"""Student classifier service — port 8789.

Provides real-time execute/suppress predictions using a lightweight scikit-learn
model trained on Cosmos-labeled gesture events (teacher-student pipeline).

Modes:
  shadow (default): always returns execute=True; predictions are logged only.
  active:           execute field reflects the actual model prediction.

Set STUDENT_MODE=active to enable suppression.
Model is loaded from models/student/current_model.joblib on first request.
"""

import json
import os
import time
from pathlib import Path

import joblib
import numpy as np
from flask import Flask, jsonify, request

app = Flask(__name__)

REPO_ROOT   = Path(__file__).resolve().parents[1]
MODEL_PATH  = REPO_ROOT / "models" / "student" / "current_model.joblib"
STUDENT_MODE = os.environ.get("STUDENT_MODE", "shadow")

FEATURE_NAMES = [
    "swipeDisplacement", "swipeDuration", "peakVelocity",
    "fingersExtended", "handSide", "handSpan",
    "wristX", "wristY", "palmFacing",
    "wristVelocityX", "wristVelocityY", "stateConfidence",
]
GESTURE_TYPES = ["OPEN_MENU", "CLOSE_MENU", "SWITCH_RIGHT", "SWITCH_LEFT"]

_model         = None
_model_mtime   = None
_model_version = None
_total_preds   = 0


def _load_model_if_needed():
    """Hot-reload model when the file changes on disk."""
    global _model, _model_mtime, _model_version
    if not MODEL_PATH.exists():
        _model = None
        _model_mtime = None
        _model_version = None
        return
    mtime = MODEL_PATH.stat().st_mtime
    if _model is None or mtime != _model_mtime:
        data = joblib.load(MODEL_PATH)
        if isinstance(data, dict):
            _model         = data.get("model")
            _model_version = data.get("version", "unknown")
        else:
            _model         = data
            _model_version = "v?"
        _model_mtime = mtime
        print(f"[student] loaded model version {_model_version}", flush=True)


def _features_to_vector(features: dict, gesture_type: str) -> np.ndarray:
    numeric = [float(features.get(n, 0.0)) for n in FEATURE_NAMES]
    onehot  = [1.0 if gesture_type == g else 0.0 for g in GESTURE_TYPES]
    return np.array(numeric + onehot, dtype=np.float32).reshape(1, -1)


@app.route("/predict", methods=["POST"])
def predict():
    global _total_preds
    _load_model_if_needed()

    body         = request.get_json(force=True, silent=True) or {}
    features     = body.get("features", {})
    gesture_type = body.get("type", "SWITCH_RIGHT")

    if _model is None:
        return jsonify({
            "execute": True, "confidence": 0.0,
            "model_version": None, "mode": STUDENT_MODE,
        })

    x    = _features_to_vector(features, gesture_type)
    pred = bool(_model.predict(x)[0])
    proba = _model.predict_proba(x)[0]
    conf = float(max(proba))

    _total_preds += 1

    # Shadow mode: always execute — predictions are for logging and analysis only
    execute = pred if STUDENT_MODE == "active" else True

    return jsonify({
        "execute":       execute,
        "confidence":    round(conf, 3),
        "model_version": _model_version,
        "mode":          STUDENT_MODE,
    })


@app.route("/status")
def status():
    _load_model_if_needed()
    return jsonify({
        "model_loaded":     _model is not None,
        "model_version":    _model_version,
        "mode":             STUDENT_MODE,
        "total_predictions": _total_preds,
    })


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    print(f"[student] starting on port 8789, mode={STUDENT_MODE}", flush=True)
    app.run(host="0.0.0.0", port=8789, debug=False)
