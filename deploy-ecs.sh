#!/usr/bin/env sh
set -eu

TARGET="${1:-}"
ENV_FILE="${AGENT_ENV_FILE:-.env}"
COMPOSE_FILE="docker-compose.yml"

# 输出部署脚本的用法说明
usage() {
  echo "Usage: bash deploy-ecs.sh <typescript|python|all>"
}

case "$TARGET" in
  typescript|python|all) ;;
  *)
    usage
    exit 1
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker Engine with the Compose plugin first."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "The Docker Compose plugin is not available."
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  echo "Created $ENV_FILE. Fill in OPENAI_API_KEY, IMAGE_API_KEY, memory gateway settings, AGENT_API_SECRET and CORS_ORIGIN, then run this command again."
  exit 1
fi

# 从部署环境文件读取指定配置
read_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

OPENAI_KEY="$(read_env OPENAI_API_KEY)"
if [ -z "$OPENAI_KEY" ] || [ "$OPENAI_KEY" = "change-me" ]; then
  echo "OPENAI_API_KEY is not configured in $ENV_FILE."
  exit 1
fi

IMAGE_KEY="$(read_env IMAGE_API_KEY)"
if [ -z "$IMAGE_KEY" ] || [ "$IMAGE_KEY" = "change-me" ]; then
  echo "IMAGE_API_KEY is not configured in $ENV_FILE."
  exit 1
fi

MEMORY_BASE_URL="$(read_env CLOUDFLARE_MEMORY_BASE_URL)"
MEMORY_SECRET="$(read_env CLOUDFLARE_MEMORY_SECRET)"
AGENT_API_SECRET="$(read_env AGENT_API_SECRET)"
if [ -z "$MEMORY_BASE_URL" ] || [ "$MEMORY_BASE_URL" = "https://change-me.workers.dev" ]; then
  echo "CLOUDFLARE_MEMORY_BASE_URL is not configured in $ENV_FILE."
  exit 1
fi
if [ -z "$MEMORY_SECRET" ] || [ "$MEMORY_SECRET" = "change-me" ]; then
  echo "CLOUDFLARE_MEMORY_SECRET is not configured in $ENV_FILE."
  exit 1
fi
if [ -z "$AGENT_API_SECRET" ] || [ "$AGENT_API_SECRET" = "change-me" ]; then
  echo "AGENT_API_SECRET is not configured in $ENV_FILE."
  exit 1
fi

case "$TARGET" in
  typescript)
    PROFILES="--profile typescript"
    SERVICES="ts-agent"
    ;;
  python)
    PROFILES="--profile python"
    SERVICES="py-agent"
    ;;
  all)
    PROFILES="--profile typescript --profile python"
    SERVICES="ts-agent py-agent"
    ;;
esac

# Word splitting is intentional for the fixed profile and service lists above.
# shellcheck disable=SC2086
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" $PROFILES up -d --build $SERVICES
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" $PROFILES ps

TS_PORT="$(read_env TS_PUBLIC_PORT)"
TS_PORT="${TS_PORT:-6001}"
PY_PORT="$(read_env PY_PUBLIC_PORT)"
PY_PORT="${PY_PORT:-6002}"

if [ "$TARGET" = "typescript" ] || [ "$TARGET" = "all" ]; then
  echo "TypeScript local health check: http://127.0.0.1:$TS_PORT/api/v1/health"
  echo "TypeScript frontend API: http://<ECS-public-IP>:$TS_PORT/api/v1"
fi
if [ "$TARGET" = "python" ] || [ "$TARGET" = "all" ]; then
  echo "Python local health check: http://127.0.0.1:$PY_PORT/api/v1/health"
  echo "Python frontend API: http://<ECS-public-IP>:$PY_PORT/api/v1"
fi
