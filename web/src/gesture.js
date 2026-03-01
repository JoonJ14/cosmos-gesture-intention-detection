// ─── MediaPipe landmark index constants ───────────────────────────────────────
const LM_WRIST      = 0;
const LM_THUMB_MCP  = 2;  const LM_THUMB_TIP  = 4;
const LM_INDEX_MCP  = 5;  const LM_INDEX_TIP  = 8;
const LM_MIDDLE_MCP = 9;  const LM_MIDDLE_TIP = 12;
const LM_RING_MCP   = 13; const LM_RING_TIP   = 16;
const LM_PINKY_MCP  = 17; const LM_PINKY_TIP  = 20;

// ─── Detection thresholds (spec: docs/GESTURE_DETECTION.md) ──────────────────
// Intentionally loose for high recall — false positives are filtered by Cosmos.
const SWIPE_MIN_DISPLACEMENT  = 0.10; // fraction of frame width (min x-displacement)
const SWIPE_MIN_DURATION      = 0.15; // seconds (min swipe duration)
const SWIPE_MAX_DURATION      = 2.0;  // seconds (max swipe duration)
const PALM_HOLD_MS            = 150;  // stable palm hold for OPEN_MENU
const FIST_HOLD_MS            = 50;   // min fist hold before palm transition (OPEN_MENU)
const PALM_STABILITY          = 0.05; // max wrist drift during OPEN_MENU palm hold
const CLOSE_MIN_MS            = 150;  // min palm hold before fist accepted (CLOSE_MENU)
const CLOSE_MAX_MS            = 1000; // total timeout for CLOSE_MENU sequence
const CLOSE_FIST_HOLD_MS      = 75;   // fist must be held this long to fire CLOSE_MENU
const REQUIRED_FRAMES         = 1;    // consecutive frames before accepting hand
const MIN_HAND_SPAN           = 0.015; // ignore hands < 1.5% of frame width
const COOLDOWN_MS             = 800;  // global cooldown after any proposal

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

