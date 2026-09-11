/**
 * VibeFlix TV (vibeflixtv.com) — API-based free trial (4 hours).
 *
 * Flow:
 *   1. POST /wp-json/vibeflix/v1/send-verification
 *        { firstName, lastName, email, device, region, turnstileToken }
 *        → triggers a 6-digit OTP email; response: { status: "success" }
 *   2. Poll inbox → wait for the 6-digit verification code.
 *   3. POST /wp-json/vibeflix/v1/verify-and-create-trial
 *        { firstName, lastName, email, code, device, region }
 *        → activates trial; response: { status: "success", username, … }
 *   4. Poll inbox → wait for the welcome email containing M3U/Xtream credentials.
 *
 * Notes:
 *   - Turnstile is a Cloudflare browser challenge; we pass an empty string
 *     (the WordPress REST endpoint does not re-validate the token server-side
 *     for step 1; the primary guard is the OTP verification in step 3).
 *   - The trial lasts 24 hours.
 *   - "device" defaults to "firestick", "region" defaults to "all".
 */
import { buildResult } from "../parsing/generators.js";
import { jsonPost } from "../http/cookieClient.js";

// ── Config ───────────────────────────────────────────────────────────────────

const WP_BASE = "https://wp.vibeflixtv.com";
const SEND_URL = `${WP_BASE}/wp-json/vibeflix/v1/send-verification`;
const VERIFY_URL = `${WP_BASE}/wp-json/vibeflix/v1/verify-and-create-trial`;
const TRIAL_PAGE = "https://vibeflixtv.com/tv/iptv-free-trial/";
const TAG = "VibeFlix TV";
const TRIAL_HOURS = 24;

// ── Service ───────────────────────────────────────────────────────────────────

export default {
  meta: {
    id: "vibeflixtv",
    name: "VibeFlix TV",
    description: `${TRIAL_HOURS} Hours`,
  },

  async execute({
    provider,
    credentialStore,
    email,
    inboxSeenIds = new Set(),
    log = () => {},
  }) {
    const firstName = "John";
    const lastName = "Smith";

    // ── Step 1: Request OTP ──────────────────────────────────────────────────
    log(`[${TAG}] Requesting verification code for ${email}…`);

    const sendResult = await jsonPost(
      SEND_URL,
      null,
      {
        firstName,
        lastName,
        email,
        device: "firestick",
        region: "all",
        turnstileToken: "", // browser-only challenge; WP endpoint accepts empty
        website: "", // honeypot — must stay empty
        _ft: String(Date.now() - 60_000), // timing token — simulate 60s on page
      },
      {
        referer: TRIAL_PAGE,
        origin: "https://vibeflixtv.com",
        throwOnError: false,
        timeout: 30_000,
      },
    );

    if (sendResult?.status !== "success") {
      const errMsg =
        sendResult?.error ?? sendResult?.message ?? "Unknown error";
      throw new Error(`[${TAG}] Failed to send verification code: ${errMsg}`);
    }

    log(`[${TAG}] OTP sent. Polling inbox for 6-digit code…`);

    // ── Step 2: Poll inbox for the OTP ───────────────────────────────────────
    const code = await provider.waitForVerificationCodeEmail(credentialStore, {
      filterText: "vibeflix",
      seenIds: new Set(inboxSeenIds),
      timeout: 120_000,
    });

    if (!code) {
      throw new Error(
        `[${TAG}] Verification code was not received within 2 minutes.`,
      );
    }

    log(`[${TAG}] ✅ Verification code received: ${code}`);

    // ── Step 3: Verify code & create trial ──────────────────────────────────
    log(`[${TAG}] Submitting code to activate trial…`);

    const verifyResult = await jsonPost(
      VERIFY_URL,
      null,
      {
        firstName,
        lastName,
        email,
        code,
        device: "firestick",
        region: "all",
      },
      {
        referer: TRIAL_PAGE,
        origin: "https://vibeflixtv.com",
        throwOnError: false,
        timeout: 30_000,
      },
    );

    if (verifyResult?.status !== "success") {
      const errMsg =
        verifyResult?.error ?? verifyResult?.message ?? "Verification failed";
      throw new Error(`[${TAG}] ${errMsg}`);
    }

    const username = verifyResult?.username ?? null;
    const password = verifyResult?.password ?? null;
    const serverUrl = verifyResult?.url ?? verifyResult?.server ?? null;

    if (username) log(`[${TAG}] Username: ${username}`);
    if (password) log(`[${TAG}] Password: ${password}`);
    if (serverUrl) log(`[${TAG}] Server  : ${serverUrl}`);

    log(`[${TAG}] ✅ Trial activated. Polling inbox for credentials email…`);

    // ── Step 4: Poll inbox for the welcome/credentials email ─────────────────
    const playlists = await provider.waitForEmailAndExtractPlaylists(
      credentialStore,
      {
        filterText: "vibeflix",
        seenIds: new Set(inboxSeenIds),
        timeout: 300_000,
      },
    );

    const tvPlaylist = playlists?.tvPlaylist ?? null;
    const allM3uLinks = playlists?.allM3uLinks ?? [];

    if (allM3uLinks.length) {
      log(
        `[${TAG}] ✅ M3U extracted — TV: ${tvPlaylist ?? "none"}, total: ${allM3uLinks.length}`,
      );
    } else {
      log(`[${TAG}] No M3U links found in credentials email.`, "warn");
    }

    return buildResult({
      username: username ?? playlists?.username ?? null,
      password: password ?? playlists?.password ?? null,
      tvPlaylist,
      allM3uLinks,
      trialHours: TRIAL_HOURS,
      serviceName: TAG,
    });
  },
};
