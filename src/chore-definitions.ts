import type { AppDatabase } from "./store/database.js";

export type ChoreDefinition = {
  id: string;
  skillId: string;
  name: string;
  schedule: string;
  enabledByDefault?: boolean;
};

export const DEFAULT_CHORES: ChoreDefinition[] = [
  { id: "system-health", skillId: "system-health-check", name: "System Health Check", schedule: "*/30 * * * *" },
  { id: "issue-trends", skillId: "issue-trend-monitor", name: "Issue Trend Monitor", schedule: "0 9 * * *" },
  { id: "daily-digest", skillId: "daily-digest", name: "Daily Digest", schedule: "0 20 * * *" },
  { id: "knowledge-gaps", skillId: "knowledge-gap-detector", name: "Knowledge Gap Detector", schedule: "0 10 * * *" },
  { id: "auto-mine", skillId: "auto-mine-threads", name: "Auto Mine Threads", schedule: "0 3 * * *", enabledByDefault: false },
  { id: "weekly-summary", skillId: "weekly-summary", name: "Weekly Summary", schedule: "0 18 * * 0", enabledByDefault: false },
  { id: "repo-changelog", skillId: "repo-changelog", name: "Repo Changelog", schedule: "30 4 * * *" },
  { id: "auto-learn", skillId: "auto-learn-from-approvals", name: "Auto-Learn from Approvals", schedule: "0 21 * * *", enabledByDefault: false },
  { id: "faq-auto-builder", skillId: "faq-auto-builder", name: "FAQ Auto-Builder", schedule: "0 11 * * *" },
  { id: "breaking-change-detector", skillId: "breaking-change-detector", name: "Breaking Change Detector", schedule: "0 5 * * *" },
  { id: "sentiment-monitor", skillId: "sentiment-monitor", name: "Sentiment Monitor", schedule: "0 */4 * * *", enabledByDefault: false },
  { id: "question-frequency-report", skillId: "question-frequency-report", name: "Question Frequency Report", schedule: "0 9 * * 1" },
  { id: "weekly-kb-mining", skillId: "weekly-kb-mining", name: "Weekly KB Mining (OpenCode)", schedule: "0 14 * * 0", enabledByDefault: false },
  { id: "kb-quality", skillId: "kb-quality-monitor", name: "KB Quality Monitor", schedule: "0 11 * * *" },
  { id: "monthly-kb-refresh", skillId: "monthly-kb-refresh", name: "Monthly KB Refresh (OpenCode)", schedule: "0 15 1-7 * 0" },
  { id: "draft-failure-analyzer", skillId: "draft-failure-analyzer", name: "Draft Failure Analyzer", schedule: "0 10 * * 3", enabledByDefault: false },
];

export function registerMissingDefaultChores(db: AppDatabase): string[] {
  const created: string[] = [];
  for (const chore of DEFAULT_CHORES) {
    const existing = db.getChore(chore.id);
    if (existing) {
      continue;
    }
    db.upsertChore({
      id: chore.id,
      skillId: chore.skillId,
      name: chore.name,
      schedule: chore.schedule,
      enabled: chore.enabledByDefault !== false,
    });
    created.push(chore.id);
  }
  return created;
}

export const DEFAULT_CHORES_BY_ID = new Map(DEFAULT_CHORES.map((chore) => [chore.id, chore]));
