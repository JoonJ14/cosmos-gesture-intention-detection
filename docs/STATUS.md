# Build Status & Session Handoff

## AI agent instructions
- **Read this file at the start of every session before doing anything else**
- **Read `docs/PROJECT_CONTEXT.md` for the full problem framing and design rationale**
- **Read `docs/GESTURE_DETECTION.md` before modifying gesture recognition**
- **Update this file only when the user explicitly asks to update the documents**

---

## Session handoff note

**Last updated**: 2026-03-01 (second session).

**Current state**: Option 2 teacher-student pipeline is fully built. All four services run. Gesture detection thresholds have been aggressively loosened for high recall. Swipe detection now uses Euclidean total displacement with a 40% lateral-component guard for direction. Feature extraction is wired into the web app. The student classifier service (Flask :8789, shadow mode by default) is live. Training script exists. The system is ready for data collection: run all four services, perform gestures + false-positive motions, and let Cosmos label events in the background. After 20+ labeled events accumulate, run `scripts/train_student.py` to train the student model.

---

## What was done this session (2026-03-01, morning)

All changes are in `web/src/gesture.js` and `web/src/index.html`.

### CSS selfie mirror
Added `transform: scaleX(-1)` to both `#video` and `#overlay` in `index.html`. User's right hand now appears on the right side of the screen (bathroom-mirror view). MediaPipe raw landmark coordinates are unaffected — all gesture math accounts for the mirrored display explicitly.

### Swipe detection redesign (pose-agnostic, any hand, mirror-correct direction)
`updateSwipe` rewritten completely:
- Detection based solely on wrist landmark (LM 0) x-displacement over time. No finger extension or palm-facing checks. Any pose can swipe.
- Either hand can trigger either direction.
- With CSS `scaleX(-1)`: raw x decreasing → screen-rightward motion → **SWITCH_LEFT**; raw x increasing → screen-leftward motion → **SWITCH_RIGHT**. (Labels were swapped once in a follow-up commit to match user mental model.)
- Per-frame `[SWIPE]` debug log: rawDisplacement, screenDir, duration.

### OPEN_MENU: fist→palm transition (3-state machine)
`updatePalm` rewritten:
- IDLE → FIST_DETECTED: hand must form a fist (≤2 fingers extended; thumb may stick out)
- FIST_DETECTED → PALM_OPENED: fist held ≥100 ms, then hand opens (≥4 fingers + palm facing)
- PALM_OPENED → emit: palm held stable ≥300 ms (wrist drift < 5% of frame width)
- Static open palm never fires without a prior fist phase.
- Per-frame debug logging in each non-IDLE state.

### CLOSE_MENU: 3-state machine with stillness and fist-hold (IDLE → OPEN_SEEN → FIST_SEEN)
`updateClose` rewritten:
- IDLE → OPEN_SEEN: open palm (≥4 fingers) seen for ≥REQUIRED_FRAMES consecutive frames
- OPEN_SEEN → FIST_SEEN: palm held still (wrist drift < 6%) for ≥300 ms, hand then closes to explicit fist (≤2 fingers) while still in frame
- FIST_SEEN → emit: fist held ≥150 ms
- Hand disappearing does NOT trigger (requires an explicit in-frame fist)
- Moving hand (reaching, phone withdrawal) resets via stillness check
- Per-frame debug logging in OPEN_SEEN and FIST_SEEN

### Mutual exclusion / priority logic
- **OPEN_MENU priority**: when OPEN_MENU is in FIST_DETECTED or PALM_OPENED (`openMenuActive = true`), CLOSE_MENU is blocked from entering OPEN_SEEN and the suppression block does not reset OPEN_MENU.
- **CLOSE_MENU suppression**: when CLOSE_MENU is in OPEN_SEEN or FIST_SEEN and OPEN_MENU is IDLE, OPEN_MENU is reset to IDLE and skipped for that frame.
- Both guards are present: inside `updateClose`'s IDLE block AND in the main dispatch loop.

