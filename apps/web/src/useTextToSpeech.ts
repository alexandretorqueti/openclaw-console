import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

const STORAGE_KEY = "openclaw-console-tts-enabled";
const MODE_STORAGE_KEY = "openclaw-console-tts-mode";
export type TextToSpeechMode = "summary" | "full";

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
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(enabled));
      localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch { /* storage unavailable */ }
  }, [enabled, mode]);

  const stop = useCallback(() => {
    requestIdRef.current += 1;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setSpeaking(false);
  }, []);

  const speak = useCallback(async (text: string) => {
    if (!enabled || !supported || typeof window === "undefined") return;
    stop();
    const requestId = requestIdRef.current;
    let clean = cleanForSpeech(text, "full");
    if (mode === "summary") {
      try {
        clean = await api.speechSummary(text);
      } catch {
        clean = cleanForSpeech(text, "summary");
      }
    }
    if (requestId !== requestIdRef.current || !clean) return;
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = "pt-BR";
    utterance.rate = 1;
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find((voice) => voice.lang.toLowerCase() === "pt-br")
      ?? voices.find((voice) => voice.lang.toLowerCase().startsWith("pt"))
      ?? null;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => { utteranceRef.current = null; setSpeaking(false); };
    utterance.onerror = () => { utteranceRef.current = null; setSpeaking(false); };
    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }, [enabled, mode, stop, supported]);

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

  return { enabled, mode, speaking, supported, speak, stop, toggle, toggleMode };
}
