// Preparação de modelos locais (LM Studio) antes do chat.send.
//
// Fluxo pedido pelo Alexandre (2026-11-28): ao receber uma solicitação para um
// modelo de provider local, o console (1) tenta carregar o modelo; (2) se
// falhar, lista os modelos carregados; (3) identifica quais estão ociosos
// (não ativos); (4) descarrega os ociosos e tenta carregar o novo de novo.
//
// Por quê: a API HTTP do LM Studio não tem endpoint de load/unload (verificado
// empiricamente em 2026-11-28: POST/DELETE em /api/v0/models* → "Unexpected
// endpoint"), e o LM Studio não evacua modelos residentes quando a carga de um
// novo falha por falta de memória. O canal que permite load/unload é o CLI
// `lms` (socket de desenvolvedor). O `lms ps --json` traz o que falta no HTTP:
// `status` (idle/generating), `sizeBytes` e `lastUsedTime` por modelo.
//
// No container de produção o binário vem de um bind-mount do `~/.lmstudio` do
// host (compose.yaml) — `lms` descobre o servidor via `$HOME/.lmstudio`, e o
// container roda como uid 1000 (mesmo dono dos arquivos no host).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LoadedLocalModel {
  /** Identificador da instância carregada (usado pelo `lms unload`). */
  identifier: string;
  /** Chave do modelo no disco (usada pelo `lms load`). */
  modelKey: string;
  /** idle | generating | ... (minúsculas). */
  status: string;
  sizeBytes: number;
  /** Epoch ms do último uso; null = nunca usado desde a carga. */
  lastUsedTime: number | null;
}

export type ModelPreparingStage = "loading" | "freeing" | "ready" | "failed";

export interface ModelPreparingEventPayload {
  sessionKey?: string;
  modelId: string;
  stage: ModelPreparingStage;
  detail?: string;
}

export interface LocalModelManagerLog {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface LocalModelManagerOptions {
  lmstudioUrl: string;
  apiKey?: string;
  /** Caminho do binário `lms`. Default: `~/.lmstudio/bin/lms`. */
  lmsPath?: string;
  /** HOME usado ao executar o `lms` (precisa conter `.lmstudio`). Default: pai do pai do binário. */
  lmsHome?: string;
  /** Prefixos de provider considerados locais. Default: ["lmstudio"]. */
  providers?: string[];
  /** TTL da carga (s); 0 = sem TTL (persistente). Default: 3600 (espelha o jitModelTTL do LM Studio). */
  ttlSeconds?: number;
  /** Timeout de cada `lms load` (carga de modelos grandes leva minutos). Default: 600_000. */
  loadTimeoutMs?: number;
  /** Máximo de modelos ociosos descarregados por tentativa. Default: 3. */
  maxUnloadsPerEnsure?: number;
  /** Janela em que um modelo usado pelo console fica protegido de despejo. Default: 90_000. */
  recentUseWindowMs?: number;
  /**
   * Ociosidade mínima (ms) segundo o `lastUsedTime` do próprio LM Studio antes
   * de permitir o despejo — protege modelos entre turnos de agente (idle por
   * frações de segundo) e qualquer consumidor fora do proxy (GUI etc.).
   * Modelo sem `lastUsedTime` conhecido nunca é despejado. 0 desliga a regra.
   * Default: 30_000.
   */
  minIdleMs?: number;
  /** Ids (identifier/modelKey, minúsculos) que nunca são descarregados. Default: embeddings. */
  protectedModels?: string[];
  log: LocalModelManagerLog;
  onProgress?: (event: ModelPreparingEventPayload) => void;
}

const DEFAULT_PROVIDERS = ["lmstudio"];
const DEFAULT_PROTECTED = ["text-embedding-bge-m3", "text-embedding-nomic-embed-text-v1.5"];

/** Ref `provedor/id` → id do modelo local; undefined para providers não locais. */
export function localModelIdFromRef(modelRef: string | undefined, providers: string[] = DEFAULT_PROVIDERS): string | undefined {
  if (!modelRef) return undefined;
  const ref = modelRef.trim();
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  const provider = ref.slice(0, slash).toLowerCase();
  if (!providers.some((candidate) => candidate.toLowerCase() === provider)) return undefined;
  return ref.slice(slash + 1).trim() || undefined;
}

/** Parse tolerante do `lms ps --json` (array de objetos). */
export function parseLmsPs(payload: unknown): LoadedLocalModel[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const identifier = typeof row.identifier === "string" && row.identifier.trim() ? row.identifier.trim() : undefined;
    if (!identifier) return [];
    return [{
      identifier,
      modelKey: typeof row.modelKey === "string" && row.modelKey.trim() ? row.modelKey.trim() : identifier,
      status: typeof row.status === "string" ? row.status.trim().toLowerCase() : "",
      sizeBytes: typeof row.sizeBytes === "number" && Number.isFinite(row.sizeBytes) ? row.sizeBytes : 0,
      lastUsedTime: typeof row.lastUsedTime === "number" && Number.isFinite(row.lastUsedTime) ? row.lastUsedTime : null,
    }];
  });
}

