import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL, getStoredToken } from "./auth";

const STORAGE_KEY = "openclaw-console-tts-enabled";
const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_~>|]/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function useTextToSpeech() {
  const [enabled, setEnabled] = useState(loadEnabled);
  const [speaking, setSpeaking] = useState(false);
  const [supported, setSupported] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    // A reprodução usa <audio> (blob MP3 vindo do BFF/ElevenLabs), disponível em qualquer navegador moderno.
    setSupported(typeof window !== "undefined" && typeof Audio !== "undefined");
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(enabled));
    } catch { /* storage unavailable */ }
  }, [enabled]);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setSpeaking(false);
  }, []);

  const speak = useCallback(async (text: string) => {
    if (!enabled || !supported || typeof window === "undefined") return;
    const clean = cleanForSpeech(text);
    if (!clean) return;

    stop();

    setSpeaking(true);
    try {
      const token = getStoredToken();
      const response = await fetch(`${API_BASE_URL}/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text: clean, voiceId: DEFAULT_VOICE_ID, modelId: DEFAULT_MODEL_ID }),
      });
      if (!response.ok) {
        let detail = "";
        try {
          const payload = await response.json();
          detail = payload?.error?.message ?? "";
        } catch { /* resposta não-JSON */ }
        throw new Error(detail || `ElevenLabs TTS falhou (HTTP ${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        setSpeaking(false);
        audioRef.current = null;
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = null;
        }
      };
      audio.onerror = () => {
        console.error("Erro ao reproduzir áudio ElevenLabs");
        stop();
      };
      await audio.play();
    } catch (err) {
      console.error(err);
      setSpeaking(false);
    }
  }, [enabled, supported, stop]);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      if (prev) stop();
      return !prev;
    });
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  return { enabled, speaking, supported, speak, stop, toggle };
}
