import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import Fastify from "fastify";
import { isProxyAuthorized, modelFromBody, proxyAction, proxyTarget, registerLmstudioProxy, stripProxyPrefix } from "./lmstudio-proxy.js";

test("isProxyAuthorized aceita Bearer e token cru, rejeita o resto", () => {
  assert.equal(isProxyAuthorized("Bearer tok123", ["tok123"]), true);
  assert.equal(isProxyAuthorized("bearer tok123", ["tok123"]), true);
  assert.equal(isProxyAuthorized("tok123", ["tok123"]), true);
  assert.equal(isProxyAuthorized("Bearer errado", ["tok123"]), false);
  assert.equal(isProxyAuthorized(undefined, ["tok123"]), false);
  assert.equal(isProxyAuthorized("Bearer tok123", []), false);
});

test("stripProxyPrefix remove só o prefixo e preserva a query", () => {
  assert.equal(stripProxyPrefix("/lmstudio/v1/chat/completions?x=1", "/lmstudio"), "/v1/chat/completions?x=1");
  assert.equal(stripProxyPrefix("/lmstudio", "/lmstudio"), "/");
  assert.equal(stripProxyPrefix("/api/v1/models", "/lmstudio"), "/api/v1/models");
});

test("proxyAction classifica load/ensure/passthrough", () => {
  assert.equal(proxyAction("POST", "/api/v1/models/load"), "load");
  assert.equal(proxyAction("POST", "/v1/chat/completions"), "ensure");
  assert.equal(proxyAction("POST", "/v1/embeddings"), "ensure");
  assert.equal(proxyAction("POST", "/v1/responses"), "ensure");
  assert.equal(proxyAction("POST", "/api/v1/models/unload"), "passthrough");
  assert.equal(proxyAction("GET", "/api/v1/models"), "passthrough");
  assert.equal(proxyAction("GET", "/v1/chat/completions"), "passthrough");
});

test("modelFromBody extrai o campo model", () => {
  assert.equal(modelFromBody({ model: " m1 " }), "m1");
  assert.equal(modelFromBody({ model: 42 }), undefined);
  assert.equal(modelFromBody(undefined), undefined);
});

test("proxyTarget preserva path e query", () => {
  assert.equal(proxyTarget("http://127.0.0.1:12360", "/v1/models?x=1"), "http://127.0.0.1:12360/v1/models?x=1");
  assert.equal(proxyTarget("http://127.0.0.1:12360/", "/v1/models"), "http://127.0.0.1:12360/v1/models");
});

interface Harness {
  app: ReturnType<typeof Fastify>;
  ensured: string[];
  failEnsure: boolean;
  upstreamHits: { method: string; url: string }[];
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const hits: { method: string; url: string }[] = [];
  const upstream: Server = createServer((req, res) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "" });
    req.resume();
    if ((req.url ?? "").startsWith("/v1/chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: ola\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echo: req.url }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const app = Fastify();
  const ensured: string[] = [];
  const harness: Harness = {
    app,
    ensured,
    failEnsure: false,
    upstreamHits: hits,
    close: async () => {
      await app.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
  await registerLmstudioProxy(app, {
    prefix: "/lmstudio",
    targetUrl: `http://127.0.0.1:${port}`,
    tokens: ["tok123"],
    ensure: async (modelId) => {
      if (harness.failEnsure) throw Object.assign(new Error("recursos insuficientes"), { code: "UNAVAILABLE" });
      ensured.push(modelId);
    },
    hasModel: async (modelId) => modelId !== "desconhecido",
    log: { info: () => {}, warn: () => {} },
  });
  await app.ready();
  return harness;
}

test("proxy: sem token → 401", async () => {
  const h = await startHarness();
  try {
    const response = await h.app.inject({ method: "POST", url: "/lmstudio/api/v1/models/load", payload: { model: "m1" } });
    assert.equal(response.statusCode, 401);
    assert.equal(h.upstreamHits.length, 0);
  } finally { await h.close(); }
});

test("proxy: load do Gateway → ensure e resposta {status:loaded} sem tocar o alvo", async () => {
  const h = await startHarness();
  try {
    const response = await h.app.inject({
      method: "POST",
      url: "/lmstudio/api/v1/models/load",
      headers: { authorization: "Bearer tok123" },
      payload: { model: "m1", context_length: 64000 },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "loaded", model: "m1" });
    assert.deepEqual(h.ensured, ["m1"]);
    assert.equal(h.upstreamHits.length, 0);
  } finally { await h.close(); }
});

test("proxy: completions garante o modelo e repassa o SSE do alvo", async () => {
  const h = await startHarness();
  try {
    const response = await h.app.inject({
      method: "POST",
      url: "/lmstudio/v1/chat/completions",
      headers: { authorization: "Bearer tok123" },
      payload: { model: "m1", messages: [] },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /data: ola/);
    assert.deepEqual(h.ensured, ["m1"]);
    assert.deepEqual(h.upstreamHits, [{ method: "POST", url: "/v1/chat/completions" }]);
  } finally { await h.close(); }
});

test("proxy: modelo fora do catálogo → passthrough sem ensure", async () => {
  const h = await startHarness();
  try {
    const response = await h.app.inject({
      method: "POST",
      url: "/lmstudio/v1/chat/completions",
      headers: { authorization: "Bearer tok123" },
      payload: { model: "desconhecido", messages: [] },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(h.ensured, []);
  } finally { await h.close(); }
});

test("proxy: GET de descoberta passa adiante com a query", async () => {
  const h = await startHarness();
  try {
    const response = await h.app.inject({
      method: "GET",
      url: "/lmstudio/api/v1/models?x=1",
      headers: { authorization: "Bearer tok123" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(h.upstreamHits, [{ method: "GET", url: "/api/v1/models?x=1" }]);
  } finally { await h.close(); }
});

test("proxy: ensure com falha → 503 claro (load e completions)", async () => {
  const h = await startHarness();
  h.failEnsure = true;
  try {
    const load = await h.app.inject({
      method: "POST",
      url: "/lmstudio/api/v1/models/load",
      headers: { authorization: "Bearer tok123" },
      payload: { model: "m1" },
    });
    assert.equal(load.statusCode, 503);
    assert.match(load.body, /recursos insuficientes/);
    const chat = await h.app.inject({
      method: "POST",
      url: "/lmstudio/v1/chat/completions",
      headers: { authorization: "Bearer tok123" },
      payload: { model: "m1", messages: [] },
    });
    assert.equal(chat.statusCode, 503);
    assert.equal(h.upstreamHits.length, 0);
  } finally { await h.close(); }
});
