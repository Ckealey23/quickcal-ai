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

After Calendar is connected, the settings page shows one predefined event: **QuickCalAI — Test Event**, tomorrow from 10:00–10:30 AM in this computer’s time zone. The page shows that calendar date, time, and time zone before anything is created. **Create test event** sends that event to the primary calendar. The floating input bar does not create events.

Reload the extension, connect Calendar, and use this checklist:

- [ ] While disconnected, **Create test event** stays disabled. The section still shows the title, tomorrow’s calendar date, 10:00–10:30 AM, and the time zone.
- [ ] Connect Google Calendar. Review that date, time, and time zone, then click **Create test event** once. The button stays disabled and the page says it is creating the event.
- [ ] When Google has saved it, the page says **Test event saved**, shows the same title and time, and offers **View in Google Calendar**. **Create test event** stays disabled.
- [ ] Open **View in Google Calendar** and confirm the event is tomorrow, 10:00–10:30 AM, on your primary calendar, with no guests.
- [ ] Close and reopen the settings page. It still shows the saved event and does not create another one.
- [ ] Click **Disconnect**. The saved confirmation disappears. Connect again and confirm the previous success is not shown.
- [ ] On a normal webpage, the toolbar icon still only toggles the input bar. Enter still does not create an event.

To delete the test event, open **View in Google Calendar**, or open [Google Calendar](https://calendar.google.com/) and go to the date shown on the settings page. Open **QuickCalAI — Test Event** and choose **Delete**. QuickCalAI does not delete it for you. A later connection can create the test event again, so delete any copies you no longer want.

## Local event extraction

`backend/` is a separate local service. It turns event text into validated fields. It does not change the Chrome extension, and it does not write to Google Calendar. The server listens only on `127.0.0.1:3000`.

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
- The last example has no date or time. Expect those fields to be null, `needsClarification` true, and questions asking for the missing date and times. A missing location by itself is not a reason to ask.

The wording of the questions can vary. The server still checks that dates exist, times are `HH:mm`, and the end is later than the start on the same day. Stop the server with Ctrl+C in the window where `npm start` is running.

## Checkpoint 1 manual checklist

Test on a normal webpage, such as `https://example.com`. Chrome restricts injection into internal pages, so the bar will not appear on `chrome://` pages, the New Tab page, the Chrome Web Store, or other browser UI.

- [ ] Click the QuickCalAI toolbar icon. The input bar opens near the bottom-right, and the text field is focused.
- [ ] Type and edit text in the field.
- [ ] Press Enter. The page stays put, and no event-created message appears.
- [ ] Close the bar with Escape, then reopen it from the toolbar icon. The field is focused again.
- [ ] Close it with the close button, then click the toolbar icon several times. The same bar toggles open and closed, and a second bar never appears.
- [ ] Narrow the browser window. The bar stays inside the window.
