// =============================================================================
// Mary Kay InTouch — Automated Session Service
// Runs on Render.com via Docker (Node.js + Puppeteer)
// =============================================================================

require("dotenv").config();

"use strict";

const express   = require("express");
const puppeteer = require("puppeteer");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// =============================================================================
// CONFIGURATION
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

const sessionCache   = {};
const SESSION_TTL_MS = 23 * 60 * 60 * 1000;

function isCacheValid(consultantNum) {
  const entry = sessionCache[consultantNum];
  if (!entry || !entry.valid) return false;
  return (Date.now() - entry.fetchedAt) < SESSION_TTL_MS;
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

function requireApiKey(req, res, next) {
  if (!API_SECRET_KEY) return next();
  const provided = req.headers["x-api-key"] || req.query.apiKey;
  if (provided !== API_SECRET_KEY) {
    return res.status(401).json({ error: "Unauthorized: invalid API key" });
  }
  next();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// PUPPETEER LOGIN
// =============================================================================

async function loginAndGetSession(consultantNum, password) {
  console.log(`[Login] Starting Puppeteer login for: ${consultantNum}`);

  // When running inside the Puppeteer Docker image, Chromium is pre-installed
  // at a fixed path. We use executablePath to point directly to it.
  // When running locally, executablePath is omitted and Puppeteer uses its
  // own downloaded Chromium automatically.
  const launchOptions = {
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process"
    ]
  };

  // If running inside Docker (Render), use the pre-installed Chromium
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log(`[Login] Using Chromium at: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
  }

  const browser = await puppeteer.launch(launchOptions);
  const page    = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );

  // Set up request interception FIRST — before any navigation
  let capturedCsrfToken = "";
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const headers = req.headers();
    const csrf    = headers["csrf-token"] || headers["x-csrf-token"] || "";
    if (csrf && !capturedCsrfToken) {
      capturedCsrfToken = csrf;
      console.log(`[Login] CSRF token captured via request interception.`);
    }
    req.continue();
  });

  try {
    // ── Step 1: Load the login page ───────────────────────────────────────────
    console.log(`[Login] Navigating to login page...`);
    await page.goto("https://mk.marykayintouch.com/s/login/?language=en_US", {
      waitUntil: "networkidle2",
      timeout:   60000
    });

    // ── Step 2: Fill credentials ──────────────────────────────────────────────
    console.log(`[Login] Filling credentials...`);
    await page.waitForSelector('input[type="text"]',     { timeout: 30000 });
    await page.waitForSelector('input[type="password"]', { timeout: 30000 });
    await page.type('input[type="text"]',     consultantNum, { delay: 60 });
    await page.type('input[type="password"]', password,      { delay: 60 });

    // ── Step 3: Submit and wait for redirect chain to complete ────────────────
    console.log(`[Login] Submitting login form...`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
      page.keyboard.press("Enter")
    ]);

    await sleep(3000);

    const postLoginUrl = page.url();
    console.log(`[Login] Post-login URL: ${postLoginUrl}`);

    if (postLoginUrl.includes("/login")) {
      throw new Error("Login failed — still on login page. Check credentials.");
    }

    // ── Step 4: Wait for Aura framework ──────────────────────────────────────
    console.log(`[Login] Waiting for Aura framework...`);
    try {
      await page.waitForFunction(
        () => typeof $A !== "undefined" && $A.clientService,
        { timeout: 20000 }
      );
    } catch (e) {
      console.warn(`[Login] Aura framework not ready — continuing anyway.`);
    }

    // ── Step 5: Extract mk domain cookies ────────────────────────────────────
    console.log(`[Login] Extracting mk domain cookies...`);
    const allCookies = await page.cookies();
    const mkCookies  = {};
    for (const c of allCookies) mkCookies[c.name] = c.value;
    console.log(`[Login] mk cookies: ${Object.keys(mkCookies).join(", ")}`);

    // ── Step 6: Extract Aura token ────────────────────────────────────────────
    console.log(`[Login] Extracting Aura token...`);
    let mkAuraToken = "";
    try {
      mkAuraToken = await page.evaluate(() => {
        try {
          if ($A && $A.clientService && $A.clientService.Cc)    return $A.clientService.Cc;
          if ($A && $A.clientService && $A.clientService.token) return $A.clientService.token;
          return "";
        } catch (e) { return ""; }
      });
    } catch (e) {
      console.warn(`[Login] Aura token extraction error: ${e.message}`);
    }

    if (!mkAuraToken) {
      try {
        const html  = await page.content();
        const match = html.match(/"token"\s*:\s*"(eyJ[^"]+)"/);
        if (match) { mkAuraToken = match[1]; console.log(`[Login] Aura token found in HTML.`); }
      } catch (e) {}
    }

    // ── Step 7: Navigate to apps domain (SAML SSO multi-hop) ─────────────────
    console.log(`[Login] Navigating to apps domain (SAML SSO)...`);
    await page.goto("https://apps.marykayintouch.com/customer-list", {
      waitUntil: "networkidle2",
      timeout:   90000
    });
    await sleep(5000);

    console.log(`[Login] Final apps URL: ${page.url()}`);

    // ── Step 8: Extract apps domain cookies ───────────────────────────────────
    console.log(`[Login] Extracting apps domain cookies...`);
    const appsCookiesAll = await page.cookies();
    const appsCookies    = {};
    for (const c of appsCookiesAll) {
      if (c.domain.includes("apps.marykayintouch.com")) appsCookies[c.name] = c.value;
    }
    console.log(`[Login] apps cookies: ${Object.keys(appsCookies).join(", ")}`);

    const appsSid       = appsCookies["sid"]       || "";
    const appsBrowserId = appsCookies["BrowserId"] || mkCookies["BrowserId"] || "";

    // ── Step 9: Trigger apex call to capture CSRF token if not yet captured ───
    if (!capturedCsrfToken) {
      console.log(`[Login] Triggering apex call to capture CSRF token...`);
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
        await sleep(4000);
      } catch (e) {
        console.warn(`[Login] Apex call failed: ${e.message}`);
      }
    }

    // ── Step 10: Summary ──────────────────────────────────────────────────────
    console.log(`[Login] ─── Extraction Summary ───`);
    console.log(`[Login] mk sid:    ${mkCookies["sid"]  ? mkCookies["sid"].substring(0,35)+"..."  : "MISSING"}`);
    console.log(`[Login] apps sid:  ${appsSid           ? appsSid.substring(0,35)+"..."           : "MISSING"}`);
    console.log(`[Login] auraToken: ${mkAuraToken       ? mkAuraToken.substring(0,35)+"..."       : "MISSING"}`);
    console.log(`[Login] csrfToken: ${capturedCsrfToken ? capturedCsrfToken.substring(0,35)+"..." : "MISSING"}`);

    if (!mkCookies["sid"]) {
      throw new Error("mk sid cookie not found — session did not establish correctly.");
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

app.get("/get-session", requireApiKey, async (req, res) => {
  const consultantNum = (req.query.consultantNum || "").trim().toUpperCase();
  if (!consultantNum) return res.status(400).json({ error: "Missing consultantNum" });

  const account = ACCOUNTS[consultantNum];
  if (!account) {
    return res.status(404).json({
      error:      `Consultant '${consultantNum}' not configured.`,
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
    console.error(`[Session] Login failed:`, err.message);
    if (sessionCache[consultantNum]) sessionCache[consultantNum].valid = false;
    return res.status(500).json({ error: "Login failed", message: err.message });
  }
});

app.post("/invalidate-session", requireApiKey, (req, res) => {
  const consultantNum = (req.body.consultantNum || "").trim().toUpperCase();
  if (!consultantNum) return res.status(400).json({ error: "Missing consultantNum" });
  if (sessionCache[consultantNum]) sessionCache[consultantNum].valid = false;
  res.json({ success: true, message: `Session invalidated for ${consultantNum}` });
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Accounts: ${Object.keys(ACCOUNTS).join(", ") || "NONE"}`);
  if (!API_SECRET_KEY) console.warn("[Server] WARNING: API_SECRET_KEY is not set!");
});
