import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProductButtons,
  buildPlatformButtons,
  buildSearchConfirmButtons,
  parseTriageButton,
  startFlow,
  getFlowState,
  clearFlow,
  markMaintainerPresent,
  handleTriageInteraction,
} from "../src/discord/interactive-triage.js";

// ─── parseTriageButton ───────────────────────────────────────────────────────

test("parseTriageButton parses product selection", () => {
  const result = parseTriageButton("triage_product:vdo-ninja:msg-123");
  assert.deepEqual(result, { kind: "product", product: "vdo-ninja", triggerMessageId: "msg-123" });
});

test("parseTriageButton parses platform selection", () => {
  const result = parseTriageButton("triage_platform:browser:msg-456");
  assert.deepEqual(result, { kind: "platform", platform: "browser", triggerMessageId: "msg-456" });
});

test("parseTriageButton parses search yes/no", () => {
  const yes = parseTriageButton("triage_search:yes:msg-789");
  assert.deepEqual(yes, { kind: "search", answer: "yes", triggerMessageId: "msg-789" });

  const no = parseTriageButton("triage_search:no:msg-789");
  assert.deepEqual(no, { kind: "search", answer: "no", triggerMessageId: "msg-789" });
});

test("parseTriageButton rejects invalid custom_ids", () => {
  assert.equal(parseTriageButton("draft_used:123"), undefined);
  assert.equal(parseTriageButton("triage_product"), undefined);
  assert.equal(parseTriageButton("triage_search:maybe:msg-1"), undefined);
  assert.equal(parseTriageButton(""), undefined);
  assert.equal(parseTriageButton("not_a_triage_button:a:b"), undefined);
});

// ─── Button builders ─────────────────────────────────────────────────────────

test("buildProductButtons creates 3 product buttons in one action row", () => {
  const rows = buildProductButtons("trigger-1") as Array<{ type: number; components: Array<{ custom_id: string; label: string }> }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].components.length, 3);
  assert.equal(rows[0].components[0].label, "VDO.Ninja");
  assert.equal(rows[0].components[1].label, "Social Stream");
  assert.equal(rows[0].components[2].label, "Other / Not Sure");
  assert.match(rows[0].components[0].custom_id, /triage_product:vdo-ninja:trigger-1/);
});

test("buildPlatformButtons returns VDO.Ninja-specific platforms (6 across 2 rows)", () => {
  const rows = buildPlatformButtons("trigger-1", "vdo-ninja") as Array<{ type: number; components: Array<{ label: string }> }>;
  assert.equal(rows.length, 2); // 6 buttons split across 2 action rows (max 5 per row)
  const allLabels = rows.flatMap((r) => r.components.map((c) => c.label));
  assert.ok(allLabels.includes("Browser"));
  assert.ok(allLabels.includes("Mobile App"));
  assert.ok(allLabels.includes("OBS Plugin"));
  assert.ok(allLabels.includes("Game Capture"));
  assert.ok(allLabels.includes("VST Plugin"));
  assert.ok(allLabels.includes("Other / Not Sure"));
});

test("buildPlatformButtons returns Social Stream-specific platforms (3 in 1 row)", () => {
  const rows = buildPlatformButtons("trigger-1", "social-stream") as Array<{ type: number; components: Array<{ label: string }> }>;
  assert.equal(rows.length, 1);
  const labels = rows[0].components.map((c) => c.label);
  assert.deepEqual(labels, ["Browser Extension", "Standalone App", "Other / Not Sure"]);
});

test("buildPlatformButtons returns default platforms for unknown product", () => {
  const rows = buildPlatformButtons("trigger-1", "other") as Array<{ type: number; components: Array<{ label: string }> }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].components.length, 4);
});

test("buildSearchConfirmButtons creates yes/no buttons", () => {
  const rows = buildSearchConfirmButtons("trigger-1") as Array<{ type: number; components: Array<{ custom_id: string; style: number }> }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].components.length, 2);
  assert.match(rows[0].components[0].custom_id, /triage_search:yes:trigger-1/);
  assert.match(rows[0].components[1].custom_id, /triage_search:no:trigger-1/);
  assert.equal(rows[0].components[0].style, 3); // SUCCESS (green)
  assert.equal(rows[0].components[1].style, 2); // SECONDARY (grey)
});

