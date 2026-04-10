#!/usr/bin/env tsx
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadAppConfig } from "../src/config.js";
import { runIterativeAgentLoop } from "../src/models/agent-loop.js";
import { OpenAiCompatJsonClient } from "../src/models/openai-compat.js";
import { buildPreferredLocalQwenClientOptions } from "../src/models/provider-fallbacks.js";
import { QueryBudget, ReadOnlyTools } from "../src/tools/read-only-tools.js";
import type { ModelInvocationTrace, QueryTraceEntry, RouteConfig } from "../src/types.js";

type Options = {
  rootDir: string;
  provider: "local-qwen" | "opencode-api" | "opencode-zen";
  routeId?: string;
  repoId?: string;
  pathScope: string;
  question: string;
  maxSteps: number;
  showTrace: boolean;
};

function loadEnv(rootDir: string): void {
  const envPath = path.join(rootDir, ".env");
  if (!existsSync(envPath)) {
    return;
  }
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function parseInteger(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    rootDir: path.resolve(process.env.STEVESBOT_ROOT ?? "."),
    provider: "local-qwen",
    routeId: "social-stream-support",
    repoId: "social-stream",
    pathScope: ".",
    question: "Where is Event Flow Editor implemented in Social Stream, and what files load or open it?",
    maxSteps: 6,
    showTrace: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    switch (arg) {
      case "--root":
        if (!next) throw new Error("--root requires a value.");
        options.rootDir = path.resolve(next);
        index += 1;
        break;
      case "--provider":
        if (!next) throw new Error("--provider requires a value.");
        if (next !== "local-qwen" && next !== "opencode-api" && next !== "opencode-zen") {
          throw new Error(`Unsupported provider: ${next}`);
        }
        options.provider = next;
        index += 1;
        break;
      case "--route":
        if (!next) throw new Error("--route requires a value.");
        options.routeId = next;
        index += 1;
        break;
      case "--repo":
        if (!next) throw new Error("--repo requires a value.");
        options.repoId = next;
        index += 1;
        break;
      case "--path-scope":
        if (!next) throw new Error("--path-scope requires a value.");
        options.pathScope = next;
        index += 1;
        break;
      case "--question":
        if (!next) throw new Error("--question requires a value.");
        options.question = next;
        index += 1;
        break;
      case "--max-steps":
        if (!next) throw new Error("--max-steps requires a value.");
        options.maxSteps = parseInteger(next, "--max-steps");
        index += 1;
        break;
      case "--trace":
        options.showTrace = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireStringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required string arg "${name}".`);
  }
  return value.trim();
}

function optionalStringArg(args: Record<string, unknown>, name: string, defaultValue: string): string {
  const value = args[name];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "string") {
    throw new Error(`Arg "${name}" must be a string.`);
  }
  return value;
}

function optionalIntegerArg(args: Record<string, unknown>, name: string, defaultValue: number): number {
  const value = args[name];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  throw new Error(`Arg "${name}" must be an integer.`);
}

function optionalBooleanArg(args: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = args[name];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string" && /^(true|false)$/i.test(value)) {
    return value.toLowerCase() === "true";
  }
  throw new Error(`Arg "${name}" must be a boolean.`);
}

function requireRouteRepoId(route: RouteConfig, args: Record<string, unknown>, argName = "repoId"): string {
  const repoId = requireStringArg(args, argName);
  if (!route.repoScopes.includes(repoId)) {
    throw new Error(`Repo "${repoId}" is not allowed for ${route.id}. Allowed repoIds: ${route.repoScopes.join(", ")}`);
  }
  return repoId;
}

function resolveRouteRepoIds(route: RouteConfig, args: Record<string, unknown>, argName = "repoIds"): string[] {
  const value = args[argName];
  if (value === undefined) {
    return route.repoScopes;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Arg "${argName}" must be an array of repo ids.`);
  }
  const repoIds = value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`Arg "${argName}" entry ${index} must be a non-empty string.`);
    }
    if (!route.repoScopes.includes(entry)) {
      throw new Error(`Repo "${entry}" is not allowed for ${route.id}. Allowed repoIds: ${route.repoScopes.join(", ")}`);
    }
    return entry.trim();
  });
  return repoIds.length > 0 ? repoIds : route.repoScopes;
}

function buildConversation(params: {
  route: RouteConfig;
  question: string;
  pathScope: string;
  repoSummaryLines: string[];
}): string {
  const defaultRepoId = params.route.repoScopes[0] ?? "social-stream";
  return [
    `Repo smoke test route: ${params.route.id}`,
    `Allowed repoIds: ${params.route.repoScopes.join(", ")}`,
    `Default pathScope: ${params.pathScope}`,
    "Repository scope:",
    ...params.repoSummaryLines,
    "Task:",
    params.question,
    "Rules:",
    "- Use only read-only repo tools.",
    "- Use at least 2 tool calls before finalizing unless the first search clearly proves nothing relevant exists.",
    "- Open files before claiming what they contain.",
    "- Keep the final answer concise and factual.",
    "- Only include repoRefs for files you directly inspected or surfaced in search results.",
    "Tool examples:",
    `searchRepoRegex {"repoId":"${defaultRepoId}","pattern":"EventFlowEditor|openEventFlowEditor","pathScope":"${params.pathScope}","limit":10}`,
    `searchRepoSymbols {"repoId":"${defaultRepoId}","symbol":"EventFlowEditor","pathScope":"${params.pathScope}","limit":10}`,
    `openRepoFile {"repoId":"${defaultRepoId}","filePath":"actions/EventFlowEditor.js","startLine":1,"endLine":120}`,
  ].join("\n");
}

