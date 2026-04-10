import test from "node:test";
import assert from "node:assert/strict";
import { extractJsonArray } from "../scripts/enrich-kb-opencode.js";

test("extractJsonArray normalizes a plain JSON array", () => {
  const result = extractJsonArray('[{"topic":"relay","thread_ids":[1,2]}]');
  assert.equal(result, JSON.stringify([{ topic: "relay", thread_ids: [1, 2] }], null, 2));
});

test("extractJsonArray strips markdown fences", () => {
  const result = extractJsonArray("```json\n[{\"topic\":\"meshcast\",\"thread_ids\":[3,4]}]\n```");
  assert.equal(result, JSON.stringify([{ topic: "meshcast", thread_ids: [3, 4] }], null, 2));
});

test("extractJsonArray rejects blank content", () => {
  assert.throws(() => extractJsonArray(""), /No JSON array found/);
});
