# OpenClaw Console

Console alternativo para OpenClaw, com frontend React, BFF Fastify e cliente WebSocket Gateway v4. O navegador nunca recebe o token do Gateway.

## Estrutura

- `packages/contracts` — contratos Zod de domínio e da API (`@alexandretorqueti/openclaw-console-contracts`).
- `packages/gateway-client` — cliente WebSocket independente, sem dependência de pacotes privados OpenClaw (`@alexandretorqueti/openclaw-gateway-client`).
- `packages/client` — SDK HTTP/SSE para browser (`@alexandretorqueti/openclaw-console-client`).
- `apps/server` — BFF Fastify e servidor do frontend (`@alexandretorqueti/openclaw-console-server`).
- `apps/web` — aplicação React/Vite usando `@alexandretorqueti/biblioteca-global-ui`.

## Recursos integrados

- agentes (`agents.list`);
- sessões (`sessions.list`);
- histórico (`chat.history`);
- continuação e streaming (`chat.send` + eventos `chat`);
- cancelamento (`chat.abort`);
- criação e fork (`sessions.create`);
- atualização de sessão (`sessions.patch`, disponível no SDK/API).

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
OPENCLAW_OLLAMA_URL=http://127.0.0.1:11434
PORT=47831
```

`OPENCLAW_AGENT_WORKSPACE_ROOT` define somente a raiz sugerida pelo Console para novos agentes. O workspace efetivo continua sendo persistido por agente no Gateway e pode ser alterado pela tela de administração.
`OPENCLAW_OLLAMA_URL` é opcional e serve para enriquecer a lista com o tamanho em disco dos modelos locais.

## Docker

A implantação local usa `network_mode: host`, mantém a porta `6280` e acessa o Gateway por loopback. Isso preserva os scopes do shared token sem criar ou simular identidade de dispositivo:

```bash
cp .env.example .env
# preencha OPENCLAW_GATEWAY_TOKEN no .env

docker compose up -d --build
```

A aplicação fica em `http://localhost:6280`; o health check fica em `/healthz`.

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
- A autenticação usa o shared token e uma identidade Ed25519 persistente em `state/device.json` (modo privado). Na primeira execução, aprove a solicitação real de pareamento com scopes `operator.read` e `operator.write`; nenhuma identidade é simulada.
