import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { AppDatabase } from "../store/database.js";
import type { WorkflowRunDetail, WorkflowRunSummary, WorkflowStepRecord } from "../types.js";
import { sendTriagePrompt, getActiveFlowCount } from "../discord/interactive-triage.js";
import { executeSkill, loadAllSkills, matchesCronSchedule } from "../chore-runner.js";
import { DEFAULT_CHORES_BY_ID, registerMissingDefaultChores } from "../chore-definitions.js";

type ServerOptions = {
  host: string;
  port: number;
  discordToken?: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
}

function formatJson(value: unknown): string {
  return escapeHtml(JSON.stringify(value, null, 2));
}

function formatDuration(value: number): string {
  return `${value} ms`;
}

function timeAgo(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + "s ago";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  const days = Math.floor(hr / 24);
  return days + "d ago";
}

type SkillManifestSnapshot = {
  id: string;
  name: string;
  description: string;
  type: string;
  schedule: string;
};

type ChoreDashboardRow = ReturnType<typeof buildChoreDashboardRows>[number];

function getRootDir(): string {
  return process.env.STEVESBOT_ROOT ?? process.cwd();
}

function loadSkillManifestSnapshots(rootDir: string): Map<string, SkillManifestSnapshot> {
  const result = new Map<string, SkillManifestSnapshot>();
  const skillsDir = path.join(rootDir, "skills");
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(skillsDir, entry.name, "skill.yaml");
      if (!existsSync(manifestPath)) {
        continue;
      }
      try {
        const parsed = parseYaml(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        const id = typeof parsed.id === "string" ? parsed.id : "";
        if (!id) {
          continue;
        }
        result.set(id, {
          id,
          name: typeof parsed.name === "string" ? parsed.name : id,
          description: typeof parsed.description === "string" ? parsed.description : "",
          type: typeof parsed.type === "string" ? parsed.type : "declarative",
          schedule: typeof parsed.schedule === "string" ? parsed.schedule : "",
        });
      } catch {
        // Skip invalid manifests in the dashboard.
      }
    }
  } catch {
    return result;
  }
  return result;
}

function validateCronExpression(value: string): boolean {
  const parts = value.trim().split(/\s+/);
  return parts.length === 5 && parts.every((part) => /^[\d*/,.-]+$/.test(part));
}

