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
 * Cookie strategy: custom request client uses redirect:"manual" and manually follows
 * every hop, collecting Set-Cookie at each 302 — fetch() with redirect:"follow"
 * would silently drop cookies set on intermediate redirects.
 *
 * Vercel / Cloudflare compatibility:
 *   - Sends realistic Chrome client hint and sec-fetch headers to prevent WAF bot triggers.
 *   - Supports multi-strategy CSRF extraction (hidden input, inline LTV3_CSRF, meta tag).
 *   - Detects Cloudflare challenge/datacenter IP blocks with descriptive messages.
 *   - Supports HTTPS_PROXY / PROXY_URL environment variables for datacenter IP bypass.
 */
import {
  generateUsername,
  generatePassword,
  buildResult,
} from "../parsing/generators.js";
import { extractPlaylists } from "../parsing/extractors.js";
import {
  createJar,
  mergeCookies,
  cookieStr,
  extractInputValue,
  extractCsrfToken,
  plainText,
  stripHtml,
  errSnippet,
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
const DEFAULT_TIMEOUT = 30_000;
const MAX_REDIRECTS = 10;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Proxy Dispatcher (Lazy) ───────────────────────────────────────────────────

let proxyDispatcher = null;
let currentProxyUrl = null;

function getActiveProxy() {
  return (
    process.env.LIBERTYTV_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.PROXY_URL ||
    null
  );
}

async function getDispatcher() {
  const active = getActiveProxy();
  if (!active) return undefined;
  if (!proxyDispatcher || currentProxyUrl !== active) {
    try {
      const { ProxyAgent } = await import("undici");
      proxyDispatcher = new ProxyAgent(active);
      currentProxyUrl = active;
    } catch {
      // undici dispatcher fallback
    }
  }
  return proxyDispatcher;
}

// ── HTTP Client ───────────────────────────────────────────────────────────────

/**
 * Executes an HTTP request with full browser headers and manual redirect tracking
 * so cookies are properly preserved across 3xx redirects.
 */
async function ltvRequest(method, url, jar, opts = {}) {
  const {
    body = null,
    referer = null,
    origin = null,
    timeout = DEFAULT_TIMEOUT,
    fallbackHeaders = false,
  } = opts;

  const resolvedJar = jar ?? {};
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;
  const dispatcher = await getDispatcher();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const isPost = currentMethod === "POST";
    const currentOrigin = origin ?? new URL(currentUrl).origin;
    const cookieHeader = cookieStr(resolvedJar);

    let headers;
    if (fallbackHeaders) {
      headers = {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
        ...(referer ? { Referer: referer } : {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      };
    } else {
      headers = {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "sec-ch-ua":
          '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": isPost
          ? "same-origin"
          : referer
            ? "same-origin"
            : "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        ...(referer ? { Referer: referer } : {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      };
    }

    if (isPost) {
      Object.assign(headers, {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: currentOrigin,
        Referer: referer ?? currentUrl,
      });
    }

    const fetchOpts = {
      method: currentMethod,
      headers,
      body:
        isPost && currentBody
          ? new URLSearchParams(currentBody).toString()
          : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    };

    if (dispatcher) {
      fetchOpts.dispatcher = dispatcher;
    }

    const res = await fetch(currentUrl, fetchOpts);
    mergeCookies(resolvedJar, res);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).href;
      currentMethod = "GET";
      currentBody = null;
      continue;
    }

    return {
      text: await res.text(),
      finalUrl: currentUrl,
      status: res.status,
    };
  }

  throw new Error(`[${TAG}] Too many redirects from ${url}`);
}

const ltvGet = (url, jar, opts) => ltvRequest("GET", url, jar, opts);
const ltvPost = (url, jar, body, referer, opts) =>
  ltvRequest("POST", url, jar, { body, referer, ...opts });

// ── Multi-strategy CSRF Extractor ─────────────────────────────────────────────

function extractLibertyCsrf(html) {
  if (!html || typeof html !== "string") return null;

  // 1. Standard name="csrf" value="..."
  const m1 = /name\s*=\s*["']?csrf["']?[^>]*?value\s*=\s*["']([^"']+)["']/i.exec(
    html,
  );
  if (m1?.[1]) return m1[1];

  // 2. Reversed value="..." name="csrf"
  const m2 = /value\s*=\s*["']([^"']+)["'][^>]*?name\s*=\s*["']?csrf["']?/i.exec(
    html,
  );
  if (m2?.[1]) return m2[1];

  // 3. Inline JS variable: const LTV3_CSRF = "..."
  const m3 = /LTV3_CSRF\s*=\s*["']([^"']+)["']/i.exec(html);
  if (m3?.[1]) return m3[1];

  // 4. Object property: csrfToken: "..." or csrf_token = "..."
  const m4 = /(?:csrfToken|csrf_token)\s*[:=]\s*["']([^"']+)["']/i.exec(html);
  if (m4?.[1]) return m4[1];

  // 5. Shared generic extractors
  return extractInputValue(html, "csrf") || extractCsrfToken(html) || null;
}

// ── Steps ─────────────────────────────────────────────────────────────────────

// GETs the registration page, then POSTs the form.
// Returns the verification status and any CSRF/email values the server embedded
// in the redirect landing — avoids an extra GET that could reset the session.
async function register(jar, { name, email, password }, log) {
  const activeProxy = getActiveProxy();
  if (activeProxy) {
    const masked = activeProxy.replace(/:[^:@]+@/, ":****@");
    log(`[${TAG}] Routing requests via proxy (${masked})…`);
  }

  log(`[${TAG}] Fetching register page…`);
  let { text: regPage, status, finalUrl } = await ltvGet(REGISTER_URL, jar);

  // If initial response is 403 or 429, retry once with clean headers after a brief pause
  if (status === 403 || status === 429) {
    log(`[${TAG}] Initial request returned HTTP ${status}, retrying with clean headers…`, "warn");
    await new Promise((r) => setTimeout(r, 1500));
    const retry = await ltvGet(REGISTER_URL, jar, { fallbackHeaders: true });
    if (retry.status === 200 || extractLibertyCsrf(retry.text)) {
      regPage = retry.text;
      status = retry.status;
      finalUrl = retry.finalUrl;
    }
  }

  const csrf = extractLibertyCsrf(regPage);
  if (!csrf) {
    // Check for Cloudflare challenge / WAF blocking on Vercel datacenter IPs
    const isCloudflareBlocked =
      status === 403 ||
      status === 503 ||
      /<title>\s*(?:Just a moment|Attention Required).*?<\/title>/i.test(regPage) ||
      (status !== 200 &&
        /cf-turnstile|cf-browser-verification|cloudflare ray id/i.test(regPage));

    if (isCloudflareBlocked) {
      const rayId =
        /Cloudflare Ray ID:\s*<strong[^>]*>([^<]+)<\/strong>/i.exec(regPage)?.[1] ||
        /ray id[:\s]+([a-f0-9]+)/i.exec(regPage)?.[1] ||
        "";
      const rayInfo = rayId ? ` (Ray ID: ${rayId})` : "";
      throw new Error(
        `[${TAG}] Cloudflare bot protection blocked register.php (HTTP ${status}${rayInfo}). The target site is restricting Vercel datacenter IPs. Set HTTPS_PROXY or PROXY_URL in Vercel Environment Variables to bypass datacenter IP blocking.`,
      );
    }

    if (status >= 400) {
      throw new Error(
        `[${TAG}] register.php returned HTTP ${status}: ${errSnippet(regPage, 150)}`,
      );
    }

    const pageSnippet = stripHtml(regPage).slice(0, 200);
    throw new Error(
      `[${TAG}] Could not extract CSRF from register.php (HTTP ${status}, URL: ${finalUrl}). Page preview: "${pageSnippet}"`,
    );
  }

  log(`[${TAG}] ✅ CSRF extracted. Submitting registration for ${email}…`);
  const { finalUrl: landedUrl, text } = await ltvPost(
    REGISTER_URL,
    jar,
    { csrf, ref: "", tz_detected: "America/New_York", name, email, password },
    REGISTER_URL,
  );

  const verifycsrf = extractLibertyCsrf(text) ?? "";
  const emailFromPage = extractInputValue(text, "email") ?? "";
  const landed = landedUrl ?? "";

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
  const { text } = await ltvGet(VERIFY_URL, jar, {
    referer: REGISTER_URL,
  });
  return {
    csrf: extractLibertyCsrf(text) ?? "",
    emailFromPage: extractInputValue(text, "email") ?? "",
  };
}

// POSTs the OTP code to /verify-email.php.
// Throws if the server stays on the verify page or returns an error message.
async function submitOtp(jar, { emailFromPage, code, csrf }, log) {
  log(`[${TAG}] Submitting OTP: ${code}`);
  const { finalUrl: otpLanded, text } = await ltvPost(
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
  const { text: dash1, finalUrl: dashLanded } = await ltvGet(
    DASHBOARD_URL,
    jar,
    { referer: DASHBOARD_URL },
  );

  if ((dashLanded ?? "").includes("login") || dash1.includes("<title>Login"))
    throw new Error(
      `[${TAG}] Session invalid after OTP — landed on login page.`,
    );

  const csrf = extractLibertyCsrf(dash1);
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
  await ltvPost(
    CLAIM_TRIAL_URL,
    jar,
    { csrf, region_id: TRIAL_REGION, "trial-submit": "1" },
    DASHBOARD_URL,
  );
  log(`[${TAG}] ✅ Trial claimed.`);

  const { text: dash2 } = await ltvGet(DASHBOARD_URL, jar, {
    referer: DASHBOARD_URL,
  });
  return dash2;
}

// ── Service ───────────────────────────────────────────────────────────────────

export default {
  meta: {
    id: "libertytv",
    name: "LibertyTV (Gmails)",
    description: `${TRIAL_HOURS} Hours`,
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
      const { text } = await ltvGet(DASHBOARD_URL, jar, {
        referer: DASHBOARD_URL,
      });
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
