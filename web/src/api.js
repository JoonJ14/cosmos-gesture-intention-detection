const EXECUTOR_BASE_URL = "http://127.0.0.1:8787";

// Verifier URL: configurable via ?verifier=http://dgx-ip:8788 query param.
// Can also be updated at runtime by calling setVerifierBaseUrl().
const _qpVerifier = new URLSearchParams(window.location.search).get("verifier");
let _verifierBaseUrl = _qpVerifier || "http://127.0.0.1:8788";

export function getVerifierBaseUrl() {
  return _verifierBaseUrl;
}

export function setVerifierBaseUrl(url) {
  _verifierBaseUrl = url;
}

// Student service URL: configurable via ?student=http://... query param.
const _qpStudent = new URLSearchParams(window.location.search).get("student");
let _studentBaseUrl = _qpStudent || "http://127.0.0.1:8789";

export function getStudentBaseUrl() {
  return _studentBaseUrl;
}

export function setStudentBaseUrl(url) {
  _studentBaseUrl = url;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function callVerifier(payload, timeoutMs = 800) {
  const url = new URL("/verify", _verifierBaseUrl);
  if (payload.force_reject === true) {
    url.searchParams.set("force_reject", "true");
  }

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Verifier request failed (${response.status}): ${body}`);
  }

  return response.json();
}

// Calls the student classifier service for execute/suppress prediction.
// Returns {execute, confidence, model_version, mode} or throws on network failure.
export async function callStudent(payload, timeoutMs = 500) {
  const url = new URL("/predict", _studentBaseUrl);
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(`Student request failed (${response.status})`);
  }
  return response.json();
}

export async function callExecutor(payload) {
  const url = new URL("/execute", EXECUTOR_BASE_URL);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Executor request failed (${response.status}): ${body}`);
  }

  return response.json();
}
