import type { DraftReply, ModelInvocationTrace, QueryTraceEntry } from "../types.js";

export type AgentAction =
  | { kind: "tool"; tool: string; args: Record<string, unknown>; reason?: string }
  | { kind: "final"; draft: string; supportRecordIds?: number[]; repoRefs?: string[] };

export interface IterativeModelClient {
  nextAction(input: {
    systemPrompt: string;
    conversation: string;
    toolTrace: QueryTraceEntry[];
    toolCatalog: string[];
    traceRecorder?: (trace: ModelInvocationTrace) => void;
  }): Promise<AgentAction>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIntegerArray(value: unknown, fieldName: string): number[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry === "number" && Number.isInteger(entry)) {
      return entry;
    }
    if (typeof entry === "string" && /^\d+$/.test(entry)) {
      return Number(entry);
    }
    throw new Error(`${fieldName}[${index}] must be an integer.`);
  });
}

function normalizeStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${fieldName}[${index}] must be a non-empty string.`);
    }
    return entry.trim();
  });
}

export function renderAgentActionFormat(toolCatalog: string[]): string {
  return [
    "Respond with exactly one JSON object.",
    "Allowed action shapes:",
    '{"kind":"tool","tool":"<name>","args":{...},"reason":"..."}',
    '{"kind":"final","draft":"...","supportRecordIds":[1],"repoRefs":["repo:path"]}',
    `Allowed tools: ${toolCatalog.join(", ")}`,
    "Do not emit multiple JSON objects.",
    "Do not wrap the JSON in markdown.",
  ].join("\n");
}

export function validateAgentAction(value: unknown, toolCatalog: string[]): AgentAction {
  if (!isRecord(value)) {
    throw new Error("Agent action must be a JSON object.");
  }

  const kind = value.kind;
  if (kind === "tool") {
    if (typeof value.tool !== "string" || !value.tool.trim()) {
      throw new Error('Tool action must include a non-empty "tool" string.');
    }
    if (!toolCatalog.includes(value.tool)) {
      throw new Error(`Tool "${value.tool}" is not in the allowed tool catalog.`);
    }
    if (!isRecord(value.args)) {
      throw new Error('Tool action must include an "args" object.');
    }
    if (value.reason !== undefined && typeof value.reason !== "string") {
      throw new Error('"reason" must be a string when provided.');
    }
    return {
      kind: "tool",
      tool: value.tool,
      args: value.args,
      reason: typeof value.reason === "string" ? value.reason : undefined,
    };
  }

  if (kind === "final") {
    if (typeof value.draft !== "string" || !value.draft.trim()) {
      throw new Error('Final action must include a non-empty "draft" string.');
    }
    return {
      kind: "final",
      draft: value.draft.trim(),
      supportRecordIds: normalizeIntegerArray(value.supportRecordIds, "supportRecordIds"),
      repoRefs: normalizeStringArray(value.repoRefs, "repoRefs"),
    };
  }

  throw new Error('Action "kind" must be either "tool" or "final".');
}

export async function runIterativeAgentLoop(params: {
  client: IterativeModelClient;
  systemPrompt: string;
  conversation: string;
  toolCatalog: string[];
  trace: QueryTraceEntry[];
  invokeTool: (tool: string, args: Record<string, unknown>) => Promise<string>;
  traceRecorder?: (trace: ModelInvocationTrace) => void;
  maxSteps?: number;
}): Promise<DraftReply> {
  const maxSteps = params.maxSteps ?? 10;

  for (let step = 0; step < maxSteps; step += 1) {
    const action = await params.client.nextAction({
      systemPrompt: params.systemPrompt,
      conversation: params.conversation,
      toolTrace: params.trace,
      toolCatalog: params.toolCatalog,
      traceRecorder: params.traceRecorder,
    });

    if (action.kind === "final") {
      return {
        body: action.draft,
        citedSupportRecordIds: action.supportRecordIds ?? [],
        repoRefs: action.repoRefs ?? [],
        queryTraceSummary: params.trace,
      };
    }

    const result = await params.invokeTool(action.tool, action.args);
    params.conversation = `${params.conversation}\n\nTool result (${action.tool}):\n${result}`;
  }

  throw new Error("Iterative answer loop exhausted without a final reply.");
}
