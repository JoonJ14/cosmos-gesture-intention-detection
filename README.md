# cosmos-gesture-intention-detection

Real-time webcam gesture agent scaffold for NVIDIA Cosmos Cookoff.

## Architecture Diagram
```text
                 ┌──────────────────────────────────────────────┐
                 │               Web App (JS)                   │
                 │  MediaPipe Hands (browser)                   │
                 │  Gesture state machine + confidence          │
                 │  Ring buffer: last ~1s frames                │
                 │  UI overlay + event log view                 │
                 └───────────────┬──────────────────────────────┘
                                 │
                 proposes intent │  POST /execute
                 and decides     │  { intent, event_id }
                 whether to      v
                 verify          ┌──────────────────────────────┐
                                 │      Action Executor (PY)    │
                                 │   FastAPI on localhost       │
                                 │   Reads actions.yaml         │
                                 │   Sends OS key events        │
                                 │   Linux GNOME X11: xdotool   │
                                 │   macOS: osascript or Quartz │
                                 │   Logs JSONL per action      │
                                 └──────────────────────────────┘

                                 │  only for ambiguous cases
                                 │  POST /verify
                                 │  { proposed_intent, frames[], landmark_summary, event_id }
                                 v
                 ┌──────────────────────────────────────────────┐
                 │           Cosmos Verifier (PY)               │
                 │   FastAPI on DGX Spark                       │
                 │   Validates strict JSON schema               │
                 │   Logs JSONL per verification                │
                 └───────────────┬──────────────────────────────┘
                                 │
                                 │  OpenAI compatible HTTP call
                                 │  /v1/chat/completions
                                 v
                 ┌──────────────────────────────────────────────┐
                 │      Cosmos Reason 2 NIM (DGX Spark)          │
                 │   Model inference service                     │
                 │   Returns strict JSON: intentional or not     │
                 └──────────────────────────────────────────────┘
```

## Runtime Flow Diagram
```text
Proposal Created (event_id)
        |
        v
Safe Mode?
  | yes                          | no
  v                              v
Call /verify                 Call /execute
  |                              |
  | timeout                      |
  v                              v
Stop, log verifier_timeout      Execute
  |
  | response
  v
intentional && final_intent != NONE ?
  | yes                          | no
  v                              v
Call /execute                   Stop, log verifier_reject
```

## What this repo contains
- Browser app (`web/`) with MediaPipe Hands overlay and keyboard-triggered gesture proposal stubs.
- Verifier service (`verifier/`) that returns strict schema-valid JSON (Cosmos verifier stub for now).
- Executor service (`executor/`) that maps verified intents to OS key actions using `actions.yaml`.
- Shared strict JSON schema (`shared/schema.json`).
- Architecture, prompt/schema, latency, and risk docs in `docs/`.
- Verifier currently uses stub logic, but the target architecture includes the Cosmos Reason 2 NIM `/v1/chat/completions` verification call path.

## Docs index
- `docs/PROJECT_CONTEXT.md`
- `docs/SYSTEM_ARCHITECTURE.md`
- [`docs/ARCHITECTURE_DIAGRAMS.md`](docs/ARCHITECTURE_DIAGRAMS.md)
- `docs/COSMOS_PROMPT_AND_SCHEMA.md`
- `docs/LATENCY_AND_AMBIGUOUS_POLICY.md`
- `docs/OPTION2_RISKS_AND_MITIGATIONS.md`

`docs/ARCHITECTURE_DIAGRAMS.md` includes the Cosmos-aware runtime decision flow and deployment modes; current verifier runtime remains stubbed while preserving the Cosmos Reason 2 NIM call architecture.

## Run locally
Open three terminals from repo root.

1. Start executor (port `8787`)
```bash
./scripts/run_executor.sh
```

2. Start verifier (port `8788`)
```bash
./scripts/run_verifier.sh
```

3. Start web app (port `5173`)
```bash
./scripts/run_web.sh
```

4. Open browser
- Visit `http://127.0.0.1:5173`
- Allow webcam access.
- Press keys `1`..`4` to generate test proposals:
  - `1` OPEN_MENU
  - `2` CLOSE_MENU
  - `3` SWITCH_RIGHT
  - `4` SWITCH_LEFT
- Toggle **Safe Mode** ON to route proposal through verifier first.

## Platform notes
- Linux target: GNOME X11 with `xdotool` installed.
- macOS target: uses `osascript` + System Events for key injection.
  - Required: enable **Accessibility** permission for Terminal or your Python interpreter in macOS Settings.

## Acceptance test curls
Executor health:
```bash
curl -s http://127.0.0.1:8787/health
```

Executor execute (dry run):
```bash
curl -s -X POST http://127.0.0.1:8787/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "intent":"OPEN_MENU",
    "event_id":"evt-readme-001",
    "dry_run":true,
    "source":"curl_test"
  }'
```

Verifier health:
```bash
curl -s http://127.0.0.1:8788/health
```

Verifier verify:
```bash
curl -s -X POST http://127.0.0.1:8788/verify \
  -H 'Content-Type: application/json' \
  -d '{
    "event_id":"evt-readme-verify-001",
    "proposed_intent":"SWITCH_RIGHT",
    "local_confidence":0.73
  }'
```

Verifier forced reject test:
```bash
curl -s -X POST 'http://127.0.0.1:8788/verify?force_reject=true' \
  -H 'Content-Type: application/json' \
  -d '{
    "event_id":"evt-readme-verify-002",
    "proposed_intent":"SWITCH_RIGHT"
  }'
```

Responses include `event_id` and verifier responses validate against `shared/schema.json`.
