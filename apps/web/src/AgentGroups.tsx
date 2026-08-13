import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AddRounded, AutoAwesomeRounded, ChatBubbleOutlineRounded, ChevronRightRounded,
  ContentCopyRounded, DeleteOutlineRounded, EditRounded, GroupRounded,
  MicRounded, MoreVertRounded, PersonRemoveRounded, SendRounded, SmartToyOutlined,
  StopCircleRounded,
} from "@mui/icons-material";
import {
  Alert, Avatar, Box, Button, Chip, CircularProgress, ClickAwayListener, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, IconButton, LinearProgress, Menu, MenuItem, Paper,
  Select, Stack, TextField, Tooltip, Typography,
} from "@mui/material";
import type { ApiAgent, ApiMessage } from "./api";
import { api } from "./api";

type SendShortcut = "enter" | "ctrl-enter";

// ------------------------- Ditado por voz (Web Speech API) -------------------------
type SpeechRecognitionResultLike = { isFinal: boolean; 0: { transcript: string } };
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
};
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined;
  const holder = window as Window & {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return holder.SpeechRecognition ?? holder.webkitSpeechRecognition;
}

function speechRecognitionSupported(): boolean {
  return Boolean(speechRecognitionCtor());
}

const colors = ["#7c6df2", "#24b47e", "#f0a23a", "#4c9ffe", "#e06c9f", "#27b4c8"];

function agentColor(agent: ApiAgent) {
  let hash = 0;
  for (const char of agent.id) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function clientId() {
  return globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

// Types for agent groups
export interface AgentGroup {
  id: string;
  name: string;
  description?: string;
  agentIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  senderType: "user" | "agent";
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;
}

const STORAGE_KEY = "openclaw-agent-groups";
const MESSAGES_STORAGE_PREFIX = "openclaw-group-messages-";

function loadGroups(): AgentGroup[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as AgentGroup[];
  } catch {
    return [];
  }
}

function saveGroups(groups: AgentGroup[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}

function loadGroupMessages(groupId: string): GroupMessage[] {
  try {
    const raw = localStorage.getItem(`${MESSAGES_STORAGE_PREFIX}${groupId}`);
    if (!raw) return [];
    return JSON.parse(raw) as GroupMessage[];
  } catch {
    return [];
  }
}

function saveGroupMessages(groupId: string, messages: GroupMessage[]) {
  localStorage.setItem(`${MESSAGES_STORAGE_PREFIX}${groupId}`, JSON.stringify(messages));
}

// System prompt for agents in a group
const GROUP_AGENT_SYSTEM_PROMPT = `Você está em um grupo com outros agentes. Abaixo está a conversa do grupo (mensagens do usuário e dos outros agentes, na ordem em que ocorreram).
Responda APENAS se:
- A mensagem é diretamente para você
- Você tem conhecimento/expertise relevante que falta aos outros
- Você precisa corrigir algo importante
Caso contrário, responda exatamente NO_REPLY (e nada mais) para ficar em silêncio.
Quando responder, seja conciso e direto ao ponto — não precisa se identificar, o chat já mostra seu nome.`;

const SYNC_STORAGE_PREFIX = "openclaw-group-sync-";

function loadGroupSync(groupId: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(`${SYNC_STORAGE_PREFIX}${groupId}`);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

function saveGroupSync(groupId: string, sync: Record<string, number>) {
  localStorage.setItem(`${SYNC_STORAGE_PREFIX}${groupId}`, JSON.stringify(sync));
}

function isNoiseMessage(content: string) {
  return content.startsWith("⏳") || content.startsWith("❌");
}

type AgentReply =
  | { kind: "reply"; content: string; timestamp?: number }
  | { kind: "silent" }
  | { kind: "timeout" };

// Espera o run do agente terminar e devolve a última mensagem assistant.
// "silent" = run terminou sem resposta visível (ex.: NO_REPLY suprimido pelo Gateway).
async function waitForAgentResponse(
  sessionKey: string,
  agentId: string,
  maxAttempts = 60,
): Promise<AgentReply> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const history = await api.history(sessionKey, agentId);
      const last = history.messages[history.messages.length - 1];
      if (last && last.role === "assistant" && last.content) {
        return { kind: "reply", content: last.content, timestamp: last.timestamp ?? Date.now() };
      }
      // A partir da 2ª tentativa, verifica se o run já terminou sem resposta
      // visível (ex.: o agente respondeu NO_REPLY e o Gateway suprimiu).
      if (attempt >= 1) {
        const page = await api.sessions(agentId, 0, 100);
        const session = page.sessions.find((s) => s.key === sessionKey);
        if (session && !session.hasActiveRun) return { kind: "silent" };
      }
    } catch (error) {
      console.error(`Error polling for agent ${agentId}:`, error);
    }
  }
  return { kind: "timeout" };
}