function getToolArgExamples(route: RouteConfig): Record<string, Record<string, unknown>> {
  const defaultRepoId = route.repoScopes[0] ?? "social-stream";
  return {
    findRepoFiles: { repoId: defaultRepoId, pattern: "actions/**/*.js", pathScope: ".", limit: 10 },
    listRepoTree: { repoId: defaultRepoId, path: "actions", depth: 2 },
    searchRepo: { repoId: defaultRepoId, query: "EventFlowEditor", pathScope: ".", limit: 10 },
    searchRepoRegex: { repoId: defaultRepoId, pattern: "EventFlowEditor|openEventFlowEditor", pathScope: ".", limit: 10 },
    searchRepoSymbols: { repoId: defaultRepoId, symbol: "EventFlowEditor", pathScope: ".", limit: 10 },
    searchAllRepos: { query: "EventFlowEditor", repoIds: route.repoScopes, limit: 10 },
    openRepoFile: { repoId: defaultRepoId, filePath: "actions/EventFlowEditor.js", startLine: 1, endLine: 120 },
  };
}

function buildClient(options: Options): OpenAiCompatJsonClient {
  switch (options.provider) {
    case "local-qwen":
      return new OpenAiCompatJsonClient({
        ...buildPreferredLocalQwenClientOptions(process.env, "repo-smoke:local-qwen"),
        systemRoleLabel: "You are a repo-aware codebase navigator using read-only repository tools.",
      });
    case "opencode-api":
      if (!process.env.OPENCODE_API_KEY) {
        throw new Error("OPENCODE_API_KEY is required for --provider opencode-api.");
      }
      return new OpenAiCompatJsonClient({
        baseUrl: process.env.OPENCODE_BASE_URL ?? "https://api.opencode.ai/v1",
        apiKey: process.env.OPENCODE_API_KEY,
        model: process.env.OPENCODE_MODEL ?? "gpt-5.4-pro",
        systemRoleLabel: "You are a repo-aware codebase navigator using read-only repository tools.",
        clientLabel: "repo-smoke:opencode-api",
        requestTimeoutMs: Number(process.env.OPENCODE_TIMEOUT_MS ?? process.env.STEVESBOT_MODEL_TIMEOUT_MS ?? "180000"),
      });
    case "opencode-zen":
      if (!process.env.OPENCODE_API_KEY) {
        throw new Error("OPENCODE_API_KEY is required for --provider opencode-zen.");
      }
      return new OpenAiCompatJsonClient({
        baseUrl: process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/v1",
        apiKey: process.env.OPENCODE_API_KEY,
        model: process.env.OPENCODE_MODEL ?? "gpt-5.4-pro",
        systemRoleLabel: "You are a repo-aware codebase navigator using read-only repository tools.",
        clientLabel: "repo-smoke:opencode-zen",
        requestTimeoutMs: Number(process.env.OPENCODE_TIMEOUT_MS ?? process.env.STEVESBOT_MODEL_TIMEOUT_MS ?? "180000"),
      });
  }
}

