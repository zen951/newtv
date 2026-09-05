/**
 * EmeraldIPTV -- API-based free trial (24-hour chunks, up to 7 days).
 *
 * Flow (pure JSON API -- no browser session required):
 *   1. POST /api/claim-trial/ with name, email, phone, and device type.
 *   2. Parse the response for Xtream Codes credentials (url/username/password)
 *      and/or the ready-made M3U URL.
 *
 * Notes:
 *   - The site issues 24-hour trial blocks; each call claims one 24-hour window.
 *   - "daily_cooldown" means a trial is already active for this email address.
 *   - "trial_limit" means all 7 days have already been claimed.
 *   - The "website" field is a honeypot -- must be left empty.
 *   - The server validates clientName looks like a real name (First Last)
 *     and clientPhone matches Irish mobile format (08X XXXXXXX or +353 8X...).
 */
import { buildM3u, buildResult } from "../parsing/generators.js";
import { jsonPost } from "../http/cookieClient.js";

// ── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = "https://emeraldiptv.irish";
const CLAIM_URL = `${BASE_URL}/api/claim-trial/`;
const TAG = "EmeraldIPTV";
const TRIAL_HOURS = 24;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Common Irish/English first and last names for plausible contact details.
const FIRST_NAMES = [
  "Liam",
  "Ciaran",
  "Sean",
  "Conor",
  "Brendan",
  "Niall",
  "Padraig",
  "Eoin",
  "Aoife",
  "Siobhan",
  "Niamh",
  "Caoimhe",
  "Roisin",
  "Fiona",
  "Sinead",
  "Orla",
  "James",
  "Patrick",
  "Michael",
  "David",
  "Daniel",
  "Emma",
  "Sarah",
  "Claire",
  "Kevin",
  "Declan",
  "Oisin",
  "Cillian",
  "Tadhg",
  "Ruairi",
  "Meadhbh",
  "Sorcha",
];
const LAST_NAMES = [
  "Murphy",
  "Kelly",
  "Brien",
  "Walsh",
  "Smith",
  "Sullivan",
  "Byrne",
  "Ryan",
  "Connor",
  "Neill",
  "Reilly",
  "Doyle",
  "McCarthy",
  "Gallagher",
  "Doherty",
  "Kennedy",
  "Lynch",
  "Murray",
  "Quinn",
  "Moore",
  "McLaughlin",
  "Carroll",
  "Connolly",
  "Nolan",
  "Burke",
  "Collins",
  "Campbell",
  "Clarke",
];

// Irish mobile prefixes (083/085/086/087/089).
const MOBILE_PREFIXES = ["083", "085", "086", "087", "089"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Returns a plausible Irish full name e.g. "Ciaran Murphy".
function generateIrishName() {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}

// Returns a 10-digit Irish mobile number e.g. "0871234567".
function generateIrishPhone() {
  const prefix = pick(MOBILE_PREFIXES);
  const suffix = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  return prefix + suffix;
}

// ── Service ───────────────────────────────────────────────────────────────────

export default {
  meta: {
    id: "emeraldiptv",
    name: "Emerald IPTV",
    description: "24 Hours",
  },

  async execute({ email, log = () => {} }) {
    const name = generateIrishName();
    const phone = generateIrishPhone();

    log(`[${TAG}] Submitting trial claim for ${email}...`);

    const data = await jsonPost(
      CLAIM_URL,
      null,
      {
        clientName: name,
        website: "", // honeypot -- must stay empty
        clientEmail: email,
        clientPhone: phone,
        deviceType: "m3u",
        deviceLabel: "Smart TV",
      },
      {
        referer: `${BASE_URL}/`,
        origin: BASE_URL,
        throwOnError: false,
        timeout: 25_000,
      },
    );

    // ── Error handling ───────────────────────────────────────────────────────────────────

    if (!data?.success) {
      const reason = data?.reason ?? "";
      const errMsg = data?.error ?? "Trial claim failed.";

      if (reason === "daily_cooldown") {
        throw new Error(
          `[${TAG}] A 24-hour trial is already active for this email -- try again tomorrow.`,
        );
      }
      if (reason === "trial_limit") {
        throw new Error(
          `[${TAG}] All 7 trial days have already been claimed for this email.`,
        );
      }
      throw new Error(`[${TAG}] ${errMsg}`);
    }

    // ── Extract credentials ───────────────────────────────────────────────────────────────────

    const d = data.data ?? {};
    const trial = data.trial ?? {};

    const serverUrl = d.url ?? null;
    const username = d.username ?? null;
    const password = d.password ?? null;
    const m3uUrl = d.m3uUrl ?? null;

    // Build an M3U link from Xtream credentials when the API returns a host URL.
    const builtM3u = buildM3u(serverUrl, username, password);
    const allM3uLinks = [...new Set([m3uUrl, builtM3u].filter(Boolean))];
    const tvPlaylist = allM3uLinks[0] ?? null;

    if (username) log(`[${TAG}] Username  : ${username}`);
    if (password) log(`[${TAG}] Password  : ${password}`);
    if (serverUrl) log(`[${TAG}] Server    : ${serverUrl}`);
    if (tvPlaylist) log(`[${TAG}] M3U       : ${tvPlaylist}`);
    if (!tvPlaylist)
      log(`[${TAG}] M3U link not found in API response.`, "warn");

    const claimNumber = trial.claimNumber ?? null;
    const remaining = trial.remaining ?? null;
    const noteExtra =
      claimNumber != null && remaining != null
        ? ` (Day ${claimNumber} of 7 -- ${remaining} day${remaining === 1 ? "" : "s"} remaining.)`
        : "";

    return buildResult({
      username,
      password,
      tvPlaylist,
      allM3uLinks,
      trialHours: TRIAL_HOURS,
      note: `${allM3uLinks.length ? "Emerald IPTV trial activated successfully." : "Emerald IPTV trial registered — M3U link not found."}${noteExtra}`,
    });
  },
};
