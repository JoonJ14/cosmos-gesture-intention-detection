/**
 * Circular frame buffer for Cosmos verification evidence windows.
 * Stores the last ~1 second of webcam frames (~30 entries at 30 fps).
 *
 * Usage:
 *   pushFrame(videoElement, multiHandLandmarks, multiHandedness)  — every frame
 *   getEvidenceWindow(n)  — returns n evenly-sampled base64 strings (no data: prefix)
 */

const BUFFER_SIZE = 30;
const _buf = new Array(BUFFER_SIZE).fill(null);
let _head = 0;   // next write slot
let _size = 0;   // valid entries in buffer (0..BUFFER_SIZE)

// Persistent canvas — allocate once, reuse every frame to avoid GC pressure
const _canvas = document.createElement("canvas");
_canvas.width  = 320;
_canvas.height = 180;
const _ctx = _canvas.getContext("2d");

/**
 * Capture the current video frame and store it with its landmark data.
 * Call once per MediaPipe callback, before gesture detection.
 *
 * @param {HTMLVideoElement} videoElement
 * @param {Array}  multiHandLandmarks  — results.multiHandLandmarks (may be empty)
 * @param {Array}  multiHandedness     — results.multiHandedness (may be empty)
 */
export function pushFrame(videoElement, multiHandLandmarks, multiHandedness) {
  _ctx.drawImage(videoElement, 0, 0, 320, 180);
  _buf[_head] = {
    timestamp:    performance.now(),
    frameDataUrl: _canvas.toDataURL("image/jpeg", 0.7),
    landmarks:    multiHandLandmarks,
    handedness:   multiHandedness,
  };
  _head = (_head + 1) % BUFFER_SIZE;
  if (_size < BUFFER_SIZE) _size++;
}

/**
 * Return n evenly-spaced frames from the buffer as plain base64 strings.
 * The data:image/jpeg;base64, prefix is stripped — nim_logic.py re-adds it.
 * Returns fewer than n entries if the buffer is not yet full.
 *
 * @param {number} n  Target frame count (default 8)
 * @returns {string[]}
 */
export function getEvidenceWindow(n = 8) {
  if (_size === 0) return [];
  const count    = _size;
  const oldestIdx = count < BUFFER_SIZE ? 0 : _head;

  if (n === 1) {
    const newest = _buf[(_head - 1 + BUFFER_SIZE) % BUFFER_SIZE];
    return newest ? [_b64(newest)] : [];
  }

  const result = [];
  const step   = count > 1 ? (count - 1) / (Math.min(n, count) - 1) : 0;
  for (let i = 0; i < Math.min(n, count); i++) {
    const pos   = Math.min(count - 1, Math.round(i * step));
    const entry = _buf[(oldestIdx + pos) % BUFFER_SIZE];
    if (entry) result.push(_b64(entry));
  }
  return result;
}

function _b64(entry) {
  // Strip "data:image/jpeg;base64," prefix
  return entry.frameDataUrl.split(",")[1];
}
