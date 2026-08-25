import {
  AgentsResponseSchema,
  AgentMutationResponseSchema,
  AgentContextFilesResponseSchema,
  ModelsResponseSchema,
  NotificationsResponseSchema,
  ApiErrorSchema,
  ChatAbortRequestSchema,
  ChatAbortResponseSchema,
  ChatEventSchema,
  ChatHistoryQuerySchema,
  ChatHistoryResponseSchema,
  ChatSendRequestSchema,
  ChatSendResponseSchema,
  CreateSessionRequestSchema,
  CreateAgentRequestSchema,
  DeleteAgentRequestSchema,
  DeleteSessionRequestSchema,
  DeleteSessionResponseSchema,
  ForkSessionRequestSchema,
  GatewayStatusSchema,
  PatchSessionRequestSchema,
  SessionMutationResponseSchema,
  SessionChangedEventSchema,
  UpdateAgentRequestSchema,
  UpdateAgentContextFilesRequestSchema,
  UpdateAgentContextFilesResponseSchema,
  SessionsQuerySchema,
  SessionsDescribeQuerySchema,
  SessionsDescribeResponseSchema,
  SessionsResponseSchema,
  type AgentsResponse,
  type AgentMutationResponse,
  type AgentContextFilesResponse,
  type ModelsResponse,
  type NotificationsResponse,
  type ChatAbortRequest,
  type ChatAbortResponse,
  type ChatEvent,
  type ChatHistoryQuery,
  type ChatHistoryResponse,
  type ChatSendRequest,
  type ChatSendResponse,
  type CreateSessionRequest,
  type CreateAgentRequest,
  type DeleteAgentRequest,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type ForkSessionRequest,
  type GatewayStatus,
  type PatchSessionRequest,
  type SessionMutationResponse,
  type SessionChangedEvent,
  type UpdateAgentRequest,
  type UpdateAgentContextFilesRequest,
  type UpdateAgentContextFilesResponse,
  type SessionsQuery,
  type SessionsDescribeQuery,
  type SessionsDescribeResponse,
  type SessionsResponse,
} from "@alexandretorqueti/openclaw-console-contracts";
import type { ZodTypeAny } from "zod";

export interface ConsoleClientOptions {
  /** Defaults to `/api`, allowing same-origin deployments with no browser secrets. */
  baseUrl?: string;
  /** Bearer token sent as `Authorization` header on requests and `?token=` on the SSE stream. */
  authToken?: string;
  fetch?: typeof globalThis.fetch;
  eventSource?: typeof globalThis.EventSource;
  headers?: HeadersInit;
}

export interface ConsoleEventHandlers {
  onChat?: (event: ChatEvent) => void;
  onStatus?: (status: GatewayStatus) => void;
  onSessions?: (event: SessionChangedEvent) => void;
  onOpen?: () => void;
  onError?: (error: Event | Error) => void;
}

export class ConsoleApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ConsoleApiError";
    this.status = status;
    this.code = code;
  }
}

export class ConsoleContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConsoleContractError";
  }
}

export class OpenClawConsoleClient {
  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly EventSourceImpl: typeof globalThis.EventSource | undefined;
  private readonly headers: HeadersInit | undefined;

  constructor(options: ConsoleClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.authToken = options.authToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.EventSourceImpl = options.eventSource ?? globalThis.EventSource;
    this.headers = options.headers;
  }

  getStatus(): Promise<GatewayStatus> {
    return this.get<GatewayStatus>("/status", GatewayStatusSchema);
  }

  listAgents(): Promise<AgentsResponse> {
    return this.get<AgentsResponse>("/agents", AgentsResponseSchema);
  }

  createAgent(request: CreateAgentRequest): Promise<AgentMutationResponse> {
    return this.mutate<AgentMutationResponse>("POST", "/agents", CreateAgentRequestSchema.parse(request), AgentMutationResponseSchema);
  }

  updateAgent(request: UpdateAgentRequest): Promise<AgentMutationResponse> {
    return this.mutate<AgentMutationResponse>("PATCH", "/agents", UpdateAgentRequestSchema.parse(request), AgentMutationResponseSchema);
  }

  deleteAgent(request: DeleteAgentRequest): Promise<AgentMutationResponse> {
    return this.mutate<AgentMutationResponse>("DELETE", "/agents", DeleteAgentRequestSchema.parse(request), AgentMutationResponseSchema);
  }

  listModels(): Promise<ModelsResponse> {
    return this.get<ModelsResponse>("/models", ModelsResponseSchema);
  }

  getAgentContextFiles(agentId: string): Promise<AgentContextFilesResponse> {
    return this.get<AgentContextFilesResponse>(`/agents/${encodeURIComponent(agentId)}/files`, AgentContextFilesResponseSchema);
  }

  updateAgentContextFiles(request: UpdateAgentContextFilesRequest): Promise<UpdateAgentContextFilesResponse> {
    const parsed = UpdateAgentContextFilesRequestSchema.parse(request);
    return this.mutate<UpdateAgentContextFilesResponse>(
      "PUT",
      `/agents/${encodeURIComponent(parsed.agentId)}/files`,
      { files: parsed.files },
      UpdateAgentContextFilesResponseSchema,
    );
  }

  listSessions(query: Partial<SessionsQuery> = {}): Promise<SessionsResponse> {
    const parsed = SessionsQuerySchema.parse(query);
    return this.get<SessionsResponse>(`/sessions?${toQueryString(parsed)}`, SessionsResponseSchema);
  }

