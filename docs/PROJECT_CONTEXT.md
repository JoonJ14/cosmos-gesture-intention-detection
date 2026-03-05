# Project Context

## One-sentence summary

A real-time webcam gesture agent that triggers desktop actions, using NVIDIA Cosmos Reason 2 as a vision-language intent verifier to distinguish deliberate commands from incidental human motion.

## The problem: false positives in continuous spatial tracking

Every major attempt at gesture-based computer interaction has hit the same wall: **false positives from incidental motion are fundamentally unsolvable with traditional detection approaches.**

On a touchscreen, input only registers when a fingertip physically contacts the surface — the touch event IS the intent signal. But in 3D spatial tracking (webcam, depth cameras, IR sensors), the system monitors your hands continuously, and there is no physical contact to anchor intent. You scratch your head — that's a swipe. A coworker walks up and you gesture while talking — that's three workspace switches. You reach for your coffee — that's a pull gesture.

Companies have tried to solve this with geometric constraints: activation zones, posture gating, velocity thresholds, cooldown timers, displacement guards. These help incrementally but hit a fundamental ceiling: **many intentional gestures and incidental motions are mechanically identical.** A deliberate lateral swipe and a conversational hand wave have the same trajectory, velocity profile, and hand shape. No amount of threshold tuning on kinematic features alone can distinguish them — because the difference isn't in the motion, it's in the context and intent behind it.

This is why gesture interaction products have repeatedly failed commercially despite working in demos. The demo works because the presenter is deliberately performing gestures in isolation; real-world use introduces a flood of ambiguous motion.

## The solution: VLM-based intent verification

Use a vision-language model (Cosmos Reason 2) to reason about whether a detected gesture was intentional. Instead of trying to engineer geometric rules that distinguish a deliberate swipe from a conversational hand wave, send a short video clip to a model that can see the full visual context — where the user is looking, whether they're engaged with the screen or talking to someone, whether the motion is directed and purposeful or casual and incidental.

The architecture follows the **Event Reviewer pattern**: a fast local perception layer (MediaPipe Hands in the browser) proposes gesture candidates at high speed, and a slower but contextually intelligent reasoning layer (Cosmos Reason 2) verifies ambiguous cases before they trigger actions.

## Why this matters beyond desktop gestures

The desktop use case is a proof of concept for a general architecture: **VLM-based intent verification as a layer on top of any continuous spatial tracking system.** The same Cosmos verification call that distinguishes "intentional swipe" from "conversational hand wave" could distinguish:

- **Robotics safety** — intentional "stop" signal vs. worker adjusting hard hat
- **Smart home / IoT** — command gesture near a switch vs. someone stretching
- **Automotive gesture controls** — deliberate in-car gestures vs. passenger conversation
- **AR/VR input** — intentional spatial commands vs. natural hand motion
- **Industrial operations** — worker commands to systems vs. normal labor movements
- **Retail kiosks** — customer engaging with display vs. passerby

In all domains, the core problem is identical: continuous spatial tracking cannot distinguish intent from incidental motion using kinematic features alone.

## Competition context

This project is submitted to the **NVIDIA Cosmos Cookoff** (deadline: March 5, 2026 at 5 PM PT).

**Submission requirements:**
- Text description of features and functionality
- Demo video under 3 minutes
- Public GitHub repo with deployment instructions

**Judging criteria:** idea quality, technical implementation & reproducibility, design & UX, impact.

**Submission method:** GitHub issue using the Cosmos Cookoff submission form template.

**How to frame this for judges:** This is not "gesture control for laptops." It is a real-time vision agent that interprets human intent from live video and triggers actions, with a reasoning model supervising ambiguous physical motion. This places it squarely in physical AI, embodied interaction, agent workflows, and human-machine interfaces — all Cosmos-aligned themes.

## Gestures in scope

Four intents, two command families:

### Menu control
| Intent | Gesture | Description |
|--------|---------|-------------|
| `OPEN_MENU` | Fist → palm | Make a fist (≤3 fingers extended), hold ≥50ms, then open hand (≥3 fingers + palm facing camera), hold stable ≥150ms |
| `CLOSE_MENU` | Palm → fist | Hold open palm (≥3 fingers + palm facing) ≥150ms, then close to fist (≤3 fingers) while still in frame, hold fist ≥75ms |