// ─── Flow state management ───────────────────────────────────────────────────

test("startFlow creates state and getFlowState retrieves it", () => {
  const state = startFlow("ch-test-1", "trigger-1", "user-1");
  assert.equal(state.step, "product");
  assert.equal(state.product, undefined);
  assert.equal(state.maintainerPresent, false);

  const retrieved = getFlowState("ch-test-1");
  assert.equal(retrieved?.channelId, "ch-test-1");
  assert.equal(retrieved?.triggerMessageId, "trigger-1");
  assert.equal(retrieved?.userId, "user-1");
  clearFlow("ch-test-1");
});

test("startFlow with preselectedProduct skips to platform step", () => {
  const state = startFlow("ch-test-2", "trigger-2", "user-2", "vdo-ninja");
  assert.equal(state.step, "platform");
  assert.equal(state.product, "vdo-ninja");
  clearFlow("ch-test-2");
});

test("clearFlow removes state", () => {
  startFlow("ch-test-3", "trigger-3", "user-3");
  assert.ok(getFlowState("ch-test-3") !== undefined);
  clearFlow("ch-test-3");
  assert.equal(getFlowState("ch-test-3"), undefined);
});

test("markMaintainerPresent sets flag on active flow", () => {
  startFlow("ch-test-4", "trigger-4", "user-4");
  markMaintainerPresent("ch-test-4");
  const state = getFlowState("ch-test-4");
  assert.equal(state?.maintainerPresent, true);
  clearFlow("ch-test-4");
});

test("markMaintainerPresent is a no-op for non-existent flows", () => {
  markMaintainerPresent("ch-nonexistent");
  assert.equal(getFlowState("ch-nonexistent"), undefined);
});

// ─── handleTriageInteraction ─────────────────────────────────────────────────

function makeMockInteraction(userId: string, channelId: string, customId: string): {
  interaction: Record<string, unknown>;
  updates: Array<Record<string, unknown>>;
  replies: Array<Record<string, unknown>>;
} {
  const updates: Array<Record<string, unknown>> = [];
  const replies: Array<Record<string, unknown>> = [];
  const interaction = {
    user: { id: userId },
    channelId,
    customId,
    update: async (data: Record<string, unknown>) => { updates.push(data); },
    reply: async (data: Record<string, unknown>) => { replies.push(data); },
  };
  return { interaction, updates, replies };
}

test("handleTriageInteraction walks through full product→platform→search flow", async () => {
  startFlow("ch-flow-1", "trigger-flow", "user-flow");

  const callbacks: Array<{ state: unknown; searchRequested: boolean }> = [];

  // Step 1: select product
  const step1 = makeMockInteraction("user-flow", "ch-flow-1", "triage_product:vdo-ninja:trigger-flow");
  await handleTriageInteraction(
    step1.interaction as never,
    { kind: "product", product: "vdo-ninja", triggerMessageId: "trigger-flow" },
  );
  assert.equal(step1.updates.length, 1);
  assert.match(step1.updates[0].content as string, /VDO\.Ninja.*What platform/);
  assert.equal(getFlowState("ch-flow-1")?.step, "platform");

  // Step 2: select platform
  const step2 = makeMockInteraction("user-flow", "ch-flow-1", "triage_platform:browser:trigger-flow");
  await handleTriageInteraction(
    step2.interaction as never,
    { kind: "platform", platform: "browser", triggerMessageId: "trigger-flow" },
  );
  assert.equal(step2.updates.length, 1);
  assert.match(step2.updates[0].content as string, /Searching for an answer about \*\*VDO\.Ninja\*\* \(Browser\)/);
  assert.equal(callbacks.length, 0);
  assert.equal(getFlowState("ch-flow-1"), undefined); // flow clears after platform selection now
});

