import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { JsonGrid, LayoutContainer, LayoutItem, useBibliotecaTheme } from "@alexandretorqueti/biblioteca-global-ui";
import {
  AddRounded, AutoAwesomeRounded, CallSplitRounded, ChatBubbleOutlineRounded, ChevronRightRounded,
  ContentCopyRounded, DarkModeRounded, DataObjectRounded, DeleteOutlineRounded, EditRounded, GroupRounded, HubRounded, InfoOutlined, KeyboardArrowDownRounded, LightModeRounded, MoreVertRounded, PsychologyRounded,
  RefreshRounded, SendRounded, SettingsRounded, SmartToyOutlined, StopCircleRounded,
  TerminalRounded,
} from "@mui/icons-material";
import {
  Alert, Avatar, Box, Button, Chip, CircularProgress, ClickAwayListener, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, IconButton,
  LinearProgress, Menu, MenuItem, Paper, Select, Stack, Switch, TextField, Tooltip, Typography,
} from "@mui/material";
import { api, type ApiAgent, type ApiAgentContextFile, type ApiMessage, type ApiModel, type ApiSession, type GatewayStatus } from "./api";
import { GroupsPanel, GroupChatPane, GroupFormDialog, ManageAgentsDialog, useAgentGroups } from "./AgentGroups";

const colors = ["#7c6df2", "#24b47e", "#f0a23a", "#4c9ffe", "#e06c9f", "#27b4c8"];
type ConsoleView = "conversations" | "agents" | "groups";
const navigation = [
  { icon: <ChatBubbleOutlineRounded />, label: "Conversas", view: "conversations" as const },
  { icon: <SmartToyOutlined />, label: "Agentes", view: "agents" as const },
  { icon: <GroupRounded />, label: "Grupos", view: "groups" as const },
  { icon: <HubRounded />, label: "Workflows" },
  { icon: <DataObjectRounded />, label: "Contratos" },
  { icon: <TerminalRounded />, label: "Modelos" },
];

function agentColor(agent: ApiAgent) {
  let hash = 0;
  for (const char of agent.id) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}
function contextPercent(session?: ApiSession): number | undefined {
  if (!session) return undefined;
  return Math.min(100, Math.max(0, Math.round(session.contextPercent ?? 0)));
}
function formatTokens(value?: number, compact = false) { if (value === undefined) return "—"; return new Intl.NumberFormat("pt-BR", compact ? { notation: "compact", maximumFractionDigits: 1 } : undefined).format(value); }
function truncateLabel(value: string, maximum = 38) { return value.length <= maximum ? value : `${value.slice(0, maximum - 1).trimEnd()}…`; }
function suggestSessionName(firstMessage: string): string | undefined {
  const clean = firstMessage.replace(/^\/\w+\s*/i, "").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const stopWords = new Set(["como", "quero", "preciso", "faça", "faz", "me", "para", "por", "de", "da", "do", "um", "uma", "o", "a", "em", "com", "vou", "pode", "poderia", "ajuda", "pode" ]);
  const words = clean.split(" ").filter((word) => word.length > 2 && !stopWords.has(word.toLowerCase())).slice(0, 5);
  if (!words.length) return truncateLabel(clean.replace(/\s+/g, " "), 40);
  return truncateLabel(words.join(" "), 40);
}
function formatModelSize(sizeBytes?: number) { return sizeBytes === undefined ? undefined : `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(sizeBytes / 1_000_000_000)} GB`; }
function contextLabel(session?: ApiSession) { const percent = contextPercent(session); if (percent === undefined) return "—"; return `${percent}% · ${session?.contextTokens === undefined ? "total desconhecido" : `${formatTokens(session.contextTokens, true)} tokens`}`; }
function agentIdFromSessionKey(key: string, fallback?: string) { return key.startsWith("agent:") ? key.split(":")[1] || fallback : fallback; }
function sessionAgentId(session: ApiSession) { return agentIdFromSessionKey(session.key, session.agentId) ?? session.agentId; }
function displayModel(session?: ApiSession, agent?: ApiAgent) {
  const model = session?.model ?? agent?.model;
  if (!model) return "modelo padrão";
  if (!session?.modelProvider || model.includes("/")) return model;
  return `${session.modelProvider}/${model}`;
}
function relativeTime(value?: number) {
  if (!value) return "sem data";
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  if (minutes < 1440) return `há ${Math.round(minutes / 60)} h`;
  return `há ${Math.round(minutes / 1440)} d`;
}
function messageText(message: ApiMessage) {
  return message.content || "";
}
function clientId() { return globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function BrandRail({ view, onNavigate }: { view: ConsoleView; onNavigate: (view: ConsoleView) => void }) {
  return <Box className="brand-rail">
    <Box className="brand-mark">C</Box>
    <Stack spacing={1.2} alignItems="center" sx={{ mt: 3 }}>
      {navigation.map((item) => <Tooltip title={item.label} placement="right" key={item.label}>
        <IconButton className={item.view === view ? "rail-button active" : "rail-button"} disabled={!item.view} onClick={() => item.view && onNavigate(item.view)}>{item.icon}</IconButton>
      </Tooltip>)}
    </Stack>
    <Box sx={{ flex: 1 }} />
    <IconButton className="rail-button"><SettingsRounded /></IconButton>
    <Avatar sx={{ width: 34, height: 34, fontSize: 13, bgcolor: "#5d50d6", mt: 1.5 }}>AT</Avatar>
  </Box>;
}

function ChatsPanel({ agents, selectedAgentId, onAgentSelect, sessions, selected, loading, loadingMore, hasMore, onSelect, onCreate, onLoadMore, onRename, onDelete, onShowDetails, onClose }: {
  agents: ApiAgent[]; selectedAgentId: string; onAgentSelect: (agentId: string) => void; sessions: ApiSession[]; selected?: ApiSession;
  loading: boolean; loadingMore: boolean; hasMore: boolean;
  onSelect: (session: ApiSession) => void; onCreate: () => void; onLoadMore: () => void;
  onRename: (session: ApiSession) => void; onDelete: (session: ApiSession) => void; onShowDetails: (session: ApiSession) => void;
  onClose?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null); const sentinelRef = useRef<HTMLDivElement>(null);
  const [menuFor, setMenuFor] = useState<ApiSession | null>(null); const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [miniFor, setMiniFor] = useState<ApiSession | null>(null); const [miniPos, setMiniPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { const sentinel = sentinelRef.current; if (!sentinel || !hasMore || loading || loadingMore) return; const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) onLoadMore(); }, { root: panelRef.current, rootMargin: "120px" }); observer.observe(sentinel); return () => observer.disconnect(); }, [hasMore, loading, loadingMore, onLoadMore]);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  return <Box className="chats-panel" ref={panelRef}>
    <Box className="chats-brand"><Box className="brand-mark">C</Box><Typography variant="h6" sx={{ flex: 1 }}>Global IA</Typography>{onClose && <IconButton size="small" className="chats-close" onClick={onClose} aria-label="Fechar conversas"><ChevronRightRounded fontSize="small" /></IconButton>}</Box>
    <Select size="small" className="chats-agent-select" value={selectedAgentId} onChange={(event) => onAgentSelect(String(event.target.value))} renderValue={(value) => { const agent = agents.find((a) => a.id === value); return agent ? `${agent.emoji ?? "🤖"} ${agent.name}` : value; }}>
      {agents.map((agent) => <MenuItem key={agent.id} value={agent.id}>{agent.emoji ?? "🤖"} {agent.name}</MenuItem>)}
    </Select>
    <Button className="new-chat-button" startIcon={<AddRounded />} disabled={!selectedAgent} onClick={onCreate}>Novo chat</Button>
    <Typography variant="overline" className="chats-section-title">Chats</Typography>
    {loading && <LinearProgress className="chats-loading-progress" />}
    <Box className="chat-list">{sessions.map((session) => {
      const name = session.label ?? session.title ?? session.key;
      return <Box key={session.key} className={selected?.key === session.key ? "chat-item selected" : "chat-item"} onClick={() => onSelect(session)}>
        <Typography className="chat-name" title={name}>{name}</Typography>
        <IconButton className="chat-more" size="small" onClick={(event) => { event.stopPropagation(); setMenuFor(session); setMenuAnchor(event.currentTarget); }} aria-label="Opções da conversa"><MoreVertRounded /></IconButton>
      </Box>; })}
      {!loading && !sessions.length && <Box className="chat-empty">Nenhum chat deste agente.</Box>}
    </Box>
    <Box ref={sentinelRef} className="chats-more-sentinel">{loadingMore && <><CircularProgress size={18} /><Typography variant="caption">Carregando mais…</Typography></>}</Box>
    <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => { setMenuAnchor(null); setMenuFor(null); }}>
      <MenuItem onClick={() => { if (menuFor) onRename(menuFor); setMenuAnchor(null); setMenuFor(null); }}><EditRounded fontSize="small" sx={{ mr: 1 }} />Editar</MenuItem>
      <MenuItem onClick={() => { if (menuFor) onDelete(menuFor); setMenuAnchor(null); setMenuFor(null); }}><DeleteOutlineRounded fontSize="small" sx={{ mr: 1 }} color="error" />Excluir</MenuItem>
      <MenuItem onClick={() => { if (menuFor) { setMiniFor(menuFor); setMiniPos(menuAnchor ? { x: menuAnchor.getBoundingClientRect().right, y: menuAnchor.getBoundingClientRect().top } : null); } setMenuAnchor(null); setMenuFor(null); }}><InfoOutlined fontSize="small" sx={{ mr: 1 }} />Detalhes</MenuItem>
    </Menu>
    {miniFor && miniPos && <ClickAwayListener onClickAway={() => { setMiniFor(null); setMiniPos(null); }}><Box className="session-mini-modal" sx={{ left: miniPos.x + 10, top: Math.max(8, miniPos.y - 10) }}>
      <Typography variant="overline" className="section-muted">Detalhes</Typography>
      <Box className="mini-detail-row"><Typography variant="caption" className="detail-label">Modelo</Typography><Typography variant="body2">{displayModel(miniFor, selectedAgent)}</Typography></Box>
      <Box className="mini-detail-row"><Typography variant="caption" className="detail-label">Tempo de uso</Typography><Typography variant="body2">{relativeTime(miniFor.updatedAt ?? miniFor.createdAt)}</Typography></Box>
      <Box className="mini-detail-row"><Typography variant="caption" className="detail-label">Tokens</Typography><Typography variant="body2">{contextPercent(miniFor) === undefined ? "—" : `${contextPercent(miniFor)}%`}</Typography></Box>
      <Box className="mini-context-bar"><LinearProgress variant="determinate" value={contextPercent(miniFor) ?? 0} color={(contextPercent(miniFor) ?? 0) > 70 ? "warning" : "primary"} /><Typography variant="caption">{contextPercent(miniFor) === undefined ? "—" : `${contextPercent(miniFor)}%`}</Typography></Box>
      <Button size="small" sx={{ mt: 1.2 }} onClick={() => { onShowDetails(miniFor); setMiniFor(null); setMiniPos(null); }}>Ver detalhes completos</Button>
    </Box></ClickAwayListener>}
  </Box>;
}

