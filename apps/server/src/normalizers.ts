import {
  AgentSchema,
  ChatActivityEventSchema,
  ChatEventSchema,
  ChatMessageSchema,
  SessionSchema,
  type Agent,
  type ChatActivityEvent,
  type ChatEvent,
  type ChatMessage,
  type Session,
  type SessionsResponse,
} from "@alexandretorqueti/openclaw-console-contracts";
import type { GatewayEventFrame } from "@alexandretorqueti/openclaw-gateway-client";

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function bool(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function timestamp(value: unknown): number | undefined {
  const result = number(value);
  if (result !== undefined) return Math.max(0, Math.trunc(result));
  if (typeof value === "string") { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return undefined;
}
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    const item = record(part);
    const type = text(item.type)?.toLowerCase().replace(/[_-]/g, "");
    if (type === "thinking" || type === "reasoning" || isToolCallType(type)) return "";
    return text(item.text) ?? text(item.content) ?? (type === "toolresult" ? text(item.output) : undefined) ?? "";
  }).filter(Boolean).join("\n");
}
function thinkingText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const thinking = value.map((part) => {
    const item = record(part);
    const type = text(item.type)?.toLowerCase().replace(/[_-]/g, "");
    if (type !== "thinking" && type !== "reasoning") return undefined;
    return text(item.thinking) ?? text(item.text) ?? text(item.content);
  }).filter((value): value is string => Boolean(value)).join("\n");
  return text(thinking);
}
function isToolCallType(type?: string): boolean {
  return type === "toolcall" || type === "tooluse" || type === "functioncall";
}
function toolCalls(value: unknown): Array<{ name: string; input?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    const item = record(part);
    const type = text(item.type)?.toLowerCase().replace(/[_-]/g, "");
    if (!isToolCallType(type)) return [];
    const name = text(item.name) ?? text(item.toolName) ?? "ferramenta";
    const rawInput = item.arguments ?? item.args ?? item.input;
    if (rawInput === undefined) return [{ name }];
    try { return [{ name, input: typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2) }]; }
    catch { return [{ name }]; }
  });
}
function normalizedRole(value: string): "user" | "assistant" | "system" | "tool" | "unknown" {
  const role = value.toLowerCase().replace(/[_-]/g, "");
  if (role === "user" || role === "assistant" || role === "system") return role;
  if (role === "tool" || role === "toolresult" || role === "function") return "tool";
  return "unknown";
}
function normalizeModel(value: unknown): string | undefined {
  if (typeof value === "string") return text(value);
  const model = record(value);
  return text(model.primary) ?? text(model.id);
}

export function normalizeAgents(payload: unknown): { agents: Agent[]; defaultAgentId?: string; mainSessionKey?: string } {
  const root = record(payload);
  const rows = Array.isArray(root.agents) ? root.agents : Array.isArray(payload) ? payload : [];
  const defaultAgentId = text(root.defaultId) ?? text(root.defaultAgentId);
  const agents = rows.flatMap((value, index) => {
    const row = record(value); const identity = record(row.identity);
    const id = text(row.id); if (!id) return [];
    const parsed = AgentSchema.safeParse({
      id,
      name: text(row.name) ?? text(identity.name) ?? id,
      role: text(identity.theme) ?? text(row.role),
      emoji: text(identity.emoji),
      avatar: text(identity.avatarUrl) ?? text(identity.avatar),
      model: normalizeModel(row.model),
      workspace: text(row.workspace),
      status: index === 0 || id === defaultAgentId ? "online" : "unknown",
      isDefault: id === defaultAgentId,
    });
    return parsed.success ? [parsed.data] : [];
  });
  return { agents, ...(defaultAgentId ? { defaultAgentId } : {}), ...(text(root.mainKey) ? { mainSessionKey: text(root.mainKey) } : {}) };
}

