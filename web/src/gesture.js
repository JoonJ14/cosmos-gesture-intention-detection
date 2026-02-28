// ─── MediaPipe landmark index constants ───────────────────────────────────────
const LM_WRIST      = 0;
const LM_THUMB_MCP  = 2;  const LM_THUMB_TIP  = 4;
const LM_INDEX_MCP  = 5;  const LM_INDEX_TIP  = 8;
const LM_MIDDLE_MCP = 9;  const LM_MIDDLE_TIP = 12;
const LM_RING_MCP   = 13; const LM_RING_TIP   = 16;
const LM_PINKY_MCP  = 17; const LM_PINKY_TIP  = 20;

// ─── Detection thresholds (spec: docs/GESTURE_DETECTION.md) ──────────────────
const SWIPE_THRESHOLD  = 0.30;  // 30% of normalised frame width
const SWIPE_MIN_MS     = 400;
const SWIPE_MAX_MS     = 900;
const PALM_HOLD_MS     = 300;   // stable hold duration for OPEN_MENU
const PALM_STABILITY   = 0.05;  // max wrist movement during hold
const CLOSE_MIN_MS     = 300;
const CLOSE_MAX_MS     = 800;
const REQUIRED_FRAMES  = 3;     // consecutive frames before accepting hand
const MIN_HAND_SPAN    = 0.05;  // ignore hands < 5% of frame (too far / small)
const COOLDOWN_MS      = 1500;  // global cooldown after any proposal

// ─── Finger & palm helpers ────────────────────────────────────────────────────

function countExtendedFingers(lms) {
  let n = 0;
  // Thumb extends laterally: tip x farther from wrist than MCP x
  if (Math.abs(lms[LM_THUMB_TIP].x - lms[LM_WRIST].x) >
      Math.abs(lms[LM_THUMB_MCP].x - lms[LM_WRIST].x)) n++;
  // Other fingers: tip y < mcp y  (y increases downward; tip above MCP = extended)
  if (lms[LM_INDEX_TIP].y  < lms[LM_INDEX_MCP].y)  n++;
  if (lms[LM_MIDDLE_TIP].y < lms[LM_MIDDLE_MCP].y) n++;
  if (lms[LM_RING_TIP].y   < lms[LM_RING_MCP].y)   n++;
  if (lms[LM_PINKY_TIP].y  < lms[LM_PINKY_MCP].y)  n++;
  return n;
}

function isPalmFacing(lms) {
  // Palm faces camera when average fingertip z is closer (lower) than wrist z
  const avgTipZ = (lms[LM_INDEX_TIP].z  + lms[LM_MIDDLE_TIP].z +
                   lms[LM_RING_TIP].z   + lms[LM_PINKY_TIP].z) / 4;
  return avgTipZ < lms[LM_WRIST].z;
}

function getHandSpan(lms) {
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const lm of lms) {
    if (lm.x < minX) minX = lm.x;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.y > maxY) maxY = lm.y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

// ─── Confidence scoring (weights from docs/GESTURE_DETECTION.md) ─────────────

function r2(v) { return Math.round(v * 100) / 100; }

function swipeConfidence(mpConf, displacement, elapsed, fingerCount, handSpan) {
  // Displacement margin: how far past the 30% threshold the swipe went
  const dispMargin = Math.min(1, Math.max(0, (displacement - SWIPE_THRESHOLD) / SWIPE_THRESHOLD));
  // Temporal fit: ideal center of [0.4s, 0.9s] window = 0.65s
  const temporal   = Math.max(0, 1 - Math.abs(elapsed - 0.65) / 0.25);
  // Pose stability: prefer extended fingers (flat hand vs fist)
  const stability  = Math.min(1, fingerCount / 4);
  const size       = Math.min(1, Math.max(0, (handSpan - MIN_HAND_SPAN) / 0.35));
  return r2(0.25 * mpConf + 0.25 * dispMargin + 0.20 * temporal +
            0.15 * stability + 0.15 * size);
}

