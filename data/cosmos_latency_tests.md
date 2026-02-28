# Cosmos Reason 2 Latency Test Results

## Environment

- **Hardware:** DGX Spark (Grace Blackwell GB10, 128GB unified memory)
- **Model:** nvidia/Cosmos-Reason2-8B via vLLM v0.16.0 (aarch64, CUDA 13.0)
- **Serving:** vLLM OpenAI-compatible endpoint on localhost:8000
- **Date:** 2026-02-27

## Setup notes

No pre-built NIM container exists for Cosmos Reason 2. Weights were downloaded from
HuggingFace (nvidia/Cosmos-Reason2-8B, 17.5 GB, gated) and served via vLLM. The GB10
is CUDA capability sm_121a; Triton's bundled ptxas does not know this target, requiring
the host CUDA 13.0 ptxas to be mounted into the container:

```bash
docker run --rm --gpus all \
  -p 8000:8000 \
  -v ~/models/Cosmos-Reason2-8B:/model \
  -v /usr/local/cuda-13.0/bin/ptxas:/usr/local/cuda-13.0/bin/ptxas:ro \
  -e TRITON_PTXAS_PATH=/usr/local/cuda-13.0/bin/ptxas \
  vllm/vllm-openai:v0.16.0-aarch64-cu130 \
  /model \
  --served-model-name nvidia/cosmos-reason2-8b \
  --dtype bfloat16 \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.85
```

Model finishes loading (16.64 GiB weights) in ~90s and reaches ready state after CUDA
graph capture (~180s total startup time).

## Latency measurements

All times are wall-clock round-trip from request send to response received.
Throughput: ~13–14 tok/s on GB10 with bfloat16.

| Scenario | Latency | Prompt Tokens | Notes |
|----------|---------|---------------|-------|
| Text only (cold, 1st request) | 30.9s | 18 | CUDA graph miss, discard |
| Text only (warm) | 3.4s | ~50 | Baseline, no images |
| 1 frame + verify prompt | 5.8s | 836 | Single JPEG, quality=80, 640×480 |
| 4 frames + verify prompt | 7.0s | 1485 | Realistic minimum for evidence window |
| 8 frames + verify prompt | 8.4s | 2596 | Full evidence window |
| Stub (no Cosmos call) | 19ms | N/A | Baseline for comparison |

Frame image cost: ~0.4–0.5s per additional frame (image tokenization + attention).

## Discrimination test results (3/3 correct)

All tests used the same neutral webcam frame (640×480, 6 KB JPEG). Context was
provided as text alongside the image to simulate different scenarios.

| Test | Expected | Verdict | Confidence | Reason Category | Latency |
|------|----------|---------|------------|-----------------|---------|
| Intentional swipe (lateral, arm out, facing screen) | ACCEPT | **ACCEPT ✓** | 0.72 | intentional_command | 7.9s |
| Head scratch (hand toward forehead, away from screen) | REJECT | **REJECT ✓** | 0.55 | tracking_error | 7.2s |
| Conversation wave (palm side-to-side, turned away) | REJECT | **REJECT ✓** | 0.61 | conversation_gesture | 7.1s |

Schema validation: all 3 responses passed. All 7 required fields present, all enum
values valid, confidence in [0, 1].

### Sample rationales

**Test 1 (ACCEPT):**
> "The right hand moves laterally with fingers extended in a controlled manner,
> consistent with a deliberate gesture to switch focus or navigate, and the direct
> arm positioning toward the camera supports intentional interaction."

**Test 2 (REJECT — tracking_error):**
> "The hand is near the forehead and moving away from the screen, which does not
> align with the expected motion for a right switch command, indicating a tracking
> error."

**Test 3 (REJECT — conversation_gesture):**
> "The gesture resembles an open palm moving side to side, which is more indicative
> of a conversational gesture rather than an intentional command to open a menu."

## Key findings

1. **Cosmos correctly discriminates intentional commands from incidental motion** across
   all three scenarios tested.
2. **Schema output is valid and consistent** across all test scenarios. The model
   wraps JSON in markdown code fences; `nim_logic.py` strips them before parsing.
3. **Latency of 5.8–8.4s makes live gating unviable** for responsive gesture control.
   A 7s verification delay is perceptible and disruptive.
4. **Confidence mirrors the local detector's input value** — the model used the
   landmark-based confidence as its anchor and adjusted based on visual context.
   To demonstrate that Cosmos *overrides* the local detector, show it changing
   confidence for hard negatives where the local model was high-confidence but wrong.
5. **reason_category is semantically meaningful** — the model distinguished
   `tracking_error` (motion direction inconsistent with intent) from
   `conversation_gesture` (social context) even with the same image.

## Architecture decision

Latency of ~7s rules out synchronous gating in the live path. Architecture shifted to:

- **Local detector executes immediately** based on local confidence
- **Cosmos verifies asynchronously** after execution
- **Cosmos labels are logged** to JSONL and become training signal for Option 2
  teacher-student loop
- **Safe Mode** (blocks execution until Cosmos responds) retained as an opt-in
  demo mode to show Cosmos reasoning in real time (~7s wait, acceptable for demo)

See `docs/LATENCY_AND_AMBIGUOUS_POLICY.md` for the updated policy specification.
