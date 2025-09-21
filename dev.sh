#!/bin/bash

# Development environment management script
# Usage: ./dev.sh [up|down|restart|logs|build]

set -e

COMPOSE_FILE="docker-compose.dev.yml"

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
        echo "🧪 Running tests..."
        docker-compose -f $COMPOSE_FILE exec backend npm test
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
        echo "  test      - Run backend tests"
        echo ""
        echo "Examples:"
        echo "  ./dev.sh up"
        echo "  ./dev.sh logs backend"
        echo "  ./dev.sh shell frontend"
        ;;
esac