/**
 * LibertyTV free trial registration service — API-based.
 *
 * Flow (pure HTTP, form-based PHP site):
 *   1. GET  /register.php    → PHPSESSID cookie + CSRF token
 *   2. POST /register.php    → submit name / email / password
 *   3. Poll inbox            → wait for 6-digit verification code
 *   4. POST /verify-email.php → submit CSRF + email + code
 *   5. GET  /dashboard.php   → CSRF + trial-region form
 *   6. POST /claim-trial.php → claim Arabic Package (region 32)
 *   7. GET  /dashboard.php   → extract the M3U playlist link
 *
 * Cookie strategy: cookieClient uses redirect:"manual" and manually follows
 * every hop, collecting Set-Cookie at each 302 — fetch() with redirect:"follow"
 * would silently drop cookies set on intermediate redirects.
 */
import {
  generateUsername,
  generatePassword,
  buildResult,
} from "../parsing/generators.js";
import { extractPlaylists } from "../parsing/extractors.js";
import {
  createJar,
  get,
  post,
  extractInputValue,
  plainText,
  stripHtml,
} from "../http/cookieClient.js";

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = "https://account.libertytv.net";
const REGISTER_URL = `${BASE_URL}/register.php`;
const VERIFY_URL = `${BASE_URL}/verify-email.php`;
const DASHBOARD_URL = `${BASE_URL}/dashboard.php`;
const CLAIM_TRIAL_URL = `${BASE_URL}/claim-trial.php`;
const TAG = "LibertyTV";
const TRIAL_HOURS = 24;
const TRIAL_REGION = "32"; // Arabic Package

// ── Steps ─────────────────────────────────────────────────────────────────────

// GETs the registration page, then POSTs the form.
// Returns the verification status and any CSRF/email values the server embedded
// in the redirect landing — avoids an extra GET that could reset the session.
async function register(jar, { name, email, password }, log) {
  const { text: regPage } = await get(REGISTER_URL, jar);
  const csrf = extractInputValue(regPage, "csrf");
  if (!csrf)
    throw new Error(`[${TAG}] Could not extract CSRF from register.php.`);

  log(`[${TAG}] Submitting registration for ${email}…`);
  const { finalUrl, text } = await post(
    REGISTER_URL,
    jar,
    { csrf, ref: "", tz_detected: "America/New_York", name, email, password },
    REGISTER_URL,
  );

  const verifycsrf = extractInputValue(text, "csrf") ?? "";
  const emailFromPage = extractInputValue(text, "email") ?? "";
  const landed = finalUrl ?? "";

  const isVerifyPage =
    landed.includes("verify-email") ||
    text.includes("verify-email") ||
    text.includes("6-digit") ||
    text.includes("Verify your email");

  if (!isVerifyPage) {
    const errorMatch =
      /(too many|already registered|email.*already|invalid|error|failed)[^.]{0,120}/i.exec(
        plainText(text),
      );
    if (errorMatch)
      throw new Error(`[${TAG}] Registration failed: ${errorMatch[0].trim()}`);
    if (text.includes("dashboard") || text.includes("Dashboard")) {
      log(`[${TAG}] Server skipped verification — already on dashboard.`);
      return { status: "skip_verify", csrf: verifycsrf, emailFromPage };
    }
    // Strip scripts/styles to get a clean snippet for the error message.
    const pageSnippet = stripHtml(text).slice(0, 300);
    throw new Error(
      `[${TAG}] Unexpected page after registration: ${pageSnippet}`,
    );
  }

  log(`[${TAG}] ✅ Account registered — verification required.`);
  return { status: "need_verify", csrf: verifycsrf, emailFromPage };
}

// Fetches /verify-email.php and extracts a fresh CSRF + email hidden value.
// Only called when the registration redirect didn't land on the verify page.
async function getVerifyCsrf(jar) {
  const { text } = await get(VERIFY_URL, jar);
  return {
    csrf: extractInputValue(text, "csrf") ?? "",
    emailFromPage: extractInputValue(text, "email") ?? "",
  };
}

// POSTs the OTP code to /verify-email.php.
// Throws if the server stays on the verify page or returns an error message.
async function submitOtp(jar, { emailFromPage, code, csrf }, log) {
  log(`[${TAG}] Submitting OTP: ${code}`);
  const { finalUrl: otpLanded, text } = await post(
    VERIFY_URL,
    jar,
    { csrf, email: emailFromPage, code: String(code).trim() },
    VERIFY_URL,
  );

  const stayedOnVerify = (otpLanded ?? "").includes("verify-email");
  const hasError =
    text.includes("Invalid code") ||
    text.includes("invalid") ||
    text.includes("incorrect") ||
    text.includes("expired");

  if (stayedOnVerify || hasError) {
    const errMsg =
      /(invalid|incorrect|expired|error)[^.]{0,120}/i
        .exec(plainText(text))?.[0]
        ?.trim() ?? "code may be incorrect or expired";
    throw new Error(`[${TAG}] OTP verification failed — ${errMsg}`);
  }

  log(`[${TAG}] ✅ Email verified.`);
}

