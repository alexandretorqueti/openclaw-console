import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AddRounded, AutoAwesomeRounded, ChatBubbleOutlineRounded, ChevronRightRounded,
  ContentCopyRounded, DeleteOutlineRounded, EditRounded, GroupRounded,
  MoreVertRounded, PersonRemoveRounded, SendRounded, SmartToyOutlined,
} from "@mui/icons-material";
import {
  Alert, Avatar, Box, Button, Chip, CircularProgress, ClickAwayListener, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, IconButton, LinearProgress, Menu, MenuItem, Paper,
  Select, Stack, TextField, Tooltip, Typography,
} from "@mui/material";
import type { ApiAgent, ApiMessage } from "./api";
import { api } from "./api";

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
const GROUP_AGENT_SYSTEM_PROMPT = `Você está em um grupo de agentes. Você verá todas as mensagens do grupo.
Responda APENAS se:
- A mensagem é diretamente para você (@seu_nome)
- Você tem conhecimento/expertise relevante que falta aos outros
- Você precisa corrigir algo importante
Caso contrário, fique em silêncio (responda NO_REPLY).

Quando responder, seja conciso e direto ao ponto. Identifique-se no início da resposta.`;

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
}: {
  group: AgentGroup;
  agents: ApiAgent[];
  messages: GroupMessage[];
  onSend: (content: string) => void;
  onManageAgents: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const groupAgents = useMemo(
    () => agents.filter((agent) => group.agentIds.includes(agent.id)),
    [agents, group.agentIds],
  );

  const submitMessage = useCallback(() => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    onSend(content);
    setDraft("");
    setTimeout(() => setSending(false), 100);
  }, [draft, sending, onSend]);

  const handleComposerKey = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitMessage();
      }
    },
    [submitMessage],
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

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
                {groupAgents.length} agente{groupAgents.length !== 1 ? "s" : ""} •{" "}
                {groupAgents.map((a) => a.emoji ?? "🤖").join(" ")}
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
            placeholder={groupAgents.length === 0 ? "Adicione agentes ao grupo para começar..." : "Mensagem para o grupo..."}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            minRows={2}
            variant="standard"
            InputProps={{ disableUnderline: true }}
            disabled={sending || groupAgents.length === 0}
            autoFocus
            onKeyDown={handleComposerKey}
          />
          <Box className="composer-controls">
            {sending && (
              <Box className="composer-processing" role="status" aria-live="polite">
                <CircularProgress size={13} thickness={5} />
                <Typography variant="caption">Enviando</Typography>
              </Box>
            )}
            <IconButton
              type="submit"
              className="send-button"
              disabled={!draft.trim() || sending || groupAgents.length === 0}
              aria-label="Enviar mensagem"
            >
              {sending ? <CircularProgress size={18} /> : <SendRounded />}
            </IconButton>
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

  // Send message to all agents in group
  const handleSendMessage = useCallback(
    async (content: string) => {
      if (!selectedGroup || selectedGroup.agentIds.length === 0) return;

      // Add user message
      const userMessage: GroupMessage = {
        id: clientId(),
        groupId: selectedGroup.id,
        senderType: "user",
        senderId: "user",
        senderName: "Você",
        content,
        timestamp: Date.now(),
      };

      const updatedMessages = [...messages, userMessage];
      setMessages(updatedMessages);
      saveGroupMessages(selectedGroup.id, updatedMessages);

      // Send to each agent
      const groupAgents = agents.filter((a) => selectedGroup.agentIds.includes(a.id));
      setSendingToAgents(new Set(selectedGroup.agentIds));

      for (const agent of groupAgents) {
        try {
          // Create a session for this agent if needed, or use existing
          // For now, we'll send via the API and collect responses
          const response = await api.send({
            sessionKey: `agent:${agent.id}:group:${selectedGroup.id}`,
            agentId: agent.id,
            message: `[Grupo: ${selectedGroup.name}]\n\n${content}\n\n${GROUP_AGENT_SYSTEM_PROMPT}`,
          });

          // Poll for response (simplified - in production, use SSE/events)
          // For now, we'll add a placeholder and update when response arrives
          const agentMessage: GroupMessage = {
            id: clientId(),
            groupId: selectedGroup.id,
            senderType: "agent",
            senderId: agent.id,
            senderName: agent.name,
            content: `⏳ Processando... (runId: ${response.runId})`,
            timestamp: Date.now(),
          };

          const withAgentMessage = [...updatedMessages, agentMessage];
          setMessages(withAgentMessage);
          saveGroupMessages(selectedGroup.id, withAgentMessage);
        } catch (error) {
          console.error(`Error sending to agent ${agent.id}:`, error);
          const errorMessage: GroupMessage = {
            id: clientId(),
            groupId: selectedGroup.id,
            senderType: "agent",
            senderId: agent.id,
            senderName: agent.name,
            content: `❌ Erro ao enviar mensagem: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
            timestamp: Date.now(),
          };
          const withError = [...updatedMessages, errorMessage];
          setMessages(withError);
          saveGroupMessages(selectedGroup.id, withError);
        }
      }

      setSendingToAgents(new Set());
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