export interface UnloadCandidateOptions {
  targetId: string;
  protectedIds: Set<string>;
  /** Id (minúsculo) → timestamp do último uso conhecido pelo console. */
  recentlyTouched: Map<string, number>;
  recentUseWindowMs: number;
  /** Ociosidade mínima (ms) pelo lastUsedTime do LM Studio; 0/undefined = regra desligada. */
  minIdleMs?: number;
  now: number;
}

/**
 * Escolhe os modelos que podem ser descarregados para liberar espaço:
 * - apenas `idle` (nunca `generating` — cortaria uma resposta em andamento);
 * - nunca o alvo, nem protegidos (embeddings etc.);
 * - nem usados pelo console dentro da janela recente (protege turnos de agente
 *   que ficam idle entre tool calls);
 * - com `minIdleMs > 0`: só modelos cujo `lastUsedTime` (do LM Studio, cobre
 *   qualquer consumidor) está parado há pelo menos `minIdleMs`; sem
 *   `lastUsedTime` conhecido → protegido (conservador);
 * - ordem: menos usado recentemente primeiro (LRU; nunca usado = mais antigo),
 *   desempate pelo maior tamanho (libera mais espaço por despejo).
 */
export function pickUnloadCandidates(models: LoadedLocalModel[], options: UnloadCandidateOptions): LoadedLocalModel[] {
  const target = options.targetId.toLowerCase();
  const minIdleMs = options.minIdleMs ?? 0;
  const candidates = models.filter((model) => {
    if (model.status !== "idle") return false;
    const ids = [model.identifier.toLowerCase(), model.modelKey.toLowerCase()];
    if (ids.includes(target)) return false;
    if (ids.some((id) => options.protectedIds.has(id))) return false;
    const touched = Math.max(...ids.map((id) => options.recentlyTouched.get(id) ?? 0));
    if (touched > 0 && options.now - touched < options.recentUseWindowMs) return false;
    if (minIdleMs > 0) {
      if (model.lastUsedTime === null) return false;
      if (options.now - model.lastUsedTime < minIdleMs) return false;
    }
    return true;
  });
  return candidates.sort((a, b) => (a.lastUsedTime ?? 0) - (b.lastUsedTime ?? 0) || b.sizeBytes - a.sizeBytes);
}

/**
 * Caminhos candidatos do info file do daemon (bionic primeiro), a partir do
 * HOME que contém o diretório `.lmstudio`. Exportado para teste.
 */
export function lmsInfoFileCandidates(lmsHome: string): string[] {
  const lmstudioDir = resolve(lmsHome, ".lmstudio");
  return [
    resolve(lmstudioDir, "apps", "bionic", "\.internal", "http-server.json"),
    resolve(lmstudioDir, ".internal", "http-server.json"),
  ];
}

