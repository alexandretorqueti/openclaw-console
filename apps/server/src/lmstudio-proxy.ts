import type { FastifyInstance } from "fastify";

// Proxy canônico Gateway → LM Studio (pedido do Alexandre, 2026-11-28).
//
// Problema: tarefas iniciadas fora do console (motores, cron, outros canais)
// passam direto pelo Gateway, cujo preload chama POST /api/v1/models/load com
// timeout FIXO de 30s (insuficiente para modelos de 30GB) e context_length
// reduzido (default 64k); na falha, o JIT do LM Studio não despeja modelos
// carregados pela GUI e o run morre com "Failed to load model".
//
// Solução: apontar o baseUrl do provider lmstudio no OpenClaw para este proxy
// (http://host.docker.internal:6280/lmstudio/v1). Aqui o tráfego inteiro —
// chat do console, tarefas, qualquer agente — vira caminho canônico único:
//   - POST /api/v1/models/load  → ensure() completo (carga com a config salva
//     = contexto CHEIO, sem reduzir; evicção de ociosos se faltar memória; o
//     LM Studio já divide o modelo entre as GPUs automaticamente). Responde
//     {status:"loaded"} no formato que o Gateway espera. O timeout de 30s do
//     Gateway deixa de importar: a carga continua serializada na fila do
//     manager e o completions seguinte espera por ela.
//   - POST /v1/chat/completions (e completions/embeddings/responses) →
//     ensure() antes de repassar; depois, streaming transparente (SSE sem
//     buffer, via hijack + pipe).
//   - Qualquer outra rota → passthrough transparente (descoberta de modelos,
//     etc.).
//
// Segurança: exige Bearer token (OPENCLAW_LMSTUDIO_PROXY_TOKEN, ou o
// OPENCLAW_LMSTUDIO_API_KEY como fallback — o Gateway envia o apiKey do
// provider). O token NUNCA é repassado ao alvo. O prefixo fica exposto no
// túnel público junto com o resto da API — por isso o gate é obrigatório.

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

const ENSURE_SUFFIXES = ["/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/responses"];

/** Bearer (ou token cru) confere com algum token aceito? */
export function isProxyAuthorized(header: unknown, tokens: string[]): boolean {
  if (typeof header !== "string" || tokens.length === 0) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = (match ? match[1] : header).trim();
  return token.length > 0 && tokens.some((candidate) => candidate === token);
}

/** "/lmstudio/v1/chat/completions?x=1" → "/v1/chat/completions?x=1" */
export function stripProxyPrefix(url: string, prefix: string): string {
  if (!url.startsWith(prefix)) return url;
  const rest = url.slice(prefix.length);
  return rest === "" || rest.startsWith("/") ? rest || "/" : `/${rest}`;
}

export type ProxyAction = "load" | "ensure" | "passthrough";

/** O que fazer com a requisição, pelo método + pathname (sem query). */
export function proxyAction(method: string, pathname: string): ProxyAction {
  if (method !== "POST") return "passthrough";
  const clean = pathname.replace(/\/+$/, "");
  if (clean === "/api/v1/models/load" || clean === "/api/v0/lms/load") return "load";
  return ENSURE_SUFFIXES.some((suffix) => clean.endsWith(suffix)) ? "ensure" : "passthrough";
}

/** Campo `model` do payload OpenAI-compatível / load do LM Studio. */
export function modelFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>).model;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** URL final no alvo, preservando path + query. */
export function proxyTarget(targetUrl: string, path: string): string {
  const base = targetUrl.endsWith("/") ? targetUrl : `${targetUrl}/`;
  return new URL(path, base).toString();
}

export interface LmstudioProxyLog {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface LmstudioProxyDeps {
  /** Prefixo das rotas (ex.: "/lmstudio"). */
  prefix: string;
  /** Alvo (ex.: "http://127.0.0.1:12360"). */
  targetUrl: string;
  /** Tokens aceitos no Authorization. */
  tokens: string[];
  /** Garante o modelo carregado (mesma fila serializada do chat do console). */
  ensure: (modelId: string) => Promise<void>;
  /** O modelo existe no catálogo local? (desconhecidos → passthrough puro) */
  hasModel: (modelId: string) => Promise<boolean>;
  log: LmstudioProxyLog;
}

export async function registerLmstudioProxy(app: FastifyInstance, deps: LmstudioProxyDeps): Promise<void> {
  app.all(`${deps.prefix}/*`, { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    const authorized = isProxyAuthorized(request.headers.authorization, deps.tokens);
    // Diagnóstico (incidente 2026-11-28: 401 intermitente com header correto):
    // fingerprint sem segredo — comprimento e prefixo do header recebido e
    // tamanhos dos tokens aceitos.
    const authHeader = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
    deps.log.info({
      method: request.method,
      path: request.url.split("?")[0],
      authLen: authHeader.length,
      authPrefix: authHeader.slice(0, 7),
      headerKeys: Object.keys(request.headers).length,
      tokenLens: deps.tokens.map((value) => value.length),
      authorized,
      remote: request.socket?.remoteAddress,
    }, "lmstudio-proxy: auth check");
    if (!authorized) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "token inválido para o proxy do LM Studio" } });
    }
    const path = stripProxyPrefix(request.url, deps.prefix);
    const pathname = path.split("?")[0];
    const action = proxyAction(request.method, pathname);
    const bodyModel = modelFromBody(request.body);

    if (action === "load") {
      if (!bodyModel) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "campo 'model' é obrigatório" } });
      try {
        // Contexto cheio da config salva do LM Studio — de propósito IGNORA o
        // context_length do Gateway (default 64k reduziria o contexto).
        await deps.ensure(bodyModel);
        deps.log.info({ model: bodyModel, via: "gateway-preload" }, "lmstudio-proxy: modelo pronto");
        return { status: "loaded", model: bodyModel };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log.warn({ model: bodyModel, err: error }, "lmstudio-proxy: ensure falhou no preload");
        return reply.code(503).send({ error: { code: "UNAVAILABLE", message } });
      }
    }

    if (action === "ensure" && bodyModel && (await deps.hasModel(bodyModel))) {
      try {
        await deps.ensure(bodyModel);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log.warn({ model: bodyModel, err: error }, "lmstudio-proxy: ensure falhou antes da inferência");
        return reply.code(503).send({ error: { code: "UNAVAILABLE", message } });
      }
    }

    // Passthrough (com ou sem ensure prévio).
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === "host" || lower === "authorization" || lower === "content-length") continue;
      if (typeof value === "string") headers[key] = value;
    }
    const init: { method: string; headers: Record<string, string>; body?: string } = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined && request.body !== null) {
      init.body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      headers["content-type"] = headers["content-type"] ?? "application/json";
    }

    const abort = new AbortController();
    request.raw.on("close", () => abort.abort());

    let upstream: Response;
    try {
      upstream = await fetch(proxyTarget(deps.targetUrl, path), { ...init, signal: abort.signal });
    } catch (error: unknown) {
      deps.log.warn({ err: error, pathname }, "lmstudio-proxy: alvo inacessível");
      return reply.code(502).send({ error: { code: "UPSTREAM_ERROR", message: "LM Studio inacessível" } });
    }

    // Streaming transparente (SSE): hijack + pipe manual, sem bufferizar.
    reply.hijack();
    const raw = reply.raw;
    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
    });
    raw.writeHead(upstream.status, outHeaders);
    try {
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!raw.write(value)) await new Promise<void>((resolve) => raw.once("drain", resolve));
        }
      }
    } catch {
      // cliente desconectou / stream interrompido — sem ação
    } finally {
      raw.end();
    }
  });
}
