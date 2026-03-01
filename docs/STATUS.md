# Build Status & Session Handoff

## AI agent instructions
- **Read this file at the start of every session before doing anything else**
- **Read `docs/PROJECT_CONTEXT.md` for the full problem framing and design rationale**
- **Read `docs/GESTURE_DETECTION.md` before modifying gesture recognition**
- **Update this file only when the user explicitly asks to update the documents**

---

## Session handoff note

**Last updated**: 2026-03-01 (end of day — full build complete).

**Current state**: Everything is built. The full teacher-student pipeline exists end-to-end: gesture detection fires proposals → student classifies in real time → Cosmos labels async → training script retrains student. Eval recording infrastructure is live in the web app (R key opens panel, Space bar cycles READY→RECORDING→CAPTURED, A key auto-captures). Standalone clip review viewer at `web/review.html`. All swipe false-positive fixes are in (x-displacement gate, vertical motion origin reset, suppression narrowed to PALM_OPENED/FIST_SEEN, cooldown 1200ms).

**Blocker**: DGX Spark at 192.168.1.250 was unreachable tonight — needs physical access to wake it up. Nothing else is blocking. All Mac-side services are ready to run.

**Tomorrow's exact plan** (priority order — see section below).

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

## What was done this session (2026-03-01, afternoon/evening)

### Threshold loosening for high recall (commit f64e3ac)
Aggressively loosened all state machine thresholds. Fist threshold relaxed from ≤2 to ≤3 fingers, palm from ≥4 to ≥3. CLOSE_MENU stillness check (CLOSE_PALM_MAX_DRIFT) removed entirely — moving hands now allowed through; Cosmos handles false positives. Swipe window widened. Cooldown halved to 800ms.

### Option 2 teacher-student pipeline (commit 8634f9f)
Full pipeline built across 11 files:
- **Feature extraction** in `gesture.js`: `extractFeatures()` computes 12 numeric features (swipeDisplacement, swipeDuration, peakVelocity, fingersExtended, handSide, handSpan, wristX, wristY, palmFacing, wristVelocityX, wristVelocityY, stateConfidence) + one-hot gestureType. `recentWristPositions` 10-entry sliding window added for velocity features.
- **Student service** `student/service.py`: Flask on :8789. Shadow mode (always execute=true, predictions logged only) by default. Active mode (`STUDENT_MODE=active`) gates on model prediction. Hot-reloads model when file mtime changes. Endpoints: `/predict`, `/status`, `/health`.
- **Training script** `scripts/train_student.py`: reads all `verifier_events.jsonl`, filters Cosmos confidence ≥0.75 and `reason_category ≠ unknown`, requires ≥20 samples. Trains LR + RF, picks better test accuracy. Regression guard: rejects update if calibration accuracy drops >2%. Saves `models/student/current_model.joblib` + versioned backups + `training_log.json`.
- **Web app integration** (`api.js`, `main.js`, `index.html`): Student URL input (default `localhost:8789`), student status div, `callStudent()` with 500 ms timeout, student prediction logged with every event, active-mode suppression path (`student_suppressed`), graceful fallback when service unavailable.
- **JSONL logging extensions**: executor and verifier both accept and log optional `features` + `student_prediction` fields, enabling event correlation by event_id.
- **Supporting files**: `student/requirements.txt`, `scripts/run_student.sh`, `models/student/.gitkeep`.

