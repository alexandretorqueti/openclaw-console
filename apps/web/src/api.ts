import { OpenClawConsoleClient } from "@alexandretorqueti/openclaw-console-client";
import type {
  Agent, AgentContextFile, ChatEvent as ContractChatEvent, ChatMessage, GatewayStatus as ContractGatewayStatus, ModelChoice, Session, SessionChangedEvent,
} from "@alexandretorqueti/openclaw-console-contracts";

export type GatewayStatus = ContractGatewayStatus & { serverVersion?: string };
export type ApiAgent = Agent;
export type ApiSession = Session;
export type ApiMessage = Omit<ChatMessage, "createdAt"> & { timestamp?: number };
export type ApiModel = ModelChoice;
export type ApiAgentContextFile = AgentContextFile;
export type ChatEvent = ContractChatEvent;

const client = new OpenClawConsoleClient();
const messages = (rows: ChatMessage[]): ApiMessage[] => rows.map(({ createdAt, ...message }) => ({ ...message, timestamp: createdAt }));

export const api = {
  status: async (): Promise<GatewayStatus> => {
    const value = await client.getStatus();
    return { ...value, serverVersion: value.version };
  },
  agents: async () => (await client.listAgents()).agents,
  models: async () => (await client.listModels()).models,
  createAgent: (input: { name: string; workspace: string; model?: string; emoji?: string; avatar?: string }) => client.createAgent(input),
  updateAgent: (input: { agentId: string; name?: string; workspace?: string; model?: string; emoji?: string; avatar?: string }) => client.updateAgent(input),
  deleteAgent: (input: { agentId: string; deleteFiles?: boolean }) => client.deleteAgent({ deleteFiles: false, ...input }),
  agentContextFiles: (agentId: string) => client.getAgentContextFiles(agentId),
  updateAgentContextFiles: (agentId: string, files: Array<{ name: AgentContextFile["name"]; content: string }>) => client.updateAgentContextFiles({ agentId, files }),
  sessions: (agentId: string, offset = 0, limit = 10) => client.listSessions({ agentId, limit, offset }),
  history: async (sessionKey: string, agentId: string) => {
    const value = await client.getChatHistory({ sessionKey, agentId, limit: 300, offset: 0 });
    return { ...value, messages: messages(value.messages) };
  },
  send: (input: { sessionKey: string; agentId: string; sessionId?: string; message: string }) => client.sendChat(input),
  abort: (input: { sessionKey: string; agentId: string; runId?: string }) => client.abortChat(input),
  createSession: (input: { agentId: string; label?: string; model?: string }) => client.createSession(input),
  forkSession: (input: { parentSessionKey: string; agentId: string; label?: string }) => client.forkSession(input),
  patchSession: (input: { key: string; agentId: string; label: string }) => client.patchSession(input),
  deleteSession: (input: { key: string; agentId: string }) => client.deleteSession(input),
  events(handlers: { onChat: (event: ChatEvent) => void; onStatus: (status: GatewayStatus) => void; onSessions: (event: SessionChangedEvent) => void; onOpen?: () => void; onError?: (error: Event | Error) => void }) {
    return client.subscribeEvents({ onChat: handlers.onChat, onStatus: handlers.onStatus, onSessions: handlers.onSessions, onOpen: handlers.onOpen, onError: handlers.onError });
  },
};
