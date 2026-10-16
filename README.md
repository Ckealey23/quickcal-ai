# quickcal-ai

QuickCalAI — AI-powered Google Calendar Chrome extension for IME4403

Development setup complete. Building QuickCalAI in small, verified increments.

## Install in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder, the one that contains `manifest.json`.

After later code changes, click the reload icon on the QuickCalAI card.

## Checkpoint 1 manual checklist

Test on a normal webpage, such as `https://example.com`. Chrome restricts injection into internal pages, so the bar will not appear on `chrome://` pages, the New Tab page, the Chrome Web Store, or other browser UI.

- [ ] Click the QuickCalAI toolbar icon. The input bar opens near the bottom-right, and the text field is focused.
- [ ] Type and edit text in the field.
- [ ] Press Enter. The page stays put, and no event-created message appears.
- [ ] Close the bar with Escape, then reopen it from the toolbar icon. The field is focused again.
- [ ] Close it with the close button, then click the toolbar icon several times. The same bar toggles open and closed, and a second bar never appears.
- [ ] Narrow the browser window. The bar stays inside the window.