function nextScheduledTime(schedule: string, now = new Date(), lookaheadDays = 400): Date | null {
  if (!validateCronExpression(schedule)) {
    return null;
  }
  const cursor = new Date(now);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const maxMinutes = lookaheadDays * 24 * 60;
  for (let i = 0; i <= maxMinutes; i += 1) {
    if (matchesCronSchedule(schedule, cursor)) {
      return new Date(cursor);
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

function buildChoreDashboardRows(db: AppDatabase, rootDir = getRootDir()) {
  const skillSnapshots = loadSkillManifestSnapshots(rootDir);
  const chores = db.listChores();
  return chores.map((chore) => {
    const skill = skillSnapshots.get(chore.skillId);
    const defaultDef = DEFAULT_CHORES_BY_ID.get(chore.id);
    const manifestSchedule = skill?.schedule?.trim() || "";
    const hasScheduleDrift = Boolean(manifestSchedule) && manifestSchedule !== chore.schedule;
    const defaultSchedule = defaultDef?.schedule ?? null;
    const hasDefaultDrift = Boolean(defaultSchedule) && defaultSchedule !== chore.schedule;
    const nextRun = chore.enabled ? nextScheduledTime(chore.schedule) : null;
    return {
      ...chore,
      skillType: skill?.type ?? "unknown",
      skillName: skill?.name ?? chore.name,
      skillDescription: skill?.description ?? "",
      manifestSchedule,
      hasScheduleDrift,
      defaultSchedule,
      hasDefaultDrift,
      nextRunAt: nextRun?.toISOString() ?? null,
      missingManifest: !skill,
      dueNow: chore.enabled && matchesCronSchedule(chore.schedule, new Date()),
    };
  });
}

function renderLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <title>${escapeHtml(title)}</title>
  <style>
    /* ═══════════════════════════════════════════════
       PIP-BOY / WINAMP COCKPIT — physical device skin
       Chassis = brushed metal. Panels = inset CRT screens.
       ═══════════════════════════════════════════════ */
    @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&display=swap');

    :root {
      color-scheme: dark;
      --chassis: #1a1d20;
      --chassis-light: #2a2d32;
      --chassis-dark: #0e1012;
      --rivet: #3a3d42;
      --screen-bg: #071a0e;
      --screen-glow: rgba(0,255,160,.06);
      --ink: #44ffaa;
      --ink-dim: #2ab866;
      --muted: #28885a;
      --accent: #33ff88;
      --border: #0a3020;
      --warn: #ffaa00;
      --good: #33ff88;
      --bad: #ff3355;
      --glow: 0 0 6px rgba(51,255,136,.25);
      --glow-warn: 0 0 6px rgba(255,170,0,.3);
      --glow-bad: 0 0 6px rgba(255,51,85,.3);
      --bevel-out: inset 0 1px 0 rgba(255,255,255,.08), inset 0 -1px 0 rgba(0,0,0,.3);
      --bevel-in: inset 0 2px 4px rgba(0,0,0,.6), inset 0 -1px 0 rgba(255,255,255,.04);
      --mono: "Share Tech Mono", "Cascadia Code", Consolas, monospace;
      --sans: "Orbitron", "Share Tech Mono", monospace;
      --scan-opacity: 0.035;
    }

    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes boot {
      0% { opacity: 0; filter: brightness(0) blur(2px); }
      30% { opacity: 1; filter: brightness(0.3) blur(0); }
      60% { opacity: 1; filter: brightness(0.8) blur(0); }
      100% { opacity: 1; filter: brightness(1) blur(0); }
    }
    @keyframes screen-on {
      0% { max-height: 2px; opacity: .5; }
      30% { max-height: 2px; opacity: 1; }
      100% { max-height: 2000px; opacity: 1; }
    }
    @keyframes flicker {
      0%,100% { opacity: 1; }
      92% { opacity: 1; }
      93% { opacity: .85; }
      94% { opacity: 1; }
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }

    /* ── CHASSIS — the physical body ─────────────── */
    body {
      margin: 0;
      font-family: var(--mono);
      color: #8a8d92;
      background:
        repeating-linear-gradient(90deg, transparent, transparent 1px, rgba(255,255,255,.015) 1px, rgba(255,255,255,.015) 2px),
        linear-gradient(180deg, #22252a 0%, var(--chassis) 100px, var(--chassis-dark) 100%);
      background-attachment: fixed;
      min-height: 100vh;
    }

    a { color: var(--accent); text-decoration: none; }
    a:hover { color: #88ffbb; text-decoration: none; }

    .shell {
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px;
    }

    /* ── TOPBAR — nameplate ──────────────────────── */
    .topbar {
      display: flex; gap: 16px; align-items: baseline; justify-content: space-between;
      margin-bottom: 16px; padding-bottom: 12px;
      border-bottom: 2px solid var(--chassis-dark);
      box-shadow: 0 1px 0 rgba(255,255,255,.05);
    }
    .title {
      font-family: var(--sans);
      font-size: 18px; font-weight: 900;
      letter-spacing: 0.15em; text-transform: uppercase;
      color: #ccc;
      text-shadow: 0 -1px 0 #000, 0 1px 0 rgba(255,255,255,.1);
    }
    .subtitle {
      color: #6a9a80;
      font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
    }

    /* ── SCREEN MIXIN — inset CRT display ────────── */
    .panel, .stats-banner, details, .message, pre {
      position: relative;
      overflow: hidden;
    }
    /* Scanlines on screens */
    .panel::after, .stats-banner::after, details::after, .message::after, pre::after {
      content: "";
      position: absolute; inset: 0;
      background: repeating-linear-gradient(0deg,
        transparent, transparent 2px,
        rgba(0,255,160,var(--scan-opacity)) 2px,
        rgba(0,255,160,var(--scan-opacity)) 3px
      );
      pointer-events: none;
      z-index: 1;
      border-radius: inherit;
    }
    /* Screen vignette */
    .panel::before, .stats-banner::before {
      content: "";
      position: absolute; inset: 0;
      background: radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,.5) 100%);
      pointer-events: none;
      z-index: 2;
      border-radius: inherit;
    }

    /* ── PANEL — recessed CRT instrument ─────────── */
    .panel {
      background: var(--screen-bg);
      border: 3px solid var(--chassis-dark);
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 16px;
      color: var(--ink);
      box-shadow:
        var(--bevel-in),
        0 4px 12px rgba(0,0,0,.4),
        inset 0 0 30px rgba(0,255,160,.03);
      animation: boot .5s ease-out;
    }
    .panel a { text-shadow: 0 0 6px rgba(51,255,136,.3); }

    .grid { display: grid; gap: 16px; }
    .grid.two { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }

    /* ── FILTERS — input strip ───────────────────── */
    .filters {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px; align-items: end;
    }
    label {
      font-size: 9px; color: var(--muted); display: block; margin-bottom: 3px;
      text-transform: uppercase; letter-spacing: 0.12em;
      font-family: var(--sans);
    }
    input, select, button {
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 7px 9px;
      font: 12px var(--mono);
      color: var(--ink);
      transition: all .15s;
    }
    input, select {
      width: 100%;
      background: rgba(0,20,10,.8);
      box-shadow: var(--bevel-in);
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: var(--bevel-in), 0 0 8px rgba(51,255,136,.2);
    }

    /* ── BUTTONS — physical raised switches ──────── */
    button {
      background: linear-gradient(180deg, #3a3d42 0%, #28292e 40%, #1e1f23 100%);
      color: #aaa;
      font-weight: 700; cursor: pointer;
      text-transform: uppercase; letter-spacing: 0.08em; font-size: 10px;
      border: 1px solid #444;
      border-radius: 4px;
      box-shadow: var(--bevel-out), 0 2px 4px rgba(0,0,0,.4);
      position: relative;
    }
    button:hover {
      background: linear-gradient(180deg, #4a4d52 0%, #333438 40%, #28292e 100%);
      color: var(--accent);
      border-color: #555;
    }
    button:active {
      background: linear-gradient(180deg, #1e1f23 0%, #28292e 40%, #3a3d42 100%);
      box-shadow: inset 0 2px 3px rgba(0,0,0,.5), 0 0 0 1px rgba(0,0,0,.2);
      transform: translateY(1px);
    }

    /* ── TABLE — data readout grid ────────────────── */
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td {
      border-bottom: 1px solid rgba(51,255,136,.08);
      padding: 7px 8px; vertical-align: top; text-align: left;
    }
    th {
      color: var(--ink-dim); font-weight: 700; font-size: 9px;
      text-transform: uppercase; letter-spacing: 0.12em;
      border-bottom: 1px solid var(--ink-dim);
      font-family: var(--sans);
    }
    tr:hover td { background: rgba(51,255,136,.04); }
    tr[data-outcome="approved"] td { background: rgba(51,255,136,.06); }
    tr[data-outcome="rejected"] td { background: rgba(255,51,85,.05); }
    tr[data-outcome="error"] td { background: rgba(255,51,85,.08); }

    /* ── PILLS — LED indicator lights ────────────── */
    .pill {
      display: inline-block; border-radius: 3px;
      padding: 2px 8px; font-size: 9px; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase;
      background: rgba(51,255,136,.08); color: var(--accent);
      border: 1px solid rgba(51,255,136,.15);
      text-shadow: 0 0 4px rgba(51,255,136,.4);
    }
    .pill.good { background: rgba(51,255,136,.12); color: var(--good); border-color: rgba(51,255,136,.25); box-shadow: 0 0 4px rgba(51,255,136,.3); }
    .pill.bad { background: rgba(255,51,85,.1); color: var(--bad); border-color: rgba(255,51,85,.25); box-shadow: var(--glow-bad); text-shadow: var(--glow-bad); }
    .pill.warn { background: rgba(255,170,0,.1); color: var(--warn); border-color: rgba(255,170,0,.25); box-shadow: var(--glow-warn); text-shadow: var(--glow-warn); }

    /* ── META — instrument readout gauges ─────────── */
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px; margin-bottom: 16px;
    }
    .meta strong {
      display: block; font-size: 8px; color: var(--muted);
      text-transform: uppercase; letter-spacing: 0.15em;
      font-family: var(--sans);
    }
    .card-title {
      font-family: var(--sans); font-size: 11px; font-weight: 700;
      margin-bottom: 8px; text-transform: uppercase;
      letter-spacing: 0.1em; color: var(--accent);
      text-shadow: 0 0 6px rgba(68,255,170,.3);
    }

    /* ── CODE — terminal output screen ────────────── */
    .mono, pre { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    pre {
      margin: 0;
      background: #010804;
      color: var(--good); padding: 12px;
      border: 2px solid var(--chassis-dark);
      border-radius: 4px;
      box-shadow: var(--bevel-in), inset 0 0 20px rgba(0,255,136,.02);
      text-shadow: 0 0 3px rgba(51,255,136,.3);
      overflow-x: auto;
    }

    /* ── DETAILS — subsystem drawer ──────────────── */
    details {
      border: 2px solid var(--chassis-dark);
      border-radius: 4px; padding: 10px 12px;
      background: var(--screen-bg);
      margin-bottom: 10px; color: var(--ink);
      box-shadow: var(--bevel-in);
    }
    summary {
      cursor: pointer; font-weight: 700;
      display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
      color: var(--accent); text-transform: uppercase;
      font-size: 11px; letter-spacing: 0.06em;
    }
    .step-meta { color: var(--muted); font-size: 10px; }
    .stack > * + * { margin-top: 10px; }

    /* ── Density ─────────────────────────────────── */
    html[data-density="compact"] table { font-size: 11px; }
    html[data-density="compact"] th, html[data-density="compact"] td { padding: 4px 6px; }
    html[data-density="compact"] .panel { padding: 10px; margin-bottom: 10px; }
    html[data-density="compact"] .meta { gap: 6px; }
    html[data-density="compact"] .card-title { font-size: 10px; margin-bottom: 5px; }
    html[data-density="compact"] .grid { gap: 8px; }
    html[data-density="compact"] details { padding: 6px 8px; margin-bottom: 6px; }
    html[data-density="dense"] table { font-size: 10px; }
    html[data-density="dense"] th, html[data-density="dense"] td { padding: 3px 5px; }
    html[data-density="dense"] .panel { padding: 8px; margin-bottom: 6px; }
    html[data-density="dense"] .meta { gap: 4px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    html[data-density="dense"] .card-title { font-size: 9px; margin-bottom: 3px; }
    html[data-density="dense"] .grid { gap: 6px; }
    html[data-density="dense"] details { padding: 4px 6px; margin-bottom: 4px; }
    html[data-density="dense"] .topbar { margin-bottom: 10px; }
    html[data-density="dense"] .shell { padding: 10px; }

    /* ── Responsive ──────────────────────────────── */
    @media (max-width: 768px) {
      .shell { padding: 8px; }
      .topbar { flex-direction: column; gap: 6px; }
      .topbar > div:last-child { display: flex; flex-wrap: wrap; gap: 6px 10px; }
      .title { font-size: 14px; }
      .grid.two { grid-template-columns: 1fr; }
      .filters { grid-template-columns: 1fr 1fr; }
      table { font-size: 10px; }
      th, td { padding: 4px; }
      .meta { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
      .pager { flex-direction: column; gap: 6px; }
      pre { font-size: 10px; padding: 8px; }
    }
    @media (max-width: 480px) {
      .filters { grid-template-columns: 1fr; }
      .meta { grid-template-columns: 1fr 1fr; }
      .title { font-size: 12px; }
    }
    @media (min-width: 1400px) {
      .shell { max-width: 1600px; }
    }

    /* ── CONTROL BAR — physical switch strip ──────── */
    .ctrl-bar {
      display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
      padding: 6px 10px;
      background: linear-gradient(180deg, #2a2d32, var(--chassis) 40%, var(--chassis-dark));
      border: 1px solid #333;
      border-radius: 5px; margin-bottom: 12px; font-size: 10px;
      flex-direction: column;
      box-shadow: var(--bevel-out), 0 2px 6px rgba(0,0,0,.3);
    }
    @media (min-width: 600px) { .ctrl-bar { flex-direction: row; } }
    .ctrl-bar button, .ctrl-bar .ctrl-btn {
      padding: 4px 10px; font-size: 9px;
    }
    .ctrl-bar .spacer { flex: 1; }
    kbd {
      background: var(--chassis-light);
      border: 1px solid #444; border-radius: 3px;
      padding: 1px 5px; font-size: 9px; font-family: var(--mono); color: #888;
      box-shadow: 0 1px 0 rgba(0,0,0,.3);
    }

    /* ── TAB NAV — row of toggle buttons ─────────── */
    .tab-nav { display: flex; gap: 2px; flex-wrap: wrap; }
    .tab {
      padding: 5px 12px; font-size: 9px; font-weight: 700;
      color: #666; text-decoration: none; transition: all .15s;
      text-transform: uppercase; letter-spacing: 0.1em;
      font-family: var(--sans);
      background: linear-gradient(180deg, #2e3136, #22252a);
      border: 1px solid #3a3d42; border-radius: 4px 4px 0 0;
      box-shadow: var(--bevel-out);
    }
    .tab:hover { color: #aaa; background: linear-gradient(180deg, #383b40, #2a2d32); text-decoration: none; }
    .tab.active {
      color: var(--accent);
      background: linear-gradient(180deg, var(--chassis-dark), #0a0c0e);
      border-color: #444;
      border-bottom-color: var(--chassis-dark);
      box-shadow: inset 0 2px 4px rgba(0,0,0,.4), 0 0 8px rgba(51,255,136,.1);
      text-shadow: 0 0 6px rgba(51,255,136,.4);
    }

    .chip-bar { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px; }
    .chip {
      padding: 3px 9px; font-size: 9px; font-weight: 700;
      cursor: pointer;
      border: 1px solid #333; background: var(--chassis); color: #666;
      text-decoration: none; transition: all .15s;
      text-transform: uppercase; letter-spacing: 0.06em; border-radius: 3px;
      box-shadow: var(--bevel-out);
    }
    .chip:hover { color: #aaa; border-color: #555; text-decoration: none; }
    .chip.active {
      background: var(--screen-bg); color: var(--accent);
      border-color: var(--ink-dim);
      box-shadow: var(--bevel-in), 0 0 6px rgba(51,255,136,.15);
      text-shadow: 0 0 4px rgba(51,255,136,.3);
    }

    /* ── STATS BANNER — LCD gauge strip ──────────── */
    .stats-banner {
      display: flex; gap: 12px; flex-wrap: wrap; padding: 10px 14px;
      background: var(--screen-bg);
      border: 3px solid var(--chassis-dark);
      border-radius: 6px; margin-bottom: 14px; align-items: center;
      box-shadow: var(--bevel-in), inset 0 0 30px rgba(0,255,136,.02);
      color: var(--ink);
    }
    .stat-item { text-align: center; min-width: 80px; position: relative; z-index: 3; }
    .stat-value {
      font-family: var(--sans); font-size: 22px; font-weight: 900;
      color: var(--accent); font-variant-numeric: tabular-nums;
      text-shadow: 0 0 8px rgba(51,255,136,.5);
    }
    .stat-label {
      font-size: 8px; text-transform: uppercase;
      letter-spacing: .12em; color: var(--muted);
      font-family: var(--sans);
    }
    .stat-item.good .stat-value { color: var(--good); text-shadow: 0 0 8px rgba(51,255,136,.5); }
    .stat-item.bad .stat-value { color: var(--bad); text-shadow: var(--glow-bad); }
    .stat-item.warn .stat-value { color: var(--warn); text-shadow: var(--glow-warn); }
    .stat-item.accent .stat-value { color: var(--accent); }

    thead th { position: sticky; top: 0; background: var(--screen-bg); z-index: 3; }

    /* ── Animated indicators ──────────────────────── */
    .refresh-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--good); display: inline-block; margin-right: 4px;
      animation: pulse 2s infinite;
      box-shadow: 0 0 4px rgba(51,255,136,.6);
    }
    .loading-spinner {
      display: inline-block; width: 14px; height: 14px;
      border: 2px solid var(--border); border-top-color: var(--accent);
      border-radius: 50%; animation: spin .6s linear infinite;
      margin-right: 6px; vertical-align: middle;
    }
    .panel-collapsible > .card-title { cursor: pointer; user-select: none; }
    .panel-collapsible > .card-title::before { content: "\\25BC "; font-size: 9px; margin-right: 4px; }
    .panel-collapsible.collapsed > .card-title::before { content: "\\25B6 "; }
    .panel-collapsible.collapsed > *:not(.card-title) { display: none; }

    @media (max-width: 768px) {
      .tab-nav { gap: 1px; }
      .tab { padding: 4px 8px; font-size: 8px; }
      .stats-banner { gap: 8px; padding: 8px; }
      .stat-value { font-size: 18px; }
      .ctrl-bar .spacer + span { display: none; }
      .chip { padding: 2px 6px; font-size: 8px; }
    }
    @media (max-width: 480px) {
      .tab { padding: 3px 6px; font-size: 7px; }
      .stat-item { min-width: 55px; }
      .stat-value { font-size: 15px; }
    }

    /* ── Heatmap ─────────────────────────────────── */
    .heatmap { display: grid; grid-template-columns: auto repeat(24, 1fr); gap: 2px; }
    .heatmap-label { display: flex; align-items: center; justify-content: flex-end; padding-right: 6px; color: var(--muted); font-size: 9px; min-width: 30px; }
    .heatmap-header { text-align: center; color: var(--muted); font-size: 8px; }
    .heatmap-cell { aspect-ratio: 1; border-radius: 1px; min-width: 0; }
    .heatmap-cell:hover { outline: 1px solid var(--accent); box-shadow: var(--glow); }

    /* ── Toast ────────────────────────────────────── */
    .toast {
      position: fixed; bottom: 16px; right: 16px; padding: 8px 14px;
      background: var(--screen-bg); border: 2px solid var(--chassis-dark);
      border-radius: 4px; font-size: 10px; z-index: 999;
      box-shadow: var(--bevel-in), var(--glow);
      opacity: 0; transform: translateY(8px);
      transition: opacity .3s, transform .3s; pointer-events: none;
      color: var(--accent); text-transform: uppercase; letter-spacing: 0.06em;
      text-shadow: 0 0 4px rgba(51,255,136,.3);
    }
    .toast.show { opacity: 1; transform: translateY(0); pointer-events: auto; }

    .sparkline { display: inline-block; vertical-align: middle; margin-left: 4px; }

    /* ── Activity bars ───────────────────────────── */
    .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
    .bar-row .bar-date { width: 72px; font-size: 9px; color: var(--muted); flex-shrink: 0; }
    .bar-row .bar-fill {
      height: 12px; border-radius: 2px;
      background: linear-gradient(90deg, var(--accent), rgba(51,255,136,.3));
      box-shadow: 0 0 4px rgba(51,255,136,.3);
      transition: width .3s;
    }
    .bar-row .bar-count { font-size: 9px; color: var(--muted); min-width: 28px; }
    .pager {
      display: flex; justify-content: space-between; align-items: center;
      gap: 10px; margin-top: 10px;
    }
    .pager a {
      border: 1px solid #333; border-radius: 4px; padding: 5px 12px;
      background: linear-gradient(180deg, #2e3136, #22252a);
      color: #888; text-transform: uppercase; font-size: 9px; letter-spacing: 0.08em;
      box-shadow: var(--bevel-out);
    }
    .pager a:hover {
      color: var(--accent); border-color: #555;
      background: linear-gradient(180deg, #383b40, #2a2d32);
      text-shadow: 0 0 4px rgba(51,255,136,.3);
    }
    .message {
      background: var(--screen-bg);
      border: 2px solid var(--chassis-dark);
      border-radius: 4px; padding: 12px; margin-bottom: 8px;
      color: var(--ink);
      box-shadow: var(--bevel-in);
      border-left: 3px solid var(--ink-dim);
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <div>
        <div class="title">StevesBot Workflow Inspector</div>
        <div class="subtitle">Support pipeline, chores, and user memory at a glance.</div>
      </div>
      <nav class="tab-nav" id="main-nav">
        <a href="/" class="tab" data-path="/">Runs</a>
        <a href="/threads" class="tab" data-path="/threads">Threads</a>
        <a href="/analytics" class="tab" data-path="/analytics">Analytics</a>
        <a href="/chores" class="tab" data-path="/chores">Chores</a>
        <a href="/skills" class="tab" data-path="/skills">Skills</a>
        <a href="/scores" class="tab" data-path="/scores">Scores</a>
        <a href="/memory" class="tab" data-path="/memory">Memory</a>
      </nav>
    </div>
    <div class="ctrl-bar">
      <button onclick="toggleScanlines()">Scanlines</button>
      <button onclick="cycleDensity()">Density</button>
      <button onclick="location.reload()">Refresh</button>
      <span class="spacer"></span>
      <span id="uptime-display" style="color:var(--muted);font-size:11px"></span>
      <span style="color:var(--muted);font-size:11px"><kbd>Ctrl</kbd>+<kbd>K</kbd> search &middot; <kbd>1</kbd>-<kbd>7</kbd> nav &middot; <kbd>R</kbd> refresh</span>
    </div>
    <div class="toast" id="toast"></div>
    <script>
    // Scanline toggle
    const scanLevels = [0.04, 0.08, 0, 0.02];
    let scanIdx = 0;
    function toggleScanlines() {
      scanIdx = (scanIdx + 1) % scanLevels.length;
      document.documentElement.style.setProperty('--scan-opacity', scanLevels[scanIdx]);
      localStorage.setItem('sb-scan', String(scanLevels[scanIdx]));
      showToast(scanLevels[scanIdx] === 0 ? 'SCANLINES OFF' : 'SCANLINES ' + Math.round(scanLevels[scanIdx]*100) + '%');
    }
    (function() {
      const saved = localStorage.getItem('sb-scan');
      if (saved !== null) document.documentElement.style.setProperty('--scan-opacity', saved);
    })();

    // Density toggle
    const densities = ['', 'compact', 'dense'];
    let dIdx = densities.indexOf(localStorage.getItem('sb-density') || '') || 0;
    function cycleDensity() {
      dIdx = (dIdx + 1) % densities.length;
      const mode = densities[dIdx];
      document.documentElement.setAttribute('data-density', mode);
      localStorage.setItem('sb-density', mode);
      showToast(mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : 'Comfortable');
    }
    (function() {
      const saved = localStorage.getItem('sb-density');
      if (saved) document.documentElement.setAttribute('data-density', saved);
    })();

    // Toast
    function showToast(msg) {
      const t = document.getElementById('toast');
      if (!t) return;
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(t._timer);
      t._timer = setTimeout(() => t.classList.remove('show'), 2000);
    }

    // Auto-refresh
    let refreshTimer = null;
    let refreshOn = localStorage.getItem('sb-autorefresh') !== 'off';
    const refreshSec = Number(localStorage.getItem('sb-refresh-interval') || '30');

    function startAutoRefresh() {
      stopAutoRefresh();
      if (refreshOn) {
        refreshTimer = setInterval(() => location.reload(), refreshSec * 1000);
      }
      updateRefreshUI();
    }
    function stopAutoRefresh() {
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    }
    function toggleAutoRefresh() {
      refreshOn = !refreshOn;
      localStorage.setItem('sb-autorefresh', refreshOn ? 'on' : 'off');
      if (refreshOn) startAutoRefresh();
      else stopAutoRefresh();
      updateRefreshUI();
      showToast(refreshOn ? 'Auto-refresh ON (' + refreshSec + 's)' : 'Auto-refresh OFF');
    }
    function updateRefreshUI() {
      const btn = document.getElementById('refresh-toggle-btn');
      if (btn) btn.innerHTML = refreshOn ? '<span class="refresh-dot"></span>Auto ' + refreshSec + 's' : 'Auto-refresh OFF';
    }
    startAutoRefresh();

    // Active tab highlight
    (function() {
      const path = location.pathname;
      document.querySelectorAll('.tab').forEach(function(tab) {
        const tp = tab.getAttribute('data-path');
        if (tp === path || (tp === '/' && (path === '/' || path === '/runs'))) {
          tab.classList.add('active');
        }
      });
    })();

    // Collapsible panels
    document.querySelectorAll('.panel-collapsible > .card-title').forEach(function(title) {
      title.addEventListener('click', function() {
        title.parentElement.classList.toggle('collapsed');
      });
    });

    // Uptime display
    fetch('/api/health').then(r => r.json()).then(d => {
      const el = document.getElementById('uptime-display');
      if (el && d.uptime) {
        const h = Math.floor(d.uptime / 3600);
        const m = Math.floor((d.uptime % 3600) / 60);
        el.textContent = 'Up ' + (h > 0 ? h + 'h ' : '') + m + 'm | ' + d.runs.total + ' runs';
      }
    }).catch(() => {});

    // Keyboard shortcuts
    document.addEventListener('keydown', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.ctrlKey || e.metaKey) return;
      const nav = { '1': '/', '2': '/threads', '3': '/analytics', '4': '/chores', '5': '/skills', '6': '/scores', '7': '/memory' };
      if (nav[e.key]) { e.preventDefault(); location.href = nav[e.key]; }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); location.reload(); showToast('Refreshed'); }
      if (e.key === 'd' || e.key === 'D') { e.preventDefault(); toggleTheme(); }
    });
    </script>
    ${body}
  </div>
</body>
</html>`;
}

function outcomeClass(outcome: string): string {
  if (outcome === "approved") {
    return "pill good";
  }
  if (outcome === "error" || outcome === "rejected") {
    return "pill bad";
  }
  return "pill warn";
}

function buildUrl(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function cloneParams(input: URLSearchParams): URLSearchParams {
  return new URLSearchParams(input.toString());
}

function summarizeOutcome(item: WorkflowRunSummary): string {
  if (item.outcome === "error") {
    return item.errorText ?? item.triage?.rationale ?? "Pipeline error without a captured reason.";
  }

  if (item.outcome === "no-reply") {
    return item.triage?.rationale ?? "Triage chose not to reply, but no rationale was captured.";
  }

  if (item.outcome === "hold") {
    return item.triage?.rationale ?? "Triage chose to hold and wait for more signal.";
  }

  if (item.outcome === "rejected") {
    const issues = [...(item.review?.issues ?? []), ...(item.review?.policyFlags ?? [])];
    if (issues.length > 0) {
      return issues.join("; ");
    }
    return item.triage?.rationale ?? "Draft was rejected without a detailed reason.";
  }

  if (item.outcome === "approved") {
    return item.replyText ?? item.review?.finalBody ?? "Reply approved.";
  }

  return item.triage?.rationale ?? item.errorText ?? "No outcome detail captured.";
}

function renderRunsTable(items: WorkflowRunSummary[]): string {
  if (items.length === 0) {
    return '<div class="panel">No workflow runs match the current filters.</div>';
  }

  const rows = items
    .map(
      (item) => `<tr data-outcome="${escapeHtml(item.outcome)}">
        <td><a href="/runs/${item.id}">#${item.id}</a><br /><span class="step-meta"><a href="/runs/${item.id}">Inspect</a></span></td>
        <td>${escapeHtml(item.routeId)}<br /><span class="step-meta"><a href="/threads/${encodeURIComponent(item.threadKey)}">${escapeHtml(item.threadKey)}</a></span></td>
        <td>${escapeHtml(item.authorName)}<br /><span class="step-meta">${escapeHtml(item.messageId)}</span></td>
        <td>${escapeHtml(truncate(item.messageContent, 180))}</td>
        <td><span class="${outcomeClass(item.outcome)}">${escapeHtml(item.outcome)}</span></td>
        <td>${escapeHtml(truncate(summarizeOutcome(item), 220))}</td>
        <td>${escapeHtml(item.qwenModel)}<br /><span class="step-meta">${escapeHtml(item.gptModel)}</span></td>
        <td>${formatDuration(item.totalDurationMs)}</td>
        <td>${escapeHtml(item.discordCreatedAt.slice(0, 16).replace("T", " "))}<br /><span class="step-meta">${timeAgo(item.discordCreatedAt)}</span></td>
      </tr>`,
    )
    .join("");

  return `<div class="panel"><table>
    <thead>
      <tr>
        <th>Run</th>
        <th>Route / Thread</th>
        <th>Author</th>
        <th>Incoming Message</th>
        <th>Outcome</th>
        <th>Reason</th>
        <th>Models</th>
        <th>Duration</th>
        <th>Discord Time</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderRunsPage(db: AppDatabase, url: URL): string {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get("pageSize") ?? "25") || 25));
  const routeId = url.searchParams.get("routeId") ?? "";
  const outcome = url.searchParams.get("outcome") ?? "";
  const threadKey = url.searchParams.get("threadKey") ?? "";
  const query = url.searchParams.get("q") ?? "";

  // Stats for banner
  const outcomeDist = db.getOutcomeDistribution();
  const totalAllRuns = outcomeDist.reduce((s, o) => s + o.count, 0);
  const approvedAll = outcomeDist.find(o => o.outcome === "approved")?.count ?? 0;
  const rejectedAll = outcomeDist.find(o => o.outcome === "rejected")?.count ?? 0;
  const attemptedAll = approvedAll + rejectedAll;
  const approvalRateAll = attemptedAll > 0 ? Math.round(approvedAll / attemptedAll * 100) : 0;
  const recentActivity = db.getRecentActivity(1);
  const todayRuns = recentActivity.length > 0 ? recentActivity[0].count : 0;

  const result = db.listWorkflowRuns({
    page,
    pageSize,
    routeId: routeId || undefined,
    outcome: outcome || undefined,
    threadKey: threadKey || undefined,
    query: query || undefined,
  });
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const routeOptions = ["", ...db.listWorkflowRouteIds()]
    .map((value) => `<option value="${escapeHtml(value)}"${value === routeId ? " selected" : ""}>${escapeHtml(value || "All routes")}</option>`)
    .join("");

  // Quick-filter chips
  const chipOutcomes = ["", "approved", "no-reply", "hold", "rejected", "error"];
  const chips = chipOutcomes.map(o => {
    const p = cloneParams(url.searchParams);
    p.set("outcome", o);
    p.set("page", "1");
    const label = o || "All";
    const active = outcome === o;
    return `<a href="${buildUrl("/", p)}" class="chip${active ? " active" : ""}">${escapeHtml(label)}</a>`;
  }).join("");

  const statsBanner = `<div class="stats-banner">
    <div class="stat-item accent"><div class="stat-value">${totalAllRuns}</div><div class="stat-label">Total Runs</div></div>
    <div class="stat-item"><div class="stat-value">${todayRuns}</div><div class="stat-label">Today</div></div>
    <div class="stat-item good"><div class="stat-value">${approvalRateAll}%</div><div class="stat-label">Approval Rate</div></div>
    <div class="stat-item good"><div class="stat-value">${approvedAll}</div><div class="stat-label">Approved</div></div>
    <div class="stat-item bad"><div class="stat-value">${rejectedAll}</div><div class="stat-label">Rejected</div></div>
    <div class="stat-item warn"><div class="stat-value">${result.total}</div><div class="stat-label">Filtered</div></div>
  </div>
  <div class="chip-bar">${chips}</div>`;

  const filters = `<div class="panel">
    <form class="filters" method="get" action="/">
      <div>
        <label for="routeId">Route</label>
        <select id="routeId" name="routeId">${routeOptions}</select>
      </div>
      <div>
        <label for="outcome">Outcome</label>
        <select id="outcome" name="outcome">
          <option value=""${outcome === "" ? " selected" : ""}>All outcomes</option>
          <option value="approved"${outcome === "approved" ? " selected" : ""}>approved</option>
          <option value="no-reply"${outcome === "no-reply" ? " selected" : ""}>no-reply</option>
          <option value="hold"${outcome === "hold" ? " selected" : ""}>hold</option>
          <option value="rejected"${outcome === "rejected" ? " selected" : ""}>rejected</option>
          <option value="error"${outcome === "error" ? " selected" : ""}>error</option>
        </select>
      </div>
      <div>
        <label for="threadKey">Thread Key</label>
        <input id="threadKey" name="threadKey" value="${escapeHtml(threadKey)}" />
      </div>
      <div>
        <label for="q">Text Search</label>
        <input id="q" name="q" value="${escapeHtml(query)}" />
      </div>
      <div>
        <label for="pageSize">Page Size</label>
        <input id="pageSize" name="pageSize" type="number" min="1" max="100" value="${pageSize}" />
      </div>
      <div>
        <label>&nbsp;</label>
        <button type="submit">Filter</button>
      </div>
    </form>
  </div>`;

  const summary = `<div class="panel">
    <div class="meta">
      <div><strong>Total runs</strong>${result.total}</div>
      <div><strong>Page</strong>${result.page} / ${totalPages}</div>
      <div><strong>Newest run shown</strong>${result.items[0] ? `#${result.items[0].id}` : "n/a"}</div>
      <div><strong>Oldest run shown</strong>${result.items.at(-1) ? `#${result.items.at(-1)?.id}` : "n/a"}</div>
    </div>
  </div>`;

  const prevParams = cloneParams(url.searchParams);
  prevParams.set("page", String(Math.max(1, page - 1)));
  const nextParams = cloneParams(url.searchParams);
  nextParams.set("page", String(Math.min(totalPages, page + 1)));
  const pager = `<div class="panel pager">
    <a href="${buildUrl("/", prevParams)}">Previous</a>
    <div>${result.total} total runs</div>
    <a href="${buildUrl("/", nextParams)}">Next</a>
  </div>`;

  return renderLayout("Workflow Runs", `${statsBanner}${filters}${summary}${renderRunsTable(result.items)}${pager}`);
}

function renderStep(step: WorkflowStepRecord): string {
  const blocks: string[] = [];
  if (step.inputText) {
    blocks.push(`<div class="stack"><div class="step-meta">Input</div><pre>${escapeHtml(step.inputText)}</pre></div>`);
  }
  if (step.outputText) {
    blocks.push(`<div class="stack"><div class="step-meta">Output</div><pre>${escapeHtml(step.outputText)}</pre></div>`);
  }
  if (step.requestJson !== undefined) {
    blocks.push(`<div class="stack"><div class="step-meta">Request JSON</div><pre>${formatJson(step.requestJson)}</pre></div>`);
  }
  if (step.responseJson !== undefined) {
    blocks.push(`<div class="stack"><div class="step-meta">Response JSON</div><pre>${formatJson(step.responseJson)}</pre></div>`);
  }
  if (step.metadata !== undefined) {
    blocks.push(`<div class="stack"><div class="step-meta">Metadata</div><pre>${formatJson(step.metadata)}</pre></div>`);
  }

  return `<details ${step.status === "error" ? "open" : ""}>
    <summary>
      <span>#${step.stepIndex}</span>
      <span>${escapeHtml(step.phase)}</span>
      <span>${escapeHtml(step.label)}</span>
      <span class="${step.status === "ok" ? "pill good" : "pill bad"}">${escapeHtml(step.status)}</span>
      <span class="step-meta">${formatDuration(step.durationMs)}</span>
      ${step.modelName ? `<span class="step-meta">${escapeHtml(step.modelName)}</span>` : ""}
    </summary>
    <div class="stack" style="margin-top: 12px;">
      <div class="meta">
        <div><strong>Started</strong>${escapeHtml(step.startedAt)}</div>
        <div><strong>Completed</strong>${escapeHtml(step.completedAt)}</div>
        <div><strong>Model Label</strong>${escapeHtml(step.modelLabel ?? "n/a")}</div>
        <div><strong>Base URL</strong>${escapeHtml(step.modelBaseUrl ?? "n/a")}</div>
      </div>
      ${blocks.join("")}
    </div>
  </details>`;
}

function renderRunDetail(run: WorkflowRunDetail, db?: AppDatabase): string {
  const triageJson = run.triage ? formatJson(run.triage) : escapeHtml("null");
  const reviewJson = run.review ? formatJson(run.review) : escapeHtml("null");
  const steps = run.steps.map(renderStep).join("");
  const feedback = db?.getRunFeedback(run.id);
  const draftUsage = db?.getDraftUsage(run.id);

  return renderLayout(
    `Run #${run.id}`,
    `<div class="grid two">
      <div class="panel">
        <div class="card-title">Run Summary</div>
        <div class="meta">
          <div><strong>Route</strong>${escapeHtml(run.routeId)}</div>
          <div><strong>Outcome</strong><span class="${outcomeClass(run.outcome)}">${escapeHtml(run.outcome)}</span></div>
          <div><strong>Thread Key</strong><a href="/threads/${encodeURIComponent(run.threadKey)}">${escapeHtml(run.threadKey)}</a></div>
          <div><strong>Duration</strong>${formatDuration(run.totalDurationMs)}</div>
          <div><strong>Qwen Model</strong>${escapeHtml(run.qwenModel)}</div>
          <div><strong>GPT Model</strong>${escapeHtml(run.gptModel)}</div>
          <div><strong>Triage Action</strong>${escapeHtml(run.triage?.action ?? "n/a")}</div>
          <div><strong>Problem Open</strong>${escapeHtml(run.triage ? String(run.triage.problemOpen) : "n/a")}</div>
          <div><strong>Human Handling</strong>${escapeHtml(run.triage ? String(run.triage.humanAlreadyHandling) : "n/a")}</div>
          <div><strong>Novelty</strong>${escapeHtml(run.triage ? String(run.triage.novelty) : "n/a")}</div>
          <div><strong>Discord Time</strong>${escapeHtml(run.discordCreatedAt)}</div>
          <div><strong>Received</strong>${escapeHtml(run.receivedAt)}</div>
          <div><strong>Author</strong>${escapeHtml(run.authorName)} (${escapeHtml(run.authorId)})</div>
          <div><strong>Source</strong><a href="${escapeHtml(run.sourceUrl)}">Open in Discord</a></div>
        </div>
        <div class="stack">
          <div><strong>Incoming Message</strong></div>
          <pre>${escapeHtml(run.messageContent)}</pre>
        </div>
        ${run.replyText ? `<div class="stack"><div><strong>Final Reply</strong></div><pre>${escapeHtml(run.replyText)}</pre></div>` : ""}
        ${run.errorText ? `<div class="stack"><div><strong>Error</strong></div><pre>${escapeHtml(run.errorText)}</pre></div>` : ""}
        ${draftUsage ? `<div class="stack" style="margin-top:12px">
          <div><strong>Draft Usage</strong></div>
          <div><span class="${draftUsage.usage === "skipped" ? "pill bad" : draftUsage.usage === "used" ? "pill good" : "pill warn"}">${escapeHtml(draftUsage.usage)}</span> at ${escapeHtml(draftUsage.createdAt)}</div>
        </div>` : ""}
        <div class="stack" style="margin-top:12px">
          <div><strong>Feedback</strong></div>
          <div id="feedback-area">
            ${feedback
              ? `<span style="font-size:1.4em">${feedback.rating === "good" ? "&#128077;" : "&#128078;"}</span> Marked <strong>${feedback.rating}</strong>${feedback.note ? ` — ${escapeHtml(feedback.note)}` : ""}`
              : `<button onclick="sendFeedback(${run.id},'good')" style="font-size:1.2em;padding:4px 16px;cursor:pointer">&#128077; Good</button>
                 <button onclick="sendFeedback(${run.id},'bad')" style="font-size:1.2em;padding:4px 16px;cursor:pointer;margin-left:8px">&#128078; Bad</button>`
            }
          </div>
        </div>
        <script>
        async function sendFeedback(runId, rating) {
          const note = rating === 'bad' ? prompt('What was wrong? (optional)') : null;
          const res = await fetch('/api/feedback/' + runId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating, note: note || undefined })
          });
          if (res.ok) {
            document.getElementById('feedback-area').innerHTML =
              '<span style="font-size:1.4em">' + (rating === 'good' ? '&#128077;' : '&#128078;') + '</span> Marked <strong>' + rating + '</strong>' + (note ? ' — ' + note : '');
          }
        }
        </script>
      </div>
      <div class="panel">
        <div class="card-title">Decisions</div>
        <div class="stack">
          <div><strong>Triage JSON</strong></div>
          <pre>${triageJson}</pre>
          <div><strong>Review JSON</strong></div>
          <pre>${reviewJson}</pre>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="card-title">Step Timeline</div>
      ${steps || "<div>No steps recorded.</div>"}
    </div>`,
  );
}

function renderThreadPage(db: AppDatabase, threadKey: string): string {
  const runs = db.listWorkflowRunsForThread(threadKey);
  const messages = runs
    .map(
      (run) => `<div class="message">
        <div><a href="/runs/${run.id}">Run #${run.id}</a> <span class="${outcomeClass(run.outcome)}">${escapeHtml(run.outcome)}</span></div>
        <div class="step-meta">${escapeHtml(run.discordCreatedAt)} | ${escapeHtml(run.authorName)} | ${escapeHtml(run.messageId)}</div>
        <pre>${escapeHtml(run.messageContent)}</pre>
        ${run.replyText ? `<div class="step-meta">Reply</div><pre>${escapeHtml(run.replyText)}</pre>` : ""}
      </div>`,
    )
    .join("");

  return renderLayout(
    `Thread ${threadKey}`,
    `<div class="panel">
      <div class="card-title">Thread: ${escapeHtml(threadKey)}</div>
      <div class="subtitle">${runs.length} captured incoming messages in this conversation.</div>
    </div>
    <div class="panel">${messages || "No messages recorded for this thread."}</div>`,
  );
}

function renderAnalyticsPage(db: AppDatabase): string {
  const conversion = db.getDraftConversionRate();
  const byRoute = db.getDraftUsageStats();
  const triageStats = db.getTriageStats();
  const outcomes = db.getOutcomeDistribution();
  const outcomesByRoute = db.getOutcomeByRoute();
  const queueHealth = db.getQueueHealth();
  const recentActivity = db.getRecentActivity(7);
  const avgDurations = db.getAvgDurations();
  const feedback = db.getFeedbackSummary();
  const guardrailStats = db.getGuardrailStats();
  const rawDb = (db as unknown as { db: InstanceType<typeof import("better-sqlite3")> }).db;

  // ── Response time chart: avg pipeline duration by day (14 days) ──
  const responseTimeRows = rawDb.prepare(
    `SELECT DATE(created_at) as day, ROUND(AVG(total_duration_ms)) as avg_ms
     FROM workflow_runs
     WHERE created_at >= DATE('now', '-14 days') AND total_duration_ms > 0
     GROUP BY day ORDER BY day ASC`
  ).all() as Array<{ day: string; avg_ms: number }>;
  const rtMax = Math.max(...responseTimeRows.map(r => Number(r.avg_ms)), 1);
  const responseTimeBars = responseTimeRows.map(r => {
    const avg = Number(r.avg_ms);
    const pct = Math.round((avg / rtMax) * 100);
    return `<div class="bar-row">
      <span class="bar-date">${escapeHtml(r.day.slice(5))}</span>
      <div style="flex:1;background:var(--border);border-radius:2px;height:12px">
        <div class="bar-fill" style="width:${Math.max(2, pct)}%"></div>
      </div>
      <span class="bar-count">${Math.round(avg)}ms</span>
    </div>`;
  }).join("");

  // ── Top KB hits: knowledge base search terms from workflow_steps ──
  const kbHitRows = rawDb.prepare(
    `SELECT metadata_json FROM workflow_steps
     WHERE (label LIKE '%knowledge%' OR label LIKE '%searchKnowledge%' OR label LIKE '%kb%')
       AND metadata_json IS NOT NULL
     ORDER BY id DESC LIMIT 500`
  ).all() as Array<{ metadata_json: string }>;
  const kbTermCounts = new Map<string, { hits: number; found: number }>();
  for (const row of kbHitRows) {
    try {
      const meta = JSON.parse(row.metadata_json);
      const query = (meta.query ?? meta.input?.query ?? meta.search ?? "") as string;
      const resultCount = Number(meta.resultCount ?? meta.results ?? meta.hitCount ?? 0);
      if (query) {
        const term = query.toLowerCase().trim().slice(0, 60);
        const entry = kbTermCounts.get(term) ?? { hits: 0, found: 0 };
        entry.hits++;
        if (resultCount > 0) entry.found++;
        kbTermCounts.set(term, entry);
      }
    } catch { /* skip */ }
  }
  // Also check workflow_steps output_text for tool calls with searchKnowledgeBase
  const kbToolRows = rawDb.prepare(
    `SELECT input_text, output_text, status FROM workflow_steps
     WHERE label LIKE '%searchKnowledge%' OR label LIKE '%Auto-inject knowledge%'
     ORDER BY id DESC LIMIT 300`
  ).all() as Array<{ input_text: string | null; output_text: string | null; status: string }>;
  for (const row of kbToolRows) {
    try {
      if (row.input_text) {
        const input = JSON.parse(row.input_text);
        const query = (input.query ?? "") as string;
        if (query) {
          const term = query.toLowerCase().trim().slice(0, 60);
          const entry = kbTermCounts.get(term) ?? { hits: 0, found: 0 };
          entry.hits++;
          if (row.status === "ok" && row.output_text && row.output_text.length > 10) entry.found++;
          kbTermCounts.set(term, entry);
        }
      }
    } catch { /* skip */ }
  }
  const topKbTerms = [...kbTermCounts.entries()]
    .sort((a, b) => b[1].hits - a[1].hits)
    .slice(0, 10);
  const kbHitsHtml = topKbTerms.length > 0
    ? '<table><thead><tr><th>Search Term</th><th>Searches</th><th>Results Found</th></tr></thead><tbody>' +
      topKbTerms.map(([term, data]) => {
        const foundPill = data.found > 0
          ? `<span class="pill good">${data.found}/${data.hits}</span>`
          : `<span class="pill bad">0/${data.hits}</span>`;
        return `<tr><td>${escapeHtml(term)}</td><td>${data.hits}</td><td>${foundPill}</td></tr>`;
      }).join("") + '</tbody></table>'
    : '<div class="step-meta">No knowledge base search data found yet.</div>';

  // ── Pipeline funnel: Total → Triaged as support → Drafted → Approved → Posted ──
  const funnelTotal = rawDb.prepare(
    "SELECT COUNT(*) as cnt FROM workflow_runs"
  ).get() as { cnt: number };
  const funnelTriaged = rawDb.prepare(
    "SELECT COUNT(*) as cnt FROM workflow_runs WHERE outcome IN ('approved', 'rejected', 'hold') OR (triage_json IS NOT NULL AND json_extract(triage_json, '$.action') = 'reply')"
  ).get() as { cnt: number };
  const funnelDrafted = rawDb.prepare(
    "SELECT COUNT(DISTINCT wr.id) as cnt FROM workflow_runs wr INNER JOIN workflow_steps ws ON ws.run_id = wr.id WHERE ws.phase = 'draft' AND ws.status = 'ok'"
  ).get() as { cnt: number };
  const funnelApproved = rawDb.prepare(
    "SELECT COUNT(*) as cnt FROM workflow_runs WHERE outcome = 'approved'"
  ).get() as { cnt: number };
  const funnelPosted = rawDb.prepare(
    "SELECT COUNT(*) as cnt FROM workflow_runs WHERE outcome = 'approved' AND reply_text IS NOT NULL AND reply_text != ''"
  ).get() as { cnt: number };

  const funnelSteps = [
    { label: "Total Messages", count: Number(funnelTotal.cnt) },
    { label: "Triaged as Support", count: Number(funnelTriaged.cnt) },
    { label: "Drafted", count: Number(funnelDrafted.cnt) },
    { label: "Approved", count: Number(funnelApproved.cnt) },
    { label: "Posted", count: Number(funnelPosted.cnt) },
  ];
  const funnelMax = Math.max(funnelSteps[0].count, 1);
  const funnelHtml = funnelSteps.map((step, i) => {
    const pct = Math.round((step.count / funnelMax) * 100);
    const dropoff = i > 0 && funnelSteps[i - 1].count > 0
      ? Math.round((1 - step.count / funnelSteps[i - 1].count) * 100)
      : 0;
    const dropoffLabel = i > 0 ? ` <span style="color:var(--bad);font-size:9px">${dropoff > 0 ? "\u2193" + dropoff + "%" : "\u2014"}</span>` : "";
    return `<div class="bar-row">
      <span class="bar-date" style="width:120px">${escapeHtml(step.label)}</span>
      <div style="flex:1;background:var(--border);border-radius:2px;height:14px">
        <div class="bar-fill" style="width:${Math.max(2, pct)}%"></div>
      </div>
      <span class="bar-count">${step.count}${dropoffLabel}</span>
    </div>`;
  }).join("");

  const conversionRate = conversion.total > 0 ? Math.round(((conversion.used + conversion.modified) / conversion.total) * 100) : 0;

  // Draft usage by route table
  const routeMap = new Map<string, { used: number; modified: number; skipped: number }>();
  for (const row of byRoute) {
    if (!routeMap.has(row.routeId)) {
      routeMap.set(row.routeId, { used: 0, modified: 0, skipped: 0 });
    }
    const entry = routeMap.get(row.routeId)!;
    if (row.usage === "used") entry.used = row.count;
    else if (row.usage === "modified") entry.modified = row.count;
    else if (row.usage === "skipped") entry.skipped = row.count;
  }

  const routeRows = [...routeMap.entries()]
    .map(([routeId, stats]) => {
      const total = stats.used + stats.modified + stats.skipped;
      const rate = total > 0 ? Math.round(((stats.used + stats.modified) / total) * 100) : 0;
      return `<tr>
        <td>${escapeHtml(routeId)}</td>
        <td>${stats.used}</td>
        <td>${stats.modified}</td>
        <td>${stats.skipped}</td>
        <td>${total}</td>
        <td><strong>${rate}%</strong></td>
      </tr>`;
    })
    .join("");

  // Outcome distribution rows
  const totalRuns = outcomes.reduce((sum, o) => sum + o.count, 0);
  const outcomeRows = outcomes
    .map((o) => {
      const pct = totalRuns > 0 ? Math.round((o.count / totalRuns) * 100) : 0;
      return `<tr>
        <td><span class="${outcomeClass(o.outcome)}">${escapeHtml(o.outcome)}</span></td>
        <td>${o.count}</td>
        <td>${pct}%</td>
      </tr>`;
    })
    .join("");

  // Outcome by route table
  const routeOutcomeMap = new Map<string, Map<string, number>>();
  const allOutcomes = new Set<string>();
  for (const row of outcomesByRoute) {
    allOutcomes.add(row.outcome);
    if (!routeOutcomeMap.has(row.routeId)) {
      routeOutcomeMap.set(row.routeId, new Map());
    }
    routeOutcomeMap.get(row.routeId)!.set(row.outcome, row.count);
  }
  const outcomeList = [...allOutcomes];
  const routeOutcomeRows = [...routeOutcomeMap.entries()]
    .map(([routeId, counts]) => {
      const total = [...counts.values()].reduce((s, c) => s + c, 0);
      const cells = outcomeList.map((o) => `<td>${counts.get(o) ?? 0}</td>`).join("");
      return `<tr><td>${escapeHtml(routeId)}</td>${cells}<td><strong>${total}</strong></td></tr>`;
    })
    .join("");
  const outcomeHeaders = outcomeList.map((o) => `<th>${escapeHtml(o)}</th>`).join("");

  // Recent activity (bar chart via inline divs)
  const maxDaily = Math.max(...recentActivity.map((d) => d.count), 1);
  const activityBars = recentActivity
    .map((d) => {
      const pct = Math.round((d.count / maxDaily) * 100);
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span class="step-meta" style="width:80px">${escapeHtml(d.date)}</span>
        <div style="background:var(--accent);height:18px;border-radius:4px;width:${Math.max(2, pct)}%;opacity:0.7"></div>
        <span class="step-meta">${d.count}</span>
      </div>`;
    })
    .join("");

  // Avg durations table
  const durationRows = avgDurations
    .map((d) => `<tr>
      <td><span class="${outcomeClass(d.outcome)}">${escapeHtml(d.outcome)}</span></td>
      <td>${formatDuration(d.avgMs)}</td>
      <td>${d.count}</td>
    </tr>`)
    .join("");

  const queueTotal = queueHealth.queued + queueHealth.leased + queueHealth.completed + queueHealth.failed;

  return renderLayout(
    "Analytics",
    `<div class="grid two">
      <div class="panel">
        <div class="card-title">Triage Distribution</div>
        <div class="meta">
          <div><strong>Total Runs</strong>${totalRuns}</div>
        </div>
        <table>
          <thead><tr><th>Outcome</th><th>Count</th><th>%</th></tr></thead>
          <tbody>${outcomeRows}</tbody>
        </table>
      </div>
      <div class="panel">
        <div class="card-title">Queue Health</div>
        <div class="meta">
          <div><strong>Queued</strong><span class="pill warn">${queueHealth.queued}</span></div>
          <div><strong>Processing</strong><span class="pill warn">${queueHealth.leased}</span></div>
          <div><strong>Completed</strong><span class="pill good">${queueHealth.completed}</span></div>
          <div><strong>Failed</strong><span class="pill bad">${queueHealth.failed}</span></div>
          <div><strong>Total Jobs</strong>${queueTotal}</div>
        </div>
      </div>
    </div>
    <div class="grid two">
      <div class="panel">
        <div class="card-title">Activity (Last 7 Days)</div>
        ${activityBars || "<div>No recent activity.</div>"}
      </div>
      <div class="panel">
        <div class="card-title">Avg Pipeline Duration</div>
        <table>
          <thead><tr><th>Outcome</th><th>Avg Duration</th><th>Runs</th></tr></thead>
          <tbody>${durationRows}</tbody>
        </table>
      </div>
    </div>
    <div class="grid two">
      <div class="panel">
        <div class="card-title">Outcomes by Route</div>
        <table>
          <thead><tr><th>Route</th>${outcomeHeaders}<th>Total</th></tr></thead>
          <tbody>${routeOutcomeRows}</tbody>
        </table>
      </div>
      <div class="panel">
        <div class="card-title">Feedback &amp; Draft Conversion</div>
        <div class="meta">
          <div><strong>Feedback: Good</strong><span class="pill good">${feedback.good}</span></div>
          <div><strong>Feedback: Bad</strong><span class="pill bad">${feedback.bad}</span></div>
        </div>
        <div class="card-title" style="margin-top:12px">Draft Conversion</div>
        <div class="meta">
          <div><strong>Total Approved</strong>${conversion.total}</div>
          <div><strong>Used As-Is</strong><span class="pill good">${conversion.used}</span></div>
          <div><strong>Modified</strong><span class="pill warn">${conversion.modified}</span></div>
          <div><strong>Skipped</strong><span class="pill bad">${conversion.skipped}</span></div>
          <div><strong>Unreviewed</strong>${conversion.unreviewed}</div>
          <div><strong>Conversion Rate</strong><strong>${conversionRate}%</strong></div>
        </div>
        <div class="step-meta" style="margin-top:8px">
          Conversion = (used + modified) / total approved. Click buttons on review channel messages to record.
        </div>
        ${routeRows
          ? `<table style="margin-top:12px">
              <thead><tr><th>Route</th><th>Used</th><th>Modified</th><th>Skipped</th><th>Total</th><th>Rate</th></tr></thead>
              <tbody>${routeRows}</tbody>
            </table>`
          : ""
        }
      </div>
    </div>
    <div class="grid two">
      <div class="panel">
        <div class="card-title">Interactive Triage Events</div>
        <div class="meta">
          <div><strong>Total Flows</strong>${triageStats.total}</div>
          <div><strong>Searched</strong><span class="pill good">${triageStats.searched}</span></div>
          <div><strong>Waited</strong><span class="pill warn">${triageStats.waited}</span></div>
        </div>
        ${triageStats.total > 0 ? `
        <table style="margin-top:12px">
          <thead><tr><th>Product</th><th>Count</th></tr></thead>
          <tbody>${Object.entries(triageStats.byProduct).map(([p, c]) => `<tr><td>${escapeHtml(p)}</td><td>${c}</td></tr>`).join("")}</tbody>
        </table>
        <table style="margin-top:12px">
          <thead><tr><th>Platform</th><th>Count</th></tr></thead>
          <tbody>${Object.entries(triageStats.byPlatform).map(([p, c]) => `<tr><td>${escapeHtml(p)}</td><td>${c}</td></tr>`).join("")}</tbody>
        </table>
        ` : '<div class="step-meta">No triage events recorded yet.</div>'}
      </div>
      <div class="panel">
        <div class="card-title">Pipeline Quality</div>
        ${(() => {
          const approvedCount = outcomes.find(o => o.outcome === "approved")?.count ?? 0;
          const rejectedCount = outcomes.find(o => o.outcome === "rejected")?.count ?? 0;
          const attempted = approvedCount + rejectedCount;
          const approvalRate = attempted > 0 ? Math.round(approvedCount / attempted * 100) : 0;
          const guardrailRows = guardrailStats.map(g =>
            `<tr><td>${escapeHtml(g.label)}</td><td>${g.count}</td></tr>`
          ).join("");
          return `
            <div class="meta">
              <div><strong>Approval Rate</strong><strong>${approvalRate}%</strong> (${approvedCount}/${attempted} attempted)</div>
            </div>
            ${guardrailRows ? `
            <table style="margin-top:12px">
              <thead><tr><th>Guardrail / Fast-Path</th><th>Count</th></tr></thead>
              <tbody>${guardrailRows}</tbody>
            </table>` : '<div class="step-meta">No guardrail data yet.</div>'}
          `;
        })()}
      </div>
    </div>
    <div class="grid two">
      <div class="panel">
        <div class="card-title">Avg Response Time (14 Days)</div>
        ${responseTimeBars || '<div class="step-meta">No response time data yet.</div>'}
      </div>
      <div class="panel">
        <div class="card-title">Pipeline Funnel</div>
        ${funnelHtml || '<div class="step-meta">No funnel data yet.</div>'}
      </div>
    </div>
    <div class="grid two">
      <div class="panel">
        <div class="card-title">Top KB Search Terms</div>
        ${kbHitsHtml}
      </div>
      <div class="panel panel-collapsible" id="rejections-panel">
        <div class="card-title">Top Rejection Reasons</div>
        <div id="rejections-container" class="step-meta">Loading...</div>
      </div>
    </div>
    <div class="grid two">
      <div class="panel panel-collapsible" id="heatmap-panel">
        <div class="card-title">Activity Heatmap (14 days)</div>
        <div id="heatmap-container" class="step-meta">Loading heatmap...</div>
      </div>
    <div class="panel panel-collapsible" id="categories-panel">
      <div class="card-title">Category Breakdown</div>
      <div id="categories-container" class="step-meta">Loading...</div>
    </div>
    <script>
    // Async-load heatmap
    fetch('/api/heatmap').then(r=>r.json()).then(d => {
      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const max = d.max || 1;
      let h = '<div class="heatmap"><div></div>';
      for (let i = 0; i < 24; i++) h += '<div class="heatmap-header">' + (i % 3 === 0 ? i + 'h' : '') + '</div>';
      for (let dow = 0; dow < 7; dow++) {
        h += '<div class="heatmap-label">' + dayNames[dow] + '</div>';
        for (let hr = 0; hr < 24; hr++) {
          const v = d.grid[dow][hr] || 0;
          const intensity = v > 0 ? Math.max(0.15, v / max) : 0.04;
          const color = v > 0 ? 'rgba(51,255,136,' + intensity + ')' : 'var(--border)';
          h += '<div class="heatmap-cell" style="background:' + color + '" title="' + dayNames[dow] + ' ' + hr + ':00 — ' + v + ' runs"></div>';
        }
      }
      h += '</div>';
      document.getElementById('heatmap-container').innerHTML = h;
    }).catch(() => { document.getElementById('heatmap-container').textContent = 'Could not load heatmap.'; });

    // Async-load top rejections
    fetch('/api/top-rejections').then(r=>r.json()).then(d => {
      if (!d.reasons || !d.reasons.length) { document.getElementById('rejections-container').textContent = 'No rejection data yet.'; return; }
      let t = '<table><thead><tr><th>Reason</th><th>Count</th><th>% of Rejected</th></tr></thead><tbody>';
      for (const r of d.reasons) {
        const pct = d.totalRejected > 0 ? Math.round(r.count / d.totalRejected * 100) : 0;
        t += '<tr><td>' + r.reason + '</td><td>' + r.count + '</td><td><div style="display:flex;align-items:center;gap:6px"><div style="width:' + Math.min(pct, 100) + 'px;height:6px;background:var(--bad);border-radius:3px"></div> ' + pct + '%</div></td></tr>';
      }
      t += '</tbody></table>';
      document.getElementById('rejections-container').innerHTML = t;
    }).catch(() => { document.getElementById('rejections-container').textContent = 'Could not load rejection data.'; });

    // Async-load categories
    fetch('/api/categories').then(r=>r.json()).then(cats => {
      if (!cats || !cats.length) { document.getElementById('categories-container').textContent = 'No category data yet.'; return; }
      let t = '<table><thead><tr><th>Category</th><th>Total</th><th>Approved</th><th>Rejected</th><th>No-Reply/Hold</th><th>Approval Rate</th></tr></thead><tbody>';
      for (const c of cats.slice(0, 15)) {
        const attempted = c.approved + c.rejected;
        const rate = attempted > 0 ? Math.round(c.approved / attempted * 100) + '%' : '\u2014';
        t += '<tr><td><strong>' + c.category + '</strong></td><td>' + c.total + '</td><td>' + c.approved + '</td><td>' + c.rejected + '</td><td>' + c.noReply + '</td><td>' + rate + '</td></tr>';
      }
      t += '</tbody></table>';
      document.getElementById('categories-container').innerHTML = t;
    }).catch(() => { document.getElementById('categories-container').textContent = 'Could not load category data.'; });
    </script>`,
  );
}

function writeHtml(response: http.ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
  }
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body) as Record<string, unknown>;
}

