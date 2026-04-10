import test from "node:test";
import assert from "node:assert/strict";
import {
  renderAgentActionFormat,
  validateAgentAction,
  runIterativeAgentLoop,
} from "../src/models/agent-loop.js";
import type { AgentAction, IterativeModelClient } from "../src/models/agent-loop.js";
import type { ModelInvocationTrace, QueryTraceEntry } from "../src/types.js";

const CATALOG = ["searchRepo", "openRepoFile", "searchSupport"];

test("validateAgentAction accepts a valid tool action", () => {
  const action = validateAgentAction(
    { kind: "tool", tool: "searchRepo", args: { query: "hello" }, reason: "searching" },
    CATALOG,
  );
  assert.equal(action.kind, "tool");
  if (action.kind === "tool") {
    assert.equal(action.tool, "searchRepo");
    assert.deepEqual(action.args, { query: "hello" });
    assert.equal(action.reason, "searching");
  }
});

test("validateAgentAction accepts a valid final action", () => {
  const action = validateAgentAction(
    { kind: "final", draft: "Here is my answer", supportRecordIds: [1, 2], repoRefs: ["vdo-ninja:src/main.js"] },
    CATALOG,
  );
  assert.equal(action.kind, "final");
  if (action.kind === "final") {
    assert.equal(action.draft, "Here is my answer");
    assert.deepEqual(action.supportRecordIds, [1, 2]);
    assert.deepEqual(action.repoRefs, ["vdo-ninja:src/main.js"]);
  }
});

test("validateAgentAction rejects unknown tools", () => {
  assert.throws(
    () => validateAgentAction({ kind: "tool", tool: "deleteEverything", args: {} }, CATALOG),
    /not in the allowed tool catalog/,
  );
});

test("validateAgentAction rejects empty drafts", () => {
  assert.throws(
    () => validateAgentAction({ kind: "final", draft: "" }, CATALOG),
    /non-empty "draft"/,
  );
});

test("validateAgentAction rejects missing args", () => {
  assert.throws(
    () => validateAgentAction({ kind: "tool", tool: "searchRepo" }, CATALOG),
    /"args" object/,
  );
});

test("validateAgentAction rejects invalid kind", () => {
  assert.throws(
    () => validateAgentAction({ kind: "hack" }, CATALOG),
    /must be either "tool" or "final"/,
  );
});

test("validateAgentAction handles string supportRecordIds", () => {
  const action = validateAgentAction(
    { kind: "final", draft: "answer", supportRecordIds: ["1", "2"] },
    CATALOG,
  );
  if (action.kind === "final") {
    assert.deepEqual(action.supportRecordIds, [1, 2]);
  }
});

test("renderAgentActionFormat includes all tools", () => {
  const format = renderAgentActionFormat(CATALOG);
  assert.match(format, /searchRepo/);
  assert.match(format, /openRepoFile/);
  assert.match(format, /searchSupport/);
  assert.match(format, /kind.*tool/);
  assert.match(format, /kind.*final/);
});

test("runIterativeAgentLoop returns draft after tool calls", async () => {
  const actions: AgentAction[] = [
    { kind: "tool", tool: "searchRepo", args: { query: "test" }, reason: "finding code" },
    { kind: "final", draft: "Found the answer in the code.", supportRecordIds: [], repoRefs: ["vdo-ninja:src/test.js"] },
  ];
  let actionIndex = 0;

  const client: IterativeModelClient = {
    async nextAction() {
      return actions[actionIndex++];
    },
  };

  const toolInvocations: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const trace: QueryTraceEntry[] = [];

  const result = await runIterativeAgentLoop({
    client,
    systemPrompt: "You are a test agent.",
    conversation: "User: help",
    toolCatalog: CATALOG,
    trace,
    invokeTool: async (tool, args) => {
      toolInvocations.push({ tool, args });
      return "Found: test.js contains the answer.";
    },
  });

  assert.equal(result.body, "Found the answer in the code.");
  assert.deepEqual(result.repoRefs, ["vdo-ninja:src/test.js"]);
  assert.equal(toolInvocations.length, 1);
  assert.equal(toolInvocations[0].tool, "searchRepo");
});

test("runIterativeAgentLoop returns immediately on first-turn final", async () => {
  const client: IterativeModelClient = {
    async nextAction() {
      return { kind: "final", draft: "I know the answer already.", supportRecordIds: [5], repoRefs: [] };
    },
  };

  const result = await runIterativeAgentLoop({
    client,
    systemPrompt: "test",
    conversation: "test",
    toolCatalog: CATALOG,
    trace: [],
    invokeTool: async () => { throw new Error("should not be called"); },
  });

  assert.equal(result.body, "I know the answer already.");
  assert.deepEqual(result.citedSupportRecordIds, [5]);
});

test("runIterativeAgentLoop throws after maxSteps exhausted", async () => {
  let callCount = 0;
  const client: IterativeModelClient = {
    async nextAction() {
      callCount++;
      return { kind: "tool", tool: "searchRepo", args: { query: "loop" } };
    },
  };

  await assert.rejects(
    () => runIterativeAgentLoop({
      client,
      systemPrompt: "test",
      conversation: "test",
      toolCatalog: CATALOG,
      trace: [],
      invokeTool: async () => "no results",
      maxSteps: 3,
    }),
    /exhausted without a final reply/,
  );
  assert.equal(callCount, 3);
});

test("runIterativeAgentLoop appends tool results to conversation", async () => {
  const conversations: string[] = [];
  let callIdx = 0;
  const actions: AgentAction[] = [
    { kind: "tool", tool: "searchRepo", args: { query: "first" } },
    { kind: "tool", tool: "openRepoFile", args: { filePath: "src/main.js" } },
    { kind: "final", draft: "Done." },
  ];

  const client: IterativeModelClient = {
    async nextAction(input) {
      conversations.push(input.conversation);
      return actions[callIdx++];
    },
  };

  await runIterativeAgentLoop({
    client,
    systemPrompt: "test",
    conversation: "initial context",
    toolCatalog: CATALOG,
    trace: [],
    invokeTool: async (tool) => tool + " result data",
  });

  // First call gets initial context
  assert.equal(conversations[0], "initial context");
  // Second call has first tool result appended
  assert.match(conversations[1], /searchRepo.*result data/);
  // Third call has both tool results
  assert.match(conversations[2], /searchRepo.*result data/);
  assert.match(conversations[2], /openRepoFile.*result data/);
});
