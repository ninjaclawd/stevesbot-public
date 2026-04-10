#!/usr/bin/env tsx
/**
 * Deep agentic analysis of the codebase and KB using GPT-5.4-pro.
 * Multiple parallel workers analyzing different aspects simultaneously.
 * Writes findings to learnings/ for the bot to reference.
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const ROOT = path.resolve(process.env.STEVESBOT_ROOT ?? ".");
const LOG = path.join(ROOT, "logs", "deep-analyze.log");

function loadEnv(): void {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split("=");
    if (key && !(key in process.env)) process.env[key] = rest.join("=");
  }
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG, line + "\n"); } catch {}
}

async function gpt(system: string, user: string, maxTokens = 8000): Promise<string> {
  const baseUrl = process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/v1";
  const apiKey = process.env.OPENCODE_API_KEY ?? "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.ANALYZE_MODEL ?? "gpt-5.4-pro",
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GPT ${res.status}: ${(await res.text().catch(()=>"")).slice(0, 300)}`);
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "";
  } finally { clearTimeout(timeout); }
}

function readFileOr(p: string, fallback = ""): string {
  try { return readFileSync(p, "utf8"); } catch { return fallback; }
}

// ════════════════════════════════════════════════════════
// WORKER 1: Analyze VDO.Ninja codebase for support insights
// ════════════════════════════════════════════════════════
async function analyzeVDONinja(): Promise<void> {
  log("[VDO] Starting VDO.Ninja codebase analysis");
  const readme = readFileOr(path.join(ROOT, "repos", "vdo-ninja", "README.md")).slice(0, 30000);
  const issues = readFileOr(path.join(ROOT, "repos", "vdo-ninja", "CHANGES.md")).slice(0, 20000);

  // Get top VDO.Ninja KB problems
  const kbDb = new Database(path.join(ROOT, "data", "sqlite", "knowledge.sqlite"), { readonly: true });
  const topProblems = kbDb.prepare(
    "SELECT problem_statement, solution, keywords_json FROM mined_threads WHERE products_json LIKE '%VDO.Ninja%' AND resolved=1 AND LENGTH(solution)>30 ORDER BY RANDOM() LIMIT 50"
  ).all() as Array<{ problem_statement: string; solution: string; keywords_json: string }>;
  kbDb.close();

  const problemList = topProblems.map((p, i) => `${i+1}. PROBLEM: ${p.problem_statement}\n   SOLUTION: ${p.solution}\n   KEYWORDS: ${p.keywords_json}`).join("\n\n");

  const result = await gpt(
    "You are a senior developer who deeply understands VDO.Ninja (browser WebRTC tool by Steve Seguin). You have access to the README, changelog, and 50 real resolved support threads. Generate the most comprehensive, practical support reference possible.",
    `## VDO.Ninja README (excerpt):
${readme.slice(0, 15000)}

## Recent Changes:
${issues.slice(0, 10000)}

## 50 Real Resolved Support Threads:
${problemList}

Generate a COMPREHENSIVE support reference document with:

1. **URL Parameter Quick Reference** — Every parameter mentioned in the support threads, what it does, common values, and when to use it. Format as a table.
2. **Top 20 Problems and Solutions** — The most common issues people hit, ranked by frequency, with step-by-step solutions.
3. **Browser Compatibility Matrix** — What works where (Chrome, Firefox, Safari, Edge, iOS, Android, OBS).
4. **Connection Troubleshooting Flowchart** — If video won't connect, follow these steps in order.
5. **Audio Troubleshooting Guide** — Echo, no audio, wrong device, etc.
6. **OBS Integration Guide** — Browser source settings, &autoplay, transparent backgrounds, audio routing.
7. **Advanced Patterns** — Rooms, directors, IFrames API, Meshcast scaling, relay servers.

Be EXTREMELY specific. Include actual URL parameters, actual error messages, actual settings values. This document will be used by a support bot to answer questions — vague answers are useless.`,
    12000
  );

  writeFileSync(path.join(ROOT, "resources", "learnings", "vdo-ninja-comprehensive-reference.md"),
    "# VDO.Ninja Comprehensive Support Reference\n\nAuto-generated by GPT-5.4-pro from README + 50 resolved support threads.\n\n" + result);
  log("[VDO] Done — wrote vdo-ninja-comprehensive-reference.md");
}

// ════════════════════════════════════════════════════════
// WORKER 2: Analyze Social Stream Ninja for support insights
// ════════════════════════════════════════════════════════
async function analyzeSSN(): Promise<void> {
  log("[SSN] Starting Social Stream Ninja analysis");
  const readme = readFileOr(path.join(ROOT, "repos", "social_stream", "README.md")).slice(0, 30000);

  const kbDb = new Database(path.join(ROOT, "data", "sqlite", "knowledge.sqlite"), { readonly: true });
  const topProblems = kbDb.prepare(
    "SELECT problem_statement, solution, keywords_json, platforms_json FROM mined_threads WHERE products_json LIKE '%Social Stream%' AND resolved=1 AND LENGTH(solution)>30 ORDER BY RANDOM() LIMIT 50"
  ).all() as Array<{ problem_statement: string; solution: string; keywords_json: string; platforms_json: string }>;
  kbDb.close();

  const problemList = topProblems.map((p, i) => `${i+1}. PROBLEM: ${p.problem_statement}\n   SOLUTION: ${p.solution}\n   PLATFORMS: ${p.platforms_json}`).join("\n\n");

  const result = await gpt(
    "You are a senior developer who deeply understands Social Stream Ninja (chat aggregation extension/app by Steve Seguin). Generate the most comprehensive support reference possible.",
    `## Social Stream Ninja README (excerpt):
${readme.slice(0, 15000)}

## 50 Real Resolved Support Threads:
${problemList}

Generate a COMPREHENSIVE support reference:

1. **Platform Setup Guides** — Step-by-step for each platform (YouTube, Twitch, Kick, TikTok, Facebook, Discord, WhatsApp, Telegram). Include what works, what's broken, workarounds.
2. **Extension vs Desktop App** — When to use which, differences, limitations.
3. **Top 20 Problems and Solutions** — Ranked by frequency with specific fixes.
4. **Overlay/Dock Configuration** — URL parameters for customization, CSS tricks, featured chat setup.
5. **TikTok Specific Issues** — This is the most problematic platform. Every known issue and workaround.
6. **Auto-Responder & API** — How to set up automated responses, API endpoints, WebSocket integration.
7. **Troubleshooting Checklist** — Extension not loading, chat stops updating, permissions issues, etc.

Be EXTREMELY specific with parameters, CSS selectors, URLs. This feeds a support bot.`,
    12000
  );

  writeFileSync(path.join(ROOT, "resources", "learnings", "ssn-comprehensive-reference.md"),
    "# Social Stream Ninja Comprehensive Support Reference\n\nAuto-generated by GPT-5.4-pro from README + 50 resolved support threads.\n\n" + result);
  log("[SSN] Done — wrote ssn-comprehensive-reference.md");
}

// ════════════════════════════════════════════════════════
// WORKER 3: Analyze unresolved threads for patterns
// ════════════════════════════════════════════════════════
async function analyzeUnresolved(): Promise<void> {
  log("[UNRESOLVED] Analyzing unresolved thread patterns");
  const kbDb = new Database(path.join(ROOT, "data", "sqlite", "knowledge.sqlite"), { readonly: true });

  const unresolved = kbDb.prepare(
    "SELECT thread_name, problem_statement, keywords_json, products_json, category, error_signals_json FROM mined_threads WHERE resolved=0 AND LENGTH(problem_statement)>20 ORDER BY RANDOM() LIMIT 80"
  ).all() as Array<{ thread_name: string; problem_statement: string; keywords_json: string; products_json: string; category: string; error_signals_json: string }>;
  kbDb.close();

  const list = unresolved.map((u, i) => `${i+1}. [${u.category}] ${u.products_json} — ${u.problem_statement}\n   Errors: ${u.error_signals_json}\n   Keywords: ${u.keywords_json}`).join("\n\n");

  const result = await gpt(
    "You are a support analyst identifying patterns in UNRESOLVED support issues for Steve Seguin's streaming tools.",
    `Here are 80 UNRESOLVED support threads — problems that were never solved:

${list}

Analyze these and generate:

1. **Recurring Unsolved Problems** — What issues keep coming back without resolution? Group them by theme.
2. **Potential Solutions** — Based on your knowledge of WebRTC, browsers, and streaming tools, suggest solutions that MIGHT work for the top unsolved issues.
3. **Documentation Gaps** — What topics need better documentation to prevent these questions?
4. **Bug Patterns** — Any patterns that suggest actual software bugs vs user error?
5. **Priority Recommendations** — If Steve could fix 5 things to eliminate the most support threads, what should they be?

Be specific and actionable.`,
    8000
  );

  writeFileSync(path.join(ROOT, "resources", "learnings", "unresolved-analysis.md"),
    "# Unresolved Support Thread Analysis\n\nAuto-generated by GPT-5.4-pro from 80 unresolved threads.\n\n" + result);
  log("[UNRESOLVED] Done — wrote unresolved-analysis.md");
}

// ════════════════════════════════════════════════════════
// WORKER 4: Analyze the bot's own pipeline for improvements
// ════════════════════════════════════════════════════════
async function analyzePipeline(): Promise<void> {
  log("[PIPELINE] Analyzing bot pipeline for improvements");
  const mainDb = new Database(path.join(ROOT, "data", "sqlite", "stevesbot.sqlite"), { readonly: true });

  const outcomes = mainDb.prepare("SELECT outcome, COUNT(*) as c FROM workflow_runs GROUP BY outcome ORDER BY c DESC").all();
  const recentRejections = mainDb.prepare(
    "SELECT message_content, reply_text, json_extract(review_json,'$.policyFlags') as flags, json_extract(triage_json,'$.category') as cat FROM workflow_runs WHERE outcome='rejected' AND reply_text IS NOT NULL ORDER BY RANDOM() LIMIT 30"
  ).all() as Array<{ message_content: string; reply_text: string; flags: string; cat: string }>;

  const recentApprovals = mainDb.prepare(
    "SELECT message_content, reply_text, json_extract(triage_json,'$.category') as cat FROM workflow_runs WHERE outcome='approved' AND reply_text IS NOT NULL ORDER BY RANDOM() LIMIT 20"
  ).all() as Array<{ message_content: string; reply_text: string; cat: string }>;
  mainDb.close();

  const rejList = recentRejections.map((r, i) => `${i+1}. QUESTION: ${r.message_content?.slice(0, 200)}\n   DRAFT: ${r.reply_text?.slice(0, 300)}\n   REJECTED: ${r.flags}\n   CATEGORY: ${r.cat}`).join("\n\n");
  const appList = recentApprovals.map((a, i) => `${i+1}. QUESTION: ${a.message_content?.slice(0, 200)}\n   REPLY: ${a.reply_text?.slice(0, 300)}\n   CATEGORY: ${a.cat}`).join("\n\n");

  // Read the pipeline source for context
  const pipelineSource = readFileOr(path.join(ROOT, "src", "pipeline", "support-pipeline.ts")).slice(0, 15000);
  const triageInstructions = readFileOr(path.join(ROOT, "resources", "instructions", "vdo-ninja-support.md")).slice(0, 5000);

  const result = await gpt(
    "You are analyzing a Discord support bot's pipeline. The bot triages messages, drafts responses using GPT-5.4, then validates with a local Qwen model. You have access to real rejected and approved examples plus the pipeline source code.",
    `## Pipeline Outcomes (all time):
${JSON.stringify(outcomes)}

## 30 REJECTED Drafts (bot wrote these but they got rejected):
${rejList}

## 20 APPROVED Drafts (these were good enough to send):
${appList}

## Pipeline Source (excerpt):
${pipelineSource.slice(0, 8000)}

## Route Instructions (VDO.Ninja channel):
${triageInstructions}

Analyze and generate:

1. **Why Drafts Get Rejected** — Common patterns in rejections. What mistakes does the drafter keep making?
2. **What Makes Good Drafts** — Patterns in approved replies. What makes them succeed?
3. **Prompt Improvements** — Specific changes to the system prompt or instructions that would improve draft quality.
4. **Triage Improvements** — Questions that should be handled differently at the triage stage.
5. **Knowledge Gaps Causing Fabrication** — Topics where the bot fabricates because it lacks KB data.
6. **Concrete Action Items** — Top 10 specific things to change in the code, prompts, or KB.`,
    10000
  );

  writeFileSync(path.join(ROOT, "resources", "learnings", "pipeline-analysis.md"),
    "# Pipeline Quality Analysis\n\nAuto-generated by GPT-5.4-pro from real approved/rejected drafts + source code.\n\n" + result);
  log("[PIPELINE] Done — wrote pipeline-analysis.md");
}

// ════════════════════════════════════════════════════════
// WORKER 5: Analyze Raspberry Ninja codebase
// ════════════════════════════════════════════════════════
async function analyzeRaspberryNinja(): Promise<void> {
  log("[RPI] Starting Raspberry Ninja analysis");
  const readme = readFileOr(path.join(ROOT, "repos", "raspberry_ninja", "README.md")).slice(0, 20000);

  const kbDb = new Database(path.join(ROOT, "data", "sqlite", "knowledge.sqlite"), { readonly: true });
  const topProblems = kbDb.prepare(
    "SELECT problem_statement, solution, keywords_json FROM mined_threads WHERE products_json LIKE '%Raspberry%' AND LENGTH(solution)>20 ORDER BY RANDOM() LIMIT 30"
  ).all() as Array<{ problem_statement: string; solution: string; keywords_json: string }>;
  kbDb.close();

  const problemList = topProblems.map((p, i) => `${i+1}. ${p.problem_statement}\n   SOLUTION: ${p.solution}`).join("\n\n");

  const result = await gpt(
    "You are a hardware/embedded systems expert analyzing Raspberry Ninja (headless WebRTC camera tool for Raspberry Pi, Jetson, Intel NUC). Generate comprehensive troubleshooting reference.",
    `## Raspberry Ninja README:
${readme.slice(0, 12000)}

## 30 Real Support Threads:
${problemList}

Generate:

1. **Hardware Compatibility Matrix** — RPi 3/4/5, Jetson Nano/Orin, Intel NUC. What works, codecs supported, performance expectations.
2. **Installation Troubleshooting** — Common install failures and fixes.
3. **Camera/Input Guide** — CSI vs USB vs HDMI capture. GStreamer pipeline examples.
4. **Encoding Settings** — H264 vs VP8 vs H265. Hardware vs software. Bitrate recommendations.
5. **Network Issues** — TURN/STUN, firewall, NAT traversal for headless devices.
6. **publish.py Flag Reference** — Every commonly-used flag with examples.
7. **Auto-Start Service Setup** — systemd service file, boot configuration.

Be specific with actual command lines and GStreamer pipelines.`,
    10000
  );

  writeFileSync(path.join(ROOT, "resources", "learnings", "raspberry-ninja-comprehensive-reference.md"),
    "# Raspberry Ninja Comprehensive Reference\n\nAuto-generated by GPT-5.4-pro from README + 30 support threads.\n\n" + result);
  log("[RPI] Done — wrote raspberry-ninja-comprehensive-reference.md");
}

// ════════════════════════════════════════════════════════
// WORKER 6: Generate cross-product integration guide
// ════════════════════════════════════════════════════════
async function analyzeIntegrations(): Promise<void> {
  log("[INTEG] Analyzing cross-product integrations");
  const kbDb = new Database(path.join(ROOT, "data", "sqlite", "knowledge.sqlite"), { readonly: true });

  // Find threads mentioning multiple products
  const multiProduct = kbDb.prepare(
    "SELECT thread_name, problem_statement, solution, products_json, keywords_json FROM mined_threads WHERE products_json LIKE '%,%' AND LENGTH(solution)>20 ORDER BY RANDOM() LIMIT 40"
  ).all() as Array<{ thread_name: string; problem_statement: string; solution: string; products_json: string; keywords_json: string }>;
  kbDb.close();

  const list = multiProduct.map((m, i) => `${i+1}. [${m.products_json}] ${m.problem_statement}\n   SOLUTION: ${m.solution}`).join("\n\n");

  const result = await gpt(
    "You are documenting how Steve Seguin's streaming tools work together. Users often combine multiple tools.",
    `Here are 40 real support threads where users used MULTIPLE products together:

${list}

Generate a **Cross-Product Integration Guide**:

1. **VDO.Ninja + OBS** — How to set up browser sources, common pitfalls, audio routing.
2. **VDO.Ninja + Social Stream Ninja** — Chat overlays in VDO.Ninja scenes.
3. **Raspberry Ninja + VDO.Ninja** — Headless camera feeding into VDO.Ninja rooms.
4. **Electron Capture + VDO.Ninja** — Clean window capture for production.
5. **Social Stream Ninja + OBS** — Dock vs overlay, featured chat in scenes.
6. **Common Multi-Tool Workflows** — The typical production setups users build.
7. **Troubleshooting Cross-Product Issues** — When the problem is at the integration boundary.

Include specific URLs, parameters, and configuration steps.`,
    8000
  );

  writeFileSync(path.join(ROOT, "resources", "learnings", "cross-product-integration-guide.md"),
    "# Cross-Product Integration Guide\n\nAuto-generated by GPT-5.4-pro from 40 multi-product support threads.\n\n" + result);
  log("[INTEG] Done — wrote cross-product-integration-guide.md");
}

// ════════════════════════════════════════════════════════
// LAUNCH ALL WORKERS IN PARALLEL
// ════════════════════════════════════════════════════════
async function main(): Promise<void> {
  loadEnv();
  if (!process.env.OPENCODE_API_KEY) { log("FATAL: No OPENCODE_API_KEY"); process.exit(1); }

  log("=== LAUNCHING 6 PARALLEL ANALYSIS WORKERS ===");
  log("All using GPT-5.4-pro via OpenCode");

  const results = await Promise.allSettled([
    analyzeVDONinja(),
    analyzeSSN(),
    analyzeUnresolved(),
    analyzePipeline(),
    analyzeRaspberryNinja(),
    analyzeIntegrations(),
  ]);

  for (const [i, r] of results.entries()) {
    const names = ["VDO.Ninja", "SSN", "Unresolved", "Pipeline", "Raspberry", "Integrations"];
    if (r.status === "fulfilled") log(`${names[i]}: SUCCESS`);
    else log(`${names[i]}: FAILED — ${r.reason}`);
  }

  log("=== ALL WORKERS COMPLETE ===");
}

main().catch(err => { log(`FATAL: ${err}`); process.exit(1); });
