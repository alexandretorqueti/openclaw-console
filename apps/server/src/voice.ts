// Ordenador de voz do console (migração Ollama → LM Studio, 2026-11-26;
// cascata de resumo 2026-11-28):
// - Resumo (cascata): (1) modelo configurado no OpenClaw para compactação
//   (agents.defaults.compaction.model, resolvido via baseUrl do provider na
//   config do Gateway — pode ser remoto, ex.: LM Studio do Mac via túnel);
//   (2) maior modelo JÁ CARREGADO no server local — zero carga, zero evicção;
//   (3) nada carregado → modelo pequeno configurado (fallback,
//   OPENCLAW_SPEECH_SUMMARY_MODEL, default qwen3.5-4b);
// - TTS (fala): backend configurável — padrão o container phonon-tts
//   (gradium ptts-openai-server, porta 8880): POST /v1/audio/speech, WAV
//   16-bit mono 24 kHz, vozes pt do catálogo oficial. Para outro backend,
//   aponte OPENCLAW_TTS_URL para qualquer server OpenAI-compatível com
//   /v1/audio/speech.
// - fila serial: um trabalho de voz por vez (resumo/fala/aquecimento), evitando
//   que cliques simultâneos disputem o server local entre si;
// - aquecimento: o Ollama expira o modelo em ~5 min (keep_alive do endpoint de
//   áudio é ignorado) → reaquecer a cada 4 min.

export type LocalModelInfo = { id: string; state?: string; type?: string; quantization?: string | null };

// Candidato a endpoint de resumo por voz: OpenAI-compatível (/v1/chat/completions).
// `local` = roda no próprio ServerIA (rede host) — usado p/ decisão de espera de GPU.
export type SummaryEndpoint = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  source: "compaction" | "loaded" | "fallback";
  local: boolean;
};

/** Completa a URL de chat/completions para um baseUrl de provider (que já pode terminar em /v1). */
export function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

// A config do Gateway usa hostname interno do Docker (o Gateway roda em bridge);
// o console roda em network_mode: host, onde o equivalente é o loopback do host.
export function rewriteDockerHost(baseUrl: string): string {
  return baseUrl.replace(/\/\/(?:host|gateway)\.docker\.internal(?=[:/]|$)/, "//127.0.0.1");
}

function isLocalBaseUrl(baseUrl: string): boolean {
  try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(baseUrl).hostname); } catch { return false; }
}

/**
 * Lista ordenada de candidatos ao resumo por voz (pedido do Alexandre,
 * 2026-11-28): (1) modelo configurado no OpenClaw para COMPACTAÇÃO
 * (agents.defaults.compaction.model, resolvido via baseUrl do provider na
 * config do Gateway); (2) lógica normal — maior modelo já carregado no server
 * local; (3) nada carregado → modelo pequeno de fallback. Duplicatas
 * (mesmo endpoint+modelo) são removidas mantendo a primeira origem.
 */
export function summaryCandidates(options: {
  compaction?: { baseUrl: string; apiKey?: string; model: string } | null;
  lmstudioUrl: string;
  lmstudioApiKey?: string;
  loadedPick?: string;
  fallbackModel: string;
}): SummaryEndpoint[] {
  const out: SummaryEndpoint[] = [];
  const seen = new Set<string>();
  const push = (endpoint: SummaryEndpoint): void => {
    const key = `${completionsUrl(endpoint.baseUrl)}|${endpoint.model.trim().toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(endpoint);
  };
  const local = (model: string, source: SummaryEndpoint["source"]): SummaryEndpoint => ({
    baseUrl: options.lmstudioUrl,
    ...(options.lmstudioApiKey ? { apiKey: options.lmstudioApiKey } : {}),
    model,
    source,
    local: isLocalBaseUrl(options.lmstudioUrl),
  });
  if (options.compaction) {
    const baseUrl = rewriteDockerHost(options.compaction.baseUrl);
    push({
      baseUrl,
      ...(options.compaction.apiKey ? { apiKey: options.compaction.apiKey } : {}),
      model: options.compaction.model,
      source: "compaction",
      local: isLocalBaseUrl(baseUrl),
    });
  }
  // pickSummaryModel já devolve o fallback quando nada está carregado — o
  // source distingue os dois casos (espera de GPU só vale p/ fallback).
  if (options.loadedPick) {
    push(local(options.loadedPick, options.loadedPick === options.fallbackModel ? "fallback" : "loaded"));
  }
  push(local(options.fallbackModel, "fallback"));
  return out;
}

export function isPhononModel(name: string): boolean {
  return name.toLowerCase().includes("phonon");
}

function quantizationBits(quant: string | null | undefined): number {
  if (!quant) return 0;
  const match = /^q(\d+)/i.exec(quant.trim());
  return match ? Number(match[1]) : 0;
}

// Tamanho em bilhões de parâmetros extraído do id quando está no nome
// ("qwen/qwen3.8-27b" → 27; "qwen3.8-flash-next@q8_0" → 0 quando não há).
function sizeHintBillion(id: string): number {
  const match = /(\d+(?:\.\d+)?)b/i.exec(id);
  return match ? Number(match[1]) : 0;
}

// Resumo: prefere o maior modelo já CARREGADO (state=loaded; llm/vlm; não-phonon,
// não-embedding) — ordem: tipo (vlm>llm), tamanho (dígito "Nb" no id),
// quantização (mais bits = mais capacidade). Sem state, assume carregado
// (endpoints que só listam o que está ativo). Se nada aplicável, usa o fallback.
export function pickSummaryModel(loaded: LocalModelInfo[], fallback: string): string {
  const candidates = loaded
    .filter((model) => (model.state ?? "loaded") === "loaded"
      && !isPhononModel(model.id)
      && (model.type === undefined || model.type === "llm" || model.type === "vlm"))
    .sort((a, b) => {
      const rank = (model: LocalModelInfo) => (model.type === "vlm" ? 2 : model.type === "llm" ? 1 : 0);
      return rank(b) - rank(a)
        || sizeHintBillion(b.id) - sizeHintBillion(a.id)
        || quantizationBits(b.quantization) - quantizationBits(a.quantization)
        || a.id.localeCompare(b.id);
    });
  return candidates[0]?.id ?? fallback;
}

// Fila serial: um trabalho de voz por vez (resumo/fala/aquecimento), evitando que
// cliques simultâneos disputem o server local entre si.
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

// Reaquecimento do modelo de TTS: o Ollama expira o modelo em ~5 min, então o
// timer roda a cada intervalo (default 4 min) e se autodeativa após o período de
// validade (default 30 min) — rearme a cada novo pedido de aquecimento.
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
    try { await options.warm(); } catch { /* server local ocupado/fora: próximo tick tenta de novo */ }
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