function palmConfidence(mpConf, fingerCount, holdSec, wristDelta, handSpan) {
  // Displacement margin: finger extension completeness (5 = max)
  const dispMargin = fingerCount / 5;
  // Temporal fit: bonus for holds longer than minimum
  const temporal   = Math.min(1, Math.max(0, (holdSec - 0.3) / 0.4));
  // Pose stability: wrist must not move during hold
  const stability  = Math.max(0, 1 - wristDelta / PALM_STABILITY);
  const size       = Math.min(1, Math.max(0, (handSpan - MIN_HAND_SPAN) / 0.35));
  return r2(0.25 * mpConf + 0.25 * dispMargin + 0.20 * temporal +
            0.15 * stability + 0.15 * size);
}

function closeConfidence(mpConf, openFingers, closeFingers, elapsed, handSpan) {
  // Displacement margin: how decisive the fist closure was
  const dispMargin = openFingers > 0
    ? Math.min(1, (openFingers - closeFingers) / openFingers)
    : 0;
  // Temporal fit: ideal center of [0.3s, 0.8s] window = 0.55s
  const temporal   = Math.max(0, 1 - Math.abs(elapsed - 0.55) / 0.25);
  const size       = Math.min(1, Math.max(0, (handSpan - MIN_HAND_SPAN) / 0.35));
  // Stability not applicable for a transition gesture — use full weight
  return r2(0.25 * mpConf + 0.25 * dispMargin + 0.20 * temporal +
            0.15 * 1.0 + 0.15 * size);
}

// ─── Per-hand state machines ──────────────────────────────────────────────────

function makeHandState() {
  return {
    frames:   0,       // consecutive frames this hand has been tracked
    accepted: false,   // true once frames >= REQUIRED_FRAMES
    swipe: { state: "IDLE", startX: null, startTs: null, trajX: [] },
    palm:  { state: "IDLE", startTs: null, startWX: null, openCount: 0 },
    close: { state: "IDLE", startTs: null, openCount: 0, openFingers: 0 },
  };
}

function resetHandState(hs) {
  hs.frames   = 0;
  hs.accepted = false;
  hs.swipe = { state: "IDLE", startX: null, startTs: null, trajX: [] };
  hs.palm  = { state: "IDLE", startTs: null, startWX: null, openCount: 0 };
  hs.close = { state: "IDLE", startTs: null, openCount: 0, openFingers: 0 };
}

const perHand = { Right: makeHandState(), Left: makeHandState() };
let lastProposalTs = -Infinity;

// ─── Swipe (SWITCH_RIGHT / SWITCH_LEFT) ──────────────────────────────────────
//
// SWITCH_RIGHT: right hand, wrist x decreases ≥30% (hand moves right→left in
//               camera view, which corresponds to the user swiping right).
// SWITCH_LEFT:  left hand,  wrist x increases ≥30%.
//
// State: IDLE → TRACKING → (proposal emitted) → IDLE
//
function updateSwipe(side, hs, lms, mpConf, now) {
  const sw      = hs.swipe;
  const wX      = lms[LM_WRIST].x;
  const fingers = countExtendedFingers(lms);
  const span    = getHandSpan(lms);

  if (sw.state === "IDLE") {
    // Start a fresh tracking window from the current wrist position.
    // (The 3-frame entry guard is handled at the caller level via hs.accepted.)
    sw.startX  = wX;
    sw.startTs = now;
    sw.trajX   = [wX];
    sw.state   = "TRACKING";
    return null;
  }

  if (sw.state === "TRACKING") {
    sw.trajX.push(wX);
    const elapsed      = (now - sw.startTs) / 1000;
    const displacement = side === "Right" ? sw.startX - wX   // x decreases
                                          : wX - sw.startX;  // x increases

    if (elapsed > SWIPE_MAX_MS / 1000) {
      // Time window exceeded — reset for next attempt
      sw.state = "IDLE";
      return null;
    }

    if (displacement >= SWIPE_THRESHOLD && elapsed >= SWIPE_MIN_MS / 1000) {
      const intent = side === "Right" ? "SWITCH_RIGHT" : "SWITCH_LEFT";
      const conf   = swipeConfidence(mpConf, displacement, elapsed, fingers, span);
      sw.state = "IDLE";
      return {
        intent,
        confidence: conf,
        landmarkSummary: {
          handedness:          side,
          wrist_trajectory_x:  [...sw.trajX],
          displacement_pct:    r2(displacement),
          duration_s:          r2(elapsed),
          fingers_extended:    fingers,
          palm_facing_camera:  isPalmFacing(lms),
        },
      };
    }
  }
  return null;
}

