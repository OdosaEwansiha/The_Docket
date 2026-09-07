# The Docket — standalone app

## What changed from the Claude version
- No AI-parsing chatbox. The Log tab is now a short form (what happened, adjourned date, next action, due date) — same result, typed instead of parsed from free text.
- Data is saved in your phone's browser storage (survives closing the browser, tied to this device and this browser only — clearing browser data will erase it).
- Any date (a case's next court date, or a task's due date) has a ⬇︎ button that downloads a `.ics` file — tap it and Android will offer to add it straight into your real Calendar app, which is the reliable way to get an actual reminder/notification.
- No background push notifications — nothing can alert you while the app itself isn't open, since that needs a server. Use the `.ics` calendar export for anything you need to be reminded of.

## Get "Add to Home Screen" working properly
Opening `index.html` directly as a file will give you a basic shortcut, but the install prompt, offline support, and icon only work fully once the app is served over HTTPS. Easiest free option:

**GitHub Pages**
1. Create a new GitHub repository and upload these 5 files (`index.html`, `app.js`, `manifest.json`, `service-worker.js`, `icon-192.png`, `icon-512.png`) to the root.
2. Repo Settings → Pages → set source to the `main` branch, root folder.
3. Open the given `https://<you>.github.io/<repo>/` URL on your Android phone in Chrome.
4. Chrome menu (⋮) → **Add to Home screen** / **Install app**.

Netlify or Vercel work the same way if you'd rather drag-and-drop the folder instead of using git.

## Files
- `index.html` — the app shell
- `app.js` — all the logic
- `manifest.json` — tells Android this is installable, sets the icon/name
- `service-worker.js` — caches the app so it opens offline once visited
- `icon-192.png` / `icon-512.png` — home screen icons
