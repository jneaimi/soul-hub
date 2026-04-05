#!/bin/bash
# Soul Hub V2 — Production starter
# Starts both Node server and Cloudflare tunnel, keeps them alive.
# Usage: ./scripts/start_prod.sh [stop|status|restart]

PORT=5173
BUILD_DIR="$HOME/dev/soul-hub/build"
LOG_DIR="$HOME/dev/soul-hub/logs"
PID_DIR="$HOME/dev/soul-hub/.pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

stop_services() {
    echo "Stopping services..."
    [ -f "$PID_DIR/node.pid" ] && kill "$(cat "$PID_DIR/node.pid")" 2>/dev/null && echo "  Node stopped"
    [ -f "$PID_DIR/cloudflared.pid" ] && kill "$(cat "$PID_DIR/cloudflared.pid")" 2>/dev/null && echo "  Cloudflared stopped"
    # Also kill by port in case PID files are stale
    kill $(lsof -ti:$PORT) 2>/dev/null
    pkill -f "cloudflared tunnel run" 2>/dev/null
    rm -f "$PID_DIR"/*.pid
    echo "Done."
}

start_services() {
    # Kill anything already on the port
    kill $(lsof -ti:$PORT) 2>/dev/null
    pkill -f "cloudflared tunnel run" 2>/dev/null
    sleep 1

    echo "Starting Soul Hub V2 production..."

    # Start Node server
    cd "$HOME/dev/soul-hub"
    PORT=$PORT node "$BUILD_DIR/index.js" >> "$LOG_DIR/node.log" 2>&1 &
    echo $! > "$PID_DIR/node.pid"
    echo "  Node server PID $(cat "$PID_DIR/node.pid") on port $PORT"

    # Wait for Node to be ready
    for i in $(seq 1 10); do
        curl -s -o /dev/null http://localhost:$PORT/ && break
        sleep 1
    done

    # Start Cloudflare tunnel
    cloudflared tunnel run >> "$LOG_DIR/cloudflared.log" 2>&1 &
    echo $! > "$PID_DIR/cloudflared.pid"
    echo "  Cloudflared PID $(cat "$PID_DIR/cloudflared.pid")"

    sleep 2

    # Verify
    local ok=0
    curl -s -o /dev/null http://localhost:$PORT/ && echo "  [OK] Node responding on :$PORT" || { echo "  [FAIL] Node not responding"; ok=1; }
    pgrep -f "cloudflared tunnel run" > /dev/null && echo "  [OK] Cloudflared running" || { echo "  [FAIL] Cloudflared not running"; ok=1; }

    if [ $ok -eq 0 ]; then
        echo ""
        echo "Soul Hub V2 live at https://soul-hub.jneaimi.com"
    fi
}

status_services() {
    echo "Soul Hub V2 status:"
    if [ -f "$PID_DIR/node.pid" ] && kill -0 "$(cat "$PID_DIR/node.pid")" 2>/dev/null; then
        echo "  Node: running (PID $(cat "$PID_DIR/node.pid"))"
    else
        echo "  Node: stopped"
    fi
    if [ -f "$PID_DIR/cloudflared.pid" ] && kill -0 "$(cat "$PID_DIR/cloudflared.pid")" 2>/dev/null; then
        echo "  Cloudflared: running (PID $(cat "$PID_DIR/cloudflared.pid"))"
    else
        echo "  Cloudflared: stopped"
    fi
    curl -s -o /dev/null -w "  HTTP: %{http_code}\n" http://localhost:$PORT/ 2>/dev/null || echo "  HTTP: unreachable"
}

case "${1:-start}" in
    stop)    stop_services ;;
    status)  status_services ;;
    restart) stop_services; sleep 1; start_services ;;
    start)   start_services ;;
    *)       echo "Usage: $0 [start|stop|status|restart]" ;;
esac
