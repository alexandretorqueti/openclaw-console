import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

const STORAGE_KEY = "***";
export type SpeechPhase = "preparing" | "playing";
export type SpeechActivity = { id: string; phase: SpeechPhase };

// Regra de leitura (decisão 2026-11-24, Alexandre):
// - Leitura AUTOMÁTICA (alto-falante global ligado): STREAMING — a voz lê os
//   blocos já completos ENQUANTO o texto ainda está sendo escrito
//   (appendStream); no final, o resto do buffer é falado. Texto COMPLETO,
//   pulando código/tabelas/comandos — SEM resumo por modelo.
// - Leitura MANUAL (botão de alto-falante na bolha): RESUMO por modelo (residente),
//   com fallback heurístico local se o resumo falhar.

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

// Limpa o que não serve para leitura: blocos de código, código inline, tabelas,
// linhas de comando/terminal, URLs e lixo de markdown — mantendo o resto.
export function cleanForFullSpeech(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/^[ \t]*\|[\s\S]*?(?=\n[^\n|]*$|$)/gm, " ")
    .replace(/^[ \t]*(\$( |$)|% |npm |yarn |pnpm |npx |git |docker |kubectl |curl |make |uvicorn|pytest |pip3? |brew |apt(-get)? |ssh |scp |crontab )/gm, " ")
    .replace(/!?(\[[^\]]*\])\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#*_~>|]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Se a limpeza esvaziou o texto (resposta 100% código/tabela), cai no fallback
  // heurístico para a leitura não ficar vazia.
  return cleaned || summaryForSpeech(text);
}

// Fallback heurístico (sem modelo): primeiras frases coerentes do texto.
function summaryForSpeech(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(\$|>|npm |yarn |pnpm |git |docker |traceback|error:|at\s)/i.test(line))
    .filter((line) => !/(\/|\\|\.[a-z0-9]{1,8}\b|node_modules|stack trace|sha256|uuid)/i.test(line) || line.length < 90);
  const cleaned = lines.join(". ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!?(\[[^\]]*\])\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#*_~>|]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned) return "A resposta contém apenas detalhes técnicos ou código.";

  // Mantém as primeiras ideias completas e evita transformar uma resposta longa
  // em uma leitura igualmente longa. O texto integral continua disponível na tela.
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [cleaned];
  const selected: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    const next = sentence.trim();
    if (!next || selected.length >= 5 || length + next.length > 650) break;
    selected.push(next);
    length += next.length;
  }
  return selected.join(" ") || cleaned.slice(0, 650);
}

// `kind`: "auto" = leitura automática (texto completo com pulos);
//        "message" = botão da bolha (resumo por modelo, fallback heurístico).
export async function prepareSpeechText(text: string, kind: "auto" | "message"): Promise<string> {
  if (kind === "message") {
    try {
      return (await api.speechSummary(text)).trim();
    } catch {
      return summaryForSpeech(text);
    }
  }
  return cleanForFullSpeech(text);
}

// Corta um sentença completa do buffer do stream. Só corta em fronteira segura:
// ponto/!/? seguido de espaço + maiúscula, ou quebra de parágrafo (limpeza dos
// markdown faz o resto no cleanForFullSpeech de cada sentença).
function popSentence(buffer: string, minLen: number): string | null {
  const para = buffer.match(/\n{2,}/);
  const sent = buffer.match(/[.!?](?:\s|$)/);
  let cut: number | null = null;
  let isParagraph = false;
  if (para && sent) {
    const paraCut = (para.index ?? 0) + para[0].length;
    const sentCut = (sent.index ?? 0) + 1;
    if (sentCut <= minLen) { cut = sentCut; } else { cut = paraCut; isParagraph = true; }
  } else if (para) { cut = (para.index ?? 0) + para[0].length; isParagraph = true; }
  else if (sent) { cut = (sent.index ?? 0) + 1; }
  if (cut !== null) {
    const head = buffer.slice(0, cut).trim();
    // Parágrafo fechado → fala mesmo curto; sentença → respeita o mínimo.
    if (head.length >= minLen || isParagraph) return head;
    // Sentença curta: espera o próximo fronteira (ou o teto abaixo).
  }
  // Sem fronteira ainda: se o buffer já ficou grande o bastante, fala em bruto
  // (a limpeza local ainda remove código/tabelas se houver).
  if (buffer.trim().length >= 480) return buffer.trim();
  return null;
}

const STREAM_MIN_SENTENCE = 24;
const STREAM_FLUSH_MS = 3_000;
const STREAM_MAX_BUFFER = 6_000;