const MessageBubble = memo(function MessageBubble({ message, agent }: { message: ApiMessage; agent: ApiAgent }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  if (isSystem) return <Box className="system-message"><CallSplitRounded /><Box><Typography variant="caption">{messageText(message)}</Typography></Box></Box>;
  return <Box className={isUser ? "message-row user" : "message-row"}>
    {!isUser && <Avatar sx={{ bgcolor: `${agentColor(agent)}25`, border: `1px solid ${agentColor(agent)}55` }}>{agent.emoji ?? "🤖"}</Avatar>}
    <Box className={isUser ? "message-bubble user" : "message-bubble"}><Stack direction="row" justifyContent="space-between" spacing={3}>
      <Typography variant="subtitle2">{message.author ?? (isUser ? "Alexandre" : agent.name)}</Typography>
      <Stack direction="row" spacing={0.3} alignItems="center"><Typography variant="caption" color="text.secondary">{message.timestamp ? new Date(message.timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""}</Typography>{!isUser && <Tooltip title={copied ? "Copiado" : "Copiar resposta"}><IconButton className="copy-message" size="small" aria-label="Copiar resposta" onClick={() => void copyText(messageText(message)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); })}><ContentCopyRounded /></IconButton></Tooltip>}</Stack>
    </Stack><Typography variant="body2" className="message-content">{messageText(message)}</Typography></Box>
  </Box>;
});
async function copyText(value: string) { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; } const area = document.createElement("textarea"); area.value = value; area.style.position = "fixed"; area.style.opacity = "0"; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove(); }

type DisplayMessage = { kind: "message"; message: ApiMessage } | { kind: "activity"; id: string; messages: ApiMessage[] } | { kind: "thinking"; id: string; content: string };
function groupDisplayMessages(messages: ApiMessage[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  for (const message of messages) {
    if (message.thinking) result.push({ kind: "thinking", id: `thinking-${message.id}`, content: message.thinking });
    if (!message.content && message.role === "assistant") continue;
    if (message.role !== "tool") { result.push({ kind: "message", message }); continue; }
    const previous = result[result.length - 1];
    if (previous?.kind === "activity") previous.messages.push(message);
    else result.push({ kind: "activity", id: `activity-${message.id}`, messages: [message] });
  }
  return result;
}
function ThinkingActivity({ content }: { content: string }) {
  return <details className="thinking-activity"><summary><PsychologyRounded /><Box><Typography variant="caption" fontWeight={700}>Pensando</Typography><Typography variant="caption" color="text.secondary">Raciocínio disponibilizado pelo modelo</Typography></Box></summary><Typography component="pre" variant="caption">{content}</Typography></details>;
}
function TechnicalActivity({ messages }: { messages: ApiMessage[] }) {
  const containerRef = useRef<HTMLDetailsElement>(null);
  const tools = [...new Set(messages.flatMap((message) => message.toolName?.split(",").map((name) => name.trim()).filter(Boolean) ?? []))];
  const errors = messages.filter((message) => message.status === "error").length;
  const results = messages.filter((message) => message.status === "completed" || message.status === "error").length;
  const operations = results || messages.filter((message) => message.status === "requested").length || messages.length;
  return <details ref={containerRef} onToggle={(event) => { if (!event.currentTarget.open) event.currentTarget.querySelectorAll(".technical-entry[open]").forEach((entry) => entry.removeAttribute("open")); }} className={errors ? "technical-activity has-error" : "technical-activity"}>
    <summary><TerminalRounded /><Box className="technical-summary"><Typography variant="caption" fontWeight={700}>Atividade técnica · {operations} {operations === 1 ? "operação" : "operações"}</Typography><Typography variant="caption" color="text.secondary">{tools.slice(0, 4).join(" · ") || "processamento interno"}{tools.length > 4 ? ` +${tools.length - 4}` : ""}</Typography></Box><Chip size="small" color={errors ? "error" : "default"} label={errors ? `${errors} erro${errors > 1 ? "s" : ""}` : "Concluída"} /></summary>
    <Box className="technical-details">{messages.map((message) => <details className={message.status === "error" ? "technical-entry error" : "technical-entry"} key={message.id}><summary><Box><Typography variant="caption" fontWeight={700}>{message.toolName ?? "ferramenta"}</Typography><Typography variant="caption" color="text.secondary">{toolActivityPreview(message)}</Typography></Box><Typography variant="caption" color={message.status === "error" ? "error" : "text.secondary"}>{message.status === "requested" ? "comando" : message.status === "error" ? "erro" : "retorno"}</Typography></summary><Box className="technical-entry-content"><ToolActivityContent message={message} /></Box></details>)}</Box>
  </details>;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}
function toolRequest(message: ApiMessage): { command: string; details?: unknown } | undefined {
  if (message.status !== "requested" || !message.content) return undefined;
  const lineBreak = message.content.indexOf("\n");
  const raw = lineBreak >= 0 ? message.content.slice(lineBreak + 1).trim() : "";
  const input = parseJson(raw) as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { command: message.content };
  const tool = message.toolName?.split(",")[0]?.trim() ?? "ferramenta";
  const command = tool === "exec" && typeof input.command === "string" ? input.command
    : tool === "read" && typeof input.path === "string" ? `Ler ${input.path}${input.offset ? ` a partir da linha ${input.offset}` : ""}`
    : (tool === "edit" || tool === "write" || tool === "apply_patch") && typeof input.path === "string" ? `${tool === "write" ? "Gravar" : "Editar"} ${input.path}`
    : tool === "web_search" && typeof input.query === "string" ? `Buscar na web: ${input.query}`
    : tool === "web_fetch" && typeof input.url === "string" ? `Acessar ${input.url}`
    : tool === "browser" ? `${String(input.action ?? "ação")} ${String(input.url ?? input.targetUrl ?? input.targetId ?? "")}`.trim()
    : `${tool} ${Object.entries(input).slice(0, 2).map(([key, value]) => `${key}=${typeof value === "string" ? value : "…"}`).join(" ")}`.trim();
  const details = Object.fromEntries(Object.entries(input).filter(([key]) => !["command", "path", "query", "url", "targetUrl", "action"].includes(key)));
  return { command, ...(Object.keys(details).length ? { details } : {}) };
}
function StructuredValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <Typography variant="caption" color="text.secondary">—</Typography>;
  if (typeof value !== "object") return <Typography component="pre" variant="caption">{String(value)}</Typography>;
  const rows = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value);
  return <Box className="structured-value">{rows.slice(0, 30).map(([key, item]) => <Box className="structured-row" key={key}><Typography variant="caption" className="structured-key">{key}</Typography>{typeof item === "object" && item !== null ? <StructuredValue value={item} /> : <Typography component="pre" variant="caption">{String(item ?? "—")}</Typography>}</Box>)}{rows.length > 30 && <Typography variant="caption" color="text.secondary">Mais {rows.length - 30} itens…</Typography>}</Box>;
}
function ToolActivityContent({ message }: { message: ApiMessage }) {
  const request = toolRequest(message);
  if (request) return <Box className="tool-command"><Typography component="code" variant="caption">{request.command}</Typography>{request.details !== undefined && <StructuredValue value={request.details} />}</Box>;
  if (!message.content) return null;
  const parsed = parseJson(message.content);
  return parsed === undefined ? <Typography component="pre" variant="caption">{message.content}</Typography> : <StructuredValue value={parsed} />;
}
function toolActivityPreview(message: ApiMessage) {
  const request = toolRequest(message);
  const value = request?.command ?? message.content.split("\n").find(Boolean) ?? "Sem detalhes";
  return value.length > 110 ? `${value.slice(0, 107)}…` : value;
}