### Swipe false-positive fixes (commits b93d025, 20deb25, 11bace0, b5a9a08, fac412f, 6222965)
A series of targeted fixes to prevent false swipe triggers:
- **Min x-displacement gate** (`SWIPE_MIN_X_DISPLACEMENT = 0.05`): total displacement can be large from a diagonal raise, but the absolute x-component must reach 5% of frame width independently.
- **Vertical motion origin reset**: on every TRACKING frame, if `|frameDy| > |frameDx|` and frame displacement > 0.005 noise floor, reset `startX/startY/startTs` to current position. Prevents raising the hand from accumulating displacement — the origin slides forward until lateral motion begins, then locks. Replaces the y-zone spatial gate (removed).
- **Swipe suppression narrowed**: only suppress swipe during `PALM_OPENED` or `FIST_SEEN` (the brief physical hold windows). `FIST_DETECTED` alone no longer suppresses — the loosened ≤3 finger threshold meant almost every hand pose entered FIST_DETECTED, which blocked all swipes.
- **Cooldown increased to 1200ms**: 800ms was too short; the natural return motion after a swipe was re-triggering the opposite direction.

### Eval recording infrastructure (commits 5592bc2, f97329d)
Full data collection tooling built into the web app:
- **`web/src/recorder.js`**: pure logic module. Space bar cycles READY → RECORDING → CAPTURED. `advanceRecordingState()` manages the cycle. Auto-capture (`A` key) is a side-channel that immediately labels gestures as `TP_{INTENT}` without touching the Space cycle.
- **Recording state visual feedback**: `#recOverlay` div inside the video shell with a white dot (READY) or red pulsing dot (RECORDING) + timer counting up every 100ms via `setInterval`. CSS `@keyframes rec-pulse` scales 1.0→1.3.
- **Clip playback preview**: on CAPTURED state, `#clipPreviewArea` shows a 160×90 looping animation at 10fps using `setInterval`. Frame counter shown. Discard button throws away the clip and returns to READY.
- **Label buttons** (TP_OPEN_MENU, TP_CLOSE_MENU, TP_SWITCH_RIGHT, TP_SWITCH_LEFT, NEG_HEAD_SCRATCH, NEG_REACH, NEG_WAVE, NEG_PHONE, NEG_STRETCH, NEG_OTHER) are only enabled in CAPTURED state.
- **Save Session**: downloads all committed clips as `eval_session_{ts}.json` via Blob URL.
- **Eval scripts**: `scripts/eval_cosmos.py` batch-sends clips to verifier and prints precision/recall/F1 + confusion matrix. `scripts/build_calibration.py` selects agreed clips as calibration set for train_student.py regression checks.

### Standalone clip review viewer (commit 7a1e0d1)
`web/review.html` — single self-contained file, no build step, opens directly in browser via `file://`.
- Drag-drop or Browse to load any `eval_session_*.json`
- Left panel: scrollable clip list, green label for TP, amber for NEG, timestamp, detected gesture, confidence, frame count; summary counts header
- Right panel: 480×270 looping playback at 10fps + metadata table
- Keyboard: `Space` pause/play, `↑`/`k` and `↓`/`j` navigate clips

---

## Current threshold values (final for this session)

```
REQUIRED_FRAMES:           1
MIN_HAND_SPAN:             0.015    (was 0.025)
FIST_HOLD_MS:              50       (was 100)
PALM_HOLD_MS:              150      (was 300)
PALM_STABILITY:            0.05
CLOSE_MIN_MS:              150      (was 300)
CLOSE_MAX_MS:              1000
CLOSE_FIST_HOLD_MS:        75       (was 150)
CLOSE_PALM_MAX_DRIFT:      removed  (was 0.06)
SWIPE_MIN_DISPLACEMENT:    0.07     (Euclidean total; was 0.15 x-only)
SWIPE_MIN_X_DISPLACEMENT:  0.05     (new — absolute x-displacement gate)
SWIPE_MIN_DURATION:        0.05     (was 0.20)
SWIPE_MAX_DURATION:        2.0      (was 1.5)
COOLDOWN_MS:               1200     (was 800 earlier today, 1500 originally)
Fist threshold:            ≤3 fingers extended  (was ≤2)
Palm threshold:            ≥3 fingers extended AND palm facing camera  (was ≥4)
Swipe direction guard:     |dx|/total ≥ 0.40  (rejects purely vertical motions)
Swipe origin reset:        resets startX/Y on vertical frame-to-frame motion > 0.005
Swipe suppression:         only during PALM_OPENED or FIST_SEEN (not all of openMenuActive)
```

