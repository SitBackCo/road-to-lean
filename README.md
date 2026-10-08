# Winter Arc

Pavi's levelling fitness tracker. Type what you ate or trained and Claude turns it into numbers. Your habits become
quests, XP, ranks, bosses and secret heroes, and every day of the arc a different character from Pavi's own anime art
stands on Home and in the Body tab, wrapped in a blazing aura of their own colour.

**Version 15 · data version 9.** The arc runs **Thu 8 Oct 2026 to Thu 31 Dec 2026** (85 days), from **90.5kg** to a
goal of **79kg**.

**The whole app is one file: `index.html`.** The rest of this folder is its source and its tests.

| File | What it is |
|---|---|
| `index.html` | The app. Built from `src/` by `node build.mjs`. **Upload this.** |
| `sw.js` | Lets the app open with no signal. **Upload this too**, every time `index.html` changes. |
| `manifest.json`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `zxing.min.js` | Home Screen icon, install details and the barcode reader. Upload once; they have not changed in v15. |
| `worker/worker.js` | The System: a Cloudflare Worker for Claude food logging, InBody photo reading, the food database, Apple Health inbox and the cloud copy. **Not changed in v15.** |
| `hosted/winter-arc.html` | The same app built to live inside Claude (no GitHub, no Cloudflare). |
| `src/` | Source: `core.js` (every rule), `app.js` (screens), `aura.js` (today's character and their aura), `hosted.js`, `styles.css`, `tests.js`, `index.src.html`. |
| `art400/` | The 273 pictures built into the page (83 bosses, 83 weapons, 11 heroes, 11 powers, and in `art400/a/` the 85 daily characters, numbered as in Pavi's list). `art400/unused/` holds the 14 that belonged to the seven bosses removed in v14. |
| `test/` | The tests (see the end of this page). |

No key, passcode or Worker address is written anywhere in this folder or in the page. They live only in your
Cloudflare account and in the storage of the device you type them into.

---

## The plan, as the app applies it

| | |
|---|---|
| Dates | Thu 8 Oct to Thu 31 Dec 2026, 85 days, shown as weeks 1 to 12 |
| Weight | 90.5kg start, 79kg goal. Checkpoints: 87.4kg on 1 Nov, 83.4kg on 1 Dec, 79.5kg on 31 Dec |
| Calories | 1,600 Monday to Saturday, 1,900 Sunday. Never below 1,450: there is no setting that lowers it |
| Steps | 10,000 on gym and football days, 15,000 on rest days. A logged shortfall is carried to the next day, never past 17,000 |
| Week | Mon Push, Tue Legs, Wed rest, Thu rest, Fri football, Sat Pull, Sun rest |
| Deloads | 26 Oct to 1 Nov and 7 to 13 Dec, at 60% of your usual weight |
| Reviews | Every 14 days: 22 Oct, 5 Nov, 19 Nov, 3 Dec, 17 Dec. 0.6 to 0.9kg a week: change nothing. Over 1.1kg: +150 kcal. 0.3 to 0.5kg: −100 kcal or +1,500 steps. Under 0.3kg: −150 kcal and +1,500 steps |
| Daily bosses | 83, one a day from 8 Oct. Each can be beaten on the day it arrives or the day after. The last arrives on 29 Dec and can still be beaten on 30 Dec. 31 Dec has no boss |
| Today's character | 85 characters, one a day from 8 Oct to 31 Dec, each exactly once, in an order drawn at random for your save (see below) |
| Secret heroes | 11 weeks, Thursday to Wednesday, 8 Oct to 23 Dec. One weigh-in in the week at least 0.85kg under the last weigh-in before that week began frees the next hero (week 1 is measured from 90.5kg) |

Nothing logged before 8 Oct or after 31 Dec earns XP, streaks, awards, bosses or heroes. It is still saved.

---

## 1. Put the app on GitHub Pages

1. github.com → your **road-to-lean** repository (or **New repository**, Public, if you are starting again).
2. **Add file → Upload files**. Drag in `index.html` and `sw.js` (first time: also `manifest.json`, the three icons and
   `zxing.min.js`). **Commit changes**.
3. First time only: **Settings → Pages → Deploy from a branch → main / (root) → Save**.
4. A minute or two later it is live at `https://<your-github-name>.github.io/road-to-lean/`.

## 2. The Cloudflare Worker (the System)

If your Worker already runs the current `worker.js` you do not need to touch it for v15. To check: open the app →
⚙️ → **Test connection**. If no line mentions "an older version", it is current.

Setting it up from nothing:

1. dash.cloudflare.com → **Workers & Pages → Create → Create Worker** → give it a name → **Deploy**.
2. **Edit code** → delete everything → paste all of `worker/worker.js` → **Deploy**.
3. Worker **Settings → Variables and Secrets**:

   | Name | Type | Value |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | Secret | your key from console.anthropic.com |
   | `APP_KEY` | Secret | a long passcode you make up (20+ characters), used for nothing else |
   | `ALLOWED_ORIGINS` | Text | `https://<your-github-name>.github.io` |

   Optional: `MODEL` (default `claude-haiku-4-5-20251001`), `WEB_MODEL`, and the daily ceilings `LIMIT_PARSE` (120),
   `LIMIT_SCAN` (12), `LIMIT_LABEL` (30), `LIMIT_WEB` (8).
4. **Storage for the cloud copy and Apple Health:** Workers & Pages → **KV** → **Create namespace** (any name). Then
   the Worker's **Settings → Bindings → Add → KV namespace** → variable name **`SYNC`** → pick the namespace → Deploy.
5. Open `https://<your-worker-address>/health`. You should see `"ai":true,"auth":true,"kv":true,"version":4`.

Set a monthly spend limit at console.anthropic.com. Each food log is one short Claude Haiku call.

## 3. On your iPhone

1. Open the app's address in **Safari** → Share → **Add to Home Screen**. Open it from that icon from then on.
2. ⚙️ → paste the **System URL** (your Worker address) and **App key** → **Save** → **Test connection**. Every line
   should be blue with no ⚠.
3. ⚙️ → **Diagnostics**: every line should say PASS (two of them check today's character and all 85 pictures).

**Updating an iPhone that already has the app:** open it with signal, wait ten seconds, close it fully (swipe it
away), open it again. ⚙️ should now end with "Winter Arc v15 · data v9". Your logs are never removed by an update, and
nothing about your save changes in v15.

## 4. On a laptop

Open the same address in Chrome, Edge or Safari. ⚙️ → enter the same System URL and App key → Save. The laptop loads
your cloud copy by itself. Everything works with a mouse and keyboard: Enter confirms, Escape closes a sheet. In
Chrome or Edge the address bar offers **Install** if you want it as its own window.

## 5. Or: inside Claude, with nothing to set up

`hosted/winter-arc.html` is published as a Claude artifact. Opened inside Claude it keeps your data in your Claude
account and uses Claude on your own plan for food logging and photo reading. No GitHub, Cloudflare or key. It cannot
reach the food database, scan barcodes, look figures up online or receive Apple Health data; everything else is the
same app. The two versions keep **separate** data, so pick one for the arc.

---

## Today's character

Pavi's 85 characters (his own art, from `AA.xlsx` and `AA_Pic.pdf`) each have the aura colour listed next to their
name. Every day of the arc one of them stands in the player card on Home and, larger, at the top of the Body tab, with
an aura pouring off them like the Super Saiyan picture: flames streaming upward, white-hot next to the body, a burst of
light behind, speed lines, dark shards, lightning at the edges and rising sparks. Very dark colours (navy, black, blood
red) keep their own dark flame with a bright edge of the same colour so they still show. Tap the character in the Body
tab for a surge of power.

- **One a day, each once.** The order is drawn at random for your save, so it is a surprise, but it is the same on your
  phone, your laptop and inside Claude, all day, after a reload or a backup. Nothing new is stored or synced for it.
- **Before 8 Oct** day 1's character is shown; **after 31 Dec** the order goes round again.
- **Battery:** it only draws while it is on screen and the app is open. With reduced motion on (⚙️ → Feel, or the
  iPhone's own setting) it holds one still frame. A phone or browser without WebGL shows the picture with a glowing CSS
  aura instead.
- The Body tab keeps all your numbers (weight, body fat, lean mass, V-taper, lost, goal date) and the muscles you
  trained this week; tap a muscle for its exercises. The 3D hologram, its body-shape sliders and the 3D engine are gone.

## InBody and Apple Health

Your 7 Sept 2026 scan is built in. Add one a week (orb → InBody scan): from screenshots, typed in, or automatically
from Apple Health with an iPhone Shortcut (⚙️ → **Set up iPhone auto-sync** shows the exact steps and your inbox
address). A scan dated inside the arc earns XP, one a week.

## Your data

- Saved on the device at once, and (when connected) in your cloud copy a second or two later.
- ⚙️ → **Export backup** saves everything as a file. **Import backup** brings one back.
- ⚙️ → **Restore an earlier version** lists the last 3 copies replaced on this device and the versions the cloud keeps
  (the last copy of each day for 30 days, the 5 most recent, and any copy deliberately replaced).
- If two devices have changed apart, the app asks which to keep. The other copy is kept, not thrown away.
- A save from the earlier 1 Oct or 7 Oct start is moved to the 8 Oct start the first time v14 or later opens it: every logged
  day is kept, and XP, bosses, heroes and awards begin again from day one.

## Changing the app

Edit files in `src/`, run `node build.mjs`, then run the tests. If saved data changes shape, raise `STATE_VERSION` in
`src/core.js` and add a step to `migrate`. When `index.html` changes, raise `VERSION` in `sw.js` so devices fetch it.

## Tests

| Command | What it checks |
|---|---|
| `node test/run-core.js` | 116 logic checks (the same ones run in the app under ⚙️ → Diagnostics) |
| `node test/run-worker.mjs` | 24 checks of the Worker and the offline worker, with stand-ins for storage and Claude |
| `node test/e2e.mjs` | 105 browser tests of the built `index.html` in Chromium at iPhone, iPad and laptop sizes, talking to the real Worker code, including the whole 85-day arc played day by day for three people and every one of the 85 auras checked for its colour |
| `node test/hosted.mjs` | 14 browser tests of the Claude-hosted build |
| `./test/webkit/run.sh` | The built app opened in WebKit (the engine Safari is built on) at phone and laptop sizes: 64 views checked for errors, anything wider than the screen, and today's character showing. Needs `gir1.2-webkit2-4.1`, `python3-gi` and `xvfb` |
| `node test/shots.mjs` | Screenshots of every tab at eight sizes, for looking at |
| `./test/all.sh` | All of the above, one after another |

The browser tests need Playwright with Chromium. They use ports 8123 and 8124: never run two at once. The full browser run takes about 80 minutes, most of it the three day-by-day seasons.