export function normalizeSessions(payload: unknown): SessionsResponse {
  const root = record(payload);
  const rows = Array.isArray(root.sessions) ? root.sessions : Array.isArray(payload) ? payload : [];
  const sessions = rows.flatMap((value) => {
    const row = record(value);
    const key = text(row.key) ?? text(row.sessionKey); const agentId = agentFromKey(key) ?? text(row.agentId);
    if (!key || !agentId) return [];
    const active = bool(row.active) ?? bool(row.hasActiveRun) ?? false;
    const archived = bool(row.archived) ?? false;
    const contextTokens = number(row.contextTokens);
    const totalTokens = number(row.totalTokens);
    const suppliedContextPercent = number(row.contextPercent);
    const contextPercent = suppliedContextPercent ?? (
      contextTokens !== undefined && contextTokens > 0 && totalTokens !== undefined
        ? (totalTokens / contextTokens) * 100
        : 0
    );
    const parsed = SessionSchema.safeParse({
      key, agentId,
      title: text(row.displayName) ?? text(row.title) ?? text(row.derivedTitle) ?? text(row.label) ?? text(row.lastMessagePreview) ?? key,
      sessionId: text(row.sessionId), label: text(row.label), category: text(row.category),
      state: archived ? "archived" : active ? "active" : "idle",
      updatedAt: timestamp(row.updatedAt) ?? timestamp(row.updatedAtMs), createdAt: timestamp(row.createdAt) ?? timestamp(row.createdAtMs),
      archived, pinned: bool(row.pinned) ?? false, unread: bool(row.unread) ?? false,
      lastReadAt: timestamp(row.lastReadAt), lastActivityAt: timestamp(row.lastActivityAt), hasActiveRun: active,
      parentSessionKey: text(row.parentSessionKey) ?? text(row.forkedFromParent), spawnedBy: text(row.spawnedBy),
      model: normalizeModel(row.model), modelProvider: text(row.modelProvider), contextTokens, totalTokens,
      contextPercent: Math.max(0, Math.min(100, contextPercent)),
      lastMessagePreview: text(row.lastMessagePreview) ?? text(record(row.lastMessage).text),
    });
    return parsed.success ? [parsed.data] : [];
  });
  return {
    sessions,
    count: number(root.count) ?? sessions.length,
    ...(number(root.totalCount) !== undefined ? { totalCount: number(root.totalCount) } : {}),
    ...(bool(root.hasMore) !== undefined ? { hasMore: bool(root.hasMore) } : {}),
    ...(number(root.nextOffset) !== undefined ? { nextOffset: number(root.nextOffset) } : {}),
  };
}
function agentFromKey(key?: string): string | undefined {
  if (!key?.startsWith("agent:")) return undefined;
  return text(key.split(":")[1]);
}

export function normalizeMessage(value: unknown): ChatMessage | undefined {
  const row = record(value);
  const nested = record(row.message);
  const gatewayMetadata = record(row.__openclaw);
  // `chat.message.get` only accepts the Gateway's persisted message id. Do not
  // manufacture one from the position/timestamp: it looks valid to consumers,
  // but can never be used to retrieve a truncated message in full.
  // Gateway history responses store the canonical id in `__openclaw.id`.
  const id = text(row.id) ?? text(row.messageId) ?? text(row.message_id)
    ?? text(nested.id) ?? text(nested.messageId)
    ?? text(gatewayMetadata.id) ?? text(gatewayMetadata.messageId);
  if (!id) return undefined;
  const roleValue = text(row.role) ?? text(nested.role) ?? "unknown";
  let role = normalizedRole(roleValue);
  const body = row.content ?? nested.content ?? row.text;
  const thinking = role === "assistant" ? thinkingText(body) : undefined;
  const calls = role === "assistant" ? toolCalls(body) : [];
  let content = contentText(body);
  let toolName = text(row.toolName) ?? text(row.tool_name) ?? text(row.name);
  let status = text(row.status);
  if (role === "assistant" && !content.trim() && calls.length > 0) {
    role = "tool";
    toolName = calls.map((call) => call.name).join(", ");
    content = calls.map((call) => call.input ? `${call.name}\n${call.input}` : call.name).join("\n\n");
    status = "requested";
  } else if (role === "assistant" && !content.trim() && !thinking) {
    return undefined;
  }
  if (role === "tool") {
    const isError = bool(row.isError) ?? bool(row.is_error) ?? false;
    status = isError ? "error" : status ?? "completed";
  }
  const createdAt = timestamp(row.timestamp) ?? timestamp(row.createdAt) ?? timestamp(row.ts);
  const parsed = ChatMessageSchema.safeParse({
    id,
    role, content, ...(thinking ? { thinking } : {}), author: text(row.author) ?? text(row.name), createdAt,
    runId: text(row.runId), status, stopReason: text(row.stopReason), toolName,
  });
  return parsed.success ? parsed.data : undefined;
}

export function normalizeHistory(payload: unknown, sessionKey: string) {
  const root = record(payload);
  const rows = Array.isArray(root.messages) ? root.messages : [];
  return {
    sessionKey,
    ...(text(root.sessionId) ? { sessionId: text(root.sessionId) } : {}),
    messages: rows.flatMap((value) => { const message = normalizeMessage(value); return message ? [message] : []; }),
    ...(bool(root.hasMore) !== undefined ? { hasMore: bool(root.hasMore) } : {}),
    ...(number(root.nextOffset) !== undefined ? { nextOffset: number(root.nextOffset) } : {}),
  };
}

