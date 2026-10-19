# quickcal-ai

QuickCalAI — AI-powered Google Calendar Chrome extension for IME4403

Development setup complete. Building QuickCalAI in small, verified increments.

## Install in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder, the one that contains `manifest.json`.

After later code changes, click the reload icon on the QuickCalAI card.

## Development extension ID

The `key` in `manifest.json` is this extension's public key. Chrome derives the extension ID from that key, so loading this folder unpacked keeps the same ID after every reload and on every machine that uses this manifest. Google OAuth needs that stable ID. Leave the key in place during normal development; replacing it creates a different extension ID.

This public key is not a Google OAuth client ID or client secret. The OAuth client ID is a separate value in the manifest.

After `manifest.json` changes, reload the extension and confirm the ID:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. If QuickCalAI is already listed, click its reload icon. If it is not loaded yet, click **Load unpacked** and select this folder.
4. Read the ID on the QuickCalAI card. It should be `mkihiedalmccmhoebiiikpdoafhdfglf`.

## Google Calendar connection

The manifest `oauth2.client_id` is the Chrome extension OAuth client for Google Calendar. In Google Cloud, that client must be the Chrome extension type and must allow extension ID `mkihiedalmccmhoebiiikpdoafhdfglf`. The project uses that client ID directly. Do not download, import, or commit a credentials JSON file or a client secret.

The toolbar icon still only shows or hides the input bar. Calendar settings open in their own tab:

1. Open `chrome://extensions`.
2. Find QuickCalAI and click **Details**, then **Extension options**. You can also right-click the QuickCalAI toolbar icon and choose **Options**.

Reload the extension from `chrome://extensions` after pulling these manifest changes, then use this checklist:

- [ ] Click **Connect Google Calendar**, approve the Google prompt, and wait until the page says **Google Calendar connected**. That text appears only after the Calendar API accepts a read-only check.
- [ ] Click **Connect Google Calendar** and close or cancel the Google prompt. The page explains that connection was cancelled and does not say connected.
- [ ] Close the settings tab and open Options again. If Calendar is still authorized, it says connected without a new Google prompt. If it is not authorized, it stays disconnected and does not prompt.
- [ ] Click **Disconnect**. The page no longer says connected. Reopening settings does not immediately connect again.
- [ ] Click **Connect Google Calendar** again. After approval and the Calendar check, it says connected.
- [ ] On a normal webpage, the toolbar icon still toggles the same input bar.

## Test event creation

After Calendar is connected, the settings page shows one predefined event: **QuickCalAI — Test Event**, tomorrow from 10:00–10:30 AM in this computer’s time zone. The page shows that calendar date, time, and time zone before anything is created. **Create test event** sends that event to the primary calendar. A normal event is created from the floating bar when you press Enter.

Reload the extension, connect Calendar, and use this checklist:

- [ ] While disconnected, **Create test event** stays disabled. The section still shows the title, tomorrow’s calendar date, 10:00–10:30 AM, and the time zone.
- [ ] Connect Google Calendar. Review that date, time, and time zone, then click **Create test event** once. The button stays disabled and the page says it is creating the event.
- [ ] When Google has saved it, the page says **Test event saved**, shows the same title and time, and offers **View in Google Calendar**. **Create test event** stays disabled.
- [ ] Open **View in Google Calendar** and confirm the event is tomorrow, 10:00–10:30 AM, on your primary calendar, with no guests.
- [ ] Close and reopen the settings page. It still shows the saved event and does not create another one.
- [ ] Click **Disconnect**. The saved confirmation disappears. Connect again and confirm the previous success is not shown.
- [ ] On a normal webpage, the toolbar icon still toggles the input bar. Pressing Enter on a complete sentence creates a normal event. **Create test event** remains on the settings page.