---

## Tomorrow's plan (2026-03-02) — priority order

### 1. Wake DGX Spark and verify Cosmos
Physical access needed. Power on, then:
```bash
ssh user@192.168.1.250
tmux attach -t cosmos       # check if vLLM still running
curl -s http://localhost:8000/health
curl -s http://localhost:8788/health
# If vLLM died: restart with run_verifier.sh on DGX
NIM_ENABLED=1 COSMOS_NIM_URL=http://localhost:8000 ./scripts/run_verifier.sh
```

### 2. Run all four services and record eval clips

```bash
# Mac terminals:
./scripts/run_executor.sh            # :8787
./scripts/run_student.sh             # :8789
./scripts/run_web.sh                 # :5173
# Open: http://localhost:5173/?verifier=http://192.168.1.250:8788&student=http://localhost:8789
```

Recording workflow:
- Press `R` to open recording panel
- Press `A` to enable auto-capture — then perform each gesture 20+ times (OPEN_MENU, CLOSE_MENU, SWITCH_RIGHT, SWITCH_LEFT). Clips auto-save labeled as TP_{INTENT}.
- Turn off auto-capture (`A` again), then manually record hard negatives: head scratch, reaching for object, conversational wave, pulling out phone, stretching. Press `Space` to start recording, `Space` again to capture, click NEG label.
- Target: 80+ true positives (20+ per gesture), 20+ hard negatives
- Press `Save Session` → downloads `eval_session_{ts}.json`

### 3. Run Cosmos eval on recorded clips
```bash
python scripts/eval_cosmos.py --verifier http://192.168.1.250:8788 --clips eval_session_{ts}.json
```
This prints precision/recall/F1 table and confusion matrix. Save this output — it's the metrics table for the submission.

### 4. Build calibration set
```bash
python scripts/build_calibration.py
```
Writes `data/calibration/calibration.jsonl` — agreed (user+Cosmos) labeled clips. Used by train_student.py regression checks.

### 5. Train first student model
```bash
python scripts/train_student.py
```
Review printed accuracy. If ≥0.75, student model is useful. Then test in shadow mode first:
```bash
STUDENT_MODE=shadow ./scripts/run_student.sh
# Perform gestures and check console for [STUDENT] EXECUTE/SUPPRESS logs
# Compare student predictions to what Cosmos says in verifier_events.jsonl
```
If shadow mode looks reasonable, switch to active:
```bash
STUDENT_MODE=active ./scripts/run_student.sh
```

### 6. Demo video (if time permits)
Under 3 minutes:
1. Show loose state machine firing on false positives (screen recording, console visible)
2. Show Cosmos correctly rejecting them (safe mode, show reasoning text)
3. Show student model learning to suppress inline (active mode)
4. Show the teacher-student loop architecture diagram
5. Show precision/recall numbers before and after student

---

## Architecture summary

**Four services:**
- Web app (JS, :5173): MediaPipe Hands + gesture state machines + ring buffer + feature extraction + eval recording UI
- Executor (Python, :8787): OS key injection (xdotool on Linux, osascript on Mac)
- Verifier (Python, :8788): Calls Cosmos Reason 2 via vLLM on DGX Spark — async teacher/labeler
- Student (Python, :8789): Real-time execute/suppress classifier (scikit-learn, shadow mode by default)

**Hardware:**
- DGX Spark (GB10, 128 GB, Ubuntu arm64) at 192.168.1.250 — Cosmos Reason 2 via vLLM on port 8000, verifier on port 8788 in tmux session "cosmos". **Currently unreachable — needs physical wake.**
- MacBook Air (Apple Silicon) — web app + executor + student run locally, connects to remote verifier