// ── Atividade ao vivo (eventos `agent` do Gateway) ──────────────────────────
// O Gateway transmite ferramentas/pensamento como eventos `agent` (streams
// "tool"/"thinking"); o chat delta só carrega texto. Sem isso, os blocos
// "Atividade técnica"/"Pensando" só aparecem quando o histórico persistido é
// rebuscado no fim da execução (ou num F5). Reempacamos como ChatMessage para
// reaproveitar a renderização do histórico, com ids `live-*` determinísticos
// (upsert por id no front; o loadHistory terminal substitui tudo pela versão
// persistida).
const LIVE_CONTENT_LIMIT = 16_000;
const LIVE_THINKING_LIMIT = 24_000;
const LIVE_ARGS_LIMIT = 6_000;

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n… (truncado)` : value;
}

function liveResultText(value: unknown): string {
  if (typeof value === "string") return truncate(value, LIVE_CONTENT_LIMIT);
  if (Array.isArray(value)) {
    const text = contentText(value);
    if (text) return truncate(text, LIVE_CONTENT_LIMIT);
  }
  const row = record(value);
  if (Object.keys(row).length === 0) return typeof value === "object" && value !== null ? "" : String(value ?? "");
  const content = row.content !== undefined ? contentText(row.content) : "";
  if (content) return truncate(content, LIVE_CONTENT_LIMIT);
  try { return truncate(JSON.stringify(value, null, 2) ?? "", LIVE_CONTENT_LIMIT); }
  catch { return ""; }
}

function liveArgsText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return truncate(value, LIVE_ARGS_LIMIT);
  try { return truncate(JSON.stringify(value, null, 2) ?? "", LIVE_ARGS_LIMIT); }
  catch { return ""; }
}

export function normalizeAgentEvent(frame: GatewayEventFrame): ChatActivityEvent | undefined {
  if (frame.event !== "agent") return undefined;
  const payload = record(frame.payload);
  const runId = text(payload.runId);
  const sessionKey = text(payload.sessionKey);
  const stream = text(payload.stream);
  const data = record(payload.data);
  if (!runId || !sessionKey) return undefined;
  const ts = timestamp(payload.ts) ?? Date.now();
  const agentId = text(payload.agentId);
  const seq = number(payload.seq) ?? frame.seq ?? 0;
  let message: ChatMessage | undefined;
  if (stream === "tool") {
    const phase = text(data.phase)?.toLowerCase();
    const name = text(data.name) ?? text(data.toolName) ?? "ferramenta";
    const toolCallId = text(data.toolCallId) ?? `${runId}:${seq}`;
    const id = `live-tool-${toolCallId}`;
    if (phase === "start") {
      const args = liveArgsText(data.args ?? data.input);
      message = { id, role: "tool", content: args ? `${name}\n${args}` : name, status: "requested", toolName: name, runId, createdAt: ts };
    } else if (phase === "update") {
      const partial = data.partialResult;
      if (partial === undefined) return undefined;
      message = { id, role: "tool", content: liveResultText(partial), status: "running", toolName: name, runId, createdAt: ts };
    } else if (phase === "result") {
      message = {
        id, role: "tool", content: liveResultText(data.result),
        status: bool(data.isError) ? "error" : "completed", toolName: name, runId, createdAt: ts,
      };
    }
  } else if (stream === "thinking") {
    const thinking = text(data.text);
    if (thinking) message = { id: `live-thinking-${runId}`, role: "assistant", content: "", thinking: truncate(thinking, LIVE_THINKING_LIMIT), runId, createdAt: ts };
  }
  if (!message) return undefined;
  const parsed = ChatActivityEventSchema.safeParse({
    runId, sessionKey, ...(agentId ? { agentId } : {}), seq, message,
  });
  return parsed.success ? parsed.data : undefined;
}

export function normalizeChatEvent(frame: GatewayEventFrame): ChatEvent | undefined {
  if (frame.event !== "chat") return undefined;
  const payload = record(frame.payload); const state = text(payload.state);
  if (!state || !["delta", "final", "aborted", "error"].includes(state)) return undefined;
  const message = payload.message === undefined ? undefined : normalizeMessage(payload.message);
  const candidate = {
    runId: text(payload.runId), sessionKey: text(payload.sessionKey), agentId: text(payload.agentId),
    seq: number(payload.seq) ?? frame.seq ?? 0, state,
    ...(message ? { message } : {}),
    ...(state === "delta" ? { deltaText: typeof payload.deltaText === "string" ? payload.deltaText : "", replace: bool(payload.replace) } : {}),
    ...(["final", "aborted", "error"].includes(state) ? { stopReason: text(payload.stopReason) } : {}),
    ...(["aborted", "error"].includes(state) ? { errorMessage: text(payload.errorMessage) } : {}),
    ...(state === "error" && ["refusal", "timeout", "rate_limit", "context_length", "unknown"].includes(String(payload.errorKind)) ? { errorKind: payload.errorKind } : {}),
  };
  const parsed = ChatEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
