#!/usr/bin/env sh
set -eu

TARGET="${1:-}"
ENV_FILE="${AGENT_ENV_FILE:-.env.ecs}"
COMPOSE_FILE="docker-compose.ecs.yml"

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
  cp .env.ecs.example "$ENV_FILE"
  echo "Created $ENV_FILE. Fill in OPENAI_API_KEY and CORS_ORIGIN, then run this command again."
  exit 1
fi

read_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

OPENAI_KEY="$(read_env OPENAI_API_KEY)"
if [ -z "$OPENAI_KEY" ] || [ "$OPENAI_KEY" = "change-me" ]; then
  echo "OPENAI_API_KEY is not configured in $ENV_FILE."
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