### Comprehensive debug tracing
- `[GESTURE FRAME]` fires unconditionally at the very top of `proposeGestureFromLandmarks` — shows hand count every frame before any guard.
- Cooldown logs remaining ms.
- Per-hand skip reasons logged (span, frames, bad landmarks).
- Accepted hand logs all three state machine states + `closeIsTracking` + `openMenuActive`.
- First-line entry logs in `updatePalm` and `updateClose`.

### Startup latency reduction
- `REQUIRED_FRAMES`: 3 → **1** (state machines run on the very first tracked frame)
- `MIN_HAND_SPAN`: 0.05 → **0.025** (accepts hands further from camera or near frame edge)

---

## What was done post-morning (2026-03-01, second session)

### Threshold loosening for high recall (commit f64e3ac)
Aggressively loosened all state machine thresholds. Fist threshold relaxed from ≤2 to ≤3 fingers, palm from ≥4 to ≥3. CLOSE_MENU stillness check (CLOSE_PALM_MAX_DRIFT) removed entirely — moving hands now allowed through; Cosmos handles false positives. Swipe window widened. Cooldown halved.

### Option 2 teacher-student pipeline (commit 8634f9f)
Full pipeline built across 11 files:
- **Feature extraction** in `gesture.js`: `extractFeatures()` computes 12 numeric features (swipeDisplacement, swipeDuration, peakVelocity, fingersExtended, handSide, handSpan, wristX, wristY, palmFacing, wristVelocityX, wristVelocityY, stateConfidence) + one-hot gestureType. `recentWristPositions` 10-entry sliding window added for velocity features.
- **Student service** `student/service.py`: Flask on :8789. Shadow mode (always execute=true, predictions logged only) by default. Active mode (`STUDENT_MODE=active`) gates on model prediction. Hot-reloads model when file mtime changes. Endpoints: `/predict`, `/status`, `/health`.
- **Training script** `scripts/train_student.py`: reads all `verifier_events.jsonl`, filters Cosmos confidence ≥0.75 and `reason_category ≠ unknown`, requires ≥20 samples. Trains LR + RF, picks better test accuracy. Regression guard: rejects update if calibration accuracy drops >2%. Saves `models/student/current_model.joblib` + versioned backups + `training_log.json`.
- **Web app integration** (`api.js`, `main.js`, `index.html`): Student URL input (default `localhost:8789`), student status div, `callStudent()` with 500 ms timeout, student prediction logged with every event, active-mode suppression path (`student_suppressed`), graceful fallback when service unavailable.
- **JSONL logging extensions**: executor and verifier both accept and log optional `features` + `student_prediction` fields, enabling event correlation by event_id.
- **Supporting files**: `student/requirements.txt`, `scripts/run_student.sh`, `models/student/.gitkeep`.

### Diagonal swipe broadening (commit e663492)
`updateSwipe` switched from x-only displacement to Euclidean total `sqrt(dx²+dy²)`. Direction still determined by x-component sign. Added `|dx|/total ≥ 0.40` lateral guard to reject purely vertical motions. Lowered `SWIPE_MIN_DISPLACEMENT` to 0.07 and `SWIPE_MIN_DURATION` to 0.05 to capture fast snap swipes and arc motions.

---

## Current threshold values (after all loosening)

```
REQUIRED_FRAMES:        1
MIN_HAND_SPAN:          0.015    (was 0.025)
FIST_HOLD_MS:           50       (was 100)
PALM_HOLD_MS:           150      (was 300)
PALM_STABILITY:         0.05
CLOSE_MIN_MS:           150      (was 300)
CLOSE_MAX_MS:           1000
CLOSE_FIST_HOLD_MS:     75       (was 150)
CLOSE_PALM_MAX_DRIFT:   removed  (was 0.06)
SWIPE_MIN_DISPLACEMENT: 0.07     (Euclidean total; was 0.15 x-only)
SWIPE_MIN_DURATION:     0.05     (was 0.20)
SWIPE_MAX_DURATION:     2.0      (was 1.5)
COOLDOWN_MS:            800      (was 1500)
Fist threshold:         ≤3 fingers extended  (was ≤2)
Palm threshold:         ≥3 fingers extended AND palm facing camera  (was ≥4)
Swipe direction guard:  |dx|/total ≥ 0.40  (new — rejects purely vertical motions)
```

