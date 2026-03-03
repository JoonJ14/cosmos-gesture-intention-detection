#!/usr/bin/env python3
"""Build calibration set from eval results and live verifier logs.

Sources:
  1. data/eval/results/eval_results.json  — labelled eval clips (existing path)
  2. verifier/logs/verifier_events.jsonl  — live gesture events with Cosmos verdicts

Both sources produce records in the format expected by scripts/train_student.py:
  - "features":     dict of numeric MediaPipe features from gesture.js extractFeatures
  - "gesture_type": intent string used for one-hot encoding
  - "label":        1 (intentional) or 0 (not intentional) per Cosmos verdict

Eval path: clips where user label and Cosmos verdict agree (TP or NEG).
Live path: events where nim_called=True and features were logged by the web app.

Usage:
    python scripts/build_calibration.py
"""

import json
import sys
from pathlib import Path

REPO_ROOT         = Path(__file__).resolve().parents[1]
RESULTS_PATH      = REPO_ROOT / "data" / "eval" / "results" / "eval_results.json"
CLIPS_DIR         = REPO_ROOT / "data" / "eval" / "clips"
CALIB_PATH        = REPO_ROOT / "data" / "calibration" / "calibration.jsonl"
VERIFIER_LOG_PATH = REPO_ROOT / "verifier" / "logs" / "verifier_events.jsonl"

TP_LABELS = frozenset(["TP_OPEN_MENU", "TP_CLOSE_MENU", "TP_SWITCH_RIGHT", "TP_SWITCH_LEFT"])

LABEL_TO_INTENT = {
    "TP_OPEN_MENU":    "OPEN_MENU",
    "TP_CLOSE_MENU":   "CLOSE_MENU",
    "TP_SWITCH_RIGHT": "SWITCH_RIGHT",
    "TP_SWITCH_LEFT":  "SWITCH_LEFT",
}

# All 12 numeric fields the student model expects from gesture.js extractFeatures.
REQUIRED_NUMERIC = frozenset([
    "swipeDisplacement", "swipeDuration", "peakVelocity",
    "fingersExtended", "handSide", "handSpan",
    "wristX", "wristY", "palmFacing",
    "wristVelocityX", "wristVelocityY", "stateConfidence",
])


# ─── Source 1: eval data ──────────────────────────────────────────────────────

def load_clips_by_key():
    """Build (clip_id, label) → clip map from all clip files and session files.

    Keying by (clip_id, label) rather than clip_id alone handles the case where
    two eval sessions reuse the same clip numbering for different recordings.
    """
    clips = {}

    for p in sorted(CLIPS_DIR.glob("clip_*.json")):
        with p.open() as f:
            data = json.load(f)
        if isinstance(data, list):
            for clip in data:
                clips[(clip["clip_id"], clip.get("label", ""))] = clip
        else:
            clips[(data["clip_id"], data.get("label", ""))] = data

    sessions_dir = CLIPS_DIR.parent / "sessions"
    if sessions_dir.exists():
        for p in sorted(sessions_dir.glob("eval_session_*.json")):
            with p.open() as f:
                data = json.load(f)
            if isinstance(data, list):
                for clip in data:
                    clips[(clip["clip_id"], clip.get("label", ""))] = clip

    return clips


def load_eval_events(results, clips_by_key):
    """Process eval result records into calibration format.

    Returns (accepted_list, counters_dict).
    """
    accepted          = []
    seen_keys         = set()
    skipped_error     = 0
    skipped_disagree  = 0
    skipped_no_feat   = 0
    skipped_duplicate = 0

    for r in results:
        clip_id    = r.get("clip_id")
        user_label = r.get("user_label", "")
        key        = (clip_id, user_label)
        if key in seen_keys:
            skipped_duplicate += 1
            continue
        seen_keys.add(key)

        if r.get("cosmos_error"):
            skipped_error += 1
            continue

        cosmos_intl   = r.get("cosmos_intentional")
        cosmos_intent = r.get("cosmos_final_intent")
        is_tp         = user_label in TP_LABELS
        is_neg        = user_label.startswith("NEG_")

        if is_tp:
            expected_intent = LABEL_TO_INTENT[user_label]
            if not (cosmos_intl is True and cosmos_intent == expected_intent):
                skipped_disagree += 1
                continue
            label_int    = 1
            gesture_type = expected_intent

        elif is_neg:
            if cosmos_intl is not False:
                skipped_disagree += 1
                continue
            label_int    = 0
            clip         = clips_by_key.get((clip_id, user_label), {})
            gesture_type = clip.get("gesture_detected") or "SWITCH_RIGHT"

        else:
            skipped_disagree += 1
            continue

        clip = clips_by_key.get((clip_id, user_label))
        if not clip or not clip.get("features"):
            skipped_no_feat += 1
            continue

        accepted.append({
            "clip_id":       clip_id,
            "features":      clip["features"],
            "gesture_type":  gesture_type,
            "label":         label_int,
            "user_label":    user_label,
            "cosmos_intent": cosmos_intent,
        })

    return accepted, {
        "skipped_error":     skipped_error,
        "skipped_disagree":  skipped_disagree,
        "skipped_no_feat":   skipped_no_feat,
        "skipped_duplicate": skipped_duplicate,
    }


