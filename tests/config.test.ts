import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fsSync from "node:fs";
import { loadAppConfig } from "../src/config.js";

function makeTempRoot(): { rootDir: string; cleanup: () => void } {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "stevesbot-config-test-"));
  const manifestsDir = path.join(rootDir, "resources", "manifests");
  const instructionsDir = path.join(rootDir, "resources", "instructions");
  const transcriptsDir = path.join(rootDir, "data", "transcripts");
  const sqliteDir = path.join(rootDir, "data", "sqlite");
  const logsDir = path.join(rootDir, "logs");

  fsSync.mkdirSync(manifestsDir, { recursive: true });
  fsSync.mkdirSync(instructionsDir, { recursive: true });
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(sqliteDir, { recursive: true });
  fsSync.mkdirSync(logsDir, { recursive: true });

  return {
    rootDir,
    cleanup: () => fsSync.rmSync(rootDir, { recursive: true, force: true }),
  };
}

function writeManifests(manifestsDir: string, overrides: { repos?: string; discord?: string; resourceMap?: string } = {}): void {
  const reposYaml = overrides.repos ?? [
    "repos:",
    "  - id: vdo-ninja",
    "    owner: maintainer-user",
    "    repo: vdo.ninja",
    "    localPath: repos/vdo-ninja",
    "    summary: WebRTC-based peer-to-peer live streaming tool",
    "    allowedPaths:",
    "      - '**/*.js'",
  ].join("\n");

  const discordYaml = overrides.discord ?? [
    "reviewChannel:",
    "  guildId: '111111111111111111'",
    "  channelId: '222222222222222222'",
    "  enabled: true",
    "routes:",
    "  - id: vdo-support",
    "    guildId: '111111111111111111'",
    "    channelId: '333333333333333333'",
    "    mode: thread",
    "    instructionRef: vdo-ninja",
    "    repoScopes:",
    "      - vdo-ninja",
    "    enabled: true",
  ].join("\n");

  const resourceMapYaml = overrides.resourceMap ?? [
    "areas:",
    "  - id: repos",
    "    label: Project Repositories",
    "    purpose: Source code for supported projects",
    "    readableScopes:",
    "      - repos/**",
    "    typicalContent: JavaScript and TypeScript source files",
    "    usageGuidance: Search for function names and API patterns",
  ].join("\n");

  fsSync.writeFileSync(path.join(manifestsDir, "repos.yaml"), reposYaml);
  fsSync.writeFileSync(path.join(manifestsDir, "discord.yaml"), discordYaml);
  fsSync.writeFileSync(path.join(manifestsDir, "resource-map.yaml"), resourceMapYaml);
}

// ── loadAppConfig with valid manifests ──────────────────────────────────────

test("loadAppConfig loads valid manifests and returns correct structure", async () => {
  const { rootDir, cleanup } = makeTempRoot();
  try {
    const manifestsDir = path.join(rootDir, "resources", "manifests");
    writeManifests(manifestsDir);

    const config = await loadAppConfig(rootDir);
    assert.equal(config.rootDir, rootDir);
    assert.equal(config.manifestsDir, manifestsDir);
    assert.equal(config.instructionsDir, path.join(rootDir, "resources", "instructions"));
    assert.equal(config.transcriptsDir, path.join(rootDir, "data", "transcripts"));
    assert.equal(config.sqlitePath, path.join(rootDir, "data", "sqlite", "stevesbot.sqlite"));
    assert.equal(config.logsDir, path.join(rootDir, "logs"));
  } finally {
    cleanup();
  }
});

test("loadAppConfig parses repos correctly", async () => {
  const { rootDir, cleanup } = makeTempRoot();
  try {
    writeManifests(path.join(rootDir, "resources", "manifests"));
    const config = await loadAppConfig(rootDir);

    assert.equal(config.repos.length, 1);
    assert.equal(config.repos[0].id, "vdo-ninja");
    assert.equal(config.repos[0].owner, "maintainer-user");
    assert.equal(config.repos[0].repo, "vdo.ninja");
    assert.equal(config.repos[0].localPath, "repos/vdo-ninja");
    assert.deepEqual(config.repos[0].allowedPaths, ["**/*.js"]);
  } finally {
    cleanup();
  }
});

