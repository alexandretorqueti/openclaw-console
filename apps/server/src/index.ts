import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { z, ZodError, type ZodType } from "zod";
import {
  AgentContextFileNameSchema, AgentContextFilesResponseSchema,
  ChatAbortRequestSchema, ChatHistoryQuerySchema, ChatSendRequestSchema, CreateSessionRequestSchema,
  CreateAgentRequestSchema, DeleteAgentRequestSchema, DeleteSessionRequestSchema, ForkSessionRequestSchema, GatewayStatusSchema, PatchSessionRequestSchema,
  ModelsResponseSchema,
  NotificationItemSchema, NotificationsResponseSchema,
  SessionChangedEventSchema, SessionsQuerySchema,
  UpdateAgentContextFilesRequestSchema, UpdateAgentContextFilesResponseSchema, UpdateAgentRequestSchema,
  type GatewayStatus,
} from "@alexandretorqueti/openclaw-console-contracts";
import { GatewayClient, type GatewayConnectionStatus, type GatewayEventFrame } from "@alexandretorqueti/openclaw-gateway-client";
import { normalizeAgents, normalizeChatEvent, normalizeHistory, normalizeSessions, record } from "./normalizers.js";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";
import { ensureProjectsLink } from "./workspace-project-link.js";

const port = Number.parseInt(process.env.PORT ?? "47831", 10);
const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "ws://openclaw:18789";
const ollamaUrl = (process.env.OPENCLAW_OLLAMA_URL?.trim() || "http://127.0.0.1:11434").replace(/\/$/, "");
const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
if (!token) throw new Error("OPENCLAW_GATEWAY_TOKEN is required");
const defaultAgentWorkspaceRoot = process.env.OPENCLAW_AGENT_WORKSPACE_ROOT?.trim() || "/data/.openclaw";
const gatewayAgentWorkspaceRoot = process.env.OPENCLAW_GATEWAY_AGENT_WORKSPACE_ROOT?.trim() || "/data/workspace/projects/agentes";
const sharedProjectsPath = process.env.OPENCLAW_SHARED_PROJECTS_PATH?.trim() || "/data/workspace/projects";

