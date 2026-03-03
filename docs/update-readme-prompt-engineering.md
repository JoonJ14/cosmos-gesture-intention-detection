# Update README: Add Prompt Engineering Narrative

## Context

This is for the NVIDIA Cosmos Cookoff 2026 competition submission (deadline March 5). The project is a webcam gesture control system that uses Cosmos Reason 2 as an intent verifier. We went through 5 prompt engineering iterations that demonstrate why VLMs are superior to traditional ML for this problem.

## What to do

Update `README.md` to add a new section that tells the prompt engineering story as a key selling point. This section should go AFTER the "Why Cosmos Is Necessary" section and BEFORE "Quick Start". Call it something like "## Rapid Iteration via Prompt Engineering".

The story to tell:

1. During evaluation with 151 test clips (70 true positives, 81 hard negatives), our initial Cosmos prompt was rejection-biased — it described what to reject but never described what intentional gestures actually look like. Result: Cosmos rejected nearly every gesture, including real intentional ones. TP recall was near zero.

2. We fixed this in under 5 minutes by rewriting the system prompt to include gesture descriptions, signs of intentional gestures, and a balanced decision guideline. Zero retraining, zero data pipeline changes. TP recall went from ~15% to 100%.

3. Over 5 prompt iterations (~25 minutes total), we incrementally improved hard negative rejection from 71.6% to 79.0% by adding gaze direction awareness, yawning recognition, and reach-specific guidance — each taking under 5 minutes.

4. In Iteration 4, we discovered a critical precision-recall tradeoff: tightening rejection for reach motions caused a true positive to be incorrectly rejected (TP recall dropped to 98.6%). We made a principled decision to prioritize TP recall (user trust) over marginal FP improvement, reverted the problematic change, and refined the approach in Iteration 5 to restore 100% TP recall while keeping most of the gains. This kind of rapid experimentation, discovery, and rollback is only possible with VLM-based verification — with traditional ML, each cycle would take hours or days.

5. The hardest category (reaching for objects, 0% rejection) is kinematically identical to swipe gestures — this represents the genuine frontier challenge that validates the teacher-student feedback loop architecture.

6. Scalability: adding a new gesture or false positive category requires adding a few sentences to the prompt, not collecting data and retraining.

Include a small comparison table:

| Scenario | Traditional ML | VLM (Cosmos) |
|----------|---------------|--------------|
| Fix bad classification | Retrain (hours/days) | Edit prompt (minutes) |
| Add new gesture | Collect data + retrain | Add text description |
| Add false positive category | Collect negatives + retrain | Add sentence to prompt |
| Discover tradeoffs | Multiple retrain cycles | Run eval, compare, revert in minutes |

Also update the existing "Why Cosmos Is Necessary" section to briefly mention that Cosmos provides not just better accuracy but dramatically faster iteration cycles compared to traditional ML approaches.

For detailed iteration-by-iteration results, reference `docs/COSMOS_PERFORMANCE_TRACKING.md` and `docs/PROMPT_ENGINEERING_LOG.md`.

## Important

**NOTE: Prompt engineering is still ongoing.** The numbers in this prompt reflect our results as of Iteration 5 but may be outdated by the time you feed this to Claude Code. Before running this prompt, update the iteration count, final TP recall, NEG rejection rate, and any narrative details to match the actual final results from `docs/COSMOS_PERFORMANCE_TRACKING.md`.

Do NOT remove or significantly alter any existing README content — this is additive. Keep the existing structure, tone, and technical detail. The README already has a good technical voice; match it.

Do NOT touch any code files. This is a README-only change.
