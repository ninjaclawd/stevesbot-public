import type { ReviewDeliveryResult, WorkflowRunDetail } from "../types.js";

type WorkflowRunLookup = {
  getWorkflowRun(runId: number): Pick<WorkflowRunDetail, "channelId" | "threadId" | "replyText" | "outcome"> | undefined;
};

type DiscordMessageResponse = {
  id?: string;
};

export async function sendApprovedDraftFromRun(
  runs: WorkflowRunLookup,
  botToken: string,
  runId: number,
): Promise<ReviewDeliveryResult> {
  const run = runs.getWorkflowRun(runId);
  if (!run) {
    throw new Error(`Workflow run ${runId} was not found.`);
  }
  if (run.outcome !== "approved") {
    throw new Error(`Workflow run ${runId} is not approved and cannot be sent as-is.`);
  }
  const body = run.replyText?.trim();
  if (!body) {
    throw new Error(`Workflow run ${runId} has no draft reply to send.`);
  }

  const channelId = run.threadId ?? run.channelId;
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: body }),
  });

  const responseText = await response.text();
  let responseJson: DiscordMessageResponse | undefined;
  try {
    responseJson = responseText ? (JSON.parse(responseText) as DiscordMessageResponse) : undefined;
  } catch {
    responseJson = undefined;
  }

  if (!response.ok || !responseJson?.id) {
    throw new Error(`Discord source delivery failed (${response.status}): ${responseText}`);
  }

  return {
    channelId,
    messageId: responseJson.id,
  };
}
