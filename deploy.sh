#!/usr/bin/env bash
# ============================================================================
# deploy.sh — OpenClaw Console
#
# Adaptado do deploy.sh da Biblioteca Global (mesmo padrão do motor
# GerenteAgentes: `bash deploy.sh` na raiz do repo, timeout 15 min;
# exit 0 → tarefa `deployada`; exit ≠ 0 → `finalizada`, trabalho validado
# não é desfeito).
#
# Realidade do console (diferente da biblioteca):
#   - Frontend (Vite/React) é ESTÁTICO → Cloudflare Pages (`openclaw-console`,
#     domínio ia.globaltecnologia.net). Deploy via wrangler (aqui no sandbox).
#   - API/BFF (Fastify) roda em UM container no host (openclaw-console-app,
#     network_mode: host, porta 6280), exposto pelo Cloudflare Tunnel
#     (openclaw-api.webconnect.com.br). Deploy via docker compose no host
#     (o repo deste container é visível lá pelo mount — mesmo working tree).
#   - Sem rede docker nem mapeamento de portas: o compose.yaml já cuida de
#     envs (`:?` obrigatórias), volumes e network_mode. Por isso NÃO usamos
#     `docker run` manual como a biblioteca — usamos `docker compose`.
#
# O que faz:
#   1. Build local do monorepo (gera apps/web/dist) — valida o código antes
#      de qualquer deploy (fail fast).
#   2. Frontend → Cloudflare Pages via `wrangler pages deploy` (exige
#      CLOUDFLARE_API_TOKEN no env; pule com SKIP_PAGES=1 para deploy de
#      emergência só da API — lição da biblioteca).
#   3. API → no host: `docker compose build` + `up -d` (preserva .env e
#      volumes; não toca em mais nada).
#   4. Healthcheck (healthz local 6280, API pública via túnel, front Pages).
#      Se a API falhar: ROLLBACK para a imagem anterior e sai ≠ 0.
#
# Variáveis de ambiente (nenhuma é commitada):
#   CLOUDFLARE_API_TOKEN  obrigatório p/ deploy do frontend (Pages Edit)
#   CLOUDFLARE_ACCOUNT_ID  account do Pages (default 18a324c1... — o token é
#                          escopado e NÃO lista contas; sem isso o wrangler
#                          falha em "Failed to retrieve account IDs")
#   SKIP_PAGES=1          pula frontend (só API)
#   HOST_ADDR             nome/endereço do Bazzite (default bazzite.local)
#
# O .env da raiz do repo é carregado automaticamente (CLOUDFLARE_API_TOKEN,
# CLOUDFLARE_ACCOUNT_ID etc.) — regra igual à do compose: variável já
# exportada no shell vence o valor do .env.
# ============================================================================
set -euo pipefail

# Roda a partir da raiz do repo, qualquer que seja o cwd de quem invocou.
cd "$(dirname "$0")"

# --- Carrega .env local ------------------------------------------------------
# O docker compose lê .env sozinho, mas o wrangler (frontend) roda aqui no
# sandbox e não vê o .env — sem este loader o deploy abortava com
# "CLOUDFLARE_API_TOKEN não definido" mesmo com o token no arquivo.
load_env() {
  [ -f .env ] || return 0
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      '' | '#'*) continue ;;
    esac
    [[ "$line" == export\ * ]] && line="${line#export }"
    key="${line%%=*}"
    value="${line#*=}"
    [ -n "$key" ] || continue
    [ -z "${!key:-}" ] || continue   # env explícito do shell vence o .env
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    export "$key=$value"
  done < .env
}
load_env

# --- Config -----------------------------------------------------------------
HOST_ADDR="${HOST_ADDR:-bazzite.local}"
SSH_USER="alexandre"
SSH_KEY="/root/.ssh/id_ed25519"
REPO_HOST="/run/media/alexandre/12T/codigofonte/openclaw-console"
CONTAINER="openclaw-console-app"
IMAGE_NAME="openclaw-console-app"          # nome de imagem do compose (project-service)
PORT=6280
PAGES_PROJECT="openclaw-console"
PAGES_BRANCH="main"
# Token escopado não lista contas → wrangler precisa da account explícita.
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-18a324c1eb5c661113310d978ffb152b}"
FRONT_URL="https://ia.globaltecnologia.net/"
API_URL="https://openclaw-api.webconnect.com.br"
TAG="deploy-$(date -u +%Y%m%d-%H%M%S)"

ssh_host() {
  ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
      -o ConnectTimeout=10 "$SSH_USER@$HOST_ADDR" "$@"
}

# Aguenta resposta HTTP. Se EXPECTED vazio: qualquer código ≠ 000 passa
# (serviço de pé, até 401). Se EXPECTED definido: exige exatamente aquele.
# Obs.: curl imprime "000" E sai não-zero quando não conecta — usar `|| true`
# (não `|| echo 000`, que concatenava "000000" e passava o healthcheck falso).
wait_http() {
  local url="$1" tries="$2" label="$3" expected="${4:-}" _ code
  for _ in $(seq 1 "$tries"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)
    [ -n "$code" ] || code=000
    if [ "$code" != "000" ] && { [ -z "$expected" ] || [ "$code" = "$expected" ]; }; then
      echo "[deploy] $label OK (HTTP $code)"
      return 0
    fi
    sleep 3
  done
  echo "[deploy] $label não respondeu após $tries tentativas (último HTTP: ${code:-000})" >&2
  return 1
}

