import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export type ChoreLockResult = {
  acquired: boolean;
  ownerPid?: number;
};

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const parsed = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function createLock(lockPath: string, pid: number): void {
  const fd = openSync(lockPath, "wx", 0o600);
  try {
    writeFileSync(fd, String(pid));
  } finally {
    closeSync(fd);
  }
}

export function acquireChoreLock(
  lockPath: string,
  pid = process.pid,
  processAlive: (candidatePid: number) => boolean = isProcessAlive,
): ChoreLockResult {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      createLock(lockPath, pid);
      return { acquired: true, ownerPid: pid };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    const ownerPid = readLockPid(lockPath);
    if (ownerPid && processAlive(ownerPid)) {
      return { acquired: false, ownerPid };
    }

    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }

  return { acquired: false, ownerPid: readLockPid(lockPath) };
}

export function releaseChoreLock(lockPath: string, pid = process.pid): boolean {
  if (readLockPid(lockPath) !== pid) {
    return false;
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}