// Groups Panel (left side)
export function GroupsPanel({
  groups,
  selectedGroupId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  groups: AgentGroup[];
  selectedGroupId: string | null;
  onSelect: (group: AgentGroup) => void;
  onCreate: () => void;
  onRename: (group: AgentGroup) => void;
  onDelete: (group: AgentGroup) => void;
}) {
  const [menuFor, setMenuFor] = useState<AgentGroup | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  return (
    <Box className="chats-panel">
      <Box className="chats-brand">
        <Box className="brand-mark">C</Box>
        <Typography variant="h6" sx={{ flex: 1 }}>Grupos</Typography>
      </Box>
      <Button className="new-chat-button" startIcon={<AddRounded />} onClick={onCreate}>
        Novo grupo
      </Button>
      <Typography variant="overline" className="chats-section-title">
        Grupos de Agentes
      </Typography>
      <Box className="chat-list">
        {groups.map((group) => (
          <Box
            key={group.id}
            className={selectedGroupId === group.id ? "chat-item selected" : "chat-item"}
            onClick={() => onSelect(group)}
          >
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
              <GroupRounded sx={{ fontSize: 18, color: "text.secondary" }} />
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography className="chat-name" title={group.name}>
                  {group.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {group.agentIds.length} agente{group.agentIds.length !== 1 ? "s" : ""}
                </Typography>
              </Box>
            </Stack>
            <IconButton
              className="chat-more"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                setMenuFor(group);
                setMenuAnchor(event.currentTarget);
              }}
              aria-label="Opções do grupo"
            >
              <MoreVertRounded />
            </IconButton>
          </Box>
        ))}
        {!groups.length && (
          <Box className="chat-empty">
            <GroupRounded sx={{ fontSize: 32, opacity: 0.5, mb: 1 }} />
            <Typography variant="body2">Nenhum grupo criado.</Typography>
            <Typography variant="caption" color="text.secondary">
              Crie um grupo para conversar com múltiplos agentes.
            </Typography>
          </Box>
        )}
      </Box>
      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={() => {
          setMenuAnchor(null);
          setMenuFor(null);
        }}
      >
        <MenuItem
          onClick={() => {
            if (menuFor) onRename(menuFor);
            setMenuAnchor(null);
            setMenuFor(null);
          }}
        >
          <EditRounded fontSize="small" sx={{ mr: 1 }} />
          Editar
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor) onDelete(menuFor);
            setMenuAnchor(null);
            setMenuFor(null);
          }}
        >
          <DeleteOutlineRounded fontSize="small" sx={{ mr: 1 }} color="error" />
          Excluir
        </MenuItem>
      </Menu>
    </Box>
  );
}

