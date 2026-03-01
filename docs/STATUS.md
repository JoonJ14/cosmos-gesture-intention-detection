# Build Status & Session Handoff

## AI agent instructions
- **Read this file at the start of every session before doing anything else**
- **Read `docs/PROJECT_CONTEXT.md` for the full problem framing and design rationale**
- **Read `docs/GESTURE_DETECTION.md` before modifying gesture recognition**
- **Update this file only when the user explicitly asks to update the documents**

---

## Session handoff note

**Last updated**: 2026-03-01 early morning session.

**Current state**: All three services run. Gesture detection has been heavily iterated — CSS selfie mirror added, swipe redesigned as pose-agnostic, OPEN_MENU requires fist→palm transition, CLOSE_MENU is a 3-state machine with stillness check, mutual exclusion / priority logic implemented, startup latency reduced. Comprehensive debug logging is wired throughout. Thresholds are working but intentionally not yet maximally loose — the **next** step is to deliberately loosen them to drive high recall and feed Cosmos with more proposals.

---

## What was done this session (2026-03-01)

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

## Current threshold values (post-session, before next loosening pass)

```
REQUIRED_FRAMES:        1        (was 3)
MIN_HAND_SPAN:          0.025    (was 0.05)
FIST_HOLD_MS:           100
PALM_HOLD_MS:           300
PALM_STABILITY:         0.05
CLOSE_MIN_MS:           300
CLOSE_MAX_MS:           1000
CLOSE_FIST_HOLD_MS:     150
CLOSE_PALM_MAX_DRIFT:   0.06
SWIPE_MIN_DISPLACEMENT: 0.15
SWIPE_MIN_DURATION:     0.20
SWIPE_MAX_DURATION:     1.5
COOLDOWN_MS:            1500
Fist threshold:         ≤2 fingers extended
Palm threshold:         ≥4 fingers extended AND palm facing camera
```

---

## What needs to happen next (in priority order)

### 1. IMMEDIATE: Loosen state machine for high recall

**Strategic decision**: intentionally make the state machine trigger-happy (high recall, low precision). This is necessary to justify Cosmos's role as the precision/filtering layer. A tight state machine that rarely fires leaves Cosmos with nothing to do.

Target threshold changes:
```
FIST_HOLD_MS:           100  →  50
PALM_HOLD_MS:           300  →  150
CLOSE_MIN_MS:           300  →  150
CLOSE_FIST_HOLD_MS:     150  →  75
SWIPE_MIN_DISPLACEMENT: 0.15 →  0.10
SWIPE_MIN_DURATION:     0.20 →  0.15
SWIPE_MAX_DURATION:     1.5  →  2.0
MIN_HAND_SPAN:          0.025 → 0.015
COOLDOWN_MS:            1500 →  800
Fist detection:         ≤2   →  ≤3 fingers
Palm detection:         ≥4   →  ≥3 fingers
Remove CLOSE_MENU stillness check (CLOSE_PALM_MAX_DRIFT) entirely
```

A prompt for this may be in `loosen-state-machine.md` in downloads or `/mnt/user-data/outputs/`.

### 2. Build Option 2 teacher-student pipeline (CRITICAL PATH)

Option 2 is the core deliverable, not a stretch goal. Architecture:
- Loose state machine fires proposals (high recall, low precision)
- Lightweight local **student classifier** (scikit-learn logistic regression or small random forest) decides execute/suppress in real time using features extracted from MediaPipe landmarks (trajectory, finger extension history, wrist velocity, hand size/position)
- Evidence frames go to Cosmos async at 100% send rate during Phase 1
- Cosmos returns intent label, logged as training data in JSONL
- Student periodically retrains on accumulated Cosmos labels
- **Phase 1**: 100% to Cosmos. **Phase 2**: ≥90% agreement → ~50% random sampling. **Phase 3**: ≥95% → 10–20% spot-check
- Always send some % to Cosmos (never 0%) to prevent teacher bias propagation and student blind spots

See `docs/OPTION2_RISKS_AND_MITIGATIONS.md` for full design, failure modes, and safeguards.

### 3. Record eval clips and run Cosmos metrics
- 20+ positives per gesture (80+ total)
- 20+ hard negatives (head scratch, reaching, conversational wave, putting phone away)
- Run through Cosmos, produce precision/recall table
- Quantitative evidence for the submission

### 4. Demo video (under 3 minutes)
- Show the problem: loose state machine firing on everything (false positives everywhere)
- Show the solution: Cosmos filtering + student model learning
- Show the metrics: precision/recall improvement
- Show the architecture: teacher-student loop