**Connection from Mac:** `http://localhost:5173/?verifier=http://192.168.1.250:8788&student=http://localhost:8789`

**Cosmos latency:** 5.8–8.4 s per call. Architecture: async verification is the teacher (labels training data); student classifier is the real-time gatekeeper.

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
e0c4148  fix: gesture detection bugs — mirror flip, fist->palm transition, mutual exclusion, threshold tuning
3279fc2  fix: mirror display, swipe redesign (pose-agnostic + direction), loosen fist detection, tighten close_menu
aca5c9c  fix: swap swipe L/R, add debug tracing for open/close menu
7a966a2  fix: OPEN_MENU priority over CLOSE_MENU when fist->palm sequence is active
782477b  fix: reduce gesture detection startup delay
e152e22  docs: rewrite Option 2 design doc with teacher-student architecture
f64e3ac  tune: aggressively loosen state machine thresholds for high recall
8634f9f  feat: Option 2 teacher-student pipeline — feature extraction, student service, training script
e663492  fix: swipe uses total displacement for diagonal arcs, lower min duration for fast swipes
c3d2f5a  docs: update STATUS.md with Option 2 build progress
b93d025  fix: require minimum x-displacement to prevent swipe on hand raise
20deb25  fix: suppress swipe detection during active open/close menu sequences
11bace0  fix: narrow swipe suppression to only active palm/fist hold phases
b5a9a08  fix: spatial gate for swipe tracking, narrow swipe suppression
fac412f  fix: reset swipe origin during vertical motion instead of spatial gate
6222965  fix: increase cooldown to 1200ms
5592bc2  feat: eval clip recording mode with auto-capture, cosmos eval script, calibration builder
f97329d  feat: recording state cycle with visual feedback, clip playback preview, discard button
7a1e0d1  feat: standalone clip review viewer
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
- [x] Mutual exclusion — OPEN_MENU priority when mid-sequence; CLOSE_MENU suppresses OPEN_MENU only when IDLE
- [x] Global 1200ms cooldown after any gesture fires
- [x] Real local_confidence — swipe: mpConf×0.30 + dispMargin×0.40 + temporal×0.15 + size×0.15
- [x] Frame ring buffer — 30-frame circular buffer, exports 8-frame evidence windows as base64 JPEGs
- [x] Async verification pipeline — fire-and-forget background verify; logs cosmos_disagrees
- [x] Comprehensive debug logging — [GESTURE FRAME], [SWIPE], [OPEN_MENU], [CLOSE_MENU], [COOLDOWN]
- [x] Thresholds aggressively loosened for high recall
- [x] Swipe false-positive fixes: x-displacement gate, vertical origin reset, suppression narrowed, cooldown 1200ms

### Done — Option 2 teacher-student pipeline
- [x] `extractFeatures()` in gesture.js — 12 numeric features + one-hot gestureType
- [x] `recentWristPositions` sliding window (10 entries) for velocity features
- [x] Student service (`student/service.py`) — Flask :8789, shadow/active modes, hot-reload
- [x] Training script (`scripts/train_student.py`) — LR + RF, regression guard, versioned saves
- [x] Launch script (`scripts/run_student.sh`) — venv setup + STUDENT_MODE env var
- [x] Web app integration — student URL input, callStudent() with 500ms timeout, graceful fallback
- [x] `student_suppressed` policy path — active mode gates on student prediction
- [x] JSONL logging extensions — features + student_prediction in executor and verifier logs

### Done — eval and data collection
- [x] `web/src/recorder.js` — Space bar READY→RECORDING→CAPTURED cycle, auto-capture A key
- [x] Recording overlay — red pulsing dot + timer during RECORDING, white dot in READY
- [x] Clip playback preview — 160×90 looping 10fps in CAPTURED state
- [x] Label buttons (TP × 4, NEG × 6) enabled only in CAPTURED state, Discard button
- [x] Session download — Blob URL JSON export
- [x] `scripts/eval_cosmos.py` — batch verifier calls, precision/recall/F1, confusion matrix
- [x] `scripts/build_calibration.py` — agreed clips → calibration.jsonl for regression checks
- [x] `web/review.html` — standalone drag-drop clip viewer, 10fps playback, keyboard nav

