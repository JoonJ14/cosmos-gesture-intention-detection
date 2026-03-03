# System Architecture

## Design principles

1. **Fast local perception, slow intelligent verification.** The browser detects gestures at 30+ fps. Cosmos reasons about intent only when needed. Users feel instant response; Cosmos adds correctness.
2. **Services communicate only via HTTP.** The browser cannot press OS keys, and should not call Cosmos directly. Each component has a single responsibility and a clean API boundary.
3. **Cross-platform from day one.** The same web app runs on macOS and Linux. Platform differences are isolated in the executor backend and the `actions.yaml` config.
4. **Log everything for Option 2.** Every proposal, verification, and execution writes JSONL with a shared `event_id`. This enables the teacher-student feedback loop later without retrofitting.

## Components

### 1. Web App (`web/`, JavaScript, port 5173)

Runs in browser on macOS and Linux identically.

**Responsibilities:**
- Webcam capture via `getUserMedia`
- MediaPipe Hands (JS) for real-time hand landmark detection at 30+ fps
- Gesture state machine: classifies landmark trajectories into intent proposals with local confidence scores
- Ring buffer: stores the last ~1 second of sampled frames (~8–12 frames) for evidence windows sent to the verifier
- Confidence-gated routing: decides whether to execute directly, verify first, or ignore (see Decision Logic below)
- Overlay UI: shows landmarks, gesture state, verification status
- Structured console logs with shared `event_id` and timing data

**Why JavaScript:** MediaPipe Python achieved only 8–10 fps on Mac Air. MediaPipe JS with WebGL achieves 30+ fps in the browser. Since all backend services are HTTP, the frontend language is independent of the backend.

### 2. Action Executor (`executor/`, Python FastAPI, port 8787)

Runs locally on the same machine as the web app.

**Responsibilities:**
- Receives intent commands via `POST /execute`
- Loads key mappings from `actions.yaml`, selects by detected OS
- Injects OS key events:
  - Linux GNOME X11: `xdotool key <combo>`
  - macOS: `osascript` with System Events (requires Accessibility permission)
- Writes JSONL to `executor/logs/executor_events.jsonl`
- Supports `dry_run` mode for testing without key injection

### 3. Cosmos Verifier (`verifier/`, Python FastAPI, port 8788)

Runs on DGX Spark (or locally for development with stub logic).

**Responsibilities:**
- Receives proposed intent + evidence via `POST /verify`
- Calls Cosmos Reason 2 NIM via OpenAI-compatible `/v1/chat/completions`
- Validates response against `shared/schema.json` — rejects malformed model output
- Returns structured JSON: intentional yes/no, final intent, confidence, reason category, rationale
- Writes JSONL to `verifier/logs/verifier_events.jsonl`
- Falls back to stub logic when Cosmos NIM is not configured (for local development)

**Cosmos NIM URL must be configurable** via environment variable (`COSMOS_NIM_URL`). This enables:
- DGX-only mode: verifier calls `http://localhost:<nim_port>/v1/chat/completions`
- Mac + DGX mode: verifier on DGX is called from Mac's web app at `http://<dgx_ip>:8788/verify`

### 4. Student Classifier (`student/`, Python Flask, port 8789)

Runs locally on the same machine as the web app.

**Responsibilities:**
- Receives gesture proposals via `POST /predict` with the 16-feature vector from gesture.js
- Returns `execute` (true/false) and confidence from a RandomForest classifier
- Hot-reloads `models/student/current_model.joblib` when the file changes
- Supports shadow mode (predictions logged but always returns execute=true) and active mode

**Model:** scikit-learn RandomForest trained on Cosmos-labeled gesture events. 12 numeric MediaPipe features + 4 one-hot gesture type = 16 features total. Inference <10ms.

**Training pipeline:** `build_calibration.py` aggregates Cosmos-labeled events from `verifier/logs/verifier_events.jsonl` → `train_student.py` trains and saves `models/student/current_model.joblib`.

### 5. Cosmos Reason 2 NIM (DGX Spark)

- NVIDIA Inference Microservice running Cosmos Reason 2
- OpenAI-compatible API at `/v1/chat/completions`
- Accepts multimodal input: base64 image frames + text prompt
- Based on Qwen3-VL architecture, runs on Blackwell GPU
- Apache 2.0 source, NVIDIA Open Model License for weights

### 6. Shared Contract (`shared/schema.json`)

Single strict JSON Schema for all verifier responses. 7 required fields, no additional properties. Used by:
- Verifier runtime validation (rejects non-conforming Cosmos output)
- Web app response parsing
- Future evaluation and training pipelines

## API contracts

### Executor: `POST /execute`

Request:
```json
{
  "intent": "OPEN_MENU|CLOSE_MENU|SWITCH_RIGHT|SWITCH_LEFT",
  "event_id": "string (optional, generated if missing)",
  "dry_run": false,
  "source": "web"
}
```

Response:
```json
{
  "ok": true,
  "executed": true,
  "intent": "OPEN_MENU",
  "event_id": "evt-...",
  "key_combo": "Super_L",
  "detail": "key event dispatched"
}
```

### Verifier: `POST /verify`

Request:
```json
{
  "event_id": "string (required)",
  "proposed_intent": "SWITCH_RIGHT",
  "frames": ["base64-jpeg-1", "base64-jpeg-2", "...8-12 frames"],
  "landmark_summary_json": { "handedness": "Right", "trajectory": [...], "palm_facing": true },
  "local_confidence": 0.73,
  "features": { "swipeDisplacement": 0.12, "peakVelocity": 0.08, "...": "..." },
  "student_prediction": { "execute": true, "confidence": 0.91 }
}
```

