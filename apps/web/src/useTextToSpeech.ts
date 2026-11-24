import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

const STORAGE_KEY = "opencl…h-on";
export type SpeechPhase = "preparing" | "playing";
export type SpeechActivity = { id: string; phase: SpeechPhase };

// Regra de leitura (decisão 2026-11-24, Alexandre):
// - Leitura AUTOMÁTICA (alto-falante global ligado, resposta nova): lê o TEXTO
//   COMPLETO, pulando código/tabelas/comandos — SEM resumo por modelo.
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
    requestIdRef.current += 1;
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

  // Núcleo: preparar texto (regra por origem) → geração de áudio (Phonon/Ollama) → tocar.
  // `messageId` identifica a fala manual (botão da bolha); null é a fala automática.
  const run = useCallback(async (text: string, messageId: string | null) => {
    if (!supported || typeof window === "undefined") return;
    stop();
    const requestId = requestIdRef.current;
    // Sinaliza também o período de preparação (resumo + áudio). Assim o
    // reconhecimento não continua captando o microfone enquanto o texto é falado.
    setSpeaking(true);
    if (messageId) setActivity({ id: messageId, phase: "preparing" });
    const kind = messageId === null ? "auto" : "message";
    let clean = await prepareSpeechText(text, kind);
    if (requestId !== requestIdRef.current || !clean) {
      if (requestId === requestIdRef.current) stop();
      return;
    }
    try {
      const blob = await api.speechAudio(clean);
      // A geração de áudio é assíncrona: descarta falas já substituídas/interrompidas.
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
      if (messageId) setActivity({ id: messageId, phase: "playing" });
    } catch (err) {
      console.error(err);
      if (requestId === requestIdRef.current) stop();
    }
  }, [stop, supported]);

  // Fala automática (respostas novas, quando o alto-falante global está ligado):
  // lê o texto completo, pulando código/tabelas/comandos — sem resumo por modelo.
  const speak = useCallback(async (text: string) => {
    if (!enabled) return;
    await run(text, null);
  }, [enabled, run]);

  // Fala manual pelo botão da mensagem: resumo por modelo (residente), fallback
  // heurístico local. Clique na mesma fala = parar.
  const speakMessage = useCallback((id: string, text: string) => {
    if (activityRef.current?.id === id) { stop(); return; }
    void run(text, id);
  }, [run, stop]);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      if (prev) stop();
      return !prev;
    });
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  return { enabled, speaking, supported, activity, speak, speakMessage, stop, toggle };
}
