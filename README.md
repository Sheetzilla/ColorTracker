# ColorTracker

A calendar-style progress tracker. Make colour-coded activities, drag them onto days, and longer sessions show up as deeper shades. Data syncs between your computer and phone through Firebase. Sign in with email + password or Google, or try it without an account (data then stays in that browser only).

## Files

| File | What it is |
|---|---|
| `index.html` | Page layout |
| `style.css` | Look, phone-first layout, animations |
| `app.js` | Calendar, drag & drop, undo/redo, saving |
| `firebase-config.js` | Which Firebase project to use (not secret) |
| `manifest.webmanifest` | Tells phones this is an installable app (name, icon, colours) |
| `sw.js` | Offline helper: lets the app open without internet |
| `icons/` | App icons (keep the folder name) |
| `firestore.rules` | Database rules: only you can read/write your data (paste into Firebase, not needed on GitHub) |

## One-time setup

### 1. Publish the database rules
1. Firebase console → **Databases and storage → Firestore → Rules** tab.
2. Replace everything there with the contents of `firestore.rules`.
3. Click **Publish**.

Without this step the app can sign you in but can't load or save anything.

### 2. Turn on the sign-in methods
1. Firebase console → **Authentication → Sign-in method**.
2. Make sure **Google** is enabled, then **Add new provider** → **Email/Password** → enable the first switch (leave "Email link" off) → **Save**.
3. **Add new provider** → **Anonymous** → enable → **Save**.

Without this, the email and "Try without an account" buttons show "This sign-in method isn't turned on in Firebase yet."

### 3. Put the site on GitHub Pages
1. On GitHub, create a new **public** repository, e.g. `colortracker`.
2. **Add file → Upload files** and drag in `index.html`, `style.css`, `app.js`, `firebase-config.js`, `manifest.webmanifest`, `sw.js` and the whole **`icons` folder** (the README and rules file can go in too).
3. **Commit changes**.
4. Repository **Settings → Pages**: under *Build and deployment*, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
5. After a minute the site is live at `https://sheetzilla.github.io/colortracker/`.

`sheetzilla.github.io` must be listed under Firebase **Authentication → Settings → Authorized domains** (already done).

### 4. Install it as an app
- **Android (Chrome):** open the address, then **☰ menu → Install app** (or Chrome's ⋮ menu → *Install app*).
- **iPhone (Safari):** open the address, tap **Share → Add to Home Screen**.
- **Computer (Chrome/Edge):** click the install icon at the right end of the address bar.

Sign in with the same account (email or Google) everywhere. Guests can tap the **×** button in the top right → **Save my data** to create an account later and keep their data. The app opens full-screen from its own icon, works offline (changes sync when you're back online) and updates itself when you upload new files to GitHub. After an update, close and reopen the app once to get the new version.

## How to use

| Action | How |
|---|---|
| New activity | Tap the **＋** dot, or **☰ → New activity** |
| See an activity's info | Tap its dot (name, default length, total, Edit) |
| Edit / delete an activity | Tap its dot → **Edit**, or tap it in the ☰ menu |
| Log a session | Drag a dot onto a day (phone: hold briefly, then drag) |
| Move a session | Drag its square to another day |
| Delete a session | Hold the square and **flick it away**, or tap it → **Delete** |
| Change a session's length | Tap the square → − / + or type minutes |
| Undo / redo (last 5 steps) | **Two-finger tap / three-finger tap** · Ctrl+Z / Ctrl+Y on a computer |
| Scroll through many dots | ‹ › arrows beside the dots, or swipe |
| Month / week | Toggle at the top. Week numbers are calendar weeks. |
| Shuffle the animal's dots | Tap the animal (tap again = back in order) |

Undo history is kept per device and resets when the page reloads.

## Testing on your computer (optional)
The page has to be served from a web address, not opened as a file. In this folder run:

```
python -m http.server 8000
```

then open `http://localhost:8000`. (`localhost` is allowed in Firebase by default.)
