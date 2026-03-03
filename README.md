# Cosmos Gesture Agent

**A real-time webcam gesture agent with VLM-based intent verification — solving the false positive problem in continuous spatial tracking.**

> NVIDIA Cosmos Cookoff 2026 Submission

> 📹 [Demo Video — Coming Soon]

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

## Results

Evaluated against 151 labeled clips (70 true positives + 81 hard negatives across 6 negative categories), trained and running on real usage sessions.

**Cosmos Intent Verification:**

| Metric | Result |
|--------|--------|
| TP Recall | 98.6% (69/70) |
| Hard Negative Rejection | 90.1% (73/81) |
| Prompt iterations to ship | 10 (~50 min total engineering time) |
| Inference latency | 5.8–8.4s per verification |

**Student Model (trained on Cosmos-labeled live data):**

| Metric | Result |
|--------|--------|
| Accuracy | 88.2% (RandomForest, scikit-learn) |
| Training samples | 380 (real usage sessions, labeled by Cosmos) |
| Features | 16 (12 MediaPipe numeric + 4 one-hot gesture type) |
| Inference latency | <10ms |

**Key takeaway:** Cosmos provides high-accuracy intent verification. The student model learns from Cosmos labels to deliver near-real-time decisions, achieving a 500–800x speedup while maintaining strong accuracy.

## Architecture

```
┌───────────────────────────────────────────────┐
│               Web App (JS, :5173)             │
│  MediaPipe Hands · Gesture state machine      │
│  Ring buffer · Confidence scoring · Overlay   │
└───────────────────────┬───────────────────────┘
                        │ gesture proposals
                        v
    ┌───────────────────────────────────────────┐
    │       Verifier Service (PY, :8788)        │
    │                                           │
    │  ┌─────────────────────────────────────┐  │
    │  │  Student ML Model (local)           │  │◄──────────────────────────────────┐
    │  │  Lightweight intent classifier      │  │                                   │
    │  └──────────────┬──────────────────────┘  │  feedback loop:                   │
    │     Phase 1: all proposals → Cosmos       │  trains lightweight               │
    │     Phase 2: ~50% once agreement > 90%    │  student model over time          │
    │     Phase 3: ~10% spot-check, > 95%       │  to improve performance           │
    │                 │                         │                                   │
    │                 v                         │                                   │
    │  ┌─────────────────────────────────────┐  │                                   │
    │  │  Cosmos Reason 2 — DGX Spark (GB10) │  │───────────────────────────────────┘
    │  │  Teacher: labels every proposal     │  │
    │  │  Labels feed back → trains Student  │  │
    │  └─────────────────────────────────────┘  │
    └────────────────────┬──────────────────────┘
                         │ intentional=True
                         v
              ┌──────────────────────┐
              │  Executor (PY, :8787)│
              │  xdotool / osascript │
              └──────────────────────┘
```

**Decision flow:** Gesture proposals from the web app pass through the Student ML Model, which routes a sampled percentage to Cosmos Reason 2 for labeling. Cosmos labels feed back to continuously retrain the Student, reducing Cosmos sampling over time (Phase 1→3). Verified intentional gestures are forwarded to the Executor for OS action. See [Architecture Diagrams](docs/ARCHITECTURE_DIAGRAMS.md) for full details.

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

**Results:** Without Cosmos, the state machine fires on all candidate motions including incidental ones (0% rejection). With Cosmos verification, 90.1% of hard negatives are correctly rejected (73/81 across 6 negative categories). The hardest category (reaching motions) achieves 25% rejection — these are kinematically identical to real swipes and represent the genuine frontier of VLM-based discrimination.