test("loadAppConfig parses discord routes correctly", async () => {
  const { rootDir, cleanup } = makeTempRoot();
  try {
    writeManifests(path.join(rootDir, "resources", "manifests"));
    const config = await loadAppConfig(rootDir);

    assert.equal(config.routes.length, 1);
    assert.equal(config.routes[0].id, "vdo-support");
    assert.equal(config.routes[0].mode, "thread");
    assert.deepEqual(config.routes[0].repoScopes, ["vdo-ninja"]);
    assert.equal(config.routes[0].enabled, true);
  } finally {
    cleanup();
  }
});

test("loadAppConfig parses review channel", async () => {
  const { rootDir, cleanup } = makeTempRoot();
  try {
    writeManifests(path.join(rootDir, "resources", "manifests"));
    const config = await loadAppConfig(rootDir);

    assert.ok(config.reviewChannel);
    assert.equal(config.reviewChannel!.guildId, "111111111111111111");
    assert.equal(config.reviewChannel!.channelId, "222222222222222222");
    assert.equal(config.reviewChannel!.enabled, true);
  } finally {
    cleanup();
  }
});

test("loadAppConfig parses resource map correctly", async () => {
  const { rootDir, cleanup } = makeTempRoot();
  try {
    writeManifests(path.join(rootDir, "resources", "manifests"));
    const config = await loadAppConfig(rootDir);

    assert.equal(config.resourceMap.length, 1);
    assert.equal(config.resourceMap[0].id, "repos");
    assert.equal(config.resourceMap[0].label, "Project Repositories");
    assert.deepEqual(config.resourceMap[0].readableScopes, ["repos/**"]);
  } finally {
    cleanup();
  }
});

test("loadAppConfig without reviewChannel still works", async () => {
  const { rootDir, cleanup } = makeTempRoot();
  try {
    writeManifests(path.join(rootDir, "resources", "manifests"), {
      discord: [
        "routes:",
        "  - id: test-route",
        "    guildId: '111111111111111111'",
        "    channelId: '333333333333333333'",
        "    mode: channel",
        "    instructionRef: test",
        "    repoScopes:",
        "      - test-repo",
        "    enabled: false",
      ].join("\n"),
    });

    const config = await loadAppConfig(rootDir);
    assert.equal(config.reviewChannel, undefined);
    assert.equal(config.routes.length, 1);
    assert.equal(config.routes[0].enabled, false);
    assert.equal(config.routes[0].mode, "channel");
  } finally {
    cleanup();
  }
});

test("loadAppConfig with multiple repos", async () => {
  const { rootDir, cleanup } = makeTempRoot();
  try {
    writeManifests(path.join(rootDir, "resources", "manifests"), {
      repos: [
        "repos:",
        "  - id: vdo-ninja",
        "    owner: maintainer-user",
        "    repo: vdo.ninja",
        "    localPath: repos/vdo-ninja",
        "    summary: WebRTC streaming tool",
        "    allowedPaths:",
        "      - '**/*.js'",
        "  - id: social-stream",
        "    owner: maintainer-user",
        "    repo: social-stream-ninja",
        "    localPath: repos/social-stream",
        "    summary: Social stream aggregator",
        "    allowedPaths:",
        "      - '**/*.js'",
        "      - '**/*.html'",
      ].join("\n"),
    });

    const config = await loadAppConfig(rootDir);
    assert.equal(config.repos.length, 2);
    assert.equal(config.repos[0].id, "vdo-ninja");
    assert.equal(config.repos[1].id, "social-stream");
    assert.deepEqual(config.repos[1].allowedPaths, ["**/*.js", "**/*.html"]);
  } finally {
    cleanup();
  }
});

test("loadAppConfig rejects invalid repos.yaml (missing required fields)", async () => {
  const { rootDir, cleanup } = makeTempRoot();
  try {
    writeManifests(path.join(rootDir, "resources", "manifests"), {
      repos: [
        "repos:",
        "  - id: bad-repo",
        // Missing owner, repo, localPath, summary, allowedPaths
      ].join("\n"),
    });

    await assert.rejects(
      () => loadAppConfig(rootDir),
      (err: Error) => {
        assert.ok(err.message.length > 0, "should throw a validation error");
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("loadAppConfig rejects missing manifest files", async () => {
  const { rootDir, cleanup } = makeTempRoot();
  try {
    // Don't write any manifests
    await assert.rejects(() => loadAppConfig(rootDir));
  } finally {
    cleanup();
  }
});