async function runChoreNow(db: AppDatabase, choreId: string): Promise<{ status: string; result: string; durationMs: number }> {
  const chore = db.getChore(choreId);
  if (!chore) {
    throw new Error("Unknown chore: " + choreId);
  }
  const rootDir = getRootDir();
  const skills = await loadAllSkills(path.join(rootDir, "skills"));
  const skill = skills.get(chore.skillId);
  if (!skill) {
    throw new Error("Unknown skill: " + chore.skillId);
  }
  let opsKnowledge = "";
  try {
    opsKnowledge = readFileSync(path.join(rootDir, "resources", "ops", "infrastructure.md"), "utf8");
  } catch {
    // Optional ops context.
  }
  return executeSkill({
    skill,
    rootDir,
    db,
    choreId: chore.id,
    opsKnowledge,
  });
}



function renderScoresPage(db: AppDatabase): string {
  const summary = db.getScoreSummary();
  const breakdown = db.getScoreBreakdown();
  const rules = db.getScoreRules();
  const recentLog = db.getRecentScoreLog(30);

  const summaryHtml = '<div class="meta">' +
    '<div><strong>Today</strong><span style="font-size:24px;font-weight:700;color:var(--accent)">' + summary.today + '</span></div>' +
    '<div><strong>This Week</strong>' + summary.week + '</div>' +
    '<div><strong>All Time</strong>' + summary.total + '</div>' +
    '<div><strong>Streak</strong>' + summary.streak + " day" + (summary.streak !== 1 ? "s" : "") + '</div></div>';

  const breakdownRows = breakdown.map(b => {
    const pct = b.dailyCap > 0 ? Math.min(100, Math.round(b.points / b.dailyCap * 100)) : 0;
    const bar = b.dailyCap > 0
      ? '<div style="background:rgba(51,255,136,.08);border:1px solid var(--border);border-radius:3px;height:14px;width:100px;display:inline-block;vertical-align:middle"><div style="background:var(--accent);border-radius:4px;height:14px;width:' + pct + 'px;opacity:0.7"></div></div> ' + pct + "%"
      : "";
    return "<tr><td>" + escapeHtml(b.eventType) + "</td><td><strong>" + b.points + "</strong></td><td>" + b.count + "</td><td>" + (b.dailyCap || "\u221e") + "</td><td>" + bar + "</td></tr>";
  }).join("");

  const rulesRows = rules.map(r =>
    "<tr><td><strong>" + escapeHtml(r.eventType) + "</strong></td><td>" + r.pointsPer + "</td><td>" + (r.dailyCap || "\u221e") + "</td><td>" + escapeHtml(r.description) + "</td></tr>"
  ).join("");

  const logRows = recentLog.map(l =>
    '<tr><td class="step-meta">' + escapeHtml(l.createdAt.slice(0, 19).replace("T", " ")) +
    "</td><td>" + escapeHtml(l.eventType) + "</td><td><strong>+" + l.points +
    '</strong></td><td class="step-meta">' + escapeHtml(l.description || "") + "</td></tr>"
  ).join("");

  return renderLayout("Scores",
    '<div class="panel"><div class="card-title">Bot Score</div>' + summaryHtml + "</div>" +
    '<div class="grid two">' +
      '<div class="panel"><div class="card-title">Todays Breakdown</div>' +
        (breakdownRows
          ? '<table><thead><tr><th>Event</th><th>Points</th><th>Count</th><th>Daily Cap</th><th>Progress</th></tr></thead><tbody>' + breakdownRows + "</tbody></table>"
          : '<div class="step-meta">No points earned yet today.</div>') +
      "</div>" +
      '<div class="panel"><div class="card-title">Scoring Rules</div>' +
        '<table><thead><tr><th>Event</th><th>Points</th><th>Daily Cap</th><th>Description</th></tr></thead><tbody>' + rulesRows + "</tbody></table>" +
      "</div>" +
    "</div>" +
    '<div class="panel"><div class="card-title">Recent Score Log</div>' +
      (logRows
        ? '<table><thead><tr><th>Time</th><th>Event</th><th>Points</th><th>Details</th></tr></thead><tbody>' + logRows + "</tbody></table>"
        : '<div class="step-meta">No score entries yet.</div>') +
    "</div>"
  );
}

