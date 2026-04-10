import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { AppDatabase } from "../store/database.js";

export class ArchiveIngestor {
  public constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
  ) {}

  public async ingestHistoricalThreads(routeId: string): Promise<number> {
    const files = await this.walk(this.config.transcriptsDir);
    let inserted = 0;

    for (const filePath of files.filter((entry) => entry.endsWith(".jsonl"))) {
      const raw = await readFile(filePath, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) {
        continue;
      }

      const first = JSON.parse(lines[0] ?? "{}") as { content?: string; createdAt?: string };
      const last = JSON.parse(lines[lines.length - 1] ?? "{}") as { content?: string; createdAt?: string };
      const questionSummary = String(first.content ?? "").slice(0, 400);
      const answerSummary = String(last.content ?? "").slice(0, 400);

      if (!questionSummary || !answerSummary) {
        continue;
      }

      this.db.upsertHistoricalRecord({
        routeId,
        productId: routeId,
        sourceThreadRef: filePath,
        dateStart: String(first.createdAt ?? new Date().toISOString()),
        dateEnd: String(last.createdAt ?? new Date().toISOString()),
        questionSummary,
        answerSummary,
        statusFlags: ["needs_review"],
      });
      inserted += 1;
    }

    return inserted;
  }

  private async walk(start: string): Promise<string[]> {
    const entries = await readdir(start, { withFileTypes: true }).catch(() => []);
    const results: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(start, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.walk(fullPath)));
      } else {
        results.push(fullPath);
      }
    }
    return results;
  }
}
