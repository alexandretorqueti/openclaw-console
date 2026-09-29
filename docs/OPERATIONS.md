# Desenvolvimento e operação

## Requisitos

- Node.js 22+
- npm
- Docker/Compose para implantação
- OpenClaw Gateway compatível com protocolo v4
- token compartilhado do Gateway
- Ollama opcional para enriquecer tamanhos de modelos

## Desenvolvimento

```bash
cp .env.example .env
npm ci
npm run typecheck
npm test
npm run build
```

O frontend Vite, quando executado separadamente, usa o BFF em mesma origem/proxy. Em produção, o Fastify serve `apps/web/dist`.

## Variáveis

| Variável | Obrigatória | Padrão | Uso |
|---|---:|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | sim | — | autenticação compartilhada com o Gateway |
| `OPENCLAW_GATEWAY_URL` | não | `ws://openclaw:18789` | WebSocket do Gateway |
| `OPENCLAW_DEVICE_IDENTITY_PATH` | não | `/data/state/device.json` | identidade Ed25519 persistente |
| `OPENCLAW_AGENT_WORKSPACE_ROOT` | não | `/data/.openclaw` | sugestão para workspaces novos |
| `OPENCLAW_GATEWAY_AGENT_WORKSPACE_ROOT` | não | `/data/workspace/projects/agentes` | raiz de workspaces criada pelo Gateway quando não montada no BFF |
| `OPENCLAW_STATE_DIR_HOST` | no Compose | `/home/alexandre/docker/openclaw/openclaw_state` | state persistente montado no BFF para preparar workspaces |
| `OPENCLAW_SHARED_PROJECTS_PATH` | não | `/data/workspace/projects` | destino do link `projects` criado para agentes novos |
| `OPENCLAW_OLLAMA_URL` | não | `http://127.0.0.1:11434` | `/api/tags` para tamanhos locais |
| `CONSOLE_WEB_DIST` | não | `apps/web/dist` relativo ao servidor | frontend estático |
| `PORT` | não | `47831` | porta HTTP do BFF |
| `LOG_LEVEL` | não | `info` | nível do Fastify |

## Docker

O Compose deste repositório usa `network_mode: host` e porta `6280`. Isso permite acessar Gateway e Ollama publicados no host por loopback. Em outra topologia, ajuste URLs para DNS/portas internas corretas; não presuma que `localhost` alcança outro container.

```bash
docker compose config
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:6280/healthz
```

Não versione `.env` nem `state/device.json`.

O volume de `OPENCLAW_STATE_DIR_HOST` precisa ser o mesmo state montado em
`/data/.openclaw` pelo Gateway. O BFF roda com UID 1000 e deve ter permissão de
escrita nesse diretório. Ao criar um agente, ele prepara:

```text
<workspace>/projects -> /data/workspace/projects
```

O destino é o caminho visto no container do OpenClaw; ele não precisa estar
montado no BFF. Workspaces fora de `OPENCLAW_AGENT_WORKSPACE_ROOT`, ancestrais
que escapem por symlink e entradas `projects` conflitantes são recusados.

## Primeiro pareamento

1. Inicie o Console com token correto.
2. O BFF cria uma identidade Ed25519 em `state/device.json`.
3. Aprove a solicitação no OpenClaw por um canal administrativo autorizado.
4. Confirme `/api/status` com `connected: true` e `canAdmin: true`.

O servidor solicita `operator.read`, `operator.write` e `operator.admin`. Sem admin, leitura/chat funcionam conforme os scopes concedidos, mas administração de agentes falha.

## Smoke test seguro

- verificar `/healthz`, `/api/status`, `/api/agents` e `/api/models`;
- criar sessão temporária com label inequívoca;
- enviar mensagem curta e aguardar evento terminal;
- confirmar histórico;
- abortar se necessário, arquivar/excluir e confirmar que não restou sessão temporária.

Para testar agentes, use workspace temporário e `deleteFiles: true` ao remover.

## Diagnóstico

### “Gateway desconectado” permanece na UI

1. Consulte `/api/status` diretamente.
2. Veja logs do container.
3. Confirme token, pareamento e scopes.
4. Confirme que o frontend publicado contém o build atual.

A UI deve se recuperar sem reload em até ~4 s quando o status volta a conectado.

### Modelos Ollama aparecem com disponibilidade não confirmada

O `models.list` do Gateway pode divergir do CLI na avaliação de auth local. O Console não bloqueia a configuração por esse campo. Confirme com:

```bash
openclaw models list --provider ollama --json
curl -fsS "$OPENCLAW_OLLAMA_URL/api/tags"
```

A ausência de Ollama afeta apenas `sizeBytes`; o catálogo do Gateway continua funcionando.

### Modelo muda, mas a label não

A UI reconcilia metadados após `/model` em 300/1200 ms e no evento terminal. Verifique se `/api/sessions` já mostra `model` e `modelProvider` novos.

### Build grande

O Vite atualmente avisa que o chunk principal ultrapassa 500 kB. É dívida conhecida, não falha de build; veja `HANDOFF.md`.

## Release npm

Os pacotes publicáveis usam SemVer independente. Antes de publicar:

1. atualize versões e dependências internas em conjunto;
2. execute `npm ci`, typecheck, testes e build;
3. execute `npm pack --dry-run` por workspace;
4. publique contratos antes dos consumidores.

Não publique `apps/web` — ele é aplicação, não biblioteca.
