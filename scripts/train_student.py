#!/usr/bin/env python3
"""Train the student gesture classifier from a calibration JSONL dataset.

Reads a pre-filtered calibration file (produced by build_calibration.py),
trains a scikit-learn classifier, evaluates against a frozen calibration set,
and saves if the new model doesn't regress.

Usage:
    python scripts/train_student.py
    python scripts/train_student.py --data path/to/custom.jsonl

Output:
    models/student/current_model.joblib   — loaded by student/service.py
    models/student/v{N}_model.joblib      — versioned backup
    models/student/training_log.json      — training metadata
"""

import argparse
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

REPO_ROOT         = Path(__file__).resolve().parents[1]
MODEL_DIR         = REPO_ROOT / "models" / "student"
CALIB_PATH        = REPO_ROOT / "data" / "calibration" / "calibration.jsonl"
DEFAULT_DATA_PATH = CALIB_PATH

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


# ─── Data loading ─────────────────────────────────────────────────────────────

def load_jsonl_events(path: Path) -> list[dict]:
    """Load events from a calibration-format JSONL file.

    Each line is expected to have:
      - "features": dict of numeric feature values (including "gestureType")
      - "gesture_type": gesture class string (top-level fallback)
      - "label": 0 or 1

    No threshold filtering is applied — the calibration file is assumed to be
    pre-filtered by build_calibration.py.
    """
    if not path.exists():
        print(f"Data file not found: {path}")
        sys.exit(1)

    events = []
    with path.open() as f:
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

            events.append({
                "features":     features,
                "gesture_type": gesture_type,
                "label":        int(label),
            })

    return events


def build_matrix(events: list[dict]):
    X = np.array([features_to_row(e["features"], e["gesture_type"]) for e in events],
                 dtype=np.float32)
    y = np.array([e["label"] for e in events], dtype=np.int32)
    return X, y


def load_calibration(path: Path = CALIB_PATH):
    if not path.exists():
        return None, None
    events = load_jsonl_events(path)
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
    parser = argparse.ArgumentParser(description="Train student gesture classifier from a calibration JSONL dataset.")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA_PATH,
                        help="Path to training data JSONL in calibration format "
                             "(default: data/calibration/calibration.jsonl). "
                             "Produced by build_calibration.py; no threshold filtering is applied here.")
    args = parser.parse_args()

    print("─── Loading training data ───")
    print(f"Source: {args.data}")
    events = load_jsonl_events(args.data)
    print(f"Loaded {len(events)} samples")

    if len(events) < MIN_SAMPLES:
        needed = MIN_SAMPLES - len(events)
        print(f"Not enough data to train. Need {needed} more labeled events (have {len(events)}, need {MIN_SAMPLES}).")
        print("Perform gestures and false-positive motions while the verifier is running to accumulate labels.")
        sys.exit(0)

    pos = sum(e["label"] for e in events)
    neg = len(events) - pos
    print(f"  Intentional: {pos}  |  Not intentional: {neg}")

    X, y = build_matrix(events)

    # ── DIAGNOSTICS ──────────────────────────────────────────────────────────
    print("\n─── DIAGNOSTIC (1): Label encoding ───")
    raw_records = []
    with args.data.open() as _f:
        for _line in _f:
            _line = _line.strip()
            if _line:
                try:
                    raw_records.append(json.loads(_line))
                except json.JSONDecodeError:
                    pass
    for lv in [0, 1]:
        samples = [(r.get("label"), r.get("user_label"), r.get("cosmos_intent"))
                   for r in raw_records if r.get("label") == lv]
        print(f"  label={lv}: {len(samples)} records  first 3: {samples[:3]}")

    # check for records that share the same clip_id with conflicting labels
    from collections import defaultdict
    clip_labels = defaultdict(set)
    for r in raw_records:
        clip_labels[r.get("clip_id")].add(r.get("label"))
    conflicts = {cid: lbls for cid, lbls in clip_labels.items() if len(lbls) > 1}
    print(f"  Clips with conflicting labels (same clip_id, both 0 and 1): {len(conflicts)}")
    for cid, lbls in list(conflicts.items())[:5]:
        print(f"    {cid}: labels={lbls}")

    # check for feature-identical rows with different labels
    from collections import Counter
    row_strs = [",".join(f"{v:.6g}" for v in X[i]) for i in range(len(X))]
    row_label_pairs = Counter(zip(row_strs, y.tolist()))
    row_groups = defaultdict(set)
    for (row_str, lbl), _ in row_label_pairs.items():
        row_groups[row_str].add(lbl)
    feat_conflicts = {rs: lbls for rs, lbls in row_groups.items() if len(lbls) > 1}
    print(f"  Feature-identical rows with different labels: {len(feat_conflicts)}")

    print("\n─── DIAGNOSTIC (2): First 3 feature vectors ───")
    col_names = FEATURE_NAMES + [f"gesture_{g}" for g in GESTURE_TYPES]
    for i in range(min(3, len(events))):
        print(f"  Sample {i}: gesture_type={events[i]['gesture_type']!r}  label={y[i]}")
        for name, val in zip(col_names, X[i]):
            print(f"    {name:22s} = {val:.4f}")

    print("\n─── DIAGNOSTIC (3): Shape and value ranges ───")
    expected_len = len(FEATURE_NAMES) + len(GESTURE_TYPES)
    sample_row = features_to_row(events[0]["features"], events[0]["gesture_type"])
    print(f"  X shape: {X.shape}  y shape: {y.shape}")
    print(f"  Expected vector length: {len(FEATURE_NAMES)} numeric + {len(GESTURE_TYPES)} one-hot = {expected_len}")
    print(f"  features_to_row() actual length: {len(sample_row)}  {'OK' if len(sample_row) == expected_len else 'MISMATCH!'}")
    print(f"  NaNs in X: {np.isnan(X).any()}")
    print(f"  All-zero rows: {(X == 0).all(axis=1).sum()} of {len(X)}")
    print(f"  {'Feature':<22}  {'min':>8}  {'max':>8}  {'mean':>8}  nonzero")
    for i, name in enumerate(col_names):
        col = X[:, i]
        print(f"  {name:<22}  {col.min():>8.4f}  {col.max():>8.4f}  {col.mean():>8.4f}  {np.count_nonzero(col)}/{len(col)}")
    print("─── END DIAGNOSTICS ───\n")
    # ─────────────────────────────────────────────────────────────────────────

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
