# Build Status & Session Handoff

## AI agent instructions
- **Read this file at the start of every session before doing anything else**
- **Read `docs/PROJECT_CONTEXT.md` for the full problem framing and design rationale**
- **Read `docs/GESTURE_DETECTION.md` before modifying gesture recognition**
- **Update this file only when the user explicitly asks to update the documents**

## Session handoff note

**Last updated**: 2026-02-27 evening. Gesture detection and ring buffer implemented.
Async Cosmos verification wired up.

**Current state**: All three services run. MediaPipe Hands detects landmarks. Gesture
state machines classify swipes, palm holds, and palm-to-fist transitions into intent
proposals with real confidence scores. Ring buffer captures ~1s of frames. Async
verification sends real evidence (8 JPEG frames + landmark summary JSON) to Cosmos in
the background after execution. Cosmos Reason 2 is running locally via vLLM on port
8000. Discrimination test passed 3/3.

**What was built today (2026-02-27):**
1. Documentation overhauled — full design context, gesture detection spec, architecture diagrams
2. Verifier URL made configurable (query param + UI input) for Mac→DGX workflow
3. Cosmos Reason 2 running locally via vLLM v0.16.0 on DGX Spark
4. Verifier nim_logic.py wired up with real Cosmos calls (NIM_ENABLED=1)
5. Discrimination test: 3/3 correct (intentional swipe approved, head scratch rejected,
   conversation wave rejected); all schema-valid
6. Latency measured: 5.8–8.4s per call — too slow for live gating; shifted to async
   verification architecture; documented in data/cosmos_latency_tests.md
7. Gesture detection implemented: 4 gesture state machines with confidence scoring
   and global cooldown (docs/GESTURE_DETECTION.md spec followed exactly)
8. Ring buffer: 30-frame circular buffer; exports 8-frame evidence windows as base64 JPEGs
9. Async verification pipeline: execute immediately, verify in background, log
   cosmos_disagrees when Cosmos result arrives (~7s later)

**Next priorities:**
1. Test gesture detection in browser — verify thresholds feel right, tune if needed
2. Network check — confirm DGX Spark is reachable from Mac for weekend development
3. Keep vLLM server and verifier running on Spark for remote access
4. Tune gesture thresholds on Mac over the weekend
5. Build Option 2 teacher-student training pipeline from JSONL logs

---

## Build checklist

### Done — scaffold
- [x] Web app: MediaPipe Hands running in browser, canvas overlay, Safe Mode toggle, verifier timeout input
- [x] Event state machine: PROPOSED → VERIFYING → APPROVED → EXECUTED with merge/supersede/timeout
- [x] Verifier service (FastAPI :8788) — schema validation, JSONL logging
- [x] Executor service (FastAPI :8787) — xdotool (Linux) / osascript (macOS), JSONL logging
- [x] `shared/schema.json` — strict 7-field verifier response contract
- [x] `executor/actions.yaml` — OS key mappings (linux/macos)
- [x] Shell scripts: `run_executor.sh`, `run_verifier.sh`, `run_web.sh`
- [x] Smoke test: `scripts/smoke_test.sh`
- [x] Design docs capturing full architecture, prompt, schema, latency policy, Option 2 risks
- [x] Keyboard test stubs (keys 1–4) for triggering intents without gesture detection

### Done — Cosmos NIM integration
- [x] Cosmos Reason 2 running on DGX Spark — vLLM v0.16.0, localhost:8000
- [x] Verifier URL configurable — `?verifier=http://dgx-ip:8788` query param + UI text input
- [x] `verifier/verifier/nim_logic.py` — real Cosmos call, code fence stripping, env-configurable
- [x] NIM_ENABLED toggle — `NIM_ENABLED=1` routes to Cosmos; `NIM_ENABLED=0` uses stub (19ms)
- [x] Discrimination test passed — 3/3 correct; all schema-valid
- [x] Latency measured and documented — 5.8–8.4s; see `data/cosmos_latency_tests.md`
- [x] Architecture decision made — async verification is default; Safe Mode retained for demo

### Done — gesture detection and evidence pipeline
- [x] Gesture recognition — `proposeGestureFromLandmarks()` with real state machines:
  swipe ≥30% frame width in 0.4–0.9s, palm hold ≥0.3s, palm→fist transition, 1.5s cooldown
- [x] Real local_confidence — computed from mpConf×0.25 + dispMargin×0.25 + temporal×0.20
  + stability×0.15 + handSize×0.15
- [x] Frame ring buffer — 30-frame circular buffer in `web/src/ringbuffer.js`,
  exports 8-frame evidence windows as base64 JPEGs (320×180, quality=0.7)
- [x] Real data to verifier — frames, landmark_summary_json, local_confidence all wired
- [x] Async verification pipeline — fire-and-forget background verify after execution;
  logs cosmos_disagrees for Option 2 training signal

### Post-core / nice-to-have
- [ ] Three-tier confidence routing: HIGH (≥0.85) → direct execute, MEDIUM → async verify, LOW → ignore
- [ ] Event log UI panel in the browser showing Cosmos rationale when async result arrives
- [ ] Evaluation harness for hard negatives (record clips, run Cosmos offline, produce metrics table)
- [ ] Option 2 teacher-student loop implementation — train on verifier_events.jsonl disagreements
- [ ] Demo video production (under 3 minutes)
- [ ] Final README polish for competition submission

