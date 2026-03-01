# Gesture Detection Specification

This document specifies the gesture detection algorithm for `web/src/gesture.js:proposeGestureFromLandmarks()`. It is the authoritative implementation reference for the local perception layer.

**Last updated: 2026-03-01** — reflects the current implementation after the Block 1/1b session.

---

## Overview

MediaPipe Hands provides 21 landmarks per hand, per frame, plus handedness (Left/Right) and detection confidence. The gesture detection logic tracks these landmarks over time using per-hand state machines to classify temporal motion patterns into intent proposals.

---

## Display coordinate system (important)

The video element and canvas overlay both have CSS `transform: scaleX(-1)` applied, creating a selfie/bathroom-mirror view. This means:

- **Screen-right ≡ low raw x** (camera's left edge)
- **Screen-left ≡ high raw x** (camera's right edge)
- MediaPipe landmark coordinates are in **raw camera space** (unaffected by CSS transforms)
- All gesture math uses raw coordinates; the mirror mapping is accounted for in the direction logic

---

## MediaPipe input

Each frame callback receives:
- `multiHandLandmarks[]` — array of hands, each with 21 normalized landmarks (`x`, `y`, `z` in [0, 1])
- `multiHandedness[]` — array of `{label: "Left"|"Right", score: float}`

Key landmarks:
- **Wrist** (0) — primary position tracker for swipe and palm detection
- **Thumb MCP/TIP** (2, 4) — thumb extension check
- **Index MCP/TIP** (5, 8), **Middle MCP/TIP** (9, 12), **Ring MCP/TIP** (13, 16), **Pinky MCP/TIP** (17, 20)

---

## Finger extension detection

```javascript
// Thumb: tip x farther from wrist than MCP x (extends laterally)
thumbExtended = |tip.x − wrist.x| > |mcp.x − wrist.x|

// Other four fingers: tip y above MCP y (y increases downward)
fingerExtended = tip.y < mcp.y
```

`countExtendedFingers(lms)` returns 0–5.

**Palm facing detection:** palm faces camera when average fingertip z < wrist z (fingertips closer to camera).

---

## Hand acceptance

```
MIN_HAND_SPAN   = 0.025   // hands spanning < 2.5% of frame width are ignored (too far/small)
REQUIRED_FRAMES = 1       // frames tracked before state machines activate (immediate)
```

On each frame per hand: if `getHandSpan(lms) < MIN_HAND_SPAN`, skip but still mark as present (prevents state reset). After `REQUIRED_FRAMES` consecutive frames, `hs.accepted = true`.

---

## Gesture definitions and state machines

### SWITCH\_RIGHT and SWITCH\_LEFT (swipe)

**Pose-agnostic**: any hand pose works. Detection is based solely on wrist (LM 0) x-displacement. Either hand can trigger either direction.

**Direction mapping with CSS mirror:**
- Raw x DECREASES → hand moved toward screen-right → **SWITCH\_LEFT**
- Raw x INCREASES → hand moved toward screen-left → **SWITCH\_RIGHT**

**Thresholds:**
```
SWIPE_MIN_DISPLACEMENT = 0.15   // 15% of frame width minimum
SWIPE_MIN_DURATION     = 0.20   // seconds
SWIPE_MAX_DURATION     = 1.5    // seconds
```

**State machine:** `IDLE → TRACKING → (emit) → IDLE`

```
IDLE:
  Record startX = wrist.x, startTs = now
  → TRACKING

TRACKING (each frame):
  rightDisp = startX − wX        // positive when x decreased (screen-right)
  leftDisp  = wX − startX        // positive when x increased (screen-left)

  if elapsed > SWIPE_MAX_DURATION:
    → IDLE (timeout)

  if rightDisp ≥ SWIPE_MIN_DISPLACEMENT AND elapsed ≥ SWIPE_MIN_DURATION:
    emit SWITCH_LEFT, → IDLE

  if leftDisp ≥ SWIPE_MIN_DISPLACEMENT AND elapsed ≥ SWIPE_MIN_DURATION:
    emit SWITCH_RIGHT, → IDLE
```

**Debug log (every TRACKING frame):**
```
[SWIPE] tracking: Right, rawDisplacement: -0.183, screenDir: RIGHT, duration: 0.312s
```

---

### OPEN\_MENU (fist → palm transition)

Requires a **deliberate fist→palm** transition. Static open palm without a prior fist never fires.

**Pose thresholds:**
```
isFist = countExtendedFingers ≤ 2    // ≤2 allows thumb to stick out
isOpen = countExtendedFingers ≥ 4 AND isPalmFacing

FIST_HOLD_MS   = 100    // ms fist must be held before palm phase starts
PALM_HOLD_MS   = 300    // ms open palm must be held (stable)
PALM_STABILITY = 0.05   // max wrist drift during palm hold (fraction of frame width)
```

**State machine:** `IDLE → FIST_DETECTED → PALM_OPENED → (emit) → IDLE`

```
IDLE:
  if isFist:
    fistStartTs = now
    → FIST_DETECTED

FIST_DETECTED (each frame):
  fistDurMs = now − fistStartTs
  if isFist:
    keep waiting
  else if isOpen AND fistDurMs ≥ FIST_HOLD_MS:
    palmStartTs = now, startWX = wrist.x
    → PALM_OPENED
  else:
    → IDLE (ambiguous pose or fist too brief)

PALM_OPENED (each frame):
  elapsed    = now − palmStartTs
  wristDelta = |wrist.x − startWX|
  if NOT isOpen:   → IDLE
  if wristDelta > PALM_STABILITY:  → IDLE (wrist drifted)
  if elapsed ≥ PALM_HOLD_MS / 1000:
    emit OPEN_MENU, → IDLE
```

**Debug logs:**
```
[OPEN_MENU] entered updatePalm
[OPEN_MENU] state: FIST_DETECTED, fingersExtended: 1, fistDuration: 87ms
[OPEN_MENU] state: PALM_OPENED, fingersExtended: 4, palmDuration: 210ms
```

---

### CLOSE\_MENU (palm → fist transition)

Requires a **deliberate, still palm** followed by an **explicit in-frame fist held briefly**. Hand withdrawal (disappearing from frame) does NOT trigger.

**Pose thresholds:**
```
isOpen = countExtendedFingers ≥ 4 AND isPalmFacing
isFist = countExtendedFingers ≤ 2

CLOSE_MIN_MS         = 300    // min palm hold before fist is accepted
CLOSE_MAX_MS         = 1000   // total sequence timeout
CLOSE_FIST_HOLD_MS   = 150    // fist must be held this long to fire
CLOSE_PALM_MAX_DRIFT = 0.06   // max wrist drift during palm phase (rejects reaching/withdrawal)
```

**State machine:** `IDLE → OPEN_SEEN → FIST_SEEN → (emit) → IDLE`

```
IDLE:
  if isOpen: openCount++
    if openCount ≥ REQUIRED_FRAMES:
      if OPEN_MENU is in FIST_DETECTED or PALM_OPENED:
        openCount = 0; return  ← OPEN_MENU has priority, defer
      startTs = now, palmStartWX = wrist.x
      → OPEN_SEEN
  else: openCount = 0

OPEN_SEEN (each frame):
  elapsed       = now − startTs
  wristMovement = |wrist.x − palmStartWX|

  if wristMovement > CLOSE_PALM_MAX_DRIFT:  → IDLE  (hand moving)
  if elapsed > CLOSE_MAX_MS / 1000:          → IDLE  (timeout)
  if isOpen: keep waiting
  if isFist AND elapsed ≥ CLOSE_MIN_MS / 1000:
    fistStartTs = now
    → FIST_SEEN
  else: → IDLE  (ambiguous or palm ended too soon)

FIST_SEEN (each frame):
  fistElapsed = now − fistStartTs
  if NOT isFist:  → IDLE  (fist broke)
  if palmElapsed > CLOSE_MAX_MS / 1000 + CLOSE_FIST_HOLD_MS / 1000:  → IDLE
  if fistElapsed ≥ CLOSE_FIST_HOLD_MS / 1000:
    emit CLOSE_MENU, → IDLE
```

**Debug logs:**
```
[CLOSE_MENU] entered updateClose
[CLOSE_MENU] IDLE: OPEN_MENU is in FIST_DETECTED, deferring OPEN_SEEN
[CLOSE_MENU] state: OPEN_SEEN, palmDur: 287ms, wristMovement: 0.021, fingersExtended: 4
[CLOSE_MENU] state: FIST_SEEN, fistDur: 112ms, fingersExtended: 1
```

---

## Mutual exclusion and priority

**OPEN_MENU priority** (more specific gesture wins):

Once OPEN_MENU has detected a fist and entered FIST_DETECTED or PALM_OPENED (`openMenuActive = true`):
1. `updateClose` IDLE block: if `hs.palm.state === "FIST_DETECTED" || "PALM_OPENED"` → resets `openCount = 0`, returns without advancing to OPEN_SEEN.
2. Main dispatch loop: the `closeIsTracking && !openMenuActive` guard is false, so the suppression reset is skipped and `updatePalm` is called regardless.

**CLOSE_MENU suppresses OPEN_MENU** (when OPEN_MENU hasn't started yet):

When `closeIsTracking` (close state is OPEN_SEEN or FIST_SEEN) AND `!openMenuActive` (palm state is IDLE):
- Resets `hs.palm` to IDLE (clears any partial state)
- Skips `updatePalm` call for that frame

---

## Global dispatch loop

```
proposeGestureFromLandmarks(results):
  log "[GESTURE FRAME] hands detected: N"    ← always, before any guard

  cooldownRemaining = COOLDOWN_MS − (now − lastProposalTs)
  if cooldownRemaining > 0:
    log "[GESTURE FRAME] in cooldown, Xms remaining"
    return null

  for each hand:
    skip if: no handedness | bad landmarks | span < MIN_HAND_SPAN | not yet accepted

    closeIsTracking = close.state ∈ {OPEN_SEEN, FIST_SEEN}
    openMenuActive  = palm.state ∈ {FIST_DETECTED, PALM_OPENED}

    if closeIsTracking AND NOT openMenuActive:
      reset palm to IDLE

    log "[GESTURE FRAME] side: accepted, swipe=X close=X palm=X ..."

    proposal = updateSwipe(...)
    if !proposal: proposal = updateClose(...)
    if !proposal AND (!closeIsTracking OR openMenuActive): proposal = updatePalm(...)

    if proposal:
      lastProposalTs = now
      resetHandState(Left), resetHandState(Right)
      return proposal

  reset state for any hand not seen this frame
  return null
```

---

## Global cooldown

```
COOLDOWN_MS = 1500   // ms after any gesture fires before detection resumes
```

After any proposal is emitted, all state machines are reset and the cooldown blocks `proposeGestureFromLandmarks` entirely for 1.5 s.

---

## Local confidence scoring

### Swipe

| Factor | Weight | Notes |
|--------|--------|-------|
| MediaPipe confidence | 0.30 | Raw score from MediaPipe handedness |
| Displacement margin | 0.40 | How far past 15% threshold the swipe went |
| Temporal fit | 0.15 | How close elapsed is to center of [0.2 s, 1.5 s] window |
| Hand size | 0.15 | Larger = landmarks more reliable |

Pose stability removed (swipe is pose-agnostic).

### OPEN_MENU (palm hold)

| Factor | Weight | Notes |
|--------|--------|-------|
| MediaPipe confidence | 0.25 | |
| Finger extension | 0.25 | count / 5 |
| Hold duration | 0.20 | bonus beyond 0.3 s |
| Wrist stability | 0.15 | penalises drift |
| Hand size | 0.15 | |

### CLOSE_MENU (palm→fist)

| Factor | Weight | Notes |
|--------|--------|-------|
| MediaPipe confidence | 0.25 | |
| Closure decisiveness | 0.25 | (openFingers − closeFingers) / openFingers |
| Temporal fit | 0.20 | centered on 0.55 s window |
| Gesture quality | 0.15 | fixed 1.0 (transition gesture) |
| Hand size | 0.15 | |

---

## Confidence routing

- **HIGH ≥ 0.85**: execute directly (not yet implemented — currently all go async)
- **MEDIUM 0.5–0.85**: send to Cosmos for async verification
- **LOW < 0.5**: ignore

---

## Ring buffer for evidence windows

- **Buffer size**: 30 frames (~1 s at 30 fps) in `web/src/ringbuffer.js`
- **Storage**: each entry = `canvas.toDataURL('image/jpeg', 0.7)` + landmarks + timestamp
- **On proposal**: `getEvidenceWindow(8)` extracts 8 evenly-spaced frames
- **Purpose**: sent to Cosmos verifier as visual evidence

---

## Edge cases

- **Both hands visible**: each hand has independent state (`perHand.Left`, `perHand.Right`). Gestures on different hands don't interfere except via the global cooldown.
- **Hand disappears mid-sequence**: state is reset to IDLE for that hand on the next frame it is absent.
- **CLOSE_MENU + OPEN_MENU conflict**: handled by the mutual exclusion logic above. The more-specific gesture (OPEN_MENU with fist precondition) always wins.
- **Swipe false positives from hand entry**: since `REQUIRED_FRAMES = 1`, swipe tracking starts immediately. The displacement threshold (15%) and min duration (0.2 s) filter out instantaneous entry artifacts.