Beyond accuracy, Cosmos also delivers **dramatically faster iteration cycles** than traditional ML — a prompt change can be validated in minutes rather than after hours of retraining. See [Rapid Iteration via Prompt Engineering](#rapid-iteration-via-prompt-engineering) below.

## Rapid Iteration via Prompt Engineering

One of Cosmos's most valuable properties isn't just accuracy — it's **iteration speed.** When something goes wrong with a traditional ML classifier, you retrain. With Cosmos, you edit English text. Here's how that played out during development.

### From Near-Zero to 100% TP Recall in Minutes

We evaluated Cosmos against **151 labeled clips** (70 true positives + 81 hard negatives). Our initial prompt was rejection-biased — it listed every motion to reject but never described what an intentional gesture actually looks like. Result: Cosmos rejected nearly everything, including real intentional gestures. **TP recall was ~15%.**

The fix took under 5 minutes: rewrite the system prompt to add gesture descriptions, signs of intentional intent, and a balanced decision guideline. Zero retraining. Zero data pipeline changes. **TP recall went from ~15% to 100%.**

### Ten Iterations, ~50 Minutes Total

| Iteration | Change | TP Recall | NEG Rejection | Notes |
|-----------|--------|-----------|---------------|-------|
| 1 | Original prompt (rejection-biased) | ~15% | ~95% | Stopped early — too aggressive |
| 2 | Balanced prompt + gesture descriptions | **100%** | 71.6% | Fixed in < 5 min |
| 3 | + Gaze direction + yawning awareness | **100%** | 77.8% | Incremental improvement |
| 4 | + Reach-specific lateral motion guidance | 98.6% | 80.2% | TP regression discovered |
| 5 | Reverted broad language, kept targeted reach | **100%** | 79.0% | Restored TP recall |
| 6/6b | Pre-evaluation gaze gates | ~97–99% | N/A | Killed early — pre-gates contaminate |
| 7 | Post-evaluation sanity check (gaze + reach) | 97.1% | 88.9% | NEG breakthrough; TP regression |
| 8 | Softened sanity check + arm extension | **100%** | 79.0% | TPs back; NEG gains erased |
| 9 | Assertive tone + arm extension signals | **100%** | 86.4% | Best 100% TP result |
| 10 | + CLOSE_MENU transition verification | 98.6% | **90.1%** | **SHIPPED** — first >90% NEG |

### Key Discoveries

**Pre-evaluation gates contaminate gesture analysis.** Iterations 6 and 6b tested gaze checks placed *before* the gesture evaluation — as a "Step 1: check gaze, then Step 2: evaluate gesture" structure. Both caused TP regression within the first few clips. Any priming that makes Cosmos suspicious before it evaluates the hand motion causes collateral damage on real gestures.

**Post-evaluation sanity checks work.** Iteration 7 moved the gaze and reach checks to *after* the gesture evaluation as a "FINAL SANITY CHECK" block. NEG rejection jumped from 79.0% to 88.9% — the biggest single-iteration gain in the session. NEG_REACH moved off 0% for the first time. The structural placement matters: evaluate first, reconsider second.

**Prompt strength has a sharp tradeoff.** Iteration 7's assertive language caused 2 TP misses (swipes rejected). Iteration 8 softened it and recovered all TPs — but erased all NEG gains. There is no simple middle ground. Iteration 9 found the balance: assertive language *plus* richer biomechanical signals (arm extension, spatial zone) that give Cosmos enough information to discriminate correctly.

**Targeted per-gesture verification catches category-specific FPs.** Iteration 10 added a CLOSE_MENU-specific check: verify you observed a deliberate palm-to-fist *transition*, not just a hand that ends up closed (catching yawn/rest FPs). NEG_OTHER improved from 86.5% to 97.3%. The lesson: when a specific gesture class generates FPs, describe exactly what distinguishes the intentional version rather than adding general restrictiveness.

### The Hardest Category: Reaches (25% rejection — breaking through)

We were able to achieve 25% rejection for the hardest category that stayed around 0% for multiple iteration cycles. This shows that just by improving the prompt to our reasoning models and iterating, we can start to break through even on the hardest category to detect — the ones that are impossible to hard-code, since their mechanical actions are identical.

Lateral hand displacement during a reach is kinematically indistinguishable from a real swipe in sampled frames. All false positives in this category cluster at confidence 0.70–0.71, suggesting Cosmos recognizes the ambiguity but cannot fully resolve it from visual frames alone. This is the genuine frontier challenge that validates the need for the teacher-student feedback loop: even a VLM needs ongoing context beyond static frames, which is exactly the use case for the student model learning from Cosmos's labeling over time.

### Scalability: Prompt Engineering vs. Retraining

| Scenario | Traditional ML | VLM (Cosmos) |
|----------|---------------|--------------|
| Fix bad classification | Retrain (hours/days) | Edit prompt (minutes) |
| Add new gesture | Collect data + retrain | Add text description |
| Add false positive category | Collect negatives + retrain | Add sentence to prompt |
| Discover tradeoffs | Multiple retrain cycles | Run eval, compare, revert in minutes |

**Final shipped result (Iteration 10):** 98.6% TP recall, 90.1% hard negative rejection across 151 evaluation clips (70 true positives + 81 hard negatives across 6 categories).

For detailed per-iteration metrics and category breakdowns, see [`docs/COSMOS_PERFORMANCE_TRACKING.md`](docs/COSMOS_PERFORMANCE_TRACKING.md) and [`docs/PROMPT_ENGINEERING_LOG.md`](docs/PROMPT_ENGINEERING_LOG.md).

## Quick Start

Four terminals from repo root:

```bash
./scripts/run_executor.sh   # Port 8787 — OS key injection
./scripts/run_verifier.sh   # Port 8788 — Cosmos intent verification
./scripts/run_student.sh    # Port 8789 — Student ML model
./scripts/run_web.sh        # Port 5173 — open in browser
```

Open the web app with service connections:

```
http://localhost:5173/?verifier=http://<DGX_IP>:8788&student=http://localhost:8789
```

Allow webcam access. Toggle **Safe Mode** (observe only) to see both Student and Cosmos decisions side by side without executing gestures. Uncheck for normal operation where verified gestures execute immediately.

**Note:** The verifier requires a running Cosmos Reason 2 instance via vLLM on the DGX Spark. Without it, the verifier falls back to a stub that approves all gestures. Set `NIM_ENABLED=1` environment variable to enable real Cosmos verification.

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

## Teacher-Student Feedback Loop

The gesture state machine is intentionally **high-recall / low-precision**: it fires on many candidate gestures, including false positives. Cosmos acts as the **teacher**, labeling every proposal with ground-truth intent via visual reasoning. A lightweight local **student classifier** trains on those labels and takes over filtering in real time.

**Phase 1 is fully operational.** The student model is trained and running:

| | |
|---|---|
| Model | RandomForest (scikit-learn) |
| Test accuracy | 88.2% |
| Training samples | 380 live events labeled by Cosmos during real usage sessions |
| Features | 12 numeric MediaPipe features (swipe displacement, finger counts, wrist velocity, palm orientation, etc.) + 4 one-hot gesture type encodings |
| Student inference | <10ms vs. Cosmos 5.8–8.4s (500–800x speedup) |

The pipeline is fully automated: `build_calibration.py` aggregates Cosmos-labeled events from `verifier/logs/verifier_events.jsonl` → `train_student.py` trains and saves the model → the student service hot-reloads on the next request. Safe mode (observe only) shows both Student and Cosmos decisions side by side in real time for comparison.

**Three phases:**
1. **Phase 1** — 100% of proposals go to Cosmos for labeling; student runs in parallel for comparison
2. **Phase 2** — When student-Cosmos agreement exceeds 90%, reduce Cosmos sampling to ~50%
3. **Phase 3** — When agreement exceeds 95%, spot-check only (10–20%); student handles the rest

As the user keeps using our models, it will go through Phase 1 and then as it keeps improving and learning from Cosmos reasoning model, it will go to Phase 2 and eventually Phase 3. A small random percentage will always go to Cosmos (never 0%) to detect student blind spots.

See [Teacher-Student Loop Design & Risks](docs/OPTION2_RISKS_AND_MITIGATIONS.md) for the full design, failure modes, and safeguards.

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
| [Teacher-Student Loop Risks](docs/OPTION2_RISKS_AND_MITIGATIONS.md) | Teacher-student loop design and safeguards |
| [Architecture Diagrams](docs/ARCHITECTURE_DIAGRAMS.md) | Visual diagrams for all system flows |
| [Build Status](docs/STATUS.md) | Current state, priorities, session handoff |
| [Performance Tracking](docs/COSMOS_PERFORMANCE_TRACKING.md) | Per-iteration Cosmos metrics and category breakdowns |
| [Prompt Engineering Log](docs/PROMPT_ENGINEERING_LOG.md) | Prompt iteration narrative and lessons learned |

## License

MIT
