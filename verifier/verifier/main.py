import json
import os
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .schema_validate import validate_response
from .stub_logic import build_stub_response
from .nim_logic import call_cosmos_nim

# Set NIM_ENABLED=1 to route verify requests through the real Cosmos NIM.
# Leave unset (or set to 0) to use the stub (fast, no GPU required).
NIM_ENABLED = os.environ.get("NIM_ENABLED", "0") == "1"

Intent = Literal["OPEN_MENU", "CLOSE_MENU", "SWITCH_RIGHT", "SWITCH_LEFT"]

REPO_ROOT = Path(__file__).resolve().parents[2]
VERIFIER_LOG_PATH = REPO_ROOT / "verifier" / "logs" / "verifier_events.jsonl"

app = FastAPI(title="Cosmos Gesture Verifier", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class VerifyRequest(BaseModel):
    event_id: str
    proposed_intent: Intent
    frames: list[str] | None = None
    landmark_summary_json: dict[str, Any] | None = None
    local_confidence: float | None = None
    force_reject: bool = False
    policy_hint: str | None = None
    features: dict[str, Any] | None = None           # feature vector from gesture.js extractFeatures
    student_prediction: dict[str, Any] | None = None  # student classifier prediction


class VerifyResponse(BaseModel):
    version: Literal["1.0"]
    proposed_intent: Intent
    final_intent: Literal["OPEN_MENU", "CLOSE_MENU", "SWITCH_RIGHT", "SWITCH_LEFT", "NONE"]
    intentional: bool
    confidence: float
    reason_category: Literal[
        "intentional_command",
        "self_grooming",
        "reaching_object",
        "swatting_insect",
        "conversation_gesture",
        "accidental_motion",
        "tracking_error",
        "unknown",
    ]
    rationale: str

def append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=True) + "\n")
        f.flush()


@app.on_event("startup")
def _ensure_verifier_log_dir() -> None:
    VERIFIER_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/verify", response_model=VerifyResponse)
def verify(req: VerifyRequest, force_reject: bool = Query(default=False)) -> VerifyResponse:
    started = time.perf_counter()
    ts_request_received_unix = time.time()
    log_written = False

    combined_force_reject = force_reject or req.force_reject

    try:
        nim_called = NIM_ENABLED and not combined_force_reject

        if nim_called:
            response_json = call_cosmos_nim(
                proposed_intent=req.proposed_intent,
                frames=req.frames,
                landmark_summary_json=req.landmark_summary_json,
                local_confidence=req.local_confidence,
                force_reject=False,
            )
        else:
            response_json = build_stub_response(
                event_id=req.event_id,
                proposed_intent=req.proposed_intent,
                force_reject=combined_force_reject,
            )

        schema_valid, schema_error = validate_response(response_json)
        latency_ms = round((time.perf_counter() - started) * 1000, 3)
        log_record = {
            "event_id": req.event_id,
            "ts_request_received_unix": ts_request_received_unix,
            "proposed_intent": req.proposed_intent,
            "nim_called": nim_called,
            "latency_ms": latency_ms,
            "response_json": response_json,
            "schema_valid": schema_valid,
            **({"policy_hint": req.policy_hint} if req.policy_hint else {}),
            **({"features": req.features} if req.features else {}),
            **({"student_prediction": req.student_prediction} if req.student_prediction else {}),
            **({"error": schema_error} if schema_error else {}),
        }
        append_jsonl(VERIFIER_LOG_PATH, log_record)
        log_written = True

        if not schema_valid:
            raise HTTPException(status_code=500, detail=f"Schema validation failed: {schema_error}")

        return VerifyResponse(**response_json)

    except HTTPException as exc:
        if not log_written:
            latency_ms = round((time.perf_counter() - started) * 1000, 3)
            append_jsonl(
                VERIFIER_LOG_PATH,
                {
                    "event_id": req.event_id,
                    "ts_request_received_unix": ts_request_received_unix,
                    "proposed_intent": req.proposed_intent,
                    "nim_called": NIM_ENABLED,
                    "latency_ms": latency_ms,
                    "response_json": None,
                    "schema_valid": False,
                    **({"policy_hint": req.policy_hint} if req.policy_hint else {}),
                    "error": exc.detail if hasattr(exc, "detail") else str(exc),
                },
            )
        raise
    except Exception as exc:
        latency_ms = round((time.perf_counter() - started) * 1000, 3)
        append_jsonl(
            VERIFIER_LOG_PATH,
            {
                "event_id": req.event_id,
                "ts_request_received_unix": ts_request_received_unix,
                "proposed_intent": req.proposed_intent,
                "nim_called": NIM_ENABLED,
                "latency_ms": latency_ms,
                "response_json": None,
                "schema_valid": False,
                **({"policy_hint": req.policy_hint} if req.policy_hint else {}),
                "error": str(exc),
            }
        )
        raise HTTPException(status_code=500, detail=str(exc)) from exc
