# Option 2: Teacher-Student Feedback Loop — Design, Risks, and Mitigations

## What Option 2 Is

Option 2 is NOT a stretch goal — it is the core deliverable that justifies Cosmos's role in the architecture.

The local gesture state machine is intentionally tuned for high recall and low precision. It fires on every real gesture AND on many incidental motions (head scratches, reaching for coffee, conversational waves). This is by design — the state machine is a broad net, not a precise filter.

Cosmos Reason 2 is too slow (5.8–8.4 seconds per call) to run as a live verification gate. By the time Cosmos returns a verdict, the action has already executed. You can't un-switch a workspace. So Cosmos-as-live-verifier is architecturally limited to after-the-fact logging.

Option 2 solves this by making Cosmos a **teacher** instead of a gatekeeper. Cosmos is too slow to run in the loop, but it's smart enough to teach. A lightweight local student classifier runs in milliseconds, makes real-time filtering decisions (execute or suppress), and improves over time because Cosmos continuously grades its work.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    Per-Gesture-Proposal Flow                 │
│                                                              │
│  1. Loose state machine fires gesture proposal               │
│  2. Student classifier decides: EXECUTE or SUPPRESS          │
│     (runs in <1ms using landmark features)                   │
│  3. If EXECUTE → action fires immediately (responsive UX)    │
│  4. Evidence frames ALWAYS go to Cosmos async                │
│  5. Cosmos returns intent label (5–8 seconds later)          │
│  6. Label logged to JSONL as training data                   │
│  7. Periodically: student retrains on accumulated labels     │
└──────────────────────────────────────────────────────────────┘
```

Key difference from the old design: the student is the actual execute/suppress decision-maker in real time. Cosmos never gates actions — it only teaches.

---

## Why "Always Send to Cosmos" (Phase 1)

In the old design, only ambiguous cases (where the student was uncertain) were sent to Cosmos. This creates a critical blind spot: if the student is confidently wrong about a case, it never sends that case to Cosmos, never gets corrected, and the error becomes permanent.

**Example:** the student learns with 95% confidence that a particular lateral hand motion is a swipe. It always executes it, never sends it to Cosmos. But it's actually the user scratching their head. Because the student is confident, it never asks Cosmos, and it never learns it was wrong.

**Solution:** in Phase 1, send 100% of gesture proposals to Cosmos regardless of student confidence. Cosmos grades every decision. The student confidence score is logged for analysis but is never used to decide whether to send to Cosmos.

---

## Three Phases of Cosmos Dependency

**Phase 1 — Full Supervision (launch state)**

Every gesture proposal goes to Cosmos. Student trains on 100% Cosmos-labeled data. This is the bootstrapping phase. Send rate: 100%.

**Phase 2 — Agreement Monitoring**

Track agreement rate: what percentage of the time does the student's prediction match Cosmos's label? When agreement is consistently above 90% over the last 100 proposals, reduce to 50% of cases sent to Cosmos. The sampling must be RANDOM — not based on student confidence — to avoid the blind spot problem. Track agreement per gesture type separately (Cosmos may be better at some gestures than others).

**Phase 3 — Spot-Check Only**

Agreement holds at 95%+. Reduce to 10–20% random sampling. The student is mostly autonomous but never fully unsupervised.

**CRITICAL:** Never reduce to 0%. Always maintain some percentage of random sampling to catch drift and prevent teacher bias propagation.

---

## Teacher Bias Propagation

If the student perfectly mimics Cosmos, it inherits whatever Cosmos gets wrong. Cosmos is not ground truth — it's a VLM with its own error patterns and biases.

**Mitigations:**
- Never go to 0% Cosmos sampling (always have a correction signal)
- Track per-gesture-type agreement separately — if Cosmos is mediocre at distinguishing OPEN_MENU from a wave, the student shouldn't inherit that weakness uniformly
- In a production system, occasionally inject human-verified labels as true ground truth
- Monitor for cases where student confidence is high but Cosmos disagrees — these are the most informative training examples and indicate potential bias issues
- The goal is for the student to approximate Cosmos's judgment, not replicate it perfectly — some divergence is healthy

---

## What the Student Model Looks Like

**Input features (per gesture proposal):**
- Swipe displacement (% of frame width)
- Swipe duration (seconds)
- Peak velocity of wrist motion (landmark 0)
- Handedness consistency (% of frames with same hand label)
- Finger extension count at proposal time
- Palm facing score (z-depth differential between wrist and fingertips)
- Motion smoothness (jerk metric)
- Hand size in frame (bounding box area)
- Wrist position relative to face (above/below/beside — helps distinguish commands from grooming)

**Output:** Binary (intentional / not intentional) + intent class if intentional

**Model:** Logistic regression or small random forest via scikit-learn. Must be under ~100 parameters. Must run in under 1 ms per prediction. Runs in a local Python service or potentially in the browser via a simple weight lookup.

**Important:** We never fine-tune Cosmos. Cosmos is a general reasoning model that already understands human intent from video. Fine-tuning it on a handful of gestures would be overkill, slow, and fragile. Instead, we train a tiny local model on hand landmark features, using Cosmos's structured labels as ground truth.

---

## Safe Deployment: Shadow Mode First

Before letting the student suppress any gestures, it should run in shadow mode:
- Student makes predictions on every proposal but does NOT suppress anything
- All proposals execute as normal (same as current behavior)
- Student predictions are logged alongside Cosmos labels
- This lets us measure student accuracy against Cosmos labels before trusting it with real decisions
- Only after student accuracy exceeds a threshold (e.g., 85% agreement with Cosmos on a held-out set) does it get promoted to active filtering

---

## The Feedback Loop in Detail

```
1. User performs gesture (or incidental motion)
2. Loose state machine proposes intent with confidence score
3. Student classifier predicts: EXECUTE or SUPPRESS
   - Shadow mode: prediction logged only, action always executes
   - Active mode: prediction determines whether action executes
