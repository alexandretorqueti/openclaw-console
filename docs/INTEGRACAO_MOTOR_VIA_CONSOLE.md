# Integração do GerenteAgentes com o OpenClaw Console

Documento para o agente responsável pelo GerenteAgentes.

## O que foi entregue no Console

### 1. Idempotência no envio de mensagens

`POST /api/chat/send` aceita o campo opcional `idempotencyKey`.

- Se o motor enviar a chave, o Console encaminha a mesma chave ao Gateway.
- Se o motor não enviar, o Console gera uma UUID com `randomUUID()`.
- Isso permite retry seguro no motor sem criar execuções duplicadas.

Exemplo de corpo:

```json
{
  "sessionKey": "agent:main:task-analysis",
  "agentId": "main",
  "message": "Analise esta tarefa",
  "idempotencyKey": "task-145-analysis-attempt-1"
}
```

### 2. Descrição de sessão

Foi disponibilizado:

```text
GET /api/sessions/describe?key=<sessionKey>
```

O retorno contém `status`, `startedAt`, `endedAt` e os campos adicionais disponíveis da sessão. O endpoint é destinado ao loader/monitor do motor, que pode consultá-lo para verificar se há atividade real.

### 3. Eventos SSE de execução

O endpoint existente continua sendo:

```text
GET /api/events
```

Nos eventos `chat`, os estados de ciclo são expostos como:

- `delta`: execução em andamento;
- `final`: execução concluída;
- `aborted`: execução abortada;
- `error`: execução com erro.

Os eventos terminais preservam `runId`, `sessionKey`, `stopReason` e, quando disponível, `errorMessage`.

## Como o adaptador do GerenteAgentes deve usar

1. Criar a sessão com `POST /api/sessions`.
2. Desarquivar com `PATCH /api/sessions`, quando necessário.
3. Enviar a mensagem com `POST /api/chat/send`, sempre reutilizando a mesma `idempotencyKey` durante retries da mesma tentativa.
4. Aguardar o evento SSE correspondente ao `runId`.
5. Em `final`, carregar a saída com `GET /api/chat/history`.
6. Em `aborted` ou `error`, converter o resultado para o contrato de erro já usado pelo runtime driver.
7. Usar `GET /api/sessions/describe?key=...` no monitoramento/loader.
8. Abortar com `POST /api/chat/abort` quando o deadline do motor for atingido.

## Teste manual

Defina o token somente no ambiente local do shell:

```bash
export TOKEN='valor-do-OPENCLAW_CONSOLE_TOKEN'
export BASE='http://127.0.0.1:6280'
export KEY='agent:main:task-analysis'
```

Verificar saúde:

```bash
curl -sS "$BASE/healthz"
```

Consultar uma sessão existente:

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/sessions/describe?key=$(printf '%s' "$KEY" | jq -sRr @uri)"
```

Abrir o SSE em outro terminal:

```bash
curl -N \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/events"
```

Enviar uma mensagem de teste:

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  "$BASE/api/chat/send" \
  -d "$(jq -n --arg key "$KEY" '{sessionKey:$key, message:"responda apenas: OK", idempotencyKey:"manual-test-2026-08-25-1"}')"
```

No SSE, deve aparecer um evento `chat` com o mesmo `sessionKey`, um `runId` e, ao final, `state: "final"` ou `state: "error"`/`"aborted"`.

## Validação feita no Console

- `npm run typecheck` passou.
- `npm run test` passou: 15 testes.
- `npm run build` passou.
- O repositório não possui script `npm run lint`.

O teste de integração do GerenteAgentes ainda precisa ser executado pelo agente do motor, usando uma tarefa real ou um ambiente com uma sessão válida.
