# Cosmos Gesture Agent

**A real-time webcam gesture agent with VLM-based intent verification — solving the false positive problem in continuous spatial tracking.**

> NVIDIA Cosmos Cookoff 2026 Submission

## The Problem

Gesture-based computer interaction has a fundamental unsolved problem: **false positives from incidental motion.**

On a touchscreen, physical contact IS the intent signal. But in webcam-based spatial tracking, the system watches your hands continuously — and a head scratch looks identical to a swipe, a conversational wave triggers workspace switches, reaching for your coffee fires a pull gesture.

Traditional approaches attack this with geometric constraints: velocity thresholds, activation zones, displacement guards, cooldown timers. These help incrementally, but hit a ceiling because **many intentional commands and incidental motions are kinematically identical.** A deliberate swipe and a conversational hand wave have the same trajectory and velocity profile. The difference isn't in the motion — it's in the *context and intent* behind it.

## The Solution: Cosmos Reason 2 as Intent Verifier

Instead of engineering increasingly complex geometric rules, we use **NVIDIA Cosmos Reason 2** — a vision-language model — to reason about whether a detected gesture was intentional.

The architecture follows the **Event Reviewer pattern:**

1. **Fast local perception** — MediaPipe Hands in the browser detects hand landmarks at 30+ fps and classifies gesture candidates using a state machine
2. **Intelligent verification** — Ambiguous cases are sent to Cosmos Reason 2 with a short evidence clip (~8–12 frames). Cosmos sees the full visual context: body posture, gaze direction, scene, whether the motion is purposeful or casual
3. **Action execution** — Only verified intentional commands trigger OS actions (workspace switching, Mission Control)

Cosmos earns its role by solving what heuristics fundamentally cannot: distinguishing a deliberate lateral swipe from someone scratching their head, catching a fly, or waving during conversation.

## Architecture

```
┌───────────────────────────────────────────────┐
│               Web App (JS, :5173)             │
│  MediaPipe Hands · Gesture state machine      │
│  Ring buffer · Confidence scoring · Overlay   │
└──────────────┬────────────────────────────────┘
               │
     ┌─────────┴──────────┐
     │                    │
     v                    v
┌──────────────┐   ┌───────────────────────┐
│ Executor     │   │ Cosmos Verifier       │
│ (PY, :8787)  │   │ (PY, :8788)           │
│ xdotool /    │   │ Calls Cosmos Reason 2 │
│ osascript    │   │ NIM on DGX Spark      │
└──────────────┘   └───────────────────────┘
```

**Decision flow:** High-confidence gestures execute directly. Ambiguous cases go to Cosmos first. Low-confidence signals are ignored. See [Architecture Diagrams](docs/ARCHITECTURE_DIAGRAMS.md) for full details.

## Gestures

| Intent | Gesture | Action (Linux / macOS) |
|--------|---------|------------------------|
| `OPEN_MENU` | Make a fist, then open palm (≥4 fingers spread, held ~0.3 s) | Super key / Ctrl+Up (Mission Control) |
| `CLOSE_MENU` | Hold open palm still ~0.3 s, then close to fist and hold ~0.15 s | Escape |
| `SWITCH_RIGHT` | Either hand sweeps leftward across the mirrored screen | Ctrl+Right / Ctrl+Right |
| `SWITCH_LEFT` | Either hand sweeps rightward across the mirrored screen | Ctrl+Left / Ctrl+Left |

**Notes:**
- The webcam is displayed in selfie/mirror mode — your right hand appears on the right side of the screen.
- Swipes are **pose-agnostic**: open palm, edge of hand, loose fist all work equally. Either hand can trigger either direction.
- OPEN_MENU requires a deliberate fist→palm transition to avoid accidental triggers from resting an open hand.

## Why Cosmos Is Necessary (Not Optional)

We demonstrate Cosmos's value with **8 hard negative scenarios** — motions that a landmark-based detector proposes as gestures, but Cosmos correctly rejects:

