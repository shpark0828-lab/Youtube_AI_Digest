#!/usr/bin/env bash
cd "$(dirname "$0")"

# Check if .venv exists
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
    ./.venv/bin/pip install -q fastapi uvicorn requests apscheduler youtube-transcript-api
fi

# Run the app
./.venv/bin/python app.py "$@"