# ─── Source 2: live verifier logs ────────────────────────────────────────────

def load_live_events(log_path):
    """Read verifier_events.jsonl and extract calibration records.

    Inclusion criteria:
      - nim_called=True        — real Cosmos NIM verdict, not stub
      - response_json present and schema_valid=True
      - features dict contains all 12 required numeric fields

    Deduplication is by event_id (UUID generated per verify request).

    Returns (accepted_list, counters_dict).
    """
    if not log_path.exists():
        return [], {
            "total_read": 0, "skipped_not_nim": 0,
            "skipped_no_resp": 0, "skipped_no_feat": 0, "skipped_duplicate": 0,
        }

    accepted          = []
    seen_event_ids    = set()
    skipped_not_nim   = 0
    skipped_no_resp   = 0
    skipped_no_feat   = 0
    skipped_duplicate = 0
    total_read        = 0

    with log_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            total_read += 1
            event_id = event.get("event_id")

            if event_id in seen_event_ids:
                skipped_duplicate += 1
                continue
            seen_event_ids.add(event_id)

            # Only real NIM calls carry ground-truth Cosmos verdicts.
            # Stub responses are predictable mocks, not valid training signal.
            if not event.get("nim_called"):
                skipped_not_nim += 1
                continue

            response = event.get("response_json")
            if not response or not event.get("schema_valid"):
                skipped_no_resp += 1
                continue

            intentional = response.get("intentional")
            if intentional is None:
                skipped_no_resp += 1
                continue

            features = event.get("features")
            if not features or not REQUIRED_NUMERIC.issubset(features.keys()):
                skipped_no_feat += 1
                continue

            proposed     = event.get("proposed_intent")
            gesture_type = features.get("gestureType") or proposed or "SWITCH_RIGHT"

            accepted.append({
                "event_id":      event_id,
                "features":      features,
                "gesture_type":  gesture_type,
                "label":         1 if intentional else 0,
                "cosmos_intent": response.get("final_intent"),
            })

    return accepted, {
        "total_read":        total_read,
        "skipped_not_nim":   skipped_not_nim,
        "skipped_no_resp":   skipped_no_resp,
        "skipped_no_feat":   skipped_no_feat,
        "skipped_duplicate": skipped_duplicate,
    }


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    if not RESULTS_PATH.exists():
        print(f"Results file not found: {RESULTS_PATH}")
        print("Run scripts/eval_cosmos.py first.")
        sys.exit(1)

    with RESULTS_PATH.open() as f:
        data = json.load(f)
    results = data.get("results", [])

    clips_by_key = load_clips_by_key()

    eval_accepted, eval_counts = load_eval_events(results, clips_by_key)
    live_accepted, live_counts = load_live_events(VERIFIER_LOG_PATH)

    all_accepted = eval_accepted + live_accepted

    CALIB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CALIB_PATH.open("w") as f:
        for record in all_accepted:
            f.write(json.dumps(record) + "\n")

    def label_counts(lst):
        tp = sum(1 for r in lst if r["label"] == 1)
        return tp, len(lst) - tp

    eval_tp,  eval_neg  = label_counts(eval_accepted)
    live_tp,  live_neg  = label_counts(live_accepted)
    total_tp, total_neg = label_counts(all_accepted)

    print(f"Calibration set written to {CALIB_PATH}")
    print()
    print(f"  Eval data:   {len(eval_accepted):>5} events  "
          f"(intentional: {eval_tp}, not intentional: {eval_neg})")
    print(f"    Skipped: {eval_counts['skipped_disagree']} disagreements, "
          f"{eval_counts['skipped_no_feat']} missing features, "
          f"{eval_counts['skipped_error']} Cosmos errors, "
          f"{eval_counts['skipped_duplicate']} duplicates")
    print()

    if VERIFIER_LOG_PATH.exists():
        print(f"  Live logs:   {len(live_accepted):>5} events  "
              f"(intentional: {live_tp}, not intentional: {live_neg})")
        print(f"    Read {live_counts['total_read']} lines — skipped: "
              f"{live_counts['skipped_not_nim']} non-NIM, "
              f"{live_counts['skipped_no_resp']} no/invalid response, "
              f"{live_counts['skipped_no_feat']} missing features, "
              f"{live_counts['skipped_duplicate']} duplicates")
    else:
        print(f"  Live logs:       0 events  "
              f"({VERIFIER_LOG_PATH} not found — "
              f"run verifier with NIM_ENABLED=1 to accumulate live data)")
    print()
    print(f"  Total:       {len(all_accepted):>5} events  "
          f"(intentional: {total_tp}, not intentional: {total_neg})")

    if len(all_accepted) < 10:
        print("\nWARNING: fewer than 10 calibration samples. "
              "Record more eval clips before relying on regression checks.")


if __name__ == "__main__":
    main()