type SendShortcut = "enter" | "ctrl-enter";
// Região mínima considerada "fim da lista": só autoscrolla quando o scroll
// já estiver colado no final (menos de ~0.5cm). Se o usuário subir 1cm, para.
const NEAR_BOTTOM_PX = 32;
function ChatPane({ agent, session, messages, loading, processing, streamText, sendShortcut, models, initialDraft = "", onDraftChange, mobile = false, onToggleChats, onShortcutChange, onSend, onAbort, onFork, onShowDetails }: {
  agent?: ApiAgent; session?: ApiSession; messages: ApiMessage[]; loading: boolean; processing: boolean; streamText: string; sendShortcut: SendShortcut;
  models: ApiModel[]; initialDraft?: string; onDraftChange: (text: string) => void; mobile?: boolean; onToggleChats: () => void; onShortcutChange: (shortcut: SendShortcut) => void; onSend: (message: string) => Promise<void>; onAbort: () => Promise<void>; onFork: () => void; onShowDetails: () => void;
}) {
  // O rascunho sobrevive à troca de chat/agente: o estado inicial vem do mapa de
  // rascunhos do ConsoleApp (por sessão) e toda alteração é propagada de volta.
  const [draft, setDraft] = useState(initialDraft);
  // Ref espelho do rascunho, sempre atualizado no render: o debounce do Enter lê
  // daqui (e não do closure do render), evitando estado obsoleto/draft vazio.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const updateDraft = (value: string) => { setDraft(value); onDraftChange(value); clearEnterDebounce(); };
  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaInputRef = useRef<HTMLInputElement | null>(null);
  // Timer do "Enter com debounce": no modo ctrl-enter, Enter quebra linha; se o
  // usuário não digitar mais nada em 1s, a mensagem é enviada automaticamente.
  const enterDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearEnterDebounce = useCallback(() => { if (enterDebounceRef.current) { clearTimeout(enterDebounceRef.current); enterDebounceRef.current = undefined; } }, []);
  useEffect(() => clearEnterDebounce, [clearEnterDebounce]);
  // Política ÚNICA de rolagem: "grudar no fundo". Toda sessão abre no final
  // (stick=true) e o próprio evento de scroll mantém o estado — rolar para cima
  // desliga o acompanhamento, voltar ao fundo religa. Sem posições salvas em mapa,
  // sem efeitos concorrentes: uma única escrita de scrollTop por atualização de
  // conteúdo, em useLayoutEffect (antes do paint), o que elimina pulos e tremidas.
  const stickToBottomRef = useRef(true);
  const [showJumpToEnd, setShowJumpToEnd] = useState(false);
  // busy = processando OU com run ativo segundo o Gateway (hasActiveRun chega via
  // eventos de sessão e reconciliação periódica — o envio nunca trava por estado
  // local obsoleto, ex.: evento "final" perdido numa reconexão do SSE).
  const busy = processing || Boolean(session?.hasActiveRun);
  // Ref espelho de "ocupado", para o debounce ler o valor vivo no disparo do timer.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const handleScroll = useCallback((list: HTMLDivElement) => {
    const distance = list.scrollHeight - list.clientHeight - list.scrollTop;
    const atBottom = distance < NEAR_BOTTOM_PX;
    stickToBottomRef.current = atBottom;
    setShowJumpToEnd((current) => { const next = !atBottom && list.scrollHeight > list.clientHeight; return current === next ? current : next; });
  }, []);

  useLayoutEffect(() => {
    if (loading) return;
    const list = listRef.current;
    if (!list || !stickToBottomRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [loading, messages, streamText]);

  const jumpToEnd = useCallback(() => { const list = listRef.current; if (!list) return; stickToBottomRef.current = true; list.scrollTop = list.scrollHeight; setShowJumpToEnd(false); }, []);

  const submitDraft = async () => {
    clearEnterDebounce();
    // Lê sempre o valor vivo via refs — seguro para o debounce (setTimeout) chamar
    // sem depender de closure de render.
    const text = (draftRef.current || "").trim();
    if (!text || busyRef.current || loading) return;
    setDraft("");
    onDraftChange("");
    stickToBottomRef.current = true;
    setShowJumpToEnd(false);
    await onSend(text);
  };
  const sendForm = async (event: FormEvent) => {
    event.preventDefault();
    await submitDraft();
    // Retorna o foco para o textarea após enviar
    requestAnimationFrame(() => { textareaInputRef.current?.focus(); });
  };

  if (!agent || !session) return <Box className="empty-chat"><AutoAwesomeRounded /><Typography variant="h6">Escolha uma sessão</Typography><Typography color="text.secondary">Abra uma conversa existente ou inicie uma nova.</Typography></Box>;

  const streamMessage = streamText ? { id: "live-stream", role: "assistant" as const, author: agent.name, content: streamText } : undefined;
  // Quando a última mensagem persistida já contém exatamente o texto em streaming,
  // ela assume a key fixa "live-stream" e a bolha avulsa não é renderizada: o React
  // reutiliza o mesmo DOM na transição streaming → histórico, sem piscada.
  const tailMatchesStream = Boolean(streamMessage) && (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "tool") continue;
      return message.role === "assistant" && message.content.trim() === streamText.trim();
    }
    return false;
  })();
  const tailReusesStreamKey = !streamMessage || tailMatchesStream;
  // useMemo: o agrupamento e os elementos da lista só são refeitos quando as
  // mensagens mudam de fato — os deltas do stream NÃO re-renderizam a lista,
  // apenas a bolha de streaming (fora do useMemo).
  const messageItems = useMemo(() => {
    const display = groupDisplayMessages(messages);
    let lastMessageIndex = -1;
    for (let index = display.length - 1; index >= 0; index -= 1) if (display[index].kind === "message") { lastMessageIndex = index; break; }
    return display.map((item, index) => {
      if (item.kind === "activity") return <TechnicalActivity key={item.id} messages={item.messages} />;
      if (item.kind === "thinking") return <ThinkingActivity key={item.id} content={item.content} />;
      const key = index === lastMessageIndex && tailReusesStreamKey ? "live-stream" : item.message.id;
      return <MessageBubble key={key} message={item.message} agent={agent} />;
    });
  }, [messages, agent, tailReusesStreamKey]);

  return <Box className="chat-pane"><Box className="chat-header"><Box className="chat-header-title"><Stack direction="row" spacing={1} alignItems="center"><Tooltip title={mobile ? "Abrir conversas" : "Ocultar/mostrar conversas"}><IconButton size="small" className="toggle-chats" onClick={onToggleChats}><ChatBubbleOutlineRounded fontSize="small" /></IconButton></Tooltip><Typography variant="h6">{session.title ?? session.label ?? "Sessão"}</Typography></Stack>
    <Typography variant="caption" color="text.secondary">{agent.name} · {session.key}</Typography></Box>
    <Stack direction="row" spacing={0.6} alignItems="center" className="chat-header-controls">
      <Tooltip title={session.contextTokens === undefined ? "Tamanho total do contexto indisponível" : `${formatTokens(session.totalTokens)} de ${formatTokens(session.contextTokens)} tokens utilizados`}><Chip size="small" variant="outlined" label={`Contexto ${contextLabel(session)}`} /></Tooltip>
      <Tooltip title="Detalhes da sessão"><IconButton size="small" onClick={onShowDetails}><DataObjectRounded fontSize="small" /></IconButton></Tooltip>
      {busy && <Tooltip title="Interromper"><IconButton color="error" size="small" onClick={() => void onAbort()}><StopCircleRounded /></IconButton></Tooltip>}
      <Tooltip title="Criar fork"><IconButton size="small" onClick={onFork}><CallSplitRounded fontSize="small" /></IconButton></Tooltip>
    </Stack></Box>
    <Box sx={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}><Box className="message-list" ref={listRef} onScroll={(event) => handleScroll(event.currentTarget)}>
      {loading && messages.length === 0 && !streamText ? <Box className="loading-chat"><CircularProgress size={28} /></Box> : messageItems}
      {streamMessage && !tailMatchesStream && <MessageBubble key="live-stream" message={streamMessage} agent={agent} />}
    </Box>
      {showJumpToEnd && <Tooltip title="Ir para o final"><IconButton aria-label="Ir para o final" onClick={jumpToEnd} sx={{ position: "absolute", right: 12, bottom: 12, bgcolor: "background.paper", boxShadow: 2, "&:hover": { bgcolor: "action.hover" } }}><KeyboardArrowDownRounded /></IconButton></Tooltip>}</Box>
    <Box component="form" onSubmit={sendForm} className="composer-wrap"><Paper className="composer" elevation={0}><TextField inputRef={textareaInputRef} multiline maxRows={5} fullWidth placeholder={loading ? "Carregando histórico…" : busy ? `Escreva aqui (o envio só habilita quando ${agent.name} terminar)…` : `Conversar com ${agent.name} nesta sessão…`} disabled={false} value={draft} onChange={(e) => updateDraft(e.target.value)} minRows={2} variant="standard" InputProps={{ disableUnderline: true }} onKeyDown={(event) => {
      // Regra única de envio, fiel ao atalho configurado:
      //  - "enter": Enter envia; Shift+Enter quebra linha.
      //  - "ctrl-enter": Ctrl/Cmd+Enter envia; Enter quebra linha.
      // Durante a resposta (busy) o atalho de envio vira quebra de linha, permitindo
      // adiantar o próximo texto — mas o envio em si nunca fica "inalcançável": no
      // modo ctrl-enter, Ctrl+Enter envia assim que o agente termina.
      //
      // Modo ctrl-enter + Enter simples: insere quebra de linha e arma um debounce
      // de 1s — se o usuário parar de digitar, a mensagem é enviada sozinha.
      // NÃO dependemos de event.nativeEvent.isComposing para decidir: alguns
      // teclados/Android deixam isComposing=true mesmo em Enter simples, o que
      // impedia o debounce de armar ("enter não envia").
      if (event.key !== "Enter") { clearEnterDebounce(); return; }
      const modifier = event.ctrlKey || event.metaKey;
      const composing = event.nativeEvent.isComposing;
      const isSendCombination = sendShortcut === "ctrl-enter" ? modifier && !event.shiftKey : !event.shiftKey;
      if (isSendCombination) {
        clearEnterDebounce();
        if (busyRef.current || loading || composing) return; // compono/ocupado: não envia
        event.preventDefault();
        void submitDraft();
        return;
      }
      // Enter de quebra de linha (Shift+Enter sempre, ou Enter no modo ctrl-enter):
      // arma o debounce mesmo durante composição — o delay de 1s é justamente para
      // deixar o usuário seguir digitando (ou o IME confirmar) sem enviar por engano.
      if (busyRef.current || loading) { clearEnterDebounce(); return; }
      clearEnterDebounce();
      enterDebounceRef.current = setTimeout(() => { enterDebounceRef.current = undefined; void submitDraft(); }, 1000);
    }} />
      <Box className="composer-controls">
        {busy && <Box className="composer-processing" role="status" aria-live="polite"><CircularProgress size={13} thickness={5} /><Typography variant="caption">Processando</Typography></Box>}
        <Tooltip title={displayModel(session, agent)}><Select className="model-select" size="small" value={displayModel(session, agent)} onChange={(event) => { const ref = String(event.target.value); if (ref && ref !== displayModel(session, agent)) void onSend(`/model ${ref}`); }} renderValue={(value) => truncateLabel(String(value))} aria-label="Modelo da sessão"><MenuItem value={displayModel(session, agent)}>Modelo atual</MenuItem>{models.map((model) => { const ref = `${model.provider}/${model.id}`; const current = ref === displayModel(session, agent) || model.name === displayModel(session, agent); if (current) return null; return <MenuItem value={ref} key={ref}>{model.name}</MenuItem>; })}</Select></Tooltip>
        <Select className="send-shortcut" size="small" value={sendShortcut} onChange={(event) => onShortcutChange(event.target.value as SendShortcut)} aria-label="Atalho para enviar mensagem"><MenuItem value="enter">Enter envia</MenuItem><MenuItem value="ctrl-enter">Ctrl+Enter envia</MenuItem></Select>
        <IconButton type="submit" className="send-button" disabled={!draft.trim() || busy || loading}><SendRounded /></IconButton>
      </Box></Paper>
      <Typography variant="caption" color="text.secondary">A mensagem continuará a sessão real no Gateway.</Typography></Box></Box>;
}

