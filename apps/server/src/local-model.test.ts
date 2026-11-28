import assert from "node:assert/strict";
import test from "node:test";
import { isLmsInfraFailure, lmsInfoFileCandidates, localModelIdFromRef, parseLmsPs, pickUnloadCandidates, type LoadedLocalModel } from "./local-model.js";

test("lmsInfoFileCandidates deriva do HOME que contém .lmstudio (bionic primeiro)", () => {
  assert.deepEqual(lmsInfoFileCandidates("/home/node"), [
    "/home/node/.lmstudio/apps/bionic/.internal/http-server.json",
    "/home/node/.lmstudio/.internal/http-server.json",
  ]);
});

test("isLmsInfraFailure distingue falha de descoberta de falta de recursos", () => {
  assert.equal(isLmsInfraFailure("Error: No running LM Studio or Bionic app, and no valid installation was found."), true);
  assert.equal(isLmsInfraFailure("Error: Failed to start or connect to a local LM Studio or Bionic API server."), true);
  assert.equal(isLmsInfraFailure("Insufficient resources to load model"), false);
  assert.equal(isLmsInfraFailure("Model not found"), false);
  assert.equal(isLmsInfraFailure(""), false);
});

test("localModelIdFromRef só aceita providers locais", () => {
  assert.equal(localModelIdFromRef("lmstudio/qwen3.8-flash-next@q4_k_xl"), "qwen3.8-flash-next@q4_k_xl");
  assert.equal(localModelIdFromRef(" lmstudio/qwen/qwen3.8-27b "), "qwen/qwen3.8-27b");
  assert.equal(localModelIdFromRef("openai/gpt-5.6"), undefined);
  assert.equal(localModelIdFromRef("ollama/qwen3:8b"), undefined); // ollama tem caminho próprio (vram.ts)
  assert.equal(localModelIdFromRef("qwen3.8-27b"), undefined); // sem provider
  assert.equal(localModelIdFromRef("lmstudio/"), undefined);
  assert.equal(localModelIdFromRef(undefined), undefined);
  assert.equal(localModelIdFromRef("LMSTUDIO/x", ["lmstudio"]), "x"); // case-insensitive no provider
});

const modelo = (overrides: Partial<LoadedLocalModel> = {}): LoadedLocalModel => ({
  identifier: "modelo-a",
  modelKey: "modelo-a",
  status: "idle",
  sizeBytes: 1_000,
  lastUsedTime: null,
  ...overrides,
});

test("parseLmsPs tolera lixo e normaliza campos", () => {
  assert.deepEqual(parseLmsPs(undefined), []);
  assert.deepEqual(parseLmsPs("não é array"), []);
  const parsed = parseLmsPs([
    null,
    { identifier: "" },
    { identifier: "a", modelKey: "k", status: " GENERATING ", sizeBytes: 10, lastUsedTime: 5 },
    { identifier: "b" }, // sem status/size → defaults
  ]);
  assert.deepEqual(parsed, [
    { identifier: "a", modelKey: "k", status: "generating", sizeBytes: 10, lastUsedTime: 5 },
    { identifier: "b", modelKey: "b", status: "", sizeBytes: 0, lastUsedTime: null },
  ]);
});

const baseOptions = {
  targetId: "alvo",
  protectedIds: new Set(["protegido"]),
  recentlyTouched: new Map<string, number>(),
  recentUseWindowMs: 90_000,
  now: 1_000_000,
};

test("pickUnloadCandidates exclui generating, alvo, protegidos e usados recentemente", () => {
  const models = [
    modelo({ identifier: "gerando", status: "generating" }),
    modelo({ identifier: "alvo" }),
    modelo({ identifier: "ALVO", modelKey: "outro" }), // alvo case-insensitive (via modelKey tb)
    modelo({ identifier: "protegido" }),
    modelo({ identifier: "protegido-key", modelKey: "PROTEGIDO" }), // protegido via modelKey
    modelo({ identifier: "recente" }),
    modelo({ identifier: "ocioso" }),
  ];
  const candidates = pickUnloadCandidates(models, {
    ...baseOptions,
    recentlyTouched: new Map([["recente", baseOptions.now - 10_000]]),
  });
  assert.deepEqual(candidates.map((model) => model.identifier), ["ocioso"]);
});

test("pickUnloadCandidates ordena por LRU e depois por tamanho", () => {
  const models = [
    modelo({ identifier: "usado-ha-pouco", lastUsedTime: 900_000, sizeBytes: 5 }),
    modelo({ identifier: "nunca-usado-grande", lastUsedTime: null, sizeBytes: 9_999 }),
    modelo({ identifier: "nunca-usado-pequeno", lastUsedTime: null, sizeBytes: 10 }),
    modelo({ identifier: "usado-ha-muito", lastUsedTime: 100_000, sizeBytes: 1 }),
  ];
  const candidates = pickUnloadCandidates(models, baseOptions);
  assert.deepEqual(candidates.map((model) => model.identifier), [
    "nunca-usado-grande", // null vira 0 (mais antigo); desempate por tamanho desc
    "nunca-usado-pequeno",
    "usado-ha-muito",
    "usado-ha-pouco",
  ]);
});

test("janela de uso recente protege modelo tocado há pouco e libera após expirar", () => {
  const models = [modelo({ identifier: "tocado" })];
  const protegido = pickUnloadCandidates(models, {
    ...baseOptions,
    recentlyTouched: new Map([["tocado", baseOptions.now - 30_000]]),
  });
  assert.deepEqual(protegido, []);
  const liberado = pickUnloadCandidates(models, {
    ...baseOptions,
    recentlyTouched: new Map([["tocado", baseOptions.now - 120_000]]),
  });
  assert.equal(liberado.length, 1);
});
