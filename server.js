// =============================================================================
// Mary Kay InTouch — Automated Session Service
// Runs on Render.com (Node.js + Playwright)
//
// ENDPOINTS:
//   GET  /health              — Health check (always public)
//   GET  /get-session         — Returns fresh/cached session for a consultant
//   POST /invalidate-session  — Forces a fresh login on next /get-session call
//
// ENVIRONMENT VARIABLES (set in Render Dashboard):
//   API_SECRET_KEY            — A secret token your Apps Script sends to authenticate
//   MK_ACCOUNT_<N>_NUM        — Consultant number, e.g. MK_ACCOUNT_1_NUM=JA7516
//   MK_ACCOUNT_<N>_PASS       — Password,           e.g. MK_ACCOUNT_1_PASS=Wemhoff824!
//   (Repeat for N = 1, 2, 3 ... for each consultant account)
// =============================================================================

"use strict";

const express    = require("express");
const { chromium } = require("playwright");

// Ensure Playwright can find its browser binaries on Render.com
// Render sets HOME to /opt/render, so the default cache path is correct.
// This line makes it explicit in case the env var is not set via render.yaml.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/render/.cache/ms-playwright";
}

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// =============================================================================
// CONFIGURATION — loaded from environment variables
// =============================================================================

const API_SECRET_KEY = process.env.API_SECRET_KEY || "";

// Build account map from environment variables
// e.g. MK_ACCOUNT_1_NUM=JA7516  MK_ACCOUNT_1_PASS=Wemhoff824!
//      MK_ACCOUNT_2_NUM=JB1234  MK_ACCOUNT_2_PASS=SomePass!
function loadAccounts() {
  const accounts = {};
  let n = 1;
  while (true) {
    const num  = process.env[`MK_ACCOUNT_${n}_NUM`];
    const pass = process.env[`MK_ACCOUNT_${n}_PASS`];
    if (!num || !pass) break;
    accounts[num.trim().toUpperCase()] = {
      consultantNum: num.trim().toUpperCase(),
      password:      pass.trim()
    };
    n++;
  }
  return accounts;
}

const ACCOUNTS = loadAccounts();
console.log(`[Config] Loaded ${Object.keys(ACCOUNTS).length} account(s):`, Object.keys(ACCOUNTS));

// =============================================================================
// IN-MEMORY SESSION CACHE
// Structure: { [consultantNum]: { session: {...}, fetchedAt: Date, valid: bool } }
// =============================================================================

const sessionCache = {};

// How long a cached session is considered fresh (23 hours — just under the 24h SF limit)
const SESSION_TTL_MS = 23 * 60 * 60 * 1000;

function isCacheValid(consultantNum) {
  const entry = sessionCache[consultantNum];
  if (!entry || !entry.valid) return false;
  const age = Date.now() - entry.fetchedAt;
  return age < SESSION_TTL_MS;
}

// =============================================================================
// MIDDLEWARE — API key authentication
// =============================================================================

function requireApiKey(req, res, next) {
  if (!API_SECRET_KEY) {
    // If no key is configured, allow all (useful for first-time setup)
    return next();
  }
  const provided = req.headers["x-api-key"] || req.query.apiKey;
  if (provided !== API_SECRET_KEY) {
    return res.status(401).json({ error: "Unauthorized: invalid API key" });
  }
  next();
}

// =============================================================================
// PLAYWRIGHT LOGIN — extracts all session credentials
// =============================================================================

