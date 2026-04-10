import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { QueryBudget, ReadOnlyTools } from "../src/tools/read-only-tools.js";

function makeFixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "stevesbot-tools-"));
  const repoRoot = path.join(rootDir, "repos", "vdo-ninja");
  const otherRepoRoot = path.join(rootDir, "repos", "raspberry-ninja");
  mkdirSync(path.join(repoRoot, "docs"), { recursive: true });
  mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  mkdirSync(path.join(otherRepoRoot, "docs"), { recursive: true });
  mkdirSync(path.join(rootDir, "resources", "secrets"), { recursive: true });

  writeFileSync(path.join(repoRoot, "README.md"), "Use meshcast to reduce relay mode.\nDock config docs.", "utf8");
  writeFileSync(path.join(repoRoot, "docs", "troubleshooting.md"), "relay mode troubleshooting\nmeshcast notes", "utf8");
  writeFileSync(
    path.join(repoRoot, "public-api.ts"),
    [
      "export function meshcastHelper() {",
      "  return 'meshcast';",
      "}",
      "",
      "export class RelayController {}",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(path.join(repoRoot, "src", "private.ts"), "this file should stay out of allowed scope", "utf8");
  writeFileSync(path.join(otherRepoRoot, "docs", "pi.md"), "Pi browser package notes.\nmeshcast can still help relay.", "utf8");
  writeFileSync(path.join(rootDir, "resources", "secrets", "token.txt"), "super-secret", "utf8");

  const tools = new ReadOnlyTools(
    {
      rootDir,
      manifestsDir: path.join(rootDir, "resources", "manifests"),
      instructionsDir: path.join(rootDir, "resources", "instructions"),
      transcriptsDir: path.join(rootDir, "data", "transcripts"),
      sqlitePath: path.join(rootDir, "data", "sqlite", "stevesbot.sqlite"),
      logsDir: path.join(rootDir, "logs"),
      repos: [
        {
          id: "vdo-ninja",
          owner: "maintainer-user",
          repo: "vdo.ninja",
          localPath: repoRoot,
          summary: "VDO docs",
          allowedPaths: ["README.md", "docs", "public-api.ts"],
        },
        {
          id: "raspberry-ninja",
          owner: "maintainer-user",
          repo: "raspberry_ninja",
          localPath: otherRepoRoot,
          summary: "Pi docs",
          allowedPaths: ["docs"],
        },
      ],
      routes: [],
      resourceMap: [
        {
          id: "learnings",
          label: "Learnings",
          purpose: "notes",
          readableScopes: [path.join(rootDir, "repos", "vdo-ninja", "docs")],
          typicalContent: "docs",
          usageGuidance: "read me",
        },
      ],
    },
    new QueryBudget({ total: 50, repo: 40, support: 10 }),
    [],
  );

  return { rootDir, repoRoot, otherRepoRoot, tools };
}

test("ReadOnlyTools blocks secret paths", () => {
  const { rootDir, tools } = makeFixture();

  try {
    assert.throws(
      () => {
        tools.ensureInsideRoot(path.resolve(rootDir, "resources", "secrets", "discord-token.txt"));
      },
      /Secrets are not readable/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("ReadOnlyTools enforces repo allowedPaths for listing and file open", async () => {
  const { rootDir, tools } = makeFixture();

  try {
    const tree = await tools.listRepoTree("vdo-ninja");
    assert.ok(tree.some((entry) => entry.endsWith(path.join("vdo-ninja", "README.md"))));
    assert.ok(tree.some((entry) => entry.endsWith(path.join("vdo-ninja", "docs", "troubleshooting.md"))));
    assert.ok(tree.every((entry) => !entry.endsWith(path.join("vdo-ninja", "src", "private.ts"))));

    await assert.rejects(
      () => tools.openRepoFile("vdo-ninja", "src/private.ts", 1, 20),
      /outside allowed repo scopes/i,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("ReadOnlyTools can find files and search across multiple repos", async () => {
  const { rootDir, tools } = makeFixture();

  try {
    const files = await tools.findRepoFiles("vdo-ninja", "troubleshooting");
    assert.equal(files.length, 1);
    assert.match(files[0] ?? "", /troubleshooting\.md$/);

    const results = await tools.searchAllRepos("meshcast", ["vdo-ninja", "raspberry-ninja"], 10);
    assert.ok(results.length >= 2);
    assert.ok(results.some((entry) => entry.repoId === "vdo-ninja"));
    assert.ok(results.some((entry) => entry.repoId === "raspberry-ninja"));
    assert.ok(results.every((entry) => entry.path.includes(path.sep)));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("findRepoFiles supports repo-relative glob patterns", async () => {
  const { rootDir, tools } = makeFixture();

  try {
    const files = await tools.findRepoFiles("vdo-ninja", "docs/**/*.md", 10);
    assert.equal(files.length, 1);
    assert.match(files[0] ?? "", /docs[\/\\]troubleshooting\.md$/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("ReadOnlyTools can search repos with regexes and symbol definitions", async () => {
  const { rootDir, tools } = makeFixture();

  try {
    const regexResults = await tools.searchRepoRegex("vdo-ninja", "relay|meshcast", ".", 10);
    assert.ok(regexResults.length >= 2);
    assert.ok(regexResults.some((entry) => entry.snippet.includes("meshcast")));

    const symbolResults = await tools.searchRepoSymbols("vdo-ninja", "meshcastHelper", ".", 10);
    assert.equal(symbolResults.length, 1);
    assert.match(symbolResults[0]?.path ?? "", /public-api\.ts$/);
    assert.match(symbolResults[0]?.snippet ?? "", /meshcastHelper/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("openResourceFile reads files within resource area scope", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "stevesbot-tools-"));
  const learningsDir = path.join(rootDir, "resources", "learnings");
  mkdirSync(path.join(learningsDir, "product-notes"), { recursive: true });
  writeFileSync(path.join(learningsDir, "product-notes", "meshcast-notes.md"), "Meshcast is a relay service.\nIt reduces bandwidth on the sender.", "utf8");

  const tools = new ReadOnlyTools(
    {
      rootDir,
      manifestsDir: path.join(rootDir, "resources", "manifests"),
      instructionsDir: path.join(rootDir, "resources", "instructions"),
      transcriptsDir: path.join(rootDir, "data", "transcripts"),
      sqlitePath: path.join(rootDir, "data", "sqlite", "stevesbot.sqlite"),
      logsDir: path.join(rootDir, "logs"),
      repos: [],
      routes: [],
      resourceMap: [
        {
          id: "learnings",
          label: "Learnings",
          purpose: "notes",
          readableScopes: [learningsDir],
          typicalContent: "docs",
          usageGuidance: "read me",
        },
      ],
    },
    new QueryBudget({ total: 50, repo: 40, support: 10 }),
    [],
  );

  try {
    // Can list and find the file
    const listing = await tools.listResourceArea("learnings", ".", 3);
    assert.ok(listing.some((e) => e.includes("meshcast-notes.md")), "Should list meshcast notes");

    // Can open the file
    const content = await tools.openResourceFile("learnings", "product-notes/meshcast-notes.md");
    assert.ok(content.includes("Meshcast is a relay service"), "Should read file content");
    assert.ok(content.includes("bandwidth"), "Should contain full content");

    // Rejects path traversal
    await assert.rejects(
      () => tools.openResourceFile("learnings", "../secrets/token.txt"),
      /Path traversal denied/,
    );

    // Rejects unknown area
    await assert.rejects(
      () => tools.openResourceFile("nonexistent", "file.md"),
      /Unknown resource area/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
