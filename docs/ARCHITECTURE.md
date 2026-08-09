# Arquitetura

## Objetivo

O OpenClaw Console é uma aplicação independente para administrar agentes e continuar sessões reais do OpenClaw. Ele também fornece pacotes reutilizáveis para outros sistemas, sem acoplar esses sistemas à aplicação web.

## Camadas

```text
React/Vite (apps/web)
        │ HTTP + SSE, sem segredos
        ▼
Fastify BFF (apps/server)
        │ protocolo WebSocket v4 + identidade de dispositivo
        ▼
OpenClaw Gateway
```

Pacotes compartilhados:

```text
packages/contracts       Zod e tipos públicos
packages/gateway-client  transporte WebSocket v4
packages/client          cliente HTTP/SSE do BFF
```

### `packages/contracts`

Define as entradas, saídas, eventos e tipos usados pelo servidor, SDK e frontend. Os schemas Zod validam dados em runtime; tipos TypeScript derivados não substituem essa validação.

### `packages/gateway-client`

Implementa frames request/response/event, challenge de conexão, assinatura Ed25519 v3, timeouts e reconexão exponencial. Não depende do código-fonte privado do OpenClaw.

### `apps/server`

É a fronteira de segurança. Guarda token e identidade, converte o protocolo do Gateway em HTTP/SSE, normaliza payloads instáveis e serve o frontend estático.

### `packages/client`

Valida cada resposta HTTP e evento SSE com os contratos. Aplicações externas devem preferir esse pacote em vez de reproduzir endpoints manualmente.

### `apps/web`

Mantém estado de agentes, sessões, histórico, streaming, layout e administração. `api.ts` é o adaptador fino; regras de transporte não devem entrar em componentes React.

## Invariantes

### Propriedade da sessão

A session key é canônica. Para `agent:programador:dashboard:abc`, o proprietário é `programador`, mesmo que uma requisição traga outro `agentId`. O BFF canonicaliza isso antes de chamar `chat.*` ou `sessions.*`.

### Histórico e eventos

- `chat.history` é a fonte permanente das mensagens.
- SSE entrega `chat`, `status` e `sessions` para baixa latência.
- Mensagens do usuário são otimistas.
- Ao terminar/abortar/falhar, o frontend recarrega histórico e metadados.
- Uma sondagem de sessões reconcilia execuções quando um evento é perdido.

### Recuperação da conexão

O EventSource reconecta automaticamente, mas não é a única proteção. O frontend consulta `/api/status` a cada 4 s quando desconectado, a cada 30 s quando conectado e ao recuperar rede/visibilidade. Apenas uma sondagem pode ficar em voo.

### Segurança

- Token e chave privada existem somente no BFF.
- A identidade fica em `state/device.json`, volume ignorado pelo Git.
- O Gateway exige pareamento real e escopos de operador.
- Edição de agentes requer `operator.admin`.
- Arquivos de contexto são limitados por allowlist Zod.

### Modelos

O Gateway fornece o catálogo configurado. `available` é exibido como informação, não bloqueio absoluto de configuração. Para Ollama, o BFF consulta opcionalmente `/api/tags` e acrescenta `sizeBytes`; falha nessa consulta não derruba `/api/models`.

## Decisões arquiteturais

- **BFF em vez de Gateway direto no navegador:** evita expor credenciais e isola mudanças do protocolo.
- **Monólito modular:** um deploy, limites internos claros; novos serviços só quando houver necessidade operacional.
- **Zod como autoridade:** JSON Schema ou TypeScript são representações, não validação suficiente.
- **Projetos separados:** o Console não deve virar subpasta do `monitor-tarefas`. Outros sistemas consomem os pacotes npm ou a API.
- **Apps não são bibliotecas:** publique contratos/clientes; não importe `apps/web` dentro de outro produto.

## Fluxo de uma mensagem

1. A UI insere a mensagem otimista.
2. `packages/client` envia `POST /api/chat/send`.
3. O BFF canonicaliza o agente e chama `chat.send` com idempotency key.
4. Deltas chegam por SSE e alimentam a bolha de streaming.
5. No evento terminal, a UI limpa o streaming e recarrega histórico/metadados.
6. Se o evento faltar, a reconciliação por `sessions.list` encerra o estado de processamento.