4. Evidence frames (8-frame window from ring buffer) sent to Cosmos async
5. Cosmos returns structured label:
   - final_intent
   - intentional (boolean)
   - reason_category
   - confidence
6. Event logged to JSONL with all data:
   - landmark features (full feature vector)
   - state machine proposal + confidence
   - student prediction + confidence
   - Cosmos label + confidence
   - execution outcome (executed / suppressed)
   - whether student agreed with Cosmos
7. Periodically (after N new labeled events, e.g., 50):
   a. Extract feature vectors and Cosmos labels from JSONL logs
   b. Filter: only use Cosmos labels with confidence >= 0.75
   c. Discard labels with reason_category: unknown
   d. Train student classifier on landmark features → intentional/not + intent class
   e. Evaluate on frozen calibration set (must include hard negatives)
   f. If performance improves AND no regression on calibration set → deploy new student version
   g. If performance regresses → reject update, keep current student version
```

---

## Risks and Mitigations

### Risk 1: Regression — updated model performs worse on previously-correct cases

The most serious risk. You update the model with new data, and it starts misclassifying gestures it used to get right.

**Mitigations:**
- Maintain a **frozen calibration set** of known-correct examples (the eval clips: 20+ positives per gesture + 20+ hard negatives)
- Before deploying any student update, evaluate on the calibration set
- Set a regression threshold: if accuracy drops by more than 2% on any gesture category, reject the update
- Keep previous model versions and allow instant rollback
- Version student models: `models/student/v0`, `v1`, etc.

### Risk 2: Label noise from Cosmos

Cosmos is not perfect. Some labels will be wrong, especially for genuinely ambiguous cases.

**Mitigations:**
- Only use labels where Cosmos confidence >= 0.75 for training
- Discard labels with `reason_category: unknown` (Cosmos expressing uncertainty)
- Require multi-frame evidence windows (8–12 frames) to give Cosmos enough context
- Log and periodically review disagreements between Cosmos and local detector

### Risk 3: Class imbalance

In normal usage with the loosened state machine, there should be a healthy mix of true positives and false positives. But the ratio may shift over time as the user adapts their behavior.

**Mitigations:**
- Actively preserve negative examples: when Cosmos rejects a proposal, always include it in training data
- Include the recorded hard negative evaluation set in every training batch
- Use class-weighted loss in the student model
- Monitor class distribution in training data and flag if it becomes heavily skewed

### Risk 4: Distribution shift between users

The student model might learn one user's specific patterns and fail for another user.

**Mitigations:**
- Keep the rule-based state machine as a fallback — the student augments the pipeline, it doesn't replace the state machine entirely
- If deploying for multiple users, maintain per-user student models or pool data with normalization
- For the competition demo, single-user is fine

### Risk 5: Policy drift / blind spots (the confident-but-wrong problem)

Over time, if the student routes fewer cases to Cosmos based on confidence, it stops getting corrective feedback on cases it's confident about. Confident mistakes become permanent.

**Mitigations:**
- Phase 1: send 100% to Cosmos (no blind spots possible)
- Phase 2–3: use RANDOM sampling, never confidence-based routing for the send decision
- Track disagreement rate: cases where student prediction differs from Cosmos label. If this rises, trigger a retraining cycle and temporarily increase Cosmos send rate
- Periodic full evaluation: re-run calibration set through both student and Cosmos and compare
- The student confidence score is used for analysis and the demo overlay, not for routing decisions about whether to send to Cosmos

### Risk 6: Privacy concerns from frame retention

Frames stored for Cosmos verification contain webcam images of the user and their environment.

**Mitigations:**
- Training data uses only extracted landmark features (no raw frames stored long-term)
- Evidence frames are kept only until Cosmos has labeled them, then deleted
- Frame capture is opt-in and configurable
- Document the retention policy clearly

### Risk 7: Schema contract breakage

If the student model or updated pipeline produces outputs that don't match the expected schema, downstream components break silently.

**Mitigations:**
- Student model outputs go through the same event pipeline as before
- The verifier response schema (`shared/schema.json`) is enforced at runtime and never changes based on student updates
- Integration tests that validate schema compliance on every code change

---

## Infrastructure Hooks Already Built

These exist in the current system to make Option 2 straightforward to implement:

- **JSONL logging everywhere** — every proposal, verification, and execution is logged with shared `event_id`, timestamps, and outcomes
- **Feature-rich event records** — local confidence, proposed intent, Cosmos label, reason category
- **Schema discipline** — strict JSON Schema validation prevents garbage data from entering the training pipeline
- **Ring buffer with 8-frame evidence windows** — ready to send to Cosmos
- **Async verification pipeline** — Cosmos calls are already non-blocking

---

## Demo Narrative for Option 2

The demo should show this progression:

- **Scene 1:** Loose state machine firing on everything (false positives everywhere) — the problem
- **Scene 2:** Cosmos catching the false positives async — the teacher at work
- **Scene 3:** Student model trained on Cosmos labels, now filtering in real time — the student learning
- **Scene 4:** Agreement rate metric climbing over time — improvement is measurable
- **Scene 5:** "Eventually the student handles it locally in milliseconds without needing Cosmos at all" — the end state

Key metric for judges: false positive rate on hard negatives — baseline (state machine only) vs. with student model trained by Cosmos.

---

## Implementation Priority

This is NOT a stretch goal. It is the core deliverable for the submission. The implementation order:

1. Loosened state machine (in progress)
2. Eval clip recording + Cosmos labeling (generates training data AND calibration set)
3. Feature extraction from JSONL logs
4. Student classifier training script
5. Shadow mode integration
6. Demo video showing the full loop