  listNotifications(): Promise<NotificationsResponse> {
    return this.get<NotificationsResponse>("/notifications", NotificationsResponseSchema);
  }

  getChatHistory(query: ChatHistoryQuery): Promise<ChatHistoryResponse> {
    const parsed = ChatHistoryQuerySchema.parse(query);
    return this.get<ChatHistoryResponse>(`/chat/history?${toQueryString(parsed)}`, ChatHistoryResponseSchema);
  }

  sendChat(request: ChatSendRequest): Promise<ChatSendResponse> {
    return this.mutate<ChatSendResponse>("POST", "/chat/send", ChatSendRequestSchema.parse(request), ChatSendResponseSchema);
  }

  abortChat(request: ChatAbortRequest): Promise<ChatAbortResponse> {
    return this.mutate<ChatAbortResponse>("POST", "/chat/abort", ChatAbortRequestSchema.parse(request), ChatAbortResponseSchema);
  }

  createSession(request: CreateSessionRequest = {}): Promise<SessionMutationResponse> {
    return this.mutate<SessionMutationResponse>(
      "POST",
      "/sessions",
      CreateSessionRequestSchema.parse(request),
      SessionMutationResponseSchema,
    );
  }

  forkSession(request: ForkSessionRequest): Promise<SessionMutationResponse> {
    return this.mutate<SessionMutationResponse>(
      "POST",
      "/sessions/fork",
      ForkSessionRequestSchema.parse(request),
      SessionMutationResponseSchema,
    );
  }

  patchSession(request: PatchSessionRequest): Promise<SessionMutationResponse> {
    return this.mutate<SessionMutationResponse>(
      "PATCH",
      "/sessions",
      PatchSessionRequestSchema.parse(request),
      SessionMutationResponseSchema,
    );
  }

  deleteSession(request: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    return this.mutate<DeleteSessionResponse>(
      "DELETE",
      "/sessions",
      DeleteSessionRequestSchema.parse(request),
      DeleteSessionResponseSchema,
    );
  }

  describeSession(query: SessionsDescribeQuery): Promise<SessionsDescribeResponse> {
    const parsed = SessionsDescribeQuerySchema.parse(query);
    return this.get<SessionsDescribeResponse>(`/sessions/describe?${toQueryString(parsed)}`, SessionsDescribeResponseSchema);
  }

  subscribeEvents(handlers: ConsoleEventHandlers): () => void {
    if (!this.EventSourceImpl) throw new Error("EventSource is not available in this environment");
    const eventsUrl = this.url("/events");
    const source = new this.EventSourceImpl(this.authToken ? `${eventsUrl}?token=${encodeURIComponent(this.authToken)}` : eventsUrl);
    const chat = (event: MessageEvent<string>) => this.handleSseData(event.data, ChatEventSchema, handlers.onChat, handlers.onError);
    const status = (event: MessageEvent<string>) =>
      this.handleSseData(event.data, GatewayStatusSchema, handlers.onStatus, handlers.onError);
    const sessions = (event: MessageEvent<string>) =>
      this.handleSseData(event.data, SessionChangedEventSchema, handlers.onSessions, handlers.onError);
    const open = () => handlers.onOpen?.();
    const error = (event: Event) => handlers.onError?.(event);
    source.addEventListener("chat", chat as EventListener);
    source.addEventListener("status", status as EventListener);
    source.addEventListener("sessions", sessions as EventListener);
    source.addEventListener("open", open);
    source.addEventListener("error", error);
    return () => {
      source.removeEventListener("chat", chat as EventListener);
      source.removeEventListener("status", status as EventListener);
      source.removeEventListener("sessions", sessions as EventListener);
      source.removeEventListener("open", open);
      source.removeEventListener("error", error);
      source.close();
    };
  }

  private handleSseData<T>(
    data: string,
    schema: ZodTypeAny,
    handler: ((value: T) => void) | undefined,
    errorHandler: ((error: Event | Error) => void) | undefined,
  ): void {
    try {
      handler?.(schema.parse(JSON.parse(data) as unknown));
    } catch (error) {
      errorHandler?.(new ConsoleContractError("Invalid SSE event payload", { cause: error }));
    }
  }

  private get<T>(path: string, schema: ZodTypeAny): Promise<T> {
    return this.request(path, { method: "GET" }, schema);
  }

  private mutate<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body: unknown, schema: ZodTypeAny): Promise<T> {
    return this.request(
      path,
      {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      schema,
    );
  }

  private async request<T>(path: string, init: RequestInit, schema: ZodTypeAny): Promise<T> {
    const headers = new Headers(this.headers);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (this.authToken && !headers.has("authorization")) headers.set("Authorization", `Bearer ${this.authToken}`);
    const response = await this.fetchImpl(this.url(path), { ...init, headers });
    const value = await readJson(response);
    if (!response.ok) {
      const parsed = ApiErrorSchema.safeParse(value);
      throw new ConsoleApiError(
        response.status,
        parsed.success ? parsed.data.error.code : "HTTP_ERROR",
        parsed.success ? parsed.data.error.message : `Console API request failed (${response.status})`,
      );
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ConsoleContractError(`Console API returned an invalid response for ${path}`, {
        cause: parsed.error,
      });
    }
    return parsed.data as T;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}

export { OpenClawConsoleClient as ConsoleClient };

function toQueryString(values: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query.toString();
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConsoleContractError("Console API returned invalid JSON", { cause: error });
  }
}
