export type Agent = {
  id: string;
  name: string;
  role: string;
  emoji: string;
  model: string;
  color: string;
  status: "online" | "busy" | "offline";
};

export type Session = {
  id: string;
  agentId: string;
  title: string;
  project: string;
  updatedAt: string;
  context: number;
  unread?: boolean;
  pinned?: boolean;
  state: "active" | "done" | "paused";
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  author: string;
  time: string;
  content: string;
  meta?: string;
};

export const agents: Agent[] = [
  { id: "main", name: "Jarbas", role: "Assistente principal", emoji: "🔧", model: "gpt-5.6-sol", color: "#7c6df2", status: "online" },
  { id: "programador", name: "Programador", role: "Engenharia de software", emoji: "⌨️", model: "qwen3-coder-next", color: "#24b47e", status: "online" },
  { id: "arquiteto", name: "Arquiteto", role: "Análise e planejamento", emoji: "📐", model: "qwen-max", color: "#f0a23a", status: "busy" },
  { id: "revisor", name: "Revisor", role: "Qualidade e evidências", emoji: "🔎", model: "gpt-oss:20b", color: "#4c9ffe", status: "offline" },
];

export const sessions: Session[] = [
  { id: "task-142-auth", agentId: "programador", title: "#142 · Autenticação JWT", project: "monitor-tarefas", updatedAt: "há 8 min", context: 62, unread: true, pinned: true, state: "active" },
  { id: "task-139-dashboard", agentId: "programador", title: "#139 · Dashboard responsivo", project: "Sistema Recrescer", updatedAt: "ontem", context: 34, state: "done" },
  { id: "task-128-prisma", agentId: "programador", title: "#128 · Migração do Prisma", project: "tarefas-server", updatedAt: "há 3 dias", context: 78, state: "paused" },
  { id: "architecture-142", agentId: "arquiteto", title: "#142 · Plano de autenticação", project: "monitor-tarefas", updatedAt: "há 31 min", context: 41, pinned: true, state: "done" },
  { id: "platform-design", agentId: "arquiteto", title: "Plataforma de agentes", project: "OpenClaw Console", updatedAt: "há 2 h", context: 29, state: "active" },
  { id: "main-console", agentId: "main", title: "Frontend alternativo do OpenClaw", project: "Laboratório", updatedAt: "agora", context: 18, pinned: true, state: "active" },
  { id: "review-139", agentId: "revisor", title: "#139 · Revisão do dashboard", project: "Sistema Recrescer", updatedAt: "ontem", context: 23, state: "done" },
];

export const initialMessages: Record<string, ChatMessage[]> = {
  "task-142-auth": [
    { id: "m1", role: "system", author: "Sistema", time: "14:08", content: "Sessão criada a partir do handoff do agente Arquiteto.", meta: "architecture-142 → task-142-auth" },
    { id: "m2", role: "user", author: "Orquestrador", time: "14:09", content: "Implemente a autenticação JWT conforme o plano. Preserve os contratos HTTP existentes e execute os testes de integração." },
    { id: "m3", role: "assistant", author: "Programador", time: "14:10", content: "Vou primeiro mapear os endpoints atuais e os testes de caracterização. Depois implementarei access token curto e refresh token em cookie HttpOnly, sem armazenar credenciais no localStorage.", meta: "Leu 8 arquivos · 2 ferramentas" },
    { id: "m4", role: "assistant", author: "Programador", time: "14:22", content: "Implementação concluída. Criei o serviço de tokens, o middleware de autenticação e os endpoints `/auth/login`, `/auth/refresh` e `/auth/logout`. O build e 18 testes passaram.", meta: "6 arquivos modificados · build aprovado" },
  ],
  "main-console": [
    { id: "c1", role: "user", author: "Alexandre", time: "15:28", content: "Quero um frontend em que eu escolha um agente, abra uma sessão existente e continue a conversa." },
    { id: "c2", role: "assistant", author: "Jarbas", time: "15:29", content: "Perfeito. A sessão será selecionada pelo par agentId + sessionKey. O histórico virá de chat.history e a continuação usará chat.send com streaming." },
  ],
};
