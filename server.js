// =============================================================================
// Mary Kay InTouch — Automated Session Service
// Runs on Render.com (Node.js + Puppeteer)
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
const puppeteer  = require("puppeteer");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// =============================================================================
// CONFIGURATION — loaded from environment variables
// =============================================================================

const API_SECRET_KEY = process.env.API_SECRET_KEY || "";

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
// =============================================================================

const sessionCache = {};
const SESSION_TTL_MS = 23 * 60 * 60 * 1000; // 23 hours

function isCacheValid(consultantNum) {
  const entry = sessionCache[consultantNum];
  if (!entry || !entry.valid) return false;
  return (Date.now() - entry.fetchedAt) < SESSION_TTL_MS;
}

// =============================================================================
// MIDDLEWARE — API key authentication
// =============================================================================

function requireApiKey(req, res, next) {
  if (!API_SECRET_KEY) return next();
  const provided = req.headers["x-api-key"] || req.query.apiKey;
  if (provided !== API_SECRET_KEY) {
    return res.status(401).json({ error: "Unauthorized: invalid API key" });
  }
  next();
}

// =============================================================================
// PUPPETEER LOGIN — extracts all session credentials
// =============================================================================

async function loginAndGetSession(consultantNum, password) {
  console.log(`[Login] Starting Puppeteer login for: ${consultantNum}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process"
    ]
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );

  // Storage for CSRF token captured via request interception
  let capturedCsrfToken = "";

  try {
    // ── Step 1: Navigate to login page ───────────────────────────────────────
    console.log(`[Login] Navigating to login page...`);
    await page.goto("https://mk.marykayintouch.com/s/login/?language=en_US", {
      waitUntil: "networkidle2",
      timeout:   60000
    });

    // ── Step 2: Fill credentials ──────────────────────────────────────────────
    console.log(`[Login] Filling credentials...`);
    await page.waitForSelector('input[type="text"]', { timeout: 30000 });
    await page.type('input[type="text"]',     consultantNum, { delay: 50 });
    await page.type('input[type="password"]', password,      { delay: 50 });

    // ── Step 3: Submit and wait for redirect ──────────────────────────────────
    console.log(`[Login] Submitting login form...`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
      page.keyboard.press("Enter")
    ]);

    const postLoginUrl = page.url();
    console.log(`[Login] Post-login URL: ${postLoginUrl}`);

    if (postLoginUrl.includes("/login")) {
      throw new Error("Login failed — still on login page. Check credentials.");
    }

    // ── Step 4: Extract mk domain cookies ────────────────────────────────────
    console.log(`[Login] Extracting mk domain cookies...`);
    const allCookies = await page.cookies();
    const mkCookies  = {};
    for (const c of allCookies) {
      if (c.domain.includes("mk.marykayintouch.com") || c.domain.includes("marykayintouch.com")) {
        mkCookies[c.name] = c.value;
      }
    }

    // ── Step 5: Extract Aura token ────────────────────────────────────────────
    console.log(`[Login] Extracting Aura token...`);
    let mkAuraToken = "";
    try {
      mkAuraToken = await page.evaluate(() => {
        try { return $A.clientService.Cc || ""; } catch (e) { return ""; }
      });
    } catch (e) {
      console.warn(`[Login] Aura token not found: ${e.message}`);
    }

    // ── Step 6: Navigate to apps domain ──────────────────────────────────────
    console.log(`[Login] Navigating to apps domain...`);

    // Enable request interception to capture the csrf-token header
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const headers = req.headers();
      if (headers["csrf-token"] && !capturedCsrfToken) {
        capturedCsrfToken = headers["csrf-token"];
        console.log(`[Login] Captured CSRF token from request interception.`);
      }
      req.continue();
    });

    await page.goto("https://apps.marykayintouch.com/customer-list", {
      waitUntil: "networkidle2",
      timeout:   60000
    });

    console.log(`[Login] Apps domain URL: ${page.url()}`);

    // ── Step 7: Extract apps domain cookies ───────────────────────────────────
    console.log(`[Login] Extracting apps domain cookies...`);
    const appsCookiesRaw = await page.cookies();
    const appsCookies    = {};
    for (const c of appsCookiesRaw) {
      if (c.domain.includes("apps.marykayintouch.com")) {
        appsCookies[c.name] = c.value;
      }
    }

    const appsSid       = appsCookies["sid"]       || "";
    const appsBrowserId = appsCookies["BrowserId"] || mkCookies["BrowserId"] || "";

    // ── Step 8: If CSRF not captured yet, trigger an apex call ────────────────
    if (!capturedCsrfToken) {
      console.log(`[Login] CSRF not captured yet — triggering apex call...`);
      try {
        await page.evaluate(async () => {
          await fetch(
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
        });
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) {
        console.warn(`[Login] Apex call for CSRF failed: ${e.message}`);
      }
    }

    console.log(`[Login] ─── Extraction Summary ───`);
    console.log(`[Login] mk sid:       ${mkCookies["sid"]     ? mkCookies["sid"].substring(0,30)+"..."     : "MISSING"}`);
    console.log(`[Login] apps sid:     ${appsSid              ? appsSid.substring(0,30)+"..."              : "MISSING"}`);
    console.log(`[Login] auraToken:    ${mkAuraToken          ? mkAuraToken.substring(0,30)+"..."          : "MISSING"}`);
    console.log(`[Login] csrfToken:    ${capturedCsrfToken    ? capturedCsrfToken.substring(0,30)+"..."    : "MISSING"}`);

    if (!mkCookies["sid"]) {
      throw new Error("mk sid cookie not found after login — session may not have established.");
    }

    return {
      consultantNum:  consultantNum,
      mkCookies:      mkCookies,
      mkAuraToken:    mkAuraToken,
      appsSid:        appsSid,
      appsBrowserId:  appsBrowserId,
      appsCsrfToken:  capturedCsrfToken,
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

// ── Get session ───────────────────────────────────────────────────────────────
app.get("/get-session", requireApiKey, async (req, res) => {
  const consultantNum = (req.query.consultantNum || "").trim().toUpperCase();

  if (!consultantNum) {
    return res.status(400).json({ error: "Missing required query param: consultantNum" });
  }

  const account = ACCOUNTS[consultantNum];
  if (!account) {
    return res.status(404).json({
      error:      `Consultant '${consultantNum}' is not configured on this server.`,
      configured: Object.keys(ACCOUNTS)
    });
  }

  if (isCacheValid(consultantNum)) {
    console.log(`[Session] Returning cached session for ${consultantNum}`);
    return res.json({ ...sessionCache[consultantNum].session, fromCache: true });
  }

  console.log(`[Session] Cache miss — logging in for ${consultantNum}...`);
  try {
    const session = await loginAndGetSession(account.consultantNum, account.password);
    sessionCache[consultantNum] = { session, fetchedAt: Date.now(), valid: true };
    return res.json({ ...session, fromCache: false });
  } catch (err) {
    console.error(`[Session] Login failed for ${consultantNum}:`, err.message);
    if (sessionCache[consultantNum]) sessionCache[consultantNum].valid = false;
    return res.status(500).json({ error: "Login failed", message: err.message });
  }
});

// ── Invalidate session ────────────────────────────────────────────────────────
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
  console.log(`[Server] Accounts: ${Object.keys(ACCOUNTS).join(", ") || "NONE — check env vars"}`);
  if (!API_SECRET_KEY) {
    console.warn("[Server] WARNING: API_SECRET_KEY is not set!");
  }
});