function renderSkillsPage(db: AppDatabase): string {
  type CatalogSkillEntry = { id: string; name: string; category: string; description: string; status: string; schedule: string | null; requirements: string[] };
  type CatEntry = { id: string; label: string };
  let catalogSkills: CatalogSkillEntry[] = [];
  let categories: CatEntry[] = [];
  try {
    const catalogPath = path.join(getRootDir(), "resources", "manifests", "skills-catalog.yaml");
    const raw = readFileSync(catalogPath, "utf8");
    const parsed = parseYaml(raw) as { skills: CatalogSkillEntry[]; categories: CatEntry[] };
    catalogSkills = parsed.skills ?? [];
    categories = parsed.categories ?? [];
  } catch { /* ok */ }
  const catalogById = new Map(catalogSkills.map((skill) => [skill.id, skill]));
  const catMap = new Map<string, Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    requirements: string[];
    schedule: string | null;
    runtimeState: string;
    type: string;
    info: string;
  }>>();
  const catLabels = new Map(categories.map((category) => [category.id, category.label]));
  const chores = db.listChores();
  const choreMap = new Map(chores.map((chore) => [chore.skillId, chore]));
  const skillSnapshots = [...loadSkillManifestSnapshots(getRootDir()).values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const skill of skillSnapshots) {
    const catalog = catalogById.get(skill.id);
    const chore = choreMap.get(skill.id);
    const category = catalog?.category ?? "uncategorized";
    const runtimeState = chore
      ? (chore.enabled ? "scheduled" : "scheduled-off")
      : (skill.schedule ? "unregistered" : "on-demand");
    const infoParts = [
      skill.type,
      chore ? `chore: ${chore.id}` : "no chore row",
      chore ? `${chore.runCount} runs` : "0 runs",
    ];
    const entry = {
      id: skill.id,
      name: skill.name,
      description: catalog?.description ?? skill.description,
      category,
      requirements: catalog?.requirements ?? [],
      schedule: chore?.schedule ?? (skill.schedule || null),
      runtimeState,
      type: skill.type,
      info: infoParts.join(" | "),
    };
    if (!catMap.has(category)) {
      catMap.set(category, []);
    }
    catMap.get(category)!.push(entry);
  }
  if (catMap.has("uncategorized") && !catLabels.has("uncategorized")) {
    catLabels.set("uncategorized", "Uncatalogued");
  }
  let sections = "";
  for (const [catId, catSkills] of catMap) {
    const label = catLabels.get(catId) ?? catId;
    const rows = catSkills.map(s => {
      const sc = s.runtimeState === "scheduled" ? "pill good" : s.runtimeState === "scheduled-off" ? "pill bad" : s.runtimeState === "unregistered" ? "pill warn" : "pill";
      const reqs = (s.requirements || []).map((r: string) => '<span style="background:rgba(51,255,136,.1);border:1px solid rgba(51,255,136,.2);border-radius:3px;padding:1px 6px;font-size:10px;margin-right:3px;color:var(--ink)">' + escapeHtml(r) + '</span>').join("");
      return '<tr><td><strong>' + escapeHtml(s.name) + '</strong><br/><span class="step-meta">' + escapeHtml(s.id) + '</span></td><td>' + escapeHtml(s.description) + '</td><td><span class="' + sc + '">' + escapeHtml(s.runtimeState) + '</span></td><td>' + escapeHtml(s.schedule ?? "on-demand") + '</td><td>' + reqs + '</td><td class="step-meta">' + escapeHtml(s.info) + '</td></tr>';
    }).join("");
    sections += '<div class="panel" style="margin-bottom:16px"><div class="card-title">' + escapeHtml(label) + '</div><table><thead><tr><th>Skill</th><th>Description</th><th>Status</th><th>Schedule</th><th>Requires</th><th>Info</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  const total = skillSnapshots.length;
  const scheduled = skillSnapshots.filter((skill) => choreMap.get(skill.id)?.enabled).length;
  const disabled = skillSnapshots.filter((skill) => {
    const chore = choreMap.get(skill.id);
    return chore?.enabled === false;
  }).length;
  const onDemand = skillSnapshots.filter((skill) => !skill.schedule).length;
  return renderLayout("Skills Catalog", '<div class="panel"><div class="card-title">Skills Catalog</div><div class="subtitle">' + total + ' loaded skill manifests with runtime chore state.</div><div class="meta" style="margin-top:12px"><div><strong>Scheduled On</strong><span class="pill good">' + scheduled + '</span></div><div><strong>Scheduled Off</strong><span class="pill bad">' + disabled + '</span></div><div><strong>On-demand</strong><span class="pill">' + onDemand + '</span></div><div><strong>Categories</strong>' + catMap.size + '</div></div></div>' + sections);
}

