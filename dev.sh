#!/bin/bash

# Development environment management script
# Usage: ./dev.sh [up|down|restart|logs|build]
#        ./dev.sh up --ephemeral          - native backend + preview frontend on this worktree's slot (scripts/dev-ephemeral.sh)
#        ./dev.sh gc                      - reap ephemeral slots past their 24 h TTL
#        ./dev.sh test                    - unit tests (in-memory, no services needed)
#        ./dev.sh test:integration        - integration tests (requires ./dev.sh up)
#        ./dev.sh cluster [up|down|test]  - local k8s via kind (free, needs docker+kind+helm)

set -e

COMPOSE_FILE="docker-compose.dev.yml"
CLUSTER_NAME="${COMMONLY_CLUSTER_NAME:-commonly-local}"
K8S_NAMESPACE="${COMMONLY_K8S_NAMESPACE:-commonly-local}"
HELM_RELEASE="${COMMONLY_HELM_RELEASE:-commonly}"
HELM_CHART="k8s/helm/commonly"
ENV_FILE=".env"
ENV_EXAMPLE_FILE=".env.example"

has_nonempty_env_value() {
    local key="$1"
    if [ -n "${!key:-}" ]; then
        return 0
    fi

    if [ ! -f "$ENV_FILE" ]; then
        return 1
    fi

    grep -Eq "^${key}=.+" "$ENV_FILE"
}

read_env_value() {
    local key="$1"
    if [ "${!key+x}" = "x" ]; then
        printf '%s' "${!key}"
        return 0
    fi

    if [ ! -f "$ENV_FILE" ]; then
        return 1
    fi

    local line
    line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
    if [ -z "$line" ]; then
        return 1
    fi

    line="${line#*=}"
    line="$(printf '%s' "$line" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
    printf '%s' "$line"
}

# Containers from the retired clawdbot compose profile. Compose no longer knows
# them, so `down` leaves them running, holding port 18789 and the mounted
# credentials, and restart: unless-stopped brings them back after a reboot.
stop_retired_gateway() {
    local name
    for name in clawdbot-gateway-dev clawdbot-cli-dev; do
        if [ -n "$(docker ps -q --filter "name=^/${name}$" 2>/dev/null || true)" ]; then
            echo "🛑 Stopping retired container ${name}. Remove it with: docker rm ${name}"
            docker stop "$name" >/dev/null || true
        fi
    done
}

set_compose_args() {
    COMPOSE_ARGS=(-f "$COMPOSE_FILE")
}

ensure_local_env_file() {
    if [ -f "$ENV_FILE" ]; then
        return
    fi

    if [ -f "$ENV_EXAMPLE_FILE" ]; then
        cp "$ENV_EXAMPLE_FILE" "$ENV_FILE"
        echo "📝 Created $ENV_FILE from $ENV_EXAMPLE_FILE"
        echo "   Review it before enabling optional integrations or AI features."
        echo ""
        return
    fi

    echo "⚠️  $ENV_FILE is missing and $ENV_EXAMPLE_FILE was not found."
    echo "   Docker Compose may still start if your shell env already has the needed values."
    echo ""
}

print_local_dev_notes() {
    echo ""
    echo "Local dev notes:"

    if has_nonempty_env_value "GEMINI_API_KEY" \
        || has_nonempty_env_value "OPENAI_API_KEY" \
        || has_nonempty_env_value "OPENROUTER_API_KEY"; then
        echo "  • AI provider credentials detected."
    else
        echo "  • No AI provider key configured. AI features will stay limited until you set one of:"
        echo "    GEMINI_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY in $ENV_FILE"
        echo "    Then run: ./dev.sh restart"
    fi

    if has_nonempty_env_value "COMMONLY_SUMMARIZER_RUNTIME_TOKEN"; then
        echo "  • commonly-bot runtime token detected."
    else
        echo "  • commonly-bot will stay idle until you provision it from Agents Hub."
        echo "    That is expected for fresh local setups."
    fi
}

