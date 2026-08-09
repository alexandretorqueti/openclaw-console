import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MutableRefObject, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { JsonGrid, LayoutContainer, LayoutItem, useBibliotecaTheme } from "@alexandretorqueti/biblioteca-global-ui";
import {
  AddRounded, AutoAwesomeRounded, CallSplitRounded, ChatBubbleOutlineRounded, ChevronLeftRounded, ChevronRightRounded,
  CircleRounded, ContentCopyRounded, DarkModeRounded, DataObjectRounded, DeleteOutlineRounded, EditRounded, HubRounded, LightModeRounded, PsychologyRounded,
  RefreshRounded, SearchRounded, SendRounded, SettingsRounded, SmartToyOutlined, StopCircleRounded,
  TerminalRounded,
} from "@mui/icons-material";
import {
  Alert, Avatar, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, IconButton, InputAdornment,
  LinearProgress, MenuItem, Paper, Select, Stack, Switch, TextField, Tooltip, Typography,
} from "@mui/material";
import { api, type ApiAgent, type ApiAgentContextFile, type ApiMessage, type ApiModel, type ApiSession, type GatewayStatus } from "./api";

const colors = ["#7c6df2", "#24b47e", "#f0a23a", "#4c9ffe", "#e06c9f", "#27b4c8"];
type ConsoleView = "conversations" | "agents";
const navigation = [
  { icon: <ChatBubbleOutlineRounded />, label: "Conversas", view: "conversations" as const },
  { icon: <SmartToyOutlined />, label: "Agentes", view: "agents" as const },
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

function AgentList({ agents, selected, processingAgents, status, loading, onSelect, onRefresh, onHide }: {
  agents: ApiAgent[]; selected?: ApiAgent; processingAgents: ReadonlySet<string>; status?: GatewayStatus; loading: boolean;
  onSelect: (agent: ApiAgent) => void; onRefresh: () => void; onHide: () => void;
}) {
  const [filter, setFilter] = useState("");
  const visible = agents.filter((agent) => `${agent.name} ${agent.id}`.toLowerCase().includes(filter.toLowerCase()));
  return <Box className="agent-panel">
    <Box className="panel-heading"><Box><Typography variant="overline">Workspace</Typography><Typography variant="h6">Agentes</Typography></Box>
      <Stack direction="row" spacing={0.3}><IconButton size="small" onClick={onRefresh} disabled={loading}><RefreshRounded /></IconButton><Tooltip title="Ocultar agentes"><IconButton size="small" onClick={onHide}><ChevronLeftRounded /></IconButton></Tooltip></Stack></Box>
    <TextField fullWidth size="small" placeholder="Buscar agente" value={filter} onChange={(e) => setFilter(e.target.value)} className="soft-input"
      InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> }} />
    {loading && <LinearProgress sx={{ mt: 1 }} />}
    <Stack spacing={0.7} sx={{ mt: 2 }}>
      {visible.map((agent) => { const color = agentColor(agent); return <Button key={agent.id} className={selected?.id === agent.id ? "agent-item selected" : "agent-item"} onClick={() => onSelect(agent)}>
        <Avatar sx={{ width: 39, height: 39, bgcolor: `${color}22`, border: `1px solid ${color}55`, fontSize: 18 }}>{agent.emoji ?? "🤖"}</Avatar>
        <Box className="agent-copy"><Stack direction="row" alignItems="center" spacing={0.8}><Typography>{agent.name}</Typography>{processingAgents.has(agent.id) && <Tooltip title="Agente processando"><CircularProgress className="agent-processing" size={14} thickness={5} /></Tooltip>}<CircleRounded className={`status-dot ${status?.connected ? "online" : "offline"}`} /></Stack>
          <Typography variant="caption">{agent.role ?? agent.model ?? agent.id}</Typography></Box><ChevronRightRounded className="agent-chevron" />
      </Button>; })}
    </Stack>
    <Paper className={`gateway-card ${status?.connected ? "connected" : "disconnected"}`} elevation={0}><Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography variant="caption">Gateway OpenClaw</Typography><Chip size="small" color={status?.connected ? "success" : "error"} label={status?.connected ? "Conectado" : "Desconectado"} />
    </Stack><Typography variant="body2" sx={{ mt: 1 }}>{status?.gatewayUrl ?? "backend/BFF"}</Typography>
      <Typography variant="caption" color="text.secondary">{status?.serverVersion ? `OpenClaw ${status.serverVersion}` : status?.connected ? "Conexão operacional" : status?.error ?? "Aguardando conexão"}</Typography></Paper>
  </Box>;
}