const deviceIdentity = loadOrCreateDeviceIdentity(process.env.OPENCLAW_DEVICE_IDENTITY_PATH ?? "/data/state/device.json");
const startedAt = Date.now();
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: ["req.headers.authorization"],
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: typeof req.url === "string" ? req.url.replace(/([?&]token=)[^&\s]+/g, "$1***") : req.url,
          hostname: req.hostname,
        };
      },
    },
  },
});
const allowedCorsOrigin = (origin: string | undefined): boolean => {
  if (!origin) return false;
  if (origin === "https://ia.globaltecnologia.net") return true;
  if (origin === "https://openclaw-console.pages.dev") return true;
  if (origin.endsWith(".openclaw-console.pages.dev")) return true;
  if (origin === "https://openclaw-api.webconnect.com.br") return true;
  return false;
};
const buildCorsHeaders = (origin: string | undefined): Record<string, string> => {
  if (!allowedCorsOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin as string,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
};
app.addHook("onRequest", async (request, reply) => {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  for (const [key, value] of Object.entries(buildCorsHeaders(origin))) reply.header(key, value);
  if (request.method === "OPTIONS") { reply.code(204).send(); return; }
});
const consoleToken = process.env.OPENCLAW_CONSOLE_TOKEN?.trim();
if (!consoleToken) app.log.warn("OPENCLAW_CONSOLE_TOKEN is not set; /api endpoints are UNPROTECTED");
const extractConsoleToken = (request: FastifyRequest): string | undefined => {
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const query = request.query as Record<string, unknown>;
  if (typeof query.token === "string") return query.token.trim();
  return undefined;
};
app.addHook("onRequest", async (request, reply) => {
  const path = request.url.split("?")[0];
  if (!path.startsWith("/api/")) return;
  if (!consoleToken) return;
  if (extractConsoleToken(request) !== consoleToken) {
    reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid or missing access token" } });
    return;
  }
});
const gateway = new GatewayClient({
  url: gatewayUrl,
  token,
  clientVersion: "0.1.0",
  locale: "pt-BR",
  userAgent: "@alexandretorqueti/openclaw-console-server/0.1.0",
  reconnect: true,
  deviceIdentity,
  scopes: ["operator.read", "operator.write", "operator.admin"],
});
let gatewayError: string | undefined;
const sseClients = new Set<NodeJS.WritableStream>();

function gatewayReady() {
  const scopes = gateway.serverHello?.auth.scopes ?? [];
  return gateway.connected && (scopes.includes("operator.read") || scopes.includes("operator.write") || scopes.includes("operator.admin"));
}
function status(): GatewayStatus {
  const hello = gateway.serverHello;
  const state = gateway.connectionState;
  const normalizedState = state === "connected" ? "connected" : state === "connecting" ? "connecting" : state === "reconnecting" ? "reconnecting" : state === "stopped" ? "disconnected" : "disconnected";
  return GatewayStatusSchema.parse({
    connected: gatewayReady(),
    state: gatewayReady() ? "connected" : gateway.connected ? "error" : gatewayError ? "error" : normalizedState,
    gatewayUrl: redactGatewayUrl(gatewayUrl),
    version: hello?.server.version,
    protocol: hello?.protocol,
    connectionId: hello?.server.connId,
    canAdmin: hello?.auth.scopes.includes("operator.admin") ?? false,
    defaultAgentWorkspaceRoot,
    uptimeMs: Date.now() - startedAt,
    checkedAt: Date.now(),
    ...(!gatewayReady() ? { error: gatewayError ?? (gateway.connected ? "Gateway connected without required operator scopes; device approval is pending" : "Gateway disconnected") } : {}),
  });
}
function redactGatewayUrl(value: string) {
  try { const url = new URL(value); url.username = ""; url.password = ""; for (const key of [...url.searchParams.keys()]) if (/token|password|secret|key/i.test(key)) url.searchParams.set(key, "***"); return url.toString(); }
  catch { return "gateway"; }
}
function sse(event: "chat" | "status" | "sessions", data: unknown) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) { try { client.write(frame); } catch { sseClients.delete(client); } }
}

gateway.on("status", (_connection: GatewayConnectionStatus) => sse("status", status()));
gateway.on("connected", () => { gatewayError = undefined; sse("status", status()); void gateway.request("sessions.subscribe", {}).catch((error: unknown) => { app.log.warn({ err: error }, "failed to subscribe to session changes"); }); });
gateway.on("error", (error: Error) => { gatewayError = error.message; sse("status", status()); });
gateway.on("event", (frame: GatewayEventFrame) => {
  const event = normalizeChatEvent(frame); if (event) sse("chat", event);
  if (frame.event === "sessions.changed") {
    const payload = record(frame.payload);
    const hasSessionData = ["active", "hasActiveRun", "model", "modelProvider", "label", "displayName", "title", "sessionId", "updatedAt", "updatedAtMs", "contextTokens", "totalTokens", "unread", "lastReadAt", "lastActivityAt", "lastMessagePreview", "archived"].some((key) => key in payload);
    const normalized = hasSessionData ? normalizeSessions({ sessions: [payload] }).sessions[0] : undefined;
    const changed = SessionChangedEventSchema.safeParse({ sessionKey: typeof payload.sessionKey === "string" ? payload.sessionKey : typeof payload.key === "string" ? payload.key : undefined, agentId: typeof payload.agentId === "string" ? payload.agentId : undefined, reason: typeof payload.reason === "string" ? payload.reason : "changed", ...(normalized ? { session: normalized } : {}) });
    if (changed.success) sse("sessions", changed.data);
  }
});