---

## What needs to happen next (in priority order)

### 1. IMMEDIATE: Verify DGX Spark Cosmos is still running
SSH to 192.168.1.250, check tmux session "cosmos", ensure vLLM is running on :8000 and verifier on :8788.

```bash
ssh user@192.168.1.250
tmux attach -t cosmos   # or: tmux ls
curl -s http://localhost:8000/health
curl -s http://localhost:8788/health
```

### 2. E2E test all four services together
Run all four services, open the web app, and verify the full pipeline:

```bash
# Four terminals from repo root:
./scripts/run_executor.sh            # :8787
NIM_ENABLED=1 COSMOS_NIM_URL=http://localhost:8000 ./scripts/run_verifier.sh   # :8788 (on DGX)
./scripts/run_student.sh             # :8789
./scripts/run_web.sh                 # :5173

# Connect from Mac:
http://localhost:5173/?verifier=http://192.168.1.250:8788&student=http://localhost:8789
```

Check browser console: `[GESTURE FRAME]`, `[SWIPE]`, `[STUDENT]`, `[VERIFY]` logs should all fire.

### 3. Accumulate labeled events for student training
Perform gestures and deliberate false-positive motions (reaching, head scratch, conversational wave, phone withdrawal) while all four services are running. Need 20+ labeled events with Cosmos confidence ≥0.75 in `verifier_events.jsonl`.

### 4. Train first student model
```bash
python scripts/train_student.py
```
Review accuracy. If acceptable, restart student service (it will hot-reload from `models/student/current_model.joblib`). Switch to active mode to test live suppression:
```bash
STUDENT_MODE=active ./scripts/run_student.sh
```

### 5. Record eval clips and run Cosmos metrics
- 20+ positives per gesture (80+ total)
- 20+ hard negatives (head scratch, reaching, conversational wave, putting phone away)
- Run through Cosmos, produce precision/recall table
- Quantitative evidence for the submission

### 6. Demo video (under 3 minutes)
- Show the problem: loose state machine firing on everything (false positives everywhere)
- Show the solution: Cosmos filtering + student model learning
- Show the metrics: precision/recall improvement
- Show the architecture: teacher-student loop

### 7. Low priority — UI overlay polish
- Show gesture state, confidence, Cosmos result in overlay
- Nice to have for the demo, not essential

---

## Architecture summary

**Four services:**
- Web app (JS, :5173): MediaPipe Hands + gesture state machines + ring buffer + evidence capture + feature extraction
- Executor (Python, :8787): OS key injection (xdotool on Linux, osascript on Mac)
- Verifier (Python, :8788): Calls Cosmos Reason 2 via vLLM on DGX Spark — async teacher/labeler
- Student (Python, :8789): Real-time execute/suppress classifier (scikit-learn, shadow mode by default)

**Hardware:**
- DGX Spark (GB10, 128 GB, Ubuntu arm64) at 192.168.1.250 — Cosmos Reason 2 via vLLM on port 8000, verifier on port 8788 in tmux session "cosmos"
- MacBook Air (Apple Silicon) — development; web app + executor + student run locally, connects to remote verifier

**Connection from Mac:** `http://localhost:5173/?verifier=http://192.168.1.250:8788&student=http://localhost:8789`

**Cosmos latency:** 5.8–8.4 s per call. Too slow for live gating. Architecture: async verification is the teacher (labels training data); student classifier is the real-time gatekeeper.

**Teacher-student phases:**
- Phase 1: 100% of proposals sent to Cosmos (blind spot detection)
- Phase 2: ≥90% agreement → ~50% random sampling to Cosmos
- Phase 3: ≥95% agreement → 10–20% spot-check to Cosmos (never 0%)

---

## Working patterns