function SessionList({ agent, sessions, selected, loading, loadingMore, hasMore, onSelect, onCreate, onLoadMore, onRename, onDelete, onHide }: {
  agent?: ApiAgent; sessions: ApiSession[]; selected?: ApiSession; loading: boolean; loadingMore: boolean; hasMore: boolean;
  onSelect: (session: ApiSession) => void; onCreate: () => void; onLoadMore: () => void; onRename: () => void; onDelete: () => void; onHide: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null); const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const sentinel = sentinelRef.current; if (!sentinel || !hasMore || loading || loadingMore) return; const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) onLoadMore(); }, { root: panelRef.current, rootMargin: "120px" }); observer.observe(sentinel); return () => observer.disconnect(); }, [hasMore, loading, loadingMore, onLoadMore]);
  return <Box className="session-panel" ref={panelRef}><Box className="session-sticky-header"><Box className="panel-heading compact"><Box>
    <Typography variant="overline">{agent?.name ?? "Agente"}</Typography><Typography variant="h6">Sessões</Typography></Box>
    <Stack direction="row" spacing={0.2}><Tooltip title="Renomear sessão"><span><IconButton size="small" disabled={!selected} onClick={onRename}><EditRounded fontSize="small" /></IconButton></span></Tooltip><Tooltip title="Excluir sessão"><span><IconButton size="small" color="error" disabled={!selected || selected.hasActiveRun} onClick={onDelete}><DeleteOutlineRounded fontSize="small" /></IconButton></span></Tooltip><Button size="small" startIcon={<AddRounded />} variant="outlined" disabled={!agent} onClick={onCreate}>Nova</Button><Tooltip title="Ocultar sessões"><IconButton size="small" onClick={onHide}><ChevronLeftRounded /></IconButton></Tooltip></Stack></Box>
    {loading && <LinearProgress />}</Box>
    <Stack spacing={1.1}>{sessions.map((session) => { const context = contextPercent(session); return <Paper key={session.key} elevation={0} onClick={() => onSelect(session)} className={selected?.key === session.key ? "session-card selected" : "session-card"}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start"><Stack direction="row" spacing={0.8} alignItems="center"><Chip size="small" label={displayModel(session, agent)} className="project-chip" />{session.hasActiveRun && <Tooltip title="Sessão processando"><CircularProgress className="session-processing" size={15} thickness={5} /></Tooltip>}</Stack>{session.unread && <Box className="unread-dot" />}</Stack>
      <Typography className="session-title">{session.title ?? session.label ?? session.key}</Typography>
      <Stack direction="row" justifyContent="space-between" spacing={1}><Typography variant="caption" color="text.secondary">{relativeTime(session.updatedAt ?? session.createdAt)}</Typography><Tooltip title={session.contextTokens === undefined ? "Tamanho total do contexto indisponível" : `${formatTokens(session.totalTokens)} de ${formatTokens(session.contextTokens)} tokens utilizados`}><Typography variant="caption" color="text.secondary">{contextLabel(session)}</Typography></Tooltip></Stack>
      <LinearProgress variant="determinate" value={context ?? 0} color={(context ?? 0) > 70 ? "warning" : "primary"} sx={{ mt: 1.1 }} />
    </Paper>; })}</Stack>
    {!loading && !sessions.length && <Box className="empty-sessions"><PsychologyRounded /><Typography>Nenhuma sessão deste agente.</Typography></Box>}
    <Box ref={sentinelRef} className="sessions-sentinel">{loadingMore && <><CircularProgress size={18} /><Typography variant="caption">Carregando mais sessões…</Typography></>}</Box>
  </Box>;
}

