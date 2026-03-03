# Cosmos Performance Tracking Log

## Purpose

This document tracks the performance of Cosmos Reason 2 across prompt iterations, recording precision/recall/F1 metrics, per-category analysis, and confidence distributions. Each iteration shows how a prompt change affected model behavior — demonstrating the rapid iteration advantage of VLM-based verification over traditional ML retraining.

**Dataset:** 151 clips total (70 true positives + 81 hard negatives), recorded March 2, 2026.

---

## Iteration 0: Stub Mode (Baseline — No Cosmos)

**Issue discovered:** The verifier was running without `NIM_ENABLED=1`, so it used `build_stub_response()` which approves everything automatically.

**Result:** Every clip labeled as `intentional=True, confidence=0.9, reason=intentional_command`. Uniform responses, no discrimination.

| Metric | Value |
|--------|-------|
| TP Recall | 100% (all approved) |
| Hard Negative Rejection | 0% (all approved) |
| Precision | 46.4% (70/151) |
| Status | **Useless — not using Cosmos at all** |

**Lesson:** Always verify `NIM_ENABLED=1` is set. Check for variable confidence scores and ~8s latency per clip to confirm real Cosmos inference.

---

## Iteration 1: Original Prompt (Rejection-Biased)

**Prompt characteristics:**
- Heavy "hard negative priors" section listing motions to reject
- "When uncertain, err on the side of rejection"
- No description of what intentional gestures look like
- No scene context

**Result:** Stopped early after ~22 clips. Cosmos rejected nearly everything including true positives.

| Metric | Value |
|--------|-------|
| TP Recall | ~15% (estimated from partial run) |
| Hard Negative Rejection | ~95% (estimated) |
| Status | **Broken — too aggressive, near-zero TP recall** |

**Root cause:** Prompt told Cosmos everything about what to reject but nothing about what to accept. With no reference for what "intentional" looks like, Cosmos defaulted to rejection.

---

## Iteration 2: Balanced Prompt with Gesture Descriptions

**Prompt changes (< 5 minutes to implement):**
1. Added scene context ("person at desk, webcam, gesture control system")
2. Added "THE FOUR GESTURES" section describing what each intentional gesture looks like
3. Added "SIGNS OF INTENTIONAL GESTURES" (deliberate, directed at camera, clear start/stop)
4. Kept "SIGNS OF INCIDENTAL MOTION" section
5. Replaced "err on rejection" with balanced decision guideline

| Gesture | P | R | F1 | TP | FP | FN |
|---------|------|------|------|----|----|-----|
| OPEN_MENU | 0.769 | 1.000 | 0.870 | 20 | 6 | 0 |
| CLOSE_MENU | 0.690 | 1.000 | 0.816 | 20 | 9 | 0 |
| SWITCH_RIGHT | 0.833 | 1.000 | 0.909 | 15 | 3 | 0 |
| SWITCH_LEFT | 0.750 | 1.000 | 0.857 | 15 | 5 | 0 |

| Category | Rejection Rate |
|----------|---------------|
| NEG_WAVE | 100% (8/8) |
| NEG_PHONE | 100% (4/4) |
| NEG_HEAD_SCRATCH | 84.2% (16/19) |
| NEG_STRETCH | 80% (4/5) |
| NEG_OTHER | 70.3% (26/37) |
| NEG_REACH | 0% (0/8) |
| **Overall** | **71.6%** |

**TP Recall: 100% (70/70)**

---

## Iteration 3: Gaze Direction + Yawning Awareness

**Prompt changes:**
1. Added gaze as intentional signal: "The person's gaze is directed at the screen or camera"
2. Added gaze as rejection signal: "The person's gaze is directed away from the screen"
3. Added yawning rejection: "Yawning with hands raised — arms lifting during a yawn is not a gesture command"

| Gesture | P | R | F1 | TP | FP | FN |
|---------|------|------|------|----|----|-----|
| OPEN_MENU | 0.870 | 1.000 | 0.930 | 20 | 3 | 0 |
| CLOSE_MENU | 0.741 | 1.000 | 0.851 | 20 | 7 | 0 |
| SWITCH_RIGHT | 0.833 | 1.000 | 0.909 | 15 | 3 | 0 |
| SWITCH_LEFT | 0.750 | 1.000 | 0.857 | 15 | 5 | 0 |

