import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";
import type { QueryTraceEntry, RepoManifestEntry, ResourceAreaSummary, SearchResult } from "../types.js";

const execFileAsync = promisify(execFile);
const GLOB_PATTERN_CHARS = /[*?{]/;

type RepoSearchOptions = {
  pathScope?: string;
  limit?: number;
  caseSensitive?: boolean;
  fileGlob?: string;
  fixedStrings?: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeGlobPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeGlobPath(pattern);
  let index = 0;
  let regex = "^";

  while (index < normalized.length) {
    const char = normalized[index];

    if (char === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
          regex += "(?:.*/)?";
          index += 3;
          continue;
        }
        regex += ".*";
        index += 2;
        continue;
      }
      regex += "[^/]*";
      index += 1;
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      index += 1;
      continue;
    }

    if (char === "{") {
      const closing = normalized.indexOf("}", index + 1);
      if (closing > index + 1) {
        const body = normalized.slice(index + 1, closing);
        const alternatives = body.split(",").map((entry) => escapeRegExp(entry));
        regex += `(?:${alternatives.join("|")})`;
        index = closing + 1;
        continue;
      }
    }

    regex += escapeRegExp(char);
    index += 1;
  }

  regex += "$";
  return new RegExp(regex, "i");
}

export class QueryBudget {
  private totalCalls = 0;
  private repoCalls = 0;
  private supportCalls = 0;

  public constructor(
    private readonly limits = {
      total: 20,
      repo: 12,
      support: 6,
    },
  ) {}

  public use(type: "repo" | "support" | "other"): void {
    this.totalCalls += 1;
    if (type === "repo") {
      this.repoCalls += 1;
    }
    if (type === "support") {
      this.supportCalls += 1;
    }
    if (this.totalCalls > this.limits.total) {
      throw new Error("Tool budget exhausted: total query limit reached.");
    }
    if (this.repoCalls > this.limits.repo) {
      throw new Error("Tool budget exhausted: repo query limit reached.");
    }
    if (this.supportCalls > this.limits.support) {
      throw new Error("Tool budget exhausted: support query limit reached.");
    }
  }
}

export class ReadOnlyTools {
  private readonly rootDir: string;
  private stepIndex = 0;

  public constructor(
    private readonly config: AppConfig,
    private readonly budget: QueryBudget,
    private readonly trace: QueryTraceEntry[],
  ) {
    this.rootDir = path.resolve(config.rootDir);
  }

  private record(toolName: string, input: Record<string, unknown>, resultSummary: string): void {
    this.trace.push({
      stepIndex: this.stepIndex,
      toolName,
      input,
      resultSummary,
      timestamp: new Date().toISOString(),
    });
    this.stepIndex += 1;
  }

