// Carregamento de modelos locais via checkbox VRAM do console.
//
// O Gateway não aceita num_gpu dentro de chat.send (o schema de chat.send é
// fechado), e o provedor Ollama do OpenClaw lê runtime params somente da
// config do modelo: agents.defaults.models["ollama/<id>"].params.num_gpu é
// mesclado na entrada do catálogo e injetado como options.num_gpu no JSON da
// requisição /api/chat. Portanto o checkbox fixa num_gpu: 0 na config do
// Gateway (hot-reload, sem restart do Gateway — prefixo `agents.defaults.models`
// é classificado como "hot" no plano de reload) quando desmarcado: o Ollama
// passa a carregar o modelo na RAM quando ele ainda não estiver carregado.
// Quando marcado, o fixo é removido e o carregamento volta ao padrão (VRAM).

/** Ref de modelo Ollama no formato `ollama/<id>`; outros provedores retornam undefined. */
export function ollamaModelRef(modelRef: string | undefined): string | undefined {
  if (!modelRef) return undefined;
  const ref = modelRef.trim();
  return /^ollama\/\S+$/.test(ref) ? ref : undefined;
}

function dig(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Lê `agents.defaults.models[<ref>].params.num_gpu` (number finito) da config. */
export function readNumGpu(config: unknown, modelRef: string): number | undefined {
  const entry = dig(config, ["agents", "defaults", "models", modelRef]);
  const raw = dig(entry, ["params", "num_gpu"]);
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** Idempotência: só escreve config quando o valor efetivamente mudaria. */
export function shouldApplyVramPatch(currentNumGpu: number | undefined, vram: boolean): boolean {
  return vram ? currentNumGpu !== undefined : currentNumGpu !== 0;
}

/**
 * Patch de merge do config.patch: desmarcado fixa num_gpu=0; marcado apaga
 * somente a chave num_gpu (null remove a chave), preservando os outros params
 * do modelo (temperature, num_ctx, ...) definidos pelo operador.
 */
export function buildVramPatch(modelRef: string, vram: boolean): string {
  return JSON.stringify({
    agents: { defaults: { models: { [modelRef]: { params: { num_gpu: vram ? null : 0 } } } } },
  });
}
