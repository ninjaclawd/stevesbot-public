/**
 * Interactive triage: multi-step button flow for support threads.
 *
 * Flow:
 *   1. User posts in support → bot sends product buttons (VDO.Ninja | Social Stream | Other)
 *   2. User clicks product → bot sends platform buttons (product-specific)
 *   3. User clicks platform → bot asks "Want the bot to search for an answer?"
 *   4. User clicks Yes → enqueue into workflow with product/platform context
 *   5. User clicks No  → bot says "Got it, a maintainer will take a look when available."
 *
 * If a maintainer posts in the thread before the user completes
 * the flow, the bot goes silent (tracked via maintainer detection).
 */

import { MessageFlags, type ButtonInteraction } from "discord.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TriageFlowStep = "product" | "platform" | "confirm" | "done";

export interface TriageFlowState {
  /** The original message ID that triggered the flow */
  triggerMessageId: string;
  /** Channel/thread the flow is happening in */
  channelId: string;
  /** User who is going through the flow */
  userId: string;
  /** Current step */
  step: TriageFlowStep;
  /** Selected product (after step 1) */
  product?: string;
  /** Selected platform (after step 2) */
  platform?: string;
  /** Whether user wants bot to search */
  wantsSearch?: boolean;
  /** The bot's triage prompt message ID (for editing/removing when done) */
  triageMessageId?: string;
  /** Timestamp the flow started */
  startedAt: number;
  /** Whether a maintainer has entered the thread (silences the bot) */
  maintainerPresent: boolean;
}

// In-memory state — keyed by channelId (or threadId)
const flowStates = new Map<string, TriageFlowState>();

// ─── Constants ───────────────────────────────────────────────────────────────

const PRODUCT_OPTIONS = [
  { id: "vdo-ninja", label: "VDO.Ninja", emoji: "\ud83c\udfa5" },
  { id: "social-stream", label: "Social Stream", emoji: "\ud83d\udcac" },
  { id: "other", label: "Other / Not Sure", emoji: "\u2753" },
] as const;

const VDO_NINJA_PLATFORMS = [
  { id: "browser", label: "Browser", emoji: "\ud83c\udf10" },
  { id: "mobile", label: "Mobile App", emoji: "\ud83d\udcf1" },
  { id: "obs-plugin", label: "OBS Plugin", emoji: "\ud83c\udfa5" },
  { id: "game-capture", label: "Game Capture", emoji: "\ud83c\udfae" },
  { id: "vst-plugin", label: "VST Plugin", emoji: "\ud83c\udfb5" },
  { id: "other", label: "Other / Not Sure", emoji: "\u2753" },
] as const;

const SOCIAL_STREAM_PLATFORMS = [
  { id: "browser", label: "Browser Extension", emoji: "\ud83c\udf10" },
  { id: "desktop", label: "Standalone App", emoji: "\ud83d\udda5\ufe0f" },
  { id: "other", label: "Other / Not Sure", emoji: "\u2753" },
] as const;

const DEFAULT_PLATFORMS = [
  { id: "browser", label: "Browser", emoji: "\ud83c\udf10" },
  { id: "desktop", label: "Desktop App", emoji: "\ud83d\udda5\ufe0f" },
  { id: "mobile", label: "Mobile", emoji: "\ud83d\udcf1" },
  { id: "other", label: "Other / Not Sure", emoji: "\u2753" },
] as const;

function getPlatformOptions(product: string): ReadonlyArray<{ readonly id: string; readonly label: string; readonly emoji: string }> {
  switch (product) {
    case "vdo-ninja": return VDO_NINJA_PLATFORMS;
    case "social-stream": return SOCIAL_STREAM_PLATFORMS;
    default: return DEFAULT_PLATFORMS;
  }
}

const FLOW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ─── Button builders ─────────────────────────────────────────────────────────

export function buildProductButtons(triggerMessageId: string): unknown[] {
  return [
    {
      type: 1, // ACTION_ROW
      components: PRODUCT_OPTIONS.map((opt) => ({
        type: 2, // BUTTON
        style: 1, // PRIMARY (blue)
        label: opt.label,
        custom_id: `triage_product:${opt.id}:${triggerMessageId}`,
        emoji: { name: opt.emoji },
      })),
    },
  ];
}

