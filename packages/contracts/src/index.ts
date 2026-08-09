import { z } from "zod";

const NonEmptyStringSchema = z.string().trim().min(1);
const NullableNonEmptyStringSchema = NonEmptyStringSchema.nullable();
const OptionalTimestampSchema = z.number().int().nonnegative().optional();

const integerQuery = (minimum: number, maximum?: number) =>
  z.preprocess(
    (value) => {
      if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
      return value;
    },
    maximum === undefined
      ? z.number().int().min(minimum)
      : z.number().int().min(minimum).max(maximum),
  );

export const AgentStatusSchema = z.enum(["online", "busy", "offline", "unknown"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentSchema = z
  .object({
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    role: z.string().optional(),
    emoji: z.string().optional(),
    avatar: z.string().optional(),
    model: z.string().optional(),
    workspace: z.string().optional(),
    status: AgentStatusSchema.default("unknown"),
    isDefault: z.boolean().default(false),
  })
  .strict();
export type Agent = z.infer<typeof AgentSchema>;

export const CreateAgentRequestSchema = z.object({
  name: NonEmptyStringSchema.max(120),
  workspace: NonEmptyStringSchema.max(1000),
  model: z.string().trim().min(1).max(300).optional(),
  emoji: z.string().max(32).optional(),
  avatar: z.string().max(500_000).optional(),
}).strict();
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const UpdateAgentRequestSchema = z.object({
  agentId: NonEmptyStringSchema,
  name: z.string().trim().min(1).max(120).optional(),
  workspace: z.string().trim().min(1).max(1000).optional(),
  model: z.string().trim().min(1).max(300).optional(),
  emoji: z.string().max(32).optional(),
  avatar: z.string().max(500_000).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "agentId"), "At least one mutable agent field is required");
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const DeleteAgentRequestSchema = z.object({ agentId: NonEmptyStringSchema, deleteFiles: z.boolean().default(false) }).strict();
export type DeleteAgentRequest = z.infer<typeof DeleteAgentRequestSchema>;
export const AgentMutationResponseSchema = z.object({ ok: z.literal(true), agentId: NonEmptyStringSchema, removedBindings: z.number().int().nonnegative().optional() }).strict();
export type AgentMutationResponse = z.infer<typeof AgentMutationResponseSchema>;

export const AgentContextFileNameSchema = z.enum([
  "AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md", "MEMORY.md",
]);
export type AgentContextFileName = z.infer<typeof AgentContextFileNameSchema>;
export const AgentContextFileSchema = z.object({
  name: AgentContextFileNameSchema,
  missing: z.boolean(),
  size: z.number().int().nonnegative().optional(),
  updatedAtMs: z.number().int().nonnegative().optional(),
  content: z.string().optional(),
}).strict();
export type AgentContextFile = z.infer<typeof AgentContextFileSchema>;
export const AgentContextFilesResponseSchema = z.object({
  agentId: NonEmptyStringSchema,
  workspace: NonEmptyStringSchema,
  files: z.array(AgentContextFileSchema),
}).strict();
export type AgentContextFilesResponse = z.infer<typeof AgentContextFilesResponseSchema>;
export const UpdateAgentContextFilesRequestSchema = z.object({
  agentId: NonEmptyStringSchema,
  files: z.array(z.object({ name: AgentContextFileNameSchema, content: z.string().max(1_000_000) }).strict()).min(1).max(8),
}).strict();
export type UpdateAgentContextFilesRequest = z.infer<typeof UpdateAgentContextFilesRequestSchema>;
export const UpdateAgentContextFilesResponseSchema = z.object({
  ok: z.literal(true),
  agentId: NonEmptyStringSchema,
  workspace: NonEmptyStringSchema,
  files: z.array(AgentContextFileSchema),
}).strict();
export type UpdateAgentContextFilesResponse = z.infer<typeof UpdateAgentContextFilesResponseSchema>;

export const ModelChoiceSchema = z.object({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  provider: NonEmptyStringSchema,
  alias: NonEmptyStringSchema.optional(),
  available: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
}).strict();
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;
export const ModelsResponseSchema = z.object({ models: z.array(ModelChoiceSchema) }).strict();
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

export const SessionStateSchema = z.enum(["active", "idle", "archived", "unknown"]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SessionSchema = z
  .object({
    key: NonEmptyStringSchema,
    sessionId: z.string().optional(),
    agentId: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    label: z.string().optional(),
    category: z.string().optional(),
    state: SessionStateSchema.default("unknown"),
    updatedAt: OptionalTimestampSchema,
    createdAt: OptionalTimestampSchema,
    archived: z.boolean().default(false),
    pinned: z.boolean().default(false),
    unread: z.boolean().default(false),
    hasActiveRun: z.boolean().default(false),
    parentSessionKey: z.string().optional(),
    spawnedBy: z.string().optional(),
    model: z.string().optional(),
    modelProvider: z.string().optional(),
    contextTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    contextPercent: z.number().min(0).max(100).optional(),
    lastMessagePreview: z.string().optional(),
  })
  .strict();
export type Session = z.infer<typeof SessionSchema>;

export const ChatRoleSchema = z.enum(["user", "assistant", "system", "tool", "unknown"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z
  .object({
    id: NonEmptyStringSchema,
    role: ChatRoleSchema,
    content: z.string(),
    thinking: z.string().optional(),
    author: z.string().optional(),
    createdAt: OptionalTimestampSchema,
    runId: z.string().optional(),
    status: z.string().optional(),
    stopReason: z.string().optional(),
    toolName: z.string().optional(),
  })
  .strict();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const GatewayConnectionStateSchema = z.enum([
  "connecting",
  "connected",
  "disconnected",
  "reconnecting",
  "error",
]);
export type GatewayConnectionState = z.infer<typeof GatewayConnectionStateSchema>;

export const GatewayStatusSchema = z
  .object({
    connected: z.boolean(),
    state: GatewayConnectionStateSchema,
    gatewayUrl: z.string().optional(),
    version: z.string().optional(),
    protocol: z.number().int().positive().optional(),
    connectionId: z.string().optional(),
    canAdmin: z.boolean().default(false),
    defaultAgentWorkspaceRoot: z.string().optional(),
    uptimeMs: z.number().nonnegative().optional(),
    checkedAt: z.number().int().nonnegative(),
    error: z.string().optional(),
  })
  .strict();
export type GatewayStatus = z.infer<typeof GatewayStatusSchema>;

const ChatEventBaseSchema = z.object({
  runId: NonEmptyStringSchema,
  sessionKey: NonEmptyStringSchema,
  agentId: z.string().optional(),
  seq: z.number().int().nonnegative(),
  message: ChatMessageSchema.optional(),
});

export const ChatDeltaEventSchema = ChatEventBaseSchema.extend({
  state: z.literal("delta"),
  deltaText: z.string(),
  replace: z.boolean().optional(),
}).strict();

export const ChatFinalEventSchema = ChatEventBaseSchema.extend({
  state: z.literal("final"),
  stopReason: z.string().optional(),
}).strict();

export const ChatAbortedEventSchema = ChatEventBaseSchema.extend({
  state: z.literal("aborted"),
  errorMessage: z.string().optional(),
  stopReason: z.string().optional(),
}).strict();

export const ChatErrorEventSchema = ChatEventBaseSchema.extend({
  state: z.literal("error"),
  errorMessage: z.string().optional(),
  errorKind: z.enum(["refusal", "timeout", "rate_limit", "context_length", "unknown"]).optional(),
  stopReason: z.string().optional(),
}).strict();

export const ChatEventSchema = z.discriminatedUnion("state", [
  ChatDeltaEventSchema,
  ChatFinalEventSchema,
  ChatAbortedEventSchema,
  ChatErrorEventSchema,
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: NonEmptyStringSchema,
        message: NonEmptyStringSchema,
        issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()).optional(),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const HealthResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const StatusResponseSchema = GatewayStatusSchema;
export type StatusResponse = GatewayStatus;

export const AgentsResponseSchema = z
  .object({
    agents: z.array(AgentSchema),
    defaultAgentId: z.string().optional(),
    mainSessionKey: z.string().optional(),
  })
  .strict();
export type AgentsResponse = z.infer<typeof AgentsResponseSchema>;

export const SessionsQuerySchema = z
  .object({
    agentId: z.string().trim().min(1).optional(),
    limit: integerQuery(1, 1000).default(200),
    offset: integerQuery(0).default(0),
    activeMinutes: integerQuery(1).optional(),
    search: z.string().trim().max(500).optional(),
    archived: z.preprocess(
      (value) => (value === "true" ? true : value === "false" ? false : value),
      z.boolean().optional(),
    ),
  })
  .strict();
export type SessionsQuery = z.infer<typeof SessionsQuerySchema>;

export const SessionsResponseSchema = z
  .object({
    sessions: z.array(SessionSchema),
    count: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative().optional(),
    hasMore: z.boolean().optional(),
    nextOffset: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SessionsResponse = z.infer<typeof SessionsResponseSchema>;

export const ChatHistoryQuerySchema = z
  .object({
    sessionKey: NonEmptyStringSchema,
    agentId: z.string().trim().min(1).optional(),
    limit: integerQuery(1, 1000).default(200),
    offset: integerQuery(0).default(0),
  })
  .strict();
export type ChatHistoryQuery = z.infer<typeof ChatHistoryQuerySchema>;

export const ChatHistoryResponseSchema = z
  .object({
    sessionKey: NonEmptyStringSchema,
    sessionId: z.string().optional(),
    messages: z.array(ChatMessageSchema),
    hasMore: z.boolean().optional(),
    nextOffset: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ChatHistoryResponse = z.infer<typeof ChatHistoryResponseSchema>;

export const ChatSendRequestSchema = z
  .object({
    sessionKey: NonEmptyStringSchema,
    agentId: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).max(500_000),
    thinking: z.string().trim().min(1).optional(),
    fastMode: z.union([z.boolean(), z.literal("auto")]).optional(),
    timeoutMs: z.number().int().min(0).max(3_600_000).optional(),
    attachments: z.array(z.unknown()).max(20).optional(),
  })
  .strict();
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>;

export const ChatSendResponseSchema = z
  .object({
    runId: NonEmptyStringSchema,
    status: z.string().optional(),
  })
  .strict();
export type ChatSendResponse = z.infer<typeof ChatSendResponseSchema>;

export const ChatAbortRequestSchema = z
  .object({
    sessionKey: NonEmptyStringSchema,
    agentId: z.string().trim().min(1).optional(),
    runId: z.string().trim().min(1).optional(),
  })
  .strict();
export type ChatAbortRequest = z.infer<typeof ChatAbortRequestSchema>;

export const ChatAbortResponseSchema = z
  .object({
    ok: z.boolean(),
    aborted: z.boolean(),
    runIds: z.array(z.string()).optional(),
  })
  .strict();
export type ChatAbortResponse = z.infer<typeof ChatAbortResponseSchema>;

export const CreateSessionRequestSchema = z
  .object({
    key: z.string().trim().min(1).optional(),
    agentId: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).max(200).optional(),
    model: z.string().trim().min(1).optional(),
    parentSessionKey: z.string().trim().min(1).optional(),
    task: z.string().max(500_000).optional(),
    message: z.string().max(500_000).optional(),
    worktree: z.boolean().optional(),
  })
  .strict();
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const ForkSessionRequestSchema = z
  .object({
    parentSessionKey: NonEmptyStringSchema,
    key: z.string().trim().min(1).optional(),
    agentId: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).max(200).optional(),
    model: z.string().trim().min(1).optional(),
  })
  .strict();
export type ForkSessionRequest = z.infer<typeof ForkSessionRequestSchema>;

export const SessionMutationResponseSchema = z
  .object({
    ok: z.literal(true),
    key: NonEmptyStringSchema,
    sessionId: z.string().optional(),
    session: SessionSchema.optional(),
    runStarted: z.boolean().optional(),
  })
  .strict();
export type SessionMutationResponse = z.infer<typeof SessionMutationResponseSchema>;

export const PatchSessionRequestSchema = z
  .object({
    key: NonEmptyStringSchema,
    agentId: z.string().trim().min(1).optional(),
    label: NullableNonEmptyStringSchema.optional(),
    category: NullableNonEmptyStringSchema.optional(),
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
    unread: z.boolean().optional(),
    thinkingLevel: NullableNonEmptyStringSchema.optional(),
    fastMode: z.union([z.boolean(), z.literal("auto"), z.null()]).optional(),
    model: NullableNonEmptyStringSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "key" && key !== "agentId"),
    "At least one mutable session field is required",
  );
export type PatchSessionRequest = z.infer<typeof PatchSessionRequestSchema>;

export const DeleteSessionRequestSchema = z.object({
  key: NonEmptyStringSchema,
  agentId: z.string().trim().min(1).optional(),
}).strict();
export type DeleteSessionRequest = z.infer<typeof DeleteSessionRequestSchema>;

export const DeleteSessionResponseSchema = z.object({
  ok: z.literal(true),
  key: NonEmptyStringSchema,
  deleted: z.boolean(),
  archived: z.array(z.string()).optional(),
}).strict();
export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponseSchema>;

export const SessionChangedEventSchema = z.object({
  sessionKey: NonEmptyStringSchema.optional(),
  agentId: z.string().optional(),
  reason: NonEmptyStringSchema,
  session: SessionSchema.optional(),
}).strict();
export type SessionChangedEvent = z.infer<typeof SessionChangedEventSchema>;

export const ConsoleEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat"), data: ChatEventSchema }).strict(),
  z.object({ type: z.literal("status"), data: GatewayStatusSchema }).strict(),
  z.object({ type: z.literal("sessions"), data: SessionChangedEventSchema }).strict(),
]);
export type ConsoleEvent = z.infer<typeof ConsoleEventSchema>;

// Explicit BFF-prefixed aliases keep the package ergonomic for consumers that
// also import OpenClaw's own protocol contracts.
export const BffStatusResponseSchema = StatusResponseSchema;
export const BffAgentsResponseSchema = AgentsResponseSchema;
export const BffSessionsResponseSchema = SessionsResponseSchema;
export const BffChatHistoryResponseSchema = ChatHistoryResponseSchema;
export const BffChatSendRequestSchema = ChatSendRequestSchema;
export const BffChatSendResponseSchema = ChatSendResponseSchema;
export const BffChatAbortRequestSchema = ChatAbortRequestSchema;
export const BffChatAbortResponseSchema = ChatAbortResponseSchema;
export const BffCreateSessionRequestSchema = CreateSessionRequestSchema;
export const BffForkSessionRequestSchema = ForkSessionRequestSchema;
export const BffPatchSessionRequestSchema = PatchSessionRequestSchema;
export const BffDeleteSessionRequestSchema = DeleteSessionRequestSchema;
export const BffDeleteSessionResponseSchema = DeleteSessionResponseSchema;
export const BffSessionMutationResponseSchema = SessionMutationResponseSchema;