function renderChoresPage(db: AppDatabase): string {
  const rows = buildChoreDashboardRows(db);
  const enabledCount = rows.filter((row) => row.enabled).length;
  const disabledCount = rows.length - enabledCount;
  const driftCount = rows.filter((row) => row.hasScheduleDrift || row.hasDefaultDrift || row.missingManifest).length;
  const errorCount = rows.filter((row) => row.lastStatus === "error").length;

  const choreRows = rows.map((row) => {
    const statusClass = row.lastStatus === "ok" ? "pill good" : row.lastStatus === "error" ? "pill bad" : "pill";
    const lastRun = row.lastRunAt ? row.lastRunAt.slice(0, 19).replace("T", " ") : "never";
    const nextRun = row.nextRunAt ? row.nextRunAt.slice(0, 19).replace("T", " ") : (row.enabled ? "unknown" : "disabled");
    const scheduleNotes: string[] = [];
    if (row.manifestSchedule) {
      scheduleNotes.push("skill.yaml: " + row.manifestSchedule + (row.hasScheduleDrift ? " (override)" : ""));
    }
    if (row.defaultSchedule && row.defaultSchedule !== row.manifestSchedule) {
      scheduleNotes.push("default: " + row.defaultSchedule + (row.hasDefaultDrift ? " (override)" : ""));
    }
    if (row.missingManifest) {
      scheduleNotes.push("skill manifest missing");
    }
    return '<tr>' +
      '<td><strong>' + escapeHtml(row.name) + '</strong><br/><span class="step-meta">' + escapeHtml(row.id) + ' | ' + escapeHtml(row.skillId) + ' | ' + escapeHtml(row.skillType) + '</span></td>' +
      '<td><form onsubmit="return saveChoreSchedule(event,\'' + escapeHtml(row.id) + '\')" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
        '<input id="schedule-' + escapeHtml(row.id) + '" value="' + escapeHtml(row.schedule) + '" style="min-width:150px;max-width:180px" />' +
        '<button type="submit">Save</button></form>' +
        (scheduleNotes.length > 0 ? '<div class="step-meta" style="margin-top:6px">' + escapeHtml(scheduleNotes.join(" | ")) + '</div>' : "") +
      '</td>' +
      '<td><span class="' + (row.enabled ? 'pill good' : 'pill bad') + '">' + (row.enabled ? 'on' : 'off') + '</span><br/><span class="step-meta">next: ' + escapeHtml(nextRun) + '</span></td>' +
      '<td>' + escapeHtml(lastRun) + (row.lastRunAt ? '<br/><span class="step-meta">' + escapeHtml(timeAgo(row.lastRunAt)) + '</span>' : '') + '</td>' +
      '<td><span class="' + statusClass + '">' + escapeHtml(row.lastStatus ?? 'pending') + '</span></td>' +
      '<td>' + row.runCount + '</td>' +
      '<td><div style="display:flex;gap:6px;flex-wrap:wrap">' +
        '<button id="toggle-' + escapeHtml(row.id) + '" onclick="toggleChore(\'' + escapeHtml(row.id) + '\',' + String(!row.enabled) + ')">' + (row.enabled ? 'Disable' : 'Enable') + '</button>' +
        '<button id="run-' + escapeHtml(row.id) + '" onclick="runChore(\'' + escapeHtml(row.id) + '\')">Run now</button>' +
      '</div></td>' +
      '</tr>';
  }).join("");

  const choreTimelines = rows.map((row) => {
    const logs = db.getRecentChoreLogs(row.id, 5);
    if (logs.length === 0) return "";
    const dots = logs.map(l => {
      const color = l.status === "ok" ? "var(--good)" : "var(--bad)";
      const glow = l.status === "ok" ? "0 0 4px rgba(51,255,136,.5)" : "0 0 4px rgba(255,51,85,.5)";
      const ts = l.createdAt.slice(0, 16).replace("T", " ");
      return '<span title="' + escapeHtml(l.status) + " | " + escapeHtml(ts) + " | " + l.durationMs + 'ms"' +
        ' style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + color + ';box-shadow:' + glow + ';margin-right:3px;cursor:help"></span>';
    }).join("");
    const latestLog = logs[0];
    const timeline = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
      '<span style="min-width:140px;font-weight:700;font-size:11px;color:var(--ink)">' + escapeHtml(row.id) + '</span>' +
      '<span>' + dots + '</span>' +
      '<span class="step-meta">' + escapeHtml(latestLog.createdAt.slice(0, 16).replace("T", " ")) + ' | ' + latestLog.durationMs + 'ms</span>' +
      '</div>';
    return timeline;
  }).filter(Boolean).join("");

  const logSections = rows.map((row) => {
    const logs = db.getRecentChoreLogs(row.id, 5);
    if (logs.length === 0) return "";
    const logRows = logs.map(l => {
      const sc = l.status === "ok" ? "pill good" : "pill bad";
      return '<div class="message">' +
        '<div><span class="' + sc + '">' + escapeHtml(l.status) + '</span> ' +
        '<span class="step-meta">' + escapeHtml(l.createdAt.slice(0, 19).replace("T", " ")) + ' | ' + l.durationMs + 'ms</span></div>' +
        '<pre>' + escapeHtml(truncate(l.result, 800)) + '</pre></div>';
    }).join("");
    return '<details><summary><strong>' + escapeHtml(row.id) + '</strong> <span class="step-meta">(' + logs.length + ' recent)</span></summary><div style="margin-top:8px">' + logRows + '</div></details>';
  }).filter(Boolean).join("");

  const unregisteredScheduledSkills = [...loadSkillManifestSnapshots(getRootDir()).values()]
    .filter((skill) => skill.schedule)
    .filter((skill) => !rows.some((row) => row.skillId === skill.id))
    .map((skill) => '<tr><td><strong>' + escapeHtml(skill.name) + '</strong><br/><span class="step-meta">' + escapeHtml(skill.id) + ' | ' + escapeHtml(skill.type) + '</span></td><td>' + escapeHtml(skill.schedule) + '</td><td>' + escapeHtml(skill.description) + '</td></tr>')
    .join("");

  return renderLayout("Chores",
    '<div class="panel"><div class="card-title">Scheduled Chores</div>' +
    '<div class="subtitle">Runtime schedule comes from the chore row in SQLite. Use this page to enable, disable, run, and edit schedules.</div>' +
    '<div class="meta" style="margin-top:12px"><div><strong>Enabled</strong><span class="pill good">' + enabledCount + '</span></div><div><strong>Disabled</strong><span class="pill bad">' + disabledCount + '</span></div><div><strong>Errors</strong><span class="' + (errorCount > 0 ? 'pill bad' : 'pill good') + '">' + errorCount + '</span></div><div><strong>Drift / Missing</strong><span class="' + (driftCount > 0 ? 'pill warn' : 'pill good') + '">' + driftCount + '</span></div></div>' +
    '<table style="margin-top:12px"><thead><tr><th>Chore</th><th>Schedule</th><th>State</th><th>Last Run</th><th>Status</th><th>Runs</th><th>Actions</th></tr></thead>' +
    '<tbody>' + (choreRows || '<tr><td colspan="7">No chores registered.</td></tr>') + '</tbody></table></div>' +
    (unregisteredScheduledSkills ? '<div class="panel"><div class="card-title">Scheduled Skills Missing Chore Rows</div><table><thead><tr><th>Skill</th><th>Manifest Schedule</th><th>Description</th></tr></thead><tbody>' + unregisteredScheduledSkills + '</tbody></table></div>' : '') +
    (choreTimelines ? '<div class="panel"><div class="card-title">Chore History Timeline</div>' +
    '<div class="step-meta" style="margin-bottom:8px">Last 5 runs per chore. Green = ok, red = error. Hover for details.</div>' +
    choreTimelines + '</div>' : '') +
    '<div class="panel"><div class="card-title">Recent Execution Logs</div>' +
    (logSections || '<div class="step-meta">No chore runs recorded yet.</div>') + '</div>' +
    `<script>
    async function postChore(path, payload) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Request failed');
      }
      return data;
    }
    async function toggleChore(id, enabled) {
      try {
        await postChore('/api/chores/' + encodeURIComponent(id) + '/enabled', { enabled });
        showToast(enabled ? 'Chore enabled' : 'Chore disabled');
        setTimeout(() => location.reload(), 250);
      } catch (err) {
        showToast(err.message || 'Toggle failed');
      }
      return false;
    }
    async function saveChoreSchedule(event, id) {
      event.preventDefault();
      const input = document.getElementById('schedule-' + id);
      try {
        await postChore('/api/chores/' + encodeURIComponent(id) + '/schedule', { schedule: input.value });
        showToast('Schedule saved');
        setTimeout(() => location.reload(), 250);
      } catch (err) {
        showToast(err.message || 'Save failed');
      }
      return false;
    }
    async function runChore(id) {
      const btn = document.getElementById('run-' + id);
      if (btn) btn.disabled = true;
      try {
        const data = await postChore('/api/chores/' + encodeURIComponent(id) + '/run', {});
        showToast('Run ' + data.status + ' in ' + data.durationMs + 'ms');
        setTimeout(() => location.reload(), 400);
      } catch (err) {
        showToast(err.message || 'Run failed');
      } finally {
        if (btn) btn.disabled = false;
      }
      return false;
    }
    </script>`
  );
}

