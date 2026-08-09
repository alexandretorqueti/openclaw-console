# Handoff técnico

Atualize este arquivo quando arquitetura, implantação, compatibilidade ou riscos mudarem.

## Estado atual

- Repositório: `https://github.com/alexandretorqueti/openclaw-console`
- Branch principal: `main`
- Runtime: Node.js 22, React 19, Fastify 5, Vite 8, Zod 3
- Gateway: protocolo público v4
- Deploy local de referência: Compose, porta HTTP `6280`
- Health check: `/healthz`

## Funcionalidades concluídas

- status e recuperação automática do Gateway;
- agentes e indicação agregada de processamento;
- administração de agentes, modelo, workspace e arquivos de contexto;
- preparação segura do workspace com link para os projetos compartilhados;
- catálogo de modelos com contexto e tamanho Ollama opcional;
- sessões paginadas, criação, rename, delete e fork;
- histórico, mensagem otimista, streaming e cancelamento;
- comandos `/model` com reconciliação da label;
- painel responsivo/redimensionável e persistência de layout;
- cliente HTTP/SSE e cliente WebSocket reutilizáveis;
- autenticação por token + identidade Ed25519 persistente.

## Cobertura atual

- `apps/server/src/normalizers.test.ts`: normalização, paginação, contexto e propriedade de sessão.
- `apps/server/src/workspace-project-link.test.ts`: criação idempotente, conflitos e contenção do workspace.
- `packages/gateway-client/src/index.test.ts`: frames v4, parsing defensivo e assinatura v3.
- Contratos e SDK são exercitados por typecheck/build, mas ainda não possuem testes próprios relevantes.
- O frontend ainda não possui suíte automatizada versionada; fluxos críticos foram validados por smoke tests de navegador durante o desenvolvimento.

## Dívidas e riscos conhecidos

1. `apps/web/src/App.tsx` concentra muitos componentes e estado; extrair hooks de sessões, conexão e administração.
2. Criar testes React/Playwright para reconexão, loader agregado, `/model` e CRUD de agentes.
3. O chunk principal do frontend supera 500 kB; aplicar code splitting por tela.
4. Atividade inicial consulta até 200 sessões por agente; muitos agentes/sessões pedem endpoint agregado no BFF.
5. `models.list.available` pode divergir da execução real do Ollama; hoje é informação, não bloqueio.
6. `OPENCLAW_OLLAMA_URL` pressupõe um endpoint acessível pelo BFF; em redes Docker não-host, usar DNS interno.
7. O protocolo Gateway está fixado em v4. Antes de atualizar OpenClaw, revisar protocolo, challenge, scopes e payloads.
8. Os pacotes declaram licença MIT, mas o repositório ainda deve manter arquivo de licença e metadados de repository consistentes antes da próxima publicação.
9. Falta CI no GitHub para typecheck/test/build e auditoria de segredos.

## Próximos trabalhos recomendados

1. CI no GitHub Actions.
2. Testes do frontend e do SDK.
3. Divisão de `App.tsx` e hooks de domínio.
4. Contratos de handoff/workflow para integração com `monitor-tarefas`.
5. Versionamento e publicação coordenada dos pacotes npm.

## Checklist para retomar

```bash
git status
git log -5 --oneline
npm ci
npm run typecheck
npm test
npm run build
docker compose config
```

Depois confirme o estado efetivo, não apenas arquivos locais:

```bash
curl -fsS http://127.0.0.1:6280/healthz
curl -fsS http://127.0.0.1:6280/api/status
```

Antes de concluir uma mudança:

- validar contratos e compatibilidade;
- executar o menor smoke test real possível;
- remover agentes/sessões temporários;
- confirmar container saudável;
- atualizar documentação afetada;
- fazer commit e push, quando autorizado.
