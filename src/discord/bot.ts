import { Client, GatewayIntentBits, MessageFlags, Partials, type AnyThreadChannel, type Attachment, type Interaction, type Message } from "discord.js";
import type { AppConfig } from "../config.js";
import { parseTriageButton, handleTriageInteraction, getFlowState, markMaintainerPresent, sendTriagePrompt, type TriageFlowState } from "./interactive-triage.js";
import type { DiscordAttachmentRecord, DiscordEventRecord, DraftUsage, RouteConfig } from "../types.js";
import { handleCommandMessage, type CommandHandlerDeps } from "./command-handler.js";

export interface WorkflowEventSink {
  enqueue(route: RouteConfig, event: DiscordEventRecord): Promise<void>;
}

export interface DraftUsageSink {
  recordUsage(
    runId: number,
    reviewMessageId: string,
    usage: DraftUsage,
    reactedBy: string,
  ): void | {
    sentToSource?: boolean;
    sourceChannelId?: string;
    sourceMessageId?: string;
  } | Promise<void | {
    sentToSource?: boolean;
    sourceChannelId?: string;
    sourceMessageId?: string;
  }>;
}

function parseMaintainerSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function routeMatchesMessage(
  route: RouteConfig,
  messageTarget: {
    guildId: string | null;
    channelId: string;
    isThread: boolean;
    parentChannelId?: string | null;
  },
): boolean {
  if (!route.enabled || route.guildId !== messageTarget.guildId) {
    return false;
  }

  if (route.mode === "thread") {
    return messageTarget.isThread && route.channelId === messageTarget.parentChannelId;
  }

  return !messageTarget.isThread && route.channelId === messageTarget.channelId;
}

export function buildSourceUrlFromEvent(event: DiscordEventRecord): string {
  return `https://discord.com/channels/${event.guildId}/${event.threadId ?? event.channelId}/${event.messageId}`;
}