### Remaining (tomorrow)
- [ ] **Wake DGX Spark** — physical access, verify Cosmos + verifier running
- [ ] **Record eval clips** — 80+ TPs via auto-capture, 20+ NEGs via manual recording
- [ ] **Run eval_cosmos.py** — get precision/recall table for submission
- [ ] **Run build_calibration.py** — freeze calibration set
- [ ] **Train first student model** — run train_student.py, evaluate
- [ ] **Shadow mode validation** — compare student predictions vs Cosmos labels
- [ ] **Demo video** — under 3 minutes if time permits
- [ ] Final README polish

---

## Key files

| File | Role | Status |
|------|------|--------|
| `web/src/gesture.js` | MediaPipe setup + 4 gesture state machines + feature extraction | Done — all fixes applied |
| `web/src/index.html` | HTML + CSS — mirror, recording panel, overlay | Done |
| `web/src/main.js` | Event state machine, async verify, student + recorder integration | Done |
| `web/src/api.js` | HTTP client for verifier, executor, student | Done |
| `web/src/recorder.js` | Eval clip recording — Space cycle, auto-capture, preview, save | Done |
| `web/src/ringbuffer.js` | 30-frame circular buffer, getEvidenceWindow(n) | Done |
| `web/src/overlay.js` | Canvas hand landmark drawing | Done |
| `web/review.html` | Standalone clip review viewer (drag-drop, 10fps playback) | Done |
| `student/service.py` | Flask :8789, shadow/active modes, hot-reload | Done |
| `student/requirements.txt` | Flask, joblib, scikit-learn, numpy | Done |
| `scripts/train_student.py` | Train LR+RF on Cosmos-labeled JSONL, regression guard | Done |
| `scripts/run_student.sh` | Launch student service with venv | Done |
| `scripts/eval_cosmos.py` | Batch Cosmos eval — precision/recall/F1, confusion matrix | Done |
| `scripts/build_calibration.py` | Agreed clips → calibration.jsonl | Done |
| `verifier/verifier/nim_logic.py` | Real Cosmos NIM call via vLLM | Done |
| `verifier/verifier/main.py` | FastAPI /verify, JSONL log with features + student_prediction | Done |
| `executor/executor/main.py` | FastAPI /execute, xdotool/osascript, JSONL log | Done |
| `shared/schema.json` | Strict verifier response schema | Done |
| `docs/OPTION2_RISKS_AND_MITIGATIONS.md` | Teacher-student loop design, failure modes, safeguards | Done |

---

## Documentation index

| Document | Purpose |
|----------|---------|
| `docs/PROJECT_CONTEXT.md` | Problem statement, solution thesis, competition framing |
| `docs/SYSTEM_ARCHITECTURE.md` | Components, APIs, deployment modes, async vs safe-mode logic |
| `docs/GESTURE_DETECTION.md` | Gesture detection spec — state machines, thresholds, mirror coords, mutual exclusion |
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

# Open in browser:
http://localhost:5173/?verifier=http://192.168.1.250:8788&student=http://localhost:8789
```

Test keys: `1` OPEN_MENU, `2` CLOSE_MENU, `3` SWITCH_RIGHT, `4` SWITCH_LEFT

Recording: `R` open panel → `A` auto-capture → perform gestures → `Save Session` → download JSON → `python scripts/eval_cosmos.py --clips eval_session_{ts}.json`

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8788/health   # verifier (on DGX)
curl -s http://127.0.0.1:8789/health   # student
curl -s http://127.0.0.1:8000/health   # vLLM (on DGX)
```
