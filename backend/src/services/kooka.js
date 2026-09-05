/**
 * kooka.tv — free 12-hour trial registration (API-based).
 *
 * Single POST to /api/trial/signup returns all credentials.
 * No browser, no CSRF, no email verification — purely HTTP JSON.
 */
import {
  generateUsername,
  generatePhone,
  buildM3u,
  buildResult,
} from "../parsing/generators.js";
import { jsonPost } from "../http/cookieClient.js";

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = "https://kooka.tv";
const SIGNUP_URL = `${BASE_URL}/api/trial/signup`;
const TAG = "Kooka";

// ── Service ───────────────────────────────────────────────────────────────────

export default {
  meta: {
    id: "kooka",
    name: "Kooka.TV",
    description: "12 Hours",
  },

  async execute({ email, log = () => {} }) {
    const resolvedEmail = email ?? `${generateUsername()}@gmail.com`;

    log(`[${TAG}] Submitting trial signup for ${resolvedEmail}...`);
    const data = await jsonPost(
      SIGNUP_URL,
      null,
      {
        email: resolvedEmail,
        whatsapp: generatePhone(),
        // fpComponents mirrors the browser fingerprint stub; empty array is accepted.
        fpComponents: [],
      },
      { referer: `${BASE_URL}/`, throwOnError: false, timeout: 20_000 },
    );

    if (!data?.ok)
      throw new Error(
        `[${TAG}] Signup rejected: ${data?.displayMessage ?? data?.reason ?? JSON.stringify(data)}`,
      );

    const t = data.trial ?? data;
    const username = t.username ?? t.user ?? null;
    const password = t.password ?? t.pass ?? null;
    const expiryDate = t.expiresAt ? new Date(t.expiresAt) : null;

    const m3uUrl = t.m3uUrl ?? t.m3u ?? null;
    const primaryM3u = buildM3u(
      t.primaryServer ?? t.server ?? t.host,
      username,
      password,
    );
    const backupM3u = buildM3u(t.secondaryServer, username, password);
    const allM3uLinks = [
      ...new Set([backupM3u, primaryM3u, m3uUrl].filter(Boolean)),
    ];

    if (m3uUrl) log(`[${TAG}] ✅ M3U URL    : ${m3uUrl}`);
    if (primaryM3u) log(`[${TAG}] ✅ M3U primary: ${primaryM3u}`);
    if (backupM3u) log(`[${TAG}] ✅ M3U backup : ${backupM3u}`);
    if (!allM3uLinks.length)
      log(`[${TAG}] M3U link not found in API response.`, "warn");

    return buildResult({
      username,
      password,
      tvPlaylist: allM3uLinks.join("\n") || null,
      allM3uLinks,
      expiryDate,
      serviceName: "Kooka.TV",
    });
  },
};
