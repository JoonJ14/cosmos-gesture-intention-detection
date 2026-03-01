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

## License

Apache 2.0
