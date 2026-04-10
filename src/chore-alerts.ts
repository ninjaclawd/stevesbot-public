const SYSTEM_HEALTH_REMINDER_MS = 6 * 60 * 60 * 1000;

export function extractSystemHealthStatus(result: string): string {
  const match = result.match(/^Status:\s*([A-Z]+)/m);
  return match?.[1] ?? "UNKNOWN";
}

export function buildSystemHealthAlertSignature(result: string): string {
  const status = extractSystemHealthStatus(result);
  const issues: string[] = [];
  let inIssuesSection = false;

  for (const rawLine of result.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line === "Issues found:") {
      inIssuesSection = true;
      continue;
    }
    if (line.endsWith(":") && line !== "Issues found:") {
      inIssuesSection = false;
      continue;
    }
    if (inIssuesSection && line.startsWith("- ")) {
      issues.push(
        line
          .slice(2)
          .replace(/`/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      );
    }
  }

  return `${status}|${issues.join("|")}`;
}

export function shouldPostSystemHealthAlert(params: {
  currentResult: string;
  previousResult?: string | null;
  previousRunAt?: string | null;
  now?: Date;
  reminderMs?: number;
}): boolean {
  const currentStatus = extractSystemHealthStatus(params.currentResult);
  if (currentStatus === "OK") {
    return false;
  }

  if (!params.previousResult) {
    return true;
  }

  const currentSignature = buildSystemHealthAlertSignature(params.currentResult);
  const previousSignature = buildSystemHealthAlertSignature(params.previousResult);
  if (currentSignature !== previousSignature) {
    return true;
  }

  const reminderMs = params.reminderMs ?? SYSTEM_HEALTH_REMINDER_MS;
  const previousRunMs = params.previousRunAt ? Date.parse(params.previousRunAt) : Number.NaN;
  if (!Number.isFinite(previousRunMs)) {
    return true;
  }

  const nowMs = (params.now ?? new Date()).getTime();
  return nowMs - previousRunMs >= reminderMs;
}