### 5. Low priority — UI overlay polish
- Show gesture state, confidence, Cosmos result in overlay
- Nice to have for the demo, not essential

---

## Architecture summary

**Three services:**
- Web app (JS, :5173): MediaPipe Hands + gesture state machines + ring buffer + evidence capture
- Executor (Python, :8787): OS key injection (xdotool on Linux, osascript on Mac)
- Verifier (Python, :8788): Calls Cosmos Reason 2 via vLLM on DGX Spark

**Hardware:**
- DGX Spark (GB10, 128 GB, Ubuntu arm64) at 192.168.1.250 — Cosmos Reason 2 via vLLM on port 8000, verifier on port 8788 in tmux session "cosmos"
- MacBook Air (Apple Silicon) — development; web app + executor run locally, connects to remote verifier

**Connection from Mac:** `http://localhost:5173/?verifier=http://192.168.1.250:8788`

**Cosmos latency:** 5.8–8.4 s per call. Too slow for live gating. Architecture shifted to async verification, then to teacher-student loop (Option 2).

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
- [x] Swipe detection — pose-agnostic, either hand, mirror-correct direction mapping
- [x] OPEN_MENU — fist→palm 3-state machine (IDLE → FIST_DETECTED → PALM_OPENED)
- [x] CLOSE_MENU — 3-state machine (IDLE → OPEN_SEEN → FIST_SEEN) with stillness check
- [x] Mutual exclusion — OPEN_MENU priority when mid-sequence; CLOSE_MENU suppresses OPEN_MENU only when it is still IDLE
- [x] Global 1.5 s cooldown after any gesture fires
- [x] Real local_confidence — swipe: mpConf×0.30 + dispMargin×0.40 + temporal×0.15 + size×0.15
- [x] Frame ring buffer — 30-frame circular buffer, exports 8-frame evidence windows as base64 JPEGs
- [x] Async verification pipeline — fire-and-forget background verify; logs cosmos_disagrees
- [x] Comprehensive debug logging — [GESTURE FRAME], [SWIPE], [OPEN_MENU], [CLOSE_MENU], [COOLDOWN]

### In progress / next
- [ ] **Loosen thresholds** for high-recall mode (see target values above)
- [ ] **Option 2 teacher-student pipeline** — student classifier, JSONL training loop, Cosmos sampling phases
- [ ] **Evaluation harness** — 80+ positives + 20+ hard negatives, metrics table
- [ ] **Demo video** — under 3 minutes
- [ ] Three-tier confidence routing: HIGH ≥0.85 direct, MEDIUM → async verify, LOW → ignore
- [ ] UI overlay: gesture state, confidence, Cosmos result live
- [ ] Final README polish

---

## Key files

| File | Role | Status |
|------|------|--------|
| `web/src/gesture.js` | MediaPipe setup + 4 gesture state machines | **Active — iterated heavily this session** |
| `web/src/index.html` | HTML + CSS including selfie mirror | **Updated this session** |
| `web/src/ringbuffer.js` | 30-frame circular buffer, getEvidenceWindow(n) | Done |
| `web/src/main.js` | Event state machine, async verify, ring buffer wiring | Done |
| `web/src/api.js` | HTTP client for verifier and executor | Done |
| `web/src/overlay.js` | Canvas hand landmark drawing | Done |
| `verifier/verifier/nim_logic.py` | Real Cosmos NIM call via vLLM | Done |
| `executor/executor/main.py` | FastAPI /execute, xdotool/osascript, JSONL log | Done |
| `shared/schema.json` | Strict verifier response schema | Done |
| `data/cosmos_latency_tests.md` | Latency measurements + discrimination test results | Done |

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
| `docs/ARCHITECTURE_DIAGRAMS.md` | ASCII diagrams for all system flows |
| `docs/STATUS.md` | This file |
| `data/cosmos_latency_tests.md` | Cosmos latency measurements and discrimination test results |

---

## Quick start

```bash
# Three terminals from repo root:
./scripts/run_executor.sh   # :8787
./scripts/run_verifier.sh   # :8788  (NIM_ENABLED=0 → stub 19 ms)
./scripts/run_web.sh        # :5173

# With real Cosmos (vLLM must be running at localhost:8000):
NIM_ENABLED=1 COSMOS_NIM_URL=http://localhost:8000 ./scripts/run_verifier.sh
```

Test keys: `1` OPEN_MENU, `2` CLOSE_MENU, `3` SWITCH_RIGHT, `4` SWITCH_LEFT

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8788/health
curl -s http://127.0.0.1:8000/health   # vLLM
```