function SessionDetailsModal({ agent, session, open, onClose }: { agent?: ApiAgent; session?: ApiSession; open: boolean; onClose: () => void }) {
  if (!agent) return null;
  const context = contextPercent(session);
  return <Dialog open={open} onClose={onClose} maxWidth={false}><Box className="details-modal-paper">
    <Box className="details-modal-header"><Box><Typography variant="overline">Contexto</Typography><Typography variant="h6">Detalhes da sessão</Typography></Box>
      <Tooltip title="Fechar"><IconButton size="small" onClick={onClose}><ChevronRightRounded /></IconButton></Tooltip></Box>
    <Paper className="agent-profile-card" elevation={0}><Avatar sx={{ width: 52, height: 52, bgcolor: `${agentColor(agent)}22`, fontSize: 24 }}>{agent.emoji ?? "🤖"}</Avatar><Box><Typography fontWeight={700}>{agent.name}</Typography><Typography variant="caption" color="text.secondary">{agent.role ?? agent.id}</Typography></Box></Paper>
    <Divider sx={{ my: 2.5 }} /><Stack spacing={2.2}><Box><Typography className="detail-label">Modelo</Typography><Typography variant="body2">{displayModel(session, agent)}</Typography></Box>
      <Box><Typography className="detail-label">Session key</Typography><Typography variant="body2" className="monospace">{session?.key ?? "—"}</Typography></Box>
      <Box><Typography className="detail-label">Session id</Typography><Typography variant="body2" className="monospace">{session?.sessionId ?? "—"}</Typography></Box>
      <Box><Typography className="detail-label">Janela de contexto</Typography><Stack direction="row" spacing={1} alignItems="center"><LinearProgress variant="determinate" value={context ?? 0} sx={{ flex: 1 }} /><Typography variant="caption">{context === undefined ? "—" : `${context}% · ${formatTokens(session?.totalTokens)} / ${formatTokens(session?.contextTokens)} tokens`}</Typography></Stack></Box></Stack>
    <Divider sx={{ my: 2.5 }} /><Typography className="detail-label">Linhagem</Typography><LayoutContainer mode="grid" columns={1} gap={1} sx={{ mt: 1 }}>
      {session?.parentSessionKey && <LayoutItem><Paper className="lineage-card" elevation={0}><Box className="lineage-icon amber"><PsychologyRounded /></Box><Box><Typography variant="caption">Origem</Typography><Typography variant="body2" className="monospace">{session.parentSessionKey}</Typography></Box></Paper></LayoutItem>}
      <LayoutItem><Paper className="lineage-card current" elevation={0}><Box className="lineage-icon green"><TerminalRounded /></Box><Box><Typography variant="caption">Sessão atual</Typography><Typography variant="body2">{session?.label ?? "Conversa"}</Typography></Box></Paper></LayoutItem></LayoutContainer>
    <DialogActions><Button onClick={onClose}>Fechar</Button></DialogActions>
  </Box></Dialog>;
}

const shortcutStorageKey = "openclaw-console-send-shortcut";
const chatsVisibleStorageKey = "openclaw-console-chats-visible";
const uiStateStorageKey = "openclaw-console-ui-state";
function loadSendShortcut(): SendShortcut { return localStorage.getItem(shortcutStorageKey) === "enter" ? "enter" : "ctrl-enter"; }
function loadChatsVisible(): boolean { return localStorage.getItem(chatsVisibleStorageKey) !== "false"; }
function loadSavedUiState(): { agentId: string; sessionKey: string } {
  try {
    const raw = localStorage.getItem(uiStateStorageKey);
    if (!raw) return { agentId: "", sessionKey: "" };
    const parsed = JSON.parse(raw) as Partial<{ agentId: string; sessionKey: string }>;
    return { agentId: typeof parsed.agentId === "string" ? parsed.agentId : "", sessionKey: typeof parsed.sessionKey === "string" ? parsed.sessionKey : "" };
  } catch { return { agentId: "", sessionKey: "" }; }
}
function GatewayOfflinePane({ status }: { status?: GatewayStatus }) {
  return <Box className="gateway-offline"><Box className="gateway-offline-icon"><HubRounded /></Box><Typography variant="h6">Gateway desconectado</Typography><Typography color="text.secondary">Sessões e conversas ficam indisponíveis até a conexão ser restabelecida.</Typography>{status?.error && <Typography variant="caption" color="error">{status.error}</Typography>}</Box>;
}

