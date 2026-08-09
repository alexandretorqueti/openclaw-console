# AGENTS.md — Guia para agentes de desenvolvimento

Leia nesta ordem antes de alterar o projeto:

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/API.md` quando alterar contratos, BFF ou SDK
4. `docs/OPERATIONS.md` quando alterar Docker, autenticação ou implantação
5. `docs/HANDOFF.md` para estado atual, riscos e próximos trabalhos

## Regras do projeto

- Node.js 22+ e npm workspaces.
- Zod em `packages/contracts` é a autoridade dos contratos em runtime.
- Ao mudar uma operação: contrato → BFF/normalizador → SDK → frontend → testes/documentação.
- Não importe código interno do OpenClaw. O `gateway-client` deve continuar independente e falar apenas o protocolo público v4.
- O navegador nunca recebe `OPENCLAW_GATEWAY_TOKEN` nem a identidade Ed25519.
- A session key (`agent:<agentId>:...`) é a autoridade para o agente proprietário; nunca confie apenas em um `agentId` recebido separadamente.
- Eventos SSE são sinais ao vivo, não a fonte permanente do transcript. Após evento terminal, recarregue `chat.history` e os metadados da sessão.
- Sessões pertencem fisicamente a um agente. Continuidade entre agentes deve ocorrer por handoff/fork explícito, não mudando a propriedade da sessão.
- `ModelChoice.available` é informativo na administração: um provider pode estar temporariamente indisponível e ainda ser uma configuração válida.
- Arquivos de contexto só podem usar a allowlist definida em `AgentContextFileNameSchema`.
- O link compartilhado `projects` só pode ser criado dentro de `OPENCLAW_AGENT_WORKSPACE_ROOT`; nunca substitua uma entrada existente.
- Não versione `.env`, `state/`, identidade do dispositivo, tokens, builds ou `node_modules`.

## Verificação obrigatória

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Para mudanças operacionais:

```bash
docker compose config
docker compose up -d --build
curl -fsS http://127.0.0.1:6280/healthz
```

Use agentes/sessões temporários em smoke tests e remova-os ao terminar. Não altere agentes ou sessões reais apenas para testar.

## Pontos de entrada

- Contratos: `packages/contracts/src/index.ts`
- WebSocket Gateway: `packages/gateway-client/src/index.ts`
- SDK HTTP/SSE: `packages/client/src/index.ts`
- BFF: `apps/server/src/index.ts`
- Normalização do Gateway: `apps/server/src/normalizers.ts`
- Adaptador do frontend: `apps/web/src/api.ts`
- Estado e UI: `apps/web/src/App.tsx`