| Category | Iter 2 | Iter 3 | Change |
|----------|--------|--------|--------|
| NEG_WAVE | 100% | 100% | — |
| NEG_PHONE | 100% | 100% | — |
| NEG_STRETCH | 80% | **100%** | ✅ Fixed |
| NEG_HEAD_SCRATCH | 84.2% | 84.2% | Same |
| NEG_OTHER | 70.3% | **81.1%** | ✅ +10.8% |
| NEG_REACH | 0% | 0% | Unchanged |
| **Overall** | **71.6%** | **77.8%** | **+6.2%** |

**TP Recall: 100% (70/70)**

---

## Iteration 4: Reach-Specific Lateral Motion Guidance

**Prompt changes:**
1. Added explicit reach description in rejection list: "hand moves laterally toward a specific target and person's body or gaze shifts toward that object"
2. Added decision guideline emphasis: "Pay special attention to lateral hand movements: a swipe command is performed while facing the screen, whereas reaching involves shifting attention away"

| Gesture | P | R | F1 | TP | FP | FN |
|---------|------|------|------|----|----|-----|
| OPEN_MENU | 0.833 | 1.000 | 0.909 | 20 | 4 | 0 |
| CLOSE_MENU | 0.769 | 1.000 | 0.870 | 20 | 6 | 0 |
| SWITCH_RIGHT | 0.875 | 0.933 | 0.903 | 14 | 2 | **1** |
| SWITCH_LEFT | 0.789 | 1.000 | 0.882 | 15 | 4 | 0 |

| Category | Iter 3 | Iter 4 | Change |
|----------|--------|--------|--------|
| NEG_REACH | 0% | **25% (2/8)** | ✅ Some progress |
| NEG_OTHER | 81.1% | **83.8%** | ✅ Slightly better |
| NEG_STRETCH | 100% | 80% | ❌ Regressed |
| **Overall** | **77.8%** | **80.2%** | +2.4% |

**⚠️ TP Recall: 98.6% (69/70) — FIRST TRUE POSITIVE MISS**

Clip 028 (TP_SWITCH_RIGHT) was incorrectly rejected at conf=0.56. The broad "pay special attention to lateral hand movements" language made Cosmos second-guess a real swipe gesture.

### Tradeoff Analysis

This iteration revealed a critical tradeoff: **tightening rejection criteria for reach motions directly risks rejecting real swipe gestures**, because reaching and swiping are kinematically identical. The decision guideline's broad language about lateral motion created collateral damage on true positives.

For this system, **100% TP recall is more valuable than marginal FP improvement.** A missed intentional gesture breaks user trust ("the system doesn't work"), while an occasional false positive is merely annoying. This informed the approach for the next iteration: revert the broad lateral motion language in the decision guideline while keeping the targeted reach description in the rejection list.

---

## Iteration 5: Refined Reach Guidance (Broad Language Reverted)

**Prompt changes:**
1. Removed the broad decision guideline sentence: "Pay special attention to lateral hand movements..."
2. Kept the targeted reach description in the rejection list with softened language: "the hand extends toward a specific target — look for gaze or body leaning toward the object. If the person is facing the screen and performs a clean lateral swipe, that is still an intentional command even if objects are nearby."

| Gesture | P | R | F1 | TP | FP | FN |
|---------|------|------|------|----|----|-----|
| OPEN_MENU | 0.870 | 1.000 | 0.930 | 20 | 3 | 0 |
| CLOSE_MENU | 0.769 | 1.000 | 0.870 | 20 | 6 | 0 |
| SWITCH_RIGHT | 0.833 | 1.000 | 0.909 | 15 | 3 | 0 |
| SWITCH_LEFT | 0.750 | 1.000 | 0.857 | 15 | 5 | 0 |

