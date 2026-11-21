import { createContext, useContext } from "react";
import VolumeUpRounded from "@mui/icons-material/VolumeUpRounded";
import { CircularProgress, IconButton, Tooltip } from "@mui/material";
import type { SpeechActivity } from "./useTextToSpeech";

// Contexto de fala por mensagem: permite que cada bolha (chat 1:1 e grupos)
// ofereça o botão de "ouvir esta resposta" sem prop drilling pela árvore.
export type MessageSpeechValue = {
  activity: SpeechActivity | null;
  speakMessage: (id: string, text: string) => void;
};

export const MessageSpeechContext = createContext<MessageSpeechValue | null>(null);

export function MessageSpeechButton({ id, text }: { id: string; text: string }) {
  const speech = useContext(MessageSpeechContext);
  if (!speech) return null;
  const current = speech.activity?.id === id ? speech.activity : null;
  const title = current?.phase === "preparing" ? "Gerando áudio…" : current ? "Parar" : "Ouvir resposta";
  return (
    <Tooltip title={title}>
      <IconButton
        className="copy-message speak-message"
        data-phase={current?.phase}
        size="small"
        aria-label="Ouvir resposta"
        color={current ? "primary" : "default"}
        onClick={() => speech.speakMessage(id, text)}
      >
        {current?.phase === "preparing" ? <CircularProgress size={13} thickness={5} sx={{ fontSize: 13 }} /> : <VolumeUpRounded />}
      </IconButton>
    </Tooltip>
  );
}
