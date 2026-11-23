import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceQueue, createVoiceWarmer, isPhononModel, pickSummaryModel } from "./voice.js";

test("picks the resident large model for summaries to avoid eviction", () => {
  const loaded = [
    { name: "phonon:40m-pt", sizeVramBytes: 170_000_000 },
    { name: "qwen3.8-flash-next:125b-a6b-q8_0", sizeVramBytes: 34_500_000_000 },
  ];
  assert.equal(pickSummaryModel(loaded, "qwen3:8b"), "qwen3.8-flash-next:125b-a6b-q8_0");
});

test("falls back to the small model when nothing large is resident", () => {
  assert.equal(pickSummaryModel([{ name: "phonon:pt", sizeVramBytes: 170_000_000 }], "qwen3:8b"), "qwen3:8b");
  assert.equal(pickSummaryModel([], "qwen3:8b"), "qwen3:8b");
});

test("never picks phonon as a summary model", () => {
  assert.equal(pickSummaryModel([{ name: "phonon:40m-multilingual", sizeVramBytes: 400_000_000_000 }], "qwen3:8b"), "qwen3:8b");
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
    warm: async () => { fails += 1; throw new Error("ollama ocupado"); },
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
