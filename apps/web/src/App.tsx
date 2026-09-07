import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { JsonGrid, LayoutContainer, LayoutItem, useBibliotecaTheme } from "@alexandretorqueti/biblioteca-global-ui";
import {
  AddRounded, AutoAwesomeRounded, CallSplitRounded, ChatBubbleOutlineRounded, ChevronRightRounded,
  ContentCopyRounded, DarkModeRounded, DataObjectRounded, DeleteOutlineRounded, DownloadRounded, EditRounded, GroupRounded, HubRounded, InfoOutlined, KeyboardArrowDownRounded, LightModeRounded, MicRounded, MoreVertRounded, NotificationsNoneRounded, PsychologyRounded,
  MicOffRounded, RefreshRounded, SendRounded, SettingsRounded, SmartToyOutlined, StopCircleRounded,
  TerminalRounded,
  VisibilityOffRounded,
  VisibilityRounded,
  VolumeUpRounded, SummarizeRounded,
  VolumeOffRounded,
} from "@mui/icons-material";
import {
  Alert, Avatar, Badge, Box, Button, Chip, CircularProgress, ClickAwayListener, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, IconButton,
  LinearProgress, Menu, MenuItem, Paper, Popover, Select, Stack, Switch, TextField, Tooltip, Typography,
} from "@mui/material";
import { api, type ApiAgent, type ApiAgentContextFile, type ApiMessage, type ApiModel, type ApiNotification, type ApiSession, type ApiSessionSummary, type GatewayStatus } from "./api";
import { readCachedSessions, saveSessions } from "./sessionDb";
import { GroupsPanel, GroupChatPane, GroupFormDialog, ManageAgentsDialog, useAgentGroups } from "./AgentGroups";
import { useTextToSpeech } from "./useTextToSpeech";
import { MultiColumnStream, useColumnLayout, useMeasuredHeight, type MultiColumnStreamHandle } from "./MultiColumnStream";
import { parseVoiceCommand, normalizeText } from "./voiceCommands";

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
// Troca de modelo só é permitida se o contexto (janela) do novo modelo comportar o
// contexto já ocupado na sessão (totalTokens). Retorna o motivo do bloqueio ou undefined.
function modelSwitchBlockReason(model: ApiModel | undefined, session: ApiSession | undefined): string | undefined {
  if (!model || !session) return undefined;
  if (model.contextWindow === undefined || session.totalTokens === undefined) return undefined;
  if (model.contextWindow < session.totalTokens) {
    return `Troca bloqueada: ${model.name} tem janela de ${formatTokens(model.contextWindow, true)} tokens, menor que os ${formatTokens(session.totalTokens, true)} tokens já ocupados nesta conversa.`;
  }
  return undefined;
}
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
function messageTimestampMs(message: ApiMessage): number | undefined {
  if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) return undefined;
  return message.timestamp < 10_000_000_000 ? message.timestamp * 1000 : message.timestamp;
}
// O Gateway pode persistir a mensagem do usuário alguns instantes depois do
// evento final da resposta. Nesse intervalo ela fica pendente e precisa ser
// reinserida no histórico pela data, não simplesmente anexada ao final.
function mergePendingMessages(history: ApiMessage[], pending: ApiMessage[]): ApiMessage[] {
  const merged = [...history];
  for (const message of pending) {
    const timestamp = messageTimestampMs(message);
    if (timestamp === undefined) {
      merged.push(message);
      continue;
    }
    const index = merged.findIndex((existing) => {
      const existingTimestamp = messageTimestampMs(existing);
      return existingTimestamp !== undefined && existingTimestamp > timestamp;
    });
    merged.splice(index < 0 ? merged.length : index, 0, message);
  }
  return merged;
}
function chatAuthor(message: ApiMessage, agent?: ApiAgent) {
  if (message.role === "user") return message.author ?? "Usuário";
  if (message.role === "tool") return `Tool${message.toolName ? ` · ${message.toolName}` : ""}`;
  return message.author ?? agent?.name ?? "Assistente";
}
function formatChatTimestamp(value?: number): string {
  if (!value) return "";
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}
// Gera o download de toda a conversa (do início até a última mensagem) em texto.
function downloadChat(agent: ApiAgent | undefined, session: ApiSession | undefined, messages: ApiMessage[]) {
  const name = session?.title ?? session?.label ?? session?.key ?? "conversa";
  const lines: string[] = [`Conversa: ${name}`, `Agente: ${agent?.name ?? "—"}`, `Sessão: ${session?.key ?? "—"}`, `Exportado em: ${formatChatTimestamp(Date.now())}`,"", "".padEnd(48, "-")];
  for (const message of messages) {
    const role = message.role === "user" ? "Você" : message.role === "tool" ? "Ferramenta" : "Assistente";
    const stamp = formatChatTimestamp(message.timestamp);
    lines.push(`[${role}${stamp ? ` · ${stamp}` : ""}] ${chatAuthor(message, agent)}`);
    const content = messageText(message).trim();
    if (content) lines.push(content);
    lines.push("");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeName = name.replace(/[\\/:*?"<>|]/g, "_").trim() || "conversa";
  anchor.href = url;
  anchor.download = `${safeName}.txt`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
function clientId() { return globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function BrandRail({ view, onNavigate, notifications, notificationsAnchor, onToggleNotifications, onCloseNotifications, onSelectNotification, onMarkAllRead }: {
  view: ConsoleView; onNavigate: (view: ConsoleView) => void;
  notifications: ApiNotification[]; notificationsAnchor: HTMLElement | null;
  onToggleNotifications: (anchor: HTMLElement) => void; onCloseNotifications: () => void;
  onSelectNotification: (session: ApiSession) => void; onMarkAllRead: () => void;
}) {
  return <Box className="brand-rail">
    <Box className="brand-mark">C</Box>
    <Tooltip title={notifications.length ? `${notifications.length} notificação${notifications.length === 1 ? "" : "es"}` : "Notificações"} placement="right">
      <IconButton className={notificationsAnchor ? "rail-button active notification-bell" : "rail-button notification-bell"} onClick={(event) => onToggleNotifications(event.currentTarget)} aria-label="Notificações">
        <Badge badgeContent={notifications.length} color="error" max={99} overlap="circular">
          <NotificationsNoneRounded />
        </Badge>
      </IconButton>
    </Tooltip>
    <NotificationsPopover
      notifications={notifications}
      anchorEl={notificationsAnchor}
      onClose={onCloseNotifications}
      onSelect={onSelectNotification}
      onMarkAllRead={onMarkAllRead}
    />
    <Stack spacing={1.2} alignItems="center" sx={{ mt: 2 }}>
      {navigation.map((item) => <Tooltip title={item.label} placement="right" key={item.label}>
        <IconButton className={item.view === view ? "rail-button active" : "rail-button"} disabled={!item.view} onClick={() => item.view && onNavigate(item.view)}>{item.icon}</IconButton>
      </Tooltip>)}
    </Stack>
    <Box sx={{ flex: 1 }} />
    <IconButton className="rail-button"><SettingsRounded /></IconButton>
    <Avatar sx={{ width: 34, height: 34, fontSize: 13, bgcolor: "#5d50d6", mt: 1.5 }}>AT</Avatar>
  </Box>;
}

function NotificationsPopover({ notifications, anchorEl, onClose, onSelect, onMarkAllRead }: {
  notifications: ApiNotification[]; anchorEl: HTMLElement | null; onClose: () => void;
  onSelect: (session: ApiSession) => void; onMarkAllRead: () => void;
}) {
  return <Popover
    open={Boolean(anchorEl)}
    anchorEl={anchorEl}
    onClose={onClose}
    anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
    transformOrigin={{ vertical: "top", horizontal: "right" }}
    slotProps={{ paper: { className: "notifications-paper" } }}
  >
    <Box className="notifications-popover">
      <Box className="notifications-header">
        <Typography variant="subtitle1" fontWeight={750}>Notificações</Typography>
        {notifications.length > 0 && <Button size="small" onClick={onMarkAllRead}>Limpar tudo</Button>}
      </Box>
      {notifications.length === 0
        ? <Box className="notifications-empty">Nenhuma notificação. Quando um agente responder em uma conversa que você não está vendo, ela aparece aqui.</Box>
        : <Box className="notifications-list">{notifications.map(({ session, agent }) => {
          const name = session.label ?? session.title ?? session.key;
          return <Box className="notification-item" key={session.key} onClick={() => onSelect(session)}>
            <Avatar className="notification-avatar" sx={{ bgcolor: `${agentColor(agent)}25`, border: `1px solid ${agentColor(agent)}55` }}>{agent.emoji ?? "🤖"}</Avatar>
            <Box className="notification-body">
              <Box className="notification-row">
                <Typography variant="subtitle2" className="notification-title" title={name}>{name}</Typography>
                <Typography variant="caption" color="text.secondary" className="notification-time">{relativeTime(session.lastActivityAt ?? session.updatedAt)}</Typography>
              </Box>
              <Typography variant="caption" className="notification-preview">{agent.name} · {session.lastMessagePreview ?? "Nova atividade na conversa"}</Typography>
            </Box>
          </Box>; })}
        </Box>}
    </Box>
  </Popover>;
}

// Sessões de grupo têm key no padrão `agent:<id>:group:<groupId>` (ver AgentGroups.tsx).
// Elas são separadas dos chats 1:1 na lista de conversas.
function isGroupSession(session: ApiSession): boolean { return session.key.includes(":group:"); }

// Sub-sessões são sessões criadas por outro agente via sessions_spawn: o contrato
// expõe parentSessionKey (chave da sessão pai) quando isso acontece.
function isSubSession(session: ApiSession): boolean { return Boolean(session.parentSessionKey); }

// Estado de colapso das seções da lista de conversas, persistido localmente.
// `true` = seção minimizada. `subagents` nasce minimizada por padrão.
const chatSectionsStorageKey = "openclaw-console-chat-sections";
type ChatSectionsState = { chats: boolean; groups: boolean; hidden: boolean; helpdesk: boolean; subagents: boolean; tasks: boolean };
function loadChatSectionsState(): ChatSectionsState {
  try {
    const raw = localStorage.getItem(chatSectionsStorageKey);
    if (!raw) return { chats: false, groups: false, hidden: true, helpdesk: false, subagents: true, tasks: false };
    const parsed = JSON.parse(raw) as Partial<ChatSectionsState>;
    return { chats: parsed.chats === true, groups: parsed.groups === true, hidden: parsed.hidden !== false, helpdesk: parsed.helpdesk === true, subagents: parsed.subagents !== false, tasks: parsed.tasks === true };
  } catch {
    return { chats: false, groups: false, hidden: true, helpdesk: false, subagents: true, tasks: false };
  }
}

function ChatSection({ title, count, collapsed, onToggle, children }: { title: string; count: number; collapsed: boolean; onToggle: () => void; children: ReactNode }) {
  return <Box className="chat-section">
    <Box className={collapsed ? "chat-section-header collapsed" : "chat-section-header"} role="button" tabIndex={0} aria-expanded={!collapsed} onClick={onToggle} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); } }}>
      <KeyboardArrowDownRounded className="chat-section-chevron" fontSize="small" />
      <Typography variant="overline" className="chat-section-title">{title}</Typography>
      {count > 0 && <Typography variant="caption" className="chat-section-count">{count}</Typography>}
    </Box>
    {!collapsed && <Box className="chat-list">{children}</Box>}
  </Box>;
}

function ChatsPanel({ agents, selectedAgentId, onAgentSelect, sessions, summary, selected, loading, loadingMore, hasMore, onSelect, onCreate, onLoadMore, onRename, onDelete, onToggleHidden, onShowDetails, onClose }: {
  agents: ApiAgent[]; selectedAgentId: string; onAgentSelect: (agentId: string) => void; sessions: ApiSession[]; selected?: ApiSession;
  summary?: ApiSessionSummary;
  loading: boolean; loadingMore: boolean; hasMore: boolean;
  onSelect: (session: ApiSession) => void; onCreate: () => void; onLoadMore: () => void;
  onRename: (session: ApiSession) => void; onDelete: (session: ApiSession) => void; onToggleHidden: (session: ApiSession) => void; onShowDetails: (session: ApiSession) => void;
  onClose?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null); const sentinelRef = useRef<HTMLDivElement>(null);
  const [menuFor, setMenuFor] = useState<ApiSession | null>(null); const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [miniFor, setMiniFor] = useState<ApiSession | null>(null); const [miniPos, setMiniPos] = useState<{ x: number; y: number } | null>(null);
  const [sectionsCollapsed, setSectionsCollapsed] = useState<ChatSectionsState>(loadChatSectionsState);
  const toggleSection = (section: keyof ChatSectionsState) => setSectionsCollapsed((current) => { const next = { ...current, [section]: !current[section] }; try { localStorage.setItem(chatSectionsStorageKey, JSON.stringify(next)); } catch { /* armazenamento indisponível */ } return next; });
  useEffect(() => { const sentinel = sentinelRef.current; if (!sentinel || !hasMore || loading || loadingMore) return; const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) onLoadMore(); }, { root: panelRef.current, rootMargin: "120px" }); observer.observe(sentinel); return () => observer.disconnect(); }, [hasMore, loading, loadingMore, onLoadMore]);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const sessionName = (session: ApiSession) => session.label ?? session.title ?? session.key;
  const isHelpdesk = (session: ApiSession) => sessionName(session).trim().toLowerCase().startsWith("helpdesk");
  const isTask = (s: ApiSession) => { const n = sessionName(s); return n.startsWith('dev-') || n.startsWith('analysis-') || n.startsWith('[TAREFA]'); };
  const taskSessions = sessions.filter((session) => !session.archived && !isHelpdesk(session) && isTask(session));
  const chatSessions = sessions.filter((session) => !session.archived && !isHelpdesk(session) && !isGroupSession(session) && !isSubSession(session) && !isTask(session));
  const groupSessions = sessions.filter((session) => !session.archived && !isHelpdesk(session) && isGroupSession(session));
  const subagentSessions = sessions.filter((session) => !session.archived && !isHelpdesk(session) && isSubSession(session));
  const helpdeskSessions = sessions.filter((session) => !session.archived && isHelpdesk(session));
  const hiddenSessions = sessions.filter((session) => session.archived);
  const renderSessionItem = (session: ApiSession) => {
    const name = session.label ?? session.title ?? session.key;
    return <Box key={session.key} className={[selected?.key === session.key ? "chat-item selected" : "chat-item", session.archived ? "archived" : ""].filter(Boolean).join(" ")} onClick={() => onSelect(session)}>
      {isGroupSession(session) && <GroupRounded fontSize="small" className="chat-kind-icon" />}
      {isSubSession(session) && <HubRounded fontSize="small" className="chat-kind-icon" />}
      <Typography className="chat-name" title={name}>{name}</Typography>
      <IconButton className="chat-more" size="small" onClick={(event) => { event.stopPropagation(); setMenuFor(session); setMenuAnchor(event.currentTarget); }} aria-label="Opções da conversa"><MoreVertRounded /></IconButton>
    </Box>;
  };
  return <Box className="chats-panel" ref={panelRef}>
    <Box className="chats-brand"><Box className="brand-mark">C</Box><Typography variant="h6" sx={{ flex: 1 }}>Global IA</Typography>{onClose && <IconButton size="small" className="chats-close" onClick={onClose} aria-label="Fechar conversas"><ChevronRightRounded fontSize="small" /></IconButton>}</Box>
    <Select size="small" className="chats-agent-select" value={selectedAgentId} onChange={(event) => onAgentSelect(String(event.target.value))} renderValue={(value) => { const agent = agents.find((a) => a.id === value); return agent ? `${agent.emoji ?? "🤖"} ${agent.name}` : value; }}>
      {agents.map((agent) => <MenuItem key={agent.id} value={agent.id}>{agent.emoji ?? "🤖"} {agent.name}</MenuItem>)}
    </Select>
    <Button className="new-chat-button" startIcon={<AddRounded />} disabled={!selectedAgent} onClick={onCreate}>Novo chat</Button>
    {loading && <LinearProgress className="chats-loading-progress" />}
    <ChatSection title="Chats" count={summary?.chats ?? chatSessions.length} collapsed={sectionsCollapsed.chats} onToggle={() => toggleSection("chats")}>
      {chatSessions.map(renderSessionItem)}
      {!loading && !chatSessions.length && <Box className="chat-empty">Nenhum chat 1:1 deste agente.</Box>}
    </ChatSection>
    <ChatSection title="Tarefas" count={summary?.tasks ?? taskSessions.length} collapsed={sectionsCollapsed.tasks} onToggle={() => toggleSection('tasks' as any)}>
      {taskSessions.map(renderSessionItem)}
      {!loading && !taskSessions.length && <Box className="chat-empty">Nenhuma tarefa.</Box>}
    </ChatSection>
    <ChatSection title="Grupos" count={summary?.groups ?? groupSessions.length} collapsed={sectionsCollapsed.groups} onToggle={() => toggleSection("groups")}>
      {groupSessions.map(renderSessionItem)}
      {!loading && !groupSessions.length && <Box className="chat-empty">Nenhuma sessão de grupo deste agente.</Box>}
    </ChatSection>
    <ChatSection title="SubAgentes" count={summary?.subagents ?? subagentSessions.length} collapsed={sectionsCollapsed.subagents} onToggle={() => toggleSection("subagents")}>
      {subagentSessions.map(renderSessionItem)}
      {!loading && !subagentSessions.length && <Box className="chat-empty">Nenhuma sub-sessão criada por outro agente.</Box>}
    </ChatSection>
    <ChatSection title="Helpdesk" count={helpdeskSessions.length} collapsed={sectionsCollapsed.helpdesk} onToggle={() => toggleSection("helpdesk")}>
      {helpdeskSessions.map(renderSessionItem)}
      {!loading && !helpdeskSessions.length && <Box className="chat-empty">Nenhuma sessão de helpdesk.</Box>}
    </ChatSection>
    {hiddenSessions.length > 0 && <ChatSection title="Ocultas" count={hiddenSessions.length} collapsed={sectionsCollapsed.hidden} onToggle={() => toggleSection("hidden")}>
      {hiddenSessions.map(renderSessionItem)}
      <Box className="chat-empty">Ocultar esconde a conversa da lista sem excluí-la. Use o menu da conversa para mostrá-la novamente.</Box>
    </ChatSection>}
    <Box ref={sentinelRef} className="chats-more-sentinel">{loadingMore && <><CircularProgress size={18} /><Typography variant="caption">Carregando mais…</Typography></>}</Box>
    <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => { setMenuAnchor(null); setMenuFor(null); }}>
      <MenuItem onClick={() => { if (menuFor) onRename(menuFor); setMenuAnchor(null); setMenuFor(null); }}><EditRounded fontSize="small" sx={{ mr: 1 }} />Editar</MenuItem>
      <MenuItem onClick={() => { if (menuFor) onToggleHidden(menuFor); setMenuAnchor(null); setMenuFor(null); }}>{menuFor?.archived ? <VisibilityRounded fontSize="small" sx={{ mr: 1 }} /> : <VisibilityOffRounded fontSize="small" sx={{ mr: 1 }} />}{menuFor?.archived ? "Mostrar" : "Ocultar"}</MenuItem>
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
  if (isSystem) { const isError = message.content.startsWith("⚠️"); return <Box className={isError ? "system-message error" : "system-message"}><CallSplitRounded /><Box><Typography variant="caption">{messageText(message)}</Typography></Box></Box>; }
  return <Box className={isUser ? "message-row user" : "message-row"}>
    {!isUser && <Avatar sx={{ bgcolor: `${agentColor(agent)}25`, border: `1px solid ${agentColor(agent)}55` }}>{agent.emoji ?? "🤖"}</Avatar>}
    <Box className={isUser ? "message-bubble user" : "message-bubble"}><Stack direction="row" justifyContent="space-between" spacing={3}>
      <Typography variant="subtitle2">{message.author ?? (isUser ? "Alexandre" : agent.name)}</Typography>
      <Stack direction="row" spacing={0.3} alignItems="center"><Typography variant="caption" color="text.secondary">{formatChatTimestamp(message.timestamp)}</Typography>{!isUser && <Tooltip title={copied ? "Copiado" : "Copiar resposta"}><IconButton className="copy-message" size="small" aria-label="Copiar resposta" onClick={() => void copyText(messageText(message)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); })}><ContentCopyRounded /></IconButton></Tooltip>}</Stack>
    </Stack><Typography variant="body2" className="message-content">{messageText(message)}</Typography></Box>
  </Box>;
});
async function copyText(value: string) { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; } const area = document.createElement("textarea"); area.value = value; area.style.position = "fixed"; area.style.opacity = "0"; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove(); }

