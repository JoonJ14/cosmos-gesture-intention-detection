# Cosmos Gesture Agent

**A real-time webcam gesture agent with VLM-based intent verification — solving the false positive problem in continuous spatial tracking.**

> NVIDIA Cosmos Cookoff 2026 Submission

> 📹 [Demo Video](https://youtu.be/qUx0bgGW2z8)

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
└──────────────┬──────────────────────┬─────────┘
               │ real-time proposal   │ async evidence frames
               ▼                      ▼
┌─────────────────────────┐  ┌────────────────────────────────────────┐
│  Student Classifier     │  │      Verifier Service (PY, :8788)      │
│  (PY, :8789)            │◄─│                                        │
│  XGBoost · <10ms        │  │  Phase 1: all proposals → Cosmos       │
│  execute / suppress     │  │  Phase 2: ~50% once agreement > 90%    │
└──────────┬──────────────┘  │  Phase 3: ~10% spot-check, > 95%      │
  execute=True               │               │                        │
           │                 │               ▼                        │
           │                 │  ┌──────────────────────────────────┐  │
           │                 │  │  Cosmos Reason 2                 │  │
           │                 │  │  Teacher: labels every proposal  │  │
           │                 │  │  Labels feed back → retrains     │  │
           │                 │  │  Student Classifier              │  │
           │                 │  └──────────────────────────────────┘  │
           │                 └────────────────────────────────────────┘
           ▼
┌──────────────────────┐
│  Executor (PY, :8787)│
│  xdotool / osascript │
└──────────────────────┘
```

**Decision flow:** The web app sends each gesture proposal to two services in parallel: the Student Classifier (:8789) for a real-time execute/suppress decision, and the Verifier (:8788) for async Cosmos labeling. Cosmos labels feed back to continuously retrain the Student, reducing Cosmos sampling over time (Phase 1→3). When the Student says execute, the action is forwarded to the Executor. See [Architecture Diagrams](docs/ARCHITECTURE_DIAGRAMS.md) for full details.

## Gestures

| Intent | Gesture | Action (Linux / macOS) |
|--------|---------|------------------------|
| `OPEN_MENU` | Make a fist, then open palm (≥3 fingers spread, held ~0.15 s) | Super key / Ctrl+Up (Mission Control) |
| `CLOSE_MENU` | Hold open palm ~0.15 s, then close to fist and hold ~0.075 s | Escape |
| `SWITCH_RIGHT` | Either hand sweeps leftward across the mirrored screen | Ctrl+Right / Ctrl+Right |
| `SWITCH_LEFT` | Either hand sweeps rightward across the mirrored screen | Ctrl+Left / Ctrl+Left |

**Notes:**
- The webcam is displayed in selfie/mirror mode — your right hand appears on the right side of the screen.
- Swipes are **pose-agnostic**: open palm, edge of hand, loose fist all work equally. Either hand can trigger either direction.
- OPEN_MENU requires a deliberate fist→palm transition to avoid accidental triggers from resting an open hand.

## Why Cosmos Is Necessary (Not Optional)

### The Scalability Problem

Traditional hard-coded approaches require engineering negative-case rules for every gesture independently. Each new gesture multiplies the rules needed:

**Approach 1: Hard-Coded Negative Rules (Not Scalable)**
```
Gesture 1   Gesture 2   Gesture 3   Gesture N
   │            │            │           │
   ▼            ▼            ▼           ▼
┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐
│neg rule│  │neg rule│  │neg rule│  │neg rule│
│neg rule│  │neg rule│  │neg rule│  │neg rule│
│neg rule│  │neg rule│  │neg rule│  │neg rule│
│neg rule│  │neg rule│  │neg rule│  │  ....  │
│  ....  │  │  ....  │  │  ....  │  │  ....  │
└────────┘  └────────┘  └────────┘  └────────┘

Rules grow O(N × M) — N gestures × M negative cases each.
Adding gesture N+1 means engineering an entirely new set of rules.
```

**Approach 2: Cosmos Reason 2 as Intent Verifier (Scalable)**
```
Gesture 1   Gesture 2   Gesture 3   Gesture N
   │            │            │           │
   └────────────┴─────┬──────┴───────────┘
                      │
                      ▼
        ┌───────────────────────────┐
        │  Student Model (local)    │  ← Fast, <10ms
        │  Trained on Cosmos labels │
        └─────────────┬─────────────┘
                      │
                      ▼
        ┌───────────────────────────┐
        │  Cosmos Reason 2 (VLM)    │  ← Reads intent, not mechanics
        │  Single prompt covers     │
        │  ALL gestures + negatives │
        └───────────────────────────┘

One model handles everything. Adding gesture N+1 = one sentence in the prompt.
```

Adding gesture N+1 means adding one sentence to the prompt. Cosmos reasons about *intent* — whether the user meant to issue a command — rather than pattern-matching against a growing library of exceptions. This applies beyond gestures to any domain where distinguishing intentional actions from incidental motion is the core challenge: robotics safety, automotive controls, smart home, AR/VR input.

The student model solves the latency problem: Cosmos labels events during normal use (5.8–8.4s), and the student learns to replicate those decisions locally in <10ms.

We demonstrate Cosmos's value with **hard negative scenarios across 3 categories** — motions that a landmark-based detector proposes as gestures, but Cosmos correctly rejects:

| Category | Scenario | Why heuristics fail |
|----------|----------|---------------------|
| Self-grooming | Scratch head | Same hand trajectory as a swipe |
| Self-grooming | Scratch nose | Same hand trajectory as a swipe |
| Self-grooming | Rub eye | Same hand trajectory as a swipe |
| Reaching | Wipe monitor | Same displacement and velocity |
| Reaching | Reach to side | Same displacement and velocity |
| Reaching | Catch a fly | Same displacement and velocity |
| Conversation | Wave while talking | Same hand shape and motion |
| Conversation | Receive item from someone | Same hand shape and motion |

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

## Teacher-Student Feedback Loop

The gesture state machine is intentionally **high-recall / low-precision**: it fires on many candidate gestures, including false positives. Cosmos acts as the **teacher**, labeling every proposal with ground-truth intent via visual reasoning. A lightweight local **student classifier** trains on those labels and takes over filtering in real time.

**Phase 1 is fully operational.** The student model is trained and running. See [Results](#results) for full student model metrics and the 6-model competition results.

The pipeline is fully automated: `build_calibration.py` aggregates Cosmos-labeled events from `verifier/logs/verifier_events.jsonl` → `train_student.py` trains and saves the model → the student service hot-reloads on the next request. Safe mode (observe only) shows both Student and Cosmos decisions side by side in real time for comparison.

**Three phases:**
1. **Phase 1** — 100% of proposals go to Cosmos for labeling; student runs in parallel for comparison
2. **Phase 2** — When student-Cosmos agreement exceeds 90%, reduce Cosmos sampling to ~50%
3. **Phase 3** — When agreement exceeds 95%, spot-check only (10–20%); student handles the rest

Through continued usage, the system progresses from Phase 1 to Phase 2 as the student's agreement with Cosmos improves, and eventually to Phase 3 where the student handles the majority of decisions independently. A small random percentage will always go to Cosmos (never 0%) to detect student blind spots.

See [Teacher-Student Loop Design & Risks](docs/OPTION2_RISKS_AND_MITIGATIONS.md) for the full design, failure modes, and safeguards.

## Results

Evaluated against 151 labeled clips (70 true positives + 81 hard negatives across 6 negative categories), trained and running on real usage sessions.

**Cosmos Intent Verification:**

| Metric | Result |
|--------|--------|
| TP Recall | 98.6% (69/70) |
| Hard Negative Rejection | 90.1% (73/81) |
| Prompt iterations to ship | 10 (~50 min total engineering time) |
| Inference latency | 5.8–8.4s per verification |

**Student Model (Teacher-Student Distillation):**

The student model is a fast local cache of Cosmos's intelligence — not a standalone classifier. It doesn't need to be perfect; it needs to be fast and mostly right, with Cosmos continuously verifying and correcting in the background.

Each retraining round, 6 model architectures compete head-to-head on the latest Cosmos-labeled data: Logistic Regression, Random Forest, SVM (RBF), MLP Neural Network, XGBoost, and LightGBM. The best performer automatically becomes the production model. As the data evolves, so does the winning architecture — v5's winner was SVM, v7's winner is XGBoost.

| Metric | Result |
|--------|--------|
| Cosmos Agreement | 94.3% |
| Model | XGBoost (winner of 6-model competition) |
| Training samples | 946 (live Cosmos-labeled data, conflict-cleaned, class-balanced) |
| Features | 16 (12 MediaPipe numeric + 4 one-hot gesture type) |
| Inference latency | <10ms |
| Speedup over Cosmos | 500–800x |

**v7 model competition (946 samples):**

| Model | Test Acc on 20% Held-Out Set (vs Cosmos labels) |
|---|---|
| Logistic Regression | 80.5% |
| Random Forest | 80.5% |
| MLP Neural Network | 81.6% |
| LightGBM | 84.2% |
| SVM (RBF) | 83.7% |
| **XGBoost** | **85.3% ← winner** |

**Key takeaway:** Cosmos provides high-accuracy intent verification. The student model learns from Cosmos's labels and delivers the same decision in under 10 milliseconds — a 500–800x speedup. Every retraining round, 6 model architectures compete and the best one wins, ensuring the student improves as more labeled data accumulates.

## Quick Start

Four terminals from repo root:

```bash
./scripts/run_executor.sh   # Port 8787 — OS key injection
./scripts/run_verifier.sh   # Port 8788 — Cosmos intent verification
./scripts/run_student.sh    # Port 8789 — Student ML model
./scripts/run_web.sh        # Port 5173 — open in browser
```

### Cosmos Reason 2 Setup (optional — needed for live verification)

Download the Cosmos-Reason2-8B model weights, then start the vLLM server:

```bash
docker run -d --name cosmos-vllm --gpus all --restart always -p 8000:8000 \
  -v /path/to/Cosmos-Reason2-8B:/model:rw \
  vllm/vllm-openai:v0.16.0-aarch64-cu130 \
  /model --served-model-name nvidia/cosmos-reason2-8b \
  --dtype bfloat16 --max-model-len 8192 --gpu-memory-utilization 0.85
```

Set `NIM_ENABLED=1` in the verifier environment to enable live Cosmos verification. Without it, the system still runs with the student model for local inference but won't have Cosmos verification.

Open the web app with service connections:

```
http://localhost:5173/?verifier=http://<DGX_IP>:8788&student=http://localhost:8789
```

Allow webcam access. Toggle **Safe Mode** (observe only) to see both Student and Cosmos decisions side by side without executing gestures. Uncheck for normal operation where verified gestures execute immediately.

**Note:** Without Cosmos running, the system still operates using the student model for local inference. You can run Cosmos periodically (rather than continuously) to accumulate labeled events and retrain the student — see the Cosmos Reason 2 Setup section above for how to start the vLLM server.

### Platform requirements

**macOS:**
- Enable Accessibility permission for Terminal: System Settings → Privacy & Security → Accessibility
- Uses `osascript` for key injection
- Make sure all dependencies are installed (`pip install -r requirements.txt`) including the lightweight ML libraries (scikit-learn, XGBoost, LightGBM) so the student model can be trained from Cosmos Reason 2 feedback and used for local inference

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