export function buildPlatformButtons(triggerMessageId: string, product?: string): unknown[] {
  const options = getPlatformOptions(product ?? "");
  const buttons = options.map((opt) => ({
    type: 2,
    style: 1,
    label: opt.label,
    custom_id: `triage_platform:${opt.id}:${triggerMessageId}`,
    emoji: { name: opt.emoji },
  }));
  // Discord limits action rows to 5 buttons each — split if needed
  const rows: unknown[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  }
  return rows;
}

export function buildSearchConfirmButtons(triggerMessageId: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3, // SUCCESS (green)
          label: "Yes, search for an answer",
          custom_id: `triage_search:yes:${triggerMessageId}`,
          emoji: { name: "\ud83d\udd0d" },
        },
        {
          type: 2,
          style: 2, // SECONDARY (grey)
          label: "No thanks, I'll wait",
          custom_id: `triage_search:no:${triggerMessageId}`,
          emoji: { name: "\u23f3" },
        },
      ],
    },
  ];
}

function buildDisabledButton(label: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label,
          custom_id: "triage_done",
          disabled: true,
        },
      ],
    },
  ];
}

// ─── State management ────────────────────────────────────────────────────────

export function getFlowState(channelId: string): TriageFlowState | undefined {
  const state = flowStates.get(channelId);
  if (state && Date.now() - state.startedAt > FLOW_TIMEOUT_MS) {
    flowStates.delete(channelId);
    return undefined;
  }
  return state;
}

export function startFlow(channelId: string, triggerMessageId: string, userId: string, preselectedProduct?: string): TriageFlowState {
  const state: TriageFlowState = {
    triggerMessageId,
    channelId,
    userId,
    step: preselectedProduct ? "platform" : "product",
    product: preselectedProduct,
    startedAt: Date.now(),
    maintainerPresent: false,
  };
  flowStates.set(channelId, state);
  return state;
}

export function clearFlow(channelId: string): void {
  flowStates.delete(channelId);
}

export function markMaintainerPresent(channelId: string): void {
  const state = flowStates.get(channelId);
  if (state) {
    state.maintainerPresent = true;
  }
}

export function getActiveFlowCount(): number {
  const now = Date.now();
  for (const [key, state] of flowStates) {
    if (now - state.startedAt > FLOW_TIMEOUT_MS) {
      flowStates.delete(key);
    }
  }
  return flowStates.size;
}

// ─── Interaction parsing ─────────────────────────────────────────────────────

export type TriageButtonAction =
  | { kind: "product"; product: string; triggerMessageId: string }
  | { kind: "platform"; platform: string; triggerMessageId: string }
  | { kind: "search"; answer: "yes" | "no"; triggerMessageId: string };

export function parseTriageButton(customId: string): TriageButtonAction | undefined {
  const parts = customId.split(":");
  if (parts.length !== 3 || !parts[0]?.startsWith("triage_")) {
    return undefined;
  }

  const [prefix, value, triggerMessageId] = parts;
  if (!triggerMessageId) return undefined;

  switch (prefix) {
    case "triage_product":
      return { kind: "product", product: value!, triggerMessageId };
    case "triage_platform":
      return { kind: "platform", platform: value!, triggerMessageId };
    case "triage_search":
      if (value === "yes" || value === "no") {
        return { kind: "search", answer: value, triggerMessageId };
      }
      return undefined;
    default:
      return undefined;
  }
}

// ─── Interaction handler ─────────────────────────────────────────────────────

