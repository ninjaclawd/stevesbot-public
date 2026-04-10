import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemHealthAlertSignature,
  extractSystemHealthStatus,
  shouldPostSystemHealthAlert,
} from "../src/chore-alerts.js";

const warningA = [
  "Status: WARNING",
  "One-line summary: System is operational with issues that should be monitored; disk is 73% and still below the warning threshold.",
  "Issues found:",
  "- Preferred local model endpoint is not healthy (`unreachable primary / unreachable legacy`).",
  "Recommended actions:",
  "- Check the preferred local model host at `127.0.0.1:8000` and the legacy fallback at `127.0.0.1:11434` if chore summaries start failing.",
].join("\n");

const warningB = [
  "Status: WARNING",
  "One-line summary: System is operational with issues that should be monitored; disk is 74% and still below the warning threshold.",
  "Issues found:",
  "- Preferred local model endpoint is not healthy (`unreachable primary / unreachable legacy`).",
  "Recommended actions:",
  "- Check the preferred local model host at `127.0.0.1:8000` and the legacy fallback at `127.0.0.1:11434` if chore summaries start failing.",
].join("\n");

const warningChanged = [
  "Status: WARNING",
  "One-line summary: System is operational with issues that should be monitored.",
  "Issues found:",
  "- Preferred local model endpoint is not healthy (`unreachable primary / unreachable legacy`).",
  "- Recent workflow errors are elevated (4/20).",
  "Recommended actions:",
  "- Review recent runtime errors to catch provider or routing regressions.",
].join("\n");

test("extractSystemHealthStatus reads the leading status line", () => {
  assert.equal(extractSystemHealthStatus(warningA), "WARNING");
  assert.equal(extractSystemHealthStatus("One-line summary: missing"), "UNKNOWN");
});

test("buildSystemHealthAlertSignature ignores summary drift and keeps issue bullets", () => {
  assert.equal(buildSystemHealthAlertSignature(warningA), buildSystemHealthAlertSignature(warningB));
  assert.notEqual(buildSystemHealthAlertSignature(warningA), buildSystemHealthAlertSignature(warningChanged));
});

test("shouldPostSystemHealthAlert skips repeated warnings inside the reminder window", () => {
  assert.equal(shouldPostSystemHealthAlert({
    currentResult: warningB,
    previousResult: warningA,
    previousRunAt: "2026-04-01T11:00:00.000Z",
    now: new Date("2026-04-01T12:30:00.000Z"),
  }), false);
});

test("shouldPostSystemHealthAlert posts when the issue signature changes", () => {
  assert.equal(shouldPostSystemHealthAlert({
    currentResult: warningChanged,
    previousResult: warningA,
    previousRunAt: "2026-04-01T11:00:00.000Z",
    now: new Date("2026-04-01T12:30:00.000Z"),
  }), true);
});

test("shouldPostSystemHealthAlert posts periodic reminders for persistent warnings", () => {
  assert.equal(shouldPostSystemHealthAlert({
    currentResult: warningA,
    previousResult: warningA,
    previousRunAt: "2026-04-01T04:00:00.000Z",
    now: new Date("2026-04-01T10:30:01.000Z"),
  }), true);
});

test("shouldPostSystemHealthAlert does not post OK reports", () => {
  assert.equal(shouldPostSystemHealthAlert({
    currentResult: "Status: OK\nOne-line summary: all good.",
    previousResult: warningA,
    previousRunAt: "2026-04-01T11:00:00.000Z",
    now: new Date("2026-04-01T12:30:00.000Z"),
  }), false);
});

