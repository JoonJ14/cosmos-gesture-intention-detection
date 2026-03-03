#!/usr/bin/env python3
"""Build calibration set from eval results where user and Cosmos labels agree.

Reads data/eval/results/eval_results.json and data/eval/clips/ (to get feature
vectors), then selects clips where the user label and Cosmos response agree:

  TP_X clip:  Cosmos says intentional=True AND final_intent=X  → label=1
  NEG_* clip: Cosmos says intentional=False                    → label=0

Writes data/calibration/calibration.jsonl in the format expected by
scripts/train_student.py for regression-check before deploying student updates.

Usage:
    python scripts/build_calibration.py
"""

import json
import sys
from pathlib import Path

REPO_ROOT    = Path(__file__).resolve().parents[1]
RESULTS_PATH = REPO_ROOT / "data" / "eval" / "results" / "eval_results.json"
CLIPS_DIR    = REPO_ROOT / "data" / "eval" / "clips"
CALIB_PATH   = REPO_ROOT / "data" / "calibration" / "calibration.jsonl"

TP_LABELS = frozenset(["TP_OPEN_MENU", "TP_CLOSE_MENU", "TP_SWITCH_RIGHT", "TP_SWITCH_LEFT"])

LABEL_TO_INTENT = {
    "TP_OPEN_MENU":   "OPEN_MENU",
    "TP_CLOSE_MENU":  "CLOSE_MENU",
    "TP_SWITCH_RIGHT": "SWITCH_RIGHT",
    "TP_SWITCH_LEFT":  "SWITCH_LEFT",
}


def load_clips_by_key():
    """Build (clip_id, label) → clip map from all clip files and session files.

    Keying by (clip_id, label) rather than clip_id alone handles the case where
    two eval sessions reuse the same clip numbering for different recordings.
    Within a single session every (clip_id, label) pair is unique; across sessions
    the same clip_id may appear with a different label, indicating a different clip.
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


def main():
    if not RESULTS_PATH.exists():
        print(f"Results file not found: {RESULTS_PATH}")
        print("Run scripts/eval_cosmos.py first.")
        sys.exit(1)

    with RESULTS_PATH.open() as f:
        data = json.load(f)
    results = data.get("results", [])

    clips_by_key = load_clips_by_key()

    accepted = []
    seen_keys        = set()   # (clip_id, user_label) — unique per recording
    skipped_error    = 0
    skipped_disagree = 0
    skipped_no_feat  = 0
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

        is_tp  = user_label in TP_LABELS
        is_neg = user_label.startswith("NEG_")

        # Determine agreement and assign binary label
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
            label_int = 0
            # Use detected gesture type for the one-hot encoding in the feature vector;
            # fall back to SWITCH_RIGHT as a neutral default for pure non-gesture motion
            clip         = clips_by_key.get((clip_id, user_label), {})
            gesture_type = clip.get("gesture_detected") or "SWITCH_RIGHT"

        else:
            skipped_disagree += 1
            continue

        # Features required — clips without them can't be used for the student model
        clip = clips_by_key.get((clip_id, user_label))
        if not clip or not clip.get("features"):
            skipped_no_feat += 1
            continue

        accepted.append({
            "clip_id":       r["clip_id"],
            "features":      clip["features"],
            "gesture_type":  gesture_type,
            "label":         label_int,
            "user_label":    user_label,
            "cosmos_intent": cosmos_intent,
        })

    CALIB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CALIB_PATH.open("w") as f:
        for record in accepted:
            f.write(json.dumps(record) + "\n")

    tp_count  = sum(1 for r in accepted if r["label"] == 1)
    neg_count = sum(1 for r in accepted if r["label"] == 0)

    print(f"Calibration set written to {CALIB_PATH}")
    print(f"  Accepted:  {len(accepted)}  (intentional: {tp_count}, not intentional: {neg_count})")
    print(f"  Skipped:   {skipped_disagree} disagreements, "
          f"{skipped_no_feat} missing features, {skipped_error} Cosmos errors, "
          f"{skipped_duplicate} duplicate clip_ids")

    if len(accepted) < 10:
        print("\nWARNING: fewer than 10 calibration samples. "
              "Record more eval clips before relying on regression checks.")


if __name__ == "__main__":
    main()