test("handleTriageInteraction platform selection immediately triggers search callbacks", async () => {
  startFlow("ch-flow-2", "trigger-flow-2", "user-flow-2");

  const callbacks: Array<{ state: unknown; searchRequested: boolean }> = [];

  const step1 = makeMockInteraction("user-flow-2", "ch-flow-2", "triage_product:vdo-ninja:trigger-flow-2");
  await handleTriageInteraction(
    step1.interaction as never,
    { kind: "product", product: "vdo-ninja", triggerMessageId: "trigger-flow-2" },
  );

  const step2 = makeMockInteraction("user-flow-2", "ch-flow-2", "triage_platform:browser:trigger-flow-2");
  await handleTriageInteraction(
    step2.interaction as never,
    { kind: "platform", platform: "browser", triggerMessageId: "trigger-flow-2" },
    (state) => { callbacks.push({ state, searchRequested: true }); },
    (state, sr) => { callbacks.push({ state, searchRequested: sr }); },
  );

  assert.equal(step2.updates.length, 1);
  assert.match(step2.updates[0].content as string, /Searching for an answer/);
  assert.equal(callbacks.length, 2); // onTriageComplete + onSearchRequested
  assert.equal(callbacks[0].searchRequested, true);
  assert.equal(getFlowState("ch-flow-2"), undefined);
});

test("handleTriageInteraction handles 'no' search gracefully", async () => {
  startFlow("ch-flow-2", "trigger-no", "user-no");

  // Fast-forward to confirm step
  const state = getFlowState("ch-flow-2")!;
  state.step = "confirm";
  state.product = "social-stream";
  state.platform = "desktop";

  const callbacks: Array<{ searchRequested: boolean }> = [];
  const mock = makeMockInteraction("user-no", "ch-flow-2", "triage_search:no:trigger-no");
  await handleTriageInteraction(
    mock.interaction as never,
    { kind: "search", answer: "no", triggerMessageId: "trigger-no" },
    undefined,
    (_state, sr) => { callbacks.push({ searchRequested: sr }); },
  );

  assert.match(mock.updates[0].content as string, /maintainer will take a look/);
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].searchRequested, false);
  assert.equal(getFlowState("ch-flow-2"), undefined);
});

test("handleTriageInteraction blocks non-owner interaction", async () => {
  startFlow("ch-flow-3", "trigger-owner", "user-owner");

  const mock = makeMockInteraction("user-intruder", "ch-flow-3", "triage_product:vdo-ninja:trigger-owner");
  await handleTriageInteraction(
    mock.interaction as never,
    { kind: "product", product: "vdo-ninja", triggerMessageId: "trigger-owner" },
  );

  assert.equal(mock.updates.length, 0); // no update
  assert.equal(mock.replies.length, 1); // ephemeral reply
  assert.match(mock.replies[0].content as string, /Only the person who asked/);
  clearFlow("ch-flow-3");
});

test("handleTriageInteraction silences when maintainer is present", async () => {
  startFlow("ch-flow-4", "trigger-maint", "user-maint");
  markMaintainerPresent("ch-flow-4");

  const mock = makeMockInteraction("user-maint", "ch-flow-4", "triage_product:vdo-ninja:trigger-maint");
  await handleTriageInteraction(
    mock.interaction as never,
    { kind: "product", product: "vdo-ninja", triggerMessageId: "trigger-maint" },
  );

  assert.equal(mock.updates.length, 1);
  assert.match(mock.updates[0].content as string, /team member is already helping/);
  assert.equal(getFlowState("ch-flow-4"), undefined); // flow cleared
});

test("handleTriageInteraction rejects stale trigger from a different flow", async () => {
  startFlow("ch-flow-5", "trigger-new", "user-stale");

  const mock = makeMockInteraction("user-stale", "ch-flow-5", "triage_product:vdo-ninja:trigger-old");
  await handleTriageInteraction(
    mock.interaction as never,
    { kind: "product", product: "vdo-ninja", triggerMessageId: "trigger-old" },
  );

  assert.equal(mock.updates.length, 1);
  assert.match(mock.updates[0].content as string, /no longer active/);
  clearFlow("ch-flow-5");
});
