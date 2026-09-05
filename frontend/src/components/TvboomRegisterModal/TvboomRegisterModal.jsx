/**
 * TvboomRegisterModal
 *
 * Shown when the TVBoom service emits a `tvboom_register` event. Embeds the
 * real https://tvboom.vip/register URL in an <iframe> inside a full-screen
 * overlay so the reCAPTCHA runs on the correct domain without opening a
 * separate window or tab.
 *
 * Cross-origin note:
 *   The iframe is cross-origin — the browser's same-origin policy prevents
 *   reading its DOM, injecting field values, or detecting navigation
 *   programmatically. Credentials are displayed in a side panel for the user
 *   to copy and paste. Completion is confirmed by clicking "Done".
 *
 * Props:
 *   challenge   { taskId, registrationUrl, username, password, email } | null
 *   onDone      (taskId) => void   — called after backend confirmed
 *   onDismiss   () => void         — "Cancel Task" button
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { signalTvboomDone, signalTvboomCancel } from "../../services/api.js";
import "./TvboomRegisterModal.css";

export default function TvboomRegisterModal({ challenge, onDone, onDismiss }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null); // which field was just copied
  const copyTimerRef = useRef(null);

  // Reset state whenever a new challenge arrives.
  useEffect(() => {
    if (!challenge) return;
    setSubmitting(false);
    setError(null);
    setCopied(null);
  }, [challenge]);

  // Clean up copy timer on unmount.
  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  // Copy a value to the clipboard and show a brief "Copied!" indicator.
  const copyToClipboard = useCallback((field, value) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(field);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(null), 1800);
    });
  }, []);

  const handleDone = useCallback(async () => {
    if (!challenge) return;
    setSubmitting(true);
    setError(null);
    try {
      await signalTvboomDone(challenge.taskId);
      onDone?.(challenge.taskId);
    } catch (err) {
      setError(`Failed to signal backend: ${err.message}`);
      setSubmitting(false);
    }
  }, [challenge, onDone]);

  const handleCancel = useCallback(async () => {
    if (!challenge) return;
    try {
      await signalTvboomCancel(challenge.taskId);
    } catch {
      // Best-effort — the dismiss callback will cancel the task anyway.
    }
    onDismiss?.();
  }, [challenge, onDismiss]);

  if (!challenge) return null;

  const { username, password, email, taskId } = challenge;

  // srcdoc for the iframe: a minimal page that immediately submits a POST form
  // to the real tvboom.vip/register with the ToS acceptance field. The browser
  // navigates the iframe to tvboom.vip — the user sees and interacts with the
  // real, live registration page (including its domain-locked reCAPTCHA).
  const tosAutoSubmitSrcdoc = `<!DOCTYPE html>
<html>
<body style="margin:0;background:#fff;">
<form id="f" method="post" action="https://tvboom.vip/register">
  <input type="hidden" name="do" value="register">
  <input type="hidden" name="dle_rules_accept" value="yes">
</form>
<script>document.getElementById('f').submit();</script>
</body>
</html>`;

  return (
    <div
      className="tvboom-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="TVBoom Manual Registration"
    >
      <div className="tvboom-shell">
        {/* ── Side panel: credentials + controls ── */}
        <aside className="tvboom-sidebar">
          <div className="tvboom-sidebar-header">
            <span className="tvboom-modal-icon">📺</span>
            <div>
              <h2 className="tvboom-modal-title">TVBoom Registration</h2>
              <p className="tvboom-modal-sub">
                Fill in these credentials in the form, solve the CAPTCHA, then
                click <strong>Done</strong>.
              </p>
            </div>
          </div>

          <div className="tvboom-modal-divider" />

          {/* Credentials */}
          <div className="tvboom-credentials">
            <p className="tvboom-creds-label">Use in the registration form:</p>
            <CredentialRow
              label="Username"
              value={username}
              fieldKey="username"
              copied={copied}
              onCopy={copyToClipboard}
            />
            <CredentialRow
              label="Email"
              value={email}
              fieldKey="email"
              copied={copied}
              onCopy={copyToClipboard}
            />
            <CredentialRow
              label="Password"
              value={password}
              fieldKey="password"
              copied={copied}
              onCopy={copyToClipboard}
            />
          </div>

          <div className="tvboom-modal-divider" />

          {/* Steps */}
          <ol className="tvboom-steps">
            <li>Copy and paste each credential into the form on the right.</li>
            <li>Solve the reCAPTCHA on the TVBoom page.</li>
            <li>Submit the registration form.</li>
            <li>
              Click <strong>Done</strong> below.
            </li>
          </ol>

          {/* Spacer pushes footer to bottom */}
          <div className="tvboom-sidebar-spacer" />

          {/* Status feedback */}
          {submitting && (
            <div className="tvboom-status submitting">
              <div className="spinner" />
              <span>Confirming with backend…</span>
            </div>
          )}
          {error && (
            <div className="tvboom-status error">
              <span>⚠️ {error}</span>
            </div>
          )}

          <div className="tvboom-modal-divider" />

          {/* Footer */}
          <div className="tvboom-modal-footer">
            <p className="tvboom-footer-note">
              Task:{" "}
              <span className="tvboom-task-id">{taskId.slice(0, 8)}…</span>
            </p>
            <div className="tvboom-footer-actions">
              <button
                type="button"
                className="tvboom-cancel-btn"
                onClick={handleCancel}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="tvboom-done-btn"
                onClick={handleDone}
                disabled={submitting}
              >
                {submitting ? "Confirming…" : "✓ Done"}
              </button>
            </div>
          </div>
        </aside>

        {/* ── Iframe: auto-submits ToS then lands on real tvboom.vip registration ── */}
        <iframe
          className="tvboom-iframe"
          srcdoc={tosAutoSubmitSrcdoc}
          title="TVBoom Registration"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        />
      </div>
    </div>
  );
}

// ── Internal sub-component ────────────────────────────────────────────────────

function CredentialRow({ label, value, fieldKey, copied, onCopy }) {
  return (
    <div className="tvboom-cred-row">
      <span className="tvboom-cred-label">{label}</span>
      <code className="tvboom-cred-value">{value}</code>
      <button
        type="button"
        className={`tvboom-copy-btn ${copied === fieldKey ? "copied" : ""}`}
        onClick={() => onCopy(fieldKey, value)}
        aria-label={`Copy ${label}`}
      >
        {copied === fieldKey ? "✓" : "Copy"}
      </button>
    </div>
  );
}
