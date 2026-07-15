import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { acquireChoreLock, releaseChoreLock } from "../src/chore-lock.js";

test("chore lock is exclusive and only its owner can release it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stevesbot-lock-"));
  const lockPath = path.join(dir, "runner.lock");
  try {
    assert.deepEqual(acquireChoreLock(lockPath, 101, () => true), { acquired: true, ownerPid: 101 });
    assert.equal(readFileSync(lockPath, "utf8"), "101");
    assert.deepEqual(acquireChoreLock(lockPath, 202, () => true), { acquired: false, ownerPid: 101 });
    assert.equal(releaseChoreLock(lockPath, 202), false);
    assert.equal(releaseChoreLock(lockPath, 101), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chore lock replaces stale or malformed lock files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stevesbot-stale-lock-"));
  const lockPath = path.join(dir, "runner.lock");
  try {
    writeFileSync(lockPath, "303");
    assert.deepEqual(acquireChoreLock(lockPath, 404, () => false), { acquired: true, ownerPid: 404 });
    assert.equal(releaseChoreLock(lockPath, 404), true);

    writeFileSync(lockPath, "not-a-pid");
    assert.deepEqual(acquireChoreLock(lockPath, 505, () => true), { acquired: true, ownerPid: 505 });
    assert.equal(releaseChoreLock(lockPath, 505), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