// fingerCount removed — swipe detection is pose-agnostic; pose stability weight
// redistributed to displacement and mpConf.
function swipeConfidence(mpConf, displacement, elapsed, handSpan) {
  // Displacement margin: how far past the 10% threshold the swipe went
  const dispMargin = Math.min(1, Math.max(0, (displacement - SWIPE_MIN_DISPLACEMENT) / SWIPE_MIN_DISPLACEMENT));
  // Temporal fit: ideal center of [0.15s, 2.0s] window = 1.075s, half-width = 0.925s
  const temporal   = Math.max(0, 1 - Math.abs(elapsed - 1.075) / 0.925);
  const size       = Math.min(1, Math.max(0, (handSpan - MIN_HAND_SPAN) / 0.35));
  return r2(0.30 * mpConf + 0.40 * dispMargin + 0.15 * temporal + 0.15 * size);
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

// ─── Feature extraction for teacher-student pipeline ─────────────────────────
//
// Called at proposal time. Returns a 12-feature object (+ gestureType string)
// that the student service uses for execute/suppress prediction.
// All numeric values are rounded to 2 decimal places.
//
function extractFeatures(lms, side, gestureType, proposal, hs) {
  const isSwipe = gestureType === "SWITCH_RIGHT" || gestureType === "SWITCH_LEFT";
  const ls      = proposal.landmarkSummary;

  // Swipe displacement and duration (0 for non-swipe gestures)
  const swipeDisplacement = isSwipe ? (ls.displacement_pct || 0) : 0;
  const swipeDuration     = isSwipe ? (ls.duration_s       || 0) : 0;

  // Peak single-frame wrist x-displacement during the gesture window
  let peakVelocity = 0;
  if (isSwipe && ls.wrist_trajectory_x && ls.wrist_trajectory_x.length > 1) {
    const traj = ls.wrist_trajectory_x;
    for (let i = 1; i < traj.length; i++) {
      peakVelocity = Math.max(peakVelocity, Math.abs(traj[i] - traj[i - 1]));
    }
  } else {
    const pos = hs.recentWristPositions;
    for (let i = 1; i < pos.length; i++) {
      peakVelocity = Math.max(peakVelocity, Math.abs(pos[i].x - pos[i - 1].x));
    }
  }

  // Signed average wrist velocity over last 5 frames (positive = rightward/downward)
  let wristVelocityX = 0;
  let wristVelocityY = 0;
  const recent = hs.recentWristPositions.slice(-5);
  if (recent.length > 1) {
    let sumX = 0, sumY = 0;
    for (let i = 1; i < recent.length; i++) {
      sumX += recent[i].x - recent[i - 1].x;
      sumY += recent[i].y - recent[i - 1].y;
    }
    wristVelocityX = sumX / (recent.length - 1);
    wristVelocityY = sumY / (recent.length - 1);
  }

  return {
    swipeDisplacement: r2(swipeDisplacement),
    swipeDuration:     r2(swipeDuration),
    peakVelocity:      r2(peakVelocity),
    fingersExtended:   ls.fingers_extended ?? countExtendedFingers(lms),
    handSide:          side === "Right" ? 1 : 0,
    handSpan:          r2(getHandSpan(lms)),
    wristX:            r2(lms[LM_WRIST].x),
    wristY:            r2(lms[LM_WRIST].y),
    // z-depth differential: fingertip closer to camera than wrist → negative value → palm facing camera
    palmFacing:        r2(lms[LM_MIDDLE_TIP].z - lms[LM_WRIST].z),
    wristVelocityX:    r2(wristVelocityX),
    wristVelocityY:    r2(wristVelocityY),
    stateConfidence:   r2(proposal.confidence),
    gestureType,
  };
}

// ─── Per-hand state machines ──────────────────────────────────────────────────

function makeHandState() {
  return {
    frames:   0,       // consecutive frames this hand has been tracked
    accepted: false,   // true once frames >= REQUIRED_FRAMES
    swipe: { state: "IDLE", startX: null, startTs: null, trajX: [] },
    palm:  { state: "IDLE", fistStartTs: null, palmStartTs: null, startWX: null, openCount: 0 },
    close: { state: "IDLE", startTs: null, palmStartWX: null, openCount: 0, openFingers: 0, fistStartTs: null },
    recentWristPositions: [],   // last 10 {x, y} wrist positions for velocity features
  };
}

function resetHandState(hs) {
  hs.frames   = 0;
  hs.accepted = false;
  hs.swipe = { state: "IDLE", startX: null, startTs: null, trajX: [] };
  hs.palm  = { state: "IDLE", fistStartTs: null, palmStartTs: null, startWX: null, openCount: 0 };
  hs.close = { state: "IDLE", startTs: null, palmStartWX: null, openCount: 0, openFingers: 0, fistStartTs: null };
  hs.recentWristPositions = [];
}

const perHand = { Right: makeHandState(), Left: makeHandState() };
let lastProposalTs = -Infinity;

// ─── Swipe (SWITCH_RIGHT / SWITCH_LEFT) ──────────────────────────────────────
//
// Pose-agnostic: any hand pose (open, sideways, loose fist) can swipe.
// Detection is based solely on the wrist landmark (0) x-displacement over time.
// Either hand can trigger either direction.
//
// Coordinate system with CSS scaleX(-1) mirror applied to the video element:
//   screen-right ≡ low raw x  |  screen-left ≡ high raw x
//   raw x DECREASES → hand moved toward screen-RIGHT → SWITCH_RIGHT
//   raw x INCREASES → hand moved toward screen-LEFT  → SWITCH_LEFT
//
// State: IDLE → TRACKING → (proposal emitted) → IDLE
//
function updateSwipe(side, hs, lms, mpConf, now) {
  const sw   = hs.swipe;
  const wX   = lms[LM_WRIST].x;
  const span = getHandSpan(lms);

  if (sw.state === "IDLE") {
    sw.startX  = wX;
    sw.startTs = now;
    sw.trajX   = [wX];
    sw.state   = "TRACKING";
    return null;
  }

  if (sw.state === "TRACKING") {
    sw.trajX.push(wX);
    const elapsed   = (now - sw.startTs) / 1000;
    const rawDelta  = wX - sw.startX;  // positive = x increased = screen-left motion
    const screenDir = rawDelta < 0 ? "RIGHT" : "LEFT";

    console.log(
      `[SWIPE] tracking: ${side}, rawDisplacement: ${rawDelta.toFixed(3)},` +
      ` screenDir: ${screenDir}, duration: ${elapsed.toFixed(3)}s`,
    );

    if (elapsed > SWIPE_MAX_DURATION) {
      sw.state = "IDLE";
      return null;
    }

    // With CSS scaleX(-1): raw x decreasing = moving toward screen-right = SWITCH_RIGHT
    // User mental model: swipe rightward on the mirrored screen → go to right workspace.
    // raw x decreases → screen-right swipe → SWITCH_RIGHT
    // raw x increases → screen-left  swipe → SWITCH_LEFT
    const rightDisp = sw.startX - wX;   // positive when x decreased (screen-right)
    const leftDisp  = wX - sw.startX;   // positive when x increased (screen-left)

    if (rightDisp >= SWIPE_MIN_DISPLACEMENT && elapsed >= SWIPE_MIN_DURATION) {
      const conf = swipeConfidence(mpConf, rightDisp, elapsed, span);
      sw.state = "IDLE";
      return {
        intent: "SWITCH_LEFT",   // swapped: screen-right swipe = SWITCH_LEFT
        confidence: conf,
        landmarkSummary: {
          handedness:         side,
          wrist_trajectory_x: [...sw.trajX],
          displacement_pct:   r2(rightDisp),
          duration_s:         r2(elapsed),
          fingers_extended:   countExtendedFingers(lms),
          palm_facing_camera: isPalmFacing(lms),
        },
      };
    }

    if (leftDisp >= SWIPE_MIN_DISPLACEMENT && elapsed >= SWIPE_MIN_DURATION) {
      const conf = swipeConfidence(mpConf, leftDisp, elapsed, span);
      sw.state = "IDLE";
      return {
        intent: "SWITCH_RIGHT",  // swapped: screen-left swipe = SWITCH_RIGHT
        confidence: conf,
        landmarkSummary: {
          handedness:         side,
          wrist_trajectory_x: [...sw.trajX],
          displacement_pct:   r2(leftDisp),
          duration_s:         r2(elapsed),
          fingers_extended:   countExtendedFingers(lms),
          palm_facing_camera: isPalmFacing(lms),
        },
      };
    }
  }
  return null;
}

// ─── Palm hold (OPEN_MENU) ────────────────────────────────────────────────────
//
// Requires a deliberate fist→palm transition to avoid false triggers from
// resting an open hand or casual gestures during conversation.
//
// State: IDLE → FIST_DETECTED → PALM_OPENED → (proposal emitted) → IDLE
//
//   IDLE:          Wait for a loosely closed fist (≤3 fingers extended).
//   FIST_DETECTED: Hold fist ≥FIST_HOLD_MS, then open hand to trigger next phase.
//   PALM_OPENED:   Partial or full palm held stable for ≥PALM_HOLD_MS → emit OPEN_MENU.
//
function updatePalm(side, hs, lms, mpConf, now) {
  console.log("[OPEN_MENU] entered updatePalm");
  const p       = hs.palm;
  const fingers = countExtendedFingers(lms);
  const facing  = isPalmFacing(lms);
  const span    = getHandSpan(lms);
  const wX      = lms[LM_WRIST].x;
  // Loosened: ≥3 fingers extended (partial palm counts)
  const isOpen  = fingers >= 3 && facing;
  // Loosened: ≤3 fingers extended catches loose/relaxed hands, not just tight fists
  const isFist  = fingers <= 3;

  if (p.state === "IDLE") {
    if (isFist) {
      p.fistStartTs = now;
      p.state       = "FIST_DETECTED";
      console.log(`[OPEN_MENU] state: FIST_DETECTED, fingersExtended: ${fingers}, fistDuration: 0ms`);
    }
    return null;
  }

  if (p.state === "FIST_DETECTED") {
    const fistDurMs = Math.round(now - p.fistStartTs);
    console.log(`[OPEN_MENU] state: ${p.state}, fingersExtended: ${fingers}, fistDuration: ${fistDurMs}ms`);
    if (isFist) {
      // Still holding fist — keep waiting
      return null;
    }
    if (isOpen && fistDurMs >= FIST_HOLD_MS) {
      // Fist was held long enough, and the hand just opened → start palm phase
      p.palmStartTs = now;
      p.startWX     = wX;
      p.openCount   = 1;
      p.state       = "PALM_OPENED";
    } else {
      // Ambiguous hand pose, or fist wasn't held long enough → reset
      p.state = "IDLE";
    }
    return null;
  }

  if (p.state === "PALM_OPENED") {
    if (!isOpen) {
      p.state = "IDLE";
      return null;
    }
    p.openCount++;
    const elapsed    = (now - p.palmStartTs) / 1000;
    const wristDelta = Math.abs(wX - p.startWX);
    console.log(`[OPEN_MENU] state: ${p.state}, fingersExtended: ${fingers}, palmDuration: ${Math.round(elapsed * 1000)}ms`);

    if (wristDelta > PALM_STABILITY) {
      // Wrist drifted — not a stable hold
      p.state = "IDLE";
      return null;
    }

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
// Any visible open-ish palm → fist transition fires, even if the hand is moving.
// High recall by design — Cosmos filters false positives. Requirements:
//   1. Partial or full palm (≥3 fingers) seen for ≥REQUIRED_FRAMES frames in IDLE.
//   2. Palm held for ≥CLOSE_MIN_MS (no stillness check — moving hands are OK).
//   3. Hand closes to fist (≤3 fingers) while still in frame.
//   4. Fist held for ≥CLOSE_FIST_HOLD_MS before firing.
//
// State: IDLE → OPEN_SEEN → FIST_SEEN → (proposal emitted) → IDLE
//
function updateClose(side, hs, lms, mpConf, now) {
  console.log("[CLOSE_MENU] entered updateClose");
  const c       = hs.close;
  const fingers = countExtendedFingers(lms);
  const facing  = isPalmFacing(lms);
  const span    = getHandSpan(lms);
  const wX      = lms[LM_WRIST].x;
  // Loosened: ≥3 fingers (partial palm) and ≤3 fingers (loose fist)
  const isOpen  = fingers >= 3 && facing;
  const isFist  = fingers <= 3;

  if (c.state === "IDLE") {
    if (isOpen) {
      c.openCount++;
      if (c.openCount >= REQUIRED_FRAMES) {
        // OPEN_MENU has priority: if it already detected a fist and is counting
        // toward palm completion, don't let CLOSE_MENU steal the palm.
        if (hs.palm.state === "FIST_DETECTED" || hs.palm.state === "PALM_OPENED") {
          console.log(`[CLOSE_MENU] IDLE: OPEN_MENU is in ${hs.palm.state}, deferring OPEN_SEEN`);
          c.openCount = 0;  // reset so CLOSE_MENU starts fresh after OPEN_MENU finishes
          return null;
        }
        c.startTs     = now;
        c.palmStartWX = wX;
        c.openFingers = fingers;
        c.state       = "OPEN_SEEN";
      }
    } else {
      c.openCount = 0;
    }
    return null;
  }

  if (c.state === "OPEN_SEEN") {
    const elapsed       = (now - c.startTs) / 1000;
    const wristMovement = Math.abs(wX - c.palmStartWX);
    console.log(
      `[CLOSE_MENU] state: OPEN_SEEN, palmDur: ${Math.round(elapsed * 1000)}ms,` +
      ` wristMovement: ${wristMovement.toFixed(3)}, fingersExtended: ${fingers}`,
    );

    // No stillness check — moving hands are allowed (Cosmos handles false positives)

    if (elapsed > CLOSE_MAX_MS / 1000) {
      c.state     = "IDLE";
      c.openCount = 0;
      return null;
    }

    if (isOpen) return null;  // still holding palm — keep waiting

    // Hand is no longer open: must be a genuine fist after sufficient palm hold
    if (isFist && elapsed >= CLOSE_MIN_MS / 1000) {
      c.fistStartTs = now;
      c.state       = "FIST_SEEN";
      return null;
    }

    // Ambiguous pose or palm ended too soon → reset
    c.state     = "IDLE";
    c.openCount = 0;
    return null;
  }

  if (c.state === "FIST_SEEN") {
    const fistElapsed = (now - c.fistStartTs) / 1000;
    const palmElapsed = (now - c.startTs) / 1000;
    console.log(
      `[CLOSE_MENU] state: FIST_SEEN, fistDur: ${Math.round(fistElapsed * 1000)}ms,` +
      ` fingersExtended: ${fingers}`,
    );

    if (!isFist) {
      // Fist broke before hold completed — not a deliberate close
      c.state     = "IDLE";
      c.openCount = 0;
      return null;
    }

    if (palmElapsed > CLOSE_MAX_MS / 1000 + CLOSE_FIST_HOLD_MS / 1000) {
      c.state     = "IDLE";
      c.openCount = 0;
      return null;
    }

    if (fistElapsed >= CLOSE_FIST_HOLD_MS / 1000) {
      const conf = closeConfidence(mpConf, c.openFingers, fingers, palmElapsed, span);
      c.state     = "IDLE";
      c.openCount = 0;
      return {
        intent:     "CLOSE_MENU",
        confidence: conf,
        landmarkSummary: {
          handedness:         side,
          wrist_trajectory_x: [],
          displacement_pct:   0,
          duration_s:         r2(palmElapsed),
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
  // ── Top-level frame trace (always fires, even if no hands / in cooldown) ──
  console.log(`[GESTURE FRAME] hands detected: ${results.multiHandLandmarks?.length || 0}`);

  const now = performance.now();

  // Global cooldown — block all proposals for 1.5s after the last one
  const cooldownRemaining = COOLDOWN_MS - (now - lastProposalTs);
  if (cooldownRemaining > 0) {
    console.log(`[GESTURE FRAME] in cooldown, ${Math.round(cooldownRemaining)}ms remaining`);
    return null;
  }

  const hands      = results.multiHandLandmarks || [];
  const handedness = results.multiHandedness    || [];

  const presentSides = new Set();

  for (let i = 0; i < hands.length; i++) {
    const h = handedness[i];
    if (!h) { console.log(`[GESTURE FRAME] hand[${i}]: no handedness entry, skipping`); continue; }
    const side   = h.label;                   // "Left" | "Right" per MediaPipe
    const mpConf = h.score ?? 0.5;
    const lms    = hands[i];

    if (side !== "Left" && side !== "Right") { console.log(`[GESTURE FRAME] hand[${i}]: unknown side "${side}", skipping`); continue; }
    if (!lms || lms.length < 21) { console.log(`[GESTURE FRAME] hand[${i}]: bad landmarks (len=${lms?.length}), skipping`); continue; }

    // Ignore hands that are too small / too far from camera
    const span = getHandSpan(lms);
    if (span < MIN_HAND_SPAN) {
      console.log(`[GESTURE FRAME] hand[${i}] ${side}: span ${span.toFixed(3)} < MIN_HAND_SPAN, skipping`);
      presentSides.add(side);  // still counts as present to prevent state reset
      continue;
    }

    presentSides.add(side);
    const hs = perHand[side];

    // Require ≥3 consecutive frames before starting detection (prevents
    // false triggers when a hand first enters the frame from the side)
    hs.frames++;
    if (hs.frames >= REQUIRED_FRAMES) hs.accepted = true;
    if (!hs.accepted) {
      console.log(`[GESTURE FRAME] hand[${i}] ${side}: entry guard frames=${hs.frames}/${REQUIRED_FRAMES}, not yet accepted`);
      continue;
    }

    // Track wrist position history for student feature extraction
    hs.recentWristPositions.push({ x: lms[LM_WRIST].x, y: lms[LM_WRIST].y });
    if (hs.recentWristPositions.length > 10) hs.recentWristPositions.shift();

    // Run state machines in priority order.
    // Swipe: fastest & highest priority (purely temporal).
    // Close: requires open-palm precondition (medium priority).
    // Palm hold: slowest — only fires if swipe/close didn't.
    //
    // Mutual exclusion with priority:
    //   CLOSE_MENU (OPEN_SEEN/FIST_SEEN) suppresses OPEN_MENU — BUT only when
    //   OPEN_MENU is still IDLE. Once OPEN_MENU has detected a fist and is in
    //   FIST_DETECTED or PALM_OPENED, it owns the hand and must not be reset.
    //   (CLOSE_MENU's IDLE guard above already prevents it from entering OPEN_SEEN
    //   while OPEN_MENU is active, so this path only applies to IDLE suppression.)
    const closeIsTracking = hs.close.state === "OPEN_SEEN" || hs.close.state === "FIST_SEEN";
    const openMenuActive  = hs.palm.state === "FIST_DETECTED" || hs.palm.state === "PALM_OPENED";

    if (closeIsTracking && !openMenuActive) {
      console.log(`[GESTURE FRAME] ${side}: closeIsTracking (${hs.close.state}), palm IDLE → suppressing OPEN_MENU`);
      hs.palm.state       = "IDLE";
      hs.palm.fistStartTs = null;
      hs.palm.palmStartTs = null;
    }

    console.log(`[GESTURE FRAME] ${side}: accepted, swipe=${hs.swipe.state}, close=${hs.close.state}, palm=${hs.palm.state}, closeIsTracking=${closeIsTracking}, openMenuActive=${openMenuActive}`);

    let proposal = updateSwipe(side, hs, lms, mpConf, now);
    if (!proposal) proposal = updateClose(side, hs, lms, mpConf, now);
    if (!proposal && (!closeIsTracking || openMenuActive)) proposal = updatePalm(side, hs, lms, mpConf, now);

    if (proposal) {
      lastProposalTs = now;

      // Extract features before resetting hand state (recentWristPositions is still populated)
      const features = extractFeatures(lms, side, proposal.intent, proposal, hs);

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
        "| features:", features,
      );

      return {
        intent:          proposal.intent,
        confidence:      proposal.confidence,
        landmarks:       lms,
        handedness:      side,
        landmarkSummary: proposal.landmarkSummary,
        features,
      };
    }
  }

  // Reset state for any hand side not seen this frame
  for (const side of ["Left", "Right"]) {
    if (!presentSides.has(side)) resetHandState(perHand[side]);
  }

  return null;
}