function MessageBubble({ message, agent }: { message: ApiMessage; agent: ApiAgent }) {
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
}
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
function ChatPane({ agent, session, messages, loading, processing, streamText, sendShortcut, scrollPositions, onShortcutChange, onSend, onAbort, onFork }: {
  agent?: ApiAgent; session?: ApiSession; messages: ApiMessage[]; loading: boolean; processing: boolean; streamText: string; sendShortcut: SendShortcut;
  scrollPositions: MutableRefObject<Map<string, number>>; onShortcutChange: (shortcut: SendShortcut) => void; onSend: (message: string) => Promise<void>; onAbort: () => Promise<void>; onFork: () => void;
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false); const nearBottomRef = useRef(true);
  useEffect(() => { if (loading || !session) return; const list = listRef.current; if (!list) return; const frame = requestAnimationFrame(() => { const saved = scrollPositions.current.get(session.key); const maximum = Math.max(0, list.scrollHeight - list.clientHeight); list.scrollTop = saved === undefined ? maximum : Math.min(saved, maximum); nearBottomRef.current = maximum - list.scrollTop < 80; restoredRef.current = true; }); return () => cancelAnimationFrame(frame); }, [loading, session?.key, scrollPositions]);
  useEffect(() => { if (loading || !restoredRef.current || !nearBottomRef.current) return; const list = listRef.current; if (!list) return; const frame = requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; if (session) scrollPositions.current.set(session.key, list.scrollTop); }); return () => cancelAnimationFrame(frame); }, [loading, messages, streamText, session?.key, scrollPositions]);
  useEffect(() => () => { const list = listRef.current; if (list && session) scrollPositions.current.set(session.key, list.scrollTop); }, [session?.key, scrollPositions]);
  const submitDraft = async () => { if (!draft.trim() || processing || loading) return; const text = draft.trim(); setDraft(""); await onSend(text); };
  const send = async (event: FormEvent) => { event.preventDefault(); await submitDraft(); };
  if (!agent || !session) return <Box className="empty-chat"><AutoAwesomeRounded /><Typography variant="h6">Escolha uma sessão</Typography><Typography color="text.secondary">Abra uma conversa existente ou inicie uma nova.</Typography></Box>;
  return <Box className="chat-pane"><Box className="chat-header"><Box><Stack direction="row" spacing={1} alignItems="center"><Typography variant="h6">{session.title ?? session.label ?? "Sessão"}</Typography></Stack>
    <Typography variant="caption" color="text.secondary">{agent.name} · {session.key}</Typography></Box><Stack direction="row" spacing={0.7}>
      {processing && <Tooltip title="Interromper"><IconButton color="error" onClick={() => void onAbort()}><StopCircleRounded /></IconButton></Tooltip>}
      <Tooltip title="Criar fork"><IconButton onClick={onFork}><CallSplitRounded /></IconButton></Tooltip></Stack></Box>
    <Box className="message-list" ref={listRef} onScroll={(event) => { const list = event.currentTarget; scrollPositions.current.set(session.key, list.scrollTop); nearBottomRef.current = list.scrollHeight - list.clientHeight - list.scrollTop < 80; }}>{loading ? <Box className="loading-chat"><CircularProgress size={28} /></Box> : groupDisplayMessages(messages).map((item) => item.kind === "activity" ? <TechnicalActivity key={item.id} messages={item.messages} /> : item.kind === "thinking" ? <ThinkingActivity key={item.id} content={item.content} /> : <MessageBubble key={item.message.id} message={item.message} agent={agent} />)}
      {streamText && <MessageBubble message={{ id: "live-stream", role: "assistant", author: agent.name, content: streamText }} agent={agent} />}</Box>
    <Box component="form" onSubmit={send} className="composer-wrap"><Paper className="composer" elevation={0}><TextField multiline maxRows={5} fullWidth disabled={loading || processing} placeholder={loading ? "Carregando histórico…" : processing ? "Aguarde o término do processamento…" : `Conversar com ${agent.name} nesta sessão…`} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(event) => { if (processing || loading || event.key !== "Enter" || event.nativeEvent.isComposing) return; const ctrl = event.ctrlKey || event.metaKey; if (sendShortcut === "enter" && ctrl) { event.preventDefault(); const textarea = event.target as HTMLTextAreaElement; const start = textarea.selectionStart; const end = textarea.selectionEnd; setDraft((current) => `${current.slice(0, start)}\n${current.slice(end)}`); requestAnimationFrame(() => textarea.setSelectionRange(start + 1, start + 1)); return; } const shouldSend = sendShortcut === "enter" ? !event.shiftKey : ctrl; if (shouldSend) { event.preventDefault(); void submitDraft(); } }} variant="standard" InputProps={{ disableUnderline: true }} />
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1 }}><Stack direction="row" spacing={0.7} alignItems="center"><Chip size="small" label={displayModel(session, agent)} /><Tooltip title={session.contextTokens === undefined ? "Tamanho total do contexto indisponível" : `${formatTokens(session.totalTokens)} de ${formatTokens(session.contextTokens)} tokens utilizados`}><Chip size="small" variant="outlined" label={`Contexto ${contextLabel(session)}`} /></Tooltip>{processing && <Box className="composer-processing" role="status" aria-live="polite"><CircularProgress size={13} thickness={5} /><Typography variant="caption">Processando</Typography></Box>}</Stack>
      <Stack direction="row" spacing={0.5} alignItems="center"><Select className="send-shortcut" size="small" value={sendShortcut} onChange={(event) => onShortcutChange(event.target.value as SendShortcut)} aria-label="Atalho para enviar mensagem"><MenuItem value="enter">Enter envia</MenuItem><MenuItem value="ctrl-enter">Ctrl+Enter envia</MenuItem></Select><IconButton type="submit" className="send-button" disabled={!draft.trim() || processing || loading}><SendRounded /></IconButton></Stack></Stack></Paper>
      <Typography variant="caption" color="text.secondary">A mensagem continuará a sessão real no Gateway.</Typography></Box></Box>;
}