type DisplayMessage = { kind: "message"; message: ApiMessage } | { kind: "activity"; id: string; messages: ApiMessage[] } | { kind: "thinking"; id: string; content: string } | { kind: "collapsed"; id: string; items: DisplayMessage[] };
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
  // Funde blocos de atividade/pensamento consecutivos (sem mensagem de texto
  // entre eles) em um único bloco colapsado com contador — clicar expande tudo.
  const merged: DisplayMessage[] = [];
  let run: DisplayMessage[] | null = null;
  const flushRun = () => {
    if (!run) return;
    if (run.length === 1) merged.push(run[0]);
    else {
      const first = run[0];
      merged.push({ kind: "collapsed", id: `collapsed-${first.kind === "message" ? first.message.id : first.id}`, items: run });
    }
    run = null;
  };
  for (const item of result) {
    const isNonText = item.kind === "activity" || item.kind === "thinking";
    if (isNonText) { (run ??= []).push(item); continue; }
    flushRun();
    merged.push(item);
  }
  flushRun();
  return merged;
}
function CollapsedActivity({ items }: { items: DisplayMessage[] }) {
  const activities = items.filter((item) => item.kind === "activity").length;
  const thinkings = items.length - activities;
  const label = activities > 0 && thinkings > 0
    ? `Atividade técnica · ${activities} ${activities === 1 ? "bloco" : "blocos"} · 💭 ${thinkings}`
    : activities > 0
      ? `Atividade técnica · ${activities} ${activities === 1 ? "bloco" : "blocos"}`
      : `Pensando · ${thinkings}`;
  return (
    <details className="collapsed-activity">
      <summary>{activities > 0 ? <TerminalRounded /> : <PsychologyRounded />}<Box><Typography variant="caption" fontWeight={700}>{label}</Typography><Typography variant="caption" color="text.secondary">Clique para expandir</Typography></Box></summary>
      <Box className="collapsed-activity-items">
        {items.map((item) => {
          if (item.kind === "activity") return <TechnicalActivity key={item.id} messages={item.messages} />;
          if (item.kind === "thinking") return <ThinkingActivity key={item.id} content={item.content} />;
          return null;
        })}
      </Box>
    </details>
  );
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
// ------------------------- Ditado por voz (Web Speech API) -------------------------
// Usa o reconhecimento de fala nativo do navegador (Chrome/Edge/Safari) para
// transcrever o microfone direto no rascunho do composer — sem backend extra.
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
  onstart?: (() => void) | null;
  onspeechstart?: (() => void) | null;
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

function ChatPane({ agent, session, messages, loading, processing, streamText, sendShortcut, models, initialDraft = "", onDraftChange, mobile = false, onToggleChats, onShortcutChange, onSend, onModelChange, onAbort, onFork, onShowDetails, ttsEnabled = false, ttsMode = "summary", ttsSpeaking = false, ttsSupported = false, onToggleTts, onToggleTtsMode, micEnabled = true, onToggleMic, onVoiceNavigate, onVoiceOpenAgent }: {
  agent?: ApiAgent; session?: ApiSession; messages: ApiMessage[]; loading: boolean; processing: boolean; streamText: string; sendShortcut: SendShortcut;
  models: ApiModel[]; initialDraft?: string; onDraftChange: (text: string) => void; mobile?: boolean; onToggleChats: () => void; onShortcutChange: (shortcut: SendShortcut) => void; onSend: (message: string) => Promise<void>; onModelChange: (modelRef: string) => Promise<void>; onAbort: () => Promise<void>; onFork: () => void; onShowDetails: () => void;
  ttsEnabled?: boolean; ttsMode?: "summary" | "full"; ttsSpeaking?: boolean; ttsSupported?: boolean; onToggleTts?: () => void; onToggleTtsMode?: () => void;
  micEnabled?: boolean; onToggleMic?: () => void;
  onVoiceNavigate?: (direction: "next" | "previous") => void;
  onVoiceOpenAgent?: (name: string) => void;
}) {
  // O rascunho sobrevive à troca de chat/agente: o estado inicial vem do mapa de
  // rascunhos do ConsoleApp (por sessão) e toda alteração é propagada de volta.
  const [draft, setDraft] = useState(initialDraft);
  // Ref espelho do rascunho, sempre atualizado no render: o debounce do Enter lê
  // daqui (e não do closure do render), evitando estado obsoleto/draft vazio.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const submitDraftRef = useRef<() => void>(() => {});
  const updateDraft = (value: string) => { setDraft(value); onDraftChange(value); clearEnterDebounce(); };
  const textareaInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MultiColumnStreamHandle | null>(null);
  const columnLayout = useColumnLayout<HTMLDivElement>();
  const composerMeasure = useMeasuredHeight<HTMLDivElement>();
  // Callbacks de navegação por voz: refs mantêm a versão mais recente (o
  // reconhecimento fecha closures na criação — padrão usado pelo draft/envio).
  const onVoiceNavigateRef = useRef(onVoiceNavigate);
  onVoiceNavigateRef.current = onVoiceNavigate;
  const onVoiceOpenAgentRef = useRef(onVoiceOpenAgent);
  onVoiceOpenAgentRef.current = onVoiceOpenAgent;
  // Timer do "Enter com debounce": no modo ctrl-enter, Enter quebra linha; se o
  // usuário não digitar mais nada em 1s, a mensagem é enviada automaticamente.
  const enterDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearEnterDebounce = useCallback(() => { if (enterDebounceRef.current) { clearTimeout(enterDebounceRef.current); enterDebounceRef.current = undefined; } }, []);
  useEffect(() => clearEnterDebounce, [clearEnterDebounce]);
  const busy = processing || Boolean(session?.hasActiveRun);
  // Ref espelho de "ocupado", para o debounce ler o valor vivo no disparo do timer.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // ---- Ditado por voz: o botão de microfone transcreve a fala e anexa o texto
  // ao rascunho. Se o usuário ficar 6s sem falar (com o mic ligado), o texto
  // acumulado é enviado automaticamente (com countdown visível no botão);
  // desligar o botão cancela o envio. Após a resposta do agente, o mic religa
  // sozinho para o fluxo contínuo de ditado. ----
  const DICTATION_SILENCE_MS = 6_000;
  const [listening, setListening] = useState(false);
  const [silenceRemainingMs, setSilenceRemainingMs] = useState<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const silenceTimerRef = useRef<number | undefined>(undefined);
  const countdownIntervalRef = useRef<number | undefined>(undefined);
  const silenceDeadlineRef = useRef<number | undefined>(undefined);
  const autoResumeRef = useRef(false);
  const wasProcessingRef = useRef(false);
  const pausedForTtsRef = useRef(false);
  // Parada intencional (botão, clique/digitação, envio) → não religa sozinho.
  const intentionalStopRef = useRef(false);
  // Timer de religada após o navegador encerrar a escuta por silêncio (no-speech).
  const restartTimerRef = useRef<number | undefined>(undefined);
  const silentEndCountRef = useRef(0);
  const clearSilenceTimer = () => {
    if (silenceTimerRef.current !== undefined) { window.clearTimeout(silenceTimerRef.current); silenceTimerRef.current = undefined; }
    if (countdownIntervalRef.current !== undefined) { window.clearInterval(countdownIntervalRef.current); countdownIntervalRef.current = undefined; }
    silenceDeadlineRef.current = undefined;
    setSilenceRemainingMs(null);
  };
  const armSilenceTimer = () => {
    clearSilenceTimer();
    const deadline = Date.now() + DICTATION_SILENCE_MS;
    silenceDeadlineRef.current = deadline;
    setSilenceRemainingMs(DICTATION_SILENCE_MS);
    silenceTimerRef.current = window.setTimeout(() => {
      clearSilenceTimer();
      // Se o usuário desligou o microfone, recognitionRef já é null → não envia
      if (!recognitionRef.current) return;
      const text = (draftRef.current || "").trim();
      if (!text) { recognitionRef.current.stop(); return; }
      if (busyRef.current || loading) { armSilenceTimer(); return; } // ocupado: segue ouvindo
      autoResumeRef.current = true; // após a resposta, religa o mic
      intentionalStopRef.current = true; // fim do segmento de ditado (não religa já)
      recognitionRef.current.stop(); // onend limpa refs e estado
      // Zera a ref antes do submit: o envio automático não deve passar pelo guard
      // de "envio manual interrompe o ditado" (que apagaria o autoResumeRef).
      recognitionRef.current = null;
      void submitDraftRef.current();
    }, DICTATION_SILENCE_MS);
    countdownIntervalRef.current = window.setInterval(() => {
      const remaining = (silenceDeadlineRef.current ?? 0) - Date.now();
      if (remaining <= 0) {
        if (countdownIntervalRef.current !== undefined) { window.clearInterval(countdownIntervalRef.current); countdownIntervalRef.current = undefined; }
        setSilenceRemainingMs(0);
        return;
      }
      setSilenceRemainingMs(remaining);
    }, 100);
  };
  const clearRestartTimer = () => {
    if (restartTimerRef.current !== undefined) { window.clearTimeout(restartTimerRef.current); restartTimerRef.current = undefined; }
  };
  // O navegador encerra a escuta sozinho após alguns segundos de silêncio
  // (no-speech), mesmo com continuous:true. Nesse caso religa com backoff
  // curto (0,25s→1,5s) para o mic ficar pronto até a primeira fala. Paradas
  // intencionais (botão, clique/digitação, envio) não religam; durante a
  // resposta do agente (busy) a religada fica por conta do efeito de processing.
  const handleRecognitionEnd = () => {
    const wasActive = recognitionRef.current !== null;
    clearSilenceTimer();
    recognitionRef.current = null;
    setListening(false);
    if (!wasActive || busyRef.current || intentionalStopRef.current) return;
    silentEndCountRef.current += 1;
    const delay = Math.min(250 * silentEndCountRef.current, 1500);
    clearRestartTimer();
    restartTimerRef.current = window.setTimeout(() => {
      restartTimerRef.current = undefined;
      if (!busyRef.current && !intentionalStopRef.current && !recognitionRef.current) startListening();
    }, delay);
  };
  const startListening = () => {
    if (!micEnabled) return;
    if (recognitionRef.current) return;
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = "pt-BR";
    recognition.continuous = true;
    recognition.interimResults = true;
    // Qualquer atividade de fala rearma o timer de silêncio
    recognition.onspeechstart = () => { armSilenceTimer(); };
    recognition.onstart = () => { intentionalStopRef.current = false; silentEndCountRef.current = 0; };
    recognition.onresult = (event) => {
      armSilenceTimer();
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
          
          // Comandos de voz: enviar, navegar entre chats, abrir agente
          const voiceCommand = parseVoiceCommand(transcript);
          if (voiceCommand) {
            if (voiceCommand.type === "send") {
              const currentText = draftRef.current.trim();
              if (currentText) void submitDraft();
            } else if (voiceCommand.type === "nextChat") {
              onVoiceNavigateRef.current?.("next");
            } else if (voiceCommand.type === "previousChat") {
              onVoiceNavigateRef.current?.("previous");
            } else if (voiceCommand.type === "openAgent") {
              onVoiceOpenAgentRef.current?.(voiceCommand.name);
            }
            return; // Não adiciona o comando ao texto
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
      
      updateDraft(current.trim() ? `${current.trimEnd()}${separator}${text}` : text);
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech") { handleRecognitionEnd(); return; }
      clearSilenceTimer(); recognitionRef.current = null; setListening(false);
    };
    recognition.onend = handleRecognitionEnd;
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      clearSilenceTimer();
      recognitionRef.current = null;
      setListening(false);
    }
  };
  const stopListening = () => { intentionalStopRef.current = true; clearRestartTimer(); clearSilenceTimer(); autoResumeRef.current = false; recognitionRef.current?.stop(); };
  const toggleListening = () => { if (recognitionRef.current) stopListening(); else startListening(); };
  // Mic desativado no topo da página: interrompe o ditado em andamento imediatamente.
  useEffect(() => {
    if (!micEnabled && recognitionRef.current) stopListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micEnabled]);
  // Evita que o reconhecimento capte a própria voz do agente. Se o usuário
  // estava ditando antes da fala, retoma automaticamente quando ela termina;
  // se o microfone já estava parado, não inicia nada por conta própria.
  useEffect(() => {
    if (ttsSpeaking) {
      if (recognitionRef.current) {
        pausedForTtsRef.current = true;
        stopListening();
      }
      return;
    }
    if (!pausedForTtsRef.current) return;
    pausedForTtsRef.current = false;
    if (micEnabled && !busyRef.current && !loading) {
      window.setTimeout(() => {
        if (micEnabled && !busyRef.current && !loading && !recognitionRef.current) startListening();
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsSpeaking, micEnabled, processing, loading]);
  // Quando a resposta do agente chega (processing true→false) e o envio foi
  // automático pelo silêncio, religa o microfone para continuar ditando.
  useEffect(() => {
    const finished = wasProcessingRef.current && !processing;
    wasProcessingRef.current = processing;
    if (finished && autoResumeRef.current && micEnabled && !recognitionRef.current) {
      autoResumeRef.current = false;
      startListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing]);
  useEffect(() => () => { intentionalStopRef.current = true; clearRestartTimer(); recognitionRef.current?.stop(); clearSilenceTimer(); }, []);
  // Auto-liga o ditado ao abrir o chat (quando ocioso): o timer de silêncio só
  // arma após a primeira fala (onspeechstart), então não há envio acidental.
  // Com autoResumeRef=true, o mic também religa sozinho após a resposta do
  // agente; clicar/digitar no campo (ou o botão) desliga sem religar.
  useEffect(() => {
    if (!speechRecognitionSupported()) return;
    if (!micEnabled) return;
    if (!session || busyRef.current || loading) return;
    autoResumeRef.current = true;
    startListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitDraft = async () => {
    clearEnterDebounce();
    // Enviar manualmente interrompe o ditado (o auto-envio por silêncio já
    // parou o mic antes de chegar aqui — recognitionRef fica null lá).
    if (recognitionRef.current) stopListening();
    // Lê sempre o valor vivo via refs — seguro para o debounce (setTimeout) chamar
    // sem depender de closure de render.
    const text = (draftRef.current || "").trim();
    if (!text || busyRef.current || loading) return;
    setDraft("");
    onDraftChange("");
    streamRef.current?.stickToEnd();
    await onSend(text);
  };
  submitDraftRef.current = submitDraft;
  const sendForm = async (event: FormEvent) => {
    event.preventDefault();
    await submitDraft();
    // Retorna o foco para o textarea após enviar
    requestAnimationFrame(() => { textareaInputRef.current?.focus(); });
  };

  const streamMessage = streamText && agent ? { id: "live-stream", role: "assistant" as const, author: agent.name, content: streamText } : undefined;
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
  // IMPORTANTE (Rules of Hooks): este useMemo precisa rodar em TODOS os renders,
  // por isso fica ANTES do early return abaixo. Com agentId restaurado do
  // localStorage, session e agent podem ficar definidos em renders diferentes
  // (sessions carrega antes de agents); se o useMemo só rodasse com ambos já
  // presentes, a contagem de hooks mudava entre renders e o React derrubava a
  // árvore inteira ("Rendered more hooks than during the previous render" →
  // tela azul vazia no F5).
  const messageItems = useMemo(() => {
    if (!agent) return [];
    const display = groupDisplayMessages(messages);
    let lastMessageIndex = -1;
    for (let index = display.length - 1; index >= 0; index -= 1) if (display[index].kind === "message") { lastMessageIndex = index; break; }
    return display.map((item, index) => {
      if (item.kind === "activity") return <TechnicalActivity key={item.id} messages={item.messages} />;
      if (item.kind === "thinking") return <ThinkingActivity key={item.id} content={item.content} />;
      if (item.kind === "collapsed") return <CollapsedActivity key={item.id} items={item.items} />;
      const key = index === lastMessageIndex && tailReusesStreamKey ? "live-stream" : item.message.id;
      return <MessageBubble key={key} message={item.message} agent={agent} />;
    });
  }, [messages, agent, tailReusesStreamKey]);
  // Itens da corrente para as colunas contínuas (chave estável por mensagem).
  const streamItems = useMemo(
    () => messageItems.map((element) => ({ key: String(element.key), node: element })),
    [messageItems],
  );
  // Bolha de streaming em andamento (só quando o histórico ainda não contém o texto).
  const streamTail = streamMessage && !tailMatchesStream && agent
    ? <MessageBubble key="live-stream" message={streamMessage} agent={agent} />
    : undefined;

  if (!agent || !session) return <Box ref={columnLayout.ref} className="empty-chat"><AutoAwesomeRounded /><Typography variant="h6">Escolha uma sessão</Typography><Typography color="text.secondary">Abra uma conversa existente ou inicie uma nova.</Typography></Box>;

  return <Box ref={columnLayout.ref} className="chat-pane"><Box className="chat-header"><Box className="chat-header-title"><Stack direction="row" spacing={1} alignItems="center"><Tooltip title={mobile ? "Abrir conversas" : "Ocultar/mostrar conversas"}><IconButton size="small" className="toggle-chats" onClick={onToggleChats}><ChatBubbleOutlineRounded fontSize="small" /></IconButton></Tooltip><Typography variant="h6">{session.title ?? session.label ?? "Sessão"}</Typography></Stack>
    <Typography variant="caption" color="text.secondary">{agent.name} · {session.key}</Typography></Box>
    <Stack direction="row" spacing={0.6} alignItems="center" className="chat-header-controls">
      <Tooltip title={session.contextTokens === undefined ? "Tamanho total do contexto indisponível" : `${formatTokens(session.totalTokens)} de ${formatTokens(session.contextTokens)} tokens utilizados`}><Chip size="small" variant="outlined" label={`Contexto ${contextLabel(session)}`} /></Tooltip>
      {ttsSupported && <Tooltip title={ttsEnabled ? "Desativar leitura em voz alta" : "Ativar leitura em voz alta"}>
        <IconButton size="small" onClick={onToggleTts} color={ttsEnabled ? "primary" : "default"}>
          {ttsSpeaking ? <VolumeUpRounded fontSize="small" sx={{ animation: "pulse 1.2s infinite" }} /> : ttsEnabled ? <VolumeUpRounded fontSize="small" /> : <VolumeOffRounded fontSize="small" />}
        </IconButton>
      </Tooltip>}
      {ttsSupported && <Tooltip title={ttsMode === "summary" ? "Voz: resumo (clique para ler tudo)" : "Voz: texto completo (clique para resumir)"}>
        <IconButton size="small" onClick={onToggleTtsMode} color={ttsMode === "summary" ? "primary" : "default"} aria-label={ttsMode === "summary" ? "Usar resumo na leitura" : "Usar texto completo na leitura"}>
          <SummarizeRounded fontSize="small" />
        </IconButton>
      </Tooltip>}
      <Tooltip title={micEnabled ? "Desativar microfone (esconde os botões de ditado por voz)" : "Ativar microfone (mostra os botões de ditado por voz)"}>
        <IconButton size="small" onClick={onToggleMic} color={micEnabled ? "primary" : "default"} aria-label={micEnabled ? "Desativar microfone" : "Ativar microfone"}>
          {micEnabled ? <MicRounded fontSize="small" /> : <MicOffRounded fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Tooltip title="Salvar conversa"><IconButton size="small" onClick={() => downloadChat(agent, session, messages)} disabled={messages.length === 0}><DownloadRounded fontSize="small" /></IconButton></Tooltip>
      <Tooltip title="Detalhes da sessão"><IconButton size="small" onClick={onShowDetails}><DataObjectRounded fontSize="small" /></IconButton></Tooltip>
      {busy && <Tooltip title="Interromper"><IconButton color="error" size="small" onClick={() => void onAbort()}><StopCircleRounded /></IconButton></Tooltip>}
      <Tooltip title="Criar fork"><IconButton size="small" onClick={onFork}><CallSplitRounded fontSize="small" /></IconButton></Tooltip>
    </Stack></Box>
    <MultiColumnStream ref={streamRef} className="stream-mode" layout={columnLayout.layout} items={streamItems} tail={streamTail} loading={loading} composerHeight={composerMeasure.height} />
    <Box className="stream-composer-row" ref={composerMeasure.ref} style={{ width: columnLayout.layout.columnWidth, left: columnLayout.layout.padX }}>
    <Box component="form" onSubmit={sendForm} className={`composer-wrap${columnLayout.layout.columns > 1 ? " stream-composer" : ""}`}><Paper className="composer" elevation={0}><TextField inputRef={textareaInputRef} multiline maxRows={5} fullWidth placeholder={loading ? "Carregando histórico…" : busy ? `Escreva aqui (o envio só habilita quando ${agent.name} terminar)…` : `Conversar com ${agent.name} nesta sessão…`} disabled={false} value={draft} onChange={(e) => updateDraft(e.target.value)} minRows={1} variant="standard" InputProps={{ disableUnderline: true }} onFocus={() => { if (recognitionRef.current) stopListening(); }} onKeyDown={(event) => {
      // Digitar com o teclado encerra o ditado por voz.
      if (recognitionRef.current) stopListening();
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

      // No modo "Enter envia", aguarda um instante antes de enviar. Isso dá
      // ao usuário uma janela para começar a digitar e cancelar o envio.
      if (sendShortcut === "enter" && !modifier && !event.shiftKey) {
        event.preventDefault();
        clearEnterDebounce();
        // Como o envio é adiado, reproduzimos aqui o comportamento padrão do
        // textarea: o Enter ainda insere uma quebra de linha.
        const nextDraft = `${draftRef.current}\n`;
        draftRef.current = nextDraft;
        setDraft(nextDraft);
        onDraftChange(nextDraft);
        if (!busyRef.current && !loading) {
          enterDebounceRef.current = setTimeout(() => {
            enterDebounceRef.current = undefined;
            void submitDraft();
          }, 1000);
        }
        return;
      }

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
      if (sendShortcut === "enter" || busyRef.current || loading) { clearEnterDebounce(); return; }
      clearEnterDebounce();
      if (draftRef.current.trim()) {
        enterDebounceRef.current = setTimeout(() => { enterDebounceRef.current = undefined; void submitDraft(); }, 1000);
      }
    }} />
      <Box className="composer-toolbar">
        <Box className="composer-toolbar-left">
          {busy && <Box className="composer-processing" role="status" aria-live="polite"><CircularProgress size={13} thickness={5} /><Typography variant="caption">Processando</Typography></Box>}
          <Tooltip title={displayModel(session, agent)}><Select className="model-select" size="small" value={displayModel(session, agent)} disabled={busy} onChange={(event) => { const ref = String(event.target.value); if (ref && ref !== displayModel(session, agent)) void onModelChange(ref); }} renderValue={(value) => truncateLabel(String(value))} aria-label="Modelo da sessão"><MenuItem value={displayModel(session, agent)}>Modelo atual</MenuItem>{models.map((model) => { const ref = `${model.provider}/${model.id}`; const current = ref === displayModel(session, agent) || model.name === displayModel(session, agent); if (current) return null; const blockedReason = modelSwitchBlockReason(model, session); return <MenuItem value={ref} key={ref} disabled={Boolean(blockedReason)} title={blockedReason ?? model.name}>{model.name}{blockedReason ? " · contexto insuficiente" : ""}</MenuItem>; })}</Select></Tooltip>
          <Select className="send-shortcut" size="small" value={sendShortcut} onChange={(event) => onShortcutChange(event.target.value as SendShortcut)} aria-label="Atalho para enviar mensagem"><MenuItem value="enter">Enter envia</MenuItem><MenuItem value="ctrl-enter">Ctrl+Enter envia</MenuItem></Select>
        </Box>
        <Box className="composer-toolbar-right">
          {micEnabled && <Tooltip title={!speechRecognitionSupported() ? "Ditado por voz não suportado neste navegador (use Chrome/Edge/Safari)" : listening ? (silenceRemainingMs !== null && silenceRemainingMs > 0 ? `Envia em ${Math.ceil(silenceRemainingMs / 1000)}s — clique para cancelar` : "Parar ditado") : "Ditar por voz (6s de silêncio envia; o mic religa após a resposta)"}><span><Box className="mic-wrap">
          {listening && silenceRemainingMs !== null && silenceRemainingMs > 0 && <CircularProgress className={silenceRemainingMs <= 3000 ? "mic-countdown urgent" : "mic-countdown"} variant="determinate" size={46} thickness={3} value={(silenceRemainingMs / DICTATION_SILENCE_MS) * 100} />}
          <IconButton type="button" className={listening ? "mic-button listening" : "mic-button"} onClick={toggleListening} disabled={!speechRecognitionSupported()} aria-label={listening ? "Parar ditado" : "Ditar por voz"}>{listening ? <StopCircleRounded /> : <MicRounded />}</IconButton>
          </Box></span></Tooltip>}
          <IconButton type="submit" className="send-button" disabled={!draft.trim() || busy || loading}><SendRounded /></IconButton>
        </Box>
      </Box></Paper></Box></Box></Box>;
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
const micEnabledStorageKey = "openclaw-console-mic-enabled";
function loadSendShortcut(): SendShortcut { return localStorage.getItem(shortcutStorageKey) === "enter" ? "enter" : "ctrl-enter"; }
function loadChatsVisible(): boolean { return localStorage.getItem(chatsVisibleStorageKey) !== "false"; }
function loadMicEnabled(): boolean { return localStorage.getItem(micEnabledStorageKey) !== "false"; }
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
  const tts = useTextToSpeech();
  const [micEnabled, setMicEnabled] = useState<boolean>(loadMicEnabled);
  useEffect(() => { try { localStorage.setItem(micEnabledStorageKey, String(micEnabled)); } catch { /* storage unavailable */ } }, [micEnabled]);
  const toggleMic = () => setMicEnabled((current) => !current);
  const [agents, setAgents] = useState<ApiAgent[]>([]); const [models, setModels] = useState<ApiModel[]>([]); const [sessions, setSessions] = useState<ApiSession[]>([]); const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [status, setStatus] = useState<GatewayStatus>(); const [agentId, setAgentId] = useState(() => loadSavedUiState().agentId); const [sessionKey, setSessionKey] = useState(() => loadSavedUiState().sessionKey); const currentSessionKeyRef = useRef(""); const initialRestoreRef = useRef(true); const [sessionId, setSessionId] = useState<string>();
  const [loading, setLoading] = useState(true); const [sessionsLoading, setSessionsLoading] = useState(false); const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false); const [sessionsHasMore, setSessionsHasMore] = useState(false); const [sessionsNextOffset, setSessionsNextOffset] = useState(0); const [historyLoading, setHistoryLoading] = useState(false); const [error, setError] = useState("");
  const [processing, setProcessing] = useState(false); const processingBySessionRef = useRef(new Map<string, boolean>()); const [processingAgentIds, setProcessingAgentIds] = useState<Set<string>>(() => new Set());
  const [detailsModalOpen, setDetailsModalOpen] = useState(false); const [detailsForSession, setDetailsForSession] = useState<ApiSession | undefined>();
  const [notifications, setNotifications] = useState<ApiNotification[]>([]); const [notificationsAnchor, setNotificationsAnchor] = useState<HTMLElement | null>(null);
  const [sessionSummaries, setSessionSummaries] = useState<Record<string, ApiSessionSummary>>({});
  const lastSessionByAgentRef = useRef(new Map<string, string>());
  const sessionLoadsRef = useRef(new Map<string, Promise<void>>());
  const notificationsRef = useRef<ApiNotification[]>([]); const agentsRef = useRef<ApiAgent[]>([]);
  // Notificações aguardando o agente PARAR de processar (hasActiveRun false) para serem exibidas.
  const pendingNotificationsRef = useRef(new Map<string, ApiNotification>());
  const notificationAudioRef = useRef<AudioContext | null>(null); const notificationsInitializedRef = useRef(false);
  // Timestamp da última conversa por agente (max de lastActivityAt/updatedAt das sessões) — ordena o combo de agentes por recência.
  const [agentLastActivity, setAgentLastActivity] = useState<Record<string, number>>({});
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
  agentsRef.current = agents; notificationsRef.current = notifications;
  // Combo de agentes: mais recentemente conversados primeiro; empates preservam a ordem original.
  const agentsByRecent = useMemo(() => {
    const sorted = [...agents];
    sorted.sort((a, b) => (agentLastActivity[b.id] ?? 0) - (agentLastActivity[a.id] ?? 0));
    return sorted;
  }, [agents, agentLastActivity]);
  const isNarrow = viewportWidth <= 900;
  const gridColumns = useMemo(() => {
    if (view === "agents") return `${viewportWidth <= 720 ? 58 : 68}px minmax(0, 1fr)`;
    if (view === "groups") return `${viewportWidth <= 720 ? 58 : 68}px minmax(240px, 300px) minmax(0, 1fr)`;
    if (isNarrow) return `${viewportWidth <= 720 ? 58 : 68}px minmax(0, 1fr)`;
    return `${viewportWidth <= 720 ? 58 : 68}px ${chatsColumnVisible ? "minmax(240px, 300px)" : "minmax(0, 0px)"} minmax(0, 1fr)`;
  }, [view, viewportWidth, chatsColumnVisible, isNarrow]);

  const refreshProcessingAgents = useCallback(() => { const active = new Set<string>(); for (const [key, running] of processingBySessionRef.current) { const id = agentIdFromSessionKey(key); if (running && id) active.add(id); } setProcessingAgentIds(active); }, []);
  const loadAgentActivity = useCallback(async (nextAgents: ApiAgent[]) => { try { const result = await api.sessionSummaries(nextAgents.map((agent) => agent.id)); const summaries: Record<string, ApiSessionSummary> = {}; const activity: Record<string, number> = {}; for (const summary of result.summaries) { summaries[summary.agentId] = summary; if (summary.latestActivityAt) activity[summary.agentId] = summary.latestActivityAt; } setSessionSummaries((current) => ({ ...current, ...summaries })); setAgentLastActivity((current) => ({ ...current, ...activity })); } catch { /* o cache local e o SSE continuam funcionando */ } }, []);
  const playNotificationSound = useCallback(() => {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!notificationAudioRef.current) notificationAudioRef.current = new Ctx();
      const ctx = notificationAudioRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const now = ctx.currentTime;
      const tone = (frequency: number, startOffset: number, duration: number, volume: number) => {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        const start = now + startOffset;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(volume, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.05);
      };
      // "ding-dong" curto e agradável: A5 seguido de E6
      tone(880, 0, 0.35, 0.16);
      tone(1318.5, 0.14, 0.5, 0.13);
    } catch { /* áudio indisponível */ }
  }, []);
  // Adiciona/atualiza uma notificação; toca o som apenas quando é uma notificação NOVA (chave não existia).
  const pushNotification = useCallback((item: ApiNotification) => {
    const exists = notificationsRef.current.some((notification) => notification.session.key === item.session.key);
    setNotifications((current) => {
      const index = current.findIndex((notification) => notification.session.key === item.session.key);
      if (index < 0) return [item, ...current];
      const next = [...current];
      next[index] = item;
      return next;
    });
    if (!exists) playNotificationSound();
  }, [playNotificationSound]);
  // Confirma via API (fonte de verdade) que o agente PAROU de processar e então promove a pendência.
  // O SSE de sessions.changed não entrega hasActiveRun=false de forma confiável no terminal
  // (o último broadcast pós-persistência ainda pode chegar com hasActiveRun=true), então
  // consultamos a API em pequenos intervalos até o run terminar de fato.
  const promotePendingWhenStopped = useCallback(async (key: string, owner: string) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const pending = pendingNotificationsRef.current.get(key);
      if (!pending) return; // já promovida, lida ou descartada
      if (currentSessionKeyRef.current === key) return; // usuário abriu a sessão: não notifica
      try {
        const page = await api.sessions(owner, 0, 200);
        const fresh = page.sessions.find((session) => session.key === key);
        if (fresh && !fresh.hasActiveRun) {
          pendingNotificationsRef.current.delete(key);
          if (fresh.unread && !fresh.archived) {
            pushNotification(pending);
          }
          return;
        }
      } catch { /* tenta novamente no próximo intervalo */ }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }, [pushNotification]);
  // Aquece o AudioContext no primeiro gesto do usuário (autoplay policy) para o som tocar de fato.
  useEffect(() => {
    const warm = () => {
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        if (!notificationAudioRef.current) notificationAudioRef.current = new Ctx();
        if (notificationAudioRef.current.state === "suspended") void notificationAudioRef.current.resume();
      } catch { /* áudio indisponível */ }
    };
    window.addEventListener("pointerdown", warm, { once: true });
    window.addEventListener("keydown", warm, { once: true });
    return () => { window.removeEventListener("pointerdown", warm); window.removeEventListener("keydown", warm); };
  }, []);
  const loadNotifications = useCallback(async () => {
    try {
      const items = await api.notifications();
      // (d) ignora sessões ainda com run ativo; (c) ignora sessões sem preview de texto real.
      const visible = items.filter((item) => !item.session.hasActiveRun && Boolean((item.session.lastMessagePreview ?? "").trim()));
      const firstLoad = !notificationsInitializedRef.current;
      notificationsInitializedRef.current = true;
      setNotifications((current) => {
        if (current.length === visible.length && current.every((item, index) => item.session.key === visible[index]?.session.key && item.session.unread === visible[index]?.session.unread)) return current;
        return visible;
      });
      for (const item of visible) pendingNotificationsRef.current.delete(item.session.key);
      if (!firstLoad) {
        const known = new Set(notificationsRef.current.map((item) => item.session.key));
        for (const item of visible) if (!known.has(item.session.key)) { playNotificationSound(); break; }
      }
    } catch { /* o refresh periódico reconcilia quando o Gateway voltar */ }
  }, [playNotificationSound]);
  const markNotificationsRead = useCallback(async (sessionsToMark: Array<{ key: string; agentId: string }>) => { if (!sessionsToMark.length) return; const keys = new Set(sessionsToMark.map((session) => session.key)); for (const key of keys) pendingNotificationsRef.current.delete(key); setNotifications((current) => current.filter((item) => !keys.has(item.session.key))); await Promise.allSettled(sessionsToMark.map((session) => api.patchSession({ key: session.key, agentId: session.agentId, unread: false }))); }, []);
  const openNotification = useCallback((session: ApiSession) => { const targetAgentId = sessionAgentId(session) ?? session.agentId; setAgentId(targetAgentId); setSessionKey(session.key); setView("conversations"); setNotificationsAnchor(null); void markNotificationsRead([session]); }, [markNotificationsRead]);
  const loadRoot = useCallback(async () => { setLoading(true); setError(""); try { const nextStatus = await api.status(); gatewayConnectedRef.current = nextStatus.connected; setStatus(nextStatus); if (!nextStatus.connected) return; const [nextAgents, nextModels] = await Promise.all([api.agents(), api.models()]); setAgents(nextAgents); setModels(nextModels); setAgentId((current) => current && nextAgents.some((a) => a.id === current) ? current : nextAgents[0]?.id ?? ""); void loadAgentActivity(nextAgents); void loadNotifications(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); } }, [loadAgentActivity, loadNotifications]);
  const setSessionProcessing = useCallback((key: string, active: boolean) => { processingBySessionRef.current.set(key, active); refreshProcessingAgents(); setSessions((current) => current.map((session) => session.key === key && session.hasActiveRun !== active ? { ...session, hasActiveRun: active } : session)); }, [refreshProcessingAgents]);
  const loadSessions = useCallback(async (nextAgentId: string, offset = 0, append = false) => { if (!nextAgentId) return; if (!append) { const running = sessionLoadsRef.current.get(nextAgentId); if (running) return running; } const task = (async () => { if (!append) { try { const cached = await readCachedSessions(nextAgentId); if (cached.length) { setSessions(cached); setSessionsNextOffset(cached.length); setSessionKey((current) => lastSessionByAgentRef.current.get(nextAgentId) ?? (cached.some((s) => s.key === current) ? current : cached[0]?.key ?? "")); } } catch { /* IndexedDB é opcional */ } } append ? setSessionsLoadingMore(true) : setSessionsLoading(true); setError(""); try { const page = await api.sessions(nextAgentId, offset, 50); const rows = page.sessions.filter((session) => sessionAgentId(session) === nextAgentId); await saveSessions(rows); for (const row of rows) processingBySessionRef.current.set(row.key, row.hasActiveRun); refreshProcessingAgents(); setSessions((current) => append ? [...current, ...rows.filter((row) => !current.some((existing) => existing.key === row.key))] : rows); setSessionsHasMore(page.hasMore ?? offset + page.sessions.length < (page.totalCount ?? offset + page.sessions.length)); setSessionsNextOffset(page.nextOffset ?? offset + page.sessions.length); if (!append) setSessionKey((current) => lastSessionByAgentRef.current.get(nextAgentId) ?? (rows.some((s) => s.key === current) ? current : rows[0]?.key ?? "")); } catch (e) { if (!append) setError(e instanceof Error ? e.message : String(e)); } finally { append ? setSessionsLoadingMore(false) : setSessionsLoading(false); } })(); if (!append) sessionLoadsRef.current.set(nextAgentId, task); try { await task; } finally { if (!append) sessionLoadsRef.current.delete(nextAgentId); } }, [refreshProcessingAgents]);
  const refreshSessionMetadata = useCallback(async (key: string, id: string) => { try { const page = await api.sessions(id, 0, 200); const fresh = page.sessions.find((session) => session.key === key); if (!fresh) return; processingBySessionRef.current.set(key, fresh.hasActiveRun); refreshProcessingAgents(); setSessions((current) => current.map((session) => session.key === key ? { ...session, ...fresh } : session)); } catch { /* A próxima atualização SSE ou sondagem reconciliará os metadados. */ } }, [refreshProcessingAgents]);
  const loadHistory = useCallback(async (key: string, id: string, options?: { silent?: boolean }) => { if (!key || !id) return; setHistoryLoading(true); try { const history = await api.history(key, id); const pending = optimisticMessagesRef.current.get(key) ?? []; const unresolved = pending.filter((optimistic) => !history.messages.some((stored) => stored.role === "user" && stored.content === optimistic.content)); if (unresolved.length) optimisticMessagesRef.current.set(key, unresolved); else optimisticMessagesRef.current.delete(key); setMessages(mergePendingMessages(history.messages, unresolved)); setSessionId(history.sessionId); setStreamText(""); terminalTextRef.current = undefined; /* a resposta persistida assume a key fixa "live-stream" no render, reutilizando a mesma bolha do streaming sem remontar */ } catch (e) { const detail = e instanceof Error ? e.message : String(e); console.warn("Falha ao sincronizar o histórico do chat:", detail); if (!options?.silent) setError(detail); } finally { setHistoryLoading(false); } }, []);
  useEffect(() => { void loadRoot(); }, [loadRoot]);
  useEffect(() => { const resize = () => setViewportWidth(window.innerWidth); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  useEffect(() => { localStorage.setItem(shortcutStorageKey, sendShortcut); }, [sendShortcut]);
  useEffect(() => { localStorage.setItem(chatsVisibleStorageKey, String(chatsVisible)); }, [chatsVisible]);
  useEffect(() => { try { localStorage.setItem(uiStateStorageKey, JSON.stringify({ agentId, sessionKey })); } catch { /* armazenamento indisponível */ } }, [agentId, sessionKey]);
  useEffect(() => { currentSessionKeyRef.current = sessionKey; }, [sessionKey]);
  useEffect(() => {
    const firstLoad = initialRestoreRef.current;
    if (!firstLoad) { setSessionsHasMore(false); setSessionsNextOffset(0); setMessages([]); }
    if (agentId) void loadSessions(agentId);
  }, [agentId, loadSessions]);
  useEffect(() => { initialRestoreRef.current = false; }, []);
  useEffect(() => { if (sessionKey && selectedSessionAgentId) lastSessionByAgentRef.current.set(selectedSessionAgentId, sessionKey); setMessages(optimisticMessagesRef.current.get(sessionKey) ?? []); setSessionId(undefined); setStreamText(""); setRunId(undefined); const active = processingBySessionRef.current.get(sessionKey) ?? Boolean(selectedSession?.hasActiveRun); setProcessing(active); if (sessionKey && selectedSessionAgentId) void loadHistory(sessionKey, selectedSessionAgentId); }, [sessionKey, selectedSessionAgentId, loadHistory]);
  // Ao abrir uma sessão, marcar como lida (o Gateway seta lastReadAt; novas respostas voltam a notificar)
  useEffect(() => { const item = notificationsRef.current.find((n) => n.session.key === sessionKey); if (item) void markNotificationsRead([item.session]); }, [sessionKey, markNotificationsRead]);
  // Reconciliação periódica das notificações (fonte da verdade é o Gateway)
  useEffect(() => { const refresh = () => { if (document.visibilityState === "visible") void loadNotifications(); }; const timer = window.setInterval(refresh, 60_000); document.addEventListener("visibilitychange", refresh); window.addEventListener("focus", refresh); return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("focus", refresh); }; }, [loadNotifications]);
  const recoverGatewayStatus = useCallback(() => { if (statusProbeRef.current) return statusProbeRef.current; const probe = (async () => { try { const nextStatus = await api.status(); const reconnected = !gatewayConnectedRef.current && nextStatus.connected; gatewayConnectedRef.current = nextStatus.connected; setStatus(nextStatus); if (reconnected) await loadRoot(); return nextStatus.connected; } catch { gatewayConnectedRef.current = false; return false; } finally { statusProbeRef.current = undefined; } })(); statusProbeRef.current = probe; return probe; }, [loadRoot]);
  useEffect(() => { let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined; const probe = async () => { const online = await recoverGatewayStatus(); if (!cancelled) timer = setTimeout(() => void probe(), online ? 30_000 : 4_000); }; timer = setTimeout(() => void probe(), 4_000); const wake = () => { if (document.visibilityState === "visible") void recoverGatewayStatus(); }; window.addEventListener("online", wake); document.addEventListener("visibilitychange", wake); return () => { cancelled = true; if (timer) clearTimeout(timer); window.removeEventListener("online", wake); document.removeEventListener("visibilitychange", wake); }; }, [recoverGatewayStatus]);
  useEffect(() => api.events({ onOpen: () => { void recoverGatewayStatus(); }, onError: () => { void recoverGatewayStatus(); }, onStatus: (nextStatus) => { const reconnected = !gatewayConnectedRef.current && nextStatus.connected; gatewayConnectedRef.current = nextStatus.connected; setStatus(nextStatus); if (reconnected) void loadRoot(); }, onSessions: (event) => { const key = event.sessionKey ?? event.session?.key; if (!key) return; if (event.reason === "delete") { pendingNotificationsRef.current.delete(key); setSessions((current) => current.filter((session) => session.key !== key)); processingBySessionRef.current.delete(key); refreshProcessingAgents(); if (currentSessionKeyRef.current === key) { setSessionKey(""); void loadSessions(agentId); } return; } if (!event.session) return; const session = event.session; if (session.hasActiveRun) { /* agente (ainda) processando: esconde a notificação visível, mas NÃO descarta a pendência — o broadcast pós-persistência do Gateway pode chegar com hasActiveRun=true mesmo após o final; a promoção é confirmada via API (promotePendingWhenStopped) */ setNotifications((current) => current.filter((item) => item.session.key !== key)); } else if (session.unread && !session.archived && currentSessionKeyRef.current !== key) { /* (a)(c)(d) parou, não lida, sessão não aberta: promove a pendência (texto final real) ou cria com preview do servidor */ const pending = pendingNotificationsRef.current.get(key); pendingNotificationsRef.current.delete(key); if (pending) { pushNotification(pending); } else { const preview = (session.lastMessagePreview ?? "").trim(); if (preview) { const agent = agentsRef.current.find((a) => a.id === session.agentId); pushNotification({ session: { ...session, unread: true }, agent: agent ?? { id: session.agentId, name: session.agentId, isDefault: false, status: "unknown" as const } }); } } } else { pendingNotificationsRef.current.delete(key); setNotifications((current) => current.filter((item) => item.session.key !== key)); } processingBySessionRef.current.set(key, session.hasActiveRun); refreshProcessingAgents(); const sessionActivity = Math.max(typeof event.session.lastActivityAt === "number" ? event.session.lastActivityAt : 0, typeof event.session.updatedAt === "number" ? event.session.updatedAt : 0); if (sessionActivity > 0) { const activityAgentId = event.session.agentId; setAgentLastActivity((current) => (current[activityAgentId] ?? 0) < sessionActivity ? { ...current, [activityAgentId]: sessionActivity } : current); } if (event.session.agentId !== agentId) return; setSessions((current) => { const index = current.findIndex((session) => session.key === key); if (index < 0) return [event.session!, ...current]; const next = [...current]; next[index] = { ...current[index], ...event.session! }; return next; }); if (currentSessionKeyRef.current === key) setProcessing(event.session.hasActiveRun); }, onChat: (event) => { const isTerminal = event.state === "final" || event.state === "aborted" || event.state === "error"; setSessionProcessing(event.sessionKey, !isTerminal); const chatOwner = agentIdFromSessionKey(event.sessionKey, event.agentId ?? agentId) ?? agentId; if (chatOwner) setAgentLastActivity((current) => (current[chatOwner] ?? 0) < Date.now() ? { ...current, [chatOwner]: Date.now() } : current); if (event.sessionKey !== sessionKey) { if (event.state === "final") { /* (c) só mensagem de texto real do assistant (exclui tool/thinking/system/comando) */ const message = event.message; const content = message && message.role === "assistant" ? (message.content ?? "").trim() : ""; if (content) { const owner = agentIdFromSessionKey(event.sessionKey, event.agentId ?? agentId) ?? agentId; const agent = agentsRef.current.find((a) => a.id === owner); const session: ApiSession = { key: event.sessionKey, agentId: owner, title: event.sessionKey, state: "idle", archived: false, pinned: false, unread: true, hasActiveRun: false, lastActivityAt: Date.now(), updatedAt: Date.now(), lastMessagePreview: content }; /* (d) só exibe quando o Gateway confirmar hasActiveRun=false (verificação via API em promotePendingWhenStopped) */ pendingNotificationsRef.current.set(event.sessionKey, { session, agent: agent ?? { id: owner, name: owner, isDefault: false, status: "unknown" as const } }); void promotePendingWhenStopped(event.sessionKey, owner); } } return; } if (event.state === "delta") { setProcessing(true); const nextText = event.replace ? event.deltaText ?? "" : (terminalTextRef.current ?? "") + (event.deltaText ?? ""); terminalTextRef.current = nextText; setStreamText(nextText); }
    if (isTerminal) { const owner = agentIdFromSessionKey(sessionKey, event.agentId ?? agentId) ?? agentId; setProcessing(false); setRunId(undefined); if (event.state === "final" && terminalTextRef.current) tts.speak(terminalTextRef.current); void markNotificationsRead([{ key: sessionKey, agentId: owner }]); void Promise.all([loadHistory(sessionKey, owner, { silent: true }), refreshSessionMetadata(sessionKey, owner)]).catch(() => { setStreamText(""); terminalTextRef.current = undefined; }); window.setTimeout(() => void refreshSessionMetadata(sessionKey, owner), 800); if ("errorMessage" in event && event.errorMessage) console.warn("O Gateway encerrou o processamento com aviso:", event.errorMessage); if (event.state === "error" && (event.errorKind === "context_length" || event.errorKind === "rate_limit")) { const errorText = event.errorKind === "context_length" ? "⚠️ A conversa atingiu o limite de tokens do modelo. Crie um novo chat ou troque o modelo para continuar." : "⚠️ Limite de requisições do modelo atingido. Aguarde alguns instantes e tente novamente."; setMessages((current) => [...current, { id: `error-${Date.now()}`, role: "system", content: errorText, timestamp: Date.now() }]); } }
  } }), [sessionKey, agentId, loadHistory, loadRoot, loadSessions, recoverGatewayStatus, refreshProcessingAgents, refreshSessionMetadata, setSessionProcessing, markNotificationsRead, pushNotification, promotePendingWhenStopped]);
  useEffect(() => { if (!processing || !sessionKey || !selectedSessionAgentId) return; let cancelled = false; let inactiveChecks = 0; let timer: ReturnType<typeof setTimeout> | undefined; const reconcile = async () => { try { const page = await api.sessions(selectedSessionAgentId, 0, 200); const current = page.sessions.find((session) => session.key === sessionKey); if (current?.hasActiveRun) inactiveChecks = 0; else if (current && ++inactiveChecks >= 2) { cancelled = true; setSessionProcessing(sessionKey, false); if (currentSessionKeyRef.current === sessionKey) { setProcessing(false); setRunId(undefined); await Promise.all([loadHistory(sessionKey, selectedSessionAgentId), refreshSessionMetadata(sessionKey, selectedSessionAgentId)]); } } } catch { /* SSE remains authoritative while reconciliation is unavailable. */ } finally { if (!cancelled) timer = setTimeout(() => void reconcile(), 5_000); } }; timer = setTimeout(() => void reconcile(), 4_000); return () => { cancelled = true; if (timer) clearTimeout(timer); }; }, [processing, sessionKey, selectedSessionAgentId, loadHistory, refreshSessionMetadata, setSessionProcessing]);
  const loadMoreSessions = useCallback(() => { if (agentId && sessionsHasMore && !sessionsLoading && !sessionsLoadingMore) void loadSessions(agentId, sessionsNextOffset, true); }, [agentId, sessionsHasMore, sessionsLoading, sessionsLoadingMore, sessionsNextOffset, loadSessions]);
  const send = async (message: string) => { if (!selectedAgent || !selectedSession) return; const targetSessionKey = selectedSession.key; const targetAgentId = sessionAgentId(selectedSession); const trimmedMessage = message.trim(); if (/^\/model(?:\s|$)/i.test(trimmedMessage)) { const ref = trimmedMessage.replace(/^\/model\s*/i, "").trim(); const targetModel = models.find((model) => `${model.provider}/${model.id}` === ref || model.alias === ref || model.name === ref); const blockedReason = modelSwitchBlockReason(targetModel, selectedSession); if (blockedReason) { setError(blockedReason); return; } } const wasAutoNamed = /^Chat \d+$/i.test(selectedSession.label ?? selectedSession.title ?? ""); const optimistic = { id: clientId(), role: "user" as const, author: "Alexandre", timestamp: Date.now(), content: message }; optimisticMessagesRef.current.set(targetSessionKey, [...(optimisticMessagesRef.current.get(targetSessionKey) ?? []), optimistic]); terminalTextRef.current = undefined; flushSync(() => { setError(""); setSessionProcessing(targetSessionKey, true); setProcessing(true); setMessages((current) => [...current, optimistic]); }); try { const result = await api.send({ sessionKey: targetSessionKey, agentId: targetAgentId, sessionId, message }); if (currentSessionKeyRef.current === targetSessionKey && processingBySessionRef.current.get(targetSessionKey)) setRunId(result.runId); if (/^\/model(?:\s|$)/i.test(message.trim())) { window.setTimeout(() => void refreshSessionMetadata(targetSessionKey, targetAgentId), 300); window.setTimeout(() => void refreshSessionMetadata(targetSessionKey, targetAgentId), 1_200); } else if (wasAutoNamed && !/^\/(?:model|new|fork|abort)/i.test(message.trim())) { const suggested = suggestSessionName(message); if (suggested && suggested !== (selectedSession.label ?? selectedSession.title)) { try { await api.patchSession({ key: targetSessionKey, agentId: targetAgentId, label: suggested }); setSessions((current) => current.map((item) => item.key === targetSessionKey ? { ...item, label: suggested, title: suggested } : item)); } catch { /* renomeio não crítico */ } } } } catch (e) { optimisticMessagesRef.current.set(targetSessionKey, (optimisticMessagesRef.current.get(targetSessionKey) ?? []).filter((item) => item.id !== optimistic.id)); setSessionProcessing(targetSessionKey, false); if (currentSessionKeyRef.current === targetSessionKey) { setProcessing(false); setRunId(undefined); setError(e instanceof Error ? e.message : String(e)); await loadHistory(targetSessionKey, targetAgentId); } } };
  const abort = async () => { if (!selectedSession) return; await api.abort({ sessionKey: selectedSession.key, agentId: sessionAgentId(selectedSession), runId }); };
  const nextChatNumber = (targetAgentId: string) => { const existing = sessions.filter((session) => sessionAgentId(session) === targetAgentId && /^Chat \d+$/i.test(session.label ?? session.title ?? "")); const used = new Set(existing.map((session) => Number((session.label ?? session.title ?? "").match(/\d+/)?.[0] ?? 0))); let n = 1; while (used.has(n)) n += 1; return n; };
  const create = async (targetAgentId?: string) => { const target = agents.find((agent) => agent.id === (targetAgentId ?? agentId)); if (!target) return; const label = `Chat ${String(nextChatNumber(target.id)).padStart(2, "0")}`; try { const result = await api.createSession({ agentId: target.id, label }); await loadSessions(target.id); setSessionKey(result.key); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  // Navegação por voz entre agentes (ordem de recência): abre a conversa mais
  // recente do próximo/anterior agente.
  const voiceNavigateAgent = useCallback((direction: "next" | "previous") => {
    const list = agentsByRecent;
    if (list.length === 0) return;
    const currentIndex = list.findIndex((agent) => agent.id === agentId);
    const base = currentIndex < 0 ? 0 : currentIndex;
    const nextIndex = (base + (direction === "next" ? 1 : -1) + list.length) % list.length;
    const target = list[nextIndex];
    if (!target || target.id === agentId) return;
    setAgentId(target.id);
    setView("conversations");
    void loadSessions(target.id);
  }, [agentsByRecent, agentId, loadSessions]);
  // "abrir <nome>" — pula direto para a conversa mais recente do agente.
  const openAgentChat = useCallback((name: string) => {
    const normalized = normalizeText(name);
    if (!normalized) return;
    const target = agents.find((agent) => {
      const candidate = normalizeText(agent.name ?? agent.id);
      return candidate.includes(normalized) || normalized.includes(candidate);
    });
    if (!target || target.id === agentId) return;
    setAgentId(target.id);
    setView("conversations");
    void loadSessions(target.id);
  }, [agents, agentId, loadSessions]);
  const renameSession = async (session: ApiSession) => { const label = window.prompt("Novo nome da sessão:", session.label ?? session.title)?.trim(); if (!label || label === (session.label ?? session.title)) return; try { await api.patchSession({ key: session.key, agentId: sessionAgentId(session), label }); setSessions((current) => current.map((item) => item.key === session.key ? { ...item, label, title: label } : item)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const deleteSession = async (session: ApiSession) => { if (session.hasActiveRun) return; if (!window.confirm(`Excluir definitivamente a sessão “${session.label ?? session.title}”? O histórico será arquivado pelo Gateway.`)) return; const key = session.key; try { const result = await api.deleteSession({ key, agentId: sessionAgentId(session) }); if (!result.deleted) throw new Error("O Gateway não excluiu a sessão"); setSessions((current) => current.filter((item) => item.key !== key)); processingBySessionRef.current.delete(key); if (currentSessionKeyRef.current === key) setSessionKey(""); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  // Ocultar/mostrar usa o campo archived do Gateway: a sessão continua existindo com
  // histórico intacto, apenas sai da lista de conversas (e para de gerar notificações).
  const toggleHiddenSession = async (session: ApiSession) => {
    const nextHidden = !session.archived;
    try {
      await api.patchSession({ key: session.key, agentId: sessionAgentId(session), archived: nextHidden });
      setSessions((current) => current.map((item) => item.key === session.key ? { ...item, archived: nextHidden, ...(nextHidden ? { unread: false } : {}) } : item));
      if (nextHidden) setNotifications((current) => current.filter((item) => item.session.key !== session.key));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const changeSessionModel = async (session: ApiSession, modelRef: string) => {
    const blockedReason = modelSwitchBlockReason(models.find((model) => `${model.provider}/${model.id}` === modelRef), session);
    if (blockedReason) { setError(blockedReason); return; }
    try {
      await api.patchSession({ key: session.key, agentId: sessionAgentId(session), model: modelRef });
      const slash = modelRef.indexOf("/");
      const modelProvider = slash > 0 ? modelRef.slice(0, slash) : undefined;
      const model = slash > 0 ? modelRef.slice(slash + 1) : modelRef;
      setSessions((current) => current.map((item) => item.key === session.key ? { ...item, model, ...(modelProvider ? { modelProvider } : {}) } : item));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const fork = async () => { if (!selectedAgent || !selectedSession) return; const label = window.prompt("Nome do fork:", `Fork · ${selectedSession.label ?? selectedSession.title ?? "sessão"}`)?.trim(); if (!label) return; try { const result = await api.forkSession({ parentSessionKey: selectedSession.key, agentId: sessionAgentId(selectedSession), label }); await loadSessions(selectedAgent.id); setSessionKey(result.key); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };

  const groupState = useAgentGroups(agents);

  return <Box className={`console-shell theme-${themeName} view-${view}${chatsVisible || chatsColumnVisible ? " chats-visible" : ""}`} style={{ gridTemplateColumns: gridColumns }}><BrandRail view={view} onNavigate={setView} notifications={notifications} notificationsAnchor={notificationsAnchor}
    onToggleNotifications={(anchor) => setNotificationsAnchor((current) => current === anchor ? null : anchor)}
    onCloseNotifications={() => setNotificationsAnchor(null)}
    onSelectNotification={openNotification}
    onMarkAllRead={() => void markNotificationsRead(notifications.map((item) => item.session))} />
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
          sendingToAgents={groupState.sendingToAgents}
          micEnabled={micEnabled}
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
            {chatsVisible && <Box className="chats-overlay" onClick={(event) => { if (event.target === event.currentTarget) setChatsVisible(false); }}><ChatsPanel agents={agentsByRecent} selectedAgentId={agentId} onAgentSelect={setAgentId} sessions={sessions} summary={sessionSummaries[agentId]} selected={selectedSession} loading={sessionsLoading} loadingMore={sessionsLoadingMore} hasMore={sessionsHasMore}
              onSelect={(s) => { setSessionKey(s.key); setChatsVisible(false); }} onCreate={() => void create(agentId)} onLoadMore={loadMoreSessions}
              onRename={(s) => void renameSession(s)} onDelete={(s) => void deleteSession(s)} onToggleHidden={(s) => void toggleHiddenSession(s)} onShowDetails={(s) => { setDetailsForSession(s); setDetailsModalOpen(true); }} onClose={() => setChatsVisible(false)} /></Box>}
            <ChatPane key={selectedSession?.key ?? "empty-chat"} agent={selectedAgent} session={selectedSession} mobile onToggleChats={() => setChatsVisible((v) => !v)} onVoiceNavigate={voiceNavigateAgent} onVoiceOpenAgent={openAgentChat} messages={messages} loading={historyLoading} processing={processing} streamText={streamText} sendShortcut={sendShortcut} models={models} initialDraft={draftsRef.current.get(sessionKey) ?? ""} onDraftChange={(text) => { if (sessionKey) draftsRef.current.set(sessionKey, text); }} onShortcutChange={setSendShortcut} onSend={send} onModelChange={(ref) => selectedSession ? changeSessionModel(selectedSession, ref) : Promise.resolve()} onAbort={abort} onFork={() => void fork()} onShowDetails={() => { setChatsVisible(false); setDetailsModalOpen(true); }} ttsEnabled={tts.enabled} ttsMode={tts.mode} ttsSpeaking={tts.speaking} ttsSupported={tts.supported} onToggleTts={tts.toggle} onToggleTtsMode={tts.toggleMode} micEnabled={micEnabled} onToggleMic={toggleMic} />
          </>
        ) : (
          <>
            {/* A track do meio precisa de um filho SEMPRE: quando colapsada, um placeholder
                vazio ocupa a coluna de 0px e mantém o ChatPane na 3ª track. Sem ele, o grid
                auto-placed joga o ChatPane na track de 0px e quebra o layout inteiro. */}
            {chatsColumnVisible ? <ChatsPanel agents={agentsByRecent} selectedAgentId={agentId} onAgentSelect={setAgentId} sessions={sessions} summary={sessionSummaries[agentId]} selected={selectedSession} loading={sessionsLoading} loadingMore={sessionsLoadingMore} hasMore={sessionsHasMore}
              onSelect={(s) => setSessionKey(s.key)} onCreate={() => void create(agentId)} onLoadMore={loadMoreSessions}
              onRename={(s) => void renameSession(s)} onDelete={(s) => void deleteSession(s)} onToggleHidden={(s) => void toggleHiddenSession(s)} onShowDetails={(s) => { setDetailsForSession(s); setDetailsModalOpen(true); }} /> : <Box className="chats-panel-placeholder" />}
            <ChatPane key={selectedSession?.key ?? "empty-chat"} agent={selectedAgent} session={selectedSession} messages={messages} loading={historyLoading} processing={processing} streamText={streamText} sendShortcut={sendShortcut} models={models} initialDraft={draftsRef.current.get(sessionKey) ?? ""} onDraftChange={(text) => { if (sessionKey) draftsRef.current.set(sessionKey, text); }} onShortcutChange={setSendShortcut} onSend={send} onModelChange={(ref) => selectedSession ? changeSessionModel(selectedSession, ref) : Promise.resolve()} onAbort={abort} onFork={() => void fork()} onShowDetails={() => setDetailsModalOpen(true)} onToggleChats={() => setChatsColumnVisible((v) => !v)} onVoiceNavigate={voiceNavigateAgent} onVoiceOpenAgent={openAgentChat} ttsEnabled={tts.enabled} ttsMode={tts.mode} ttsSpeaking={tts.speaking} ttsSupported={tts.supported} onToggleTts={tts.toggle} onToggleTtsMode={tts.toggleMode} micEnabled={micEnabled} onToggleMic={toggleMic} />
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
