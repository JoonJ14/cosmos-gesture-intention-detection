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

## Iteration History Summary

| Iteration | Change | TP Recall | NEG Rejection | Notes |
|-----------|--------|-----------|---------------|-------|
| 0 | Stub mode (no Cosmos) | 100% | 0% | Not real inference |
| 1 | Original prompt (rejection-biased) | ~15% | ~95% | Stopped early |
| 2 | Balanced prompt + gesture descriptions | **100%** | 71.6% | First real results |
| 3 | + Gaze direction + yawning awareness | **100%** | 77.8% | Gaze + yawn helped |
| 4 | + Reach-specific lateral motion guidance | 98.6% ⚠️ | 80.2% | TP regression — too aggressive |
| 5 | Reverted broad language, kept targeted reach | **100%** | 79.0% | Best with 100% TP recall |

*Each iteration takes minutes, not hours. This is the core advantage of VLM-based verification over traditional ML retraining.*

---

## Remaining Challenges

### NEG_REACH (0% rejection — hardest category)
Reaching across a desk produces lateral hand displacement that is kinematically identical to a swipe gesture. Despite gaze direction hints and targeted reach descriptions, Cosmos cannot distinguish the two from 8 sampled frames alone. All false positives in this category have low confidence (0.56-0.69), suggesting Cosmos recognizes ambiguity but leans toward approval. This is arguably the genuine frontier challenge that validates the need for the teacher-student feedback loop — even a VLM needs additional context beyond static frames.

### NEG_OTHER → CLOSE_MENU (6 remaining clips)
These are yawning clips where hands come down in a fist-like position, resembling the palm→fist transition of CLOSE_MENU. Reduced from 9 (Iter 2) to 7 (Iter 3) to 6 (Iter 4-5) through prompt improvements.

### Confidence Threshold Considerations
Once prompt iterations plateau, the next lever is confidence thresholds for student model training. Current analysis suggests lowering from 0.75 to 0.60-0.65 to preserve more training data, as most TP decisions fall in the 0.44-0.78 range while most FP decisions are below 0.75.