echo "[deploy] $(date -u '+%F %T') UTC — openclaw-console, tag $TAG"

# --- 0) Pré-checagens --------------------------------------------------------
if [ "${SKIP_PAGES:-0}" != "1" ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "[deploy] CLOUDFLARE_API_TOKEN não definido (obrigatório p/ o frontend)." >&2
  echo "[deploy] Defina no .env da raiz do repo (auto-carregado) ou exporte no shell. Alternativa: SKIP_PAGES=1 (só API)." >&2
  exit 1
fi

# --- 1) Acesso ao host -------------------------------------------------------
ssh_host 'echo ok' >/dev/null
echo "[deploy] acesso ao host $HOST_ADDR OK"

# --- 2) Build local (valida + gera apps/web/dist para o Pages) ---------------
if [ "${SKIP_PAGES:-0}" != "1" ]; then
  echo "[deploy] build local do monorepo..."
  npm run build
  echo "[deploy] build local OK (apps/web/dist gerado)"
fi

# --- 3) Frontend → Cloudflare Pages ------------------------------------------
if [ "${SKIP_PAGES:-0}" != "1" ]; then
  echo "[deploy] publicando frontend no Cloudflare Pages ($PAGES_PROJECT, branch $PAGES_BRANCH)..."
  # Lição 2026-08-16: sem WRANGLER_CACHE_DIR o wrangler usava
  # node_modules/.cache/wrangler (permissão de root do build docker) e falhava.
  WRANGLER_CACHE_DIR="${WRANGLER_CACHE_DIR:-$HOME/.cache/wrangler}" \
    npx --yes wrangler@latest pages deploy apps/web/dist \
      --project-name "$PAGES_PROJECT" --branch "$PAGES_BRANCH"
  echo "[deploy] frontend publicado → $FRONT_URL"
fi

# --- 4) API → container no host (compose, .env/volumes preservados) ----------
# Captura a imagem ATUAL antes de buildar (base do rollback).
OLD_IMAGE=$(ssh_host "docker inspect $CONTAINER --format '{{.Image}}'" 2>/dev/null || echo "")
echo "[deploy] imagem atual do $CONTAINER: ${OLD_IMAGE:-<nenhuma>}"

ssh_host bash -s -- "$REPO_HOST" <<'REMOTE'
set -eu
cd "$1"
echo "[deploy][host] compose config (valida .env antes de buildar)..."
docker compose config --quiet
echo "[deploy][host] build da imagem (docker compose build)..."
docker compose build
echo "[deploy][host] recriando container (docker compose up -d)..."
docker compose up -d
REMOTE
echo "[deploy] container $CONTAINER recriado no host (tag $TAG)"

# --- 5) Healthcheck ----------------------------------------------------------
# API local no host: exige HTTP 200 no /healthz (mais tentativas: build+up).
wait_http "http://$HOST_ADDR:$PORT/healthz" 30 "api-local($PORT)" 200 || ROLLBACK_NEEDED=1

if [ "${ROLLBACK_NEEDED:-0}" != "1" ]; then
  # API pública via túnel (qualquer HTTP = túnel+container de pé)
  wait_http "$API_URL/healthz" 10 "api-publica($API_URL)"
  # Front produção (Pages)
  wait_http "$FRONT_URL" 10 "front($FRONT_URL)"
  # Proteção ativa: /api/status sem token deve dar 401 (aviso, não bloqueia)
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API_URL/api/status" 2>/dev/null || echo 000)
  if [ "$CODE" = "401" ]; then
    echo "[deploy] proteção da API OK (sem token → 401)"
  else
    echo "[deploy] ATENÇÃO: /api/status sem token retornou $CODE (esperado 401) — confira o OPENCLAW_CONSOLE_TOKEN" >&2
  fi
fi

# --- 6) Rollback (só API) -----------------------------------------------------
if [ "${ROLLBACK_NEEDED:-0}" = "1" ]; then
  echo "[deploy] FALHOU — revertendo a API para ${OLD_IMAGE:-?}" >&2
  if [ -n "$OLD_IMAGE" ]; then
    ssh_host bash -s -- "$OLD_IMAGE" "$REPO_HOST" "$IMAGE_NAME" <<'REMOTE' || true
set -eu
OLD="$1"; cd "$2"; IMG="$3"
docker tag "$OLD" "$IMG:latest"
docker compose up -d --force-recreate
REMOTE
    echo "[deploy] rollback executado (imagem anterior restaurada)" >&2
  else
    echo "[deploy] sem imagem anterior para restaurar — verifique o container manualmente" >&2
  fi
  exit 1
fi

echo "[deploy] SUCESSO — openclaw-console $TAG no ar (api $API_URL, front $FRONT_URL)"
exit 0
