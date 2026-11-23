// Ordenador de voz do console (probes de 2026-11-23 no Ollama do ServerIA):
// - phonon usa ~0,17 GB de VRAM e CONVIVE com o modelo grande (sem evicção);
// - o ping-pong de evicção vinha do qwen3:8b (5,2 GB) do resumo → resumir com o
//   modelo já residente elimina a carga;
// - keep_alive no /v1/audio/speech é ignorado (expira ~5 min) → reaquecer a cada 4 min.

export type OllamaLoadedModel = { name: string; sizeVramBytes: number };

export function isPhononModel(name: string): boolean {
  return name.toLowerCase().includes("phonon");
}

// Resumo: usa o modelo grande já residente (>1 GB de VRAM, não-phonon); se nada
// residente, cai no modelo pequeno configurado (fallback).
export function pickSummaryModel(loaded: OllamaLoadedModel[], fallback: string): string {
  const resident = loaded
    .filter((model) => !isPhononModel(model.name) && model.sizeVramBytes > 1_000_000_000)
    .sort((a, b) => b.sizeVramBytes - a.sizeVramBytes)[0];
  return resident?.name ?? fallback;
}

// Fila serial: um trabalho de voz por vez (resumo/fala/aquecimento), evitando que
// cliques simultâneos disputem o Ollama entre si.
export function createVoiceQueue(): { enqueue: <T>(task: () => Promise<T>) => Promise<T> } {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

// Reaquecimento do phonon: o Ollama expira o modelo em ~5 min, então o timer roda
// a cada intervalo (default 4 min) e se autodeativa após o período de validade
// (default 30 min) — rearme a cada novo pedido de aquecimento.
export function createVoiceWarmer(options: {
  warm: () => Promise<void>;
  intervalMs?: number;
  validityMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
  now?: () => number;
}) {
  const intervalMs = options.intervalMs ?? 4 * 60_000;
  const validityMs = options.validityMs ?? 30 * 60_000;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | undefined;
  let expiresAt = 0;
  let running = false;

  async function tick() {
    if (running) return;
    if (now() >= expiresAt) { if (timer) clearIntervalFn(timer); timer = undefined; return; }
    running = true;
    try { await options.warm(); } catch { /* Ollama ocupado/fora: próximo tick tenta de novo */ }
    finally { running = false; }
  }

  return {
    async start() {
      expiresAt = now() + validityMs;
      if (!timer) timer = setIntervalFn(() => void tick(), intervalMs);
      await tick();
    },
    stop() { if (timer) clearIntervalFn(timer); timer = undefined; expiresAt = 0; },
  };
}