- Claude (chat on claude.ai) = strategic partner — plans, drafts prompts, thinks through architecture
- Claude Code CLI = actual implementation on both DGX Spark and Mac
- Small fix prompts: plain paragraphs, no numbered lists (they don't copy cleanly into Claude Code)
- Big multi-fix prompts: downloadable `.md` files
- Always document milestones before context compaction

---

## Deadline

**NVIDIA Cosmos Cookoff: March 5, 2026 (4 days remaining)**

---

## Git commits this session (2026-03-01)

```
782477b fix: reduce gesture detection startup delay
7a966a2 fix: OPEN_MENU priority over CLOSE_MENU when fist->palm sequence is active
aca5c9c fix: swap swipe L/R, add debug tracing for open/close menu
3279fc2 fix: mirror display, swipe redesign (pose-agnostic + direction), loosen fist detection, tighten close_menu
e0c4148 fix: gesture detection bugs — mirror flip, fist->palm transition, mutual exclusion, threshold tuning
e152e22 docs: rewrite Option 2 design doc with teacher-student architecture
f64e3ac tune: aggressively loosen state machine thresholds for high recall — Cosmos handles precision
8634f9f feat: Option 2 teacher-student pipeline — feature extraction, student service, training script
e663492 fix: swipe uses total displacement for diagonal arcs, lower min duration for fast swipes
```

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
- [x] Design docs: full architecture, prompt, schema, latency policy, Option 2 risks
- [x] Keyboard test stubs (keys 1–4) for triggering intents without gesture detection

### Done — Cosmos NIM integration
- [x] Cosmos Reason 2 running on DGX Spark — vLLM v0.16.0, localhost:8000
- [x] Verifier URL configurable — `?verifier=http://dgx-ip:8788` query param + UI text input
- [x] `verifier/verifier/nim_logic.py` — real Cosmos call, code fence stripping, env-configurable
- [x] NIM_ENABLED toggle — `NIM_ENABLED=1` routes to Cosmos; `NIM_ENABLED=0` uses stub (19 ms)
- [x] Discrimination test passed — 3/3 correct; all schema-valid
- [x] Latency measured — 5.8–8.4 s; see `data/cosmos_latency_tests.md`
- [x] Architecture: async verification is default; Safe Mode retained for demo

### Done — gesture detection and evidence pipeline
- [x] CSS selfie mirror — `#video` and `#overlay` both `transform: scaleX(-1)`
- [x] Swipe detection — pose-agnostic, either hand, Euclidean total displacement, 40% lateral guard
- [x] OPEN_MENU — fist→palm 3-state machine (IDLE → FIST_DETECTED → PALM_OPENED)
- [x] CLOSE_MENU — 3-state machine (IDLE → OPEN_SEEN → FIST_SEEN), stillness check removed
- [x] Mutual exclusion — OPEN_MENU priority when mid-sequence; CLOSE_MENU suppresses OPEN_MENU only when it is still IDLE
- [x] Global 800 ms cooldown after any gesture fires
- [x] Real local_confidence — swipe: mpConf×0.30 + dispMargin×0.40 + temporal×0.15 + size×0.15
- [x] Frame ring buffer — 30-frame circular buffer, exports 8-frame evidence windows as base64 JPEGs
- [x] Async verification pipeline — fire-and-forget background verify; logs cosmos_disagrees
- [x] Comprehensive debug logging — [GESTURE FRAME], [SWIPE], [OPEN_MENU], [CLOSE_MENU], [COOLDOWN]
- [x] Thresholds aggressively loosened for high recall (commit f64e3ac)

### Done — Option 2 teacher-student pipeline
- [x] `extractFeatures()` in gesture.js — 12 numeric features + one-hot gestureType
- [x] `recentWristPositions` sliding window (10 entries) for velocity features
- [x] Student service (`student/service.py`) — Flask :8789, shadow/active modes, hot-reload
- [x] Training script (`scripts/train_student.py`) — LR + RF, regression guard, versioned saves
- [x] Launch script (`scripts/run_student.sh`) — venv setup + STUDENT_MODE env var
- [x] Web app integration — student URL input, callStudent() with 500 ms timeout, graceful fallback
- [x] `student_suppressed` policy path — active mode gates on student prediction
- [x] JSONL logging extensions — features + student_prediction in executor and verifier logs
- [x] Diagonal swipe broadening — Euclidean displacement, |dx|/total ≥ 0.40, SWIPE_MIN_DURATION 0.05

### In progress / next
- [ ] **Verify DGX Spark** — confirm Cosmos + verifier still running
- [ ] **E2E test** all four services together with real Cosmos
- [ ] **Accumulate 20+ labeled events** via gesture + false-positive session
- [ ] **Train first student model** and evaluate
- [ ] **Evaluation harness** — 80+ positives + 20+ hard negatives, metrics table
- [ ] **Demo video** — under 3 minutes
- [ ] UI overlay: gesture state, confidence, Cosmos result live
- [ ] Final README polish

---

## Key files

| File | Role | Status |
|------|------|--------|
| `web/src/gesture.js` | MediaPipe setup + 4 gesture state machines + feature extraction | **Updated — all thresholds loosened, diagonal swipe, extractFeatures()** |
| `web/src/index.html` | HTML + CSS including selfie mirror, student URL input | **Updated** |
| `web/src/main.js` | Event state machine, async verify, student integration | **Updated — student call, student_suppressed path** |
| `web/src/api.js` | HTTP client for verifier, executor, student | **Updated — callStudent()** |
| `web/src/ringbuffer.js` | 30-frame circular buffer, getEvidenceWindow(n) | Done |
| `web/src/overlay.js` | Canvas hand landmark drawing | Done |
| `student/service.py` | Flask :8789, shadow/active modes, hot-reload | **New** |
| `student/requirements.txt` | Flask, joblib, scikit-learn, numpy | **New** |
| `scripts/train_student.py` | Train LR+RF on Cosmos-labeled JSONL, regression guard | **New** |
| `scripts/run_student.sh` | Launch student service with venv | **New** |
| `verifier/verifier/nim_logic.py` | Real Cosmos NIM call via vLLM | Done |
| `verifier/verifier/main.py` | FastAPI /verify, JSONL log with features + student_prediction | **Updated** |
| `executor/executor/main.py` | FastAPI /execute, xdotool/osascript, JSONL log | **Updated** |
| `shared/schema.json` | Strict verifier response schema | Done |
| `data/cosmos_latency_tests.md` | Latency measurements + discrimination test results | Done |
| `docs/OPTION2_RISKS_AND_MITIGATIONS.md` | Teacher-student loop design, failure modes, safeguards | **Rewritten** |

---

## Documentation index

| Document | Purpose |
|----------|---------|
| `docs/PROJECT_CONTEXT.md` | Problem statement, solution thesis, competition framing |
| `docs/SYSTEM_ARCHITECTURE.md` | Components, APIs, deployment modes, async vs safe-mode logic |
| `docs/GESTURE_DETECTION.md` | **Current** gesture detection spec — state machines, thresholds, mirror coords, mutual exclusion |
| `docs/COSMOS_PROMPT_AND_SCHEMA.md` | Cosmos prompt template, schema, API call construction |
| `docs/LATENCY_AND_AMBIGUOUS_POLICY.md` | Measured latency, async vs safe-mode policy, merge/supersede rules |
| `docs/OPTION2_RISKS_AND_MITIGATIONS.md` | Teacher-student loop design, failure modes, safeguards |
| `docs/ARCHITECTURE_DIAGRAMS.md` | ASCII diagrams for all system flows including teacher-student loop |
| `docs/STATUS.md` | This file |
| `data/cosmos_latency_tests.md` | Cosmos latency measurements and discrimination test results |

---

## Quick start

```bash
# Four terminals from repo root (Mac):
./scripts/run_executor.sh            # :8787
./scripts/run_student.sh             # :8789  (shadow mode by default)
./scripts/run_web.sh                 # :5173

# On DGX Spark (192.168.1.250):
NIM_ENABLED=1 COSMOS_NIM_URL=http://localhost:8000 ./scripts/run_verifier.sh   # :8788
```

Test keys: `1` OPEN_MENU, `2` CLOSE_MENU, `3` SWITCH_RIGHT, `4` SWITCH_LEFT

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8788/health   # verifier (on DGX)
curl -s http://127.0.0.1:8789/health   # student
curl -s http://127.0.0.1:8000/health   # vLLM (on DGX)
```
