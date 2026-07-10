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
// CSRF TOKEN EXTRACTION — DEFINITIVE HELPER
// =============================================================================
// Called after the apps domain page is fully loaded.
// Uses 3 methods in order of reliability, stopping as soon as one succeeds.
//
// WHY THIS IS RELIABLE:
//   The apps.marykayintouch.com LWR (Lightning Web Runtime) page ALWAYS embeds
//   the CSRF token as a JWT (eyJ...) inside an inline <script> tag in the page
//   HTML. This is part of the LWR bootstrap process and is present on every
//   page load — it is not conditional on any user action or dynamic state.
//   We confirmed this by live inspection of the DOM on the customer-list page.
//
// WHAT COULD BREAK IT:
//   Only a major platform upgrade by Mary Kay / Salesforce that changes the
//   LWR bootstrap format would break this. That is extremely rare and would
//   also break many other things on the site simultaneously.

async function extractCsrfToken(page) {

  // ── Method A: Read from live DOM script tags (PRIMARY — most reliable) ──────
  // Iterates every inline <script> tag and finds the one containing
  // "csrfToken": "eyJ..." — the real JWT value, NOT the module path reference.
  // This works because the LWR bootstrap always writes the token here.
  try {
    const token = await page.evaluate(() => {
      for (const s of document.querySelectorAll("script:not([src])")) {
        const t = s.textContent;
        if (!t.includes("csrfToken")) continue;
        // Match the JWT value — starts with eyJ, contains only non-quote chars
        const m = t.match(/"csrfToken"\s*:\s*"(eyJ[^"]+)"/);
        if (m && m[1]) return m[1];
      }
      return "";
    });
    if (token) {
      console.log(`[Login] CSRF token found via DOM script tag inspection (Method A).`);
      return token;
    }
  } catch (e) {
    console.warn(`[Login] Method A (DOM script) failed: ${e.message}`);
  }

  // ── Method B: Read from window.LWR / window.CLWR runtime objects ────────────
  // After the LWR framework initialises, it stores configuration in window.LWR
  // and window.CLWR. The CSRF token is accessible via CLWR.serverData.
  try {
    const token = await page.evaluate(() => {
      try {
        // CLWR.serverData is the LWR server-side rendered data blob
        if (window.CLWR && window.CLWR.serverData) {
          const sd = window.CLWR.serverData;
          if (sd.csrfToken) return sd.csrfToken;
          // Sometimes nested under appContext
          if (sd.appContext && sd.appContext.csrfToken) return sd.appContext.csrfToken;
        }
        // Also try window.appConfig (older LWR versions)
        if (window.appConfig && window.appConfig.csrfToken) return window.appConfig.csrfToken;
        if (window.__lwr_app_config__ && window.__lwr_app_config__.csrfToken)
          return window.__lwr_app_config__.csrfToken;
        // Meta tag fallback
        const meta = document.querySelector('meta[name="csrf-token"]');
        if (meta) return meta.getAttribute("content");
        return "";
      } catch (e) { return ""; }
    });
    if (token) {
      console.log(`[Login] CSRF token found via window runtime objects (Method B).`);
      return token;
    }
  } catch (e) {
    console.warn(`[Login] Method B (window objects) failed: ${e.message}`);
  }

  // ── Method C: Raw HTML regex scan (FALLBACK) ─────────────────────────────────
  // Fetches the full page HTML as a string and scans it with a regex that
  // specifically matches JWT values (eyJ...) to avoid matching module paths.
  try {
    const html = await page.content();
    // Only match JWT-format values (eyJ...) — never match paths like /webruntime/...
    const m = html.match(/"csrfToken"\s*:\s*"(eyJ[^"\\]{20,}(?:\\.[^"\\]*)*)"/);
    if (m && m[1]) {
      // Unescape any \u003d (=) sequences that may be in the raw HTML
      const token = m[1].replace(/\\u003d/gi, "=").replace(/\\u002f/gi, "/");
      console.log(`[Login] CSRF token found via raw HTML regex scan (Method C).`);
      return token;
    }
  } catch (e) {
    console.warn(`[Login] Method C (HTML regex) failed: ${e.message}`);
  }

  // ── Method D: CDP Fetch interception — trigger a real API call ───────────────
  // Uses Chrome DevTools Protocol to intercept network requests at the OS level.
  // This catches the csrf-token request header that the LWR framework sends
  // automatically when making apex API calls. Unlike page.evaluate fetch(),
  // CDP interception sees ALL requests including those from the page's own JS.
  console.log(`[Login] Attempting CDP-level apex call for CSRF token (Method D)...`);
  try {
    const client = await page.target().createCDPSession();
    await client.send("Fetch.enable", {
      patterns: [{ urlPattern: "*/webruntime/api/apex/*", requestStage: "Request" }]
    });

    const csrfPromise = new Promise((resolve) => {
      client.on("Fetch.requestPaused", async (event) => {
        const hdrs = event.request.headers || {};
        const csrf = hdrs["csrf-token"] || hdrs["x-csrf-token"] || "";
        if (csrf) {
          console.log(`[Login] CSRF token captured via CDP interception (Method D).`);
          resolve(csrf);
        }
        try {
          await client.send("Fetch.continueRequest", { requestId: event.requestId });
        } catch (_) {}
      });
      setTimeout(() => resolve(""), 10000);
    });

    // Trigger an apex call from within the page context
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
      ).catch(() => {});
    });

    const token = await csrfPromise;
    await client.send("Fetch.disable").catch(() => {});

    if (token) return token;
  } catch (e) {
    console.warn(`[Login] Method D (CDP) failed: ${e.message}`);
  }

  console.warn(`[Login] All CSRF extraction methods exhausted — token not found.`);
  return "";
}

// =============================================================================
// PUPPETEER LOGIN
// =============================================================================

async function loginAndGetSession(consultantNum, password) {
  console.log(`[Login] Starting Puppeteer login for: ${consultantNum}`);

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

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log(`[Login] Using Chromium at: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
  }

  const browser = await puppeteer.launch(launchOptions);
  const page    = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );

  // Request interception — catches CSRF if it appears in a request header
  // during the initial page load (belt-and-suspenders approach)
  let earlyInterceptedCsrf = "";
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const headers = req.headers();
    const csrf    = headers["csrf-token"] || headers["x-csrf-token"] || "";
    if (csrf && !earlyInterceptedCsrf) {
      earlyInterceptedCsrf = csrf;
      console.log(`[Login] CSRF token captured early via request interception.`);
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

    // ── Step 9: Extract CSRF token ────────────────────────────────────────────
    // Use the early intercepted value if we already have it, otherwise run
    // the full 4-method extraction sequence.
    let capturedCsrfToken = earlyInterceptedCsrf;
    if (!capturedCsrfToken) {
      capturedCsrfToken = await extractCsrfToken(page);
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
