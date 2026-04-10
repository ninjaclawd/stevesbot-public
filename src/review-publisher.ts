import type { AppConfig } from "./config.js";
import { buildReviewMessage } from "./discord/bot.js";
import type { DiscordEventRecord, ReviewDeliveryResult, RouteConfig } from "./types.js";

type DiscordMessageResponse = {
  id?: string;
};

function buildUsageButtons(runId: number): unknown[] {
  return [
    {
      type: 1, // ACTION_ROW
      components: [
        {
          type: 2, // BUTTON
          style: 3, // SUCCESS (green)
          label: "Send as-is",
          custom_id: `draft_used:${runId}`,
          emoji: { name: "\u2705" },
        },
        {
          type: 2,
          style: 2, // SECONDARY (grey)
          label: "Edit & Send",
          custom_id: `draft_modified:${runId}`,
          emoji: { name: "\u270f\ufe0f" },
        },
        {
          type: 2,
          style: 4, // DANGER (red)
          label: "Don't Send",
          custom_id: `draft_skipped:${runId}`,
          emoji: { name: "\u274c" },
        },
      ],
    },
  ];
}

export class DiscordReviewPublisher {
  public constructor(
    private readonly config: AppConfig,
    private readonly token: string,
  ) {}

  public async publish(route: RouteConfig, event: DiscordEventRecord, reply: string, runId?: number, draftType?: "standard" | "clarify" | "no_answer"): Promise<ReviewDeliveryResult> {
    const reviewChannel = this.config.reviewChannel;
    if (!reviewChannel?.enabled) {
      throw new Error("Review channel is not enabled.");
    }

    const body: Record<string, unknown> = {
      content: buildReviewMessage(route, event, reply, draftType),
    };

    if (runId !== undefined) {
      body.components = buildUsageButtons(runId);
    }

    const response = await fetch(`https://discord.com/api/v10/channels/${reviewChannel.channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    let responseJson: DiscordMessageResponse | undefined;
    try {
      responseJson = responseText ? (JSON.parse(responseText) as DiscordMessageResponse) : undefined;
    } catch {
      responseJson = undefined;
    }

    if (!response.ok || !responseJson?.id) {
      throw new Error(`Discord review delivery failed (${response.status}): ${responseText}`);
    }

    return {
      channelId: reviewChannel.channelId,
      messageId: responseJson.id,
    };
  }
}