function renderMemoryPage(db: AppDatabase, url: URL): string {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = 25;
  const rawDb = (db as unknown as { db: InstanceType<typeof import("better-sqlite3")> }).db;
  const countRow = rawDb.prepare("SELECT COUNT(*) as cnt FROM user_memory").get() as { cnt: number } | undefined;
  const total = countRow?.cnt ?? 0;
  const offset = (page - 1) * pageSize;
  const rows = rawDb.prepare(
    "SELECT author_id, author_name, interaction_count, products_json, recent_issues_json, resolved_count, unresolved_count, first_seen_at, last_seen_at FROM user_memory ORDER BY last_seen_at DESC LIMIT ? OFFSET ?"
  ).all(pageSize, offset) as Array<{
    author_id: string; author_name: string; interaction_count: number; products_json: string;
    recent_issues_json: string; resolved_count: number; unresolved_count: number;
    first_seen_at: string; last_seen_at: string;
  }>;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const userRows = rows.map(r => {
    const products = JSON.parse(r.products_json) as string[];
    const issues = JSON.parse(r.recent_issues_json) as Array<{ date: string; route: string; category: string; summary: string; resolved: boolean }>;
    const resolvedPct = r.interaction_count > 0 ? Math.round(r.resolved_count / r.interaction_count * 100) : 0;
    const issueList = issues.slice(0, 3).map(i => {
      const st = i.resolved ? '<span class="pill good" style="font-size:10px">resolved</span>' : '<span class="pill bad" style="font-size:10px">open</span>';
      return '<div class="step-meta">[' + escapeHtml(i.date) + '] ' + escapeHtml(i.category) + ' ' + st + ' — ' + escapeHtml(truncate(i.summary, 100)) + '</div>';
    }).join("");
    return '<tr>' +
      '<td><strong>' + escapeHtml(r.author_name) + '</strong><br/><span class="step-meta">' + escapeHtml(r.author_id) + '</span></td>' +
      '<td>' + r.interaction_count + '</td>' +
      '<td>' + escapeHtml(products.join(", ") || "\u2014") + '</td>' +
      '<td>' + r.resolved_count + '/' + r.interaction_count + ' (' + resolvedPct + '%)</td>' +
      '<td>' + escapeHtml(r.first_seen_at.slice(0, 10)) + '</td>' +
      '<td>' + escapeHtml(r.last_seen_at.slice(0, 10)) + '</td>' +
      '<td>' + issueList + '</td></tr>';
  }).join("");

  // ── User leaderboard: most active users in last 30 days ──
  const leaderboardRows = rawDb.prepare(
    `SELECT author_name, author_id, interaction_count, products_json,
            resolved_count, unresolved_count, last_seen_at
     FROM user_memory
     WHERE last_seen_at >= DATE('now', '-30 days')
     ORDER BY interaction_count DESC
     LIMIT 15`
  ).all() as Array<{
    author_name: string; author_id: string; interaction_count: number; products_json: string;
    resolved_count: number; unresolved_count: number; last_seen_at: string;
  }>;
  const leaderboardMax = Math.max(...leaderboardRows.map(r => r.interaction_count), 1);
  const leaderboardHtml = leaderboardRows.length > 0
    ? '<table><thead><tr><th>#</th><th>User</th><th>Interactions</th><th>Activity</th><th>Products</th><th>Resolved / Unresolved</th><th>Last Seen</th></tr></thead><tbody>' +
      leaderboardRows.map((r, i) => {
        const products = JSON.parse(r.products_json) as string[];
        const barPct = Math.round((r.interaction_count / leaderboardMax) * 100);
        const resolvedRatio = (r.resolved_count + r.unresolved_count) > 0
          ? Math.round(r.resolved_count / (r.resolved_count + r.unresolved_count) * 100)
          : 0;
        const ratioClass = resolvedRatio >= 70 ? "pill good" : resolvedRatio >= 40 ? "pill warn" : "pill bad";
        return '<tr>' +
          '<td style="color:var(--muted);font-weight:700">' + (i + 1) + '</td>' +
          '<td><strong>' + escapeHtml(r.author_name) + '</strong></td>' +
          '<td>' + r.interaction_count + '</td>' +
          '<td><div style="background:var(--border);border-radius:2px;height:10px;width:80px;display:inline-block;vertical-align:middle"><div class="bar-fill" style="width:' + Math.max(2, barPct) + '%;height:10px"></div></div></td>' +
          '<td>' + escapeHtml(products.slice(0, 3).join(", ") || "\u2014") + '</td>' +
          '<td><span class="' + ratioClass + '">' + r.resolved_count + '/' + (r.resolved_count + r.unresolved_count) + ' (' + resolvedRatio + '%)</span></td>' +
          '<td class="step-meta">' + escapeHtml(r.last_seen_at.slice(0, 10)) + '</td></tr>';
      }).join("") + '</tbody></table>'
    : '<div class="step-meta">No active users in the last 30 days.</div>';

  const prevP = new URLSearchParams(url.searchParams.toString()); prevP.set("page", String(Math.max(1, page - 1)));
  const nextP = new URLSearchParams(url.searchParams.toString()); nextP.set("page", String(Math.min(totalPages, page + 1)));

  return renderLayout("User Memory",
    '<div class="panel"><div class="card-title">User Memory</div>' +
    '<div class="subtitle">' + total + ' users tracked. Per-user context is injected into drafting prompts.</div></div>' +
    '<div class="panel"><div class="card-title">Most Active Users (30 Days)</div>' + leaderboardHtml + '</div>' +
    '<div class="panel"><table>' +
    '<thead><tr><th>User</th><th>Interactions</th><th>Products</th><th>Resolved</th><th>First Seen</th><th>Last Seen</th><th>Recent Issues</th></tr></thead>' +
    '<tbody>' + (userRows || '<tr><td colspan="7">No user memory records yet.</td></tr>') + '</tbody></table></div>' +
    '<div class="panel pager"><a href="/memory?' + escapeHtml(prevP.toString()) + '">Previous</a>' +
    '<div>' + total + ' users | Page ' + page + '/' + totalPages + '</div>' +
    '<a href="/memory?' + escapeHtml(nextP.toString()) + '">Next</a></div>'
  );
}

