#!/usr/bin/env python3
"""Train the student gesture classifier from Cosmos-labeled JSONL logs.

Reads verifier logs (which contain both feature vectors and Cosmos labels),
filters to high-confidence labels, trains a scikit-learn classifier, evaluates
against a frozen calibration set, and saves if the new model doesn't regress.

Usage:
    python scripts/train_student.py

Output:
    models/student/current_model.joblib   — loaded by student/service.py
    models/student/v{N}_model.joblib      — versioned backup
    models/student/training_log.json      — training metadata
"""

import glob
import json
import sys
import time
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import train_test_split

REPO_ROOT  = Path(__file__).resolve().parents[1]
MODEL_DIR  = REPO_ROOT / "models" / "student"
CALIB_PATH = REPO_ROOT / "data" / "calibration" / "calibration.jsonl"

FEATURE_NAMES = [
    "swipeDisplacement", "swipeDuration", "peakVelocity",
    "fingersExtended", "handSide", "handSpan",
    "wristX", "wristY", "palmFacing",
    "wristVelocityX", "wristVelocityY", "stateConfidence",
]
GESTURE_TYPES = ["OPEN_MENU", "CLOSE_MENU", "SWITCH_RIGHT", "SWITCH_LEFT"]
MIN_SAMPLES   = 20
REGRESS_LIMIT = 0.02   # reject update if calibration accuracy drops by more than this


# ─── Feature encoding ─────────────────────────────────────────────────────────

def features_to_row(features: dict, gesture_type: str) -> list:
    numeric = [float(features.get(n, 0.0)) for n in FEATURE_NAMES]
    onehot  = [1.0 if gesture_type == g else 0.0 for g in GESTURE_TYPES]
    return numeric + onehot


# ─── Log loading and filtering ────────────────────────────────────────────────

def load_labeled_events() -> list[dict]:
    """Read all verifier JSONL logs and return events with usable Cosmos labels."""
    log_paths = list(REPO_ROOT.glob("**/verifier_events.jsonl"))
    if not log_paths:
        print("No verifier_events.jsonl found. Run the verifier and accumulate logs first.")
        sys.exit(1)

    events = []
    for path in log_paths:
        with path.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue

                resp     = record.get("response_json") or {}
                features = record.get("features")

                # Require features vector and a valid Cosmos response
                if not features or not resp:
                    continue
                if not resp.get("schema_valid", True):
                    continue

                cosmos_conf   = resp.get("confidence", 0.0)
                reason        = resp.get("reason_category", "unknown")
                intentional   = resp.get("intentional")
                gesture_type  = features.get("gestureType") or record.get("proposed_intent")

                # Quality filters
                if cosmos_conf < 0.75:
                    continue
                if reason == "unknown":
                    continue
                if intentional is None or gesture_type is None:
                    continue

                events.append({
                    "features":    features,
                    "gesture_type": gesture_type,
                    "label":       int(bool(intentional)),
                    "cosmos_conf": cosmos_conf,
                    "reason":      reason,
                    "event_id":    record.get("event_id", ""),
                })

    return events


def build_matrix(events: list[dict]):
    X = np.array([features_to_row(e["features"], e["gesture_type"]) for e in events],
                 dtype=np.float32)
    y = np.array([e["label"] for e in events], dtype=np.int32)
    return X, y


def load_calibration():
    if not CALIB_PATH.exists():
        return None, None
    events = []
    with CALIB_PATH.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            features     = record.get("features")
            gesture_type = (features or {}).get("gestureType") or record.get("gesture_type")
            label        = record.get("label")
            if features is None or gesture_type is None or label is None:
                continue
            events.append({"features": features, "gesture_type": gesture_type, "label": int(label)})
    if not events:
        return None, None
    return build_matrix(events)


# ─── Training ─────────────────────────────────────────────────────────────────

def train_and_pick(X_train, y_train, X_test, y_test):
    """Train LR and RF; return the better model."""
    results = []
    for name, clf in [
        ("LogisticRegression", LogisticRegression(max_iter=500, class_weight="balanced")),
        ("RandomForest",       RandomForestClassifier(max_depth=3, n_estimators=10,
                                                      class_weight="balanced", random_state=42)),
    ]:
        clf.fit(X_train, y_train)
        acc = (clf.predict(X_test) == y_test).mean()
        print(f"  {name}: test accuracy = {acc:.3f}")
        results.append((acc, name, clf))

    results.sort(key=lambda t: t[0], reverse=True)
    best_acc, best_name, best_clf = results[0]
    print(f"  → Selected: {best_name} (acc={best_acc:.3f})")
    return best_clf, best_name, best_acc


