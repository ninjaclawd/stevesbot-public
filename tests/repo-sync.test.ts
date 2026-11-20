import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("sync reports missing checkouts and rejects a checkout from another owner", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bot-repo-sync-"));
  try {
    mkdirSync(path.join(root, "resources/manifests"), { recursive: true });
    symlinkSync(path.resolve("scripts"), path.join(root, "scripts"));
    writeFileSync(path.join(root, "resources/manifests/repos.yaml"), JSON.stringify({ repos: [{
      id: "product", localPath: "repos/product", owner: "example", repo: "product", branch: "main",
    }] }));
    const run = () => spawnSync("bash", ["scripts/update-repos.sh"], {
      env: { ...process.env, STEVESBOT_ROOT: root }, encoding: "utf8",
    });
    assert.equal(run().status, 1);
    const checkout = path.join(root, "repos/product");
    mkdirSync(checkout, { recursive: true });
    execFileSync("git", ["init", "--quiet", "-b", "main", checkout]);
    execFileSync("git", ["-C", checkout, "config", "branch.main.remote", "origin"]);
    execFileSync("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/other/product.git"]);
    assert.equal(run().status, 1);
    assert.match(readFileSync(path.join(root, "logs/repo-update.log"), "utf8"), /Unexpected remote/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
