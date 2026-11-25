import assert from "node:assert/strict";
import test from "node:test";
import { buildVramPatch, ollamaModelRef, readNumGpu, shouldApplyVramPatch } from "./vram.js";

test("ollamaModelRef only matches local Ollama models", () => {
  assert.equal(ollamaModelRef("ollama/qwen3.8:27b"), "ollama/qwen3.8:27b");
  assert.equal(ollamaModelRef("  ollama/x  "), "ollama/x");
  assert.equal(ollamaModelRef("openai/gpt-5.6"), undefined);
  assert.equal(ollamaModelRef("qwen3.8:27b"), undefined);
  assert.equal(ollamaModelRef(undefined), undefined);
});

test("readNumGpu extracts the pinned value from the config, if valid", () => {
  const config = { agents: { defaults: { models: { "ollama/x": { params: { num_gpu: 0, temperature: 0.7 } } } } } };
  assert.equal(readNumGpu(config, "ollama/x"), 0);
  assert.equal(readNumGpu(config, "ollama/y"), undefined);
  assert.equal(readNumGpu(undefined, "ollama/x"), undefined);
  assert.equal(readNumGpu({ agents: { defaults: { models: { "ollama/x": { params: { num_gpu: "muitos" } } } } } }, "ollama/x"), undefined);
});

test("shouldApplyVramPatch avoids redundant config writes", () => {
  assert.equal(shouldApplyVramPatch(0, false), false); // RAM já fixada
  assert.equal(shouldApplyVramPatch(undefined, true), false); // padrão VRAM já vigente
  assert.equal(shouldApplyVramPatch(undefined, false), true); // precisa fixar num_gpu=0
  assert.equal(shouldApplyVramPatch(0, true), true); // precisa remover o fixo
  assert.equal(shouldApplyVramPatch(99, true), true); // num_gpu estranho: limpa ao reativar VRAM
  assert.equal(shouldApplyVramPatch(99, false), true); // desmarcado exige 0
});

test("buildVramPatch touches only num_gpu, preserving other model params", () => {
  assert.deepEqual(JSON.parse(buildVramPatch("ollama/x", false)), {
    agents: { defaults: { models: { "ollama/x": { params: { num_gpu: 0 } } } } },
  });
  assert.deepEqual(JSON.parse(buildVramPatch("ollama/x", true)), {
    agents: { defaults: { models: { "ollama/x": { params: { num_gpu: null } } } } },
  });
});