case "$1" in
    up)
        if [ "$2" = "--ephemeral" ]; then
            # Per-worktree native stack on its own ports and database (D177). See scripts/dev-ephemeral.sh.
            exec bash "$(dirname "$0")/scripts/dev-ephemeral.sh" up
        fi
        ensure_local_env_file
        echo "🚀 Starting development environment..."
        # Set higher timeout for frontend npm install
        export COMPOSE_HTTP_TIMEOUT=300
        set_compose_args
        stop_retired_gateway
        docker compose "${COMPOSE_ARGS[@]}" up -d
        echo "✅ Development environment started!"
        echo "🌐 Frontend: http://localhost:3000"
        echo "🔧 Backend: http://localhost:5000"
        echo "📊 MongoDB: localhost:27017"
        echo "🐘 PostgreSQL: localhost:5432"
        echo ""
        print_local_dev_notes
        ;;
    
    gc)
        exec bash "$(dirname "$0")/scripts/dev-ephemeral.sh" gc
        ;;

    down)
        echo "🛑 Stopping development environment..."
        stop_retired_gateway
        docker compose -f $COMPOSE_FILE down
        echo "✅ Development environment stopped!"
        ;;
    
    restart)
        ensure_local_env_file
        echo "🔄 Restarting development environment..."
        set_compose_args
        docker compose "${COMPOSE_ARGS[@]}" restart
        echo "✅ Development environment restarted!"
        print_local_dev_notes
        ;;
    
    logs)
        if [ -n "$2" ]; then
            echo "📋 Showing logs for service: $2"
            docker compose -f $COMPOSE_FILE logs -f "$2"
        else
            echo "📋 Showing logs for all services..."
            docker compose -f $COMPOSE_FILE logs -f
        fi
        ;;
    
    build)
        echo "🔨 Building development containers..."
        set_compose_args
        docker compose "${COMPOSE_ARGS[@]}" build
        echo "✅ Development containers built!"
        ;;
    
    rebuild)
        echo "🔨 Rebuilding development containers (no cache)..."
        set_compose_args
        docker compose "${COMPOSE_ARGS[@]}" build --no-cache
        echo "✅ Development containers rebuilt!"
        ;;
    
    clean)
        echo "🧹 Cleaning up development environment..."
        docker compose -f $COMPOSE_FILE down -v --remove-orphans
        docker image prune -f
        echo "✅ Development environment cleaned!"
        ;;
    
    shell)
        if [ -n "$2" ]; then
            echo "🐚 Opening shell in service: $2"
            docker compose -f $COMPOSE_FILE exec "$2" /bin/bash
        else
            echo "❌ Please specify a service: backend, frontend, mongo, postgres"
        fi
        ;;
    
    test)
        echo "🧪 Running unit tests (in-memory DBs)..."
        docker compose -f $COMPOSE_FILE exec backend npm test
        ;;

    test:integration)
        echo "🧪 Running integration tests against Docker Compose services..."
        echo "   Requires: ./dev.sh up (mongo on :27017, postgres on :5432)"
        INTEGRATION_TEST=true npm --prefix backend test -- --forceExit
        ;;

    cluster)
        case "$2" in
            up)
                echo "☸️  Creating local kind cluster: $CLUSTER_NAME"
                if ! command -v kind &> /dev/null; then
                    echo "❌ kind not found. Install: https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
                    exit 1
                fi
                if ! command -v helm &> /dev/null; then
                    echo "❌ helm not found. Install: https://helm.sh/docs/intro/install/"
                    exit 1
                fi

                # Create cluster if it doesn't already exist
                if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
                    echo "  Cluster '$CLUSTER_NAME' already exists, skipping create."
                else
                    kind create cluster --name "$CLUSTER_NAME"
                fi

                echo "🔨 Building Docker images..."
                docker build -t commonly-backend:local ./backend
                docker build \
                    --build-arg REACT_APP_API_URL=http://localhost:5000 \
                    -t commonly-frontend:local ./frontend

                echo "📦 Loading images into kind cluster..."
                kind load docker-image commonly-backend:local --name "$CLUSTER_NAME"
                kind load docker-image commonly-frontend:local --name "$CLUSTER_NAME"

                echo "🚀 Deploying via Helm..."
                helm upgrade --install "$HELM_RELEASE" "$HELM_CHART" \
                    --create-namespace -n "$K8S_NAMESPACE" \
                    -f "$HELM_CHART/values.yaml" \
                    -f "$HELM_CHART/values-local.yaml" \
                    "$@"

                echo "⏳ Waiting for backend to be ready..."
                kubectl wait --for=condition=ready pod \
                    -l app=backend -n "$K8S_NAMESPACE" \
                    --timeout=120s

                echo ""
                echo "✅ Local cluster is up!"
                echo ""
                echo "Access the app:"
                echo "  kubectl port-forward -n $K8S_NAMESPACE svc/backend 5000:5000"
                echo "  kubectl port-forward -n $K8S_NAMESPACE svc/frontend 3000:80"
                echo ""
                echo "Run tests against it:"
                echo "  ./dev.sh cluster test"
                echo ""
                echo "Tear down:"
                echo "  ./dev.sh cluster down"
                ;;

            down)
                echo "🗑️  Deleting kind cluster: $CLUSTER_NAME"
                kind delete cluster --name "$CLUSTER_NAME"
                echo "✅ Cluster deleted."
                ;;

            test)
                echo "🧪 Running tests against local kind cluster..."
                if ! kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
                    echo "  Cluster not running — starting it first..."
                    "$0" cluster up
                fi

                echo "⏳ Waiting for backend readiness..."
                kubectl wait --for=condition=ready pod \
                    -l app=backend -n "$K8S_NAMESPACE" \
                    --timeout=120s

                # Forward backend to a local port for the test suite
                LOCAL_PORT=15000
                kubectl port-forward -n "$K8S_NAMESPACE" \
                    svc/backend "${LOCAL_PORT}:5000" &
                PF_PID=$!
                sleep 2

                # Run tests, capture exit code, always kill port-forward
                EXIT_CODE=0
                INTEGRATION_TEST=true \
                    BACKEND_URL="http://localhost:${LOCAL_PORT}" \
                    npm --prefix backend test -- --forceExit || EXIT_CODE=$?

                kill "$PF_PID" 2>/dev/null || true

                if [ "$EXIT_CODE" -eq 0 ]; then
                    echo "✅ All tests passed."
                else
                    echo "❌ Tests failed (exit $EXIT_CODE)."
                fi
                exit "$EXIT_CODE"
                ;;

            logs)
                SERVICE="${3:-backend}"
                echo "📋 Logs for $SERVICE in $K8S_NAMESPACE..."
                kubectl logs -n "$K8S_NAMESPACE" -l "app=$SERVICE" -f
                ;;

            status)
                echo "☸️  Cluster: $CLUSTER_NAME"
                kubectl get pods -n "$K8S_NAMESPACE"
                ;;

            *)
                echo "☸️  Local Kubernetes Cluster Commands"
                echo ""
                echo "Usage: ./dev.sh cluster [command]"
                echo ""
                echo "Commands:"
                echo "  up      - Build images, create kind cluster, deploy via Helm"
                echo "  down    - Delete the kind cluster"
                echo "  test    - Run integration tests against the cluster"
                echo "  logs    - Stream logs (optional: logs [service])"
                echo "  status  - Show pod status"
                echo ""
                echo "Requires: kind, kubectl, helm"
                echo "Install kind:  https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
                echo "Install helm:  https://helm.sh/docs/intro/install/"
                echo ""
                echo "To pass API keys:"
                echo "  COMMONLY_CLUSTER_NAME=my-cluster ./dev.sh cluster up \\"
                echo "    --set localSecrets.geminiApiKey=AIza..."
                ;;
        esac
        ;;

    clawdbot)
        stop_retired_gateway
        echo "The local OpenClaw gateway was retired (ADR-021 Part B), so this command no longer does anything."
        echo "Use native agents, or attach a local CLI with: commonly agent attach <cli>"
        exit 1
        ;;

    *)
        echo "🎯 Development Environment Manager"
        echo ""
        echo "Usage: ./dev.sh [command]"
        echo ""
        echo "Commands:"
        echo "  up        - Start development environment"
        echo "  down      - Stop development environment"
        echo "  restart   - Restart development environment"
        echo "  logs      - Show logs (optional: logs [service])"
        echo "  build     - Build development containers (with cache)"
        echo "  rebuild   - Rebuild development containers (no cache)"
        echo "  clean     - Clean up containers and volumes"
        echo "  shell     - Open shell in service (shell [service])"
        echo "  test      - Run backend tests (Docker Compose)"
        echo "  cluster   - Local Kubernetes cluster (requires kind + helm)"
        echo "              cluster up|down|test|logs|status"
        echo ""
        echo "Examples:"
        echo "  ./dev.sh up"
        echo "  ./dev.sh logs backend"
        echo "  ./dev.sh shell frontend"
        echo "  ./dev.sh cluster up"
        echo "  ./dev.sh cluster test"
        echo "  ./dev.sh cluster down"
        ;;
esac