### Workspace switching
| Intent | Gesture | Description |
|--------|---------|-------------|
| `SWITCH_RIGHT` | Swipe left on screen | Either hand; wrist moves rightward in raw camera coords (x increases); selfie-mirror view means this appears as rightward motion on screen |
| `SWITCH_LEFT` | Swipe right on screen | Either hand; wrist moves leftward in raw camera coords (x decreases) |

Swipes are **pose-agnostic** — any hand shape works. Minimum 7% Euclidean displacement, 40% lateral component, peak velocity ≥0.03, within 0.05–2.0s window. Both hands can trigger either direction.

## Hard negative scenarios

These specific scenarios demonstrate why Cosmos is necessary. Each is kinematically similar to a real gesture but should NOT trigger an action:

**Self-grooming (3):**
1. Raising hand to scratch head
2. Raising hand to scratch nose
3. Raising hand and rubbing eye

**Reaching (3):**
4. Reaching toward monitor to wipe something off the screen
5. Reaching for something beside you while head is turned
6. Rapid swatting motion trying to catch a fly

**Conversation (2):**
7. Turning around and waving hand in the air while talking to someone
8. Someone hands you an item and you raise/move your hand to receive it

These are intentionally hard to rule out with geometric heuristics. A head-scratch swipe and an intentional swipe have nearly identical hand trajectories — the difference is in the visual context around the hand, which only a VLM can reason about.

## Platform targets

| Platform | Environment | Key injection | Status |
|----------|-------------|---------------|--------|
| Linux | Ubuntu 24.04, GNOME X11 on DGX Spark | `xdotool` | Primary target |
| macOS | MacBook Air (Apple Silicon) | `osascript` (System Events) | Development & secondary demo |

Both platforms use the same web app (MediaPipe JS runs identically in Chrome/Chromium on both). The executor auto-detects OS and uses the appropriate backend.

**Why the web app is JavaScript, not Python:** MediaPipe Python was tested on Mac Air and achieved only 8–10 fps — too slow for responsive gesture control. MediaPipe JS runs via WebAssembly with WebGL acceleration in the browser and achieves 30+ fps. Since Cosmos is called via HTTP, there's no requirement for the frontend to be Python. The executor and verifier remain in Python (FastAPI) because OS key injection and model inference are better served by Python tooling.

## Hardware

- **DGX Spark** (NVIDIA Grace Blackwell GB10, 128GB unified memory, Ubuntu 24.04 arm64) — runs Cosmos Reason 2 NIM, verifier service, and optionally all services
- **LG monitor** via HDMI, **USB webcam** via USB-C adapter on DGX Spark
- **MacBook Air** (Apple Silicon) — development machine, secondary demo platform

## Key OS mappings

Configurable via `executor/actions.yaml`.

### Linux (DGX Spark, GNOME X11)
- `OPEN_MENU` → `Super_L` (opens GNOME Overview)
- `CLOSE_MENU` → `Escape`
- `SWITCH_RIGHT` → `Ctrl+Right`
- `SWITCH_LEFT` → `Ctrl+Left`

### macOS (MacBook Air)
- `OPEN_MENU` → `Ctrl+Up` (Mission Control)
- `CLOSE_MENU` → `Escape`
- `SWITCH_RIGHT` → `Ctrl+Right`
- `SWITCH_LEFT` → `Ctrl+Left`

## Teacher-student feedback loop (operational)

The architecture supports — and has implemented — a continuous improvement loop:

1. Local gesture state machine detects candidates and assigns confidence
2. All proposals are sent to Cosmos for async verification (training label generation)
3. All events are logged to `verifier/logs/verifier_events.jsonl` with a shared `event_id`
4. `build_calibration.py` aggregates Cosmos-labeled events; `train_student.py` trains a RandomForest classifier
5. The student model provides real-time execute/suppress decisions (<10ms inference)
6. Safe mode (observe only) shows Student and Cosmos decisions side by side for comparison

**Current status (Phase 1 operational):** 100% of proposals go to Cosmos for labeling. Student model v7 (XGBoost, 94.3% Cosmos agreement, 946 training samples) runs in parallel. Phase 2 (50% Cosmos sampling at 90% agreement) and Phase 3 (10–20% spot-check at 95% agreement) are designed but not yet activated.

**Cosmos is the teacher, not the student.** We never fine-tune Cosmos. We train a small local model on Cosmos's labels. See `docs/OPTION2_RISKS_AND_MITIGATIONS.md` for the full design, failure modes, and safeguards.