// ─── Palm hold (OPEN_MENU) ────────────────────────────────────────────────────
//
// Detect ≥4 fingers extended + palm facing camera, held stable for ≥0.3s.
// State: IDLE → PALM_DETECTED → HOLDING → (proposal emitted) → IDLE
//
function updatePalm(side, hs, lms, mpConf, now) {
  const p       = hs.palm;
  const fingers = countExtendedFingers(lms);
  const facing  = isPalmFacing(lms);
  const span    = getHandSpan(lms);
  const wX      = lms[LM_WRIST].x;
  const isOpen  = fingers >= 4 && facing;

  if (p.state === "IDLE") {
    if (isOpen) {
      p.startTs   = now;
      p.startWX   = wX;
      p.openCount = 1;
      p.state     = "PALM_DETECTED";
    }
    return null;
  }

  if (p.state === "PALM_DETECTED" || p.state === "HOLDING") {
    if (!isOpen) {
      p.state = "IDLE";
      return null;
    }
    p.openCount++;
    const elapsed    = (now - p.startTs) / 1000;
    const wristDelta = Math.abs(wX - p.startWX);

    if (wristDelta > PALM_STABILITY) {
      // Wrist drifted — not a stable hold
      p.state = "IDLE";
      return null;
    }

    if (p.state === "PALM_DETECTED") p.state = "HOLDING";

    if (elapsed >= PALM_HOLD_MS / 1000) {
      const conf = palmConfidence(mpConf, fingers, elapsed, wristDelta, span);
      p.state = "IDLE";
      return {
        intent:     "OPEN_MENU",
        confidence: conf,
        landmarkSummary: {
          handedness:         side,
          wrist_trajectory_x: [p.startWX, wX],
          displacement_pct:   r2(wristDelta),
          duration_s:         r2(elapsed),
          fingers_extended:   fingers,
          palm_facing_camera: true,
        },
      };
    }
  }
  return null;
}

// ─── Palm-to-fist (CLOSE_MENU) ────────────────────────────────────────────────
//
// Open palm held for ≥3 frames, then hand closes to fist (≤1 finger) within
// 0.3–0.8s of the OPEN_SEEN transition.
// State: IDLE → OPEN_SEEN → (proposal emitted) → IDLE
//
function updateClose(side, hs, lms, mpConf, now) {
  const c       = hs.close;
  const fingers = countExtendedFingers(lms);
  const facing  = isPalmFacing(lms);
  const span    = getHandSpan(lms);
  const isOpen  = fingers >= 4 && facing;
  const isFist  = fingers <= 1;

  if (c.state === "IDLE") {
    if (isOpen) {
      c.openCount++;
      if (c.openCount >= REQUIRED_FRAMES) {
        c.startTs     = now;
        c.openFingers = fingers;
        c.state       = "OPEN_SEEN";
      }
    } else {
      c.openCount = 0;  // reset if open palm breaks before 3 frames
    }
    return null;
  }

  if (c.state === "OPEN_SEEN") {
    const elapsed = (now - c.startTs) / 1000;

    if (elapsed > CLOSE_MAX_MS / 1000) {
      c.state     = "IDLE";
      c.openCount = 0;
      return null;
    }

    if (isFist && elapsed >= CLOSE_MIN_MS / 1000) {
      const conf = closeConfidence(mpConf, c.openFingers, fingers, elapsed, span);
      c.state     = "IDLE";
      c.openCount = 0;
      return {
        intent:     "CLOSE_MENU",
        confidence: conf,
        landmarkSummary: {
          handedness:         side,
          wrist_trajectory_x: [],
          displacement_pct:   0,
          duration_s:         r2(elapsed),
          fingers_extended:   fingers,
          palm_facing_camera: facing,
        },
      };
    }
  }
  return null;
}

// ─── Public gesture proposal entry-point ─────────────────────────────────────

