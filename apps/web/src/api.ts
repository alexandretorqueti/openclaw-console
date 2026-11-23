import { OpenClawConsoleClient } from "@alexandretorqueti/openclaw-console-client";
import { API_BASE_URL, getStoredToken } from "./auth";
import type {
  Agent, AgentContextFile, ChatEvent as ContractChatEvent, ChatMessage, GatewayStatus as ContractGatewayStatus, ModelChoice, NotificationItem, PatchSessionRequest, Session, SessionChangedEvent, SessionSummary,
} from "@alexandretorqueti/openclaw-console-contracts";

export type GatewayStatus = ContractGatewayStatus & { serverVersion?: string };
export type ApiAgent = Agent;
export type ApiSession = Session;
export type ApiMessage = Omit<ChatMessage, "createdAt"> & { timestamp?: number };
export type ApiNotification = NotificationItem;
export type ApiModel = ModelChoice;
export type ApiAgentContextFile = AgentContextFile;
export type ApiSessionSummary = SessionSummary;
export type ChatEvent = ContractChatEvent;

const client = new OpenClawConsoleClient({ baseUrl: API_BASE_URL, authToken: getStoredToken() });
const messages = (rows: ChatMessage[]): ApiMessage[] => rows.map(({ createdAt, ...message }) => ({ ...message, timestamp: createdAt }));

export const api = {
  status: async (): Promise<GatewayStatus> => {
    const value = await client.getStatus();
    return { ...value, serverVersion: value.version };
  },
  agents: async () => (await client.listAgents()).agents,
  models: async () => (await client.listModels()).models,
  speechSummary: async (text: string): Promise<string> => {
    const token = getStoredToken();
    const response = await fetch(`${API_BASE_URL}/speech-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(`Resumo por voz indisponível (HTTP ${response.status})`);
    const payload = await response.json() as { summary?: unknown };
    if (typeof payload.summary !== "string" || !payload.summary.trim()) throw new Error("Resumo por voz vazio");
    return payload.summary.trim();
  },
  speechAudio: async (text: string): Promise<Blob> => {
    const token = getStoredToken();
    const response = await fetch(`${API_BASE_URL}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      let detail = "";
      try { detail = ((await response.json()) as { error?: { message?: string } })?.error?.message ?? ""; } catch { /* resposta não-JSON */ }
      throw new Error(detail || `TTS local indisponível (HTTP ${response.status})`);
    }
    return await response.blob();
  },
  // Mantém o Phonon residente no Ollama enquanto a voz está ligada (o BFF
  // reaquece sozinho a cada 4 min durante 30 min por chamada).
  warmVoice: async (): Promise<void> => {
    const token = getStoredToken();
    try {
      await fetch(`${API_BASE_URL}/warm-voice`, {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
    } catch { /* melhor esforço: a fala funciona mesmo sem aquecimento */ }
  },
  createAgent: (input: { name: string; workspace: string; model?: string; emoji?: string; avatar?: string }) => client.createAgent(input),
  updateAgent: (input: { agentId: string; name?: string; workspace?: string; model?: string; emoji?: string; avatar?: string }) => client.updateAgent(input),
  deleteAgent: (input: { agentId: string; deleteFiles?: boolean }) => client.deleteAgent({ deleteFiles: false, ...input }),
  agentContextFiles: (agentId: string) => client.getAgentContextFiles(agentId),
  updateAgentContextFiles: (agentId: string, files: Array<{ name: AgentContextFile["name"]; content: string }>) => client.updateAgentContextFiles({ agentId, files }),
  sessions: (agentId: string, offset = 0, limit = 10, search?: string) => client.listSessions({ agentId, limit, offset, ...(search ? { search } : {}) }),
  sessionSummaries: (agentIds?: string[]) => client.listSessionSummaries(agentIds),
  notifications: async () => (await client.listNotifications()).notifications,
  history: async (sessionKey: string, agentId: string) => {
    const value = await client.getChatHistory({ sessionKey, agentId, limit: 300, offset: 0 });
    return { ...value, messages: messages(value.messages) };
  },
  send: (input: { sessionKey: string; agentId: string; sessionId?: string; message: string }) => client.sendChat(input),
  abort: (input: { sessionKey: string; agentId: string; runId?: string }) => client.abortChat(input),
  createSession: (input: { agentId: string; label?: string; model?: string }) => client.createSession(input),
  forkSession: (input: { parentSessionKey: string; agentId: string; label?: string }) => client.forkSession(input),
  patchSession: (input: PatchSessionRequest) => client.patchSession(input),
  deleteSession: (input: { key: string; agentId: string }) => client.deleteSession(input),
  events(handlers: { onChat: (event: ChatEvent) => void; onStatus: (status: GatewayStatus) => void; onSessions: (event: SessionChangedEvent) => void; onOpen?: () => void; onError?: (error: Event | Error) => void }) {
    return client.subscribeEvents({ onChat: handlers.onChat, onStatus: handlers.onStatus, onSessions: handlers.onSessions, onOpen: handlers.onOpen, onError: handlers.onError });
  },
};
