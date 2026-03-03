"""
Real Cosmos Reason 2 NIM call via vLLM OpenAI-compatible API.

Endpoint: COSMOS_NIM_URL env var (default: http://localhost:8000)
Model:    nvidia/cosmos-reason2-8b (served via vLLM)

Latency benchmarks on DGX Spark GB10 (measured 2026-02-27):
  - 1 frame:  ~5.8s   (836 prompt tokens, ~14 tok/s)
  - 4 frames: ~7.3s  (1485 prompt tokens)
  - 8 frames: ~8.4s  (2596 prompt tokens)
"""

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Literal

COSMOS_NIM_URL = os.environ.get("COSMOS_NIM_URL", "http://localhost:8000")
COSMOS_MODEL = os.environ.get("COSMOS_MODEL", "nvidia/cosmos-reason2-8b")

Intent = Literal["OPEN_MENU", "CLOSE_MENU", "SWITCH_RIGHT", "SWITCH_LEFT"]

SYSTEM_PROMPT = """\
You are a gesture verifier for a webcam-based desktop control system.

SCENE CONTEXT: A person is sitting at a desk in front of a computer with a webcam. They have set up a gesture control system that lets them control their computer with hand motions. The webcam is pointed at them from the front.

THE FOUR GESTURES (what intentional commands look like):
- OPEN_MENU: Person deliberately opens their hand from a fist into a spread palm, facing the camera. The transition from closed to open hand is the key signal.
- CLOSE_MENU: Person deliberately closes their open palm into a fist while facing the camera. The transition from open to closed hand is the key signal.
- SWITCH_RIGHT: Person makes a deliberate lateral swipe motion with their hand, moving across their body. The motion is purposeful with a clear start and end.
- SWITCH_LEFT: Person makes a deliberate lateral swipe motion with their hand, moving across their body in the opposite direction. The motion is purposeful with a clear start and end.

SIGNS OF INTENTIONAL GESTURES:
- The person appears aware they are performing a gesture
- The hand motion has a deliberate, controlled quality
- The motion is directed toward or performed in front of the camera
- There is a clear start and stop to the motion
- The person's attention is generally toward the screen/camera
- The person's gaze is directed at the screen or camera, not at another object or person

SIGNS OF INCIDENTAL MOTION (reject these):
- Self-grooming: scratching head/face, rubbing eyes, adjusting glasses or hair
- Reaching for objects: grabbing a mug, phone, mouse, wiping surfaces
- Conversation: waving while talking to someone else, gesticulating
- Fidgeting: stretching, repositioning hands, cracking knuckles
- The person's attention is clearly directed away from the screen
- The hand motion is a side effect of another activity
- The person's gaze is directed away from the screen — looking at an object, another person, or away from the camera
- Yawning with hands raised — arms lifting during a yawn is not a gesture command
- Reaching for objects: the hand extends toward a specific target (mug, phone, mouse) — look for the person's gaze or body leaning toward the object rather than facing the screen. If the person is facing the screen and performs a clean lateral swipe, that is still an intentional command even if objects are nearby

DECISION GUIDELINE: If the motion looks like the person is deliberately performing one of the four gestures described above for the purpose of controlling their computer, classify it as intentional. If the motion is a byproduct of some other activity, classify it as not intentional. When genuinely uncertain, consider the overall body language and whether the person seems to be interacting with the computer.

FINAL SANITY CHECK: After determining your assessment of the hand motion, verify these things before giving your final answer:
1. The person's head and face are oriented toward the screen/camera. A person giving a gesture command faces their screen. If the person's head is turned away from the screen — toward an object, another person, their lap, or the ceiling — reconsider your assessment and lower your confidence.
2. The hand motion is compact and stays in front of the torso/chest area. If instead the arm is extending outward away from the body (elbow straightening, hand moving toward an object on a desk or shelf, or hand traveling outside the area in front of the chest), this looks like a reach rather than a gesture command. Reaching for objects is not a gesture command — reconsider your assessment and lower your confidence.
3. If you are about to classify the motion as CLOSE_MENU, verify that you observed a clear deliberate transition from an open palm to a closed fist. Many everyday motions involve a hand lowering, closing, or coming to rest in a fist-like shape (yawning, stretching, resting hands) — these are not CLOSE_MENU. The key indicator is a visible, deliberate palm-to-fist closure performed as a distinct action, not a hand that simply ends up closed.
If any check fails, you should strongly favor classifying the motion as NOT intentional unless the gesture pattern match is exceptionally clear and unambiguous.

Output ONLY a JSON object with these fields:
- "version": "1.0"
- "proposed_intent": must match the proposed intent from the input exactly
- "final_intent": one of OPEN_MENU, CLOSE_MENU, SWITCH_RIGHT, SWITCH_LEFT, or NONE
- "intentional": boolean
- "confidence": number between 0 and 1
- "reason_category": exactly one of: intentional_command, self_grooming, reaching_object, swatting_insect, conversation_gesture, accidental_motion, tracking_error, unknown
- "rationale": one concise sentence explaining the decision
- If not intentional, set final_intent to "NONE"\
"""


def _strip_code_fences(text: str) -> str:
    """Strip markdown code fences if the model wraps its JSON response."""
    text = text.strip()
    # Match ```json ... ``` or ``` ... ```
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if match:
        return match.group(1).strip()
    return text


def call_cosmos_nim(
    proposed_intent: Intent,
    frames: list[str] | None = None,
    landmark_summary_json: dict[str, Any] | None = None,
    local_confidence: float | None = None,
    force_reject: bool = False,
) -> dict:
    """
    Call Cosmos Reason 2 via vLLM OpenAI-compatible API and return a response dict
    that validates against shared/schema.json.

    Raises RuntimeError on network failure or unparseable response.
    """
    if force_reject:
        return {
            "version": "1.0",
            "proposed_intent": proposed_intent,
            "final_intent": "NONE",
            "intentional": False,
            "confidence": 0.9,
            "reason_category": "accidental_motion",
            "rationale": "Forced reject is enabled for test validation.",
        }

    context: dict[str, Any] = {"proposed_intent": proposed_intent}
    if local_confidence is not None:
        context["local_confidence"] = local_confidence
    if landmark_summary_json:
        context["landmark_summary"] = landmark_summary_json

    # Build multimodal content: images first, then text context
    content_parts: list[dict] = []
    for frame_b64 in (frames or []):
        content_parts.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{frame_b64}"},
        })
    content_parts.append({"type": "text", "text": json.dumps(context)})

    payload = {
        "model": COSMOS_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content_parts},
        ],
        "max_tokens": 256,
        "temperature": 0.1,
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{COSMOS_NIM_URL}/v1/chat/completions",
        data=data,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Cosmos NIM unreachable at {COSMOS_NIM_URL}: {exc}") from exc

    raw = result["choices"][0]["message"]["content"]
    cleaned = _strip_code_fences(raw)

    try:
        response_json = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Cosmos NIM returned non-JSON: {raw!r}") from exc

    # Ensure required fields are present (schema_validate will do full validation)
    required = {"version", "proposed_intent", "final_intent", "intentional", "confidence", "reason_category", "rationale"}
    missing = required - response_json.keys()
    if missing:
        raise RuntimeError(f"Cosmos NIM response missing fields {missing}: {response_json}")

    return response_json