def next_version_num() -> int:
    existing = list(MODEL_DIR.glob("v*_model.joblib"))
    return len(existing) + 1


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("─── Loading labeled events ───")
    events = load_labeled_events()
    print(f"Found {len(events)} usable events (cosmos_confidence ≥ 0.75, reason ≠ unknown)")

    if len(events) < MIN_SAMPLES:
        needed = MIN_SAMPLES - len(events)
        print(f"Not enough data to train. Need {needed} more labeled events (have {len(events)}, need {MIN_SAMPLES}).")
        print("Perform gestures and false-positive motions while the verifier is running to accumulate labels.")
        sys.exit(0)

    pos = sum(e["label"] for e in events)
    neg = len(events) - pos
    print(f"  Intentional: {pos}  |  Not intentional: {neg}")

    X, y = build_matrix(events)

    print("\n─── Calibration set ───")
    calib_X, calib_y = load_calibration()
    if calib_X is not None:
        print(f"Loaded {len(calib_y)} calibration examples from {CALIB_PATH}")
    else:
        print("No calibration set found — using 80/20 train/test split only.")

    print("\n─── Training ───")
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y if pos > 1 and neg > 1 else None
    )
    print(f"Train: {len(y_train)}  |  Test: {len(y_test)}")

    new_model, model_type, test_acc = train_and_pick(X_train, y_train, X_test, y_test)

    print("\n─── Classification report (test set) ───")
    preds = new_model.predict(X_test)
    print(classification_report(y_test, preds, target_names=["not_intentional", "intentional"], zero_division=0))

    print("─── Confusion matrix (test set) ───")
    print(confusion_matrix(y_test, preds))

    # ── Calibration regression check ─────────────────────────────────────────
    calib_acc_old = None
    calib_acc_new = None
    if calib_X is not None:
        calib_acc_new = (new_model.predict(calib_X) == calib_y).mean()
        print(f"\nCalibration set accuracy (new model): {calib_acc_new:.3f}")

        current_path = MODEL_DIR / "current_model.joblib"
        if current_path.exists():
            old_data = joblib.load(current_path)
            old_model = old_data.get("model") if isinstance(old_data, dict) else old_data
            calib_acc_old = (old_model.predict(calib_X) == calib_y).mean()
            print(f"Calibration set accuracy (old model): {calib_acc_old:.3f}")
            if calib_acc_new < calib_acc_old - REGRESS_LIMIT:
                print(f"\nWARNING: New model regresses on calibration set "
                      f"({calib_acc_new:.3f} vs {calib_acc_old:.3f}, limit={REGRESS_LIMIT}).")
                print("Model NOT saved. Investigate training data quality.")
                sys.exit(0)

    # ── Save ─────────────────────────────────────────────────────────────────
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    version_num = next_version_num()
    version_str = f"v{version_num}"

    feature_col_names = FEATURE_NAMES + [f"gesture_{g}" for g in GESTURE_TYPES]
    model_bundle = {
        "model":         new_model,
        "version":       version_str,
        "model_type":    model_type,
        "timestamp":     time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "num_samples":   len(events),
        "test_accuracy": round(float(test_acc), 4),
        "calib_accuracy": round(float(calib_acc_new), 4) if calib_acc_new is not None else None,
        "feature_names": feature_col_names,
    }

    versioned_path = MODEL_DIR / f"{version_str}_model.joblib"
    current_path   = MODEL_DIR / "current_model.joblib"

    joblib.dump(model_bundle, versioned_path)
    joblib.dump(model_bundle, current_path)
    print(f"\nSaved: {versioned_path}")
    print(f"Saved: {current_path}  (loaded by student service)")

    training_log = {
        "version":       version_str,
        "timestamp":     model_bundle["timestamp"],
        "num_samples":   len(events),
        "pos_samples":   pos,
        "neg_samples":   neg,
        "model_type":    model_type,
        "test_accuracy": model_bundle["test_accuracy"],
        "calib_accuracy": model_bundle["calib_accuracy"],
        "calib_acc_old": round(float(calib_acc_old), 4) if calib_acc_old is not None else None,
        "feature_names": feature_col_names,
    }
    log_path = MODEL_DIR / "training_log.json"
    existing_log = []
    if log_path.exists():
        try:
            existing_log = json.loads(log_path.read_text())
        except Exception:
            existing_log = []
    existing_log.append(training_log)
    log_path.write_text(json.dumps(existing_log, indent=2))
    print(f"Appended to: {log_path}")

    print(f"\nDone. Student model {version_str} ready. Restart student service to hot-reload.")


if __name__ == "__main__":
    main()
