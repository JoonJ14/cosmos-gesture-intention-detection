import { callExecutor, callVerifier, getVerifierBaseUrl, setVerifierBaseUrl } from "./api.js";
import {
  createEventId,
  createHandsPipeline,
  intentFromTestKey,
  proposeGestureFromLandmarks,
  setupCamera,
  startHandsCameraLoop,
} from "./gesture.js";
import { drawHandsOverlay, syncOverlaySize } from "./overlay.js";

const videoElement = document.getElementById("video");
const overlayElement = document.getElementById("overlay");
const safeModeToggle = document.getElementById("safeModeToggle");
const verifierTimeoutInput = document.getElementById("verifierTimeoutMs");
const verifierUrlInput = document.getElementById("verifierUrl");
const statusElement = document.getElementById("status");

// Initialize verifier URL input from query param or default, then keep in sync.
verifierUrlInput.value = getVerifierBaseUrl();
verifierUrlInput.addEventListener("change", (e) => {
  setVerifierBaseUrl(e.target.value.trim());
});

const EVENT_STATES = Object.freeze({
  PROPOSED: "proposed",
  VERIFYING: "verifying",
  APPROVED: "approved",
  REJECTED: "rejected",
  TIMEOUT: "timeout",
  EXECUTED: "executed",
});

const POLICY_PATHS = new Set([
  "proposed",
  "merge_inflight_verify",
  "safe_mode_verification",
  "verifier_timeout",
  "stale_verifier_response_ignored",
  "verifier_reject",
  "safe_mode_verified",
  "unsafe_direct",
  "superseded",
  "executor_error",
  "verifier_error",
  "runtime_error",
]);

const TERMINAL_STATES = new Set([
  EVENT_STATES.REJECTED,
  EVENT_STATES.TIMEOUT,
  EVENT_STATES.EXECUTED,
]);

const MERGE_WINDOW_MS = 250;

const eventStore = new Map();
let currentEventId = null;
let activeVerifyEventId = null;
let nextSequence = 0;

function nowMs() {
  return performance.now();
}

function roundMs(value) {
  if (typeof value !== "number") {
    return null;
  }
  return Math.round(value * 1000) / 1000;
}

function computeLatencyMs(startMs, endMs) {
  if (typeof startMs !== "number" || typeof endMs !== "number") {
    return null;
  }
  return roundMs(endMs - startMs);
}

function setStatus(message, level = "") {
  statusElement.textContent = message;
  statusElement.className = `status ${level}`.trim();
}

function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

function isEventTerminal(event) {
  return isTerminalState(event.state) || event.superseded;
}

function getEvent(eventId) {
  return eventStore.get(eventId) || null;
}

function isCurrentEvent(event) {
  return currentEventId === event.event_id && !event.superseded;
}

function setPolicyPath(event, policyPath) {
  event.policy_path = POLICY_PATHS.has(policyPath) ? policyPath : "runtime_error";
}

function setEventState(event, state) {
  event.state = state;
  event.updated_at_ms = nowMs();
}

function emitTerminalEventLog(event, terminalMs = nowMs()) {
  if (event.final_log_emitted) {
    return;
  }
  event.final_log_emitted = true;

  const ts = event.timestamps;
  const terminalReferenceMs =
    typeof ts.exec_recv_ms === "number" ? ts.exec_recv_ms : terminalMs;

  const payload = {
    event_id: event.event_id,
    proposed_intent: event.intent,
    safe_mode: event.safe_mode,
    policy_path: event.policy_path,
    merge_count: event.merge_count,
    proposal_start_ms: roundMs(ts.proposal_start_ms),
    verify_send_ms: roundMs(ts.verify_send_ms),
    verify_recv_ms: roundMs(ts.verify_recv_ms),
    exec_send_ms: roundMs(ts.exec_send_ms),
    exec_recv_ms: roundMs(ts.exec_recv_ms),
    latency_web_verify_ms: computeLatencyMs(ts.verify_send_ms, ts.verify_recv_ms),
    latency_web_exec_ms: computeLatencyMs(ts.exec_send_ms, ts.exec_recv_ms),
    latency_e2e_ms: computeLatencyMs(ts.proposal_start_ms, terminalReferenceMs),
    ...(event.superseded_by_event_id
      ? { superseded_by: event.superseded_by_event_id }
      : {}),
    ...(event.verifier_final_intent !== undefined
      ? { verifier_final_intent: event.verifier_final_intent }
      : {}),
    ...(event.verifier_intentional !== undefined
      ? { verifier_intentional: event.verifier_intentional }
      : {}),
    ...(event.verifier_confidence !== undefined
      ? { verifier_confidence: event.verifier_confidence }
      : {}),
  };

  console.log(payload);
}