export async function handleTriageInteraction(
  interaction: ButtonInteraction,
  action: TriageButtonAction,
  onSearchRequested?: (state: TriageFlowState) => void,
  onTriageComplete?: (state: TriageFlowState, searchRequested: boolean) => void,
): Promise<void> {
  const channelId = interaction.channelId;
  const state = getFlowState(channelId);

  // If no active flow or flow expired, dismiss
  if (!state) {
    await interaction.update({
      content: "This triage flow has expired. Please send a new message to start again.",
      components: [],
    });
    return;
  }

  // Verify the button belongs to the active flow (prevents cross-flow confusion)
  if (action.triggerMessageId !== state.triggerMessageId) {
    await interaction.update({
      content: "This triage flow is no longer active. A newer one may have replaced it.",
      components: [],
    });
    return;
  }

  // If maintainer entered, silently end the flow
  if (state.maintainerPresent) {
    await interaction.update({
      content: "A team member is already helping in this thread. The bot will stand by.",
      components: [],
    });
    clearFlow(channelId);
    return;
  }

  // Only the original user can interact
  if (interaction.user.id !== state.userId) {
    try {
      await interaction.reply({
        content: "Only the person who asked the question can use these buttons.",
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  switch (action.kind) {
    case "product": {
      state.product = action.product;
      state.step = "platform";
      const productLabel = PRODUCT_OPTIONS.find((o) => o.id === action.product)?.label ?? action.product;
      await interaction.update({
        content: `Got it \u2014 **${productLabel}**. What platform are you using?`,
        components: buildPlatformButtons(state.triggerMessageId, state.product) as never[],
      });
      break;
    }

    case "platform": {
      state.platform = action.platform;
      state.wantsSearch = true;
      state.step = "done";
      state.triageMessageId = interaction.message?.id;
      const platformOptions = getPlatformOptions(state.product ?? "");
      const platformLabel = platformOptions.find((o) => o.id === action.platform)?.label ?? action.platform;
      const productLabel = PRODUCT_OPTIONS.find((o) => o.id === state.product)?.label ?? state.product;
      await interaction.update({
        content: `Searching for an answer about **${productLabel}** (${platformLabel})...`,
        components: [],
      });
      onTriageComplete?.(state, true);
      onSearchRequested?.(state);
      clearFlow(channelId);
      break;
    }

    case "search": {
      state.wantsSearch = action.answer === "yes";
      state.step = "done";

      if (action.answer === "yes") {
        const productLabel = PRODUCT_OPTIONS.find((o) => o.id === state.product)?.label ?? state.product;
        const platformOptions = getPlatformOptions(state.product ?? "");
        const platformLabel = platformOptions.find((o) => o.id === state.platform)?.label ?? state.platform;
        await interaction.update({
          content: `Searching for an answer about **${productLabel}** (${platformLabel})... This may take a moment.`,
          components: buildDisabledButton("Searching...") as never[],
        });
        onTriageComplete?.(state, true);
        // Notify the caller to trigger the pipeline
        onSearchRequested?.(state);
      } else {
        await interaction.update({
          content: "No problem! A maintainer will take a look when available. Hang tight!",
          components: buildDisabledButton("Waiting for maintainer") as never[],
        });
        onTriageComplete?.(state, false);
      }

      clearFlow(channelId);
      break;
    }
  }
}

// ─── REST helper to send initial prompt ──────────────────────────────────────

export async function sendTriagePrompt(
  token: string,
  channelId: string,
  triggerMessageId: string,
  userId: string,
  preselectedProduct?: string,
): Promise<{ messageId?: string; error?: string }> {
  startFlow(channelId, triggerMessageId, userId, preselectedProduct);

  const productLabel = PRODUCT_OPTIONS.find((o) => o.id === preselectedProduct)?.label;
  const body = preselectedProduct
    ? {
        content: `Hi! I'm a support bot. I see you're asking about **${productLabel ?? preselectedProduct}**. What platform are you using?`,
        components: buildPlatformButtons(triggerMessageId, preselectedProduct),
      }
    : {
        content: "Hi! I'm a support bot. To help find the right answer, which product is this about?",
        components: buildProductButtons(triggerMessageId),
      };

  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await response.text();
    if (!response.ok) {
      clearFlow(channelId);
      return { error: `Discord API ${response.status}: ${data}` };
    }

    const parsed = JSON.parse(data) as { id?: string };
    return { messageId: parsed.id };
  } catch (error) {
    clearFlow(channelId);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