---

## Key files

| File | Role | Status |
|------|------|--------|
| `web/src/gesture.js` | MediaPipe setup + 4 gesture state machines | **Done** |
| `web/src/ringbuffer.js` | 30-frame circular buffer, getEvidenceWindow(n) | **Done** |
| `web/src/main.js` | Event state machine, async verify, ring buffer wiring | Done |
| `web/src/api.js` | HTTP client for verifier and executor | Done |
| `web/src/overlay.js` | Canvas hand landmark drawing | Done |
| `verifier/verifier/main.py` | FastAPI /verify, schema validation, JSONL log | Done |
| `verifier/verifier/nim_logic.py` | Real Cosmos NIM call via vLLM | Done |
| `verifier/verifier/stub_logic.py` | Stub verifier (always approve/force reject) | Done |
| `verifier/verifier/schema_validate.py` | JSON Schema validation | Done |
| `executor/executor/main.py` | FastAPI /execute, xdotool/osascript, JSONL log | Done |
| `executor/actions.yaml` | OS key mappings per intent | Done |
| `shared/schema.json` | Strict verifier response schema | Done |
| `data/cosmos_latency_tests.md` | Measured latency + discrimination test results | Done |

---

## Documentation index

| Document | Purpose |
|----------|---------|
| `docs/PROJECT_CONTEXT.md` | Problem statement, solution thesis, gestures, hard negatives, platforms, competition context |
| `docs/SYSTEM_ARCHITECTURE.md` | Components, APIs, deployment modes, async vs safe-mode decision logic |
| `docs/GESTURE_DETECTION.md` | Gesture detection algorithm spec with thresholds and state machines |
| `docs/COSMOS_PROMPT_AND_SCHEMA.md` | Cosmos prompt template, schema, API call construction, why-Cosmos framing |
| `docs/LATENCY_AND_AMBIGUOUS_POLICY.md` | Measured latency, async vs safe-mode policy, merge/supersede rules |
| `docs/OPTION2_RISKS_AND_MITIGATIONS.md` | Teacher-student loop failure modes and safeguards |
| `docs/ARCHITECTURE_DIAGRAMS.md` | ASCII diagrams for architecture, runtime flow, deployment modes |
| `docs/STATUS.md` | This file — build state, priority, session handoff |
| `data/cosmos_latency_tests.md` | Cosmos latency measurements and discrimination test results |

---

## Quick start (3 terminals on DGX Spark)

```bash
./scripts/run_executor.sh   # :8787
./scripts/run_verifier.sh   # :8788  (NIM_ENABLED=0 uses stub, 19ms)
./scripts/run_web.sh        # :5173 — open in browser
```

To use real Cosmos (vLLM must be running at localhost:8000):
```bash
NIM_ENABLED=1 COSMOS_NIM_URL=http://localhost:8000 ./scripts/run_verifier.sh
```

To restart vLLM (takes ~3 minutes to load):
```bash
docker run --rm --gpus all \
  -p 8000:8000 \
  -v ~/models/Cosmos-Reason2-8B:/model \
  -v /usr/local/cuda-13.0/bin/ptxas:/usr/local/cuda-13.0/bin/ptxas:ro \
  -e TRITON_PTXAS_PATH=/usr/local/cuda-13.0/bin/ptxas \
  vllm/vllm-openai:v0.16.0-aarch64-cu130 \
  /model --served-model-name nvidia/cosmos-reason2-8b \
  --dtype bfloat16 --max-model-len 8192 --gpu-memory-utilization 0.85
```

Test: keys `1`–`4` → OPEN_MENU / CLOSE_MENU / SWITCH_RIGHT / SWITCH_LEFT
(Safe Mode ON blocks on verifier ~7s with NIM, 19ms with stub; OFF executes directly)

```bash
# Health checks
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8788/health
curl -s http://127.0.0.1:8000/health  # vLLM

# Manual verifier test with real Cosmos
curl -s -X POST http://127.0.0.1:8788/verify \
  -H 'Content-Type: application/json' \
  -d '{"event_id":"test","proposed_intent":"SWITCH_RIGHT","local_confidence":0.73}'
```

## Gesture detection console output

When a gesture fires, the browser console shows two log entries:

```
[gesture] SWITCH_RIGHT | conf: 0.73 | side: Right | disp: 0.34 | dur: 0.6s

{event_id: "…", proposed_intent: "SWITCH_RIGHT", trigger: "gesture",
 local_confidence: 0.73, policy_path: "unsafe_direct", latency_e2e_ms: 18, …}
```

Then ~7s later (if NIM_ENABLED=1 and Safe Mode OFF):
```
{event_id: "…", cosmos_async: true, cosmos_intentional: true,
 cosmos_final_intent: "SWITCH_RIGHT", cosmos_disagrees: false,
 cosmos_reason_category: "intentional_command",
 cosmos_rationale: "The right hand moves laterally …"}
```
