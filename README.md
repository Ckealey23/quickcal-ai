# quickcal-ai

QuickCalAI — AI-powered Google Calendar Chrome extension for IME4403

Development setup complete. Building QuickCalAI in small, verified increments.

## Install in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder, the one that contains `manifest.json`.

After later code changes, click the reload icon on the QuickCalAI card.

## Testing finite schedules locally

Finite daily windows and weekday patterns within a month resolve to explicit dates.
A month without a year uses the user's local current year, including past dates in
that month. Exclusions are removed before saving. Missing times prompt for a time;
an omitted duration uses the existing one-hour default. Calendar receives a finite
`RDATE` list: separate timed occurrences linked as one bounded schedule, with no
indefinite repetition. Date ranges are limited to 366 days. Different time windows
within one request and overnight schedules still require clarification.

With Node 24 or newer installed, from the repository folder:

```sh
npm ci --prefix backend
node --test backend/test/bounded-schedule.test.js backend/test/parse.test.js backend/test/local-parse.test.js backend/test/calendar-save.test.js
npm test --prefix backend
```

These tests mock model and Calendar calls and create no real events. They use fixed
reference dates for schedule assertions. No extension build is required. Reload
QuickCalAI at `chrome://extensions`, then refresh the webpage containing the bar.

The extension uses the hosted parser by default; reloading it does not deploy backend changes.
For an unpacked local test, create the Git-ignored `shared/local-config.js` containing
`self.QuickCalUseLocalBackend = true;`. Start the local backend, reload the extension,
and refresh the webpage. Parsing, health checks, access checks, and transcription
then use `http://127.0.0.1:3000`. Google Calendar still receives real events.
Set the flag to `false` and reload to switch back to the hosted server.
Never include `shared/local-config.js` in a distributed extension ZIP.
To test the updated parser locally, configure `backend/.env` as described below,
run `npm start --prefix backend`, and in another terminal run:

```sh
curl http://127.0.0.1:3000/parse-event \
  -H 'Content-Type: application/json' \
  -d '{"text":"CPR training every m/w/f in November 2026 except the 4th","timeZone":"America/Los_Angeles"}'
```

This parser-only request calls the model but does not create Calendar events.
Check `recurrence.dates` for 12 dates and a time-only clarification. To test a
follow-up, send `text: "9am–10am"` with the same timezone and a `clarification`
object containing `originalText` and the returned event as `draft`. The dates
must remain unchanged. Other users using the hosted server need the updated
backend to be deployed separately.

## Development extension ID

The `key` in `manifest.json` is this extension's public key. Chrome derives the extension ID from that key, so loading this folder unpacked keeps the same ID after every reload and on every machine that uses this manifest. Google OAuth needs that stable ID. Leave the key in place during normal development; replacing it creates a different extension ID.

This public key is not a Google OAuth client ID or client secret. The OAuth client ID is a separate value in the manifest.

After `manifest.json` changes, reload the extension and confirm the ID:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. If QuickCalAI is already listed, click its reload icon. If it is not loaded yet, click **Load unpacked** and select this folder.
4. Read the ID on the QuickCalAI card. It should be `epnmambadhgonpaplpfgajhdpbkaiikb`.

## Google Calendar connection

The manifest `oauth2.client_id` is the Chrome extension OAuth client for Google Calendar. In Google Cloud, that client must be the Chrome extension type and must allow extension ID `epnmambadhgonpaplpfgajhdpbkaiikb`. The project uses that client ID directly. Do not download, import, or commit a credentials JSON file or a client secret.

The toolbar icon shows or hides the floating widget. A new installation does **not** open the options tab. First-use onboarding runs inside the widget the first time QuickCal opens on a supported webpage. Google’s prompt starts only after **Connect Google** is clicked on the Connect step.

1. Open `chrome://extensions`.
2. Find QuickCalAI and click **Details**, then **Extension options** for connection management or **Replay welcome tour**. You can also right-click the QuickCalAI toolbar icon and choose **Options**.

Reload the extension from `chrome://extensions` after these manifest changes, then use this checklist:

- [ ] On a fresh install, no options tab opens by itself. Opening QuickCal on a normal webpage shows the in-widget tour.
- [ ] Examples are local demos only (no AI, Calendar/Tasks writes, recordings, or uploads).
- [ ] Connect Google explains Calendar and Tasks permissions and AI processing; the prompt starts only after that deliberate click.
- [ ] **Start using QuickCal** appears only after connection and `/access` succeed, then enters the normal input.
- [ ] Dismiss (X/Escape) hides the tour without completing it; reopening resumes the same step.
- [ ] Established users (prior welcome flag, prior connect, or draft) are not forced through the tour after update.
- [ ] **Replay welcome tour** from options opens the widget tour without disconnecting or clearing completion.
- [ ] Disconnect does not erase onboarding completion; missing scopes use reconnect, not a full tour reset.

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

The response includes `ok: true`, `apiKeyConfigured`, `quickcalApiVersion`, `quickcalRelease`, and a capability list. `quickcalRelease` is `local` outside Render, or Render's public deployment revision when deployed. These non-secret fields make it possible to confirm that the extension and hosted parser are running compatible revisions. `apiKeyConfigured` is true only when `backend/.env` has a non-empty `OPENAI_API_KEY`. Put the key on that same line, as `OPENAI_API_KEY=...`. A key pasted on the following line by itself is also accepted. Restart the server after changing `.env`. Then send one of the examples below. Each one is a paid model call. Use your own IANA time zone if it is not `America/Los_Angeles`.

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

`GET /health` returns health, parser API version, public deployment revision, and supported capabilities without calling OpenAI. `apiKeyConfigured` is true only when `OPENAI_API_KEY` is set. The response never includes the key, the allowlist, or a Google token. Use one instance. The per-user rate limit is stored in process memory, so it is not shared by more than one instance and it resets whenever the service restarts, redeploys, or spins down.

Render sets `PORT` and `RENDER=true`. With `RENDER=true`, the server binds `0.0.0.0` and that port. Local `npm start` binds `127.0.0.1:3000` when `PORT` is unset, and it stays on `127.0.0.1` if `PORT` is set. `NODE_ENV=production` or `RENDER=true` turns authentication on, and a value of `QUICKCAL_REQUIRE_AUTH=false` does not turn it off. Access policy is controlled by `QUICKCAL_ACCESS_MODE`:

| `QUICKCAL_ACCESS_MODE` | Behavior |
| --- | --- |
| unset | Same as invite-only. Current production default. |
| `invite-only` | Requires `GOOGLE_CLIENT_ID` and `ALLOWED_EMAILS`. Only allowlisted verified Google accounts are approved. |
| `public` | Requires `GOOGLE_CLIENT_ID`. Any valid Google-authenticated user with a verified email and stable account id is approved. `ALLOWED_EMAILS` is not required and is not used for approval. |
| any other nonempty value | Startup fails with a clear error. |

An empty `ALLOWED_EMAILS` list never implies public mode. Public mode does not write emails into environment variables or a database.

If invite-only production is missing `GOOGLE_CLIENT_ID` or `ALLOWED_EMAILS`, or public mode is missing `GOOGLE_CLIENT_ID`, the process exits before it listens.

Set these environment variables in Render. Mark the key and the allowlist as secret. Use placeholders here; do not commit real values. Keep live Render invite-only until you deliberately flip public mode.

| Variable | Value |
| --- | --- |
| `OPENAI_API_KEY` | `YOUR_OPENAI_API_KEY` |
| `OPENAI_MODEL` | `gpt-6-luna` |
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` |
| `GOOGLE_CLIENT_ID` | the `oauth2.client_id` already in `manifest.json` |
| `ALLOWED_EMAILS` | `reference.customer@example.com,second.customer@example.com` |
| `QUICKCAL_ACCESS_MODE` | leave unset or `invite-only` for current production |

Later, to enable self-service onboarding without changing code: set `QUICKCAL_ACCESS_MODE=public` on Render and redeploy/restart. You may clear or leave `ALLOWED_EMAILS`; it is ignored for approval in public mode.

Optional: `QUICKCAL_RATE_LIMIT_MAX` (default `30`) and `QUICKCAL_RATE_LIMIT_WINDOW_MS` (default `900000`, 15 minutes). Parsing, transcription, document reading, and document analysis share that per-account limit. Do not put the OpenAI key, the allowlist, or any shared password in the extension. Audio is kept only in memory for the request. Do not add a `backend/.env` file on Render. The disk is ephemeral, and the server does not use a database. Calendar events and the extension’s retry ids stay in Google Calendar and `chrome.storage.local`.

### Google configuration for the hosted parser

Keep the existing Chrome-extension OAuth client. Do not create a web client, and do not download a client secret. The Render URL is not an OAuth redirect or JavaScript origin. The extension still obtains the access token with `chrome.identity.getAuthToken`, and the server checks that token with Google.

On the OAuth consent screen, keep these scopes and add the conflict-check scopes:

- `https://www.googleapis.com/auth/calendar.events.owned` — create, edit, and delete events on calendars you own
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly` — discover calendars available to the account
- `https://www.googleapis.com/auth/calendar.events.readonly` — read event details on accessible calendars for conflict notices
- `https://www.googleapis.com/auth/calendar.events.freebusy` — read busy/free blocks when event details are not available
- `https://www.googleapis.com/auth/tasks` — create Google Tasks for to-do requests and approved document items
- `https://www.googleapis.com/auth/userinfo.email` — verify the connected Google account for the hosted parser