(`features` and `student_prediction` are optional — logged alongside Cosmos verdict for training correlation.)

Response (must validate against `shared/schema.json`):
```json
{
  "version": "1.0",
  "proposed_intent": "SWITCH_RIGHT",
  "final_intent": "SWITCH_RIGHT",
  "intentional": true,
  "confidence": 0.87,
  "reason_category": "intentional_command",
  "rationale": "User is facing screen with deliberate lateral hand motion directed at camera."
}
```

## Runtime decision logic

Cosmos Reason 2 latency on DGX Spark GB10 is **5.8–8.4s** per verification call
(measured 2026-02-27, see `data/cosmos_latency_tests.md`). This rules out synchronous
verification in the live gesture path. The default mode is async verification.

### Default mode: async verification

```
Gesture detected → local_confidence computed
    │
    ├── confidence ≥ HIGH threshold → Execute immediately
    │       → Queue async Cosmos verification (fire-and-forget)
    │       → When Cosmos responds (~7s later): log result, flag disagreements
    │
    ├── MEDIUM ≤ confidence < HIGH  → Execute immediately
    │       → Queue async Cosmos verification
    │       → When Cosmos responds: log result, flag disagreements
    │
    └── confidence < LOW threshold  → Ignore (no execution, no Cosmos call)

Async verification (background, non-blocking):
    → POST frames + landmarks to verifier → Cosmos NIM
    → Log JSONL: intentional, final_intent, reason_category, rationale, latency_ms
    → If Cosmos disagrees with local execution → record as disagreement
    → Disagreements = training signal for Option 2 teacher-student loop
```

### Safe Mode: observe only (demo)

Safe Mode is an observe-only mode — **no gestures execute at all**. Proposals are sent to
both the Student model and Cosmos; both decisions are displayed in the UI overlay in real
time. Useful for showing judges what each layer decides without triggering desktop actions.
Toggle via the **Safe Mode (observe only)** checkbox in the web UI.

```
Gesture detected → proposals sent to Student and Cosmos as normal
    → Student prediction displayed in overlay (no execution)
    → Cosmos result displayed in overlay (~7s later, no execution)
```

**Why not synchronous verify-then-execute:** The 5.8–8.4s Cosmos latency rules that out.
In normal mode, gestures execute immediately and Cosmos verifies in the background for
training label generation only.

**Full-system accuracy (measured on 151 eval clips):** 98.6% TP recall, 90.1% hard
negative rejection across 6 negative categories (10 prompt iterations, ~50 minutes total).

See `docs/LATENCY_AND_AMBIGUOUS_POLICY.md` for the full policy specification including
merge/supersede rules, stale response handling, and instrumentation fields.

## Data flow to the verifier

When a gesture proposal triggers Cosmos verification:

1. Web app grabs the last ~1 second from the ring buffer (~8–12 frames sampled at even intervals)
2. Frames are JPEG-encoded and base64-encoded in the browser
3. A landmark summary JSON is constructed: handedness, palm center trajectory over the window, finger extension states, palm facing score
4. The payload (proposed intent + frames + landmarks + local confidence) is POSTed to the verifier
5. The verifier constructs a multimodal prompt with the frames as base64 images and the landmark summary as text context
6. Cosmos Reason 2 returns structured JSON which the verifier validates against the schema

## Deployment modes

### DGX-only mode (primary for competition)
All four components run on DGX Spark. Webcam is connected to DGX. No network latency for verification. Best for stable demo and reproducibility.

```
DGX Spark:
  Browser (Chromium) → Web App (:5173)
  Web App → Executor (:8787)  → xdotool → GNOME desktop
  Web App → Verifier (:8788)  → Cosmos NIM (localhost) → response
```

### Mac + DGX mode (development and secondary demo)
Web app and executor run on MacBook Air. Verifier and Cosmos NIM run on DGX Spark, accessible over the local network.

```
MacBook Air:
  Browser (Chrome) → Web App (:5173)
  Web App → Executor (:8787, localhost) → osascript → macOS desktop
  Web App → Verifier (:8788, DGX_IP) → Cosmos NIM → response

DGX Spark:
  Verifier (:8788) → Cosmos NIM (localhost)
```

**Verifier URL configuration:** Pass `?verifier=http://192.168.1.250:8788&student=http://localhost:8789` as URL query params when opening the web app. Both URLs are configurable at runtime with no code changes.

### Stub mode (offline development)
Same as DGX-only or Mac-only, but the verifier uses stub logic (always approve or force-reject) instead of calling Cosmos. Useful for developing gesture detection without DGX access.

## Logging and observability

All components correlate via shared `event_id`:

| Component | Log file | Key fields |
|-----------|----------|------------|
| Web App | Browser console (structured JSON) | event_id, proposed_intent, local_confidence, policy_path, timing timestamps, merge_count |
| Verifier | `verifier/logs/verifier_events.jsonl` | event_id, proposed_intent, nim_called, latency_ms, response_json, schema_valid |
| Executor | `executor/logs/executor_events.jsonl` | event_id, intent, key_combo, executed, dry_run, os_name, latency_ms |

**Timing fields captured in web app per event:**
- `proposal_start_ms` — when gesture was first detected
- `verify_send_ms` / `verify_recv_ms` — verifier round-trip
- `exec_send_ms` / `exec_recv_ms` — executor round-trip
- `latency_e2e_ms` — total from detection to execution

These enable latency analysis, timeout tuning, and Option 2 disagreement tracking.
