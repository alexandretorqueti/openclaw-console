import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceQueue, createVoiceWarmer, isPhononModel, pickSummaryModel } from "./voice.js";

test("prefers the largest loaded model for summaries to avoid load/eviction", () => {
  const loaded = [
    { id: "phonon-40m-multilingual", state: "loaded", type: "llm" },
    { id: "qwen/qwen3.8-27b", state: "loaded", type: "vlm", quantization: "Q4_K_M" },
    { id: "qwen3.5-4b", state: "not-loaded", type: "vlm", quantization: "Q8_0" },
  ];
  assert.equal(pickSummaryModel(loaded, "gemma-2-9b-it"), "qwen/qwen3.8-27b");
});

test("prefers the bigger model (size in id) even when the smaller one has more quantization bits", () => {
  const loaded = [
    { id: "qwen3.5-4b", state: "loaded", type: "vlm", quantization: "Q8_0" },
    { id: "qwen/qwen3.8-27b", state: "loaded", type: "vlm", quantization: "Q4_K_M" },
  ];
  assert.equal(pickSummaryModel(loaded, "gemma-2-9b-it"), "qwen/qwen3.8-27b");
});

test("falls back to the configured small model when nothing usable is loaded", () => {
  assert.equal(pickSummaryModel([{ id: "qwen3.5-4b", state: "not-loaded", type: "vlm" }], "gemma-2-9b-it"), "gemma-2-9b-it");
  assert.equal(pickSummaryModel([], "gemma-2-9b-it"), "gemma-2-9b-it");
  assert.equal(pickSummaryModel([{ id: "phonon-40m-multilingual", state: "loaded", type: "llm" }], "gemma-2-9b-it"), "gemma-2-9b-it");
});

test("never picks phonon or embeddings as a summary model", () => {
  const loaded = [
    { id: "phonon-40m-multilingual", state: "loaded", type: "llm" },
    { id: "text-embedding-bge-m3", state: "loaded", type: "embeddings", quantization: "FP16" },
  ];
  assert.equal(pickSummaryModel(loaded, "gemma-2-9b-it"), "gemma-2-9b-it");
});

test("prefers higher quantization when sizes are equal", () => {
  const loaded = [
    { id: "qwen3.8-flash-next@q4_k_xl", state: "loaded", type: "vlm", quantization: "Q4_K_XL" },
    { id: "qwen3.8-flash-next@q8_0", state: "loaded", type: "vlm", quantization: "Q8_0" },
  ];
  assert.equal(pickSummaryModel(loaded, "gemma-2-9b-it"), "qwen3.8-flash-next@q8_0");
});

test("isPhononModel is case-insensitive", () => {
  assert.equal(isPhononModel("Phonon:40m-pt"), true);
  assert.equal(isPhononModel("qwen3:8b"), false);
});

test("voice queue serializes tasks", async () => {
  const queue = createVoiceQueue();
  const events: string[] = [];
  const slow = queue.enqueue(async () => {
    events.push("slow:start");
    await new Promise((done) => setTimeout(done, 30));
    events.push("slow:end");
  });
  const fast = queue.enqueue(async () => { events.push("fast"); return 42; });
  assert.equal(await fast, 42);
  await slow;
  assert.deepEqual(events, ["slow:start", "slow:end", "fast"]);
});

test("voice queue survives failures", async () => {
  const queue = createVoiceQueue();
  await assert.rejects(queue.enqueue(async () => { throw new Error("boom"); }));
  assert.equal(await queue.enqueue(async () => "ok"), "ok");
});

test("voice warmer warms immediately and re-warms until validity expires", async () => {
  let nowMs = 1_000;
  let ticks: (() => void) | undefined;
  let warmed = 0;
  const warmer = createVoiceWarmer({
    warm: async () => { warmed += 1; },
    intervalMs: 4_000,
    validityMs: 10_000,
    setIntervalFn: (fn) => { ticks = fn; return 7 as unknown as ReturnType<typeof setInterval>; },
    clearIntervalFn: () => { ticks = undefined; },
    now: () => nowMs,
  });
  await warmer.start();
  assert.equal(warmed, 1);
  nowMs += 4_000; ticks?.(); await new Promise((done) => setImmediate(done));
  nowMs += 4_000; ticks?.(); await new Promise((done) => setImmediate(done));
  assert.equal(warmed, 3);
  nowMs += 4_000; ticks?.(); await new Promise((done) => setImmediate(done)); // validade expirou (13_000 > 11_000): para de aquecer
  assert.equal(warmed, 3);
  assert.equal(ticks, undefined);
});

test("voice warmer keeps going when warm fails", async () => {
  let fails = 0;
  let ticks: (() => void) | undefined;
  const warmer = createVoiceWarmer({
    warm: async () => { fails += 1; throw new Error("server local ocupado"); },
    intervalMs: 1_000,
    setIntervalFn: (fn) => { ticks = fn; return 1 as unknown as ReturnType<typeof setInterval>; },
    clearIntervalFn: () => {},
  });
  await warmer.start();
  assert.equal(fails, 1);
  ticks?.();
  assert.equal(fails, 2);
  warmer.stop();
});