In the same Google Cloud project, open **APIs & Services → Library** and enable the **Google Tasks API**. The Calendar API is already enabled. Without the Tasks API, task requests fail with a message that says to enable it; calendar events keep working. Google Tasks has no narrower write scope than `tasks`, and QuickCalAI only creates tasks in the default list.

Do not add `https://www.googleapis.com/auth/calendar` or a broader write scope. If the consent screen is in Testing, add each reference customer as a test user. That lets them receive a token. In invite-only mode, `ALLOWED_EMAILS` is a separate server-side list and is what decides who can call the paid parser. In public mode, Google still must issue a valid token for this client, but the allowlist is not checked.

Google Calendar and Tasks scopes used here are sensitive. Publishing status **Testing** limits access to listed test users (with warnings and short-lived grants). Moving the OAuth consent screen to **In production** and completing Google’s verification is a separate process from paying the Chrome Web Store developer registration fee. The Store fee does not make Google OAuth public or verified. See Google’s docs on [app audience / Testing vs Production](https://support.google.com/cloud/answer/15549945), [sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), and [Chrome extension OAuth ownership](https://developers.google.com/identity/protocols/oauth2/native-app).

After these scopes are added to the Chrome OAuth client and consent screen, each tester must choose **Reconnect Google Calendar** once so the token includes them. Existing drafts and the shared conversation stay in place. The options page detects a token without Tasks access and offers **Reconnect** for that case too. Depending on Chrome, an existing connection may instead show **Connect Google Calendar** after the extension updates; connecting again grants every scope at once.

The token Google returns must be for this extension’s client ID and must include a verified email and stable account id (`sub`). The server rejects tokens issued to another client, unverified emails, expired tokens, and—when invite-only—emails that are not on `ALLOWED_EMAILS`. It does not accept an email, extension origin, or shared secret sent by the client.

### Chrome Web Store item ID

The public `key` in `manifest.json` derives extension ID `epnmambadhgonpaplpfgajhdpbkaiikb`, which matches the Chrome Web Store item. Keep that key in the development/test package so unpacked installs use the same ID. Store upload packages omit the `key` field; Chrome assigns the Store item ID from the published package. The Chrome-extension OAuth client and hosted `GOOGLE_CLIENT_ID` must allow this extension ID and match `oauth2.client_id` in the manifest.

Post-save conflict checking runs in the service worker after Google confirms a create, edit, or move. It never blocks or undoes the save. Recurring series are checked for **90 days** from the saved start; the success card shows that bounded range and does not claim the whole series is clear.

### Extension changes for the hosted service

The extension calls `https://quickcal-ai.onrender.com/parse-event`. The service worker attaches the Google access token as `Authorization: Bearer`. The widget never receives that token. `GET /health` checks that Render is awake and does not call the model. `GET /access` checks that this Google account is approved. It uses the same token check as `/parse-event` and does not call the model. `POST /transcribe` accepts one microphone recording, checks the same Google account, applies the same per-user limit, and calls the transcription model. Deploy the backend that provides `/transcribe` before testing voice in Chrome. Until that deploy, voice capture can succeed and transcription will fail.

`POST /extract-document` accepts one PDF, DOCX, or TXT file of up to 2 MB as raw bytes, checks the same Google account and per-user limit, and returns the file's text. It reads the file in a worker thread with a memory cap and a 20-second limit, keeps it only in memory, and never writes it to disk. Scanned PDFs without selectable text are refused with a message; there is no OCR. `POST /analyze-document` takes that text (up to 150,000 characters), the user's request, and up to four earlier requests, and returns proposed events and tasks. It never creates anything. Because analysis can take longer than the 30 seconds Chrome waits for response headers, the route sends its 200 status early and then the JSON result; errors after that point are reported inside the JSON. Neither route logs document contents. API version 5 adds these routes and the `tasks` and `document-analysis` capabilities, so deploy the backend before reloading the extension.

Reference customers do not need a local server, `backend/.env`, or Node.js. After reloading the extension, each person connects Google Calendar again so the token includes the email scope.

## Google Tasks

A to-do request such as `Remind me to submit my report tomorrow`, `Add buy groceries to my tasks`, or `I need to finish chapter 7 by Wednesday` creates a Google Task in the default task list instead of a calendar event. It is saved immediately, like an event, and the card says **Task successfully created** with **View in Google Tasks**. A task keeps its due date when one is given and has no due date otherwise. The Google Tasks API stores only a due date and cannot set a task's time, so a stated time such as `at 6 PM` is added to the task's title, for example **Call Mom (6:00 PM)**, and shown on the card. Google does not send a reminder at that time. QuickCalAI never invents a due date or time, does not create repeating tasks (it asks instead), and does not edit a task after it is created.

## Changing a saved event's time

After an event is created, its time on the success card is a button. Clicking it opens a small menu with **Start** and **End** lists in 5-minute steps, scrolled to the current times. Arrow keys move through the list, Left and Right switch lists, Enter picks, and Escape closes the menu without closing QuickCalAI. Picking a time patches that same Calendar event by id; it does not create another event. Moving the start keeps the event's length. A saved time that is not on the 5-minute grid stays listed as it is and is never rounded. Tasks have no time menu.

## Documents

The paperclip at the left of the bar opens a panel below the bar (or above it when the bar is near the bottom of the screen; the bar itself never moves). Drop a PDF, DOCX, or TXT file of up to 2 MB on it, or choose **Browse Files**. While the panel is open, the main input describes what to find, for example `Only find midterms and final exams` or `Create tasks for assignments rather than calendar events`. Press Enter to analyze, or choose **Analyze Document** to find all relevant dates. A later request such as `Actually, only show midterms` refines the list without another upload and keeps any decisions for items that are still listed.

Each proposed item shows its date and time, details, the quote and page it came from, and notes about anything missing, assumed, or conflicting. Nothing is approved automatically. Choose **Approve**, **Skip**, or **Edit** for each item; an event without a time cannot be approved until it gets a time or is marked all day. **Create N Approved Events** creates only approved items. Each event uses an id fixed when it was proposed, so retrying after a failure never makes a duplicate, and created items are not created again. Collapsing the panel keeps the review; closing QuickCalAI discards it and the stored document text.

This approval step applies only to documents. Ordinary typed or spoken requests are still created immediately.

## Event preview and save

With Calendar connected and QuickCalAI ready, the floating bar sends what you type to the hosted parser. A complete event is created immediately. The card says **Creating event…** and then **Event successfully created** only after Google confirms it. If the date and start time are clear and no end time or duration was given, the event lasts one hour and the card says **1-hour default**. Incomplete text asks a question and creates nothing. After a successful save, the field says **Tell me what to change…**. A follow-up such as `Move it to 11 AM` updates that same calendar event. **New event** inside the card starts a separate event.

Customer use does not need a local server. Reload the extension, connect Calendar from the welcome page, and test on `https://example.com`:

- [ ] Click the toolbar icon. Only the rounded input pill opens. The field is focused, the microphone still says **Voice input coming soon**, and a downward chevron inside the pill can hide it.
- [ ] Type `Coffee with Alex tomorrow from 10 to 10:30 AM` and press Enter. The card says **Creating event…**, then **Event successfully created**, and offers **View in Google Calendar**. Open that link and confirm the event is on your primary calendar.
- [ ] Closing and reopening the bar does not create another copy. Pressing Enter again while it is still saving does not either. If saving fails, **Try again** uses the same attempt.
- [ ] The field now says **Tell me what to change…**. Type `Move it to 11 AM` and press Enter. The same calendar event moves to 11:00 and keeps its previous length. The card updates only after Google confirms the change.
- [ ] Click **New event**. The next complete sentence creates a separate event.
- [ ] Type `Coffee with Alex tomorrow at 10 AM` and press Enter. The created event ends one hour later and the card says **1-hour default**.
- [ ] Type `Coffee with Alex` and press Enter. The card asks for the missing date and time, and nothing is created.
- [ ] Disconnect on the settings page, submit a complete sentence, and choose **Connect Google Calendar**. The settings page opens and the sentence remains in the bar. Disconnect also clears the event that follow-up edits would change.
- [ ] If QuickCal is still waking up, the bar says **Connecting to QuickCal…** and the text stays in the field. Pressing Enter again does not send a second parser request. If it stays unavailable, **Try again** appears and the text is still there.
- [ ] Hide the pill with the chevron, Escape, and the toolbar icon. The same bar toggles, and a second bar never appears.
- [ ] Narrow the window and raise the browser zoom. The pill, its controls, and its shadow stay inside the window.
- [ ] Type `Make a date every Friday with John at 6pm` and press Enter. The card shows **Date with John**, the next Friday, **6:00–7:00 PM**, **Every Friday**, the time zone, and **No end date**. Open **View in Google Calendar** and confirm one weekly series with no guests and no end date.
- [ ] On a Friday before 6 PM, the same sentence starts today. After 6 PM, it starts the next Friday.
- [ ] Type `Coffee with John` and press Enter. The card asks for the date and start time and creates nothing.
- [ ] After the Friday series is saved, type `Move it to 7 PM`. The card asks before changing the series. Type `Change the entire series to 7 PM` to move that same series. **New event**, then a one-time sentence such as `Move it to 11 AM` on a non-repeating event, still changes only that event.

These browser steps use your real parser and your real calendar. The automated checks stub both and do not.

## Invite-only deploy (stay closed)

Do not enable public access until deliberately ready.

1. Deploy the backend to Render with the existing free instance and current OpenAI env vars.
2. Keep `QUICKCAL_ACCESS_MODE` unset or set to `invite-only`.
3. Keep `GOOGLE_CLIENT_ID` matching `manifest.json` `oauth2.client_id`.
4. Keep `ALLOWED_EMAILS` populated with approved tester emails.
5. Reload the unpacked extension (or ship the extension ZIP). Do not change live Google OAuth publishing status unless you intend to.

## Later: enable public mode

1. Confirm OAuth Testing vs Production / verification needs for your audience (Store fee alone is not enough).
2. Confirm privacy-policy and homepage URLs required by Google/Chrome for broader publishing.
3. Confirm the Chrome Web Store item ID (if published) matches the OAuth extension client configuration.
4. On Render only: set `QUICKCAL_ACCESS_MODE=public`, then restart/redeploy.
5. Smoke-test: fresh Google account not in `ALLOWED_EMAILS` can Connect → ready → parse.

## Manual onboarding checklist

### Fresh Chrome profile
- [ ] Install/load unpacked: no options tab opens automatically.
- [ ] Toolbar open on `https://example.com` shows Welcome → Examples → Connect Google.
- [ ] Example clicks do not call AI or write Calendar/Tasks.
- [ ] Connect Google starts Google’s prompt only after that click; cancel stays on Connect without completing.
- [ ] After ready, **Start using QuickCal** enters the normal input; later opens skip the tour.
- [ ] Highlight “Add to QuickCal” during the tour preserves text; after setup it is restored without auto-create.
- [ ] X/Escape dismisses without completing; reopen resumes the same step across tabs.

### Replay welcome tour
- [ ] Options → **Replay welcome tour** opens the widget tour on a supported page.
- [ ] Google stays connected; Connect is not forced again when already ready.
- [ ] Dismissing replay leaves completion intact (next toolbar open is normal input).
- [ ] An active draft/busy conversation blocks replay with a clear message instead of wiping work.

## Checkpoint 1 manual checklist

Test on a normal webpage, such as `https://example.com`. Chrome restricts injection into internal pages, so the bar will not appear on `chrome://` pages, the New Tab page, the Chrome Web Store, or other browser UI.

- [ ] Click the QuickCalAI toolbar icon. The input bar opens near the bottom-right, and the text field is focused.
- [ ] Type and edit text in the field.
- [ ] Press Enter. With Calendar connected and QuickCalAI ready, a complete sentence is created after Google confirms it. Incomplete text asks a question and creates nothing.
- [ ] After a successful save, type a change such as `Move it to 11 AM` and press Enter. That saved event is updated. **New event** returns to creating a separate event.
- [ ] Hide the pill with the chevron inside it, with Escape, and with the toolbar icon. The same bar toggles, and a second bar never appears.
- [ ] Narrow the browser window. The bar stays inside the window.
