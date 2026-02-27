# Build Status & Session Handoff

## AI agent instructions
- **Read this file at the start of every session before doing anything else**
- **Update this file only when the user explicitly asks to update the documents** (typically at end of session)

## Session handoff note
> Update this block at the end of every session so the next one knows where to start.

**Last updated**: Initial scaffold complete. No gesture recognition or Cosmos NIM call yet.
**Next session should**: Implement `proposeGestureFromLandmarks()` in `web/src/gesture.js`.

---

## Build checklist

### Done — scaffold
- [x] Web app: MediaPipe Hands running, canvas overlay, Safe Mode toggle, verifier timeout input
- [x] Event state machine: PROPOSED → VERIFYING → APPROVED → EXECUTED (merge/supersede/timeout)
- [x] Verifier service (FastAPI :8788) — stub, schema validation, JSONL logging
- [x] Executor service (FastAPI :8787) — xdotool (Linux) / osascript (macOS), JSONL logging
- [x] `shared/schema.json` — strict 7-field verifier response contract
- [x] `executor/actions.yaml` — OS key mappings (linux/macos)
- [x] Smoke test: `scripts/smoke_test.sh`
- [x] Design docs in `docs/`

### Critical path — not done
- [ ] **Gesture recognition** — `web/src/gesture.js:proposeGestureFromLandmarks()` returns `null`. Needs landmark-to-intent classification + temporal smoothing + hold heuristics for OPEN/CLOSE, directionality for SWITCH_LEFT/RIGHT.
- [ ] **Cosmos NIM call** — `verifier/verifier/stub_logic.py` is a stub. Replace with OpenAI-compatible `/v1/chat/completions` call. Prompt template is in `docs/COSMOS_PROMPT_AND_SCHEMA.md`.
- [ ] **Send actual data to verifier** — `web/src/main.js` sends only hardcoded `local_confidence: 0.7`. Must pass real `landmark_summary_json` (or base64 `frames`) so Cosmos can reason visually.
- [ ] **Real local_confidence** — compute from MediaPipe detection confidence, not hardcoded.

### Post-core / nice-to-have
- [ ] Confidence threshold routing: HIGH → direct execute, MEDIUM → verify, LOW → ignore (designed in docs, not in code)
- [ ] Frame ring buffer for multi-frame context window to Cosmos
- [ ] Event log UI panel in the browser

---

## Key files

| File | Role |
|------|------|
| `web/src/gesture.js` | MediaPipe setup + **TODO: gesture recognition** |
| `web/src/main.js` | Event state machine, safe mode policy, merge/supersede |
| `web/src/api.js` | HTTP client for verifier and executor |
| `verifier/verifier/stub_logic.py` | **Stub — replace with Cosmos NIM call** |
| `verifier/verifier/main.py` | FastAPI /verify, schema validation, JSONL log |
| `executor/executor/main.py` | FastAPI /execute, xdotool/osascript, JSONL log |
| `executor/actions.yaml` | OS key mappings per intent |
| `shared/schema.json` | Strict verifier response schema |

---

## Run locally (3 terminals)

```bash
./scripts/run_executor.sh   # :8787
./scripts/run_verifier.sh   # :8788
./scripts/run_web.sh        # :5173 — open in browser
```

Test triggers: keys `1`–`4` → OPEN_MENU / CLOSE_MENU / SWITCH_RIGHT / SWITCH_LEFT. Safe Mode ON routes through verifier first.

```bash
# Health checks
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8788/health

# Executor dry run
curl -s -X POST http://127.0.0.1:8787/execute \
  -H 'Content-Type: application/json' \
  -d '{"intent":"OPEN_MENU","event_id":"test","dry_run":true,"source":"curl"}'

# Verifier (stub pass-through)
curl -s -X POST http://127.0.0.1:8788/verify \
  -H 'Content-Type: application/json' \
  -d '{"event_id":"test","proposed_intent":"SWITCH_RIGHT","local_confidence":0.73}'

# Verifier forced reject
curl -s -X POST 'http://127.0.0.1:8788/verify?force_reject=true' \
  -H 'Content-Type: application/json' \
  -d '{"event_id":"test","proposed_intent":"SWITCH_RIGHT"}'
```

---

## Cosmos NIM integration (when ready)

- API: OpenAI-compatible `/v1/chat/completions`
- Model slug: check NIM docs (`nvidia/cosmos-reason2` or catalog name)
- Pass frames as base64 images in multimodal message content
- Pass `landmark_summary_json` as JSON string in the user turn
- Response must validate against `shared/schema.json` — 7 required fields, strict enums
- Full prompt template: `docs/COSMOS_PROMPT_AND_SCHEMA.md`
- Can run on DGX Spark locally or via `api.nvidia.com` (API key in env)