function buildSourceUrl(message: Message): string {
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

function toAttachmentRecord(message: Message, attachment: Attachment): DiscordAttachmentRecord {
  const contentType = attachment.contentType ?? undefined;
  const isImage = Boolean((contentType && contentType.startsWith("image/")) || attachment.width || attachment.height);
  return {
    id: attachment.id,
    fileName: attachment.name ?? `attachment-${attachment.id}`,
    url: attachment.url,
    proxyUrl: attachment.proxyURL,
    contentType,
    sizeBytes: attachment.size,
    width: attachment.width ?? undefined,
    height: attachment.height ?? undefined,
    kind: isImage ? "image" : "other",
  };
}

function toEvent(message: Message): DiscordEventRecord {
  const attachments = message.attachments.map((attachment) => toAttachmentRecord(message, attachment));
  return {
    guildId: message.guildId ?? "dm",
    channelId: message.channelId,
    threadId: message.channel.isThread() ? message.channel.id : undefined,
    messageId: message.id,
    authorId: message.author.id,
    authorName: message.author.username,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    sourceUrl: buildSourceUrl(message),
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

function formatEventAttachments(event: DiscordEventRecord): string | undefined {
  if (!event.attachments || event.attachments.length === 0) {
    return undefined;
  }

  return event.attachments
    .map((attachment) => {
      const dimensions = attachment.width && attachment.height ? ` ${attachment.width}x${attachment.height}` : "";
      const summary = attachment.extractedSummary ? ` summary: ${attachment.extractedSummary}` : "";
      const text = attachment.extractedText ? ` text: ${attachment.extractedText}` : "";
      return `- ${attachment.fileName} [${attachment.kind}${attachment.contentType ? ` ${attachment.contentType}` : ""}${dimensions}]${summary}${text}`;
    })
    .join("\n");
}

export function buildReviewMessage(route: RouteConfig, event: DiscordEventRecord, reply: string, draftType?: "standard" | "clarify" | "no_answer"): string {
  const attachmentText = formatEventAttachments(event);
  const draftLabel = draftType === "clarify"
    ? "Approved draft (CLARIFICATION QUESTION):"
    : draftType === "no_answer"
      ? "Approved draft (NO ANSWER — needs maintainer):"
      : "Approved draft:";
  return [
    `Route: ${route.id}`,
    `Source: ${event.sourceUrl ?? buildSourceUrlFromEvent(event)}`,
    `Author: ${event.authorName} (${event.authorId})`,
    "",
    "Incoming message:",
    event.content || "[no text content]",
    attachmentText ? "" : undefined,
    attachmentText ? "Attachments:" : undefined,
    attachmentText,
    "",
    draftLabel,
    reply,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

const MAINTAINER_IDS = parseMaintainerSet(process.env.STEVESBOT_MAINTAINER_USER_IDS ?? "111111111111111111");
const MAINTAINER_NAMES = parseMaintainerSet(process.env.STEVESBOT_MAINTAINER_USERNAMES ?? "maintainer,maintainer-user");

const SUPPORT_PROBLEM_PATTERN = /\b(?:help|fix|debug|diagnos(?:e|is|tic)|troubleshoot|error|issue|problem|broken|bug|crash(?:ed|ing|es)?|fail(?:ed|ing|s|ure)?|stuck|unable|offline|disconnect(?:ed|ing|s)?|missing|cannot|can't|won't|not\s+working|doesn['’]?t\s+work)\b/i;
const SUPPORT_TOPIC_PATTERN = /\b(?:support|product|service|app|website|stream(?:ing)?|camera|webcam|video|audio|microphone|browser|webrtc|relay|overlay|chat|extension|url|link|setting|configuration|config|screenshot|logs?)\b/i;
const HELP_REQUEST_PATTERN = /\b(?:can|could|would|will)\s+you\b|\b(?:please|help|fix|debug|diagnose|troubleshoot|investigate|check|review|explain|analy[sz]e|look\s+into|take\s+a\s+look)\b|\b(?:how|why|what|where)\s+(?:do|does|can|could|should|is|are|did)\b|\?/i;

/**
 * Treat only support-relevant @mentions as an explicit request. Discord's parsed
 * mentions are authoritative; matching visible @text alone would be spoofable.
 */
export function isExplicitBotHelpMention(
  message: Pick<Message, "content" | "mentions">,
  botUserId: string | undefined,
): boolean {
  if (!botUserId || !message.mentions.has(botUserId)) {
    return false;
  }

  const requestText = message.content.replace(/<@!?\d+>/g, " ").trim();
  if (!requestText) {
    return false;
  }

  const hasProblem = SUPPORT_PROBLEM_PATTERN.test(requestText);
  const hasSupportTopic = SUPPORT_TOPIC_PATTERN.test(requestText);
  const hasRequestLanguage = HELP_REQUEST_PATTERN.test(requestText);
  return (hasProblem && (hasRequestLanguage || hasSupportTopic)) || (hasSupportTopic && hasRequestLanguage);
}

/** Map route IDs to triage product IDs for auto-triage in known support channels */
const ROUTE_PRODUCT_MAP: Record<string, string> = {
  "vdo-ninja-support": "vdo-ninja",
  "social-stream-support": "social-stream",
};

const DRAFT_USAGE_PREFIX = "draft_";
const USAGE_LABELS: Record<DraftUsage, string> = {
  used: "Sent as-is",
  modified: "Edited & sent",
  skipped: "Not sent",
};

function parseDraftUsageButton(customId: string): { usage: DraftUsage; runId: number } | undefined {
  if (!customId.startsWith(DRAFT_USAGE_PREFIX)) {
    return undefined;
  }
  const rest = customId.slice(DRAFT_USAGE_PREFIX.length);
  const colonIndex = rest.indexOf(":");
  if (colonIndex < 0) {
    return undefined;
  }
  const action = rest.slice(0, colonIndex);
  const runId = Number(rest.slice(colonIndex + 1));
  if (!Number.isInteger(runId)) {
    return undefined;
  }
  if (action === "used" || action === "modified" || action === "skipped") {
    return { usage: action, runId };
  }
  return undefined;
}

export class DiscordBot {
  private readonly client: Client;

  public constructor(
    private readonly config: AppConfig,
    private readonly sink: WorkflowEventSink,
    private readonly usageSink?: DraftUsageSink,
    private readonly onTriageSearchRequested?: (state: TriageFlowState) => void,
    private readonly onTriageComplete?: (state: TriageFlowState, searchRequested: boolean) => void,
    private readonly commandDeps?: CommandHandlerDeps,
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  private listenersRegistered = false;

  public async start(token: string): Promise<void> {
    if (!this.listenersRegistered) {
      this.client.on("messageCreate", (message) => {
        void this.onMessage(message).catch((error) => {
          console.error("Discord message intake failed.", error);
        });
      });

      this.client.on("interactionCreate", (interaction) => {
        void this.onInteraction(interaction).catch((error) => {
          console.error("Discord interaction handling failed.", error);
        });
      });

      this.client.on("threadCreate", (thread, newlyCreated) => {
        if (newlyCreated) {
          void this.onThreadCreate(thread).catch((error) => {
            console.error("Discord thread create handling failed.", error);
          });
        }
      });

      this.listenersRegistered = true;
    }

    await this.client.login(token);
  }

  /** Destroy the Discord client connection. */
  destroy(): void {
    this.client.destroy();
  }

  private async onMessage(message: Message): Promise<void> {
    // Inter-bot triage: NinjaBot mentions us with !start-triage to trigger interactive triage
    if (message.author.bot && message.guildId && message.mentions.has(this.client.user?.id ?? "")) {
      const match = message.content.match(/!start-triage\s+user=(\d+)(?:\s+trigger=(\d+))?/);
      if (match) {
        const userId = match[1];
        const triggerMessageId = match[2] ?? message.id;
        const channelId = message.channelId;

        // Detect product from thread starter message content
        let preselectedProduct: string | undefined;
        if (message.channel.isThread()) {
          try {
            const starter = await message.channel.fetchStarterMessage();
            if (starter) {
              const text = starter.content.toLowerCase();
              const vdoPattern = /\bvdo\b|\bmeshcast\b|\bwhip\b|\bwhep\b|\bdirector\b|\bstream\s*id\b|\bguest\s*link\b|\bscene\s*link\b|\bpush\s*link\b|\bview\s*link\b|\braspberry\.ninja\b|\b&?proaudio\b|\bvirtual\s*cam/i;
              const ssnPattern = /\bssn\b|\bsocial\b|\bsocialstream\b|\bdock\.html\b|\bfeatured\s*chat\b|\bchat\s*overlay\b|\bchat\s*capture\b|\bevent\s*flow\b|\bstreamer\.bot\b|\bmultichat\b|\brelay\b/i;
              if (vdoPattern.test(text)) {
                preselectedProduct = "vdo-ninja";
              } else if (ssnPattern.test(text)) {
                preselectedProduct = "social-stream";
              }
            }
          } catch { /* couldn't fetch starter */ }
        }

        const token = this.client.token;
        if (token) {
          // Delete the command message to keep thread clean
          try { await message.delete(); } catch { /* may lack permission */ }

          const result = await sendTriagePrompt(token, channelId, triggerMessageId, userId, preselectedProduct);
          if (result.error) {
            console.log(`[BOT-TRIAGE] Failed in ${channelId}: ${result.error}`);
          } else {
            console.log(`[BOT-TRIAGE] Started triage in ${channelId} for user ${userId} (product: ${preselectedProduct ?? "ask"}, message: ${result.messageId})`);
          }
        }
        return;
      }
    }

    if (message.author.bot || !message.guildId) {
      return;
    }

    // ── Review channel: maintainer-controlled channel for direct bot interaction ──
    if (
      this.config.reviewChannel?.enabled &&
      this.config.reviewChannel.guildId === message.guildId &&
      this.config.reviewChannel.channelId === message.channelId &&
      this.commandDeps
    ) {
      void handleCommandMessage(message, this.commandDeps).catch((err) => {
        console.error("[COMMAND] Unhandled error:", err);
      });
      return;
    }

    // If a maintainer posts in a channel with an active triage flow, silence the bot
    const channelId = message.channelId;
    if (
      (MAINTAINER_IDS.has(message.author.id) || MAINTAINER_NAMES.has(message.author.username.toLowerCase())) &&
      getFlowState(channelId)
    ) {
      markMaintainerPresent(channelId);
    }

    const route = this.resolveRoute(message);
    if (!route) {
      return;
    }

    const event = toEvent(message);
    const isMaintainer = MAINTAINER_IDS.has(message.author.id)
      || MAINTAINER_NAMES.has(message.author.username.toLowerCase());
    if (!isMaintainer && isExplicitBotHelpMention(message, this.client.user?.id)) {
      event.userRequestedBotHelp = true;
      event.botHelpRequestSource = "mention";
    }

    await this.sink.enqueue(route, event);
  }

  private async onThreadCreate(thread: AnyThreadChannel): Promise<void> {
    if (!thread.parentId || !thread.guildId) return;

    // Only auto-triage in thread-mode support channels
    const route = this.config.routes.find(
      (r) => r.enabled && r.mode === "thread" && r.guildId === thread.guildId && r.channelId === thread.parentId,
    );
    if (!route) return;

    // Skip if created by a bot
    if (thread.ownerId) {
      try {
        const owner = await thread.guild?.members.fetch(thread.ownerId);
        if (owner?.user.bot) return;
      } catch {
        // Can't verify — proceed anyway
      }
    }

    // Small delay to let the starter message propagate
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get the starter message (the user's question)
    const starterMessage = await thread.fetchStarterMessage().catch(() => null);
    const triggerMessageId = starterMessage?.id ?? thread.id;
    const userId = starterMessage?.author.id ?? thread.ownerId ?? "";
    if (!userId) return;

    // Map route to product for pre-selection
    const preselectedProduct = ROUTE_PRODUCT_MAP[route.id];

    const token = this.client.token;
    if (!token) return;

    const result = await sendTriagePrompt(token, thread.id, triggerMessageId, userId, preselectedProduct);
    if (result.error) {
      console.log(`[AUTO-TRIAGE] Failed to send prompt in ${thread.id}: ${result.error}`);
    } else {
      console.log(`[AUTO-TRIAGE] Sent triage prompt in thread ${thread.id} (route: ${route.id}, product: ${preselectedProduct ?? "ask"}, message: ${result.messageId})`);
    }
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) {
      return;
    }

    // Check for interactive triage buttons first
    const triageAction = parseTriageButton(interaction.customId);
    if (triageAction) {
      await handleTriageInteraction(interaction, triageAction, this.onTriageSearchRequested, this.onTriageComplete);
      return;
    }

    const parsed = parseDraftUsageButton(interaction.customId);
    if (!parsed) {
      return;
    }

    const { usage, runId } = parsed;

    try {
      const usageResult = this.usageSink
        ? await this.usageSink.recordUsage(runId, interaction.message.id, usage, interaction.user.id)
        : undefined;

      if (this.usageSink) {
        // already handled above so async send-as-is paths can complete before we disable buttons
      }

      // Update the message to show which button was clicked and disable all buttons
      await interaction.update({
        components: [
          {
            type: 1, // ACTION_ROW
            components: [
              {
                type: 2, // BUTTON
                style: 2, // SECONDARY
                label: `${usage === "used" && usageResult?.sentToSource ? "Sent as-is" : USAGE_LABELS[usage]} (by ${interaction.user.username})`,
                custom_id: "draft_recorded",
                disabled: true,
              },
            ],
          },
        ],
      });
    } catch (error) {
      console.error(`Failed to record draft usage for run ${runId}:`, error);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "Failed to record usage.", flags: MessageFlags.Ephemeral });
        }
      } catch {
        // Interaction may have expired
      }
    }
  }

  private resolveRoute(message: Message): RouteConfig | undefined {
    return this.config.routes.find((route) =>
      routeMatchesMessage(route, {
        guildId: message.guildId,
        channelId: message.channelId,
        isThread: message.channel.isThread(),
        parentChannelId: message.channel.isThread() ? message.channel.parentId : undefined,
      }),
    );
  }
}
