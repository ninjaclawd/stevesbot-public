import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";

export async function ensureLayout(config: AppConfig): Promise<void> {
  const paths = [
    config.rootDir,
    path.join(config.rootDir, "resources"),
    path.join(config.rootDir, "resources", "secrets"),
    path.join(config.rootDir, "resources", "access"),
    path.join(config.rootDir, "resources", "learnings"),
    path.join(config.rootDir, "resources", "instructions"),
    path.join(config.rootDir, "resources", "manifests"),
    path.join(config.rootDir, "repos"),
    path.join(config.rootDir, "data"),
    config.transcriptsDir,
    path.dirname(config.sqlitePath),
    path.join(config.rootDir, "data", "exports", "qa"),
    config.logsDir,
  ];

  await Promise.all(paths.map((target) => mkdir(target, { recursive: true })));
}
