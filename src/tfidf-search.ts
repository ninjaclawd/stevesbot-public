import Database from "better-sqlite3";
import path from "node:path";

/**
 * In-memory TF-IDF search index.
 * Complements FTS5 (exact keyword match) with semantic similarity.
 * "webcam not working" will match "camera not detected" even though
 * they share no keywords, because both contain device-failure terms.
 *
 * Loads all KB threads into memory (~2-5MB for 1,300 docs).
 * Rebuild periodically or on KB changes.
 */

type DocVector = { id: string; name: string; category: string; tfidf: Map<string, number> };

let documents: DocVector[] = [];
let idfMap: Map<string, number> = new Map();
let ready = false;

// ── Tokenizer ──

const STOP_WORDS = new Set([
  "the","and","for","are","but","not","you","all","can","had","was","one","our",
  "out","has","have","been","some","them","than","its","over","such","that","with",
  "this","will","each","make","like","just","from","they","also","into","your",
  "does","there","where","when","what","how","now","way","get","see","even",
  "still","think","know","please","thank","thanks","show","find","anyone","help",
  "need","hello","hey","here","would","could","should","want","using","use",
  "used","going","trying","something","anything","nothing","else","other","much",
  "very","really","well","about","more","back","then","only","being","same",
  "again","right","okay","sure","yeah","yes","sorry","while","been","noticed",
  "maybe","actually","though","already","basically","probably","seems","thing",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

// ── TF-IDF computation ──

function computeTf(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  const max = Math.max(...freq.values(), 1);
  const tf = new Map<string, number>();
  for (const [term, count] of freq) tf.set(term, count / max);
  return tf;
}

function computeIdf(allDocs: Map<string, number>[]): Map<string, number> {
  const N = allDocs.length;
  const df = new Map<string, number>();
  for (const doc of allDocs) {
    for (const term of doc.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log((N + 1) / (count + 1)) + 1);
  }
  return idf;
}

function toTfidf(tf: Map<string, number>, idf: Map<string, number>): Map<string, number> {
  const tfidf = new Map<string, number>();
  for (const [term, tfVal] of tf) {
    const idfVal = idf.get(term) ?? 1;
    tfidf.set(term, tfVal * idfVal);
  }
  return tfidf;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, magA = 0, magB = 0;
  for (const [term, val] of a) {
    magA += val * val;
    const bVal = b.get(term);
    if (bVal !== undefined) dot += val * bVal;
  }
  for (const val of b.values()) magB += val * val;
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ── Public API ──

export function buildTfidfIndex(kbDbPath: string): void {
  const db = new Database(kbDbPath, { readonly: true });
  const rows = db.prepare(
    "SELECT thread_id, thread_name, summary, problem_statement, solution, keywords_json, category FROM mined_threads"
  ).all() as Array<{
    thread_id: string; thread_name: string; summary: string;
    problem_statement: string; solution: string; keywords_json: string; category: string;
  }>;
  db.close();

  // Build TF for each document
  const allTfs: Map<string, number>[] = [];
  const docs: Array<{ id: string; name: string; category: string; tf: Map<string, number> }> = [];

  for (const row of rows) {
    const text = [row.thread_name, row.summary, row.problem_statement, row.solution].join(" ");
    let keywords: string[] = [];
    try { keywords = JSON.parse(row.keywords_json ?? "[]"); } catch { /* ok */ }
    const tokens = [...tokenize(text), ...keywords.map(k => k.toLowerCase())];
    const tf = computeTf(tokens);
    allTfs.push(tf);
    docs.push({ id: row.thread_id, name: row.thread_name, category: row.category, tf });
  }

  // Compute IDF
  idfMap = computeIdf(allTfs);

  // Convert to TF-IDF vectors
  documents = docs.map(d => ({
    id: d.id,
    name: d.name,
    category: d.category,
    tfidf: toTfidf(d.tf, idfMap),
  }));

  ready = true;
  console.log("[TFIDF] Index built: " + documents.length + " documents, " + idfMap.size + " terms");
}

export function searchSimilar(query: string, limit = 5): Array<{ id: string; name: string; category: string; score: number }> {
  if (!ready || documents.length === 0) return [];

  const tokens = tokenize(query);
  const queryTf = computeTf(tokens);
  const queryVec = toTfidf(queryTf, idfMap);

  const scored = documents.map(doc => ({
    id: doc.id,
    name: doc.name,
    category: doc.category,
    score: cosineSimilarity(queryVec, doc.tfidf),
  }));

  return scored
    .filter(d => d.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function isTfidfReady(): boolean {
  return ready;
}

export function getTfidfStats(): { documents: number; terms: number } {
  return { documents: documents.length, terms: idfMap.size };
}