function markSuperseded(event, reason, supersededByEventId) {
  if (!event || event.superseded) {
    return;
  }

  event.superseded = true;
  event.superseded_reason = reason;
  event.superseded_by_event_id = supersededByEventId;

  if (!isTerminalState(event.state)) {
    setEventState(event, EVENT_STATES.REJECTED);
  }

  setPolicyPath(event, "superseded");
  emitTerminalEventLog(event, nowMs());
}

function clearActiveVerifyIfMatch(eventId) {
  if (activeVerifyEventId === eventId) {
    activeVerifyEventId = null;
  }
}

function createEvent(intent, trigger, proposalStartMs) {
  const event = {
    event_id: createEventId(),
    sequence: ++nextSequence,
    intent,
    trigger,
    safe_mode: safeModeToggle.checked,
    state: EVENT_STATES.PROPOSED,
    superseded: false,
    superseded_reason: null,
    superseded_by_event_id: null,
    merge_count: 0,
    final_log_emitted: false,
    verifier_final_intent: undefined,
    verifier_intentional: undefined,
    verifier_confidence: undefined,
    policy_path: "proposed",
    created_at_ms: proposalStartMs,
    updated_at_ms: proposalStartMs,
    timestamps: {
      proposal_start_ms: proposalStartMs,
      proposal_last_updated_ms: proposalStartMs,
      verify_send_ms: null,
      verify_recv_ms: null,
      exec_send_ms: null,
      exec_recv_ms: null,
    },
  };

  eventStore.set(event.event_id, event);
  currentEventId = event.event_id;
  return event;
}

function updateMergedProposal(event, proposalTs) {
  event.merge_count += 1;
  event.updated_at_ms = proposalTs;
  event.timestamps.proposal_last_updated_ms = proposalTs;
  setPolicyPath(event, "merge_inflight_verify");

  setStatus(
    `Merged into in-flight event ${event.event_id} (${event.intent}), merge_count=${event.merge_count}.`,
    "warn",
  );
}

function findMergeCandidate(intent, proposalTs) {
  if (!activeVerifyEventId) {
    return null;
  }

  const activeEvent = getEvent(activeVerifyEventId);
  if (!activeEvent) {
    return null;
  }

  if (
    activeEvent.intent !== intent ||
    activeEvent.state !== EVENT_STATES.VERIFYING ||
    activeEvent.superseded
  ) {
    return null;
  }

  const ageMs = proposalTs - activeEvent.timestamps.proposal_last_updated_ms;
  if (ageMs < 0 || ageMs > MERGE_WINDOW_MS) {
    return null;
  }

  return activeEvent;
}

function supersedePreviousInFlightIfNeeded(newEventId) {
  if (!activeVerifyEventId) {
    return;
  }

  const previousEvent = getEvent(activeVerifyEventId);
  if (!previousEvent || previousEvent.event_id === newEventId || isEventTerminal(previousEvent)) {
    return;
  }

  markSuperseded(previousEvent, "newest_non_superseded_event_wins", newEventId);
}

function shouldBlockExecution(event) {
  if (event.superseded) {
    return true;
  }
  if (event.state === EVENT_STATES.REJECTED || event.state === EVENT_STATES.TIMEOUT) {
    return true;
  }
  if (!isCurrentEvent(event)) {
    return true;
  }
  return false;
}

