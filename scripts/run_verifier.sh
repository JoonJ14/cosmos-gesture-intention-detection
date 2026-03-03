#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/verifier"

python3 -m venv .venv
source .venv/bin/activate
pip install setuptools
pip install --no-build-isolation -e .

uvicorn verifier.main:app --host 0.0.0.0 --port 8788 --reload