const KEY_TO_INTENT = {
  "1": "OPEN_MENU",
  "2": "CLOSE_MENU",
  "3": "SWITCH_RIGHT",
  "4": "SWITCH_LEFT",
};

export function createEventId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function intentFromTestKey(key) {
  return KEY_TO_INTENT[key] || null;
}

export async function setupCamera(videoElement) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 960, height: 540 },
    audio: false,
  });
  videoElement.srcObject = stream;
  await videoElement.play();
  return stream;
}

export function createHandsPipeline(onResults) {
  if (!window.Hands) {
    return null;
  }

  const hands = new window.Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 0,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });

  hands.onResults(onResults);
  return hands;
}

export function startHandsCameraLoop(videoElement, hands) {
  if (!window.Camera || !hands) {
    return null;
  }

  const camera = new window.Camera(videoElement, {
    onFrame: async () => {
      await hands.send({ image: videoElement });
    },
    width: 960,
    height: 540,
  });

  camera.start();
  return camera;
}

/**
 * Analyse a MediaPipe Hands result frame and return a gesture proposal, or
 * null if no gesture was detected this frame.
 *
 * Returns:
 *   { intent, confidence, landmarks, handedness, landmarkSummary }  |  null
 *
 * Where:
 *   intent          — "SWITCH_RIGHT" | "SWITCH_LEFT" | "OPEN_MENU" | "CLOSE_MENU"
 *   confidence      — local score 0–1 (weights per docs/GESTURE_DETECTION.md)
 *   landmarks       — MediaPipe 21-point array for the triggering hand
 *   handedness      — "Left" | "Right"
 *   landmarkSummary — structured JSON for the verifier payload
 */
export function proposeGestureFromLandmarks(results) {
  const now = performance.now();

  // Global cooldown — block all proposals for 1.5s after the last one
  if (now - lastProposalTs < COOLDOWN_MS) return null;

  const hands      = results.multiHandLandmarks || [];
  const handedness = results.multiHandedness    || [];

  const presentSides = new Set();

  for (let i = 0; i < hands.length; i++) {
    const h = handedness[i];
    if (!h) continue;
    const side   = h.label;                   // "Left" | "Right" per MediaPipe
    const mpConf = h.score ?? 0.5;
    const lms    = hands[i];

    if (side !== "Left" && side !== "Right") continue;
    if (!lms || lms.length < 21) continue;

    // Ignore hands that are too small / too far from camera
    if (getHandSpan(lms) < MIN_HAND_SPAN) {
      presentSides.add(side);  // still counts as present to prevent state reset
      continue;
    }

    presentSides.add(side);
    const hs = perHand[side];

    // Require ≥3 consecutive frames before starting detection (prevents
    // false triggers when a hand first enters the frame from the side)
    hs.frames++;
    if (hs.frames >= REQUIRED_FRAMES) hs.accepted = true;
    if (!hs.accepted) continue;

    // Run state machines in priority order.
    // Swipe: fastest & highest priority (purely temporal).
    // Close: requires open-palm precondition (medium priority).
    // Palm hold: slowest — only fires if swipe/close didn't.
    let proposal = updateSwipe(side, hs, lms, mpConf, now);
    if (!proposal) proposal = updateClose(side, hs, lms, mpConf, now);
    if (!proposal) proposal = updatePalm(side, hs, lms, mpConf, now);

    if (proposal) {
      lastProposalTs = now;

      // Reset all per-hand state so stale swipe/palm timers don't carry over
      // into the next detection window after the cooldown expires.
      resetHandState(perHand.Left);
      resetHandState(perHand.Right);

      console.log(
        "[gesture]", proposal.intent,
        "| conf:", proposal.confidence,
        "| side:", side,
        "| disp:", proposal.landmarkSummary?.displacement_pct,
        "| dur:", proposal.landmarkSummary?.duration_s + "s",
      );

      return {
        intent:          proposal.intent,
        confidence:      proposal.confidence,
        landmarks:       lms,
        handedness:      side,
        landmarkSummary: proposal.landmarkSummary,
      };
    }
  }

  // Reset state for any hand side not seen this frame
  for (const side of ["Left", "Right"]) {
    if (!presentSides.has(side)) resetHandState(perHand[side]);
  }

  return null;
}