| Category | Iter 3 | Iter 4 | Iter 5 | Change vs Best (Iter 3) |
|----------|--------|--------|--------|-------------------------|
| NEG_WAVE | 100% | 100% | 100% | — |
| NEG_PHONE | 100% | 100% | 100% | — |
| NEG_HEAD_SCRATCH | 84.2% | 84.2% | **89.5% (17/19)** | ✅ +5.3% |
| NEG_OTHER | 81.1% | 83.8% | **83.8% (31/37)** | ✅ +2.7% |
| NEG_STRETCH | 100% | 80% | 80% (4/5) | ❌ -20% |
| NEG_REACH | 0% | 25% | 0% (0/8) | Unchanged |
| **Overall** | **77.8%** | **80.2%** | **79.0%** | **+1.2%** |

**TP Recall: 100% (70/70) ✅ — Restored**

### Analysis

Reverting the broad lateral motion language restored 100% TP recall while keeping most of the gains from previous iterations. NEG_HEAD_SCRATCH improved to 89.5% (best yet), and NEG_OTHER held at 83.8%.

NEG_REACH remains at 0% — the targeted reach description in the rejection list was not enough to change Cosmos's behavior on these clips. The motion trajectory is simply too similar to a real swipe for text-based guidance alone to distinguish.

NEG_STRETCH regressed from 100% (Iter 3) to 80%, with one stretch clip misclassified as OPEN_MENU at conf=0.54. This is likely a side effect of the refined reach language affecting how Cosmos weights other motion types.

---

## Iteration 6: Gaze Pre-Gate + Reach Language in Step 2

**Prompt changes:**
1. Restructured prompt with a two-step evaluation framework: Step 1 checks head/face engagement as a hard gate before evaluating hand motion; Step 2 adds note that swipe commands are compact lateral motions, not arm extensions toward objects.

**Result:** Killed early — TP regression on SWITCH_RIGHT (clips 6 and 7 rejected). The reach vs. swipe language in Step 2 contaminated swipe evaluation, the same pattern as Iteration 4.

| Metric | Value |
|--------|-------|
| TP Recall | ~97% (killed early, not full run) |
| Hard Negative Rejection | N/A (incomplete) |
| Status | **Reverted — reach/swipe discriminator language consistently causes TP regression** |

**Decision:** Reverted. Reach/swipe discriminator language in the evaluation path causes TP regression regardless of where it is placed.

---

## Iteration 6b: Gaze Pre-Gate Only (No Reach Language)

**Prompt changes:**
1. Same gaze engagement gate as Iter 6 but removed ALL reach/swipe language from Step 2. Only the pre-gate: check head/face orientation before evaluating hand motion.

**Result:** Killed early — still 1 TP regression (clip 7, SWITCH_RIGHT rejected). Even the gaze gate alone, placed before hand evaluation, primes Cosmos to be suspicious of swipes.

| Metric | Value |
|--------|-------|
| TP Recall | ~98.6% (killed early) |
| Hard Negative Rejection | N/A (incomplete) |
| Status | **Reverted — pre-evaluation gates of any kind contaminate hand motion analysis** |

**Decision:** Reverted. Anything that primes Cosmos to be suspicious *before* it evaluates the hand motion causes collateral damage on real gestures.

---

## Iteration 7: Post-Evaluation Gaze + Reach Destination Sanity Check

**Prompt changes:**
1. Instead of a pre-gate, added a "FINAL SANITY CHECK" block *after* the main evaluation: (1) Is person facing screen? If head turned away, reconsider and lower confidence. (2) Is hand moving toward a specific visible object? Gesture commands are performed in open space without a physical destination.

**Result:** Full run completed.

| Category | Iter 5 | Iter 7 | Change |
|----------|--------|--------|--------|
| NEG_HEAD_SCRATCH | 89.5% (17/19) | **100% (19/19)** | ✅ +10.5% |
| NEG_WAVE | 100% (8/8) | **100% (8/8)** | — |
| NEG_PHONE | 100% (4/4) | **100% (4/4)** | — |
| NEG_STRETCH | 80% (4/5) | **100% (5/5)** | ✅ +20% |
| NEG_OTHER | 83.8% (31/37) | **91.9% (34/37)** | ✅ +8.1% |
| NEG_REACH | 0% (0/8) | **25% (2/8)** | ✅ First progress |
| **Overall** | **79.0%** | **88.9% (72/81)** | **+9.9%** |

**⚠️ TP Recall: 97.1% (68/70) — 2 SWITCH_RIGHT misses (clips 28 and 40)**