function parse<T>(schema: ZodType<T>, value: unknown): T { return schema.parse(value); }
function rpc<T>(method: string, params?: unknown): Promise<T> { return gateway.request<T>(method, params); }
function mutation(raw: unknown, fallbackKey?: string) {
  const value = record(raw); const key = typeof value.key === "string" ? value.key : fallbackKey;
  if (!key) throw new Error("Gateway did not return a session key");
  return { ok: true as const, key, ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}), ...(typeof value.runStarted === "boolean" ? { runStarted: value.runStarted } : {}) };
}
function canonicalAgentId(sessionKey: string, fallback?: string) {
  if (!sessionKey.startsWith("agent:")) return fallback;
  return sessionKey.split(":")[1] || fallback;
}
async function ollamaModelSizes() {
  const sizes = new Map<string, number>();
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return sizes;
    const payload = record(await response.json());
    const models = Array.isArray(payload.models) ? payload.models : [];
    for (const value of models) {
      const model = record(value); const name = typeof model.name === "string" ? model.name : typeof model.model === "string" ? model.model : undefined;
      if (name && typeof model.size === "number" && Number.isFinite(model.size) && model.size >= 0) sizes.set(name.toLowerCase(), model.size);
    }
  } catch { /* O tamanho é opcional; o catálogo do Gateway continua disponível. */ }
  return sizes;
}

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid request", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) } });
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "INTERNAL_ERROR";
  const http = code === "UNAVAILABLE" ? 503 : code === "TIMEOUT" ? 504 : 500;
  app.log.error({ err: error, code }, "request failed");
  return reply.code(http).send({ error: { code, message: error instanceof Error ? error.message : String(error) } });
});

