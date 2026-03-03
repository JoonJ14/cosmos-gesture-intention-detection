# Prompt: Update README Prompt Engineering Section

Edit `README.md`. Update ONLY the "Rapid Iteration via Prompt Engineering" section (`## Rapid Iteration via Prompt Engineering` through the table comparison at the end of that section). Do NOT modify any other part of the README.

## What to change

### 1. Update the opening sentence

Change:
```
We evaluated Cosmos against **151 labeled clips** (70 true positives + 81 hard negatives). Our initial prompt was rejection-biased — it listed every motion to reject but never described what an intentional gesture actually looks like. Result: Cosmos rejected nearly everything, including real intentional gestures. **TP recall was ~15%.**

The fix took under 5 minutes: rewrite the system prompt to add gesture descriptions, signs of intentional intent, and a balanced decision guideline. Zero retraining. Zero data pipeline changes. **TP recall went from ~15% to 100%.**
```

The subsection header should also change from:

`### From Near-Zero to 100% TP Recall in 5 Minutes`

to:

`### From Near-Zero to 100% TP Recall in Minutes`

And the paragraph below it should stay the same (151 clips, fix took 5 min, went from 15% to 100%).

### 2. Replace the iterations table

Change the subsection header from:

`### Five Iterations, ~25 Minutes Total`

to:

`### Ten Iterations, ~50 Minutes Total`

Replace the 5-row table with this 10-row table:

```
| Iteration | Change | TP Recall | NEG Rejection | Notes |
|-----------|--------|-----------|---------------|-------|
| 1 | Original prompt (rejection-biased) | ~15% | ~95% | Stopped early — too aggressive |
| 2 | Balanced prompt + gesture descriptions | **100%** | 71.6% | Fixed in < 5 min |
| 3 | + Gaze direction + yawning awareness | **100%** | 77.8% | Incremental improvement |
| 4 | + Reach-specific lateral motion guidance | 98.6% ⚠️ | 80.2% | TP regression discovered |
| 5 | Reverted broad language, kept targeted reach | **100%** | 79.0% | Restored TP recall |
| 6/6b | Pre-evaluation gaze gates | ~97–99% ⚠️ | N/A | Killed early — pre-gates contaminate |
| 7 | Post-evaluation sanity check (gaze + reach) | 97.1% ⚠️ | 88.9% | NEG breakthrough; TP regression |
| 8 | Softened sanity check + arm extension | **100%** | 79.0% | TPs back; NEG gains erased |
| 9 | Assertive tone + arm extension signals | **100%** | 86.4% | Best 100% TP result |
| 10 | + CLOSE_MENU transition verification | 98.6% ⚠️ | **90.1%** | **SHIPPED** — first >90% NEG |
```

### 3. Replace "The Tradeoff Discovery" subsection

Replace the existing `### The Tradeoff Discovery` paragraph with this expanded version:

```
### Key Discoveries

**Pre-evaluation gates contaminate gesture analysis.** Iterations 6 and 6b tested gaze checks placed *before* the gesture evaluation — as a "Step 1: check gaze, then Step 2: evaluate gesture" structure. Both caused TP regression within the first few clips. Any priming that makes Cosmos suspicious before it evaluates the hand motion causes collateral damage on real gestures.

**Post-evaluation sanity checks work.** Iteration 7 moved the gaze and reach checks to *after* the gesture evaluation as a "FINAL SANITY CHECK" block. NEG rejection jumped from 79.0% to 88.9% — the biggest single-iteration gain in the session. NEG_REACH moved off 0% for the first time. The structural placement matters: evaluate first, reconsider second.

**Prompt strength has a sharp tradeoff.** Iteration 7's assertive language caused 2 TP misses (swipes rejected). Iteration 8 softened it and recovered all TPs — but erased all NEG gains. There is no simple middle ground. Iteration 9 found the balance: assertive language *plus* richer biomechanical signals (arm extension, spatial zone) that give Cosmos enough information to discriminate correctly.

**Targeted per-gesture verification catches category-specific FPs.** Iteration 10 added a CLOSE_MENU-specific check: verify you observed a deliberate palm-to-fist *transition*, not just a hand that ends up closed (catching yawn/rest FPs). NEG_OTHER improved from 86.5% to 97.3%. The lesson: when a specific gesture class generates FPs, describe exactly what distinguishes the intentional version rather than adding general restrictiveness.
```

### 4. Replace "The Hardest Category" subsection

Replace the existing `### The Hardest Category` paragraph with:

```
### The Hardest Category: Reaches (25% rejection — the fundamental limit)

Reaching for nearby objects remains the hardest category — achieving only 25% rejection even at Iteration 10. Lateral hand displacement during a reach is kinematically indistinguishable from a real swipe in sampled frames. All false positives in this category cluster at confidence 0.70–0.71, improved from 0% for couple iterations, suggesting Cosmos recognizes the ambiguity but cannot resolve it from visual frames alone.

This is not a prompt engineering failure — it is the genuine frontier challenge that validates the need for the teacher-student feedback loop. Even a VLM needs ongoing context beyond static frames to distinguish reaches from swipes, which is exactly the use case for the student model learning from Cosmos's labeling over time.
```

### 5. Update the final results summary paragraph

The paragraph immediately before the scalability table currently ends with:
```
For detailed per-iteration metrics and category breakdowns, see [`docs/COSMOS_PERFORMANCE_TRACKING.md`](docs/COSMOS_PERFORMANCE_TRACKING.md) and [`docs/PROMPT_ENGINEERING_LOG.md`](docs/PROMPT_ENGINEERING_LOG.md).
```

Add a brief summary sentence before that link line:
```
**Final shipped result (Iteration 10):** 98.6% TP recall, 90.1% hard negative rejection across 151 evaluation clips (70 true positives + 81 hard negatives across 6 categories).
```

## What NOT to change

- Do not modify anything outside the `## Rapid Iteration via Prompt Engineering` section
- Do not modify the scalability table (`| Scenario | Traditional ML | VLM (Cosmos) |`)
- Do not change any other section headings, the architecture section, the gestures table, the quick start, or the documentation table
- Keep all existing links and formatting conventions