**Key insight:** Post-evaluation sanity checks work where pre-gates don't. Cosmos evaluates the hand motion uncontaminated first, then reconsiders. The massive NEG jump (+9.9%) and first-ever REACH progress (25%) confirm the approach. But the assertive "reconsider your assessment" language was strong enough to override 2 confident TP swipe matches.

**Decision:** Not shipped due to TP regression. Established the post-evaluation sanity check as the correct structural approach.

---

## Iteration 8: Softened Sanity Check + Arm Extension Signals

**Prompt changes:**
1. Softened the Iter 7 sanity check language: added "do not let them override a strong gesture match" and "only change your assessment if the gesture match was already weak or ambiguous."
2. Added arm extension / spatial zone signals to the reach check: elbow straightening, hand moving outside the torso area.

**Result:** Full run completed.

| Category | Iter 7 | Iter 8 | Change |
|----------|--------|--------|--------|
| NEG_HEAD_SCRATCH | 100% (19/19) | 89.5% (17/19) | ❌ -10.5% |
| NEG_WAVE | 100% (8/8) | 87.5% (7/8) | ❌ -12.5% |
| NEG_PHONE | 100% (4/4) | **100% (4/4)** | — |
| NEG_STRETCH | 100% (5/5) | **100% (5/5)** | — |
| NEG_OTHER | 91.9% (34/37) | 81.1% (30/37) | ❌ -10.8% |
| NEG_REACH | 25% (2/8) | 12.5% (1/8) | ❌ -12.5% |
| **Overall** | **88.9%** | **79.0% (64/81)** | **-9.9%** |

**TP Recall: 100% (70/70) ✅ — TPs recovered**

**Key insight:** The softened "do not override" language was too permissive — Cosmos stopped applying the sanity check to any case, erasing all NEG gains from Iter 7. Confirmed a clear tradeoff: strong sanity check = high NEG but TP regression; soft sanity check = safe TPs but no NEG improvement. There is no middle ground with simple prompt softening.

**Decision:** Not shipped. Clearly demonstrated the prompt strength tradeoff.

---

## Iteration 9: Assertive Tone + Arm Extension Signals

**Prompt changes:**
1. Combined Iter 7's assertive tone with Iter 8's arm extension signals: "reconsider your assessment and lower your confidence" (assertive, matching Iter 7) plus the biomechanical reach signals (elbow straightening, spatial zone, hand moving toward an object destination).
2. Final sentence: "strongly favor classifying as NOT intentional unless the gesture pattern match is exceptionally clear and unambiguous."

**Result:** Full run completed.

| Category | Iter 7 | Iter 8 | Iter 9 | Change vs Iter 7 |
|----------|--------|--------|--------|------------------|
| NEG_HEAD_SCRATCH | 100% | 89.5% | **100% (19/19)** | ✅ Restored |
| NEG_WAVE | 100% | 87.5% | **100% (8/8)** | ✅ Restored |
| NEG_PHONE | 100% | 100% | **100% (4/4)** | — |
| NEG_STRETCH | 100% | 100% | **100% (5/5)** | — |
| NEG_OTHER | 91.9% | 81.1% | 86.5% (32/37) | ❌ -5.4% — 5 FPs, all CLOSE_MENU at conf=0.74 |
| NEG_REACH | 25% | 12.5% | **25% (2/8)** | ✅ Restored |
| **Overall** | **88.9%** | **79.0%** | **86.4% (70/81)** | -2.5% vs Iter 7 |

**TP Recall: 100% (70/70) ✅**

**Key insight:** The arm extension biomechanical signals allowed assertive language without the TP regression seen in Iter 7. The 5 remaining NEG_OTHER FPs were all classified as CLOSE_MENU — hands ending in fist-like positions from yawning/resting, not deliberate palm-to-fist transitions. This pointed directly at the next iteration.

**Decision:** Strong candidate. Tried one more iteration targeting the CLOSE_MENU FPs specifically.

---

## Iteration 10: CLOSE_MENU Transition Verification ← SHIPPED

**Prompt changes:**
1. Added a third point to the FINAL SANITY CHECK: "If you are about to classify the motion as CLOSE_MENU, verify that you observed a clear deliberate transition from an open palm to a closed fist. Many everyday motions involve a hand lowering, closing, or coming to rest in a fist-like shape (yawning, stretching, resting hands) — these are not CLOSE_MENU. The key indicator is a visible, deliberate palm-to-fist closure performed as a distinct action."

