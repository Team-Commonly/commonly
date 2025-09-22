#!/bin/bash

# Production environment management script
# Usage: ./prod.sh [up|down|restart|logs|build]

set -e

COMPOSE_FILE="docker-compose.yml"

case "$1" in
    up)
        echo "🚀 Starting production environment..."
        docker-compose -f $COMPOSE_FILE up -d
        echo "✅ Production environment started!"
        echo "🌐 Frontend: http://localhost:3000"
        echo "🔧 Backend: http://localhost:5000"
        ;;
    
    down)
        echo "🛑 Stopping production environment..."
        docker-compose -f $COMPOSE_FILE down
        echo "✅ Production environment stopped!"
        ;;
    
    restart)
        echo "🔄 Restarting production environment..."
        docker-compose -f $COMPOSE_FILE restart
        echo "✅ Production environment restarted!"
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
        echo "🔨 Building production containers..."
        docker-compose -f $COMPOSE_FILE build --no-cache
        echo "✅ Production containers built!"
        ;;
    
    deploy)
        echo "🚀 Deploying production environment..."
        docker-compose -f $COMPOSE_FILE build
        docker-compose -f $COMPOSE_FILE up -d
        echo "✅ Production environment deployed!"
        ;;
    
    *)
        echo "🏭 Production Environment Manager"
        echo ""
        echo "Usage: ./prod.sh [command]"
        echo ""
        echo "Commands:"
        echo "  up        - Start production environment"
        echo "  down      - Stop production environment"  
        echo "  restart   - Restart production environment"
        echo "  logs      - Show logs (optional: logs [service])"
        echo "  build     - Rebuild production containers"
        echo "  deploy    - Build and deploy production environment"
        echo ""
        ;;
esac