async function processEvent(event) {
  let approvedIntent = event.intent;
  let stage = "runtime";

  try {
    if (event.safe_mode) {
      stage = "verifier";
      setEventState(event, EVENT_STATES.VERIFYING);
      setPolicyPath(event, "safe_mode_verification");
      event.timestamps.verify_send_ms = nowMs();
      activeVerifyEventId = event.event_id;

      const timeoutMs = Number.parseInt(verifierTimeoutInput.value, 10) || 800;
      let verifierResponse;
      try {
        verifierResponse = await callVerifier(
          {
            event_id: event.event_id,
            proposed_intent: event.intent,
            local_confidence: 0.7,
            policy_hint: "safe_mode",
          },
          timeoutMs,
        );
      } catch (err) {
        clearActiveVerifyIfMatch(event.event_id);
        event.timestamps.verify_recv_ms = nowMs();

        if (err.name === "AbortError") {
          if (!event.final_log_emitted && !event.superseded) {
            setEventState(event, EVENT_STATES.TIMEOUT);
            setPolicyPath(event, "verifier_timeout");
            setStatus(`Verifier timeout for ${event.event_id}; execution blocked.`, "warn");
            emitTerminalEventLog(event, event.timestamps.verify_recv_ms);
          }
          return;
        }

        throw err;
      }

      clearActiveVerifyIfMatch(event.event_id);
      event.timestamps.verify_recv_ms = nowMs();
      event.verifier_final_intent = verifierResponse.final_intent;
      event.verifier_intentional = verifierResponse.intentional;
      event.verifier_confidence = verifierResponse.confidence;

      if (event.state === EVENT_STATES.TIMEOUT || event.superseded || !isCurrentEvent(event)) {
        if (!event.final_log_emitted && !event.superseded && event.state !== EVENT_STATES.TIMEOUT) {
          setEventState(event, EVENT_STATES.REJECTED);
          setPolicyPath(event, "stale_verifier_response_ignored");
          emitTerminalEventLog(event, event.timestamps.verify_recv_ms);
        }
        return;
      }

      if (!verifierResponse.intentional || verifierResponse.final_intent === "NONE") {
        setEventState(event, EVENT_STATES.REJECTED);
        setPolicyPath(event, "verifier_reject");

        setStatus(`Verifier rejected ${event.event_id}; execution blocked.`, "warn");
        emitTerminalEventLog(event, event.timestamps.verify_recv_ms);
        return;
      }

      approvedIntent = verifierResponse.final_intent;
      setEventState(event, EVENT_STATES.APPROVED);
      setPolicyPath(event, "safe_mode_verified");
    } else {
      setEventState(event, EVENT_STATES.APPROVED);
      setPolicyPath(event, "unsafe_direct");
    }

    if (shouldBlockExecution(event)) {
      if (!event.final_log_emitted && !event.superseded && !isCurrentEvent(event)) {
        markSuperseded(event, "newest_non_superseded_event_wins", currentEventId);
      }
      return;
    }

    stage = "executor";
    event.timestamps.exec_send_ms = nowMs();
    await callExecutor({
      event_id: event.event_id,
      intent: approvedIntent,
      source: "web",
      dry_run: false,
    });
    event.timestamps.exec_recv_ms = nowMs();

    setEventState(event, EVENT_STATES.EXECUTED);

    setStatus(
      `Executed ${approvedIntent} (event ${event.event_id}) via ${event.policy_path}.`,
      "ok",
    );

    emitTerminalEventLog(event, event.timestamps.exec_recv_ms);
  } catch (error) {
    const terminalMs = nowMs();

    if (stage === "verifier" && event.timestamps.verify_recv_ms === null) {
      event.timestamps.verify_recv_ms = terminalMs;
    }
    if (stage === "executor" && event.timestamps.exec_recv_ms === null) {
      event.timestamps.exec_recv_ms = terminalMs;
    }

    if (stage === "verifier") {
      setPolicyPath(event, "verifier_error");
    } else if (stage === "executor") {
      setPolicyPath(event, "executor_error");
    } else {
      setPolicyPath(event, "runtime_error");
    }

    if (!event.superseded && !isTerminalState(event.state)) {
      setEventState(event, EVENT_STATES.REJECTED);
    }

    setStatus(`Error for ${event.event_id}: ${error.message}`, "bad");
    emitTerminalEventLog(event, terminalMs);
  }
}

function handleIntentProposal(intent, trigger = "unknown") {
  const proposalTs = nowMs();

  const mergeCandidate = findMergeCandidate(intent, proposalTs);
  if (mergeCandidate) {
    updateMergedProposal(mergeCandidate, proposalTs);
    return;
  }

  const event = createEvent(intent, trigger, proposalTs);

  supersedePreviousInFlightIfNeeded(event.event_id);

  void processEvent(event);
}

function installKeyboardIntentStub() {
  window.addEventListener("keydown", (event) => {
    const intent = intentFromTestKey(event.key);
    if (!intent) {
      return;
    }
    event.preventDefault();
    handleIntentProposal(intent, "keyboard_test");
  });
}

async function bootstrap() {
  try {
    await setupCamera(videoElement);
    syncOverlaySize(videoElement, overlayElement);

    const hands = createHandsPipeline((results) => {
      syncOverlaySize(videoElement, overlayElement);
      drawHandsOverlay(overlayElement, results);

      // Future gesture inference entrypoint; currently returns null.
      const maybeIntent = proposeGestureFromLandmarks(results);
      if (maybeIntent) {
        handleIntentProposal(maybeIntent, "landmark_stub");
      }
    });

    if (hands) {
      startHandsCameraLoop(videoElement, hands);
      setStatus("Webcam active. Press 1..4 to send test intents.", "ok");
    } else {
      setStatus("MediaPipe Hands unavailable; keyboard test mode only.", "warn");
    }

    installKeyboardIntentStub();
  } catch (error) {
    setStatus(`Initialization failed: ${error.message}`, "bad");
    console.error(error);
  }
}

bootstrap();