// GETs the dashboard to extract CSRF and trial form, then POSTs the trial claim.
// Returns the final dashboard HTML for M3U extraction.
async function claimTrial(jar, log) {
  const { text: dash1, finalUrl: dashLanded } = await get(DASHBOARD_URL, jar);

  if ((dashLanded ?? "").includes("login") || dash1.includes("<title>Login"))
    throw new Error(
      `[${TAG}] Session invalid after OTP — landed on login page.`,
    );

  const csrf = extractInputValue(dash1, "csrf");
  if (!csrf) {
    log(
      `[${TAG}] CSRF not found on dashboard — trial may already be active.`,
      "warn",
    );
    return dash1;
  }

  const hasTrialForm =
    dash1.includes("trial-region") ||
    dash1.includes("trial-submit") ||
    dash1.includes("claim-trial");
  if (!hasTrialForm) {
    log(`[${TAG}] Trial form not found — trial may already be active.`, "warn");
    return dash1;
  }

  log(`[${TAG}] Claiming trial (region ${TRIAL_REGION} — Arabic Package)…`);
  await post(
    CLAIM_TRIAL_URL,
    jar,
    { csrf, region_id: TRIAL_REGION, "trial-submit": "1" },
    DASHBOARD_URL,
  );
  log(`[${TAG}] ✅ Trial claimed.`);

  const { text: dash2 } = await get(DASHBOARD_URL, jar);
  return dash2;
}

// ── Service ───────────────────────────────────────────────────────────────────

export default {
  meta: {
    id: "libertytv",
    name: "LibertyTV (Gmails)",
    description: "24 Hours",
  },

  async execute({
    provider,
    credentialStore,
    email,
    inboxSeenIds = new Set(),
    log = () => {},
  }) {
    const username = generateUsername();
    const password = generatePassword();
    const jar = createJar();

    // Steps 1+2: Register and determine if verification is required.
    const regResult = await register(
      jar,
      { name: username, email, password },
      log,
    );

    let dashHtml = null;

    if (regResult.status !== "skip_verify") {
      let { csrf: verifyCsrf, emailFromPage } = regResult;

      // Fallback: GET the verify page if CSRF wasn't embedded in the redirect.
      if (!verifyCsrf)
        ({ csrf: verifyCsrf, emailFromPage } = await getVerifyCsrf(jar));

      // Step 3: Poll inbox for the 6-digit verification code.
      const code = await provider.waitForVerificationCodeEmail(
        credentialStore,
        {
          filterText: "liberty",
          seenIds: new Set(inboxSeenIds),
          timeout: 120_000,
        },
      );
      if (!code) throw new Error(`[${TAG}] Verification code not received.`);
      log(`[${TAG}] ✅ Verification code received: ${code}`);

      // Step 4: Submit OTP.
      await submitOtp(jar, { emailFromPage, code, csrf: verifyCsrf }, log);
    }

    // Steps 5+6: Claim the trial.
    dashHtml = await claimTrial(jar, log);

    // Step 7: Re-fetch the dashboard if the M3U link isn't present yet.
    if (!extractPlaylists(dashHtml)) {
      await new Promise((r) => setTimeout(r, 4_000));
      const { text } = await get(DASHBOARD_URL, jar);
      dashHtml = text;
    }

    const m3uLink = extractPlaylists(dashHtml)?.tvPlaylist ?? null;
    if (m3uLink) log(`[${TAG}] ✅ M3U extracted: ${m3uLink}`);
    else {
      // Log relevant dashboard lines to help diagnose the URL format.
      const relevantLines = dashHtml
        .split("\n")
        .filter((l) =>
          /http|url|link|playlist|stream|server|port|user|pass|trial|m3u|xtream/i.test(
            l,
          ),
        )
        .map((l) => l.trim().slice(0, 300))
        .join("\n");
      log(
        `[${TAG}] M3U link not found on dashboard. Relevant lines:\n${relevantLines}`,
        "warn",
      );
    }

    return buildResult({
      username,
      password,
      tvPlaylist: m3uLink ?? null,
      trialHours: TRIAL_HOURS,
      serviceName: "LibertyTV",
    });
  },
};
