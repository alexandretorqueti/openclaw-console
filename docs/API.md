# API do BFF

Base padrão: `/api`. Todas as respostas são validadas por schemas de `packages/contracts`.

## Status e catálogo

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/healthz` | HTTP 200 quando o Gateway está operacional; 503 caso contrário |
| `GET` | `/api/status` | conexão, versão, protocolo, scopes e raiz sugerida de workspaces |
| `GET` | `/api/agents` | agentes configurados |
| `GET` | `/api/models` | catálogo configurado; tamanhos Ollama são opcionais |

## Agentes

| Método | Rota | Contrato |
|---|---|---|
| `POST` | `/api/agents` | `CreateAgentRequestSchema` |
| `PATCH` | `/api/agents` | `UpdateAgentRequestSchema` |
| `DELETE` | `/api/agents` | `DeleteAgentRequestSchema` |
| `GET` | `/api/agents/:agentId/files` | `AgentContextFilesResponseSchema` |
| `PUT` | `/api/agents/:agentId/files` | lista de arquivos de `UpdateAgentContextFilesRequestSchema` |

O agente `main` nunca pode ser excluído pelo Console. Mutações exigem `operator.admin` no Gateway.

Antes de `agents.create`, o BFF prepara o workspace e cria o link simbólico
`projects` para `OPENCLAW_SHARED_PROJECTS_PATH`. O workspace precisa estar
dentro de `OPENCLAW_AGENT_WORKSPACE_ROOT`; entradas existentes nunca são
substituídas. Um conflito impede a criação do agente.

Workspaces pertencentes ao Gateway em `/data/workspace/projects/agentes` são
aceitos mesmo quando esse volume não está montado no BFF; nesse caso o Gateway
é responsável por criar o workspace. Outros caminhos externos continuam
recusados.

Arquivos aceitos: `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` e `MEMORY.md`.

## Sessões

| Método | Rota | Contrato/observação |
|---|---|---|
| `GET` | `/api/sessions` | `SessionsQuerySchema`; paginação por `limit` e `offset` |
| `POST` | `/api/sessions` | `CreateSessionRequestSchema` |
| `POST` | `/api/sessions/fork` | `ForkSessionRequestSchema` |
| `PATCH` | `/api/sessions` | `PatchSessionRequestSchema` |
| `DELETE` | `/api/sessions` | arquiva e remove transcript conforme o Gateway |

O BFF extrai o agente da session key para operações sobre sessões existentes.

## Chat

| Método | Rota | Contrato |
|---|---|---|
| `GET` | `/api/chat/history` | `ChatHistoryQuerySchema` → `ChatHistoryResponseSchema` |
| `GET` | `/api/chat/message` | recupera pelo ID uma mensagem integral truncada em `chat.history` |
| `POST` | `/api/chat/send` | `ChatSendRequestSchema` → `ChatSendResponseSchema` |
| `POST` | `/api/chat/abort` | `ChatAbortRequestSchema` → `ChatAbortResponseSchema` |
| `GET` | `/api/sessions/describe?key=...` | `SessionsDescribeQuerySchema` → gateway passthrough |

`chat.send` aceita `idempotencyKey` opcional. Quando omitida, o BFF gera uma UUID; quando fornecida, ela é encaminhada ao gateway para que retries do motor não dupliquem a execução. Comandos como `/model` continuam sendo enviados como mensagens normais; o frontend atualiza os metadados da sessão após o comando.

`sessions.describe` encaminha a consulta ao gateway e devolve os campos de atividade (`status`, `startedAt`, `endedAt`) junto com os campos adicionais disponíveis, sem normalização destrutiva.

## Eventos SSE

`GET /api/events`, `Content-Type: text/event-stream`.

Eventos:

- `status`: `GatewayStatusSchema`;
- `chat`: `ChatEventSchema` (`delta`, `final`, `aborted`, `error`);
- `sessions`: `SessionChangedEventSchema`.

O servidor envia keepalive a cada 15 s. EventSource cuida da reconexão de transporte; a UI também mantém sondagem independente de status.

## Uso pelo SDK

```ts
import { OpenClawConsoleClient } from "@alexandretorqueti/openclaw-console-client";

const client = new OpenClawConsoleClient({ baseUrl: "/api" });
const { agents } = await client.listAgents();
const stop = client.subscribeEvents({
  onStatus: (status) => console.log(status.connected),
  onChat: (event) => console.log(event.state),
});

// posteriormente
stop();
```

Para detalhes exatos de campos e limites, consulte `packages/contracts/src/index.ts`; não duplique schemas em documentação ou consumidores.
