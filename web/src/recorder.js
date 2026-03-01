/**
 * Eval clip recording module.
 *
 * Space bar cycles through three states when the recording panel is open:
 *
 *   READY     — waiting. Overlay shows white dot + "Press Space to Record".
 *   RECORDING — timer running. Overlay shows red pulsing dot + "RECORDING 0.0s".
 *               The ring buffer captures frames continuously (it always does).
 *               Press Space again to stop and capture.
 *   CAPTURED  — clip held pending label. Preview plays back in panel.
 *               Click a label button to commit, or Discard to throw away.
 *               Either action returns to READY.
 *
 * Auto-capture (A key) is a separate side-channel: every gesture that fires is
 * immediately labeled TP_{INTENT} and committed without touching the Space cycle.
 *
 * "Save Session" downloads all committed clips as a single JSON file.
 * Feed that file to scripts/eval_cosmos.py for Cosmos evaluation.
 */

let _enabled     = false;   // true when recording panel is open
let _autoCapture = false;   // true when gestures auto-capture clips
let _clips       = [];      // committed (labeled) clips for this session
let _pending     = null;    // clip awaiting a label (CAPTURED state)
let _counter     = 0;       // monotonic counter for clip IDs
let _lastGesture = null;    // {intent, confidence, features, frames} — most recent gesture
let _recState    = "ready"; // "ready" | "recording" | "captured"
let _recStartMs  = null;    // performance.now() when current recording started
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

// ─── Reads ────────────────────────────────────────────────────────────────────

export function isRecordingEnabled() { return _enabled; }
export function isAutoCapture()       { return _autoCapture; }
export function getRecordingState()   { return _recState; }

/** Milliseconds elapsed since the current recording started (0 if not recording). */
export function getRecordingElapsedMs() {
  return (_recState === "recording" && _recStartMs !== null)
    ? performance.now() - _recStartMs
    : 0;
}

/** Frames of the pending clip (empty array if none). Used for preview playback. */
export function getPendingFrames() {
  return _pending?.frames ?? [];
}

export function getStats() {
  const byLabel = {};
  for (const clip of _clips) {
    const key = clip.label ?? "unlabeled";
    byLabel[key] = (byLabel[key] || 0) + 1;
  }
  return { total: _clips.length, pending: _pending !== null, byLabel };
}

// ─── State transitions ────────────────────────────────────────────────────────

export function toggleRecording() {
  _enabled = !_enabled;
  if (!_enabled) {
    // Reset everything when the panel is closed
    _recState   = "ready";
    _recStartMs = null;
    _pending    = null;
  }
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
 * context is available when the user presses Space to stop recording.
 */
export function notifyGesture(intent, confidence, features, frames) {
  _lastGesture = { intent, confidence, features, frames };
}

/**
 * Advance the recording state machine one step (called on Space press).
 *
 *   READY     → RECORDING  (start timer, do not capture yet)
 *   RECORDING → CAPTURED   (grab ring buffer, build pending clip)
 *   CAPTURED  → no-op      (must label or discard before re-recording)
 *
 * @param {() => string[]} getFramesFn  — returns current ring buffer as base64 array
 */
export function advanceRecordingState(getFramesFn) {
  if (!_enabled) return;

  if (_recState === "ready") {
    _recState   = "recording";
    _recStartMs = performance.now();
    console.log("[RECORDER] started recording");
    _notify();

  } else if (_recState === "recording") {
    const frames = getFramesFn();
    const g      = _lastGesture;
    _pending = _buildClip(
      null,
      g?.intent    ?? null,
      g?.confidence ?? null,
      g?.features  ?? null,
      frames,
    );
    _recState   = "captured";
    _recStartMs = null;
    console.log(`[RECORDER] captured ${_pending.clip_id}, ${frames.length} frames, gesture=${g?.intent ?? "none"}`);
    _notify();
  }
  // In "captured" state, Space is ignored — user must label or discard.
}

/**
 * Auto-capture: called when a gesture fires while auto-capture is enabled.
 * Bypasses the Space cycle entirely — creates a TP-labeled clip immediately
 * without affecting _recState.
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
 * Assign a label to the pending clip, commit it, and return to READY.
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
  _pending  = null;
  _recState = "ready";
  _notify();
}

/**
 * Discard the pending clip without saving and return to READY.
 */
export function discardPendingClip() {
  if (_pending) {
    console.log(`[RECORDER] discarded ${_pending.clip_id}`);
    _pending = null;
  }
  _recState = "ready";
  _notify();
}

/**
 * Download all committed clips as a JSON file via Blob URL.
 * Move the downloaded file to data/eval/ and feed it to scripts/eval_cosmos.py.
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