// Group Chat Pane (right side)
export const GroupMessageBubble = memo(function GroupMessageBubble({
  message,
  agent,
}: {
  message: GroupMessage;
  agent?: ApiAgent;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = message.senderType === "user";

  return (
    <Box className={isUser ? "message-row user" : "message-row"}>
      {!isUser && (
        <Avatar
          sx={{
            bgcolor: agent ? `${agentColor(agent)}25` : "#5d50d625",
            border: agent ? `1px solid ${agentColor(agent)}55` : "1px solid #5d50d655",
          }}
        >
          {agent?.emoji ?? "🤖"}
        </Avatar>
      )}
      <Box className={isUser ? "message-bubble user" : "message-bubble"}>
        <Stack direction="row" justifyContent="space-between" spacing={3}>
          <Typography variant="subtitle2">{message.senderName}</Typography>
          <Stack direction="row" spacing={0.3} alignItems="center">
            <Typography variant="caption" color="text.secondary">
              {new Date(message.timestamp).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Typography>
            {!isUser && (
              <Tooltip title={copied ? "Copiado" : "Copiar resposta"}>
                <IconButton
                  className="copy-message"
                  size="small"
                  aria-label="Copiar resposta"
                  onClick={() =>
                    void copyText(message.content).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1400);
                    })
                  }
                >
                  <ContentCopyRounded />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
        </Stack>
        <Typography variant="body2" className="message-content">
          {message.content}
        </Typography>
      </Box>
    </Box>
  );
});

export function GroupChatPane({
  group,
  agents,
  messages,
  onSend,
  onManageAgents,
  sendingToAgents,
}: {
  group: AgentGroup;
  agents: ApiAgent[];
  messages: GroupMessage[];
  onSend: (content: string) => void;
  onManageAgents: () => void;
  sendingToAgents: Set<string>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendShortcut, setSendShortcut] = useState<SendShortcut>(
    () => (localStorage.getItem("openclaw-console-send-shortcut") === "enter" ? "enter" : "ctrl-enter")
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const enterDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearEnterDebounce = useCallback(() => {
    if (enterDebounceRef.current) {
      clearTimeout(enterDebounceRef.current);
      enterDebounceRef.current = undefined;
    }
  }, []);

  useEffect(() => clearEnterDebounce, [clearEnterDebounce]);

  const groupAgents = useMemo(
    () => agents.filter((agent) => group.agentIds.includes(agent.id)),
    [agents, group.agentIds],
  );

  // ---- Ditado por voz ----
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  useEffect(() => () => { recognitionRef.current?.stop(); }, []);

  const toggleListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = "pt-BR";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      let text = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) {
          let transcript = result[0].transcript;
          
          // Comandos customizados de pontuação (português)
          // Primeiro, remove espaços antes das palavras de pontuação
          transcript = transcript
            .replace(/\s+\bpar[áa]grafo\b/gi, "\n\n")
            .replace(/\s+\bdois pontos\b/gi, ":")
            .replace(/\s+\bponto e v[íi]rgula\b/gi, ";")
            .replace(/\s+\binterroga[çc][ãa]o\b/gi, "?")
            .replace(/\s+\bexclama[çc][ãa]o\b/gi, "!")
            .replace(/\s+\bv[íi]rgula\b/gi, ",")
            .replace(/\s+\bponto\b/gi, ".");
          
          // Depois, substitui as palavras que estão no início
          transcript = transcript
            .replace(/^par[áa]grafo\b/gi, "\n\n")
            .replace(/^dois pontos\b/gi, ":")
            .replace(/^ponto e v[íi]rgula\b/gi, ";")
            .replace(/^interroga[çc][ãa]o\b/gi, "?")
            .replace(/^exclama[çc][ãa]o\b/gi, "!")
            .replace(/^v[íi]rgula\b/gi, ",")
            .replace(/^ponto\b/gi, ".");
          
          // Capitaliza letra após pontuação final (. ? !) e após parágrafo
          transcript = transcript
            .replace(/([.?!])\s+([a-zà-ÿ])/g, (_m, punct, letter) => `${punct} ${letter.toUpperCase()}`)
            .replace(/\n\n\s*([a-zà-ÿ])/g, (_m, letter) => `\n\n${letter.toUpperCase()}`);
          
          // Comando para enviar mensagem
          if (/^\s*remeter\s*$/i.test(transcript)) {
            const currentText = draftRef.current.trim();
            if (currentText) {
              submitMessage();
            }
            return;
          }
          
          text += transcript;
        }
      }
      text = text.trim();
      if (!text) return;
      const current = draftRef.current;
      
      // Não adicionar espaço antes de pontuação ou quebras de linha
      const startsWithPunctuation = /^[\.,;:!?\n]/.test(text);
      const separator = startsWithPunctuation ? '' : ' ';
      
      setDraft(current.trim() ? `${current.trimEnd()}${separator}${text}` : text);
    };
    recognition.onerror = () => { recognitionRef.current = null; setListening(false); };
    recognition.onend = () => { recognitionRef.current = null; setListening(false); };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      setListening(false);
    }
  };

  const submitMessage = useCallback(() => {
    clearEnterDebounce();
    const content = draftRef.current.trim();
    if (!content || sending) return;
    setSending(true);
    onSend(content);
    setDraft("");
    setTimeout(() => setSending(false), 100);
  }, [sending, onSend, clearEnterDebounce]);

  const handleComposerKey = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter") {
        clearEnterDebounce();
        return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      const composing = event.nativeEvent.isComposing;
      const isSendCombination = sendShortcut === "ctrl-enter" ? modifier && !event.shiftKey : !event.shiftKey;

      if (isSendCombination) {
        clearEnterDebounce();
        if (sending || composing) return;
        event.preventDefault();
        submitMessage();
        return;
      }

      if (sending) {
        clearEnterDebounce();
        return;
      }
      clearEnterDebounce();
      enterDebounceRef.current = setTimeout(() => {
        enterDebounceRef.current = undefined;
        submitMessage();
      }, 1000);
    },
    [sendShortcut, sending, submitMessage, clearEnterDebounce],
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const isProcessing = sendingToAgents.size > 0;
  const processingAgents = useMemo(
    () => groupAgents.filter((a) => sendingToAgents.has(a.id)),
    [groupAgents, sendingToAgents],
  );

  return (
    <Box className="chat-pane">
      <Box className="chat-header">
        <Box className="chat-header-title">
          <Stack direction="row" spacing={1} alignItems="center">
            <Avatar sx={{ bgcolor: "#5d50d6", width: 32, height: 32, fontSize: 14 }}>
              <GroupRounded />
            </Avatar>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="h6" noWrap>
                {group.name}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {groupAgents.length} agente{groupAgents.length !== 1 ? "s" : ""}
              </Typography>
            </Box>
          </Stack>
        </Box>
        <Stack direction="row" spacing={0.6} alignItems="center" className="chat-header-controls">
          <Tooltip title="Gerenciar agentes">
            <IconButton size="small" onClick={onManageAgents} aria-label="Gerenciar agentes">
              <SmartToyOutlined fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>

      {/* Lista de agentes do grupo */}
      <Box sx={{ px: 2, py: 1, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {groupAgents.map((agent) => {
            const isAgentProcessing = sendingToAgents.has(agent.id);
            return (
              <Chip
                key={agent.id}
                avatar={
                  <Avatar sx={{ bgcolor: `${agentColor(agent)}25`, border: `1px solid ${agentColor(agent)}55` }}>
                    {agent.emoji ?? "🤖"}
                  </Avatar>
                }
                label={agent.name}
                size="small"
                sx={{
                  border: isAgentProcessing ? `1px solid ${agentColor(agent)}` : undefined,
                  animation: isAgentProcessing ? "pulse 1.5s ease-in-out infinite" : undefined,
                  "@keyframes pulse": {
                    "0%, 100%": { opacity: 1 },
                    "50%": { opacity: 0.6 },
                  },
                }}
              />
            );
          })}
          {groupAgents.length === 0 && (
            <Typography variant="caption" color="text.secondary">
              Nenhum agente no grupo
            </Typography>
          )}
        </Stack>
      </Box>

      <Box sx={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Box className="message-list" ref={scrollRef}>
          {messages.length === 0 && (
            <Box className="chat-empty-state">
              <AutoAwesomeRounded />
              <Typography variant="subtitle1">Grupo: {group.name}</Typography>
              <Typography variant="body2" color="text.secondary" textAlign="center">
                {group.description || "Envie uma mensagem para todos os agentes do grupo."}
              </Typography>
              <Typography variant="caption" color="text.secondary" textAlign="center" sx={{ mt: 1 }}>
                Agentes: {groupAgents.map((a) => a.name).join(", ") || "Nenhum agente adicionado"}
              </Typography>
            </Box>
          )}
          {messages.map((message) => (
            <GroupMessageBubble
              key={message.id}
              message={message}
              agent={groupAgents.find((a) => a.id === message.senderId)}
            />
          ))}
        </Box>
      </Box>

      <Box component="form" className="composer-wrap" onSubmit={(event) => {
        event.preventDefault();
        submitMessage();
      }}>
        <Paper className="composer" elevation={0}>
          <TextField
            multiline
            maxRows={5}
            fullWidth
            placeholder={
              groupAgents.length === 0
                ? "Adicione agentes ao grupo para começar..."
                : isProcessing
                  ? `Aguardando ${processingAgents.map((a) => a.name).join(", ")} terminar...`
                  : "Mensagem para o grupo..."
            }
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            minRows={2}
            variant="standard"
            InputProps={{ disableUnderline: true }}
            disabled={isProcessing || groupAgents.length === 0}
            autoFocus
            onKeyDown={handleComposerKey}
          />
          <Box className="composer-controls">
            <Tooltip title={!speechRecognitionSupported() ? "Ditado por voz não suportado neste navegador (use Chrome/Edge/Safari)" : listening ? "Parar ditado" : "Ditar por voz (a fala vira texto no campo)"}>
              <span>
                <IconButton
                  type="button"
                  className={listening ? "mic-button listening" : "mic-button"}
                  onClick={toggleListening}
                  disabled={!speechRecognitionSupported() || groupAgents.length === 0}
                  aria-label={listening ? "Parar ditado" : "Ditar por voz"}
                >
                  {listening ? <StopCircleRounded /> : <MicRounded />}
                </IconButton>
              </span>
            </Tooltip>
            {isProcessing && (
              <Box className="composer-processing" role="status" aria-live="polite">
                <CircularProgress size={13} thickness={5} />
                <Typography variant="caption">
                  {processingAgents.map((a) => a.emoji ?? "🤖").join("")} Processando
                </Typography>
              </Box>
            )}
            <Select
              className="send-shortcut"
              size="small"
              value={sendShortcut}
              onChange={(event) => {
                const value = event.target.value as SendShortcut;
                setSendShortcut(value);
                localStorage.setItem("openclaw-console-send-shortcut", value);
              }}
              aria-label="Atalho para enviar mensagem"
            >
              <MenuItem value="enter">Enter envia</MenuItem>
              <MenuItem value="ctrl-enter">Ctrl+Enter envia</MenuItem>
            </Select>
            <Tooltip title={isProcessing ? `Aguardando ${processingAgents.map((a) => a.name).join(", ")} terminar` : ""}>
              <span>
                <IconButton
                  type="submit"
                  className="send-button"
                  disabled={!draft.trim() || isProcessing || groupAgents.length === 0}
                  aria-label="Enviar mensagem"
                >
                  {isProcessing ? <CircularProgress size={18} /> : <SendRounded />}
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        </Paper>
        {groupAgents.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            Adicione agentes ao grupo para começar a conversar.
          </Typography>
        )}
      </Box>
    </Box>
  );
}

// Manage Agents Dialog
export function ManageAgentsDialog({
  open,
  group,
  agents,
  onClose,
  onSave,
}: {
  open: boolean;
  group: AgentGroup | null;
  agents: ApiAgent[];
  onClose: () => void;
  onSave: (agentIds: string[]) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    if (group) {
      setSelectedIds([...group.agentIds]);
    }
  }, [group]);

  const toggleAgent = (agentId: string) => {
    setSelectedIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId],
    );
  };

  const handleSave = () => {
    onSave(selectedIds);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Gerenciar Agentes</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Selecione os agentes que farão parte deste grupo.
        </Typography>
        <Stack spacing={1}>
          {agents.map((agent) => {
            const isSelected = selectedIds.includes(agent.id);
            return (
              <Paper
                key={agent.id}
                elevation={0}
                sx={{
                  p: 1.5,
                  display: "flex",
                  alignItems: "center",
                  gap: 1.5,
                  cursor: "pointer",
                  bgcolor: isSelected ? "action.selected" : "background.paper",
                  border: 1,
                  borderColor: isSelected ? "primary.main" : "divider",
                  "&:hover": { bgcolor: "action.hover" },
                }}
                onClick={() => toggleAgent(agent.id)}
              >
                <Avatar
                  sx={{
                    bgcolor: `${agentColor(agent)}25`,
                    border: `1px solid ${agentColor(agent)}55`,
                  }}
                >
                  {agent.emoji ?? "🤖"}
                </Avatar>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="subtitle2">{agent.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {agent.model || "Modelo padrão"}
                  </Typography>
                </Box>
                {isSelected && (
                  <Chip size="small" color="primary" label="No grupo" onDelete={() => toggleAgent(agent.id)} />
                )}
              </Paper>
            );
          })}
          {agents.length === 0 && (
            <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ py: 3 }}>
              Nenhum agente disponível. Crie um agente primeiro.
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancelar</Button>
        <Button onClick={handleSave} variant="contained">
          Salvar ({selectedIds.length})
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// Create/Edit Group Dialog
export function GroupFormDialog({
  open,
  group,
  onClose,
  onSave,
}: {
  open: boolean;
  group: AgentGroup | null;
  onClose: () => void;
  onSave: (name: string, description: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (group) {
      setName(group.name);
      setDescription(group.description || "");
    } else {
      setName("");
      setDescription("");
    }
  }, [group, open]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    onSave(name.trim(), description.trim());
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit}>
        <DialogTitle>{group ? "Editar Grupo" : "Novo Grupo"}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="Nome do grupo"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
              fullWidth
            />
            <TextField
              label="Descrição (opcional)"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              multiline
              rows={2}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="contained" disabled={!name.trim()}>
            {group ? "Salvar" : "Criar"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// Hook for managing agent groups state
export function useAgentGroups(agents: ApiAgent[]) {
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<AgentGroup | null>(null);
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [sendingToAgents, setSendingToAgents] = useState<Set<string>>(new Set());

  // Load groups on mount
  useEffect(() => {
    setGroups(loadGroups());
  }, []);

  // Load messages when group changes
  useEffect(() => {
    if (selectedGroupId) {
      setMessages(loadGroupMessages(selectedGroupId));
    } else {
      setMessages([]);
    }
  }, [selectedGroupId]);

  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroupId) || null,
    [groups, selectedGroupId],
  );

  // Create/Update group
  const handleSaveGroup = useCallback(
    (name: string, description: string) => {
      if (editingGroup) {
        // Update existing
        const updated = groups.map((g) =>
          g.id === editingGroup.id ? { ...g, name, description, updatedAt: Date.now() } : g,
        );
        setGroups(updated);
        saveGroups(updated);
      } else {
        // Create new
        const newGroup: AgentGroup = {
          id: clientId(),
          name,
          description,
          agentIds: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        const updated = [...groups, newGroup];
        setGroups(updated);
        saveGroups(updated);
        setSelectedGroupId(newGroup.id);
      }
      setEditingGroup(null);
    },
    [editingGroup, groups],
  );

  // Delete group
  const handleDeleteGroup = useCallback(
    (group: AgentGroup) => {
      if (!confirm(`Excluir o grupo "${group.name}"?`)) return;
      const updated = groups.filter((g) => g.id !== group.id);
      setGroups(updated);
      saveGroups(updated);
      localStorage.removeItem(`${MESSAGES_STORAGE_PREFIX}${group.id}`);
      localStorage.removeItem(`${SYNC_STORAGE_PREFIX}${group.id}`);
      if (selectedGroupId === group.id) {
        setSelectedGroupId(null);
      }
    },
    [groups, selectedGroupId],
  );

  // Update agents in group
  const handleSaveAgents = useCallback(
    (agentIds: string[]) => {
      if (!selectedGroup) return;
      const updated = groups.map((g) =>
        g.id === selectedGroup.id ? { ...g, agentIds, updatedAt: Date.now() } : g,
      );
      setGroups(updated);
      saveGroups(updated);
    },
    [selectedGroup, groups],
  );

  // Send message to all agents in group — revezamento sequencial com transcrição
  // compartilhada: cada agente recebe a conversa acumulada (incluindo as respostas
  // dos agentes que falaram antes na mesma rodada) e o próximo só é acionado
  // depois que o anterior responde. Assim todos "veem" a conversa do grupo.
  const handleSendMessage = useCallback(
    async (content: string) => {
      if (!selectedGroup || selectedGroup.agentIds.length === 0) return;
      const groupId = selectedGroup.id;
      const groupName = selectedGroup.name;

      // Atualização funcional: cada alteração parte do estado VIVO e é persistida.
      const updateMessages = (updater: (current: GroupMessage[]) => GroupMessage[]) => {
        setMessages((current) => {
          const next = updater(current);
          saveGroupMessages(groupId, next);
          return next;
        });
      };

      const markAgentDone = (agentId: string) => {
        setSendingToAgents((current) => {
          if (!current.has(agentId)) return current;
          const next = new Set(current);
          next.delete(agentId);
          return next;
        });
      };

      // Add user message
      const userMessage: GroupMessage = {
        id: clientId(),
        groupId,
        senderType: "user",
        senderId: "user",
        senderName: "Você",
        content,
        timestamp: Date.now(),
      };
      updateMessages((current) => [...current, userMessage]);

      const groupAgents = agents.filter((a) => selectedGroup.agentIds.includes(a.id));
      setSendingToAgents(new Set(selectedGroup.agentIds));

      // Pontos de sincronização: quantas mensagens do grupo cada agente já viu
      // na própria sessão do Gateway (evita reenviar histórico a cada rodada).
      const sync = loadGroupSync(groupId);

      // Espelho local do array persistido — sempre o mesmo comprimento/ordem.
      let liveMessages: GroupMessage[] = [...messages, userMessage];

      for (const agent of groupAgents) {
        const sessionKey = `agent:${agent.id}:group:${groupId}`;
        const placeholderId = clientId();

        // Delta: o que este agente ainda não viu, excluindo as próprias falas
        // (já estão na sessão dele como respostas assistant) e mensagens de ruído.
        const syncFrom = sync[agent.id] ?? 0;
        const delta = liveMessages
          .slice(syncFrom)
          .filter((m) => m.senderId !== agent.id && !isNoiseMessage(m.content));

        if (delta.length === 0) {
          sync[agent.id] = liveMessages.length;
          saveGroupSync(groupId, sync);
          markAgentDone(agent.id);
          continue;
        }

        // Placeholder visível enquanto este agente processa
        const placeholder: GroupMessage = {
          id: placeholderId,
          groupId,
          senderType: "agent",
          senderId: agent.id,
          senderName: agent.name,
          content: "⏳ Pensando...",
          timestamp: Date.now(),
        };
        updateMessages((current) => [...current, placeholder]);

        try {
          const transcript = delta
            .map((m) => `${m.senderType === "user" ? "Usuário" : m.senderName}: ${m.content}`)
            .join("\n\n");

          await api.send({
            sessionKey,
            agentId: agent.id,
            message: `[Grupo: ${groupName}]\n\n${transcript}\n\n${GROUP_AGENT_SYSTEM_PROMPT}`,
          });

          const response = await waitForAgentResponse(sessionKey, agent.id);

          if (
            response.kind === "silent" ||
            (response.kind === "reply" && /^\s*NO_REPLY\s*$/i.test(response.content))
          ) {
            // Agente escolheu ficar em silêncio — remove a bolha
            updateMessages((current) => current.filter((m) => m.id !== placeholderId));
          } else if (response.kind === "reply") {
            const agentMessage: GroupMessage = {
              id: placeholderId,
              groupId,
              senderType: "agent",
              senderId: agent.id,
              senderName: agent.name,
              content: response.content,
              timestamp: response.timestamp ?? Date.now(),
            };
            updateMessages((current) =>
              current.map((m) => (m.id === placeholderId ? agentMessage : m)),
            );
            liveMessages = [...liveMessages, agentMessage];
          } else {
            // Timeout
            const timeoutMessage: GroupMessage = {
              id: placeholderId,
              groupId,
              senderType: "agent",
              senderId: agent.id,
              senderName: agent.name,
              content: "⏳ Tempo esgotado aguardando resposta...",
              timestamp: Date.now(),
            };
            updateMessages((current) =>
              current.map((m) => (m.id === placeholderId ? timeoutMessage : m)),
            );
            liveMessages = [...liveMessages, timeoutMessage];
          }
        } catch (error) {
          console.error(`Error sending to agent ${agent.id}:`, error);
          updateMessages((current) =>
            current.map((m) =>
              m.id === placeholderId
                ? {
                    ...m,
                    content: `❌ Erro ao enviar mensagem: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
                  }
                : m,
            ),
          );
        }

        sync[agent.id] = liveMessages.length;
        saveGroupSync(groupId, sync);
        markAgentDone(agent.id);
      }
    },
    [selectedGroup, messages, agents],
  );

  return {
    groups,
    selectedGroupId,
    selectedGroup,
    messages,
    formDialogOpen,
    editingGroup,
    manageDialogOpen,
    sendingToAgents,
    setSelectedGroupId,
    setFormDialogOpen,
    setEditingGroup,
    setManageDialogOpen,
    handleSaveGroup,
    handleDeleteGroup,
    handleSaveAgents,
    handleSendMessage,
  };
}

// Main Agent Groups Management Component (for standalone use)
export function AgentGroupsManagement({
  agents,
}: {
  agents: ApiAgent[];
}) {
  const groupState = useAgentGroups(agents);

  return (
    <Box className="agent-management">
      <GroupsPanel
        groups={groupState.groups}
        selectedGroupId={groupState.selectedGroupId}
        onSelect={(group) => groupState.setSelectedGroupId(group.id)}
        onCreate={() => {
          groupState.setEditingGroup(null);
          groupState.setFormDialogOpen(true);
        }}
        onRename={(group) => {
          groupState.setEditingGroup(group);
          groupState.setFormDialogOpen(true);
        }}
        onDelete={groupState.handleDeleteGroup}
      />

      {groupState.selectedGroup ? (
        <GroupChatPane
          group={groupState.selectedGroup}
          agents={agents}
          messages={groupState.messages}
          onSend={groupState.handleSendMessage}
          onManageAgents={() => groupState.setManageDialogOpen(true)}
          sendingToAgents={groupState.sendingToAgents}
        />
      ) : (
        <Box className="agent-empty">
          <Box className="agent-empty-card">
            <GroupRounded sx={{ fontSize: 40 }} />
            <Typography variant="h6">Selecione um grupo</Typography>
            <Typography variant="body2" color="text.secondary" textAlign="center">
              Escolha um grupo na lista ou crie um novo para começar a conversar com múltiplos agentes.
            </Typography>
          </Box>
        </Box>
      )}

      <GroupFormDialog
        open={groupState.formDialogOpen}
        group={groupState.editingGroup}
        onClose={() => {
          groupState.setFormDialogOpen(false);
          groupState.setEditingGroup(null);
        }}
        onSave={groupState.handleSaveGroup}
      />

      <ManageAgentsDialog
        open={groupState.manageDialogOpen}
        group={groupState.selectedGroup}
        agents={agents}
        onClose={() => groupState.setManageDialogOpen(false)}
        onSave={groupState.handleSaveAgents}
      />
    </Box>
  );
}
