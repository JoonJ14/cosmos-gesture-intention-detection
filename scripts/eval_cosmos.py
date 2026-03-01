#!/usr/bin/env python3
"""Batch Cosmos evaluation for recorded eval clips.

Reads all clip JSON files from data/eval/clips/ (or a session JSON downloaded
from the web app), sends each clip to the verifier service, collects Cosmos
responses, and writes a results file with per-clip labels.

Prints a precision/recall/F1 table and confusion matrix.

Usage:
    python scripts/eval_cosmos.py
    python scripts/eval_cosmos.py --verifier http://192.168.1.250:8788
    python scripts/eval_cosmos.py --clips data/eval/clips/eval_session_2026-03-01.json

The results from this script are the metrics table for the competition submission.
Feed the output to scripts/build_calibration.py to generate the frozen
calibration set for student model regression checks.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT   = Path(__file__).resolve().parents[1]
CLIPS_DIR   = REPO_ROOT / "data" / "eval" / "clips"
RESULTS_DIR = REPO_ROOT / "data" / "eval" / "results"

# For clips with no gesture_detected, map label to a plausible proposed_intent
LABEL_DEFAULT_INTENT = {
    "TP_OPEN_MENU":     "OPEN_MENU",
    "TP_CLOSE_MENU":    "CLOSE_MENU",
    "TP_SWITCH_RIGHT":  "SWITCH_RIGHT",
    "TP_SWITCH_LEFT":   "SWITCH_LEFT",
    "NEG_HEAD_SCRATCH": "OPEN_MENU",
    "NEG_REACH":        "SWITCH_RIGHT",
    "NEG_WAVE":         "OPEN_MENU",
    "NEG_PHONE":        "SWITCH_RIGHT",
    "NEG_STRETCH":      "SWITCH_RIGHT",
    "NEG_OTHER":        "SWITCH_RIGHT",
}

TP_LABELS = frozenset(["TP_OPEN_MENU", "TP_CLOSE_MENU", "TP_SWITCH_RIGHT", "TP_SWITCH_LEFT"])


# ─── Clip loading ──────────────────────────────────────────────────────────────

def load_clips(extra_path=None):
    """Load clips from extra_path, or from all clip_*.json files in CLIPS_DIR,
    or from all eval_session_*.json files in sessions/."""
    clips = []

    if extra_path:
        p = Path(extra_path)
        with p.open() as f:
            data = json.load(f)
        clips = data if isinstance(data, list) else [data]
        return clips

    # Individual clip files
    for p in sorted(CLIPS_DIR.glob("clip_*.json")):
        with p.open() as f:
            data = json.load(f)
        if isinstance(data, list):
            clips.extend(data)
        else:
            clips.append(data)

    # Session files (downloaded from browser)
    sessions_dir = CLIPS_DIR.parent / "sessions"
    if sessions_dir.exists():
        for p in sorted(sessions_dir.glob("eval_session_*.json")):
            with p.open() as f:
                data = json.load(f)
            if isinstance(data, list):
                clips.extend(data)
            else:
                clips.append(data)

    return clips


# ─── Verifier call ────────────────────────────────────────────────────────────

def send_to_verifier(clip, verifier_url):
    """POST clip to /verify endpoint and return the parsed response dict."""
    label            = clip.get("label", "")
    proposed_intent  = (clip.get("gesture_detected")
                        or LABEL_DEFAULT_INTENT.get(label, "SWITCH_RIGHT"))
    payload = {
        "event_id":         clip["clip_id"],
        "proposed_intent":  proposed_intent,
        "local_confidence": clip.get("confidence") or 0.7,
    }
    if clip.get("frames"):
        payload["frames"] = clip["frames"]
    if clip.get("features"):
        payload["landmark_summary_json"] = clip.get("metadata", {})

    data = json.dumps(payload).encode()
    req  = urllib.request.Request(
        f"{verifier_url}/verify",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.reason}"}
    except Exception as e:
        return {"error": str(e)}


# ─── Metrics ──────────────────────────────────────────────────────────────────

def compute_metrics(results):
    """Compute per-gesture-type precision/recall/F1.

    For gesture X:
      TP: user=TP_X AND Cosmos says intentional=True AND final_intent=X
      FN: user=TP_X AND Cosmos disagrees
      FP: any clip where Cosmos says intentional=True AND final_intent=X but user != TP_X
      TN: user=NEG_* AND Cosmos says intentional=False
    """
    gesture_types = ["OPEN_MENU", "CLOSE_MENU", "SWITCH_RIGHT", "SWITCH_LEFT"]
    metrics = {}
    for g in gesture_types:
        tp = fp = fn = tn = 0
        for r in results:
            if r.get("cosmos_error"):
                continue
            user_label    = r.get("user_label", "")
            cosmos_intl   = r.get("cosmos_intentional", False)
            cosmos_intent = r.get("cosmos_final_intent", "NONE")

            user_is_this  = user_label == f"TP_{g}"
            user_is_neg   = user_label.startswith("NEG_")
            cosmos_fired  = cosmos_intl and cosmos_intent == g

            if user_is_this:
                if cosmos_fired:
                    tp += 1
                else:
                    fn += 1
            elif cosmos_fired:
                fp += 1
            elif user_is_neg and not cosmos_intl:
                tn += 1

        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall    = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1        = (2 * precision * recall / (precision + recall)
                     if (precision + recall) > 0 else 0.0)
        metrics[g] = {
            "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": precision, "recall": recall, "f1": f1,
        }
    return metrics


def print_metrics(metrics, results):
    errors = sum(1 for r in results if r.get("cosmos_error"))
    valid  = len(results) - errors

    print("\n═══ Precision / Recall / F1 ════════════════════════════════")
    print(f"{'Gesture':<16} {'P':>6} {'R':>6} {'F1':>6} {'TP':>4} {'FP':>4} {'FN':>4} {'TN':>4}")
    print("─" * 60)
    for g, m in metrics.items():
        print(
            f"{g:<16} {m['precision']:>6.3f} {m['recall']:>6.3f} {m['f1']:>6.3f}"
            f" {m['tp']:>4} {m['fp']:>4} {m['fn']:>4} {m['tn']:>4}",
        )
    print(f"\nTotal clips: {len(results)}  |  Valid: {valid}  |  Errors: {errors}")


def print_confusion_matrix(results):
    """Print user label (rows) vs Cosmos prediction (columns)."""
    all_labels = sorted({r.get("user_label", "?") for r in results if not r.get("cosmos_error")})
    cosmos_cols = ["OPEN_MENU", "CLOSE_MENU", "SWITCH_RIGHT", "SWITCH_LEFT", "NONE/reject"]

    counts = {}
    for r in results:
        if r.get("cosmos_error"):
            continue
        row = r.get("user_label", "?")
        ci  = r.get("cosmos_final_intent", "NONE")
        ci_intl = r.get("cosmos_intentional", False)
        col = ci if (ci_intl and ci in cosmos_cols) else "NONE/reject"
        counts[(row, col)] = counts.get((row, col), 0) + 1

    col_w = 14
    print("\n═══ Confusion Matrix (rows=user label, cols=Cosmos) ════════")
    header = f"{'User \\ Cosmos':<20}" + "".join(f"{c:>{col_w}}" for c in cosmos_cols)
    print(header)
    print("─" * len(header))
    for row in all_labels:
        line = f"{row:<20}"
        for col in cosmos_cols:
            line += f"{counts.get((row, col), 0):>{col_w}}"
        print(line)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Batch Cosmos eval for recorded clips")
    parser.add_argument(
        "--verifier", default="http://localhost:8788",
        help="Verifier base URL (default: http://localhost:8788)",
    )
    parser.add_argument(
        "--clips", default=None,
        help="Path to a specific session JSON file (default: scan data/eval/clips/)",
    )
    parser.add_argument(
        "--sleep", type=float, default=1.0,
        help="Seconds to sleep between Cosmos calls to avoid hammering the GPU (default: 1.0)",
    )
    args = parser.parse_args()

    clips = load_clips(args.clips)
    if not clips:
        print(f"No clips found. Record clips with the web app, then download and place them in "
              f"{CLIPS_DIR} or pass --clips path/to/session.json")
        sys.exit(1)

    labeled = [c for c in clips if c.get("label") and c["label"] != "unlabeled"]
    print(f"Loaded {len(clips)} clips ({len(labeled)} labeled, {len(clips) - len(labeled)} unlabeled).")
    if len(labeled) < len(clips):
        print(f"  Skipping {len(clips) - len(labeled)} unlabeled clips.")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    results = []
    for i, clip in enumerate(labeled):
        label = clip.get("label", "?")
        print(
            f"[{i+1}/{len(labeled)}] {clip['clip_id']}  label={label}"
            f"  frames={clip.get('num_frames', 0)} ...",
            end="  ", flush=True,
        )

        resp         = send_to_verifier(clip, args.verifier)
        cosmos_error = "error" in resp

        result = {
            "clip_id":             clip["clip_id"],
            "user_label":          label,
            "user_category":       clip.get("category"),
            "gesture_detected":    clip.get("gesture_detected"),
            "cosmos_intentional":  resp.get("intentional"),
            "cosmos_final_intent": resp.get("final_intent"),
            "cosmos_confidence":   resp.get("confidence"),
            "cosmos_reason":       resp.get("reason_category"),
            "cosmos_error":        cosmos_error,
            "cosmos_error_msg":    resp.get("error") if cosmos_error else None,
        }
        results.append(result)

        if cosmos_error:
            print(f"ERROR: {resp['error']}")
        else:
            print(
                f"intentional={resp.get('intentional')}"
                f"  intent={resp.get('final_intent')}"
                f"  conf={resp.get('confidence', 0):.2f}",
            )
            time.sleep(args.sleep)

    # Write results
    output = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "verifier_url": args.verifier,
        "total_clips":  len(labeled),
        "results":      results,
    }
    out_path = RESULTS_DIR / "eval_results.json"
    out_path.write_text(json.dumps(output, indent=2))
    print(f"\nResults written to {out_path}")

    metrics = compute_metrics(results)
    print_metrics(metrics, results)
    print_confusion_matrix(results)


if __name__ == "__main__":
    main()
