# OpenClaw Console 🖥️

Console web para gerenciamento do **OpenClaw** (agents da Global Tecnologia).

## Tecnologia
- **Runtime:** Node.js (Docker `node`, Dockerfile próprio)
- **Frontend:** (app web servido pelo Node — gráficos/UI do console)
- **Deploy:** container Docker / Cloudflare (.wrangler presente) apenas para túnel 
- **Rede:** `network_mode: host` (sem mapeamento de portas)

## Repositório
- **Remoto:** `git@github.com:alexandretorqueti/openclaw-console.git`
- **Branch atual (local):** `refatoracao-layout`
- **Organização-alvo:** migrar para `globaltecnologia`

## Portas
| Serviço | Porta |
|---------|-------|
| Console | 6280 (host, network_mode host) |
| Gateway OpenClaw | 18789 (ws://127.0.0.1) |
| Ollama | 11434 (http://127.0.0.1) |

## Ambientes
- **Produção:** container `openclaw-console-app` com `NODE_ENV=production`
- Compose: `compose.yaml` (name: `openclaw-console`)

## Variáveis de Ambiente (`.env` — obrigatórias)
- `PORT` — 6280
- `OPENCLAW_GATEWAY_URL` — `ws://127.0.0.1:18789`
- `OPENCLAW_OLLAMA_URL` — `http://127.0.0.1:11434`
- `OPENCLAW_GATEWAY_TOKEN` — **obrigatório** (`:?` falha se ausente)
- `OPENCLAW_CONSOLE_TOKEN` — **obrigatório** (`:?` falha se ausente)
- `OPENCLAW_DEVICE_IDENTITY_PATH` — `/data/state/device.json`
- `OPENCLAW_AGENT_WORKSPACE_ROOT` — `/data/.openclaw`
- `OPENCLAW_SHARED_PROJECTS_PATH` — `/data/workspace/projects`
- Volumes host: `OPENCLAW_STATE_DIR_HOST` (default `/home/alexandre/docker/openclaw/openclaw_state`)

## Tokens e Chaves (`.env`)
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_CONSOLE_TOKEN`
- Arquivo: `openclaw-console/.env` (modo 600, não versionado)
- Exemplo: `.env.example`
- Repo central: `/data/workspace/projects/agentes/devops/secrets/`

## Estrutura
```
openclaw-console/
├── (código do console Node)
├── compose.yaml
├── Dockerfile
├── .env          # segredos (não versionado)
├── .env.example
└── .wrangler/    # config Cloudflare
```

## Subir
```bash
docker compose up -d --build
```
Console em http://localhost:6280 (requer `OPENCLAW_GATEWAY_TOKEN` + `OPENCLAW_CONSOLE_TOKEN`).

> ⚠️ **PROIBIDO** alterar `compose.yaml`/config do OpenClaw sem plano aprovado pelo Alexandre (pode travar o Gateway).
