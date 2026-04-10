import type { AppDatabase } from "./store/database.js";

/**
 * Centralized scoring — all point recording goes through here.
 * Call scoreEvent() from anywhere; it handles rules, caps, and logging.
 */

let _db: AppDatabase | null = null;

export function initScoring(db: AppDatabase): void {
  _db = db;
}

export function scoreEvent(type: string, detail?: string, refId?: string): number {
  if (!_db) return 0;
  try {
    return _db.recordPoints(type, detail, refId);
  } catch {
    return 0;
  }
}

export function getScore(): { today: number; week: number; total: number; streak: number } {
  if (!_db) return { today: 0, week: 0, total: 0, streak: 0 };
  try {
    return _db.getScoreSummary();
  } catch {
    return { today: 0, week: 0, total: 0, streak: 0 };
  }
}

export function getScoreContext(): string {
  const s = getScore();
  if (s.total === 0) return "";
  return "Score: today=" + s.today + " week=" + s.week + " total=" + s.total + " streak=" + s.streak + "d";
}

// ── Pipeline events ──

export function scoreApprovedReply(runId: number): void {
  scoreEvent("approved_reply", "Run #" + runId, String(runId));
}

export function scoreAutoResolution(runId: number, userMessage: string): void {
  scoreEvent("auto_resolution", "User said: " + userMessage.slice(0, 60), String(runId));
}

export function scoreGuardrailSave(rationale: string): void {
  scoreEvent("guardrail_saved", rationale.slice(0, 100));
}

export function scoreCorrectHold(rationale: string): void {
  scoreEvent("hold_correct", rationale.slice(0, 100));
}

export function scoreClarifyUsed(question: string): void {
  scoreEvent("clarify_used", question.slice(0, 100));
}

export function scoreNoAnswerHonest(reason: string): void {
  scoreEvent("no_answer_honest", reason.slice(0, 100));
}

// ── Command channel events ──

export function scoreCommandReply(question: string): void {
  scoreEvent("command_reply", question.slice(0, 80));
}

export function scoreToolUse(toolName: string): void {
  scoreEvent("tool_use", toolName);
}

// ── Chore events ──

export function scoreChoreCompleted(choreId: string): void {
  scoreEvent("chore_completed", choreId);
}

export function scoreKbMined(count: number): void {
  for (let i = 0; i < Math.min(count, 30); i++) {
    scoreEvent("kb_mined", "batch mine");
  }
}

export function scoreAlertSent(type: string): void {
  scoreEvent("alert_sent", type);
}