function DetailPanel({ agent, session, onHide }: { agent?: ApiAgent; session?: ApiSession; onHide: () => void }) {
  if (!agent) return <Box className="detail-panel" />;
  const context = contextPercent(session);
  return <Box className="detail-panel"><Box className="panel-heading compact"><Box><Typography variant="overline">Contexto</Typography><Typography variant="h6">Detalhes da sessão</Typography></Box><Tooltip title="Ocultar detalhes"><IconButton size="small" onClick={onHide}><ChevronRightRounded /></IconButton></Tooltip></Box>
    <Paper className="agent-profile-card" elevation={0}><Avatar sx={{ width: 52, height: 52, bgcolor: `${agentColor(agent)}22`, fontSize: 24 }}>{agent.emoji ?? "🤖"}</Avatar><Box><Typography fontWeight={700}>{agent.name}</Typography><Typography variant="caption" color="text.secondary">{agent.role ?? agent.id}</Typography></Box></Paper>
    <Divider sx={{ my: 2.5 }} /><Stack spacing={2.2}><Box><Typography className="detail-label">Modelo</Typography><Typography variant="body2">{displayModel(session, agent)}</Typography></Box>
      <Box><Typography className="detail-label">Session key</Typography><Typography variant="body2" className="monospace">{session?.key ?? "—"}</Typography></Box>
      <Box><Typography className="detail-label">Session id</Typography><Typography variant="body2" className="monospace">{session?.sessionId ?? "—"}</Typography></Box>
      <Box><Typography className="detail-label">Janela de contexto</Typography><Stack direction="row" spacing={1} alignItems="center"><LinearProgress variant="determinate" value={context ?? 0} sx={{ flex: 1 }} /><Typography variant="caption">{context === undefined ? "—" : `${context}% · ${formatTokens(session?.totalTokens)} / ${formatTokens(session?.contextTokens)} tokens`}</Typography></Stack></Box></Stack>
    <Divider sx={{ my: 2.5 }} /><Typography className="detail-label">Linhagem</Typography><LayoutContainer mode="grid" columns={1} gap={1} sx={{ mt: 1 }}>
      {session?.parentSessionKey && <LayoutItem><Paper className="lineage-card" elevation={0}><Box className="lineage-icon amber"><PsychologyRounded /></Box><Box><Typography variant="caption">Origem</Typography><Typography variant="body2" className="monospace">{session.parentSessionKey}</Typography></Box></Paper></LayoutItem>}
      <LayoutItem><Paper className="lineage-card current" elevation={0}><Box className="lineage-icon green"><TerminalRounded /></Box><Box><Typography variant="caption">Sessão atual</Typography><Typography variant="body2">{session?.label ?? "Conversa"}</Typography></Box></Paper></LayoutItem></LayoutContainer>
  </Box>;
}