function printTraces(toolTrace: QueryTraceEntry[], modelTraces: ModelInvocationTrace[]): void {
  console.log("\nTool trace:");
  for (const entry of toolTrace) {
    console.log(`- [${entry.stepIndex}] ${entry.toolName}: ${entry.resultSummary}`);
  }
  console.log("\nModel trace:");
  for (const trace of modelTraces) {
    const outcome = trace.ok ? "ok" : "error";
    console.log(`- ${trace.clientLabel} ${trace.model} ${outcome} ${trace.durationMs}ms`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  loadEnv(options.rootDir);
  const config = await loadAppConfig(options.rootDir);

  let route = options.routeId ? config.routes.find((entry) => entry.id === options.routeId) : undefined;
  if (!route && options.repoId) {
    route = config.routes.find((entry) => entry.repoScopes.includes(options.repoId!));
  }
  if (!route) {
    route = {
      id: `repo-smoke:${options.repoId ?? "adhoc"}`,
      guildId: "repo-smoke",
      channelId: "repo-smoke",
      mode: "thread",
      instructionRef: "",
      repoScopes: options.repoId ? [options.repoId] : config.repos.map((repo) => repo.id),
      enabled: true,
    };
  }

  if (options.repoId && !route.repoScopes.includes(options.repoId)) {
    route = { ...route, repoScopes: [options.repoId] };
  }

  const repoSummaryLines = config.repos
    .filter((repo) => route.repoScopes.includes(repo.id))
    .map((repo) => `- ${repo.id}: ${repo.summary}`);
  const toolCatalog = [
    "findRepoFiles",
    "listRepoTree",
    "searchRepo",
    "searchRepoRegex",
    "searchRepoSymbols",
    "searchAllRepos",
    "openRepoFile",
  ];
  const toolTrace: QueryTraceEntry[] = [];
  const modelTraces: ModelInvocationTrace[] = [];
  const tools = new ReadOnlyTools(config, new QueryBudget({ total: 12, repo: 12, support: 0 }), toolTrace);
  const client = buildClient(options);
  const expectedArgs = getToolArgExamples(route);

  let answer;
  try {
    answer = await runIterativeAgentLoop({
      client,
      systemPrompt: [
        "You are StevesBot's end-to-end repo smoke-test agent.",
        "Answer the repository question using only the allowed read-only repo tools.",
        "Do not fabricate file contents, parameter names, or implementation details.",
      ].join("\n"),
      conversation: buildConversation({
        route,
        question: options.question,
        pathScope: options.pathScope,
        repoSummaryLines,
      }),
      toolCatalog,
      trace: toolTrace,
      traceRecorder: (trace) => modelTraces.push(trace),
      maxSteps: options.maxSteps,
      invokeTool: async (toolName, args) => {
        try {
          switch (toolName) {
            case "findRepoFiles":
              return JSON.stringify(
                await tools.findRepoFiles(
                  requireRouteRepoId(route, args),
                  requireStringArg(args, "pattern"),
                  optionalIntegerArg(args, "limit", 20),
                  optionalStringArg(args, "pathScope", "."),
                ),
                null,
                2,
              );
            case "listRepoTree":
              return JSON.stringify(
                await tools.listRepoTree(
                  requireRouteRepoId(route, args),
                  optionalStringArg(args, "path", "."),
                  optionalIntegerArg(args, "depth", 2),
                ),
                null,
                2,
              );
            case "searchRepo":
              return JSON.stringify(
                await tools.searchRepo(
                  requireRouteRepoId(route, args),
                  requireStringArg(args, "query"),
                  optionalStringArg(args, "pathScope", "."),
                  optionalIntegerArg(args, "limit", 20),
                ),
                null,
                2,
              );
            case "searchRepoRegex":
              return JSON.stringify(
                await tools.searchRepoRegex(
                  requireRouteRepoId(route, args),
                  requireStringArg(args, "pattern"),
                  optionalStringArg(args, "pathScope", "."),
                  optionalIntegerArg(args, "limit", 20),
                  optionalStringArg(args, "fileGlob", "") || undefined,
                  optionalBooleanArg(args, "caseSensitive", false),
                ),
                null,
                2,
              );
            case "searchRepoSymbols":
              return JSON.stringify(
                await tools.searchRepoSymbols(
                  requireRouteRepoId(route, args),
                  requireStringArg(args, "symbol"),
                  optionalStringArg(args, "pathScope", "."),
                  optionalIntegerArg(args, "limit", 20),
                ),
                null,
                2,
              );
            case "searchAllRepos":
              return JSON.stringify(
                await tools.searchAllRepos(
                  requireStringArg(args, "query"),
                  resolveRouteRepoIds(route, args),
                  optionalIntegerArg(args, "limit", 20),
                ),
                null,
                2,
              );
            case "openRepoFile":
              return await tools.openRepoFile(
                requireRouteRepoId(route, args),
                requireStringArg(args, "filePath"),
                optionalIntegerArg(args, "startLine", 1),
                optionalIntegerArg(args, "endLine", 120),
              );
            default:
              throw new Error(`Unknown tool: ${toolName}`);
          }
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          toolTrace.push({
            stepIndex: toolTrace.length,
            toolName,
            input: args,
            resultSummary: `Tool error: ${errorText}`,
            timestamp: new Date().toISOString(),
          });
          return JSON.stringify(
            {
              ok: false,
              tool: toolName,
              error: errorText,
              allowedRepoIds: route.repoScopes,
              expectedArgs: expectedArgs[toolName] ?? null,
            },
            null,
            2,
          );
        }
      },
    });
  } catch (error) {
    console.error(JSON.stringify({
      provider: options.provider,
      routeId: route.id,
      repoScopes: route.repoScopes,
      question: options.question,
      error: error instanceof Error ? error.message : String(error),
      toolTraceCount: toolTrace.length,
    }, null, 2));
    if (options.showTrace) {
      printTraces(toolTrace, modelTraces);
    }
    throw error;
  }

  console.log(JSON.stringify({
    provider: options.provider,
    routeId: route.id,
    repoScopes: route.repoScopes,
    question: options.question,
    answer: answer.body,
    repoRefs: answer.repoRefs,
    toolTraceCount: toolTrace.length,
  }, null, 2));

  if (options.showTrace) {
    printTraces(toolTrace, modelTraces);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