To delete the test event, open **View in Google Calendar**, or open [Google Calendar](https://calendar.google.com/) and go to the date shown on the settings page. Open **QuickCalAI — Test Event** and choose **Delete**. QuickCalAI does not delete it for you. A later connection can create the test event again, so delete any copies you no longer want.

## Local event extraction

`backend/` is a separate service. It turns event text into validated fields. It does not write to Google Calendar. Local development listens on `127.0.0.1:3000`. A hosted deployment listens on the port Render assigns. The hosted setup is in [Hosted parser on Render](#hosted-parser-on-render).

When you later pack QuickCalAI as an installable extension ZIP, exclude the whole `backend/` directory, `node_modules/`, `backend/.env`, and any other secret or key files. The ZIP should contain the extension only. Do not put an API key in that package, and do not serve this repository as the extension’s files.

The service reads `OPENAI_API_KEY` and `OPENAI_MODEL` from `backend/.env`. If `OPENAI_MODEL` is empty, it uses `gpt-6-luna` and does not switch models after an error. Install dependencies and run the simulated checks from `backend/`:

```powershell
Set-Location "C:\Users\charl\OneDrive - Cal Poly\Cal Poly\Third Year\Fall Semester\IME4403\QuickCal-AI Project\quickcal-ai\backend"
npm install
npm test
```

`npm test` does not call OpenAI and does not read a real API key. To try the model yourself, copy the example environment file, put your key only in `backend/.env`, and start the server:

```powershell
Copy-Item .env.example .env
notepad .env
npm start
```

Leave that window open. In a second PowerShell window, check that the server is up. This does not call OpenAI:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3000/health
```

The response includes `ok: true` and `apiKeyConfigured`. `apiKeyConfigured` is true only when `backend/.env` has a non-empty `OPENAI_API_KEY`. Put the key on that same line, as `OPENAI_API_KEY=...`. A key pasted on the following line by itself is also accepted. Restart the server after changing `.env`. Then send one of the examples below. Each one is a paid model call. Use your own IANA time zone if it is not `America/Los_Angeles`.

```powershell
function Send-ParseEvent($Text) {
  $json = @{ text = $Text; timeZone = "America/Los_Angeles" } | ConvertTo-Json
  Invoke-RestMethod `
    -Uri http://127.0.0.1:3000/parse-event `
    -Method POST `
    -ContentType "application/json; charset=utf-8" `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
}

Send-ParseEvent "Lunch with Priya on October 21, 2026 from 12:00 PM to 1:00 PM at Avila"
Send-ParseEvent "Coffee with Alex tomorrow from 10 to 10:30 AM"
Send-ParseEvent "Coffee with Alex"
```

- The lunch example is fully specified. Expect a title, the date `2026-10-21`, start `12:00`, end `13:00`, the requested time zone, location Avila, and `needsClarification` false.
- The coffee example gives a relative date and a range. Expect the local tomorrow for the time zone in the request, start `10:00`, end `10:30`, and no invented location. `needsClarification` can stay false when the date and both times are clear.
- The last example has no date or time. Expect those fields to be null, `needsClarification` true, and questions asking for the missing date and start time. A missing end time defaults to one hour. A missing location by itself is not a reason to ask.
- `Make a date every Friday with John at 6pm` is a weekly series. Expect the title **Date with John**, the next Friday at 6:00–7:00 PM in the request’s time zone, no location, and no end date. If that Friday’s 6 PM is already past, the series starts the following Friday.

The wording of the questions can vary. The server still checks that dates exist, times are `HH:mm`, and the end is later than the start on the same day. Stop the server with Ctrl+C in the window where `npm start` is running.

## Hosted parser on Render

Reference customers should use a hosted parser instead of running `backend/` themselves. The extension still writes to Google Calendar. This repository is not deployed yet; the settings below are the ones to enter in Render.

The backend loads `shared/schedule.js` from the repository root (`backend/src/schedule.js` reads `../../shared/schedule.js`). Render’s root directory must be the repository root. Do not set it to `backend/`, or the schedule file will be missing and the service will not start.

Create a Render Web Service:

| Setting | Value |
| --- | --- |
| Root directory | repository root (leave Render’s root directory empty) |
| Runtime | Node |
| Node version | 24 (`.node-version` and `backend/package.json` `engines`) |
| Build command | `npm ci --prefix backend` |
| Start command | `npm start --prefix backend` |
| Health check path | `/health` |

`GET /health` returns `{ "ok": true, "apiKeyConfigured": true or false }` and does not call OpenAI. `apiKeyConfigured` is true only when `OPENAI_API_KEY` is set. The response never includes the key, the allowlist, or a Google token. Use one instance. The per-user rate limit is stored in process memory, so it is not shared by more than one instance and it resets whenever the service restarts, redeploys, or spins down.

Render sets `PORT` and `RENDER=true`. With `RENDER=true`, the server binds `0.0.0.0` and that port. Local `npm start` binds `127.0.0.1:3000` when `PORT` is unset, and it stays on `127.0.0.1` if `PORT` is set. `NODE_ENV=production` or `RENDER=true` turns authentication on, and a value of `QUICKCAL_REQUIRE_AUTH=false` does not turn it off. If `GOOGLE_CLIENT_ID` or `ALLOWED_EMAILS` is missing, the process exits before it listens.

Set these environment variables in Render. Mark the key and the allowlist as secret. Use placeholders here; do not commit real values.

| Variable | Value |
| --- | --- |
| `OPENAI_API_KEY` | `YOUR_OPENAI_API_KEY` |
| `OPENAI_MODEL` | `gpt-6-luna` |
| `GOOGLE_CLIENT_ID` | the `oauth2.client_id` already in `manifest.json` |
| `ALLOWED_EMAILS` | `reference.customer@example.com,second.customer@example.com` |

Optional: `QUICKCAL_RATE_LIMIT_MAX` (default `30`) and `QUICKCAL_RATE_LIMIT_WINDOW_MS` (default `900000`, 15 minutes). Do not put the OpenAI key, the allowlist, or any shared password in the extension. Do not add a `backend/.env` file on Render. The disk is ephemeral, and the server does not use a database. Calendar events and the extension’s retry ids stay in Google Calendar and `chrome.storage.local`.

### Google configuration for the hosted parser

Keep the existing Chrome-extension OAuth client. Do not create a web client, and do not download a client secret. The Render URL is not an OAuth redirect or JavaScript origin. The extension still obtains the access token with `chrome.identity.getAuthToken`, and the server checks that token with Google.

On the OAuth consent screen, add the non-sensitive scope `https://www.googleapis.com/auth/userinfo.email`. Leave the Calendar scope at `https://www.googleapis.com/auth/calendar.events.owned`. Do not add `https://www.googleapis.com/auth/calendar` or a broader events scope. If the consent screen is in Testing, add each reference customer as a test user. That lets them receive a token. `ALLOWED_EMAILS` is a separate server-side list and is what decides who can call the paid parser.

The token Google returns must be for this extension’s client ID and must include a verified email. The server rejects tokens issued to another client, unverified emails, and emails that are not on `ALLOWED_EMAILS`. It does not accept an email, extension origin, or shared secret sent by the client.

### Extension changes for the hosted service

The extension still calls `http://127.0.0.1:3000/parse-event` and does not send the Google token. Local development can stay that way because local authentication is off. To use Render, change the extension as follows and then reload it. Each reference customer must connect Google Calendar again so the new email scope is on the token.

- In `manifest.json` `host_permissions`, add `https://YOUR_SERVICE.onrender.com/*`. Keep the Calendar and `https://oauth2.googleapis.com/*` permissions.
- In `manifest.json` `oauth2.scopes`, add `https://www.googleapis.com/auth/userinfo.email` next to the existing `https://www.googleapis.com/auth/calendar.events.owned` scope. Do not widen Calendar access.
- In `shared/local-parse.js`, set `PARSE_URL` to `https://YOUR_SERVICE.onrender.com/parse-event`.
- When `requestLocalParse` runs in `background.js`, send `Authorization: Bearer` and the access token already returned by `chrome.identity.getAuthToken`. Send the event text, time zone, and current event only. Do not send the user’s email or an API key.

## Event preview and save

With the backend running, the floating bar sends what you type to `http://127.0.0.1:3000/parse-event`. A complete event is created immediately. The card says **Creating event…** and then **Event successfully created** only after Google confirms it. If the date and start time are clear and no end time or duration was given, the event lasts one hour and the card says **1-hour default**. Incomplete text asks a question and creates nothing. After a successful save, the field says **Tell me what to change…**. A follow-up such as `Move it to 11 AM` updates that same calendar event. **New event** inside the card starts a separate event.

Start the backend from `backend/` if it is not already running. Restart it after pulling these parser changes:

```powershell
Set-Location "C:\Users\charl\OneDrive - Cal Poly\Cal Poly\Third Year\Fall Semester\IME4403\QuickCal-AI Project\quickcal-ai\backend"
npm install
npm test
npm start
```

Leave `npm start` running. In a second window, confirm the health check before using Chrome:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3000/health
```

`ok` should be true. `apiKeyConfigured` should be true before you expect a real preview. Reload QuickCalAI on `chrome://extensions` after this update. Connect Google Calendar from the extension’s settings page, then test on `https://example.com`:

- [ ] Click the toolbar icon. Only the rounded input pill opens. The field is focused, the microphone still says **Voice input coming soon**, and a downward chevron inside the pill can hide it.
- [ ] Type `Coffee with Alex tomorrow from 10 to 10:30 AM` and press Enter. The card says **Creating event…**, then **Event successfully created**, and offers **View in Google Calendar**. Open that link and confirm the event is on your primary calendar.
- [ ] Closing and reopening the bar does not create another copy. Pressing Enter again while it is still saving does not either. If saving fails, **Try again** uses the same attempt.
- [ ] The field now says **Tell me what to change…**. Type `Move it to 11 AM` and press Enter. The same calendar event moves to 11:00 and keeps its previous length. The card updates only after Google confirms the change.
- [ ] Click **New event**. The next complete sentence creates a separate event.
- [ ] Type `Coffee with Alex tomorrow at 10 AM` and press Enter. The created event ends one hour later and the card says **1-hour default**.
- [ ] Type `Coffee with Alex` and press Enter. The card asks for the missing date and time, and nothing is created.
- [ ] Disconnect on the settings page, submit a complete sentence, and choose **Connect Google Calendar**. The settings page opens and the sentence remains in the bar. Disconnect also clears the event that follow-up edits would change.
- [ ] Stop the backend with Ctrl+C, type a sentence, and press Enter again. The text stays in the field and the bar explains that the local parser could not be reached.
- [ ] Hide the pill with the chevron, Escape, and the toolbar icon. The same bar toggles, and a second bar never appears.
- [ ] Narrow the window and raise the browser zoom. The pill, its controls, and its shadow stay inside the window.
- [ ] Type `Make a date every Friday with John at 6pm` and press Enter. The card shows **Date with John**, the next Friday, **6:00–7:00 PM**, **Every Friday**, the time zone, and **No end date**. Open **View in Google Calendar** and confirm one weekly series with no guests and no end date.
- [ ] On a Friday before 6 PM, the same sentence starts today. After 6 PM, it starts the next Friday.
- [ ] Type `Coffee with John` and press Enter. The card asks for the date and start time and creates nothing.
- [ ] After the Friday series is saved, type `Move it to 7 PM`. The card asks before changing the series. Type `Change the entire series to 7 PM` to move that same series. **New event**, then a one-time sentence such as `Move it to 11 AM` on a non-repeating event, still changes only that event.

These browser steps use your real parser and your real calendar. The automated checks stub both and do not.

## Checkpoint 1 manual checklist

Test on a normal webpage, such as `https://example.com`. Chrome restricts injection into internal pages, so the bar will not appear on `chrome://` pages, the New Tab page, the Chrome Web Store, or other browser UI.

- [ ] Click the QuickCalAI toolbar icon. The input bar opens near the bottom-right, and the text field is focused.
- [ ] Type and edit text in the field.
- [ ] Press Enter. With the local parser running and Calendar connected, a complete sentence is created after Google confirms it. Incomplete text asks a question and creates nothing.
- [ ] After a successful save, type a change such as `Move it to 11 AM` and press Enter. That saved event is updated. **New event** returns to creating a separate event.
- [ ] Hide the pill with the chevron inside it, with Escape, and with the toolbar icon. The same bar toggles, and a second bar never appears.
- [ ] Narrow the browser window. The bar stays inside the window.
