# OpenClaw Console

Console alternativo para OpenClaw, com frontend React, BFF Fastify e cliente WebSocket Gateway v4. O navegador nunca recebe o token do Gateway.

Repositório: <https://github.com/alexandretorqueti/openclaw-console>

## Estrutura

- `packages/contracts` — contratos Zod de domínio e da API (`@alexandretorqueti/openclaw-console-contracts`).
- `packages/gateway-client` — cliente WebSocket independente, sem dependência de pacotes privados OpenClaw (`@alexandretorqueti/openclaw-gateway-client`).
- `packages/client` — SDK HTTP/SSE para browser (`@alexandretorqueti/openclaw-console-client`).
- `apps/server` — BFF Fastify e servidor do frontend (`@alexandretorqueti/openclaw-console-server`).
- `apps/web` — aplicação React/Vite usando `@alexandretorqueti/biblioteca-global-ui`.

## Documentação

- [`AGENTS.md`](AGENTS.md) — instruções e invariantes para agentes de desenvolvimento;
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — camadas, fluxos e decisões;
- [`docs/API.md`](docs/API.md) — rotas HTTP/SSE e contratos;
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — desenvolvimento, pareamento, Docker e diagnóstico;
- [`docs/HANDOFF.md`](docs/HANDOFF.md) — estado atual, débitos e checklist de continuidade.

## Recursos integrados

- agentes, modelos, workspaces e arquivos de contexto;
- criação, edição e exclusão de agentes (`operator.admin`);
- atalho `projects` automático nos workspaces de agentes novos;
- sessões (`sessions.list`);
- histórico (`chat.history`);
- continuação e streaming (`chat.send` + eventos `chat`);
- cancelamento (`chat.abort`);
- criação e fork (`sessions.create`);
- rename e exclusão de sessão;
- recuperação automática de Gateway/SSE;
- tamanhos de modelos Ollama via `/api/tags`.

## Desenvolvimento

```bash
npm install
npm run typecheck
npm test
npm run build
```

Variáveis do servidor:

```bash
OPENCLAW_GATEWAY_URL=ws://openclaw:18789
OPENCLAW_GATEWAY_TOKEN=seu-token
OPENCLAW_AGENT_WORKSPACE_ROOT=/data/.openclaw
OPENCLAW_STATE_DIR_HOST=/home/alexandre/docker/openclaw/openclaw_state
OPENCLAW_SHARED_PROJECTS_PATH=/data/workspace/projects
OPENCLAW_OLLAMA_URL=http://127.0.0.1:11434
PORT=47831
```

`OPENCLAW_AGENT_WORKSPACE_ROOT` define somente a raiz sugerida pelo Console para novos agentes. O workspace efetivo continua sendo persistido por agente no Gateway e pode ser alterado pela tela de administração.
`OPENCLAW_STATE_DIR_HOST` monta no BFF o state persistente usado pelo Gateway. Ao criar um agente, o Console cria idempotentemente `<workspace>/projects -> OPENCLAW_SHARED_PROJECTS_PATH`, sem substituir arquivos ou links divergentes já existentes.
`OPENCLAW_OLLAMA_URL` é opcional e serve para enriquecer a lista com o tamanho em disco dos modelos locais.

## Docker

A implantação local de referência usa `network_mode: host`, mantém a porta `6280` e acessa Gateway/Ollama por loopback. O BFF cria e persiste uma identidade Ed25519 real para o pareamento com o Gateway:

```bash
cp .env.example .env
# preencha OPENCLAW_GATEWAY_TOKEN no .env

docker compose up -d --build
```

A aplicação fica em `http://localhost:6280`; o health check fica em `/healthz`.

No primeiro start, aprove a identidade solicitada pelo Gateway com os scopes necessários. Consulte [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Publicação npm

Os quatro pacotes possuem `files: ["dist"]`, `publishConfig.access: public` e passam por `npm pack --dry-run`. Antes de publicar, ajuste versões e metadados de repositório/licença conforme necessário.

```bash
npm run build
npm publish -w @alexandretorqueti/openclaw-console-contracts
npm publish -w @alexandretorqueti/openclaw-gateway-client
npm publish -w @alexandretorqueti/openclaw-console-client
npm publish -w @alexandretorqueti/openclaw-console-server
```

## Segurança e compatibilidade

- O token é lido apenas pelo BFF e `.env` é ignorado pelo Git e pelo build Docker.
- O cliente fixa o protocolo Gateway v4 e deve ser validado quando o OpenClaw mudar o wire protocol.
- Eventos ao vivo não substituem o transcript; ao receber evento terminal, o frontend recarrega `chat.history`.
- A autenticação usa o shared token e uma identidade Ed25519 persistente em `state/device.json` (modo privado). O servidor solicita `operator.read`, `operator.write` e `operator.admin`; nenhuma identidade é simulada.