type ConsoleLayout = { agentsWidth: number; sessionsWidth: number; detailsWidth: number; agentsVisible: boolean; sessionsVisible: boolean; detailsVisible: boolean };
const defaultLayout: ConsoleLayout = { agentsWidth: 250, sessionsWidth: 300, detailsWidth: 264, agentsVisible: true, sessionsVisible: true, detailsVisible: true };
const layoutStorageKey = "openclaw-console-layout-v1";
const shortcutStorageKey = "openclaw-console-send-shortcut";
function loadSendShortcut(): SendShortcut { return localStorage.getItem(shortcutStorageKey) === "enter" ? "enter" : "ctrl-enter"; }
function loadLayout(): ConsoleLayout {
  try { const stored = JSON.parse(localStorage.getItem(layoutStorageKey) ?? "null") as Partial<ConsoleLayout> | null; return stored ? { ...defaultLayout, ...stored } : defaultLayout; }
  catch { return defaultLayout; }
}
function clamp(value: number, minimum: number, maximum: number) { return Math.min(maximum, Math.max(minimum, value)); }
function ResizeHandle({ direction = 1, onResize }: { direction?: 1 | -1; onResize: (delta: number) => void }) {
  return <Box className="resize-handle" role="separator" aria-orientation="vertical" onPointerDown={(event) => { event.preventDefault(); let previous = event.clientX; const move = (next: PointerEvent) => { const delta = (next.clientX - previous) * direction; previous = next.clientX; onResize(delta); }; const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); document.body.classList.remove("resizing-panels"); }; document.body.classList.add("resizing-panels"); window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop, { once: true }); }} />;
}
function RestorePanels({ layout, connected, onRestore }: { layout: ConsoleLayout; connected: boolean; onRestore: (panel: "agents" | "sessions" | "details") => void }) {
  const hidden = [!layout.agentsVisible && { panel: "agents" as const, label: "Exibir agentes", icon: <SmartToyOutlined /> }, connected && !layout.sessionsVisible && { panel: "sessions" as const, label: "Exibir sessões", icon: <ChatBubbleOutlineRounded /> }, connected && !layout.detailsVisible && { panel: "details" as const, label: "Exibir detalhes", icon: <DataObjectRounded /> }].filter(Boolean) as Array<{ panel: "agents" | "sessions" | "details"; label: string; icon: ReactNode }>;
  if (!hidden.length) return null;
  return <Box className="restore-panels">{hidden.map((item) => <Tooltip title={item.label} placement="right" key={item.panel}><IconButton onClick={() => onRestore(item.panel)}>{item.icon}</IconButton></Tooltip>)}</Box>;
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
  const [layout, setLayout] = useState<ConsoleLayout>(loadLayout); const [sendShortcut, setSendShortcut] = useState<SendShortcut>(loadSendShortcut); const gatewayConnectedRef = useRef(false); const statusProbeRef = useRef<Promise<boolean> | undefined>(undefined);
  const [agents, setAgents] = useState<ApiAgent[]>([]); const [models, setModels] = useState<ApiModel[]>([]); const [sessions, setSessions] = useState<ApiSession[]>([]); const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [status, setStatus] = useState<GatewayStatus>(); const [agentId, setAgentId] = useState(""); const [sessionKey, setSessionKey] = useState(""); const currentSessionKeyRef = useRef(""); const [sessionId, setSessionId] = useState<string>();
  const [loading, setLoading] = useState(true); const [sessionsLoading, setSessionsLoading] = useState(false); const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false); const [sessionsHasMore, setSessionsHasMore] = useState(false); const [sessionsNextOffset, setSessionsNextOffset] = useState(0); const [historyLoading, setHistoryLoading] = useState(false); const [error, setError] = useState("");
  const [processing, setProcessing] = useState(false); const processingBySessionRef = useRef(new Map<string, boolean>()); const [processingAgentIds, setProcessingAgentIds] = useState<Set<string>>(() => new Set());
  const optimisticMessagesRef = useRef(new Map<string, ApiMessage[]>());
  const scrollPositionsRef = useRef(new Map<string, number>());
  const [runId, setRunId] = useState<string>(); const [streamText, setStreamText] = useState("");
  const selectedAgent = agents.find((agent) => agent.id === agentId); const selectedSession = sessions.find((session) => session.key === sessionKey); const selectedSessionAgentId = selectedSession ? sessionAgentId(selectedSession) : agentId; const connected = Boolean(status?.connected);
  const displayLayout = useMemo(() => {
    let agentsVisible = layout.agentsVisible; let sessionsVisible = connected && layout.sessionsVisible; let detailsVisible = connected && layout.detailsVisible;
    const rail = viewportWidth <= 720 ? 58 : 68; const restore = 42; const handles = () => Number(agentsVisible) * 5 + Number(sessionsVisible) * 5 + Number(detailsVisible) * 5;
    const required = () => rail + restore + handles() + (agentsVisible ? layout.agentsWidth : 0) + (sessionsVisible ? layout.sessionsWidth : 0) + (detailsVisible ? layout.detailsWidth : 0) + 360;
    if (required() > viewportWidth) detailsVisible = false;
    if (required() > viewportWidth) agentsVisible = false;
    if (required() > viewportWidth) sessionsVisible = false;
    return { ...layout, agentsVisible, sessionsVisible, detailsVisible };
  }, [connected, layout, viewportWidth]);
  const hasRestoreBar = !displayLayout.agentsVisible || connected && (!displayLayout.sessionsVisible || !displayLayout.detailsVisible);
  const gridColumns = useMemo(() => { if (view === "agents") return `${viewportWidth <= 720 ? 58 : 68}px minmax(0, 1fr)`; const columns = [`${viewportWidth <= 720 ? 58 : 68}px`]; if (hasRestoreBar) columns.push("42px"); if (displayLayout.agentsVisible) columns.push(`${displayLayout.agentsWidth}px`, "5px"); if (!connected) { columns.push("minmax(0, 1fr)"); return columns.join(" "); } if (displayLayout.sessionsVisible) columns.push(`${displayLayout.sessionsWidth}px`, "5px"); columns.push("minmax(0, 1fr)"); if (displayLayout.detailsVisible) columns.push("5px", `${displayLayout.detailsWidth}px`); return columns.join(" "); }, [connected, displayLayout, hasRestoreBar, view, viewportWidth]);

  const refreshProcessingAgents = useCallback(() => { const active = new Set<string>(); for (const [key, running] of processingBySessionRef.current) { const id = agentIdFromSessionKey(key); if (running && id) active.add(id); } setProcessingAgentIds(active); }, []);
  const loadAgentActivity = useCallback(async (nextAgents: ApiAgent[]) => { const pages = await Promise.allSettled(nextAgents.map((agent) => api.sessions(agent.id, 0, 200))); pages.forEach((result, index) => { if (result.status !== "fulfilled") return; const id = nextAgents[index]?.id; if (!id) return; for (const [key] of processingBySessionRef.current) if (agentIdFromSessionKey(key) === id) processingBySessionRef.current.delete(key); for (const session of result.value.sessions) processingBySessionRef.current.set(session.key, session.hasActiveRun); }); refreshProcessingAgents(); }, [refreshProcessingAgents]);
  const loadRoot = useCallback(async () => { setLoading(true); setError(""); try { const nextStatus = await api.status(); gatewayConnectedRef.current = nextStatus.connected; setStatus(nextStatus); if (!nextStatus.connected) return; const [nextAgents, nextModels] = await Promise.all([api.agents(), api.models()]); setAgents(nextAgents); setModels(nextModels); setAgentId((current) => current && nextAgents.some((a) => a.id === current) ? current : nextAgents[0]?.id ?? ""); void loadAgentActivity(nextAgents); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); } }, [loadAgentActivity]);
  const setSessionProcessing = useCallback((key: string, active: boolean) => { processingBySessionRef.current.set(key, active); refreshProcessingAgents(); setSessions((current) => current.map((session) => session.key === key && session.hasActiveRun !== active ? { ...session, hasActiveRun: active } : session)); }, [refreshProcessingAgents]);
  const loadSessions = useCallback(async (nextAgentId: string, offset = 0, append = false) => { if (!nextAgentId) return; append ? setSessionsLoadingMore(true) : setSessionsLoading(true); setError(""); try { const page = await api.sessions(nextAgentId, offset, 10); const rows = page.sessions.filter((session) => sessionAgentId(session) === nextAgentId); for (const row of rows) processingBySessionRef.current.set(row.key, row.hasActiveRun); refreshProcessingAgents(); setSessions((current) => append ? [...current, ...rows.filter((row) => !current.some((existing) => existing.key === row.key))] : rows); setSessionsHasMore(page.hasMore ?? offset + page.sessions.length < (page.totalCount ?? offset + page.sessions.length)); setSessionsNextOffset(page.nextOffset ?? offset + page.sessions.length); if (!append) setSessionKey((current) => rows.some((s) => s.key === current) ? current : rows[0]?.key ?? ""); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { append ? setSessionsLoadingMore(false) : setSessionsLoading(false); } }, [refreshProcessingAgents]);
  const refreshSessionMetadata = useCallback(async (key: string, id: string) => { try { const page = await api.sessions(id, 0, 200); const fresh = page.sessions.find((session) => session.key === key); if (!fresh) return; processingBySessionRef.current.set(key, fresh.hasActiveRun); refreshProcessingAgents(); setSessions((current) => current.map((session) => session.key === key ? { ...session, ...fresh } : session)); } catch { /* A próxima atualização SSE ou sondagem reconciliará os metadados. */ } }, [refreshProcessingAgents]);
  const loadHistory = useCallback(async (key: string, id: string) => { if (!key || !id) return; setHistoryLoading(true); try { const history = await api.history(key, id); const pending = optimisticMessagesRef.current.get(key) ?? []; const unresolved = pending.filter((optimistic) => !history.messages.some((stored) => stored.role === "user" && stored.content === optimistic.content)); if (unresolved.length) optimisticMessagesRef.current.set(key, unresolved); else optimisticMessagesRef.current.delete(key); setMessages([...history.messages, ...unresolved]); setSessionId(history.sessionId); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setHistoryLoading(false); } }, []);
  useEffect(() => { void loadRoot(); }, [loadRoot]);
  useEffect(() => { const resize = () => setViewportWidth(window.innerWidth); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  useEffect(() => { localStorage.setItem(layoutStorageKey, JSON.stringify(layout)); }, [layout]);
  useEffect(() => { localStorage.setItem(shortcutStorageKey, sendShortcut); }, [sendShortcut]);
  useEffect(() => { currentSessionKeyRef.current = sessionKey; }, [sessionKey]);
  useEffect(() => { setSessions([]); setSessionKey(""); setSessionsHasMore(false); setSessionsNextOffset(0); setMessages([]); if (agentId) void loadSessions(agentId); }, [agentId, loadSessions]);
  useEffect(() => { setMessages(optimisticMessagesRef.current.get(sessionKey) ?? []); setSessionId(undefined); setStreamText(""); setRunId(undefined); const active = processingBySessionRef.current.get(sessionKey) ?? Boolean(selectedSession?.hasActiveRun); setProcessing(active); if (sessionKey && selectedSessionAgentId) void loadHistory(sessionKey, selectedSessionAgentId); }, [sessionKey, selectedSessionAgentId, loadHistory]);
  const recoverGatewayStatus = useCallback(() => { if (statusProbeRef.current) return statusProbeRef.current; const probe = (async () => { try { const nextStatus = await api.status(); const reconnected = !gatewayConnectedRef.current && nextStatus.connected; gatewayConnectedRef.current = nextStatus.connected; setStatus(nextStatus); if (reconnected) await loadRoot(); return nextStatus.connected; } catch { gatewayConnectedRef.current = false; return false; } finally { statusProbeRef.current = undefined; } })(); statusProbeRef.current = probe; return probe; }, [loadRoot]);
  useEffect(() => { let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined; const probe = async () => { const online = await recoverGatewayStatus(); if (!cancelled) timer = setTimeout(() => void probe(), online ? 30_000 : 4_000); }; timer = setTimeout(() => void probe(), 4_000); const wake = () => { if (document.visibilityState === "visible") void recoverGatewayStatus(); }; window.addEventListener("online", wake); document.addEventListener("visibilitychange", wake); return () => { cancelled = true; if (timer) clearTimeout(timer); window.removeEventListener("online", wake); document.removeEventListener("visibilitychange", wake); }; }, [recoverGatewayStatus]);
  useEffect(() => api.events({ onOpen: () => { void recoverGatewayStatus(); }, onError: () => { void recoverGatewayStatus(); }, onStatus: (nextStatus) => { const reconnected = !gatewayConnectedRef.current && nextStatus.connected; gatewayConnectedRef.current = nextStatus.connected; setStatus(nextStatus); if (reconnected) void loadRoot(); }, onSessions: (event) => { const key = event.sessionKey ?? event.session?.key; if (!key) return; if (event.reason === "delete") { setSessions((current) => current.filter((session) => session.key !== key)); processingBySessionRef.current.delete(key); refreshProcessingAgents(); if (currentSessionKeyRef.current === key) { setSessionKey(""); void loadSessions(agentId); } return; } if (!event.session) return; processingBySessionRef.current.set(key, event.session.hasActiveRun); refreshProcessingAgents(); if (event.session.agentId !== agentId) return; setSessions((current) => { const index = current.findIndex((session) => session.key === key); if (index < 0) return [event.session!, ...current]; const next = [...current]; next[index] = { ...current[index], ...event.session! }; return next; }); if (currentSessionKeyRef.current === key) setProcessing(event.session.hasActiveRun); }, onChat: (event) => { const isTerminal = event.state === "final" || event.state === "aborted" || event.state === "error"; setSessionProcessing(event.sessionKey, !isTerminal); if (event.sessionKey !== sessionKey) return; if (event.state === "delta") { setProcessing(true); setStreamText((current) => event.replace ? event.deltaText ?? "" : current + (event.deltaText ?? "")); }
    if (isTerminal) { const owner = agentIdFromSessionKey(sessionKey, event.agentId ?? agentId) ?? agentId; setProcessing(false); setRunId(undefined); setStreamText(""); void Promise.all([loadHistory(sessionKey, owner), refreshSessionMetadata(sessionKey, owner)]); window.setTimeout(() => void refreshSessionMetadata(sessionKey, owner), 800); if ("errorMessage" in event && event.errorMessage) setError(event.errorMessage); }
  } }), [sessionKey, agentId, loadHistory, loadRoot, loadSessions, recoverGatewayStatus, refreshProcessingAgents, refreshSessionMetadata, setSessionProcessing]);
  useEffect(() => { if (!processing || !sessionKey || !selectedSessionAgentId) return; let cancelled = false; let inactiveChecks = 0; let timer: ReturnType<typeof setTimeout> | undefined; const reconcile = async () => { try { const page = await api.sessions(selectedSessionAgentId, 0, 200); const current = page.sessions.find((session) => session.key === sessionKey); if (current?.hasActiveRun) inactiveChecks = 0; else if (current && ++inactiveChecks >= 2) { cancelled = true; setSessionProcessing(sessionKey, false); if (currentSessionKeyRef.current === sessionKey) { setProcessing(false); setRunId(undefined); setStreamText(""); await Promise.all([loadHistory(sessionKey, selectedSessionAgentId), refreshSessionMetadata(sessionKey, selectedSessionAgentId)]); } } } catch { /* SSE remains authoritative while reconciliation is unavailable. */ } finally { if (!cancelled) timer = setTimeout(() => void reconcile(), 5_000); } }; timer = setTimeout(() => void reconcile(), 4_000); return () => { cancelled = true; if (timer) clearTimeout(timer); }; }, [processing, sessionKey, selectedSessionAgentId, loadHistory, refreshSessionMetadata, setSessionProcessing]);
  const loadMoreSessions = useCallback(() => { if (agentId && sessionsHasMore && !sessionsLoading && !sessionsLoadingMore) void loadSessions(agentId, sessionsNextOffset, true); }, [agentId, sessionsHasMore, sessionsLoading, sessionsLoadingMore, sessionsNextOffset, loadSessions]);
  const send = async (message: string) => { if (!selectedAgent || !selectedSession) return; const targetSessionKey = selectedSession.key; const targetAgentId = sessionAgentId(selectedSession); const optimistic = { id: clientId(), role: "user" as const, author: "Alexandre", timestamp: Date.now(), content: message }; optimisticMessagesRef.current.set(targetSessionKey, [...(optimisticMessagesRef.current.get(targetSessionKey) ?? []), optimistic]); flushSync(() => { setError(""); setSessionProcessing(targetSessionKey, true); setProcessing(true); setMessages((current) => [...current, optimistic]); }); try { const result = await api.send({ sessionKey: targetSessionKey, agentId: targetAgentId, sessionId, message }); if (currentSessionKeyRef.current === targetSessionKey && processingBySessionRef.current.get(targetSessionKey)) setRunId(result.runId); if (/^\/model(?:\s|$)/i.test(message.trim())) { window.setTimeout(() => void refreshSessionMetadata(targetSessionKey, targetAgentId), 300); window.setTimeout(() => void refreshSessionMetadata(targetSessionKey, targetAgentId), 1_200); } } catch (e) { optimisticMessagesRef.current.set(targetSessionKey, (optimisticMessagesRef.current.get(targetSessionKey) ?? []).filter((item) => item.id !== optimistic.id)); setSessionProcessing(targetSessionKey, false); if (currentSessionKeyRef.current === targetSessionKey) { setProcessing(false); setRunId(undefined); setError(e instanceof Error ? e.message : String(e)); await loadHistory(targetSessionKey, targetAgentId); } } };
  const abort = async () => { if (!selectedSession) return; await api.abort({ sessionKey: selectedSession.key, agentId: sessionAgentId(selectedSession), runId }); };
  const create = async () => { if (!selectedAgent) return; const label = window.prompt("Nome da nova sessão:", "Nova conversa")?.trim(); if (!label) return; try { const result = await api.createSession({ agentId: selectedAgent.id, label }); await loadSessions(selectedAgent.id); setSessionKey(result.key); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const rename = async () => { if (!selectedSession) return; const label = window.prompt("Novo nome da sessão:", selectedSession.label ?? selectedSession.title)?.trim(); if (!label || label === selectedSession.label) return; try { await api.patchSession({ key: selectedSession.key, agentId: sessionAgentId(selectedSession), label }); setSessions((current) => current.map((session) => session.key === selectedSession.key ? { ...session, label, title: label } : session)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const deleteSession = async () => { if (!selectedAgent || !selectedSession || selectedSession.hasActiveRun) return; if (!window.confirm(`Excluir definitivamente a sessão “${selectedSession.label ?? selectedSession.title}”? O histórico será arquivado pelo Gateway.`)) return; const key = selectedSession.key; try { const result = await api.deleteSession({ key, agentId: sessionAgentId(selectedSession) }); if (!result.deleted) throw new Error("O Gateway não excluiu a sessão"); setSessionKey(""); await loadSessions(selectedAgent.id); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const fork = async () => { if (!selectedAgent || !selectedSession) return; const label = window.prompt("Nome do fork:", `Fork · ${selectedSession.label ?? selectedSession.title ?? "sessão"}`)?.trim(); if (!label) return; try { const result = await api.forkSession({ parentSessionKey: selectedSession.key, agentId: sessionAgentId(selectedSession), label }); await loadSessions(selectedAgent.id); setSessionKey(result.key); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };

  return <Box className={`console-shell theme-${themeName} view-${view}`} style={{ gridTemplateColumns: gridColumns }}><BrandRail view={view} onNavigate={setView} />
    {view === "agents" ? <AgentManagement agents={agents} models={models} status={status} loading={loading} onRefresh={loadRoot} onError={setError} /> : <>
    {hasRestoreBar && <RestorePanels layout={displayLayout} connected={connected} onRestore={(panel) => setLayout((current) => panel === "agents" ? { ...current, agentsVisible: true } : panel === "sessions" ? { ...current, sessionsVisible: true } : { ...current, detailsVisible: true })} />}
    {displayLayout.agentsVisible && <AgentList agents={agents} selected={selectedAgent} processingAgents={processingAgentIds} status={status} loading={loading} onSelect={(a) => setAgentId(a.id)} onRefresh={loadRoot} onHide={() => setLayout((current) => ({ ...current, agentsVisible: false }))} />}
    {displayLayout.agentsVisible && <ResizeHandle onResize={(delta) => setLayout((current) => ({ ...current, agentsWidth: clamp(current.agentsWidth + delta, 190, 440) }))} />}
    {!connected ? <GatewayOfflinePane status={status} /> : <>
      {displayLayout.sessionsVisible && <SessionList agent={selectedAgent} sessions={sessions} selected={selectedSession} loading={sessionsLoading} loadingMore={sessionsLoadingMore} hasMore={sessionsHasMore} onSelect={(s) => setSessionKey(s.key)} onCreate={() => void create()} onLoadMore={loadMoreSessions} onRename={() => void rename()} onDelete={() => void deleteSession()} onHide={() => setLayout((current) => ({ ...current, sessionsVisible: false }))} />}
      {displayLayout.sessionsVisible && <ResizeHandle onResize={(delta) => setLayout((current) => ({ ...current, sessionsWidth: clamp(current.sessionsWidth + delta, 230, 520) }))} />}
      <ChatPane key={selectedSession?.key ?? "empty-chat"} agent={selectedAgent} session={selectedSession} messages={messages} loading={historyLoading} processing={processing} streamText={streamText} sendShortcut={sendShortcut} scrollPositions={scrollPositionsRef} onShortcutChange={setSendShortcut} onSend={send} onAbort={abort} onFork={() => void fork()} />
      {displayLayout.detailsVisible && <ResizeHandle direction={-1} onResize={(delta) => setLayout((current) => ({ ...current, detailsWidth: clamp(current.detailsWidth + delta, 220, 460) }))} />}
      {displayLayout.detailsVisible && <DetailPanel agent={selectedAgent} session={selectedSession} onHide={() => setLayout((current) => ({ ...current, detailsVisible: false }))} />}
    </>}
    </>}
    {error && <Alert severity="error" className="floating-error" onClose={() => setError("")}>{error}</Alert>}
    <Tooltip title={themeName === "escuro" ? "Tema claro" : "Tema escuro"}><IconButton className="theme-toggle" onClick={() => setThemeName(themeName === "escuro" ? "claro" : "escuro")}>{themeName === "escuro" ? <LightModeRounded /> : <DarkModeRounded />}</IconButton></Tooltip>
  </Box>;
}

export default function App() { return <ConsoleApp />; }
