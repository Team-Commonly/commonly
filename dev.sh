#!/bin/bash

# Development environment management script
# Usage: ./dev.sh [up|down|restart|logs|build]
#        ./dev.sh test                    - unit tests (in-memory, no services needed)
#        ./dev.sh test:integration        - integration tests (requires ./dev.sh up)
#        ./dev.sh clawdbot [up|down|logs]
#        ./dev.sh cluster [up|down|test]  - local k8s via kind (free, needs docker+kind+helm)

set -e

COMPOSE_FILE="docker-compose.dev.yml"
CLUSTER_NAME="${COMMONLY_CLUSTER_NAME:-commonly-local}"
K8S_NAMESPACE="${COMMONLY_K8S_NAMESPACE:-commonly-local}"
HELM_RELEASE="${COMMONLY_HELM_RELEASE:-commonly}"
HELM_CHART="k8s/helm/commonly"

case "$1" in
    up)
        echo "🚀 Starting development environment..."
        # Set higher timeout for frontend npm install
        export COMPOSE_HTTP_TIMEOUT=300
        docker-compose -f $COMPOSE_FILE up -d
        echo "✅ Development environment started!"
        echo "🌐 Frontend: http://localhost:3000"
        echo "🔧 Backend: http://localhost:5000"
        echo "📊 MongoDB: localhost:27017"
        echo "🐘 PostgreSQL: localhost:5432"
        echo ""
        echo "💡 To start Clawdbot: ./dev.sh clawdbot up"
        ;;
    
    down)
        echo "🛑 Stopping development environment..."
        docker-compose -f $COMPOSE_FILE down
        echo "✅ Development environment stopped!"
        ;;
    
    restart)
        echo "🔄 Restarting development environment..."
        docker-compose -f $COMPOSE_FILE restart
        echo "✅ Development environment restarted!"
        ;;
    
    logs)
        if [ -n "$2" ]; then
            echo "📋 Showing logs for service: $2"
            docker-compose -f $COMPOSE_FILE logs -f "$2"
        else
            echo "📋 Showing logs for all services..."
            docker-compose -f $COMPOSE_FILE logs -f
        fi
        ;;
    
    build)
        echo "🔨 Building development containers..."
        docker-compose -f $COMPOSE_FILE build
        echo "✅ Development containers built!"
        ;;
    
    rebuild)
        echo "🔨 Rebuilding development containers (no cache)..."
        docker-compose -f $COMPOSE_FILE build --no-cache
        echo "✅ Development containers rebuilt!"
        ;;
    
    clean)
        echo "🧹 Cleaning up development environment..."
        docker-compose -f $COMPOSE_FILE down -v --remove-orphans
        docker image prune -f
        echo "✅ Development environment cleaned!"
        ;;
    
    shell)
        if [ -n "$2" ]; then
            echo "🐚 Opening shell in service: $2"
            docker-compose -f $COMPOSE_FILE exec "$2" /bin/bash
        else
            echo "❌ Please specify a service: backend, frontend, mongo, postgres"
        fi
        ;;
    
    test)
        echo "🧪 Running unit tests (in-memory DBs)..."
        docker-compose -f $COMPOSE_FILE exec backend npm test
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
        case "$2" in
            up)
                echo "🤖 Starting Clawdbot services..."
                docker-compose -f $COMPOSE_FILE --profile clawdbot up -d
                echo "✅ Clawdbot services started!"
                echo "🧠 Clawdbot Gateway: http://localhost:18789"
                echo "🌉 Clawdbot Bridge: polling Commonly API"
                echo ""
                echo "📋 View logs: ./dev.sh clawdbot logs"
                ;;
            down)
                echo "🛑 Stopping Clawdbot services..."
                docker-compose -f $COMPOSE_FILE --profile clawdbot stop clawdbot-gateway clawdbot-cli
                echo "✅ Clawdbot services stopped!"
                ;;
            logs)
                echo "📋 Showing logs for: clawdbot-$3"
                docker-compose -f $COMPOSE_FILE logs -f "clawdbot-$3"
                ;;
            restart)
                echo "🔄 Restarting Clawdbot services..."
                docker-compose -f $COMPOSE_FILE --profile clawdbot restart clawdbot-gateway clawdbot-cli
                echo "✅ Clawdbot services restarted!"
                ;;
            build)
                echo "🔨 Building Clawdbot containers..."
                docker-compose -f $COMPOSE_FILE --profile clawdbot build clawdbot-gateway clawdbot-cli
                echo "✅ Clawdbot containers built!"
                ;;
            *)
                echo "🤖 Clawdbot Commands"
                echo ""
                echo "Usage: ./dev.sh clawdbot [command]"
                echo ""
                echo "Commands:"
                echo "  up       - Start Clawdbot services (gateway, bridge, cli)"
                echo "  down     - Stop Clawdbot services"
                echo "  restart  - Restart Clawdbot services"
                echo "  logs     - Show bridge logs (or: logs gateway, logs cli)"
                echo "  build    - Build Clawdbot containers"
                ;;
        esac
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
        echo "  clawdbot  - Manage Clawdbot services (clawdbot up|down|logs|restart)"
        echo "  cluster   - Local Kubernetes cluster (requires kind + helm)"
        echo "              cluster up|down|test|logs|status"
        echo ""
        echo "Examples:"
        echo "  ./dev.sh up"
        echo "  ./dev.sh logs backend"
        echo "  ./dev.sh shell frontend"
        echo "  ./dev.sh clawdbot up"
        echo "  ./dev.sh cluster up"
        echo "  ./dev.sh cluster test"
        echo "  ./dev.sh cluster down"
        ;;
esac