function renderThreadsOverview(db: AppDatabase, url: URL): string {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = 25;
  const routeId = url.searchParams.get("routeId") ?? "";
  const rawDb = (db as unknown as { db: InstanceType<typeof import("better-sqlite3")> }).db;

  const whereClause = routeId ? " WHERE route_id = ?" : "";
  const params: unknown[] = routeId ? [routeId] : [];

  const countRow = rawDb.prepare("SELECT COUNT(DISTINCT thread_key) as cnt FROM workflow_runs" + whereClause).get(...params) as { cnt: number } | undefined;
  const total = countRow?.cnt ?? 0;
  const offset = (page - 1) * pageSize;
  const threads = rawDb.prepare(
    "SELECT thread_key, route_id, MIN(discord_created_at) as first_msg, MAX(discord_created_at) as last_msg, COUNT(*) as msg_count, GROUP_CONCAT(DISTINCT author_name) as authors, GROUP_CONCAT(DISTINCT outcome) as outcomes FROM workflow_runs" +
    whereClause + " GROUP BY thread_key ORDER BY last_msg DESC LIMIT ? OFFSET ?"
  ).all(...params, pageSize, offset) as Array<{
    thread_key: string; route_id: string; first_msg: string; last_msg: string;
    msg_count: number; authors: string; outcomes: string;
  }>;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const routeOptions = ["", ...db.listWorkflowRouteIds()]
    .map(v => '<option value="' + escapeHtml(v) + '"' + (v === routeId ? ' selected' : '') + '>' + escapeHtml(v || 'All routes') + '</option>')
    .join("");

  const threadRows = threads.map(t => {
    const outcomeList = t.outcomes.split(",");
    const hasApproved = outcomeList.includes("approved");
    const hasError = outcomeList.includes("error");
    const mainOutcome = hasApproved ? "approved" : hasError ? "error" : outcomeList[outcomeList.length - 1];
    return '<tr>' +
      '<td><a href="/threads/' + encodeURIComponent(t.thread_key) + '">' + escapeHtml(truncate(t.thread_key, 50)) + '</a></td>' +
      '<td>' + escapeHtml(t.route_id) + '</td>' +
      '<td>' + t.msg_count + '</td>' +
      '<td>' + escapeHtml(t.authors.split(",").slice(0, 3).join(", ")) + '</td>' +
      '<td><span class="' + outcomeClass(mainOutcome) + '">' + escapeHtml(mainOutcome) + '</span></td>' +
      '<td>' + escapeHtml(t.first_msg.slice(0, 16).replace("T", " ")) + '</td>' +
      '<td>' + escapeHtml(t.last_msg.slice(0, 16).replace("T", " ")) + '</td></tr>';
  }).join("");

  const prevP = new URLSearchParams(url.searchParams.toString()); prevP.set("page", String(Math.max(1, page - 1)));
  const nextP = new URLSearchParams(url.searchParams.toString()); nextP.set("page", String(Math.min(totalPages, page + 1)));

  return renderLayout("Threads",
    '<div class="panel"><form class="filters" method="get" action="/threads">' +
    '<div><label for="routeId">Route</label><select id="routeId" name="routeId">' + routeOptions + '</select></div>' +
    '<div><label>&nbsp;</label><button type="submit">Filter</button></div></form></div>' +
    '<div class="panel"><div class="card-title">Conversation Threads</div>' +
    '<div class="subtitle">' + total + ' unique threads grouped by thread key.</div>' +
    '<table style="margin-top:12px"><thead><tr><th>Thread</th><th>Route</th><th>Messages</th><th>Participants</th><th>Latest Outcome</th><th>First Message</th><th>Last Message</th></tr></thead>' +
    '<tbody>' + (threadRows || '<tr><td colspan="7">No threads found.</td></tr>') + '</tbody></table></div>' +
    '<div class="panel pager"><a href="/threads?' + escapeHtml(prevP.toString()) + '">Previous</a>' +
    '<div>' + total + ' threads | Page ' + page + '/' + totalPages + '</div>' +
    '<a href="/threads?' + escapeHtml(nextP.toString()) + '">Next</a></div>'
  );
}

