#!/usr/bin/env bash
# Usage: ./run.sh   (search + download)
# Works on macOS and Termux. RUNTIME in .env picks node/ or python/; installs
# packages on first run, loads .env, and runs that version.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "❌ .env missing. Run: cp .env.example .env  and fill it in." >&2
  exit 1
fi
set -a; source .env; set +a

for var in TG_API_ID TG_API_HASH TG_PHONE BOT_USERNAME; do
  if [[ -z "${!var:-}" ]]; then echo "❌ $var is empty in .env" >&2; exit 1; fi
done

case "${RUNTIME:-node}" in
  node)
    if [[ ! -d node/node_modules ]]; then
      echo "📦 First run: installing node packages..."
      # --no-bin-links: shared storage on Android can't hold symlinks.
      # --ignore-scripts: skips optional native add-ons, which fall back to plain JS.
      npm install --silent --no-bin-links --ignore-scripts --prefix node
    fi
    # Newer Node warns when gramjs merely checks for localStorage; it's harmless.
    exec node --disable-warning=ExperimentalWarning node/popkorn.js
    ;;
  python)
    # Packages go in a plain folder, not a venv: shared storage on Android
    # can't hold symlinks or run binaries, so we use the system python3.
    if [[ ! -d python/.deps ]]; then
      echo "📦 First run: installing telethon..."
      python3 -m pip install -q --target python/.deps -r python/requirements.txt
    fi
    PYTHONPATH=python/.deps exec python3 python/popkorn.py
    ;;
  *)
    echo "❌ RUNTIME in .env must be node or python (got: $RUNTIME)" >&2
    exit 1
    ;;
esac
