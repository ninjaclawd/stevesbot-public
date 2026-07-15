export type RouteMode = "thread" | "channel";

export type RouteConfig = {
  id: string;
  guildId: string;
  channelId: string;
  mode: RouteMode;
  instructionRef: string;
  repoScopes: string[];
  enabled: boolean;
};

export type ReviewChannelConfig = {
  guildId: string;
  channelId: string;
  enabled: boolean;
};

export type RepoManifestEntry = {
  id: string;
  owner: string;
  repo: string;
  localPath: string;
  summary: string;
  allowedPaths: string[];
};

export type ResourceAreaSummary = {
  id: string;
  label: string;
  purpose: string;
  readableScopes: string[];
  typicalContent: string;
  usageGuidance: string;
};

export type DiscordAttachmentRecord = {
  id: string;
  fileName: string;
  url: string;
  proxyUrl?: string;
  contentType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  kind: "image" | "other";
  storedPath?: string;
  storedContentType?: string;
  storedWidth?: number;
  storedHeight?: number;
  extractedText?: string;
  extractedSummary?: string;
  extractedSignals?: string[];
  extractedConfidence?: number;
  processingError?: string;
};

export type DiscordEventRecord = {
  guildId: string;
  channelId: string;
  threadId?: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  sourceUrl?: string;
  attachments?: DiscordAttachmentRecord[];
  /** Set when the user explicitly asks the bot for help; bypasses maintainer/human-handling guards. */
  userRequestedBotHelp?: boolean;
  /** Distinguishes a passive Discord mention from the repeatable Ask-the-Bot action. */
  botHelpRequestSource?: "ask-button" | "mention";
  /** The triage prompt message ID — edited/removed when pipeline completes. */
  triageMessageId?: string;
};

export type ThreadContext = {
  route: RouteConfig;
  firstMessage?: DiscordEventRecord;
  recentMessages: DiscordEventRecord[];
  currentMessage: DiscordEventRecord;
};

export type TriageAction = "ignore" | "hold" | "reply";
export type TriageUrgency = "low" | "medium" | "high";

export type TriageDecision = {
  action: TriageAction;
  botShouldSpeakNow: boolean;
  confidence: number;
  category: string;
  rationale: string;
  problemOpen: boolean;
  humanAlreadyHandling: boolean;
  directAsk: boolean;
  newTechnicalEvidence: boolean;
  novelty: number;
  urgency: TriageUrgency;
};

export type HistoricalSupportRecord = {
  id: number;
  routeId: string;
  productId: string;
  sourceThreadRef: string;
  dateStart: string;
  dateEnd: string;
  questionSummary: string;
  answerSummary: string;
  statusFlags: string[];
};

export type QueryTraceEntry = {
  stepIndex: number;
  toolName: string;
  input: Record<string, unknown>;
  resultSummary: string;
  timestamp: string;
};

export type DraftReply = {
  body: string;
  citedSupportRecordIds: number[];
  repoRefs: string[];
  queryTraceSummary: QueryTraceEntry[];
};

export type ReviewDecision = {
  approved: boolean;
  confidence: number;
  issues: string[];
  policyFlags: string[];
  finalBody: string;
};

export type QaEntry = {
  routeId: string;
  threadKey: string;
  questionText: string;
  answerText: string;
  supportRefs: number[];
  repoRefs: string[];
  reviewConfidence: number;
};

export type SearchResult = {
  repoId: string;
  path: string;
  line: number;
  snippet: string;
};

export type ResourceMap = {
  areas: ResourceAreaSummary[];
};

export type RepoManifest = {
  repos: RepoManifestEntry[];
};

export type DiscordManifest = {
  reviewChannel?: ReviewChannelConfig;
  routes: RouteConfig[];
};

export type ModelClientDescriptor = {
  clientLabel: string;
  model: string;
  baseUrl: string;
};

export type ModelInvocationTrace = {
  clientLabel: string;
  model: string;
  baseUrl: string;
  attemptNumber?: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  statusCode?: number;
  ok: boolean;
  requestBody: Record<string, unknown>;
  responseBody?: unknown;
  responseText?: string;
  errorText?: string;
  validationSchema?: string;
  validationErrorText?: string;
};

export type WorkflowQueueStatus = "queued" | "leased" | "completed" | "failed";

export type WorkflowQueueJob = {
  id: number;
  routeId: string;
  event: DiscordEventRecord;
  status: WorkflowQueueStatus;
  attempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  availableAt: string;
  runId?: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ReviewDeliveryResult = {
  channelId: string;
  messageId: string;
};

export type WorkflowStepStatus = "ok" | "error";

export type WorkflowStepRecord = {
  id?: number;
  runId?: number;
  stepIndex: number;
  phase: string;
  label: string;
  status: WorkflowStepStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  modelLabel?: string;
  modelName?: string;
  modelBaseUrl?: string;
  inputText?: string;
  outputText?: string;
  requestJson?: unknown;
  responseJson?: unknown;
  metadata?: Record<string, unknown>;
};

export type WorkflowRunSummary = {
  id: number;
  routeId: string;
  threadKey: string;
  messageId: string;
  guildId: string;
  channelId: string;
  threadId?: string;
  authorId: string;
  authorName: string;
  sourceUrl: string;
  messageContent: string;
  discordCreatedAt: string;
  receivedAt: string;
  outcome: string;
  triage?: TriageDecision;
  review?: ReviewDecision;
  replyText?: string;
  errorText?: string;
  totalDurationMs: number;
  qwenModel: string;
  gptModel: string;
  createdAt: string;
};

export type WorkflowRunDetail = WorkflowRunSummary & {
  steps: WorkflowStepRecord[];
};

export type DraftUsage = "used" | "modified" | "skipped";

export type DraftUsageRecord = {
  runId: number;
  reviewMessageId: string;
  usage: DraftUsage;
  reactedBy: string;
  createdAt: string;
};
