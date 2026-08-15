/** Normaliza texto para comparação tolerante a acentos/caixa/pontuação. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

export type VoiceCommand =
  | { type: "send" }
  | { type: "nextChat" }
  | { type: "previousChat" }
  | { type: "openAgent"; name: string }
  | null;

/**
 * Interpreta a última fala (transcript final do reconhecimento) como comando
 * de voz, se for um. Retorna null para fala normal (vira mensagem).
 */
export function parseVoiceCommand(utterance: string): VoiceCommand {
  const t = normalizeText(utterance);
  if (!t) return null;
  if (/^(remeter|enviar)$/.test(t)) return { type: "send" };
  if (/^(proximo|proxima|avancar|seguinte)\s+(chat|conversa)$/.test(t)) return { type: "nextChat" };
  if (/^(chat|conversa)\s+(anterior|voltar)$/.test(t)) return { type: "previousChat" };
  const open = t.match(/^(abrir|abra|ir para|vai para|conversar com|trocar para|mudar para)\s+(.+)$/);
  if (open) return { type: "openAgent", name: open[2].trim() };
  return null;
}
