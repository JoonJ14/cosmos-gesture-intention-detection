/**
 * Eval clip recording module.
 *
 * Captures labeled gesture clips and hard-negative motions from the ring
 * buffer for two purposes:
 *   1. Evaluation: feed clips through Cosmos to measure precision/recall.
 *   2. Calibration: agree-labeled clips become the frozen regression-check set
 *      used by train_student.py before deploying student model updates.
 *
 * Usage (keyboard shortcuts):
 *   R     — toggle recording panel visible / hidden (enables/disables recording)
 *   Space — manually capture a clip from the ring buffer (while panel is open)
 *   A     — toggle auto-capture (clips auto-saved whenever a gesture fires)
 *
 * After a manual capture, the clip is "pending" — click a label button to tag
 * it and commit it to the session. Auto-captured clips are auto-labeled with
 * TP_{INTENT} and committed immediately.
 *
 * "Save Session" downloads all committed clips as a single JSON file.
 * Feed that file to scripts/eval_cosmos.py for Cosmos evaluation.
 */

let _enabled     = false;   // true when recording panel is open
let _autoCapture = false;   // true when gestures auto-capture clips
let _clips       = [];      // committed (labeled) clips for this session
let _pending     = null;    // manually captured clip awaiting a label
let _counter     = 0;       // monotonic counter for clip IDs
let _lastGesture = null;    // {intent, confidence, features, frames} — most recent gesture
let _onStateChange = null;  // called whenever any state changes (for UI sync)

export function setOnStateChange(cb) {
  _onStateChange = cb;
}

function _notify() {
  if (_onStateChange) _onStateChange();
}

function _buildClip(label, gestureDetected, confidence, features, frames) {
  _counter++;
  return {
    clip_id:          `clip_${String(_counter).padStart(3, "0")}`,
    timestamp:        new Date().toISOString(),
    label:            label ?? null,
    category:         label
      ? (label.startsWith("TP_") ? "true_positive" : "hard_negative")
      : "unlabeled",
    gesture_detected: gestureDetected ?? null,
    features:         features ?? null,
    confidence:       typeof confidence === "number" ? confidence : null,
    frames:           frames ?? [],
    num_frames:       (frames ?? []).length,
    metadata:         { mirror_mode: true },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function isRecordingEnabled() { return _enabled; }
export function isAutoCapture()       { return _autoCapture; }
export function hasPendingClip()      { return _pending !== null; }

export function getStats() {
  const byLabel = {};
  for (const clip of _clips) {
    const key = clip.label ?? "unlabeled";
    byLabel[key] = (byLabel[key] || 0) + 1;
  }
  return { total: _clips.length, pending: _pending !== null, byLabel };
}

export function toggleRecording() {
  _enabled = !_enabled;
  console.log(`[RECORDER] recording ${_enabled ? "ON" : "OFF"}`);
  _notify();
}

export function toggleAutoCapture() {
  _autoCapture = !_autoCapture;
  console.log(`[RECORDER] auto-capture ${_autoCapture ? "ON" : "OFF"}`);
  _notify();
}

/**
 * Called by main.js on every gesture detection so the most recent gesture
 * context is available when the user manually presses Space to capture.
 */
export function notifyGesture(intent, confidence, features, frames) {
  _lastGesture = { intent, confidence, features, frames };
}

/**
 * Manual capture: grabs the current ring buffer via getFramesFn() and stores
 * a pending clip. The clip is not committed until the user clicks a label button.
 * If there was already a pending clip, it is discarded.
 *
 * @param {() => string[]} getFramesFn  — zero-arg function returning base64 frame array
 */
export function manualCapture(getFramesFn) {
  if (!_enabled) return;
  const frames = getFramesFn();
  const g      = _lastGesture;
  if (_pending) {
    console.warn(`[RECORDER] discarding unlabeled ${_pending.clip_id} — replaced by new capture`);
  }
  _pending = _buildClip(
    null,
    g?.intent    ?? null,
    g?.confidence ?? null,
    g?.features  ?? null,
    frames,
  );
  console.log(`[RECORDER] captured ${_pending.clip_id}, ${frames.length} frames, gesture=${g?.intent ?? "none"}`);
  _notify();
}

/**
 * Auto-capture: called right after a gesture fires when auto-capture is on.
 * The clip is auto-labeled with TP_{INTENT} and committed immediately.
 */
export function autoCapture(intent, confidence, features, frames) {
  if (!_enabled || !_autoCapture) return;
  const label = `TP_${intent}`;
  const clip  = _buildClip(label, intent, confidence, features, frames);
  _clips.push(clip);
  console.log(`[RECORDER] auto-captured ${clip.clip_id} as ${label}`);
  _notify();
}

/**
 * Assign a label to the pending clip and commit it to the session.
 * No-op if there is no pending clip.
 */
export function labelPendingClip(label) {
  if (!_pending) {
    console.warn("[RECORDER] no pending clip to label");
    return;
  }
  _pending.label    = label;
  _pending.category = label.startsWith("TP_") ? "true_positive" : "hard_negative";
  _clips.push(_pending);
  console.log(`[RECORDER] labeled ${_pending.clip_id} as ${label}`);
  _pending = null;
  _notify();
}

/**
 * Download all committed clips as a JSON file via Blob URL.
 * The file is saved to wherever the browser downloads files.
 * Move it to data/eval/ and feed it to scripts/eval_cosmos.py.
 */
export function saveSession() {
  if (_clips.length === 0) {
    console.warn("[RECORDER] nothing to save");
    return;
  }
  const ts       = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `eval_session_${ts}.json`;
  const blob     = new Blob([JSON.stringify(_clips, null, 2)], { type: "application/json" });
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  console.log(`[RECORDER] downloaded ${_clips.length} clips as ${filename}`);
}