| Category | Scenario | Why heuristics fail |
|----------|----------|---------------------|
| Self-grooming | Scratch head, scratch nose, rub eye | Same hand trajectory as a swipe |
| Reaching | Wipe monitor, reach to side, catch a fly | Same displacement and velocity |
| Conversation | Wave while talking, receive item from someone | Same hand shape and motion |

**Key metric:** False positive rate on hard negatives — baseline (local only) vs. with Cosmos verification.

Beyond accuracy, Cosmos also delivers **dramatically faster iteration cycles** than traditional ML — a prompt change can be validated in minutes rather than after hours of retraining. See [Rapid Iteration via Prompt Engineering](#rapid-iteration-via-prompt-engineering) below.

## Rapid Iteration via Prompt Engineering

One of Cosmos's most valuable properties isn't just accuracy — it's **iteration speed.** When something goes wrong with a traditional ML classifier, you retrain. With Cosmos, you edit English text. Here's how that played out during development.

### From Near-Zero to 100% TP Recall in 5 Minutes

We evaluated Cosmos against **151 labeled clips** (70 true positives + 81 hard negatives). Our initial prompt was rejection-biased — it listed every motion to reject but never described what an intentional gesture actually looks like. Result: Cosmos rejected nearly everything, including real intentional gestures. **TP recall was ~15%.**

The fix took under 5 minutes: rewrite the system prompt to add gesture descriptions, signs of intentional intent, and a balanced decision guideline. Zero retraining. Zero data pipeline changes. **TP recall went from ~15% to 100%.**

### Five Iterations, ~25 Minutes Total

| Iteration | Change | TP Recall | NEG Rejection | Notes |
|-----------|--------|-----------|---------------|-------|
| 1 | Original prompt (rejection-biased) | ~15% | ~95% | Stopped early — too aggressive |
| 2 | Balanced prompt + gesture descriptions | **100%** | 71.6% | Fixed in < 5 min |
| 3 | + Gaze direction + yawning awareness | **100%** | 77.8% | Incremental improvement |
| 4 | + Reach-specific lateral motion guidance | 98.6% ⚠️ | 80.2% | TP regression discovered |
| 5 | Reverted broad language, kept targeted reach | **100%** | 79.0% | Best with 100% TP recall |

### The Tradeoff Discovery

Iteration 4 revealed a critical precision-recall tradeoff: tightening rejection criteria for reaching motions directly risks rejecting real swipe gestures, because the two motions are **kinematically identical.** We made a principled decision to prioritize TP recall over marginal FP improvement — a missed intentional gesture breaks user trust ("the system doesn't work"), while an occasional false positive is merely annoying. We reverted the harmful language in Iteration 5, restoring 100% TP recall while keeping most of the gains.

This kind of rapid experimentation, discovery, and rollback is only possible with VLM-based verification. With traditional ML, each cycle would require hours of retraining.

### The Hardest Category

Reaching for nearby objects remains at 0% rejection — lateral hand displacement during a reach is kinematically indistinguishable from a real swipe in sampled frames. This is the genuine frontier challenge, and it validates the need for the teacher-student feedback loop: even a VLM needs ongoing context beyond static frames.

### Scalability: Prompt Engineering vs. Retraining

| Scenario | Traditional ML | VLM (Cosmos) |
|----------|---------------|--------------|
| Fix bad classification | Retrain (hours/days) | Edit prompt (minutes) |
| Add new gesture | Collect data + retrain | Add text description |
| Add false positive category | Collect negatives + retrain | Add sentence to prompt |
| Discover tradeoffs | Multiple retrain cycles | Run eval, compare, revert in minutes |

For detailed per-iteration metrics and category breakdowns, see [`docs/COSMOS_PERFORMANCE_TRACKING.md`](docs/COSMOS_PERFORMANCE_TRACKING.md) and [`docs/PROMPT_ENGINEERING_LOG.md`](docs/PROMPT_ENGINEERING_LOG.md).

## Quick Start

Three terminals from repo root:

```bash
./scripts/run_executor.sh   # Port 8787 — OS key injection
./scripts/run_verifier.sh   # Port 8788 — Cosmos verification (stub for now)
./scripts/run_web.sh        # Port 5173 — open in browser
```

Open `http://127.0.0.1:5173`, allow webcam access. Press keys `1`–`4` to test intent proposals. Toggle **Safe Mode** to route through the verifier.

### Platform requirements

**Linux (DGX Spark / Ubuntu):**
- GNOME X11 desktop
- `sudo apt install xdotool`

**macOS:**
- Enable Accessibility permission for Terminal: System Settings → Privacy & Security → Accessibility
- Uses `osascript` for key injection

## Hardware

- **DGX Spark** (Grace Blackwell GB10, 128GB unified, Ubuntu 24.04 arm64) — Cosmos inference
- **MacBook Air** (Apple Silicon) — development and secondary demo platform
- USB webcam on DGX Spark; built-in camera on Mac

## Teacher-Student Feedback Loop (Option 2 — Core Deliverable)

The gesture state machine is intentionally **high-recall / low-precision**: it fires on many candidate gestures, including false positives. Cosmos acts as the **teacher**, labeling every proposal with ground-truth intent via visual reasoning. A lightweight local **student classifier** (logistic regression or small random forest) trains on those labels and takes over filtering in real time.

**Three phases:**
1. **Phase 1** — 100% of proposals go to Cosmos for labeling
2. **Phase 2** — When student-Cosmos agreement exceeds 90%, reduce sampling to ~50%
3. **Phase 3** — When agreement exceeds 95%, spot-check only (10–20%)

A small random percentage always goes to Cosmos (never 0%) to detect student blind spots.

See [Option 2 Design & Risks](docs/OPTION2_RISKS_AND_MITIGATIONS.md) for the full design, failure modes, and safeguards.

## Beyond Desktop Gestures

Desktop gesture control is a proof of concept. The core architecture — **VLM-based intent verification on top of continuous spatial tracking** — applies to any domain where false positives from incidental motion are the bottleneck:

- Robotics safety (command vs. normal worker motion)
- Automotive gesture controls (driver commands vs. passenger conversation)
- Smart home / IoT (control gestures vs. stretching)
- AR/VR spatial input (commands vs. natural hand motion)
- Industrial operations and retail kiosks

## Documentation

| Document | Purpose |
|----------|---------|
| [Project Context](docs/PROJECT_CONTEXT.md) | Problem statement, solution thesis, competition framing |
| [System Architecture](docs/SYSTEM_ARCHITECTURE.md) | Components, APIs, deployment modes, data flow |
| [Gesture Detection](docs/GESTURE_DETECTION.md) | Detection algorithm, thresholds, state machines |
| [Cosmos Prompt & Schema](docs/COSMOS_PROMPT_AND_SCHEMA.md) | Prompt template, JSON schema, integration guide |
| [Latency Policy](docs/LATENCY_AND_AMBIGUOUS_POLICY.md) | Timeout, merge/supersede, instrumentation |
| [Option 2 Risks](docs/OPTION2_RISKS_AND_MITIGATIONS.md) | Teacher-student loop design and safeguards |
| [Architecture Diagrams](docs/ARCHITECTURE_DIAGRAMS.md) | Visual diagrams for all system flows |
| [Build Status](docs/STATUS.md) | Current state, priorities, session handoff |
| [Performance Tracking](docs/COSMOS_PERFORMANCE_TRACKING.md) | Per-iteration Cosmos metrics and category breakdowns |
| [Prompt Engineering Log](docs/PROMPT_ENGINEERING_LOG.md) | Prompt iteration narrative and lessons learned |

## License

Apache 2.0