export interface LocalModelManager {
  /** Id local a partir de `provedor/id`; undefined se não for provider local. */
  idFromRef(modelRef: string | undefined): string | undefined;
  /** Garante o modelo carregado; dispara progress via onProgress. Serializado globalmente. */
  ensure(modelId: string, sessionKey?: string): Promise<void>;
  /** Marca uso recente (protege o modelo de despejo pela janela). */
  touch(modelId: string): void;
  /** O binário `lms` está disponível? Sem ele a orquestração é pulada. */
  isConfigured(): boolean;
}

function safeJsonParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return undefined; }
}

/**
 * Saída do `lms` indica falha de INFRAESTRUTURA de descoberta (servidor
 * inalcançável / instalação não encontrada) em vez de falta de recursos?
 * Nesse caso a preparação degrada para o comportamento antigo (carga JIT do
 * Gateway) em vez de bloquear o envio com 503.
 */
export function isLmsInfraFailure(output: string): boolean {
  return /No running LM Studio|Failed to start or connect|no valid installation/i.test(output);
}

export function createLocalModelManager(options: LocalModelManagerOptions): LocalModelManager {
  const lmsPath = options.lmsPath?.trim() || resolve(homedir(), ".lmstudio", "bin", "lms");
  // `lms` descobre o servidor via $HOME/.lmstudio → HOME é o diretório que
  // CONTÉM `.lmstudio` (não derivar do caminho do binário: bin vive em
  // `.lmstudio/bin/lms`, dois dirnames cairiam no próprio `.lmstudio`).
  const lmsHome = options.lmsHome?.trim() || homedir();
  const providers = options.providers ?? DEFAULT_PROVIDERS;
  const protectedIds = new Set((options.protectedModels ?? DEFAULT_PROTECTED).map((id) => id.toLowerCase()));
  const ttlSeconds = options.ttlSeconds ?? 3600;
  const loadTimeoutMs = options.loadTimeoutMs ?? 600_000;
  const maxUnloads = options.maxUnloadsPerEnsure ?? 3;
  const recentUseWindowMs = options.recentUseWindowMs ?? 90_000;
  const minIdleMs = options.minIdleMs ?? 30_000;
  const log = options.log;

  const touched = new Map<string, number>();
  // Fila global: load/unload mexem na VRAM inteira — duas preparações em
  // paralelo despejariam modelos uma da outra. O fast path (já carregado) fica
  // FORA da fila para não adicionar latência ao envio comum.
  let queue: Promise<unknown> = Promise.resolve();

  function touch(modelId: string): void {
    touched.set(modelId.toLowerCase(), Date.now());
    const cutoff = Date.now() - recentUseWindowMs * 10;
    for (const [id, at] of touched) if (at < cutoff) touched.delete(id);
  }

  function isConfigured(): boolean {
    return existsSync(lmsPath);
  }

  function progress(modelId: string, stage: ModelPreparingStage, sessionKey?: string, detail?: string): void {
    try {
      options.onProgress?.({ modelId, stage, ...(sessionKey ? { sessionKey } : {}), ...(detail ? { detail } : {}) });
    } catch { /* progresso é melhor-esforço */ }
  }

  async function runLms(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; failed: boolean }> {
    try {
      const { stdout, stderr } = await execFileAsync(lmsPath, args, {
        env: await buildLmsEnv(),
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout, stderr, failed: false };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message ?? String(error), failed: true };
    }
  }

  // Dentro do container, a descoberta padrão do `lms` falha: ele lê
  // `.internal/http-server.json` (ou apps/bionic/.internal/) que contém o `pid`
  // do daemon, e o cheque de vida `process.kill(pid, 0)` não enxerga PIDs do
  // host a partir do namespace do container. Solução: gerar uma cópia do info
  // file SEM pid (campo opcional no schema do lms) na MESMA pasta (o dirname do
  // arquivo vira o internalFolder usado pela autenticação local privilegiada)
  // e apontar `LMS_API_SERVER_INFO_PATH` para ela. A porta é dinâmica (mudou p/
  // 37799 num restart observado) → relê a origem toda vez; sem o arquivo de
  // origem, mantém o ambiente como está.
  async function buildLmsEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: lmsHome };
    if (env.LMS_API_SERVER_INFO_PATH) return env; // configuração explícita vence
    for (const source of lmsInfoFileCandidates(lmsHome)) {
      const info = safeJsonParse(await readFile(source, "utf8").catch(() => "")) as { port?: number; host?: string } | undefined;
      if (!info || typeof info.port !== "number") continue;
      const stripped = resolve(dirname(source), "http-server-nopid.json");
      const content = JSON.stringify({ port: info.port, ...(typeof info.host === "string" ? { host: info.host } : {}) });
      const existing = await readFile(stripped, "utf8").catch(() => "");
      if (existing !== content) {
        await writeFile(stripped, content, "utf8").catch((error) => {
          log.warn({ stripped, error: String(error) }, "não foi possível gravar info file sem pid do lms");
        });
      }
      if (existsSync(stripped)) return { ...env, LMS_API_SERVER_INFO_PATH: stripped };
    }
    return env;
  }

  async function httpStates(): Promise<Map<string, string>> {
    const states = new Map<string, string>();
    try {
      const response = await fetch(`${options.lmstudioUrl}/api/v0/models`, {
        headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return states;
      const payload = (await response.json()) as { data?: unknown };
      if (!Array.isArray(payload.data)) return states;
      for (const value of payload.data) {
        if (!value || typeof value !== "object") continue;
        const row = value as Record<string, unknown>;
        if (typeof row.id === "string" && typeof row.state === "string") states.set(row.id.toLowerCase(), row.state);
      }
    } catch { /* sem estado: tratado como "não carregado" */ }
    return states;
  }

  async function isLoaded(modelId: string): Promise<boolean> {
    return (await httpStates()).get(modelId.toLowerCase()) === "loaded";
  }

  async function attemptLoad(modelId: string): Promise<{ loaded: boolean; infraFailure: boolean }> {
    const args = ["load", modelId, "-y"];
    if (ttlSeconds > 0) args.push("--ttl", String(ttlSeconds));
    const result = await runLms(args, loadTimeoutMs);
    if (result.failed) {
      log.warn({ modelId, stderr: result.stderr.slice(0, 500) }, "lms load falhou; conferindo estado via HTTP (timeout do CLI não significa carga abortada)");
    }
    // O CLI pode estourar timeout com a carga ainda em andamento no app; o
    // estado HTTP é a fonte de verdade.
    const loaded = await isLoaded(modelId);
    return { loaded, infraFailure: !loaded && isLmsInfraFailure(`${result.stdout}${result.stderr}`) };
  }

  async function ensureOnce(modelId: string, sessionKey?: string): Promise<void> {
    touch(modelId);
    if (await isLoaded(modelId)) return;

    progress(modelId, "loading", sessionKey);
    log.info({ modelId }, "modelo local não carregado: iniciando carga via lms");
    const attempt = await attemptLoad(modelId);
    if (attempt.loaded) {
      progress(modelId, "ready", sessionKey);
      return;
    }
    if (attempt.infraFailure) {
      // lms não alcança o daemon (ex.: descasamento de versão/endereço): não
      // bloqueia o envio — o Gateway ainda tenta a carga JIT como antes.
      log.warn({ modelId }, "lms não conseguiu falar com o servidor local; seguindo sem preparação (carga JIT do Gateway)");
      return;
    }

    // Carga falhou → despejar ociosos (passos 2–4 do fluxo pedido).
    progress(modelId, "freeing", sessionKey);
    const ps = await runLms(["ps", "--json"], 15_000);
    if (ps.failed && isLmsInfraFailure(`${ps.stdout}${ps.stderr}`)) {
      log.warn({ modelId }, "lms ps inacessível; seguindo sem preparação (carga JIT do Gateway)");
      return;
    }
    const loaded = parseLmsPs(safeJsonParse(ps.stdout));
    const candidates = pickUnloadCandidates(loaded, {
      targetId: modelId,
      protectedIds,
      recentlyTouched: touched,
      recentUseWindowMs,
      minIdleMs,
      now: Date.now(),
    });
    if (candidates.length === 0) {
      const detail = minIdleMs > 0
        ? `nenhum modelo ocioso há pelo menos ${Math.round(minIdleMs / 1000)}s disponível para liberar memória`
        : "nenhum modelo ocioso disponível para liberar memória";
      progress(modelId, "failed", sessionKey, detail);
      throw Object.assign(new Error(`Não foi possível carregar o modelo local "${modelId}" (${detail}).`), { code: "UNAVAILABLE" });
    }

    let unloaded = 0;
    for (const candidate of candidates.slice(0, maxUnloads)) {
      // Revalida IMEDIATAMENTE antes de despejar: entre a seleção e aqui o
      // candidato pode ter recebido trabalho (o idle momentâneo entre turnos
      // de agente não despeja mais — incidente 2026-11-28 reportado pelo Alexandre).
      const fresh = await runLms(["ps", "--json"], 15_000);
      if (fresh.failed) {
        log.warn({ modelId }, "revalidação do lms ps falhou; abortando despejos por segurança");
        break;
      }
      const candidateId = candidate.identifier.toLowerCase();
      const freshModel = parseLmsPs(safeJsonParse(fresh.stdout)).find((model) => model.identifier.toLowerCase() === candidateId || model.modelKey.toLowerCase() === candidateId);
      const stillEligible = freshModel
        ? pickUnloadCandidates([freshModel], { targetId: modelId, protectedIds, recentlyTouched: touched, recentUseWindowMs, minIdleMs, now: Date.now() }).length === 1
        : false;
      if (!stillEligible) {
        log.info({ modelId, skipped: candidate.identifier }, "candidato voltou a ser usado/inelegível; pulando despejo");
        progress(modelId, "freeing", sessionKey, `pulando ${candidate.identifier} (voltou a ser usado)`);
        continue;
      }
      progress(modelId, "freeing", sessionKey, `descarregando ${candidate.identifier}`);
      const result = await runLms(["unload", candidate.identifier], 30_000);
      if (result.failed) {
        // "Model Not Found" = já saiu da memória (corrida benigna) → seguir.
        if (!/not found|not loaded/i.test(`${result.stdout}${result.stderr}`)) {
          log.warn({ identifier: candidate.identifier, stderr: result.stderr.slice(0, 300) }, "lms unload falhou; tentando o próximo candidato");
          continue;
        }
      }
      unloaded += 1;
      log.info({ modelId, evicted: candidate.identifier, sizeBytes: candidate.sizeBytes }, "modelo ocioso descarregado para liberar memória");
      if ((await attemptLoad(modelId)).loaded) {
        progress(modelId, "ready", sessionKey);
        return;
      }
    }

    const detail = `${unloaded} modelo(s) ocioso(s) liberado(s) sem sucesso na carga`;
    progress(modelId, "failed", sessionKey, detail);
    throw Object.assign(new Error(`Não foi possível carregar o modelo local "${modelId}": recursos insuficientes (${detail}).`), { code: "UNAVAILABLE" });
  }

  function ensure(modelId: string, sessionKey?: string): Promise<void> {
    const run = () => ensureOnce(modelId, sessionKey);
    const next = queue.then(run, run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  return {
    idFromRef: (modelRef) => localModelIdFromRef(modelRef, providers),
    async ensure(modelId, sessionKey) {
      if (!isConfigured()) {
        // Sem o CLI no ambiente (dev fora do container): não bloqueia o chat —
        // o LM Studio ainda tenta a carga JIT na requisição do Gateway.
        log.warn({ modelId, lmsPath }, "lms não encontrado; pulando preparação do modelo local");
        touch(modelId);
        return;
      }
      // Fast path fora da fila: modelo já residente não espera nada.
      if (await isLoaded(modelId)) {
        touch(modelId);
        return;
      }
      return ensure(modelId, sessionKey);
    },
    touch,
    isConfigured,
  };
}