  public ensureInsideRoot(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    const relative = path.relative(this.rootDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes stevesbot root: ${targetPath}`);
    }
    if (resolved.includes(`${path.sep}resources${path.sep}secrets${path.sep}`)) {
      throw new Error("Secrets are not readable by model tools.");
    }
    return resolved;
  }

  private resolveConfiguredPath(configuredPath: string): string {
    return this.ensureInsideRoot(path.isAbsolute(configuredPath) ? configuredPath : path.resolve(this.rootDir, configuredPath));
  }

  private resolveRepo(repoId: string): RepoManifestEntry {
    const repo = this.config.repos.find((entry) => entry.id === repoId);
    if (!repo) {
      throw new Error(`Unknown repo: ${repoId}`);
    }
    return repo;
  }

  private getAllowedRepoRoots(repo: RepoManifestEntry): string[] {
    return repo.allowedPaths.map((allowedPath) => this.ensureInsideRoot(path.resolve(repo.localPath, allowedPath)));
  }

  private ensureInsideAllowedRepoPath(repo: RepoManifestEntry, targetPath: string): string {
    const resolved = this.ensureInsideRoot(targetPath);
    const allowedRoots = this.getAllowedRepoRoots(repo);
    const isAllowed = allowedRoots.some((allowedRoot) => resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`));
    if (!isAllowed) {
      throw new Error(`Path is outside allowed repo scopes for ${repo.id}: ${resolved}`);
    }
    return resolved;
  }

  private async existingPaths(pathsToCheck: string[]): Promise<string[]> {
    const results: string[] = [];
    for (const candidate of pathsToCheck) {
      if (await stat(candidate).then(() => true).catch(() => false)) {
        results.push(candidate);
      }
    }
    return results;
  }

  private async resolveRepoSearchRoots(repo: RepoManifestEntry, subPath = "."): Promise<string[]> {
    if (subPath === "." || subPath === "") {
      return this.existingPaths(this.getAllowedRepoRoots(repo));
    }
    const candidate = this.ensureInsideAllowedRepoPath(repo, path.resolve(repo.localPath, subPath));
    return this.existingPaths([candidate]);
  }

  private async collectRepoFiles(repo: RepoManifestEntry, subPath = ".", maxDepth = 6): Promise<string[]> {
    const roots = await this.resolveRepoSearchRoots(repo, subPath);
    const results = new Set<string>();
    for (const root of roots) {
      const stats = await stat(root).catch(() => undefined);
      if (!stats) {
        continue;
      }
      if (stats.isFile()) {
        results.add(root);
        continue;
      }
      for (const file of await this.walk(root, maxDepth, true)) {
        results.add(this.ensureInsideAllowedRepoPath(repo, file));
      }
    }
    return [...results];
  }

  private parseSearchResults(repo: RepoManifestEntry, cwd: string, output: string, limit: number): SearchResult[] {
    const results: SearchResult[] = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const match = line.match(/^(.*?):(\d+):(.*)$/);
      if (!match) {
        continue;
      }
      const [, filePart, lineNumber, snippet] = match;
      const fullPath = this.ensureInsideAllowedRepoPath(repo, path.resolve(cwd, filePart));
      results.push({
        repoId: repo.id,
        path: fullPath,
        line: Number(lineNumber),
        snippet: snippet.trim(),
      });
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  private async searchRepoCore(
    repo: RepoManifestEntry,
    pattern: string,
    options: RepoSearchOptions = {},
  ): Promise<SearchResult[]> {
    const pathScope = options.pathScope ?? ".";
    const limit = options.limit ?? 20;
    const caseSensitive = options.caseSensitive ?? false;
    const roots = await this.resolveRepoSearchRoots(repo, pathScope);
    const ripgrepResults: SearchResult[] = [];

    for (const root of roots) {
      const rootStats = await stat(root).catch(() => undefined);
      if (!rootStats) {
        continue;
      }
      const cwd = rootStats.isDirectory() ? root : path.dirname(root);
      const target = rootStats.isDirectory() ? "." : path.basename(root);
      const args = [
        "--line-number",
        "--no-heading",
        ...(caseSensitive ? [] : ["--ignore-case"]),
        ...(options.fixedStrings ? ["--fixed-strings"] : []),
        ...(options.fileGlob && rootStats.isDirectory() ? ["--glob", options.fileGlob] : []),
        pattern,
        target,
      ];

      try {
        const rgOutput = await this.runRipgrep(args, cwd);
        if (!rgOutput) {
          continue;
        }
        ripgrepResults.push(...this.parseSearchResults(repo, cwd, rgOutput, limit - ripgrepResults.length));
      } catch (error) {
        const stderr = typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr ?? "").trim()
          : "";
        if (stderr) {
          throw new Error(stderr);
        }
        throw error;
      }

      if (ripgrepResults.length >= limit) {
        break;
      }
    }

    if (ripgrepResults.length > 0) {
      return ripgrepResults.slice(0, limit);
    }

    const files = await this.collectRepoFiles(repo, pathScope, 12);
    const globMatcher = options.fileGlob ? globToRegExp(options.fileGlob) : undefined;
    const fallbackResults: SearchResult[] = [];
    let regex: RegExp;
    try {
      regex = new RegExp(options.fixedStrings ? escapeRegExp(pattern) : pattern, caseSensitive ? "" : "i");
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }

    for (const file of files) {
      if (fallbackResults.length >= limit) {
        break;
      }
      const repoRelativePath = normalizeGlobPath(path.relative(repo.localPath, file));
      if (globMatcher && !globMatcher.test(repoRelativePath)) {
        continue;
      }
      const raw = await readFile(file, "utf8").catch(() => "");
      if (!raw) {
        continue;
      }
      const lines = raw.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (regex.test(lines[index] ?? "")) {
          fallbackResults.push({
            repoId: repo.id,
            path: file,
            line: index + 1,
            snippet: lines[index] ?? "",
          });
          if (fallbackResults.length >= limit) {
            break;
          }
        }
      }
    }

    return fallbackResults.slice(0, limit);
  }

  private async runRipgrep(args: string[], cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("rg", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        const code = "code" in error ? (error.code as number | string | undefined) : undefined;
        const stdout = "stdout" in error ? String(error.stdout ?? "") : "";
        if (code === 1) {
          return stdout;
        }
        if (code === "ENOENT") {
          return undefined;
        }
      }
      throw error;
    }
  }

  public getResourceMap(): ResourceAreaSummary[] {
    this.budget.use("other");
    this.record("getResourceMap", {}, `Returned ${this.config.resourceMap.length} resource areas.`);
    return this.config.resourceMap;
  }

  public async listResourceArea(areaId: string, subPath = ".", depth = 2): Promise<string[]> {
    this.budget.use("other");
    const area = this.config.resourceMap.find((entry) => entry.id === areaId);
    if (!area) {
      throw new Error(`Unknown resource area: ${areaId}`);
    }

    const results = new Set<string>();
    for (const scope of area.readableScopes) {
      const scopeRoot = this.resolveConfiguredPath(scope);
      const target = this.ensureInsideRoot(path.resolve(scopeRoot, subPath));
      for (const entry of await this.walk(target, depth)) {
        results.add(entry);
      }
    }

    const entries = [...results].sort();
    this.record("listResourceArea", { areaId, subPath, depth }, `Listed ${entries.length} paths from ${area.label}.`);
    return entries;
  }

  public async openResourceFile(areaId: string, filePath: string, startLine = 1, endLine = 120): Promise<string> {
    this.budget.use("other");
    const area = this.config.resourceMap.find((entry) => entry.id === areaId);
    if (!area) {
      throw new Error(`Unknown resource area: ${areaId}`);
    }

    // Try each readable scope until we find the file
    for (const scope of area.readableScopes) {
      const scopeRoot = this.resolveConfiguredPath(scope);
      const fullPath = path.resolve(scopeRoot, filePath);
      // Ensure the resolved path stays within the scope root
      if (!fullPath.startsWith(scopeRoot)) {
        throw new Error(`Path traversal denied: ${filePath}`);
      }
      try {
        const raw = await readFile(fullPath, "utf8");
        const safeStart = Math.max(1, startLine);
        const safeEnd = Math.max(safeStart, endLine);
        const lines = raw.split(/\r?\n/).slice(safeStart - 1, safeEnd);
        const result = lines.join("\n");
        this.record("openResourceFile", { areaId, filePath, startLine: safeStart, endLine: safeEnd }, `Opened ${filePath} (${lines.length} lines) from ${area.label}.`);
        return result;
      } catch {
        continue;
      }
    }

    throw new Error(`File not found in ${area.label}: ${filePath}`);
  }

  public async listRepoTree(repoId: string, subPath = ".", depth = 2): Promise<string[]> {
    this.budget.use("repo");
    const repo = this.resolveRepo(repoId);
    const roots = await this.resolveRepoSearchRoots(repo, subPath);
    const entries = new Set<string>();
    for (const root of roots) {
      const stats = await stat(root).catch(() => undefined);
      if (!stats) {
        continue;
      }
      if (stats.isFile()) {
        entries.add(root);
        continue;
      }
      for (const entry of await this.walk(root, depth)) {
        entries.add(this.ensureInsideAllowedRepoPath(repo, entry));
      }
    }

    const result = [...entries].sort();
    this.record("listRepoTree", { repoId, subPath, depth }, `Listed ${result.length} paths under ${repoId}.`);
    return result;
  }

  public async findRepoFiles(repoId: string, pattern: string, limit = 20, pathScope = "."): Promise<string[]> {
    this.budget.use("repo");
    const repo = this.resolveRepo(repoId);
    const files = await this.collectRepoFiles(repo, pathScope, 12);
    const isGlob = GLOB_PATTERN_CHARS.test(pattern);
    const globMatcher = isGlob ? globToRegExp(pattern) : undefined;
    const needle = pattern.toLowerCase();
    const matches = files.filter((file) => {
      const relativePath = normalizeGlobPath(path.relative(repo.localPath, file));
      if (globMatcher) {
        return globMatcher.test(relativePath);
      }
      return relativePath.toLowerCase().includes(needle);
    }).slice(0, limit);
    this.record("findRepoFiles", { repoId, pattern, limit, pathScope }, `Found ${matches.length} matching files in ${repoId}.`);
    return matches;
  }

  public async searchRepo(repoId: string, query: string, pathScope = ".", limit = 20): Promise<SearchResult[]> {
    this.budget.use("repo");
    const repo = this.resolveRepo(repoId);
    const results = await this.searchRepoCore(repo, query, {
      pathScope,
      limit,
      caseSensitive: false,
      fixedStrings: true,
    });
    this.record("searchRepo", { repoId, query, pathScope, limit }, `Found ${results.length} literal hits in ${repoId}.`);
    return results;
  }

  public async searchRepoRegex(
    repoId: string,
    pattern: string,
    pathScope = ".",
    limit = 20,
    fileGlob?: string,
    caseSensitive = false,
  ): Promise<SearchResult[]> {
    this.budget.use("repo");
    const repo = this.resolveRepo(repoId);
    const results = await this.searchRepoCore(repo, pattern, {
      pathScope,
      limit,
      fileGlob,
      caseSensitive,
      fixedStrings: false,
    });
    this.record(
      "searchRepoRegex",
      { repoId, pattern, pathScope, limit, fileGlob, caseSensitive },
      `Found ${results.length} regex hits in ${repoId}.`,
    );
    return results;
  }

  public async searchRepoSymbols(repoId: string, symbol: string, pathScope = ".", limit = 20): Promise<SearchResult[]> {
    this.budget.use("repo");
    const repo = this.resolveRepo(repoId);
    const escaped = escapeRegExp(symbol.trim());
    const patterns = [
      String.raw`\bexport\s+(?:default\s+)?(?:async\s+)?function\s+${escaped}\b`,
      String.raw`\b(?:async\s+)?function\s+${escaped}\b`,
      String.raw`\bexport\s+(?:default\s+)?class\s+${escaped}\b`,
      String.raw`\bclass\s+${escaped}\b`,
      String.raw`\b(?:export\s+)?(?:interface|type|enum)\s+${escaped}\b`,
      String.raw`\b(?:export\s+)?(?:const|let|var)\s+${escaped}\b`,
      String.raw`\b${escaped}\s*[:=]\s*(?:async\s*)?\(`,
      String.raw`\bdef\s+${escaped}\b`,
      String.raw`\bfn\s+${escaped}\b`,
      String.raw`\bstruct\s+${escaped}\b`,
    ];
    const seen = new Set<string>();
    const results: SearchResult[] = [];

    for (const pattern of patterns) {
      if (results.length >= limit) {
        break;
      }
      const matches = await this.searchRepoCore(repo, pattern, {
        pathScope,
        limit: limit - results.length,
        caseSensitive: false,
        fixedStrings: false,
      });
      for (const match of matches) {
        const key = `${match.path}:${match.line}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        results.push(match);
        if (results.length >= limit) {
          break;
        }
      }
    }

    this.record("searchRepoSymbols", { repoId, symbol, pathScope, limit }, `Found ${results.length} likely symbol definitions in ${repoId}.`);
    return results;
  }

  public async searchAllRepos(query: string, repoIds: string[], limit = 20): Promise<SearchResult[]> {
    const searchOrder = repoIds.length > 0 ? repoIds : this.config.repos.map((repo) => repo.id);
    const results: SearchResult[] = [];
    for (const repoId of searchOrder) {
      const remaining = limit - results.length;
      if (remaining <= 0) {
        break;
      }
      results.push(...(await this.searchRepo(repoId, query, ".", remaining)));
    }
    this.record("searchAllRepos", { query, repoIds: searchOrder, limit }, `Found ${results.length} hits across ${searchOrder.length} repos.`);
    return results.slice(0, limit);
  }

  public async openRepoFile(repoId: string, filePath: string, startLine = 1, endLine = 120): Promise<string> {
    this.budget.use("repo");
    const repo = this.resolveRepo(repoId);
    const fullPath = this.ensureInsideAllowedRepoPath(repo, path.resolve(repo.localPath, filePath));
    const raw = await readFile(fullPath, "utf8");
    const safeStart = Math.max(1, startLine);
    const safeEnd = Math.max(safeStart, endLine);
    const lines = raw.split(/\r?\n/).slice(safeStart - 1, safeEnd);
    const result = lines.join("\n");
    this.record("openRepoFile", { repoId, filePath, startLine: safeStart, endLine: safeEnd }, `Opened ${filePath} (${lines.length} lines).`);
    return result;
  }

  public async webSearch(query: string, limit = 5): Promise<string> {
    this.budget.use("other");

    // Try Brave Search first, fall back to Tavily
    const braveKey = process.env.BRAVE_SEARCH_API_KEY;
    const tavilyKey = process.env.TAVILY_API_KEY;

    if (braveKey) {
      try {
        return await this.braveSearch(query, limit, braveKey);
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        if (!tavilyKey) {
          this.record("webSearch", { query, limit }, `Brave search failed: ${errorText}`);
          return `Web search failed: ${errorText}`;
        }
        // Fall through to Tavily
      }
    }

    if (tavilyKey) {
      try {
        return await this.tavilySearch(query, limit, tavilyKey);
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        this.record("webSearch", { query, limit }, `Tavily search failed: ${errorText}`);
        return `Web search failed: ${errorText}`;
      }
    }

    this.record("webSearch", { query, limit }, "No search API key configured.");
    return "Web search unavailable: no BRAVE_SEARCH_API_KEY or TAVILY_API_KEY configured.";
  }

  private async braveSearch(query: string, limit: number, apiKey: string): Promise<string> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Brave returned ${response.status}`);
      }
      const data = (await response.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      const results = (data.web?.results ?? []).slice(0, limit);
      const summary = results.length
        ? results.map((r, idx) => `${idx + 1}. ${r.title ?? "Untitled"}\n   ${r.url ?? ""}\n   ${r.description ?? ""}`).join("\n\n")
        : "No results found.";
      this.record("webSearch", { query, limit, provider: "brave" }, `Found ${results.length} results.`);
      return summary;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async tavilySearch(query: string, limit: number, apiKey: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: limit,
          include_answer: true,
          search_depth: "basic",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Tavily returned ${response.status}`);
      }
      const data = (await response.json()) as {
        answer?: string;
        results?: Array<{ title?: string; url?: string; content?: string }>;
      };
      const results = (data.results ?? []).slice(0, limit);
      const parts: string[] = [];
      if (data.answer) {
        parts.push(`AI Summary: ${data.answer}`);
      }
      if (results.length) {
        parts.push(
          results.map((r, idx) => `${idx + 1}. ${r.title ?? "Untitled"}\n   ${r.url ?? ""}\n   ${(r.content ?? "").slice(0, 200)}`).join("\n\n"),
        );
      }
      const summary = parts.length ? parts.join("\n\n") : "No results found.";
      this.record("webSearch", { query, limit, provider: "tavily" }, `Found ${results.length} results.`);
      return summary;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async walk(start: string, depth: number, filesOnly = false): Promise<string[]> {
    if (depth < 0) {
      return [];
    }
    const entries = await readdir(start, { withFileTypes: true }).catch(() => []);
    const results: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(start, entry.name);
      if (entry.isDirectory()) {
        if (!filesOnly) {
          results.push(fullPath);
        }
        results.push(...(await this.walk(fullPath, depth - 1, filesOnly)));
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
    return results;
  }
}