export async function startObservabilityServer(db: AppDatabase, options: ServerOptions): Promise<http.Server> {
  registerMissingDefaultChores(db);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    // Handle POST for feedback API
    if (request.method === "POST" && url.pathname.startsWith("/api/feedback/")) {
      const runId = Number(url.pathname.slice("/api/feedback/".length));
      if (!Number.isInteger(runId)) {
        writeJson(response, 400, { error: "Run id must be an integer." });
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        try {
          const data = JSON.parse(body) as { rating?: string; note?: string };
          if (data.rating !== "good" && data.rating !== "bad") {
            writeJson(response, 400, { error: "Rating must be 'good' or 'bad'." });
            return;
          }
          db.setRunFeedback(runId, data.rating, data.note);
          writeJson(response, 200, { ok: true, runId, rating: data.rating });
        } catch {
          writeJson(response, 400, { error: "Invalid JSON body." });
        }
      });
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/chores/")) {
      const pathParts = url.pathname.split("/").filter(Boolean);
      const choreId = pathParts[2];
      const action = pathParts[3];
      if (!choreId || !action) {
        writeJson(response, 400, { error: "Missing chore id or action." });
        return;
      }

      const chore = db.getChore(choreId);
      if (!chore) {
        writeJson(response, 404, { error: "Chore not found." });
        return;
      }

      void (async () => {
        try {
          const body = await readJsonBody(request);
          if (action === "enabled") {
            if (typeof body.enabled !== "boolean") {
              writeJson(response, 400, { error: "`enabled` must be boolean." });
              return;
            }
            db.setChoreEnabled(choreId, body.enabled);
            writeJson(response, 200, { ok: true, id: choreId, enabled: body.enabled });
            return;
          }

          if (action === "schedule") {
            const schedule = typeof body.schedule === "string" ? body.schedule.trim() : "";
            if (!validateCronExpression(schedule)) {
              writeJson(response, 400, { error: "Schedule must be a 5-field cron expression." });
              return;
            }
            db.updateChoreSchedule(choreId, schedule);
            writeJson(response, 200, { ok: true, id: choreId, schedule });
            return;
          }

          if (action === "run") {
            const result = await runChoreNow(db, choreId);
            writeJson(response, 200, { ok: true, id: choreId, ...result });
            return;
          }

          writeJson(response, 404, { error: "Unknown chore action." });
        } catch (err) {
          writeJson(response, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return;
    }


    // ─── Interactive triage test endpoint ──────────────────────────────
    if (request.method === "POST" && (url.pathname === "/api/start-triage" || url.pathname === "/api/test-triage")) {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", async () => {
        try {
          const params = JSON.parse(body || "{}") as Record<string, string>;
          const channelId = params.channelId ?? process.env.STEVESBOT_TEST_CHANNEL ?? "";
          const triggerMessageId = params.triggerMessageId ?? "test-" + Date.now();
          const userId = params.userId ?? "0";
          const token = options.discordToken ?? process.env.DISCORD_BOT_TOKEN ?? "";

          if (!channelId || !token) {
            writeJson(response, 400, { error: "Missing channelId or DISCORD_BOT_TOKEN" });
            return;
          }

          const preselectedProduct = params.preselectedProduct;
          const result = await sendTriagePrompt(token, channelId, triggerMessageId, userId, preselectedProduct);
          if (result.error) {
            writeJson(response, 502, { error: result.error });
          } else {
            writeJson(response, 200, { ok: true, messageId: result.messageId, activeFlows: getActiveFlowCount() });
          }
        } catch (err) {
          writeJson(response, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }
    if (request.method !== "GET") {
      writeHtml(response, 405, renderLayout("Method Not Allowed", '<div class="panel">Only GET is supported.</div>'));
      return;
    }

        if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
      const dashPath = path.resolve("dashboard", "index.html");
      if (existsSync(dashPath)) {
        writeHtml(response, 200, readFileSync(dashPath, "utf8"));
      } else {
        writeHtml(response, 404, "<h1>Dashboard not found</h1>");
      }
      return;
    }

    if (url.pathname === "/favicon.svg") {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#0d6b78"/><rect x="20" y="30" width="60" height="45" rx="10" fill="#fffaf3"/><circle cx="36" cy="50" r="7" fill="#0d6b78"/><circle cx="64" cy="50" r="7" fill="#0d6b78"/><rect x="38" y="62" width="24" height="4" rx="2" fill="#0d6b78"/><rect x="30" y="14" width="6" height="16" rx="3" fill="#fffaf3"/><rect x="64" y="14" width="6" height="16" rx="3" fill="#fffaf3"/></svg>`;
      response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
      response.end(svg);
      return;
    }

    if (url.pathname === "/" || url.pathname === "/runs") {
      writeHtml(response, 200, renderRunsPage(db, url));
      return;
    }

    if (url.pathname === "/analytics") {
      writeHtml(response, 200, renderAnalyticsPage(db));
      return;
    }

    if (url.pathname.startsWith("/runs/")) {
      const id = Number(url.pathname.slice("/runs/".length));
      if (!Number.isInteger(id)) {
        writeHtml(response, 400, renderLayout("Bad Run Id", '<div class="panel">Run id must be an integer.</div>'));
        return;
      }
      const run = db.getWorkflowRun(id);
      if (!run) {
        writeHtml(response, 404, renderLayout("Run Not Found", '<div class="panel">No run exists with that id.</div>'));
        return;
      }
      writeHtml(response, 200, renderRunDetail(run, db));
      return;
    }

    if (url.pathname.startsWith("/threads/")) {
      const threadKey = decodeURIComponent(url.pathname.slice("/threads/".length));
      writeHtml(response, 200, renderThreadPage(db, threadKey));
      return;
    }

    // ── New insight APIs ────────────────────────────────
    if (url.pathname === "/api/heatmap") {
      const rawDb = (db as unknown as { db: InstanceType<typeof import("better-sqlite3")> }).db;
      const days = Math.min(Number(url.searchParams.get("days") ?? "14"), 30);
      const rows = rawDb.prepare(
        `SELECT CAST(strftime('%w', created_at) AS INTEGER) as dow,
                CAST(strftime('%H', created_at) AS INTEGER) as hour,
                COUNT(*) as c
         FROM workflow_runs
         WHERE created_at >= date('now', '-' || ? || ' days')
         GROUP BY dow, hour`
      ).all(days) as Array<{ dow: number; hour: number; c: number }>;
      const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
      let max = 0;
      for (const r of rows) { grid[r.dow][r.hour] = r.c; if (r.c > max) max = r.c; }
      writeJson(response, 200, { grid, max, days });
      return;
    }

    if (url.pathname === "/api/top-rejections") {
      const rawDb = (db as unknown as { db: InstanceType<typeof import("better-sqlite3")> }).db;
      const rows = rawDb.prepare(
        "SELECT review_json FROM workflow_runs WHERE outcome = 'rejected' AND review_json IS NOT NULL ORDER BY id DESC LIMIT 500"
      ).all() as Array<{ review_json: string }>;
      const reasons: Record<string, number> = {};
      for (const r of rows) {
        try {
          const review = JSON.parse(r.review_json);
          if (Array.isArray(review.issues)) for (const i of review.issues) reasons[i] = (reasons[i] || 0) + 1;
          if (Array.isArray(review.policyFlags)) for (const f of review.policyFlags) reasons[f] = (reasons[f] || 0) + 1;
        } catch { /* skip */ }
      }
      const sorted = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 15)
        .map(([reason, count]) => ({ reason, count }));
      writeJson(response, 200, { reasons: sorted, totalRejected: rows.length });
      return;
    }

    if (url.pathname === "/api/categories") {
      const rawDb = (db as unknown as { db: InstanceType<typeof import("better-sqlite3")> }).db;
      const rows = rawDb.prepare(
        "SELECT triage_json, outcome FROM workflow_runs WHERE triage_json IS NOT NULL ORDER BY id DESC LIMIT 2000"
      ).all() as Array<{ triage_json: string; outcome: string }>;
      const cats: Record<string, { total: number; approved: number; rejected: number; noReply: number }> = {};
      for (const r of rows) {
        try {
          const t = JSON.parse(r.triage_json);
          const cat = t.category || "unknown";
          if (!cats[cat]) cats[cat] = { total: 0, approved: 0, rejected: 0, noReply: 0 };
          cats[cat].total++;
          if (r.outcome === "approved") cats[cat].approved++;
          else if (r.outcome === "rejected") cats[cat].rejected++;
          else cats[cat].noReply++;
        } catch { /* skip */ }
      }
      const result = Object.entries(cats).sort((a, b) => b[1].total - a[1].total)
        .map(([category, data]) => ({ category, ...data }));
      writeJson(response, 200, result);
      return;
    }

    if (url.pathname === "/api/top-askers") {
      const rawDb = (db as unknown as { db: InstanceType<typeof import("better-sqlite3")> }).db;
      const days = Math.min(Number(url.searchParams.get("days") ?? "30"), 90);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "15"), 50);
      const rows = rawDb.prepare(
        `SELECT author_name, author_id, COUNT(*) as message_count,
                COUNT(DISTINCT thread_key) as thread_count,
                MAX(discord_created_at) as last_seen
         FROM workflow_runs
         WHERE created_at >= date('now', '-' || ? || ' days')
         GROUP BY author_id
         ORDER BY message_count DESC
         LIMIT ?`
      ).all(days, limit);
      writeJson(response, 200, { users: rows, days });
      return;
    }

    if (url.pathname === "/api/hourly-volume") {
      const rawDb = (db as unknown as { db: InstanceType<typeof import("better-sqlite3")> }).db;
      const rows = rawDb.prepare(
        `SELECT strftime('%Y-%m-%dT%H:00', created_at) as hour, outcome, COUNT(*) as c
         FROM workflow_runs WHERE created_at >= date('now', '-7 days')
         GROUP BY hour, outcome ORDER BY hour ASC`
      ).all();
      writeJson(response, 200, rows);
      return;
    }

        if (url.pathname === "/api/health") {
      const outcomes = db.getOutcomeDistribution();
      const queue = db.getQueueHealth();
      const guardrails = db.getGuardrailStats();
      const totalRuns = outcomes.reduce((sum, o) => sum + o.count, 0);
      const outcomeMap: Record<string, number> = {};
      for (const o of outcomes) outcomeMap[o.outcome] = o.count;
      const approved = outcomeMap["approved"] ?? 0;
      const rejected = outcomeMap["rejected"] ?? 0;
      const attempted = approved + rejected;
      const guardrailMap: Record<string, number> = {};
      for (const g of guardrails) guardrailMap[g.label] = g.count;
      writeJson(response, 200, {
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        runs: { total: totalRuns, ...outcomeMap },
        approvalRate: attempted > 0 ? Math.round(approved / attempted * 100) : 0,
        attempted,
        queue,
        guardrails: guardrailMap,
      });
      return;
    }

        if (url.pathname === "/api/runs") {
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
      const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get("pageSize") ?? "25") || 25));
      writeJson(
        response,
        200,
        db.listWorkflowRuns({
          page,
          pageSize,
          routeId: url.searchParams.get("routeId") ?? undefined,
          outcome: url.searchParams.get("outcome") ?? undefined,
          threadKey: url.searchParams.get("threadKey") ?? undefined,
          query: url.searchParams.get("q") ?? undefined,
        }),
      );
      return;
    }

    if (url.pathname.startsWith("/api/runs/")) {
      const id = Number(url.pathname.slice("/api/runs/".length));
      if (!Number.isInteger(id)) {
        writeJson(response, 400, { error: "Run id must be an integer." });
        return;
      }
      const run = db.getWorkflowRun(id);
      if (!run) {
        writeJson(response, 404, { error: "Run not found." });
        return;
      }
      writeJson(response, 200, run);
      return;
    }

    if (url.pathname === "/scores") {
      writeHtml(response, 200, renderScoresPage(db));
      return;
    }

        if (url.pathname === "/skills") {
      writeHtml(response, 200, renderSkillsPage(db));
      return;
    }

        if (url.pathname === "/chores") {
      writeHtml(response, 200, renderChoresPage(db));
      return;
    }

    if (url.pathname === "/memory") {
      writeHtml(response, 200, renderMemoryPage(db, url));
      return;
    }

    if (url.pathname === "/threads") {
      writeHtml(response, 200, renderThreadsOverview(db, url));
      return;
    }

        writeHtml(response, 404, renderLayout("Not Found", '<div class="panel">No page exists at this path.</div>'));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("Observability server failed to bind.");
  }
  return server;
}
