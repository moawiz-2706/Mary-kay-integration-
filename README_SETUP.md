# Mary Kay InTouch — Automated Session Integration

This package contains everything you need to completely automate your Mary Kay InTouch data extraction. You no longer need to manually copy/paste cookies every day!

## Architecture Overview

Since Mary Kay InTouch (Salesforce Experience Cloud) strictly enforces a 24-hour session limit, we've split the solution into two parts:

1. **Render.com Node.js Service**: A tiny, private server that uses Playwright to automatically log into Mary Kay InTouch with your credentials, extract all the necessary session cookies and tokens, and securely serve them via a REST API.
2. **Google Apps Script (v7)**: Your existing script, updated to call your new Render service to grab fresh cookies on the fly right before running the daily exports.

---

## Step 1: Deploy the Authentication Service to Render.com

1. **Create a GitHub Repository**
   - Create a new private repository on your GitHub account.
   - Upload the following files from this folder into the repository:
     - `package.json`
     - `server.js`
     - `render.yaml`
     - `.gitignore`

2. **Deploy to Render**
   - Go to [Render.com](https://render.com) and sign in.
   - Click **New +** and select **Web Service**.
   - Connect your GitHub account and select the repository you just created.
   - Render will automatically detect the Node.js environment.
   - Scroll down to the **Environment Variables** section and add the following:
     - `API_SECRET_KEY` = *(Create a strong random password, e.g., `my-super-secret-key-2026`)*
     - `MK_ACCOUNT_1_NUM` = `JA7516`
     - `MK_ACCOUNT_1_PASS` = `Wemhoff824!`
   - Click **Create Web Service**.
   - *Note: The build process will take a few minutes as it installs Playwright and Chromium.*

3. **Get Your Render URL**
   - Once the deployment is live, copy the URL provided by Render (e.g., `https://mk-session-service-xyz.onrender.com`).

---

## Step 2: Update Your Google Apps Script

1. Open your Google Apps Script project.
2. Replace your entire existing script with the contents of `GoogleAppsScript_v7.js`.
3. In the new script, locate **SECTION 1.2: RENDER SERVICE CONFIGURATION** (around line 24).
4. Update the configuration with your new Render details:
   ```javascript
   var RENDER_CONFIG = {
     url: "https://mk-session-service-xyz.onrender.com", // Paste your Render URL here
     apiKey: "my-super-secret-key-2026"                  // Paste your secret key here
   };
   ```
5. *(Optional)* Update your GoHighLevel API keys in Section 1.5 if they have changed.

---

## Step 3: Test the Automation

1. In the Google Apps Script editor, select the `runAllExports` function from the dropdown menu at the top.
2. Click **Run**.
3. Watch the **Execution Log**. You should see:
   - `[Session] Fetching fresh session from Render service for JA7516...`
   - `[Session] Successfully obtained fresh session for JA7516`
   - The script will then proceed to export all your CSVs and sync with GHL.

## How it works automatically

- Your Google Apps Script is scheduled to run daily at 2:00 AM.
- When it wakes up, it checks if the cached session is older than 23 hours.
- If it is, it pings your Render service.
- The Render service launches a headless browser, logs into Mary Kay, extracts the fresh cookies, and sends them back to Google Apps Script.
- The Google Apps Script uses those fresh cookies to pull all the data and sync it to GHL.
- **You never have to manually update cookies again!**
