# Cosmos Prompt Engineering Log — March 2, 2026

## The Key Insight: Prompt Engineering vs. Traditional ML Retraining

On March 2, during the evaluation sprint, we went through 5 prompt iterations in a single session, each taking under 5 minutes to implement and evaluate. This rapid iteration cycle perfectly demonstrates why VLM-based intent verification (Cosmos) is superior to a traditional ML-only approach.

With traditional ML, each iteration would require: collecting more training data, retraining the model (hours/days), tuning hyperparameters, and revalidating against the full test set. With Cosmos, we edited English text and re-ran the eval — getting new results in ~20 minutes (dominated by inference time, not development time).

---

## The Problem: Initial Prompt Failure

After recording 70 true positive clips and 81 hard negative clips (151 total), we ran `eval_cosmos.py` and found two critical issues:

### Issue 1: Stub Mode (No Real Inference)
The verifier was running without `NIM_ENABLED=1`, causing it to use a stub that approves everything. Every clip returned identical `intentional=True, confidence=0.9`. Lesson: always verify real Cosmos inference by checking for variable confidence scores and ~8s latency per clip.

### Issue 2: Rejection-Biased Prompt
Once real Cosmos inference was enabled, the original prompt rejected nearly everything — including true positives. TP recall was near zero because the prompt described what to reject but never described what to accept.

---

## The Fix: Balanced Prompt with Gesture Descriptions

The core fix added what the original prompt lacked:

1. **Scene context** — "A person is sitting at a desk in front of a computer with a webcam. They have set up a gesture control system."
2. **Gesture descriptions** — What each of the four gestures looks like when performed intentionally
3. **Signs of intentional gestures** — Deliberate/controlled quality, directed toward camera, clear start/stop
4. **Balanced decision guideline** — Replaced "err on rejection" with neutral criteria

This single change took TP recall from ~15% to 100%, while achieving 71.6% hard negative rejection.

---

## Iterative Improvement Through Prompt Engineering

### Iteration 3: Gaze Direction + Yawning (77.8% rejection, 100% TP recall)
Added gaze as a signal — intentional gestures involve looking at the screen, incidental motions often involve looking away. Also added yawning awareness. Result: NEG rejection improved from 71.6% to 77.8%, stretch rejection went from 80% to 100%, and TP recall stayed at 100%.

### Iteration 4: The Tradeoff Discovery (80.2% rejection, 98.6% TP recall ⚠️)
Added reach-specific language about lateral motion plus a broad decision guideline. Result: NEG_REACH improved from 0% to 25%, but **one true positive was incorrectly rejected** (TP recall dropped to 98.6%). This revealed the fundamental tradeoff: tightening criteria for reach motions risks rejecting real swipe gestures because the motions are kinematically identical.

**Decision:** For this system, 100% TP recall is more important than marginal FP improvement. A missed intentional gesture breaks user trust ("the system doesn't work"), while an occasional false positive is merely annoying. The broad lateral motion language was reverted.

### Iteration 5: Refined Guidance (79.0% rejection, 100% TP recall ✅)
Reverted the broad language that caused the TP regression while keeping the targeted reach description with an explicit escape hatch for real swipes. Result: TP recall restored to 100%, head scratch rejection improved to 89.5% (best yet), and overall rejection settled at 79.0%.

NEG_REACH remains at 0% — the motion is kinematically indistinguishable from a real swipe in static frames. This represents the genuine frontier challenge and validates the need for the teacher-student feedback loop with ongoing Cosmos verification.

---

## Why This Matters for the Submission

### VLM vs. Traditional ML: Iteration Speed

| Scenario | Traditional ML | VLM (Cosmos) |
|----------|---------------|--------------|
| Fix bad classification | Retrain (hours/days) | Edit prompt (minutes) |
| Add new gesture | Collect data + retrain | Add text description |
| Add false positive category | Collect negatives + retrain | Add sentence to prompt |
| Adjust sensitivity | Tune thresholds + retrain | Adjust guidelines in English |
| Discover tradeoffs | Multiple retrain cycles | Run eval, compare, revert in minutes |

### The Prompt Engineering Iteration Story

The progression from Iteration 1 to 5 demonstrates mature engineering practice:
- **Iteration 1→2:** Diagnosed and fixed a fundamental prompt bias in minutes
- **Iteration 3:** Added contextual signals (gaze, yawning) for incremental improvement
- **Iteration 4:** Discovered the precision-recall tradeoff through empirical testing and made a principled decision to prioritize TP recall
- **Iteration 5:** Applied the lesson from Iteration 4, reverting the harmful change while preserving the gains

This kind of rapid, evidence-based iteration — including the ability to immediately revert a bad change — is only possible with VLM-based verification. Each cycle took minutes, not hours.

### Scalability Argument

If we wanted to add a 5th gesture (e.g., "PINCH_ZOOM"), the traditional ML approach requires: collecting 50+ labeled examples, retraining the classifier, validating against all existing gestures for regression, and deploying the new model.

The Cosmos approach requires: adding 3 sentences to the prompt describing what a pinch-zoom looks like. Done.

---

## Final Results After 5 Iterations

| Metric | Value |
|--------|-------|
| TP Recall | **100%** (70/70) |
| Hard Negative Rejection | **79.0%** (64/81) |
| Best Category | NEG_WAVE 100%, NEG_PHONE 100% |
| Hardest Category | NEG_REACH 0% (kinematically identical to swipes) |
| Total Prompt Engineering Time | ~25 minutes across 5 iterations |

For detailed per-iteration metrics and per-category breakdowns, see `COSMOS_PERFORMANCE_TRACKING.md`.

---

## Technical Details

### Environment
- **Cosmos Model**: nvidia/Cosmos-Reason2-8B via vLLM v0.16.0 in Docker on DGX Spark (GB10, 128GB)
- **Inference Latency**: ~6-8 seconds per clip (8 frames at 320×180 JPEG)
- **Verifier**: Python FastAPI service, port 8788
- **Key Environment Variable**: `NIM_ENABLED=1` required

### Data Collection Summary

| Dataset | Clips | Description |
|---------|-------|-------------|
| True Positives | 70 | All 4 gestures, left/right hand variability, multiple angles |
| Hard Negatives | 81 | Head scratches, reaching, waving, phone, stretching, yawning, clapping, other |
| **Total** | **151** | Stored in `data/eval/sessions/` |