app.get("/healthz", async (_request, reply) => reply.code(gatewayReady() ? 200 : 503).send({ ok: gatewayReady() }));
app.get("/api/status", async () => status());
app.get("/api/agents", async () => normalizeAgents(await rpc("agents.list", {})));
app.get("/api/models", async () => {
  const [payloadRaw, ollamaSizes] = await Promise.all([rpc("models.list", { view: "configured" }), ollamaModelSizes()]);
  const payload = record(payloadRaw);
  const rows = Array.isArray(payload.models) ? payload.models : [];
  const models = rows.flatMap((value) => {
    const row = record(value);
    if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.provider !== "string") return [];
    const sizeBytes = row.provider.toLowerCase() === "ollama" ? ollamaSizes.get(row.id.toLowerCase()) : undefined;
    return [{ id: row.id, name: row.name, provider: row.provider, ...(typeof row.alias === "string" ? { alias: row.alias } : {}), ...(typeof row.available === "boolean" ? { available: row.available } : {}), ...(typeof row.contextWindow === "number" ? { contextWindow: row.contextWindow } : {}), ...(sizeBytes !== undefined ? { sizeBytes } : {}), ...(typeof row.reasoning === "boolean" ? { reasoning: row.reasoning } : {}) }];
  });
  return ModelsResponseSchema.parse({ models });
});
app.post("/api/agents", async (request) => {
  const body = parse(CreateAgentRequestSchema, request.body);
  const localRelative = relative(resolve(defaultAgentWorkspaceRoot), resolve(body.workspace));
  const gatewayRelative = relative(resolve(gatewayAgentWorkspaceRoot), resolve(body.workspace));
  if (localRelative !== "" && !localRelative.startsWith("..") && !isAbsolute(localRelative)) {
    await ensureProjectsLink({ workspace: body.workspace, workspaceRoot: defaultAgentWorkspaceRoot, projectsPath: sharedProjectsPath });
  } else if (gatewayRelative === "" || gatewayRelative.startsWith("..") || isAbsolute(gatewayRelative)) {
    throw Object.assign(new Error(`Agent workspace must be a descendant of ${gatewayAgentWorkspaceRoot}`), { code: "INVALID_WORKSPACE_PATH" });
  }
  const payload = record(await rpc("agents.create", body));
  return { ok: true as const, agentId: typeof payload.agentId === "string" ? payload.agentId : body.name };
});
app.patch("/api/agents", async (request) => { const body = parse(UpdateAgentRequestSchema, request.body); await rpc("agents.update", body); return { ok: true as const, agentId: body.agentId }; });
app.delete("/api/agents", async (request) => { const body = parse(DeleteAgentRequestSchema, request.body); if (body.agentId === "main") throw Object.assign(new Error('O agente "main" não pode ser excluído'), { code: "INVALID_REQUEST" }); const payload = record(await rpc("agents.delete", body)); return { ok: true as const, agentId: body.agentId, ...(typeof payload.removedBindings === "number" ? { removedBindings: payload.removedBindings } : {}) }; });
const AgentIdParamsSchema = z.object({ agentId: z.string().trim().min(1) }).strict();
app.get("/api/agents/:agentId/files", async (request) => {
  const { agentId } = parse(AgentIdParamsSchema, request.params);
  const listing = record(await rpc("agents.files.list", { agentId }));
  const workspace = typeof listing.workspace === "string" ? listing.workspace : undefined;
  const rows = Array.isArray(listing.files) ? listing.files : [];
  const files = await Promise.all(rows.map(async (value) => {
    const meta = record(value); const parsedName = AgentContextFileNameSchema.safeParse(meta.name);
    if (!parsedName.success) return undefined;
    if (meta.missing === true) return { name: parsedName.data, missing: true as const };
    const detail = record(await rpc("agents.files.get", { agentId, name: parsedName.data }));
    const file = record(detail.file);
    return { name: parsedName.data, missing: file.missing === true, ...(typeof file.size === "number" ? { size: file.size } : {}), ...(typeof file.updatedAtMs === "number" ? { updatedAtMs: file.updatedAtMs } : {}), ...(typeof file.content === "string" ? { content: file.content } : {}) };
  }));
  return AgentContextFilesResponseSchema.parse({ agentId, workspace, files: files.filter((file) => file !== undefined) });
});
app.put("/api/agents/:agentId/files", async (request) => {
  const { agentId } = parse(AgentIdParamsSchema, request.params);
  const body = parse(UpdateAgentContextFilesRequestSchema, { ...record(request.body), agentId });
  const written = [];
  let workspace = "";
  for (const file of body.files) {
    const result = record(await rpc("agents.files.set", { agentId, name: file.name, content: file.content }));
    workspace = typeof result.workspace === "string" ? result.workspace : workspace;
    const saved = record(result.file);
    written.push({ name: file.name, missing: false, ...(typeof saved.size === "number" ? { size: saved.size } : {}), ...(typeof saved.updatedAtMs === "number" ? { updatedAtMs: saved.updatedAtMs } : {}), content: file.content });
  }
  return UpdateAgentContextFilesResponseSchema.parse({ ok: true, agentId, workspace, files: written });
});
app.get("/api/sessions", async (request) => {
  const query = parse(SessionsQuerySchema, request.query);
  return normalizeSessions(await rpc("sessions.list", { ...query, configuredAgentsOnly: true, includeDerivedTitles: true, includeLastMessage: true }));
});
app.get("/api/notifications", async () => {
  const agents = normalizeAgents(await rpc("agents.list", {})).agents;
  const pages = await Promise.allSettled(agents.map((agent) => rpc("sessions.list", { agentId: agent.id, limit: 200, offset: 0, configuredAgentsOnly: true, includeDerivedTitles: true, includeLastMessage: true })));
  const notifications = [];
  for (let index = 0; index < agents.length; index += 1) {
    const agent = agents[index];
    const result = pages[index];
    if (!agent || result.status !== "fulfilled") continue;
    const normalized = normalizeSessions(result.value);
    for (const session of normalized.sessions) {
      if (session.archived) continue;
      const unread = session.unread === true || (session.lastReadAt === undefined && session.lastActivityAt !== undefined);
      if (!unread) continue;
      notifications.push(NotificationItemSchema.parse({ session, agent }));
    }
  }
  notifications.sort((a, b) => (b.session.lastActivityAt ?? b.session.updatedAt ?? 0) - (a.session.lastActivityAt ?? a.session.updatedAt ?? 0));
  return NotificationsResponseSchema.parse({ notifications });
});
app.get("/api/chat/history", async (request) => {
  const query = parse(ChatHistoryQuerySchema, request.query);
  const agentId = canonicalAgentId(query.sessionKey, query.agentId);
  const payload = await rpc("chat.history", { sessionKey: query.sessionKey, ...(agentId ? { agentId } : {}), limit: query.limit, offset: query.offset });
  return normalizeHistory(payload, query.sessionKey);
});
app.post("/api/chat/send", async (request) => {
  const body = parse(ChatSendRequestSchema, request.body);
  const payload = record(await rpc("chat.send", { ...body, agentId: canonicalAgentId(body.sessionKey, body.agentId), idempotencyKey: randomUUID() }));
  const runId = typeof payload.runId === "string" ? payload.runId : undefined;
  if (!runId) throw new Error("Gateway did not return a runId");
  return { runId, ...(typeof payload.status === "string" ? { status: payload.status } : {}) };
});
app.post("/api/chat/abort", async (request) => {
  const body = parse(ChatAbortRequestSchema, request.body);
  const payload = record(await rpc("chat.abort", { ...body, agentId: canonicalAgentId(body.sessionKey, body.agentId) }));
  const runIds = Array.isArray(payload.runIds) ? payload.runIds.filter((value): value is string => typeof value === "string") : undefined;
  return { ok: typeof payload.ok === "boolean" ? payload.ok : true, aborted: typeof payload.aborted === "boolean" ? payload.aborted : (runIds?.length ?? 0) > 0, ...(runIds ? { runIds } : {}) };
});
app.post("/api/sessions", async (request) => { const body = parse(CreateSessionRequestSchema, request.body); return mutation(await rpc("sessions.create", body), body.key); });
app.post("/api/sessions/fork", async (request) => { const body = parse(ForkSessionRequestSchema, request.body); return mutation(await rpc("sessions.create", { ...body, agentId: canonicalAgentId(body.parentSessionKey, body.agentId), fork: true }), body.key); });
app.patch("/api/sessions", async (request) => { const body = parse(PatchSessionRequestSchema, request.body); return mutation(await rpc("sessions.patch", { ...body, agentId: canonicalAgentId(body.key, body.agentId) }), body.key); });
app.delete("/api/sessions", async (request) => {
  const body = parse(DeleteSessionRequestSchema, request.body);
  const agentId = canonicalAgentId(body.key, body.agentId);
  await rpc("sessions.patch", { key: body.key, ...(agentId ? { agentId } : {}), archived: true });
  const payload = record(await rpc("sessions.delete", { key: body.key, ...(agentId ? { agentId } : {}), archivedOnly: true, deleteTranscript: true }));
  return { ok: true as const, key: typeof payload.key === "string" ? payload.key : body.key, deleted: payload.deleted === true, ...(Array.isArray(payload.archived) ? { archived: payload.archived.filter((value): value is string => typeof value === "string") } : {}) };
});
app.get("/api/events", async (request: FastifyRequest, reply: FastifyReply) => {
  reply.hijack();
  const sseOrigin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", ...buildCorsHeaders(sseOrigin) });
  sseClients.add(reply.raw); reply.raw.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
  const heartbeat = setInterval(() => { try { reply.raw.write(": keepalive\n\n"); } catch { clearInterval(heartbeat); } }, 15_000);
  request.raw.on("close", () => { clearInterval(heartbeat); sseClients.delete(reply.raw); });
});

const webRoot = process.env.CONSOLE_WEB_DIST ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } }) : reply.sendFile("index.html"));

await app.listen({ host: "0.0.0.0", port });
void gateway.start().catch((error: unknown) => { gatewayError = error instanceof Error ? error.message : String(error); app.log.error({ err: error }, "initial Gateway connection failed; reconnect remains enabled"); });

async function shutdown(signal: string) { app.log.info({ signal }, "shutting down"); gateway.stop(); for (const client of sseClients) try { client.end(); } catch { /* noop */ } await app.close(); process.exit(0); }
process.on("SIGTERM", () => void shutdown("SIGTERM")); process.on("SIGINT", () => void shutdown("SIGINT"));
