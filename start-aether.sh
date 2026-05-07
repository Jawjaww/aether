#!/bin/bash
# start-aether.sh
# Starts the Aether Gateway, which then orchestrates the MLX model and Daemon.

# Configuration
MLX_PORT=8081
AETHER_PORT=8080
CONFIG_FILE="$HOME/.aether/config.json"
if [ -f "$CONFIG_FILE" ]; then
  export TOKEN_BUDGET=$(node -e "try { console.log(require('$CONFIG_FILE').tokenBudget || 8192) } catch(e) { console.log(8192) }")
else
  export TOKEN_BUDGET=8192
fi

echo "=========================================="
echo "🌌 Starting Aether Gateway Manager"
echo "=========================================="

export OLLAMA_URL="http://127.0.0.1:$MLX_PORT"
export AETHER_PORT=$AETHER_PORT

echo "1️⃣  Starting Aether Gateway..."
npm run dev --workspace=packages/gateway &
GATEWAY_PID=$!

echo "⏳  Waiting for Gateway to boot (3s)..."
sleep 3

echo "=========================================="
echo "✅  GATEWAY IS READY!"
echo "👉  Open your Dashboard to Power On the Engine"
echo "✅  EVERYTHING IS READY!"
echo "👉  Dashboard: http://127.0.0.1:$AETHER_PORT/dashboard"
echo "👉  API Base : http://127.0.0.1:$AETHER_PORT/v1"
echo "=========================================="
echo "(Press CTRL+C to stop everything cleanly)"

# Function to clean up on exit (CTRL+C)
cleanup() {
    echo ""
    echo "🛑 Stopping services via Gateway..."
    curl -s -X POST http://127.0.0.1:$AETHER_PORT/aether/engine/stop > /dev/null
    sleep 1
    kill $GATEWAY_PID 2>/dev/null
    echo "👋 See you soon!"
    exit 0
}

# Trap the interrupt signals
trap cleanup SIGINT SIGTERM

# Keep the script active
wait
