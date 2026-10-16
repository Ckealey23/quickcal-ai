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

## Checkpoint 1 manual checklist

Test on a normal webpage, such as `https://example.com`. Chrome restricts injection into internal pages, so the bar will not appear on `chrome://` pages, the New Tab page, the Chrome Web Store, or other browser UI.

- [ ] Click the QuickCalAI toolbar icon. The input bar opens near the bottom-right, and the text field is focused.
- [ ] Type and edit text in the field.
- [ ] Press Enter. The page stays put, and no event-created message appears.
- [ ] Close the bar with Escape, then reopen it from the toolbar icon. The field is focused again.
- [ ] Close it with the close button, then click the toolbar icon several times. The same bar toggles open and closed, and a second bar never appears.
- [ ] Narrow the browser window. The bar stays inside the window.
