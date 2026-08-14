import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "openclaw-console-tts-enabled";

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function pickPortugueseVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  // Prefer Brazilian Portuguese female voices
  const ptBr = voices.filter((v) => /^pt-BR/i.test(v.lang));
  const pt = voices.filter((v) => /^pt/i.test(v.lang));
  const candidates = ptBr.length ? ptBr : pt.length ? pt : voices;
  const female = candidates.find((v) => /female|feminino|maria|luciana|francisca|joana/i.test(v.name));
  return female ?? candidates[0] ?? null;
}

export function useTextToSpeech() {
  const [enabled, setEnabled] = useState(loadEnabled);
  const [speaking, setSpeaking] = useState(false);
  const [supported, setSupported] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    setSupported(true);
    // Voices may load asynchronously in some browsers
    const resolveVoice = () => {
      voiceRef.current = pickPortugueseVoice();
    };
    resolveVoice();
    window.speechSynthesis.onvoiceschanged = resolveVoice;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
      window.speechSynthesis.cancel();
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(enabled));
    } catch { /* storage unavailable */ }
  }, [enabled]);

  const speak = useCallback((text: string) => {
    if (!enabled || !supported || typeof window === "undefined" || !window.speechSynthesis) return;
    const clean = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_~>|]/g, "").replace(/\n{2,}/g, ". ").replace(/\n/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!clean) return;
    // Stop any current speech
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(clean);
    if (voiceRef.current) utterance.voice = voiceRef.current;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => { setSpeaking(false); utteranceRef.current = null; };
    utterance.onerror = () => { setSpeaking(false); utteranceRef.current = null; };
    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }, [enabled, supported]);

  const stop = useCallback(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
    utteranceRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      if (prev) {
        // Disabling → stop any current speech
        if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
        setSpeaking(false);
      }
      return !prev;
    });
  }, []);

  return { enabled, speaking, supported, speak, stop, toggle };
}