**Result:** Full run completed. **This is the shipped prompt.**

| Category | Iter 9 | Iter 10 | Change |
|----------|--------|---------|--------|
| NEG_HEAD_SCRATCH | 100% (19/19) | **100% (19/19)** | — |
| NEG_WAVE | 100% (8/8) | 87.5% (7/8) | ❌ -12.5% (1 FP as SWITCH_LEFT) |
| NEG_PHONE | 100% (4/4) | **100% (4/4)** | — |
| NEG_STRETCH | 100% (5/5) | **100% (5/5)** | — |
| NEG_OTHER | 86.5% (32/37) | **97.3% (36/37)** | ✅ +10.8% — caught 4 of 5 CLOSE_MENU FPs |
| NEG_REACH | 25% (2/8) | **25% (2/8)** | — |
| **Overall** | **86.4%** | **90.1% (73/81)** | **+3.7%** |

**⚠️ TP Recall: 98.6% (69/70) — 1 SWITCH_RIGHT miss (clip 040)**

**Decision:** Shipped. Best overall performance across 10 iterations. The 1 TP miss is acceptable (user retries the gesture), while 90.1% NEG rejection provides the cleanest training data for the student model. First iteration to exceed 90% overall NEG rejection.

---

## Iteration History Summary

| Iteration | Change | TP Recall | NEG Rejection | Notes |
|-----------|--------|-----------|---------------|-------|
| 0 | Stub mode (no Cosmos) | 100% | 0% | Not real inference |
| 1 | Original prompt (rejection-biased) | ~15% | ~95% | Stopped early |
| 2 | Balanced prompt + gesture descriptions | **100%** | 71.6% | First real results |
| 3 | + Gaze direction + yawning awareness | **100%** | 77.8% | Gaze + yawn helped |
| 4 | + Reach-specific lateral motion guidance | 98.6% ⚠️ | 80.2% | TP regression — too aggressive |
| 5 | Reverted broad language, kept targeted reach | **100%** | 79.0% | Best with 100% TP recall |
| 6 | Pre-evaluation gaze gate + reach/swipe Step 2 | ~97% ⚠️ | N/A | Killed early — TP regression |
| 6b | Pre-evaluation gaze gate only | ~98.6% ⚠️ | N/A | Killed early — TP regression |
| 7 | Post-evaluation sanity check (gaze + reach destination) | 97.1% ⚠️ | 88.9% | NEG breakthrough; TP regression |
| 8 | Softened sanity check + arm extension | **100%** | 79.0% | TPs back; NEG gains erased |
| 9 | Assertive tone + arm extension signals | **100%** | 86.4% | Best 100% TP result |
| 10 | + CLOSE_MENU transition verification | 98.6% ⚠️ | 90.1% | **SHIPPED** — first >90% NEG |

*Each iteration takes minutes, not hours. This is the core advantage of VLM-based verification over traditional ML retraining.*

---

## Remaining Challenges

### NEG_REACH (25% rejection — hardest category)
Reaching across a desk produces lateral hand displacement that is kinematically identical to a swipe gesture. Despite gaze direction hints, arm extension signals, and spatial zone guidance, Cosmos correctly rejects only 2 of 8 reach clips. All false positives in this category have low confidence (0.56–0.69), suggesting Cosmos recognizes the ambiguity but leans toward approval. This is the genuine frontier challenge that validates the need for the teacher-student feedback loop — even a VLM needs additional context beyond static frames to distinguish reaches from swipes.

### NEG_WAVE → SWITCH_LEFT (1 remaining clip)
One wave clip is persistently classified as SWITCH_LEFT across iterations. The lateral hand motion during a conversational wave is near-identical to the swipe command trajectory. This is the same kinematic equivalence problem as NEG_REACH.

### Confidence Threshold Considerations
Once prompt iterations plateau, the next lever is confidence thresholds for student model training. Current analysis suggests lowering from 0.75 to 0.60–0.65 to preserve more training data, as most TP decisions fall in the 0.44–0.78 range while most FP decisions are below 0.75.