export function useTextToSpeech() {
  const [enabled, setEnabled] = useState(loadEnabled);
  const [speaking, setSpeaking] = useState(false);
  const [supported, setSupported] = useState(false);
  // Fala em andamento iniciada pelo botão de uma mensagem (id + fase).
  const [activity, setActivity] = useState<SpeechActivity | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const activityRef = useRef<SpeechActivity | null>(null);
  activityRef.current = activity;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // Streaming: buffer de texto não-falado da resposta em curso + timer de flush
  // (fala o que tiver se o modelo parar de gerar sem fechar sentença).
  const streamPendingRef = useRef("");
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fences de código abertas (```) — o que estiver dentro NUNCA entra no buffer
  // de fala (evita ler código no meio do bloco ou ler meio-bloco sem a cerca).
  const streamInFenceRef = useRef(false);
  // Garante um único streamLoop por vez (evita dois loops disputando o buffer
  // e audios saindo fora de ordem).
  const streamLoopRunningRef = useRef(false);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && typeof Audio !== "undefined");
  }, []);

  // Voz ligada → mantém o Phonon residente no Ollama (o BFF segura o keep-alive
  // por ~30 min; reacender a cada 20 min cobre sessões longas sem custo real).
  useEffect(() => {
    if (!enabled) return;
    void api.warmVoice();
    const timer = setInterval(() => void api.warmVoice(), 20 * 60_000);
    return () => clearInterval(timer);
  }, [enabled]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(enabled));
    } catch { /* storage unavailable */ }
  }, [enabled]);

  const stop = useCallback(() => {
    requestIdRef.current += 1; // cancela o loop de stream e falas antigas
    if (streamFlushTimerRef.current) { clearTimeout(streamFlushTimerRef.current); streamFlushTimerRef.current = null; }
    streamPendingRef.current = "";
    streamInFenceRef.current = false;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setSpeaking(false);
    setActivity(null);
  }, []);

  // Encadeia audios: um toca depois do outro, mantendo o request atual.
  const playChunk = useCallback(async (audio: HTMLAudioElement, requestId: number) => {
    if (streamFlushTimerRef.current) { clearTimeout(streamFlushTimerRef.current); streamFlushTimerRef.current = null; }
    const prev = (playChunk as unknown as { __chain?: Promise<void> }).__chain ?? Promise.resolve();
    const next = prev.then(async () => {
      if (requestId !== requestIdRef.current) return;
      const finish = () => { if (requestId === requestIdRef.current) stop(); };
      audio.onended = finish;
      audio.onerror = () => {
        console.error("Erro ao reproduzir áudio do TTS local (Phonon/Ollama)");
        finish();
      };
      await audio.play();
    });
    (playChunk as unknown as { __chain?: Promise<void> }).__chain = next;
  }, [stop]);

  // Loop do streaming: enquanto houver buffer, corta sentenças, gera áudio no
  // Phonon (fila serial do BFF) e toca na ordem. O áudio do próximo bloco é
  // preparado ENQUANTO o anterior toca — por isso a voz acompanha o texto.
  const streamLoop = useCallback(async (requestId: number) => {
    if (streamLoopRunningRef.current) return;
    streamLoopRunningRef.current = true;
    try {
      while (requestId === requestIdRef.current) {
        const sentence = popSentence(streamPendingRef.current, STREAM_MIN_SENTENCE);
        if (!sentence) break;
        // A sentença é o PREFIXO do buffer: remove o que já foi falado.
        streamPendingRef.current = streamPendingRef.current.slice(sentence.length).trimStart();
        const clean = cleanForFullSpeech(sentence);
        if (requestId !== requestIdRef.current) return;
        if (!clean) continue;
        try {
          const blob = await api.speechAudio(clean);
          if (requestId !== requestIdRef.current) return;
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          const audio = new Audio(url);
          audioRef.current = audio;
          setSpeaking(true);
          await playChunk(audio, requestId);
        } catch (err) {
          console.error(err);
        }
      }
      if (requestId === requestIdRef.current && !streamPendingRef.current.trim()) {
        setSpeaking(false);
        setActivity(null);
      }
    } finally {
      streamLoopRunningRef.current = false;
      // Se chegou texto novo durante a espera (loop encerrado por buffer vazio,
      // por exemplo), retoma o processamento.
      if (requestId === requestIdRef.current && streamPendingRef.current.trim()) {
        void streamLoop(requestId);
      }
    }
  }, [playChunk]);

  // Stream do chat: appende texto novo (pular conteúdo de cerca de código) e
  // dispara o loop assim que houver uma sentença falável (ou via timer, se o
  // modelo não fechar sentença).
  const appendStream = useCallback((text: string) => {
    if (!enabledRef.current) return;
    // Remove o que estiver entre cercas de código (```) — inclusive a cerca,
    // pois o buffer de fala não precisa saber que existiu um bloco de código.
    let out = "";
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (/^```/.test(trimmed)) {
        streamInFenceRef.current = !streamInFenceRef.current;
        continue;
      }
      if (streamInFenceRef.current) continue;
      out += line + "\n";
    }
    if (!out) return;
    streamPendingRef.current += out;
    if (streamPendingRef.current.length > STREAM_MAX_BUFFER) {
      // segurança: não deixar o buffer crescer sem fim
      streamPendingRef.current = streamPendingRef.current.slice(-STREAM_MAX_BUFFER);
    }
    if (streamPendingRef.current.length < STREAM_MIN_SENTENCE) return;
    const requestId = requestIdRef.current;
    setSpeaking(true);
    // Dispara imediatamente se já há sentença completa; senão, timer de flush.
    const hasSentence = popSentence(streamPendingRef.current, STREAM_MIN_SENTENCE) !== null;
    if (hasSentence) {
      if (streamFlushTimerRef.current) { clearTimeout(streamFlushTimerRef.current); streamFlushTimerRef.current = null; }
      void streamLoop(requestId);
    } else if (!streamFlushTimerRef.current) {
      streamFlushTimerRef.current = setTimeout(() => {
        streamFlushTimerRef.current = null;
        if (requestId === requestIdRef.current && streamPendingRef.current.trim()) void streamLoop(requestId);
      }, STREAM_FLUSH_MS);
    }
  }, [streamLoop]);

  // Fim do stream: fala o resto do buffer (mesmo sem sentença fechada).
  const flushStream = useCallback(() => {
    if (!enabledRef.current) return;
    if (!streamPendingRef.current.trim()) return;
    if (streamFlushTimerRef.current) { clearTimeout(streamFlushTimerRef.current); streamFlushTimerRef.current = null; }
    void streamLoop(requestIdRef.current);
  }, [streamLoop]);

  // Nova mensagem do usuário: descarta qualquer resto de fala da resposta antiga.
  const resetStream = useCallback(() => {
    if (streamFlushTimerRef.current) { clearTimeout(streamFlushTimerRef.current); streamFlushTimerRef.current = null; }
    streamPendingRef.current = "";
    streamInFenceRef.current = false;
  }, []);

  // Fala automática de uma vez (texto já completo — ex.: legado/fallback).
  const speak = useCallback(async (text: string) => {
    if (!enabledRef.current) return;
    stop();
    const requestId = requestIdRef.current;
    setSpeaking(true);
    const clean = cleanForFullSpeech(text);
    if (requestId !== requestIdRef.current || !clean) {
      if (requestId === requestIdRef.current) stop();
      return;
    }    try {
      const blob = await api.speechAudio(clean);
      if (requestId !== requestIdRef.current) return;
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      const finish = () => { if (requestId === requestIdRef.current) stop(); };
      audio.onended = finish;
      audio.onerror = () => {
        console.error("Erro ao reproduzir áudio do TTS local (Phonon/Ollama)");
        finish();
      };
      await audio.play();
    } catch (err) {
      console.error(err);
      if (requestId === requestIdRef.current) stop();
    }
  }, [stop]);

  // Fala manual pelo botão da mensagem: resumo por modelo (residente), fallback
  // heurístico local. Clique na mesma fala = parar.
  const speakMessage = useCallback((id: string, text: string) => {
    if (activityRef.current?.id === id) { stop(); return; }
    stop(); // cancela o streaming em andamento (uma fala ativa por vez)
    const requestId = requestIdRef.current;
    setSpeaking(true);
    setActivity({ id, phase: "preparing" });
    void (async () => {
      const clean = await prepareSpeechText(text, "message");
      if (requestId !== requestIdRef.current || !clean) {
        if (requestId === requestIdRef.current) stop();
        return;
      }
      try {
        const blob = await api.speechAudio(clean);
        if (requestId !== requestIdRef.current) return;
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        const finish = () => { if (requestId === requestIdRef.current) stop(); };
        audio.onended = finish;
        audio.onerror = () => {
          console.error("Erro ao reproduzir áudio do TTS local (Phonon/Ollama)");
          finish();
        };
        await audio.play();
        if (requestId !== requestIdRef.current) return;
        setActivity({ id, phase: "playing" });
      } catch (err) {
        console.error(err);
        if (requestId === requestIdRef.current) stop();
      }
    })();
  }, [stop]);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      if (prev) { stop(); } else { streamPendingRef.current = ""; }
      return !prev;
    });
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  return {
    enabled, speaking, supported, activity,
    speak, appendStream, flushStream, resetStream,
    speakMessage, stop, toggle,
  };
}