type AgentForm = { agentId?: string; name: string; workspace: string; model: string; emoji: string; avatar: string; deleteFiles: boolean };
type EditableContextFile = ApiAgentContextFile & { dirty: boolean };
const emptyAgentForm: AgentForm = { name: "", workspace: "", model: "", emoji: "🤖", avatar: "", deleteFiles: false };
function agentWorkspace(name: string, root: string) { const id = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); return id ? `${root.replace(/\/$/, "")}/workspace-${id}` : ""; }
const contextFileDescriptions: Record<ApiAgentContextFile["name"], string> = { "AGENTS.md": "Instruções operacionais", "SOUL.md": "Personalidade, tom e limites", "TOOLS.md": "Notas sobre ferramentas e ambiente", "IDENTITY.md": "Nome, identidade e avatar", "USER.md": "Perfil e preferências do usuário", "HEARTBEAT.md": "Rotina de verificações periódicas", "BOOTSTRAP.md": "Inicialização de um workspace novo", "MEMORY.md": "Memória durável do agente" };
function AgentManagement({ agents, models, status, loading, onRefresh, onError }: { agents: ApiAgent[]; models: ApiModel[]; status?: GatewayStatus; loading: boolean; onRefresh: () => Promise<void> | void; onError: (message: string) => void }) {
  const [form, setForm] = useState<AgentForm>(); const [saving, setSaving] = useState(false); const [filesLoading, setFilesLoading] = useState(false);
  const [contextFiles, setContextFiles] = useState<EditableContextFile[]>([]); const [selectedContextFile, setSelectedContextFile] = useState<ApiAgentContextFile["name"]>(); const [originalWorkspace, setOriginalWorkspace] = useState("");
  const rows = agents.map((agent) => ({ id: agent.id, nome: agent.name, emoji: agent.emoji ?? "🤖", modelo: agent.model ?? "padrão", workspace: agent.workspace ?? "padrão", principal: agent.id === "main" || agent.isDefault }));
  const defaultWorkspaceRoot = status?.defaultAgentWorkspaceRoot ?? "/data/.openclaw";
  const openCreate = () => { setForm(emptyAgentForm); setContextFiles([]); setSelectedContextFile(undefined); setOriginalWorkspace(""); };
  const openEdit = (row: Record<string, unknown>) => { const agent = agents.find((item) => item.id === row.id); if (!agent) return; const workspace = agent.workspace ?? ""; setForm({ agentId: agent.id, name: agent.name, workspace, model: agent.model ?? "", emoji: agent.emoji ?? "", avatar: agent.avatar ?? "", deleteFiles: false }); setOriginalWorkspace(workspace); setContextFiles([]); setSelectedContextFile(undefined); setFilesLoading(true); void api.agentContextFiles(agent.id).then((result) => { setOriginalWorkspace(result.workspace); setForm((current) => current?.agentId === agent.id ? { ...current, workspace: result.workspace } : current); const files = result.files.map((file) => ({ ...file, content: file.content ?? "", dirty: false })); setContextFiles(files); setSelectedContextFile(files[0]?.name); }).catch((error) => onError(error instanceof Error ? error.message : String(error))).finally(() => setFilesLoading(false)); };
  const save = async () => { if (!form?.name.trim()) return; const workspace = form.workspace.trim() || agentWorkspace(form.name, defaultWorkspaceRoot); if (!workspace) return; setSaving(true); try { if (form.agentId) { await api.updateAgent({ agentId: form.agentId, name: form.name.trim(), workspace, ...(form.model.trim() ? { model: form.model.trim() } : {}), emoji: form.emoji.trim(), ...(form.avatar.trim() ? { avatar: form.avatar.trim() } : {}) }); const workspaceChanged = workspace !== originalWorkspace; const filesToWrite = contextFiles.filter((file) => file.dirty || workspaceChanged && !file.missing).map((file) => ({ name: file.name, content: file.content ?? "" })); if (filesToWrite.length) await api.updateAgentContextFiles(form.agentId, filesToWrite); } else await api.createAgent({ name: form.name.trim(), workspace, ...(form.model.trim() ? { model: form.model.trim() } : {}), emoji: form.emoji.trim(), ...(form.avatar.trim() ? { avatar: form.avatar.trim() } : {}) }); setForm(undefined); await onRefresh(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } finally { setSaving(false); } };
  const remove = async () => { if (!form?.agentId || form.agentId === "main" || !window.confirm(`Excluir o agente “${form.name}”?${form.deleteFiles ? " O workspace e os arquivos do agente também serão removidos." : " O workspace será preservado."}`)) return; setSaving(true); try { await api.deleteAgent({ agentId: form.agentId, deleteFiles: form.deleteFiles }); setForm(undefined); await onRefresh(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } finally { setSaving(false); } };
  const activeContextFile = contextFiles.find((file) => file.name === selectedContextFile);
  const modelOptions = [...models]; const currentModelKnown = !form?.model || modelOptions.some((model) => `${model.provider}/${model.id}` === form.model || model.alias === form.model);
  return <Box className="agent-management"><Box className="management-header"><Box><Typography variant="overline">Administração</Typography><Typography variant="h5">Agentes</Typography><Typography variant="body2" color="text.secondary">Identidade, workspace e modelo dos agentes configurados.</Typography></Box><Stack direction="row" spacing={1}><Button variant="outlined" startIcon={<RefreshRounded />} onClick={onRefresh} disabled={loading}>Atualizar</Button><Button variant="contained" startIcon={<AddRounded />} onClick={openCreate} disabled={!status?.canAdmin}>Novo agente</Button></Stack></Box>
    {!status?.canAdmin && <Alert severity="warning">O Console está conectado com leitura e escrita, mas a administração de agentes exige o escopo <code>operator.admin</code>. A listagem continua disponível; inclusão e edição ficam bloqueadas até essa permissão ser aprovada no Gateway.</Alert>}
    <Paper className="agents-grid-card" elevation={0}><JsonGrid data={rows} title="Agentes configurados" loading={loading} emptyMessage="Nenhum agente configurado" searchable sortable pagination initialPageSize={10} pageSizeOptions={[10, 25, 50]} getRowId={(row) => String(row.id)} columns={{ id: { label: "ID" }, nome: { label: "Nome" }, emoji: { label: "Emoji", sortable: false, searchable: false }, modelo: { label: "Modelo" }, workspace: { label: "Workspace" }, principal: { label: "Principal", type: "boolean", searchable: false } }} {...(status?.canAdmin ? { onEdit: openEdit } : {})} /></Paper>
    <Dialog open={Boolean(form)} onClose={() => !saving && setForm(undefined)} fullWidth maxWidth="md"><DialogTitle>{form?.agentId ? `Editar ${form.name}` : "Novo agente"}</DialogTitle><DialogContent><Stack spacing={1.6} sx={{ pt: 1 }}><TextField label="Nome" value={form?.name ?? ""} onChange={(event) => setForm((current) => current && ({ ...current, name: event.target.value, ...(!current.agentId && !current.workspace ? { workspace: agentWorkspace(event.target.value, defaultWorkspaceRoot) } : {}) }))} required /><TextField label="Caminho dos arquivos de contexto" value={form?.workspace ?? ""} onChange={(event) => setForm((current) => current && ({ ...current, workspace: event.target.value }))} required helperText={`Workspace consultado pelo agente. Raiz sugerida: ${defaultWorkspaceRoot}`} /><Stack direction={{ xs: "column", sm: "row" }} spacing={1.4}><TextField label="Emoji" value={form?.emoji ?? ""} onChange={(event) => setForm((current) => current && ({ ...current, emoji: event.target.value }))} sx={{ width: { sm: 110 } }} /><TextField select label="Modelo" value={form?.model ?? ""} onChange={(event) => setForm((current) => current && ({ ...current, model: event.target.value }))} fullWidth SelectProps={{ renderValue: (value) => { const ref = String(value); if (!ref) return "Modelo padrão do Gateway"; const model = modelOptions.find((item) => `${item.provider}/${item.id}` === ref || item.alias === ref); return model ? `${truncateLabel(model.name)}${model.sizeBytes === undefined ? "" : ` (${formatModelSize(model.sizeBytes)})`}` : truncateLabel(ref); }, MenuProps: { PaperProps: { sx: { maxWidth: 620 } } } }}><MenuItem value="">Modelo padrão do Gateway</MenuItem>{!currentModelKnown && form?.model && <MenuItem value={form.model}>{form.model} (configurado atualmente)</MenuItem>}{modelOptions.map((model) => { const ref = `${model.provider}/${model.id}`; const size = formatModelSize(model.sizeBytes); return <MenuItem value={ref} key={ref} title={`${model.name} · ${ref}`}><Box sx={{ minWidth: 0, maxWidth: 560 }}><Typography noWrap>{truncateLabel(model.name)}{size ? ` (${size})` : ""}</Typography><Typography variant="caption" color="text.secondary" noWrap>{ref}{model.contextWindow ? ` · ${formatTokens(model.contextWindow, true)} tokens` : ""}{model.available === false ? " · disponibilidade não confirmada" : ""}</Typography></Box></MenuItem>; })}</TextField></Stack><TextField label="Avatar" value={form?.avatar ?? ""} onChange={(event) => setForm((current) => current && ({ ...current, avatar: event.target.value }))} placeholder="Caminho, URL ou data URI" />
      {form?.agentId && <Box className="context-files-editor"><Stack direction="row" justifyContent="space-between" alignItems="center"><Box><Typography fontWeight={700}>Arquivos de contexto</Typography><Typography variant="caption" color="text.secondary">O conteúdo é lido do workspace e sobrescrito ao salvar.</Typography></Box>{filesLoading && <CircularProgress size={20} />}</Stack>{!filesLoading && contextFiles.length > 0 && <><TextField select size="small" label="Arquivo" value={selectedContextFile ?? ""} onChange={(event) => setSelectedContextFile(event.target.value as ApiAgentContextFile["name"])} fullWidth>{contextFiles.map((file) => <MenuItem value={file.name} key={file.name}>{file.name} · {contextFileDescriptions[file.name]}{file.missing ? " · ausente" : ""}</MenuItem>)}</TextField><TextField className="context-file-content" multiline minRows={10} maxRows={20} value={activeContextFile?.content ?? ""} onChange={(event) => setContextFiles((current) => current.map((file) => file.name === selectedContextFile ? { ...file, content: event.target.value, missing: false, dirty: true } : file))} label={selectedContextFile ?? "Arquivo"} helperText={activeContextFile?.dirty ? "Alterado — será sobrescrito ao salvar" : activeContextFile?.missing ? "Arquivo ainda não existe" : `${formatTokens(activeContextFile?.size)} bytes`} /></>}{!filesLoading && !contextFiles.length && <Alert severity="warning">Nenhum arquivo de contexto foi disponibilizado pelo Gateway.</Alert>}</Box>}
      {form?.agentId && form.agentId !== "main" && <FormControlLabel control={<Switch checked={form.deleteFiles} onChange={(event) => setForm((current) => current && ({ ...current, deleteFiles: event.target.checked }))} />} label="Excluir também workspace e arquivos ao remover o agente" />}{form?.agentId === "main" && <Alert severity="info">O agente principal pode ser editado, mas nunca excluído.</Alert>}</Stack></DialogContent><DialogActions>{form?.agentId && <Button color="error" startIcon={<DeleteOutlineRounded />} disabled={saving || form.agentId === "main"} onClick={() => void remove()}>Excluir</Button>}<Box sx={{ flex: 1 }} /><Button onClick={() => setForm(undefined)} disabled={saving}>Cancelar</Button><Button variant="contained" onClick={() => void save()} disabled={saving || filesLoading || !form?.name.trim() || !form?.workspace.trim()}>{saving ? "Salvando…" : "Salvar"}</Button></DialogActions></Dialog>
  </Box>;
}

function ConsoleApp() {
  const { themeName, setThemeName } = useBibliotecaTheme();
  const [view, setView] = useState<ConsoleView>("conversations");
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [sendShortcut, setSendShortcut] = useState<SendShortcut>(loadSendShortcut); const gatewayConnectedRef = useRef(false); const statusProbeRef = useRef<Promise<boolean> | undefined>(undefined);
  const [agents, setAgents] = useState<ApiAgent[]>([]); const [models, setModels] = useState<ApiModel[]>([]); const [sessions, setSessions] = useState<ApiSession[]>([]); const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [status, setStatus] = useState<GatewayStatus>(); const [agentId, setAgentId] = useState(() => loadSavedUiState().agentId); const [sessionKey, setSessionKey] = useState(() => loadSavedUiState().sessionKey); const currentSessionKeyRef = useRef(""); const initialRestoreRef = useRef(true); const [sessionId, setSessionId] = useState<string>();
  const [loading, setLoading] = useState(true); const [sessionsLoading, setSessionsLoading] = useState(false); const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false); const [sessionsHasMore, setSessionsHasMore] = useState(false); const [sessionsNextOffset, setSessionsNextOffset] = useState(0); const [historyLoading, setHistoryLoading] = useState(false); const [error, setError] = useState("");
  const [processing, setProcessing] = useState(false); const processingBySessionRef = useRef(new Map<string, boolean>()); const [processingAgentIds, setProcessingAgentIds] = useState<Set<string>>(() => new Set());
  const [detailsModalOpen, setDetailsModalOpen] = useState(false); const [detailsForSession, setDetailsForSession] = useState<ApiSession | undefined>();
  const [chatsVisible, setChatsVisible] = useState<boolean>(loadChatsVisible);
  // Coluna fixa de conversas no modo desktop: estado separado do overlay mobile,
  // sempre inicia visível para nunca produzir uma coluna de largura 0 no grid.
  const [chatsColumnVisible, setChatsColumnVisible] = useState<boolean>(true);
  const optimisticMessagesRef = useRef(new Map<string, ApiMessage[]>());
  const draftsRef = useRef(new Map<string, string>());
  const [runId, setRunId] = useState<string>(); const [streamText, setStreamText] = useState("");
  // Guarda o último texto do stream (fallback) + o flag de terminal para a transição
  // suave: a bolha de streaming permanece visível até o histórico persistido chegar,
  // evitando o frame vazio ("piscadinha") ao terminar a escrita do agente.
  const terminalTextRef = useRef<string | undefined>(undefined);
  const selectedAgent = agents.find((agent) => agent.id === agentId); const selectedSession = sessions.find((session) => session.key === sessionKey); const selectedSessionAgentId = selectedSession ? sessionAgentId(selectedSession) : agentId; const connected = Boolean(status?.connected);
  const isNarrow = viewportWidth <= 900;
  const gridColumns = useMemo(() => {
    if (view === "agents") return `${viewportWidth <= 720 ? 58 : 68}px minmax(0, 1fr)`;
    if (view === "groups") return `${viewportWidth <= 720 ? 58 : 68}px minmax(240px, 300px) minmax(0, 1fr)`;
    if (isNarrow) return `${viewportWidth <= 720 ? 58 : 68}px minmax(0, 1fr)`;
    return `${viewportWidth <= 720 ? 58 : 68}px ${chatsColumnVisible ? "minmax(240px, 300px)" : "minmax(0, 0px)"} minmax(0, 1fr)`;
  }, [view, viewportWidth, chatsColumnVisible, isNarrow]);

  const refreshProcessingAgents = useCallback(() => { const active = new Set<string>(); for (const [key, running] of processingBySessionRef.current) { const id = agentIdFromSessionKey(key); if (running && id) active.add(id); } setProcessingAgentIds(active); }, []);
  const loadAgentActivity = useCallback(async (nextAgents: ApiAgent[]) => { const pages = await Promise.allSettled(nextAgents.map((agent) => api.sessions(agent.id, 0, 200))); pages.forEach((result, index) => { if (result.status !== "fulfilled") return; const id = nextAgents[index]?.id; if (!id) return; for (const [key] of processingBySessionRef.current) if (agentIdFromSessionKey(key) === id) processingBySessionRef.current.delete(key); for (const session of result.value.sessions) processingBySessionRef.current.set(session.key, session.hasActiveRun); }); refreshProcessingAgents(); }, [refreshProcessingAgents]);
  const loadRoot = useCallback(async () => { setLoading(true); setError(""); try { const nextStatus = await api.status(); gatewayConnectedRef.current = nextStatus.connected; setStatus(nextStatus); if (!nextStatus.connected) return; const [nextAgents, nextModels] = await Promise.all([api.agents(), api.models()]); setAgents(nextAgents); setModels(nextModels); 
    // Valida o agentId salvo: se não existe mais na lista, usa o primeiro disponível
    setAgentId((current) => {
      console.log("[loadRoot] agentId atual do state:", current, "agentes disponíveis:", nextAgents.map(a => a.id));
      const savedValid = current && nextAgents.some((a) => a.id === current);
      const result = savedValid ? current : nextAgents[0]?.id ?? "";
      console.log("[loadRoot] agentId final:", result);
      return result;
    });
    void loadAgentActivity(nextAgents); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); } }, [loadAgentActivity]);
  const setSessionProcessing = useCallback((key: string, active: boolean) => { processingBySessionRef.current.set(key, active); refreshProcessingAgents(); setSessions((current) => current.map((session) => session.key === key && session.hasActiveRun !== active ? { ...session, hasActiveRun: active } : session)); }, [refreshProcessingAgents]);
  const loadSessions = useCallback(async (nextAgentId: string, offset = 0, append = false) => { if (!nextAgentId) return; append ? setSessionsLoadingMore(true) : setSessionsLoading(true); setError(""); try { const page = await api.sessions(nextAgentId, offset, 10); const rows = page.sessions.filter((session) => sessionAgentId(session) === nextAgentId); for (const row of rows) processingBySessionRef.current.set(row.key, row.hasActiveRun); refreshProcessingAgents(); setSessions((current) => append ? [...current, ...rows.filter((row) => !current.some((existing) => existing.key === row.key))] : rows); setSessionsHasMore(page.hasMore ?? offset + page.sessions.length < (page.totalCount ?? offset + page.sessions.length)); setSessionsNextOffset(page.nextOffset ?? offset + page.sessions.length); if (!append) setSessionKey((current) => {
    console.log("[loadSessions] sessionKey atual do state:", current, "primeira sessão:", rows[0]?.key);
    return rows.some((s) => s.key === current) ? current : rows[0]?.key ?? "";
  }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { append ? setSessionsLoadingMore(false) : setSessionsLoading(false); } }, [refreshProcessingAgents]);
  const refreshSessionMetadata = useCallback(async (key: string, id: string) => { try { const page = await api.sessions(id, 0, 200); const fresh = page.sessions.find((session) => session.key === key); if (!fresh) return; processingBySessionRef.current.set(key, fresh.hasActiveRun); refreshProcessingAgents(); setSessions((current) => current.map((session) => session.key === key ? { ...session, ...fresh } : session)); } catch { /* A próxima atualização SSE ou sondagem reconciliará os metadados. */ } }, [refreshProcessingAgents]);
  const loadHistory = useCallback(async (key: string, id: string) => { if (!key || !id) return; setHistoryLoading(true); try { const history = await api.history(key, id); const pending = optimisticMessagesRef.current.get(key) ?? []; const unresolved = pending.filter((optimistic) => !history.messages.some((stored) => stored.role === "user" && stored.content === optimistic.content)); if (unresolved.length) optimisticMessagesRef.current.set(key, unresolved); else optimisticMessagesRef.current.delete(key); setMessages([...history.messages, ...unresolved]); setSessionId(history.sessionId); setStreamText(""); terminalTextRef.current = undefined; /* a resposta persistida assume a key fixa "live-stream" no render, reutilizando a mesma bolha do streaming sem remontar */ } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setHistoryLoading(false); } }, []);
  useEffect(() => { void loadRoot(); }, [loadRoot]);
  useEffect(() => { const resize = () => setViewportWidth(window.innerWidth); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  useEffect(() => { localStorage.setItem(shortcutStorageKey, sendShortcut); }, [sendShortcut]);
  useEffect(() => { localStorage.setItem(chatsVisibleStorageKey, String(chatsVisible)); }, [chatsVisible]);
  useEffect(() => { try { localStorage.setItem(uiStateStorageKey, JSON.stringify({ agentId, sessionKey })); } catch { /* armazenamento indisponível */ } }, [agentId, sessionKey]);
  useEffect(() => { currentSessionKeyRef.current = sessionKey; }, [sessionKey]);
  useEffect(() => {
    const firstLoad = initialRestoreRef.current;
    if (!firstLoad) {
      setSessions([]); setSessionKey(""); setSessionsHasMore(false); setSessionsNextOffset(0); setMessages([]);
    }
    if (agentId) {
      console.log("[useEffect agentId] chamando loadSessions para:", agentId);
      void loadSessions(agentId);
    }
  }, [agentId, loadSessions]);
  useEffect(() => { initialRestoreRef.current = false; }, []);
  useEffect(() => { 
    console.log("[useEffect sessionKey] sessionKey:", sessionKey, "selectedSession:", !!selectedSession);
    setMessages(optimisticMessagesRef.current.get(sessionKey) ?? []); 
    setSessionId(undefined); 
    setStreamText(""); 
    setRunId(undefined); 
    const active = processingBySessionRef.current.get(sessionKey) ?? Boolean(selectedSession?.hasActiveRun); 
    setProcessing(active); 
    if (sessionKey && selectedSession) {
      console.log("[useEffect sessionKey] chamando loadHistory para:", sessionKey);
      void loadHistory(sessionKey, sessionAgentId(selectedSession));
    } else {
      console.log("[useEffect sessionKey] NÃO chamando loadHistory (sessionKey ou selectedSession inválido)");
    }
  }, [sessionKey, selectedSession, loadHistory]);
  const recoverGatewayStatus = useCallback(() => { if (statusProbeRef.current) return statusProbeRef.current; const probe = (async () => { try { const nextStatus = await api.status(); const reconnected = !gatewayConnectedRef.current && nextStatus.connected; gatewayConnectedRef.current = nextStatus.connected; setStatus(nextStatus); if (reconnected) await loadRoot(); return nextStatus.connected; } catch { gatewayConnectedRef.current = false; return false; } finally { statusProbeRef.current = undefined; } })(); statusProbeRef.current = probe; return probe; }, [loadRoot]);
  useEffect(() => { let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined; const probe = async () => { const online = await recoverGatewayStatus(); if (!cancelled) timer = setTimeout(() => void probe(), online ? 30_000 : 4_000); }; timer = setTimeout(() => void probe(), 4_000); const wake = () => { if (document.visibilityState === "visible") void recoverGatewayStatus(); }; window.addEventListener("online", wake); document.addEventListener("visibilitychange", wake); return () => { cancelled = true; if (timer) clearTimeout(timer); window.removeEventListener("online", wake); document.removeEventListener("visibilitychange", wake); }; }, [recoverGatewayStatus]);
  useEffect(() => api.events({ onOpen: () => { void recoverGatewayStatus(); }, onError: () => { void recoverGatewayStatus(); }, onStatus: (nextStatus) => { const reconnected = !gatewayConnectedRef.current && nextStatus.connected; gatewayConnectedRef.current = nextStatus.connected; setStatus(nextStatus); if (reconnected) void loadRoot(); }, onSessions: (event) => { const key = event.sessionKey ?? event.session?.key; if (!key) return; if (event.reason === "delete") { setSessions((current) => current.filter((session) => session.key !== key)); processingBySessionRef.current.delete(key); refreshProcessingAgents(); if (currentSessionKeyRef.current === key) { setSessionKey(""); void loadSessions(agentId); } return; } if (!event.session) return; processingBySessionRef.current.set(key, event.session.hasActiveRun); refreshProcessingAgents(); if (event.session.agentId !== agentId) return; setSessions((current) => { const index = current.findIndex((session) => session.key === key); if (index < 0) return [event.session!, ...current]; const next = [...current]; next[index] = { ...current[index], ...event.session! }; return next; }); if (currentSessionKeyRef.current === key) setProcessing(event.session.hasActiveRun); }, onChat: (event) => { const isTerminal = event.state === "final" || event.state === "aborted" || event.state === "error"; setSessionProcessing(event.sessionKey, !isTerminal); if (event.sessionKey !== sessionKey) return; if (event.state === "delta") { setProcessing(true); const nextText = event.replace ? event.deltaText ?? "" : (terminalTextRef.current ?? "") + (event.deltaText ?? ""); terminalTextRef.current = nextText; setStreamText(nextText); }
    if (isTerminal) { const owner = agentIdFromSessionKey(sessionKey, event.agentId ?? agentId) ?? agentId; setProcessing(false); setRunId(undefined); void Promise.all([loadHistory(sessionKey, owner), refreshSessionMetadata(sessionKey, owner)]).catch(() => { setStreamText(""); terminalTextRef.current = undefined; }); window.setTimeout(() => void refreshSessionMetadata(sessionKey, owner), 800); if ("errorMessage" in event && event.errorMessage) setError(event.errorMessage); }
  } }), [sessionKey, agentId, loadHistory, loadRoot, loadSessions, recoverGatewayStatus, refreshProcessingAgents, refreshSessionMetadata, setSessionProcessing]);
  useEffect(() => { if (!processing || !sessionKey || !selectedSessionAgentId) return; let cancelled = false; let inactiveChecks = 0; let timer: ReturnType<typeof setTimeout> | undefined; const reconcile = async () => { try { const page = await api.sessions(selectedSessionAgentId, 0, 200); const current = page.sessions.find((session) => session.key === sessionKey); if (current?.hasActiveRun) inactiveChecks = 0; else if (current && ++inactiveChecks >= 2) { cancelled = true; setSessionProcessing(sessionKey, false); if (currentSessionKeyRef.current === sessionKey) { setProcessing(false); setRunId(undefined); await Promise.all([loadHistory(sessionKey, selectedSessionAgentId), refreshSessionMetadata(sessionKey, selectedSessionAgentId)]); } } } catch { /* SSE remains authoritative while reconciliation is unavailable. */ } finally { if (!cancelled) timer = setTimeout(() => void reconcile(), 5_000); } }; timer = setTimeout(() => void reconcile(), 4_000); return () => { cancelled = true; if (timer) clearTimeout(timer); }; }, [processing, sessionKey, selectedSessionAgentId, loadHistory, refreshSessionMetadata, setSessionProcessing]);
  const loadMoreSessions = useCallback(() => { if (agentId && sessionsHasMore && !sessionsLoading && !sessionsLoadingMore) void loadSessions(agentId, sessionsNextOffset, true); }, [agentId, sessionsHasMore, sessionsLoading, sessionsLoadingMore, sessionsNextOffset, loadSessions]);
  const send = async (message: string) => { if (!selectedAgent || !selectedSession) return; const targetSessionKey = selectedSession.key; const targetAgentId = sessionAgentId(selectedSession); const wasAutoNamed = /^Chat \d+$/i.test(selectedSession.label ?? selectedSession.title ?? ""); const optimistic = { id: clientId(), role: "user" as const, author: "Alexandre", timestamp: Date.now(), content: message }; optimisticMessagesRef.current.set(targetSessionKey, [...(optimisticMessagesRef.current.get(targetSessionKey) ?? []), optimistic]); terminalTextRef.current = undefined; flushSync(() => { setError(""); setSessionProcessing(targetSessionKey, true); setProcessing(true); setMessages((current) => [...current, optimistic]); }); try { const result = await api.send({ sessionKey: targetSessionKey, agentId: targetAgentId, sessionId, message }); if (currentSessionKeyRef.current === targetSessionKey && processingBySessionRef.current.get(targetSessionKey)) setRunId(result.runId); if (/^\/model(?:\s|$)/i.test(message.trim())) { window.setTimeout(() => void refreshSessionMetadata(targetSessionKey, targetAgentId), 300); window.setTimeout(() => void refreshSessionMetadata(targetSessionKey, targetAgentId), 1_200); } else if (wasAutoNamed && !/^\/(?:model|new|fork|abort)/i.test(message.trim())) { const suggested = suggestSessionName(message); if (suggested && suggested !== (selectedSession.label ?? selectedSession.title)) { try { await api.patchSession({ key: targetSessionKey, agentId: targetAgentId, label: suggested }); setSessions((current) => current.map((item) => item.key === targetSessionKey ? { ...item, label: suggested, title: suggested } : item)); } catch { /* renomeio não crítico */ } } } } catch (e) { optimisticMessagesRef.current.set(targetSessionKey, (optimisticMessagesRef.current.get(targetSessionKey) ?? []).filter((item) => item.id !== optimistic.id)); setSessionProcessing(targetSessionKey, false); if (currentSessionKeyRef.current === targetSessionKey) { setProcessing(false); setRunId(undefined); setError(e instanceof Error ? e.message : String(e)); await loadHistory(targetSessionKey, targetAgentId); } } };
  const abort = async () => { if (!selectedSession) return; await api.abort({ sessionKey: selectedSession.key, agentId: sessionAgentId(selectedSession), runId }); };
  const nextChatNumber = (targetAgentId: string) => { const existing = sessions.filter((session) => sessionAgentId(session) === targetAgentId && /^Chat \d+$/i.test(session.label ?? session.title ?? "")); const used = new Set(existing.map((session) => Number((session.label ?? session.title ?? "").match(/\d+/)?.[0] ?? 0))); let n = 1; while (used.has(n)) n += 1; return n; };
  const create = async (targetAgentId?: string) => { const target = agents.find((agent) => agent.id === (targetAgentId ?? agentId)); if (!target) return; const label = `Chat ${String(nextChatNumber(target.id)).padStart(2, "0")}`; try { const result = await api.createSession({ agentId: target.id, label }); await loadSessions(target.id); setSessionKey(result.key); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const renameSession = async (session: ApiSession) => { const label = window.prompt("Novo nome da sessão:", session.label ?? session.title)?.trim(); if (!label || label === (session.label ?? session.title)) return; try { await api.patchSession({ key: session.key, agentId: sessionAgentId(session), label }); setSessions((current) => current.map((item) => item.key === session.key ? { ...item, label, title: label } : item)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const deleteSession = async (session: ApiSession) => { if (session.hasActiveRun) return; if (!window.confirm(`Excluir definitivamente a sessão “${session.label ?? session.title}”? O histórico será arquivado pelo Gateway.`)) return; const key = session.key; try { const result = await api.deleteSession({ key, agentId: sessionAgentId(session) }); if (!result.deleted) throw new Error("O Gateway não excluiu a sessão"); if (currentSessionKeyRef.current === key) setSessionKey(""); await loadSessions(sessionAgentId(session)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const fork = async () => { if (!selectedAgent || !selectedSession) return; const label = window.prompt("Nome do fork:", `Fork · ${selectedSession.label ?? selectedSession.title ?? "sessão"}`)?.trim(); if (!label) return; try { const result = await api.forkSession({ parentSessionKey: selectedSession.key, agentId: sessionAgentId(selectedSession), label }); await loadSessions(selectedAgent.id); setSessionKey(result.key); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };

  const groupState = useAgentGroups(agents);

  return <Box className={`console-shell theme-${themeName} view-${view}${chatsVisible || chatsColumnVisible ? " chats-visible" : ""}`} style={{ gridTemplateColumns: gridColumns }}><BrandRail view={view} onNavigate={setView} />
    {view === "agents" ? <AgentManagement agents={agents} models={models} status={status} loading={loading} onRefresh={loadRoot} onError={setError} />
    : view === "groups" ? <>
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
    </>
    : <>
      {!connected ? <GatewayOfflinePane status={status} /> : <>
        {isNarrow ? (
          <>
            {chatsVisible && <Box className="chats-overlay" onClick={(event) => { if (event.target === event.currentTarget) setChatsVisible(false); }}><ChatsPanel agents={agents} selectedAgentId={agentId} onAgentSelect={setAgentId} sessions={sessions} selected={selectedSession} loading={sessionsLoading} loadingMore={sessionsLoadingMore} hasMore={sessionsHasMore}
              onSelect={(s) => { setSessionKey(s.key); setChatsVisible(false); }} onCreate={() => void create(agentId)} onLoadMore={loadMoreSessions}
              onRename={(s) => void renameSession(s)} onDelete={(s) => void deleteSession(s)} onShowDetails={(s) => { setDetailsForSession(s); setDetailsModalOpen(true); }} onClose={() => setChatsVisible(false)} /></Box>}
            <ChatPane key={selectedSession?.key ?? "empty-chat"} agent={selectedAgent} session={selectedSession} mobile onToggleChats={() => setChatsVisible((v) => !v)} messages={messages} loading={historyLoading} processing={processing} streamText={streamText} sendShortcut={sendShortcut} models={models} initialDraft={draftsRef.current.get(sessionKey) ?? ""} onDraftChange={(text) => { if (sessionKey) draftsRef.current.set(sessionKey, text); }} onShortcutChange={setSendShortcut} onSend={send} onAbort={abort} onFork={() => void fork()} onShowDetails={() => { setChatsVisible(false); setDetailsModalOpen(true); }} />
          </>
        ) : (
          <>
            {chatsColumnVisible && <ChatsPanel agents={agents} selectedAgentId={agentId} onAgentSelect={setAgentId} sessions={sessions} selected={selectedSession} loading={sessionsLoading} loadingMore={sessionsLoadingMore} hasMore={sessionsHasMore}
              onSelect={(s) => setSessionKey(s.key)} onCreate={() => void create(agentId)} onLoadMore={loadMoreSessions}
              onRename={(s) => void renameSession(s)} onDelete={(s) => void deleteSession(s)} onShowDetails={(s) => { setDetailsForSession(s); setDetailsModalOpen(true); }} />}
            <ChatPane key={selectedSession?.key ?? "empty-chat"} agent={selectedAgent} session={selectedSession} messages={messages} loading={historyLoading} processing={processing} streamText={streamText} sendShortcut={sendShortcut} models={models} initialDraft={draftsRef.current.get(sessionKey) ?? ""} onDraftChange={(text) => { if (sessionKey) draftsRef.current.set(sessionKey, text); }} onShortcutChange={setSendShortcut} onSend={send} onAbort={abort} onFork={() => void fork()} onShowDetails={() => setDetailsModalOpen(true)} onToggleChats={() => setChatsColumnVisible((v) => !v)} />
          </>
        )}
        <SessionDetailsModal agent={selectedAgent} session={detailsForSession ?? selectedSession} open={detailsModalOpen} onClose={() => setDetailsModalOpen(false)} />
      </>}
    </>}
    {error && <Alert severity="error" className="floating-error" onClose={() => setError("")}>{error}</Alert>}
    <Tooltip title={themeName === "escuro" ? "Tema claro" : "Tema escuro"}><IconButton className="theme-toggle" onClick={() => setThemeName(themeName === "escuro" ? "claro" : "escuro")}>{themeName === "escuro" ? <LightModeRounded /> : <DarkModeRounded />}</IconButton></Tooltip>
  </Box>;
}

export default function App() { return <ConsoleApp />; }
