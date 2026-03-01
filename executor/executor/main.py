import json
import platform
import subprocess
import time
from pathlib import Path
from typing import Literal
from uuid import uuid4

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

Intent = Literal["OPEN_MENU", "CLOSE_MENU", "SWITCH_RIGHT", "SWITCH_LEFT"]

REPO_ROOT = Path(__file__).resolve().parents[2]
ACTIONS_PATH = REPO_ROOT / "executor" / "actions.yaml"
EXECUTOR_LOG_PATH = REPO_ROOT / "executor" / "logs" / "executor_events.jsonl"

app = FastAPI(title="Cosmos Gesture Executor", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ExecuteRequest(BaseModel):
    intent: Intent
    event_id: str | None = None
    dry_run: bool = False
    source: str = "web"
    features: dict | None = None           # feature vector from gesture.js extractFeatures
    student_prediction: dict | None = None  # student classifier prediction


class ExecuteResponse(BaseModel):
    ok: bool
    executed: bool
    intent: Intent
    event_id: str
    key_combo: str
    detail: str


def _detect_os_key() -> str:
    system = platform.system().lower()
    if system == "linux":
        return "linux"
    if system == "darwin":
        return "macos"
    raise RuntimeError(f"Unsupported operating system: {system}")


def _load_actions() -> dict:
    if not ACTIONS_PATH.exists():
        raise RuntimeError(f"Missing actions config: {ACTIONS_PATH}")
    with ACTIONS_PATH.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise RuntimeError("actions.yaml must contain a top-level object")
    return data


def _key_combo_for_intent(intent: Intent, os_key: str) -> str:
    actions = _load_actions()
    os_actions = actions.get(os_key)
    if not isinstance(os_actions, dict):
        raise RuntimeError(f"Missing '{os_key}' key mappings in actions.yaml")
    key_combo = os_actions.get(intent)
    if not isinstance(key_combo, str) or not key_combo:
        raise RuntimeError(f"Missing key mapping for intent '{intent}' on OS '{os_key}'")
    return key_combo


def _macos_osascript_for_combo(combo: str) -> str:
    parts = [p.strip() for p in combo.split("+") if p.strip()]
    if not parts:
        raise RuntimeError(f"Invalid key combo: {combo}")

    key_token = parts[-1].lower()
    modifier_tokens = [p.lower() for p in parts[:-1]]

    modifiers_map = {
        "ctrl": "control down",
        "control": "control down",
        "cmd": "command down",
        "command": "command down",
        "shift": "shift down",
        "alt": "option down",
        "option": "option down",
    }

    modifiers = []
    for token in modifier_tokens:
        if token not in modifiers_map:
            raise RuntimeError(f"Unsupported macOS modifier in combo '{combo}': {token}")
        modifiers.append(modifiers_map[token])

    special_key_codes = {
        "right": 124,
        "left": 123,
        "up": 126,
        "down": 125,
        "escape": 53,
        "esc": 53,
        "space": 49,
        "return": 36,
        "enter": 36,
    }

    using_clause = ""
    if modifiers:
        using_clause = " using {" + ", ".join(modifiers) + "}"

    if key_token in special_key_codes:
        return (
            'tell application "System Events"\n'
            f"  key code {special_key_codes[key_token]}{using_clause}\n"
            "end tell"
        )

    if len(key_token) == 1:
        escaped = key_token.replace('"', '\\"')
        return (
            'tell application "System Events"\n'
            f'  keystroke "{escaped}"{using_clause}\n'
            "end tell"
        )

    raise RuntimeError(f"Unsupported macOS key token in combo '{combo}': {key_token}")


def _execute_linux(key_combo: str) -> None:
    subprocess.run(["xdotool", "key", key_combo], check=True)


def _execute_macos(key_combo: str) -> None:
    script = _macos_osascript_for_combo(key_combo)
    subprocess.run(["osascript", "-e", script], check=True)


def append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=True) + "\n")
        f.flush()


@app.on_event("startup")
def _ensure_executor_log_dir() -> None:
    EXECUTOR_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/execute", response_model=ExecuteResponse)
def execute(req: ExecuteRequest) -> ExecuteResponse:
    started = time.perf_counter()
    ts_unix = time.time()
    event_id = req.event_id or str(uuid4())

    try:
        os_key = _detect_os_key()
        key_combo = _key_combo_for_intent(req.intent, os_key)

        executed = False
        detail = "dry run: no key event sent"

        if not req.dry_run:
            if os_key == "linux":
                _execute_linux(key_combo)
            elif os_key == "macos":
                _execute_macos(key_combo)
            else:
                raise RuntimeError(f"Unsupported operating system key: {os_key}")
            executed = True
            detail = "key event dispatched"

        latency_ms = round((time.perf_counter() - started) * 1000, 3)
        append_jsonl(
            EXECUTOR_LOG_PATH,
            {
                "event_id": event_id,
                "ts_unix": ts_unix,
                "intent": req.intent,
                "key_combo": key_combo,
                "executed": executed,
                "dry_run": req.dry_run,
                "source": req.source,
                "os_name": os_key,
                "latency_ms": latency_ms,
                **({"features": req.features} if req.features else {}),
                **({"student_prediction": req.student_prediction} if req.student_prediction else {}),
            }
        )

        return ExecuteResponse(
            ok=True,
            executed=executed,
            intent=req.intent,
            event_id=event_id,
            key_combo=key_combo,
            detail=detail,
        )

    except subprocess.CalledProcessError as exc:
        latency_ms = round((time.perf_counter() - started) * 1000, 3)
        error_msg = f"Command failed: {exc}"
        append_jsonl(
            EXECUTOR_LOG_PATH,
            {
                "event_id": event_id,
                "ts_unix": ts_unix,
                "intent": req.intent,
                "key_combo": "",
                "executed": False,
                "dry_run": req.dry_run,
                "source": req.source,
                "os_name": platform.system().lower(),
                "latency_ms": latency_ms,
                "error": error_msg,
            }
        )
        raise HTTPException(status_code=500, detail=error_msg) from exc

    except Exception as exc:
        latency_ms = round((time.perf_counter() - started) * 1000, 3)
        error_msg = str(exc)
        append_jsonl(
            EXECUTOR_LOG_PATH,
            {
                "event_id": event_id,
                "ts_unix": ts_unix,
                "intent": req.intent,
                "key_combo": "",
                "executed": False,
                "dry_run": req.dry_run,
                "source": req.source,
                "os_name": platform.system().lower(),
                "latency_ms": latency_ms,
                "error": error_msg,
            }
        )
        raise HTTPException(status_code=500, detail=error_msg) from exc
