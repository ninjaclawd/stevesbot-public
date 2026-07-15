#!/usr/bin/env tsx
/**
 * Enrich existing KB entries using GPT-5.4-pro.
 * - Reviews low-quality entries (short summaries, few keywords)
 * - Cross-links related entries
 * - Generates FAQ clusters
 * - Builds a "top issues" reference doc
 *
 * Uses OpenCode credits. Run alongside mine-with-opencode.ts.
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const ROOT = path.resolve(process.env.STEVESBOT_ROOT ?? ".");
const LOG = path.join(ROOT, "logs", "enrich-kb.log");

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

export function extractJsonArray(text: string): string {
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON array found in model response.");
  }
  const candidate = cleaned.slice(start, end + 1);
  const parsed = JSON.parse(candidate);
  if (!Array.isArray(parsed)) {
    throw new Error("Cluster response was not a JSON array.");
  }
  return JSON.stringify(parsed, null, 2);
}

async function callGPT(system: string, user: string, maxTokens = 4096): Promise<string> {
  const baseUrl = process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/v1";
  const apiKey = process.env.OPENCODE_API_KEY ?? "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.ENRICH_MODEL ?? "gpt-5.4-mini",
        temperature: 0.15,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GPT ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  loadEnv();
  if (!process.env.OPENCODE_API_KEY) { log("ERROR: No OPENCODE_API_KEY"); process.exit(1); }

  const kbDb = new Database(path.join(ROOT, "data", "sqlite", "knowledge.sqlite"));
  const mainDb = new Database(path.join(ROOT, "data", "sqlite", "stevesbot.sqlite"), { readonly: true });

  // ═══════════════════════════════════════════════════════
  // PHASE 1: Analyze KB state — find gaps and weak entries
  // ═══════════════════════════════════════════════════════
  log("=== PHASE 1: KB Analysis ===");

  const categoryStats = kbDb.prepare(
    "SELECT category, COUNT(*) as c, SUM(CASE WHEN resolved=1 THEN 1 ELSE 0 END) as resolved FROM mined_threads GROUP BY category ORDER BY c DESC"
  ).all() as Array<{ category: string; c: number; resolved: number }>;

  const weakEntries = kbDb.prepare(
    "SELECT id, thread_id, thread_name, summary, problem_statement, solution, keywords_json, category FROM mined_threads WHERE LENGTH(summary) < 80 OR LENGTH(COALESCE(solution,'')) < 20 OR LENGTH(COALESCE(keywords_json,'[]')) < 30 LIMIT 100"
  ).all() as Array<{ id: number; thread_id: string; thread_name: string; summary: string; problem_statement: string; solution: string; keywords_json: string; category: string }>;

  const productStats = kbDb.prepare(`
    SELECT products_json FROM mined_threads WHERE products_json IS NOT NULL
  `).all() as Array<{ products_json: string }>;

  // Count product mentions
  const productCounts: Record<string, number> = {};
  for (const row of productStats) {
    try {
      const products = JSON.parse(row.products_json);
      if (Array.isArray(products)) {
        for (const p of products) { productCounts[p] = (productCounts[p] ?? 0) + 1; }
      }
    } catch {}
  }

  log(`KB entries: ${categoryStats.reduce((s, r) => s + r.c, 0)}`);
  log(`Categories: ${categoryStats.map(r => `${r.category}(${r.c})`).join(", ")}`);
  log(`Products: ${Object.entries(productCounts).sort((a,b) => b[1]-a[1]).map(([k,v]) => `${k}(${v})`).join(", ")}`);
  log(`Weak entries needing enrichment: ${weakEntries.length}`);

  // ═══════════════════════════════════════════════════════
  // PHASE 2: Enrich weak entries with GPT-5.4-pro
  // ═══════════════════════════════════════════════════════
  log("=== PHASE 2: Enrich weak entries ===");

  const archiveDb = new Database(path.join(ROOT, "data", "sqlite", "archive.sqlite"), { readonly: true });

  const updateStmt = kbDb.prepare(`
    UPDATE mined_threads SET summary=?, problem_statement=?, solution=?, resolved=?,
    keywords_json=?, products_json=?, platforms_json=?, error_signals_json=?,
    searchable_text=?, indexed_at=datetime('now') WHERE id=?
  `);

  let enriched = 0;
  for (const entry of weakEntries) {
    // Fetch original messages
    const messages = archiveDb.prepare(
      "SELECT author_name, content, created_at FROM archived_messages WHERE thread_id = ? ORDER BY created_at ASC"
    ).all(entry.thread_id) as Array<{ author_name: string; content: string; created_at: string }>;

    if (messages.length < 2) continue;

    const conversation = messages.map(m => `[${m.created_at}] ${m.author_name}: ${m.content}`).join("\n");

    try {
      log(`  Enriching: ${entry.thread_name} (was: ${entry.summary.slice(0, 50)}...)`);

      const result = await callGPT(
        `You are a support knowledge engineer for the configured streaming tools. Extract the best possible structured knowledge from this support thread. The existing entry was low quality — make it much better.`,
        `Thread: ${entry.thread_name}
Existing weak summary: ${entry.summary}
Existing weak solution: ${entry.solution}

Full conversation:
${conversation.slice(0, 50000)}

Return JSON:
{"summary":"2-4 detailed sentences","problemStatement":"specific problem","solution":"specific actionable solution with steps/parameters","resolved":bool,"keywords":["15-25 specific searchable terms including URL params like &push, error messages, settings"],"products":["product names"],"platforms":["platforms/browsers/OS"],"errorSignals":["exact error messages quoted"]}`
      );

      const cleaned = result.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end === -1) { log(`  SKIP: no JSON`); continue; }

      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      const searchable = [entry.thread_name, parsed.summary, parsed.problemStatement, parsed.solution, ...(parsed.keywords || [])].join(" ");

      updateStmt.run(
        parsed.summary ?? entry.summary,
        parsed.problemStatement ?? entry.problem_statement,
        parsed.solution ?? entry.solution,
        parsed.resolved ? 1 : 0,
        JSON.stringify(parsed.keywords ?? []),
        JSON.stringify(parsed.products ?? []),
        JSON.stringify(parsed.platforms ?? []),
        JSON.stringify(parsed.errorSignals ?? []),
        searchable,
        entry.id
      );
      enriched++;
      log(`  OK: ${entry.thread_name}`);
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
      if (String(err).includes("429")) { await new Promise(r => setTimeout(r, 30000)); }
    }
  }
  log(`Enriched: ${enriched}/${weakEntries.length}`);

  // ═══════════════════════════════════════════════════════
  // PHASE 3: Generate FAQ clusters per category
  // ═══════════════════════════════════════════════════════
  log("=== PHASE 3: FAQ generation ===");

  const faqCategories = ["troubleshooting", "how-to", "configuration", "bug-report", "compatibility"];
  const faqOutput: string[] = ["# Auto-Generated FAQ\n\nGenerated by GPT-5.4-pro from mined support threads.\n"];

  for (const cat of faqCategories) {
    const entries = kbDb.prepare(
      "SELECT thread_name, summary, problem_statement, solution, keywords_json, products_json FROM mined_threads WHERE category=? AND resolved=1 AND LENGTH(COALESCE(solution,'')) > 20 ORDER BY RANDOM() LIMIT 30"
    ).all(cat) as Array<{ thread_name: string; summary: string; problem_statement: string; solution: string; keywords_json: string; products_json: string }>;

    if (entries.length < 5) continue;

    const entrySummaries = entries.map((e, i) =>
      `${i+1}. [${e.thread_name}] Problem: ${e.problem_statement} Solution: ${e.solution} Products: ${e.products_json}`
    ).join("\n");

    try {
      log(`  Generating FAQ for: ${cat} (${entries.length} resolved entries)`);
      const faq = await callGPT(
        "You are writing a support FAQ. Generate clear, practical Q&A pairs that will help both humans and support bots answer future questions. Group by product when possible.",
        `Generate a FAQ section for the "${cat}" category based on these ${entries.length} resolved support threads:

${entrySummaries}

Write 8-15 Q&A pairs. Format each as:
## Q: [Clear question someone would ask]
**A:** [Concise, actionable answer with specific steps, URL parameters, or settings when applicable]

Focus on the most common and useful patterns. Include specific technical details (URL parameters, settings, commands).`,
        6000
      );
      faqOutput.push(`\n---\n## ${cat.toUpperCase()}\n\n${faq}\n`);
      log(`  OK: ${cat} FAQ generated`);
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      log(`  ERROR: ${cat}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Write FAQ doc
  const faqPath = path.join(ROOT, "resources", "learnings", "support-qa", "auto-generated-faq.md");
  writeFileSync(faqPath, faqOutput.join("\n"));
  log(`FAQ written to ${faqPath}`);

  // ═══════════════════════════════════════════════════════
  // PHASE 4: Generate "Top Issues" reference for each product
  // ═══════════════════════════════════════════════════════
  log("=== PHASE 4: Product issue summaries ===");

  const products = ["VDO.Ninja", "Social Stream Ninja", "Raspberry Ninja"];
  for (const product of products) {
    const entries = kbDb.prepare(
      "SELECT thread_name, summary, problem_statement, solution, category FROM mined_threads WHERE products_json LIKE ? ORDER BY RANDOM() LIMIT 40"
    ).all(`%${product}%`) as Array<{ thread_name: string; summary: string; problem_statement: string; solution: string; category: string }>;

    if (entries.length < 5) continue;

    const entrySummaries = entries.map((e, i) =>
      `${i+1}. [${e.category}] ${e.problem_statement} → ${e.solution}`
    ).join("\n");

    try {
      log(`  Generating issue summary for: ${product} (${entries.length} entries)`);
      const summary = await callGPT(
        `You are a product analyst for ${product}. Analyze support patterns and generate a comprehensive reference document.`,
        `Based on ${entries.length} real support threads for ${product}, generate a reference document:

${entrySummaries}

Write a document with these sections:
1. **Most Common Issues** (top 5-8 problems users face, with quick solutions)
2. **Configuration Gotchas** (settings/parameters that trip people up)
3. **Platform-Specific Notes** (any browser/OS/platform specific issues)
4. **Quick Troubleshooting Checklist** (steps to try before asking for help)

Be specific — include URL parameters, settings names, error messages. This doc will be used by a support bot to answer questions.`,
        6000
      );

      const slug = product.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const docPath = path.join(ROOT, "resources", "learnings", `${slug}-top-issues.md`);
      writeFileSync(docPath, `# ${product} — Common Issues & Solutions\n\nAuto-generated from ${entries.length} support threads by GPT-5.4-pro.\n\n${summary}\n`);
      log(`  OK: Written to ${docPath}`);
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      log(`  ERROR: ${product}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // PHASE 5: Cross-reference — find related thread clusters
  // ═══════════════════════════════════════════════════════
  log("=== PHASE 5: Cross-reference clusters ===");

  // Get all unique keyword groups
  const allEntries = kbDb.prepare(
    "SELECT id, thread_name, keywords_json, category, products_json FROM mined_threads WHERE keywords_json IS NOT NULL"
  ).all() as Array<{ id: number; thread_name: string; keywords_json: string; category: string; products_json: string }>;

  // Sample 50 entries and find their nearest neighbors by keyword overlap
  const sample = allEntries.sort(() => Math.random() - 0.5).slice(0, 50);
  const clusterInput = sample.map(e => `[${e.id}] ${e.thread_name} | keywords: ${e.keywords_json} | category: ${e.category}`).join("\n");

  try {
    log(`  Clustering ${sample.length} entries...`);
    const clusters = await callGPT(
      "You are analyzing a support knowledge base. Find clusters of related threads that cover the same topic.",
      `Here are ${sample.length} KB entries. Group them into clusters of related threads (same underlying issue or topic).

${clusterInput}

Return JSON array of clusters:
[{"topic":"descriptive topic name","thread_ids":[1,2,3],"commonKeywords":["shared","keywords"],"suggestedMergedSummary":"what these threads collectively teach us"}]

Only include clusters with 2+ threads. Aim for 8-15 clusters.`,
      4000
    );

    const clusterPath = path.join(ROOT, "resources", "learnings", "kb-clusters.json");
    const normalizedClusters = extractJsonArray(clusters);
    writeFileSync(clusterPath, normalizedClusters + "\n");
    log(`  OK: Clusters written to ${clusterPath}`);
  } catch (err) {
    log(`  ERROR: clustering: ${err instanceof Error ? err.message : String(err)}`);
  }

  archiveDb.close();
  kbDb.close();
  mainDb.close();
  log("=== ALL PHASES COMPLETE ===");
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isEntrypoint) {
  main().catch(err => {
    log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