async function loginAndGetSession(consultantNum, password) {
  console.log(`[Login] Starting Playwright login for consultant: ${consultantNum}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "en-US"
  });

  const page = await context.newPage();

  try {
    // ── Step 1: Navigate to the login page ────────────────────────────────────
    console.log(`[Login] Navigating to login page...`);
    await page.goto("https://mk.marykayintouch.com/s/login/?language=en_US", {
      waitUntil: "networkidle",
      timeout: 60000
    });

    // ── Step 2: Fill in credentials ───────────────────────────────────────────
    console.log(`[Login] Filling credentials...`);
    await page.waitForSelector('input[type="text"]', { timeout: 30000 });
    await page.fill('input[type="text"]',     consultantNum);
    await page.fill('input[type="password"]', password);

    // ── Step 3: Click login and wait for redirect ─────────────────────────────
    console.log(`[Login] Clicking login button...`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 60000 }),
      page.click('div[class*="login"]button, button:has-text("Log In"), div:has-text("Log In") >> nth=0')
        .catch(() => page.keyboard.press("Enter"))
    ]);

    // Confirm we are on the home page (not still on login)
    const currentUrl = page.url();
    console.log(`[Login] After login URL: ${currentUrl}`);
    if (currentUrl.includes("/login")) {
      throw new Error("Login failed — still on login page. Check credentials.");
    }

    // ── Step 4: Extract mk domain cookies ────────────────────────────────────
    console.log(`[Login] Extracting mk domain cookies...`);
    const mkCookiesRaw = await context.cookies("https://mk.marykayintouch.com");
    const mkCookies    = {};
    for (const c of mkCookiesRaw) {
      mkCookies[c.name] = c.value;
    }

    // ── Step 5: Extract Aura token from the page ──────────────────────────────
    console.log(`[Login] Extracting Aura token...`);
    let mkAuraToken = "";
    try {
      mkAuraToken = await page.evaluate(() => {
        try { return $A.clientService.Cc || ""; } catch (e) { return ""; }
      });
    } catch (e) {
      console.warn(`[Login] Could not extract Aura token: ${e.message}`);
    }

    // ── Step 6: Navigate to apps.marykayintouch.com ───────────────────────────
    console.log(`[Login] Navigating to apps domain...`);
    await page.goto("https://apps.marykayintouch.com/customer-list", {
      waitUntil: "networkidle",
      timeout: 60000
    });

    const appsUrl = page.url();
    console.log(`[Login] Apps domain URL: ${appsUrl}`);

    // ── Step 7: Extract apps domain cookies ───────────────────────────────────
    console.log(`[Login] Extracting apps domain cookies...`);
    const appsCookiesRaw = await context.cookies("https://apps.marykayintouch.com");
    const appsCookies    = {};
    for (const c of appsCookiesRaw) {
      appsCookies[c.name] = c.value;
    }

    const appsSid       = appsCookies["sid"]       || "";
    const appsBrowserId = appsCookies["BrowserId"] || mkCookies["BrowserId"] || "";

    // ── Step 8: Extract CSRF token by intercepting an apex API call ───────────
    console.log(`[Login] Extracting CSRF token...`);
    let appsCsrfToken = "";

    try {
      // Intercept the next fetch call to capture the csrf-token header
      appsCsrfToken = await page.evaluate(async () => {
        return new Promise((resolve) => {
          const origFetch = window.fetch;
          let resolved = false;

          window.fetch = function (url, opts) {
            if (!resolved && opts && opts.headers) {
              const h    = opts.headers;
              const csrf = (h instanceof Headers)
                ? (h.get("csrf-token") || h.get("x-csrf-token") || "")
                : (h["csrf-token"]     || h["x-csrf-token"]     || "");
              if (csrf) {
                resolved = true;
                window.fetch = origFetch;
                resolve(csrf);
              }
            }
            return origFetch.apply(this, arguments);
          };

          // Trigger a real apex call to force the csrf-token header to appear
          origFetch("/webruntime/api/apex/execute?language=en-US&asGuest=false&htmlEncode=false", {
            method:      "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json; charset=utf-8"
            },
            body: JSON.stringify({
              namespace:      "",
              classname:      "CMT_CustomerListController",
              method:         "getRelatedCustomers",
              params:         {},
              cacheable:      false,
              isContinuation: false
            })
          }).then(async (r) => {
            // Also try to get it from the response header as fallback
            if (!resolved) {
              const hCsrf = r.headers.get("csrf-token") || r.headers.get("x-csrf-token") || "";
              if (hCsrf) { resolved = true; window.fetch = origFetch; resolve(hCsrf); }
            }
          }).catch(() => {});

          // Timeout fallback after 10 seconds
          setTimeout(() => {
            if (!resolved) { resolved = true; window.fetch = origFetch; resolve(""); }
          }, 10000);
        });
      });
    } catch (e) {
      console.warn(`[Login] Could not extract CSRF token via intercept: ${e.message}`);
    }

    // If intercept didn't work, try getting it from a direct fetch response header
    if (!appsCsrfToken) {
      try {
        appsCsrfToken = await page.evaluate(async () => {
          const r = await fetch(
            "/webruntime/api/apex/execute?language=en-US&asGuest=false&htmlEncode=false",
            {
              method:      "POST",
              credentials: "include",
              headers:     { "Content-Type": "application/json; charset=utf-8" },
              body:        JSON.stringify({
                namespace: "", classname: "CMT_CustomerListController",
                method: "getRelatedCustomers", params: {},
                cacheable: false, isContinuation: false
              })
            }
          );
          return r.headers.get("csrf-token") || r.headers.get("x-csrf-token") || "";
        });
      } catch (e) {
        console.warn(`[Login] Fallback CSRF extraction failed: ${e.message}`);
      }
    }

    console.log(`[Login] Session extraction complete.`);
    console.log(`[Login] mk sid: ${mkCookies["sid"] ? mkCookies["sid"].substring(0, 30) + "..." : "MISSING"}`);
    console.log(`[Login] apps sid: ${appsSid ? appsSid.substring(0, 30) + "..." : "MISSING"}`);
    console.log(`[Login] auraToken: ${mkAuraToken ? mkAuraToken.substring(0, 30) + "..." : "MISSING"}`);
    console.log(`[Login] csrfToken: ${appsCsrfToken ? appsCsrfToken.substring(0, 30) + "..." : "MISSING"}`);

    if (!mkCookies["sid"]) {
      throw new Error("Login succeeded but mk sid cookie not found.");
    }

    return {
      consultantNum:  consultantNum,
      mkCookies:      mkCookies,
      mkAuraToken:    mkAuraToken,
      appsSid:        appsSid,
      appsBrowserId:  appsBrowserId,
      appsCsrfToken:  appsCsrfToken,
      fetchedAt:      new Date().toISOString()
    };

  } finally {
    await browser.close();
  }
}

// =============================================================================
// ROUTES
// =============================================================================

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:   "ok",
    accounts: Object.keys(ACCOUNTS),
    cached:   Object.keys(sessionCache).map(k => ({
      consultantNum: k,
      valid:         sessionCache[k].valid,
      fetchedAt:     sessionCache[k].session?.fetchedAt || null,
      ageMinutes:    sessionCache[k].fetchedAt
        ? Math.round((Date.now() - sessionCache[k].fetchedAt) / 60000)
        : null
    }))
  });
});

// ── Get session (main endpoint) ───────────────────────────────────────────────
//
// GET /get-session?consultantNum=JA7516
// Headers: x-api-key: <your secret>
//
// Returns:
// {
//   "consultantNum": "JA7516",
//   "mkCookies":     { "sid": "...", "oid": "...", ... },
//   "mkAuraToken":   "eyJ...",
//   "appsSid":       "00D1N...",
//   "appsBrowserId": "...",
//   "appsCsrfToken": "eyJ...",
//   "fetchedAt":     "2024-01-01T02:00:00.000Z",
//   "fromCache":     true
// }
//
app.get("/get-session", requireApiKey, async (req, res) => {
  const consultantNum = (req.query.consultantNum || "").trim().toUpperCase();

  if (!consultantNum) {
    return res.status(400).json({ error: "Missing required query param: consultantNum" });
  }

  const account = ACCOUNTS[consultantNum];
  if (!account) {
    return res.status(404).json({
      error: `Consultant number '${consultantNum}' is not configured on this server.`,
      configured: Object.keys(ACCOUNTS)
    });
  }

  // Return cached session if still valid
  if (isCacheValid(consultantNum)) {
    console.log(`[Session] Returning cached session for ${consultantNum}`);
    return res.json({ ...sessionCache[consultantNum].session, fromCache: true });
  }

  // Otherwise perform a fresh login
  console.log(`[Session] Cache miss or expired for ${consultantNum} — logging in...`);
  try {
    const session = await loginAndGetSession(account.consultantNum, account.password);
    sessionCache[consultantNum] = {
      session:   session,
      fetchedAt: Date.now(),
      valid:     true
    };
    return res.json({ ...session, fromCache: false });
  } catch (err) {
    console.error(`[Session] Login failed for ${consultantNum}:`, err.message);
    // Invalidate any stale cache entry
    if (sessionCache[consultantNum]) {
      sessionCache[consultantNum].valid = false;
    }
    return res.status(500).json({
      error:   "Login failed",
      message: err.message
    });
  }
});

// ── Invalidate session (force re-login on next call) ─────────────────────────
//
// POST /invalidate-session
// Body: { "consultantNum": "JA7516" }
// Headers: x-api-key: <your secret>
//
app.post("/invalidate-session", requireApiKey, (req, res) => {
  const consultantNum = (req.body.consultantNum || "").trim().toUpperCase();
  if (!consultantNum) {
    return res.status(400).json({ error: "Missing required body field: consultantNum" });
  }
  if (sessionCache[consultantNum]) {
    sessionCache[consultantNum].valid = false;
    console.log(`[Session] Invalidated cache for ${consultantNum}`);
  }
  res.json({ success: true, message: `Session invalidated for ${consultantNum}` });
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
  console.log(`[Server] Mary Kay Session Service running on port ${PORT}`);
  console.log(`[Server] Accounts configured: ${Object.keys(ACCOUNTS).join(", ") || "NONE — check env vars"}`);
  if (!API_SECRET_KEY) {
    console.warn("[Server] WARNING: API_SECRET_KEY is not set — all requests are unauthenticated!");
  }
});
