const BASE = "/api/automation";

export async function fetchInfo() {
  const res = await fetch(`${BASE}/info`);
  if (!res.ok) throw new Error(`Failed to load automation info: ${res.status}`);
  return res.json();
}

export async function startAutomation(providerId, serviceIds) {
  const res = await fetch(`${BASE}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, serviceIds }),
  });
  return res.json();
}

export async function stopAutomation(taskId) {
  const res = await fetch(`${BASE}/stop/${taskId}`, { method: "POST" });
  return res.json();
}

/**
 * Submits the solved reCAPTCHA token back to the backend so the paused
 * service can resume. Called by the CaptchaModal after the user solves it.
 */
export async function submitCaptchaToken(taskId, token) {
  const res = await fetch(`${BASE}/captcha/${taskId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return res.json();
}

/**
 * Signals the backend that the user finished registering on tvboom.vip,
 * unblocking the paused TVBoom service execution.
 */
export async function signalTvboomDone(taskId) {
  const res = await fetch(`${BASE}/tvboom-done/${taskId}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Unexpected response: ${res.status}`);
  }
  return res.json();
}

/**
 * Signals the backend that the user cancelled TVBoom registration,
 * causing the service to throw a cancellation error.
 */
export async function signalTvboomCancel(taskId) {
  const res = await fetch(`${BASE}/tvboom-cancel/${taskId}`, {
    method: "POST",
  });
  return res.json().catch(() => ({}));
}

/**
 * Open an SSE stream for a task and call handlers for each event type.
 * @returns {Function} unsubscribe — call to close the stream
 */
export function subscribeToTask(
  taskId,
  {
    onLog,
    onResult,
    onEmail,
    onCaptcha,
    onTvboomRegister,
    onDone,
    onError,
  } = {},
) {
  const es = new EventSource(`${BASE}/stream/${taskId}`);

  es.onmessage = (e) => {
    let event;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }

    switch (event.type) {
      case "log":
        onLog?.(event.data, event.timestamp);
        break;
      case "result":
        onResult?.(event.data);
        break;
      case "email_created":
        onEmail?.(event.data);
        break;
      case "error":
        onError?.(event.data);
        break;
      case "captcha_challenge":
        onCaptcha?.(event.data);
        break;
      case "tvboom_register":
        onTvboomRegister?.(event.data);
        break;
      case "done":
      case "stream_end":
        es.close();
        onDone?.(event.data);
        break;
      default:
        break;
    }
  };

  es.onerror = () => {
    es.close();
    onDone?.();
  };

  return () => es.close();
}
