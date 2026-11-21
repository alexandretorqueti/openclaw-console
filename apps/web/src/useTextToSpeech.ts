import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

const STORAGE_KEY = "***";
const MODE_STORAGE_KEY = "***";
export type TextToSpeechMode = "summary" | "full";
export type SpeechPhase = "preparing" | "playing";
export type SpeechActivity = { id: string; phase: SpeechPhase };

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function loadMode(): TextToSpeechMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === "full" ? "full" : "summary";
  } catch {
    return "summary";
  }
}

function normalizeText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!?(\[[^\]]*\])\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#*_~>|]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function summaryForSpeech(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(\$|>|npm |yarn |pnpm |git |docker |traceback|error:|at\s)/i.test(line))
    .filter((line) => !/(\/|\\|\.[a-z0-9]{1,8}\b|node_modules|stack trace|sha256|uuid)/i.test(line) || line.length < 90);
  const cleaned = normalizeText(lines.join(". "));
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

function cleanForSpeech(text: string, mode: TextToSpeechMode): string {
  return mode === "summary" ? summaryForSpeech(text) : normalizeText(text);
}

export function useTextToSpeech() {
  const [enabled, setEnabled] = useState(loadEnabled);
  const [mode, setMode] = useState<TextToSpeechMode>(loadMode);
  const [speaking, setSpeaking] = useState(false);
  const [supported, setSupported] = useState(false);
  // Fala em andamento iniciada pelo botão de uma mensagem (id + fase).
  const [activity, setActivity] = useState<SpeechActivity | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const activityRef = useRef<SpeechActivity | null>(null);
  activityRef.current = activity;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    setSupported(typeof window !== "undefined" && typeof Audio !== "undefined");
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(enabled));
      localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch { /* storage unavailable */ }
  }, [enabled, mode]);

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

  // Núcleo do processo: resumo (modelo) → geração de áudio (Phonon/Ollama) → tocar.
  // `messageId` identifica a fala manual (botão da bolha); null é a fala automática.
  const run = useCallback(async (text: string, messageId: string | null) => {
    if (!supported || typeof window === "undefined") return;
    stop();
    const requestId = requestIdRef.current;
    // Sinaliza também o período de preparação (resumo + áudio). Assim o
    // reconhecimento não continua captando o microfone enquanto o texto é falado.
    setSpeaking(true);
    if (messageId) setActivity({ id: messageId, phase: "preparing" });
    const currentMode = modeRef.current;
    let clean = cleanForSpeech(text, currentMode);
    if (currentMode === "summary") {
      try {
        clean = await api.speechSummary(text);
      } catch {
        clean = cleanForSpeech(text, "summary");
      }
    }
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

  // Fala automática (respostas novas, quando o alto-falante global está ligado).
  const speak = useCallback(async (text: string) => {
    if (!enabled) return;
    await run(text, null);
  }, [enabled, run]);

  // Fala manual pelo botão da mensagem. Clique na mesma fala = parar.
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

  const toggleMode = useCallback(() => {
    setMode((prev) => prev === "summary" ? "full" : "summary");
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { enabled, mode, speaking, supported, activity, speak, speakMessage, stop, toggle, toggleMode };
}
