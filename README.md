# Ascend

Pavi's levelling fitness tracker (it used to be called Winter Arc; the 85-day season inside it is still the Winter Arc).
Search what you ate in the built-in UK menus and foods or the online databases, or type quick commands like
“drank 750ml”, “weighed 88.6” or “lat pulldown 60kg 3x10”. Food logging no longer uses Claude. Your habits become
quests, XP, ranks, bosses and secret heroes, and every day of the arc a different character from Pavi's own anime art
stands on Home and in the Body tab, wrapped in a blazing aura of their own colour.

**Version VF (Ascend, the final version) · data version 10.** The arc runs **Thu 8 Oct 2026 to Thu 31 Dec 2026** (85 days), from **90.5kg** to a
goal of **79kg**.

**The app is `index.html` plus its pictures in `art/`.** The rest of this folder is its source and its tests.

| File | What it is |
|---|---|
| `index.html` | The app (about 700 KB). Built from `src/` by `node build.mjs`. **Upload this.** |
| `art/` | The 274 pictures (with Pavi's LUCK piece), written by the build: the AI-upscaled, twice-as-sharp versions from `art_hd/` where they exist, otherwise `art400/`. Since v17 they are separate files: the page opens about twice as fast and uses far less memory, and the phone keeps every picture after the first open. `art/t/` holds a grid-sized copy of each boss, weapon, hero and power (from `art_thumb/`), so the Bosses and Armoury tabs open without decoding 160 full-size pictures. **Upload this folder** whenever the build changes it. |
| `foods.json` | About 7,200 generic foods per 100g (USDA FoodData Central, via the tempo-food-db package) plus about 620 foods copied from MyFitnessPal's database (`data/mfp/`: Sri Lankan and South Indian dishes, UK supermarket products, takeaways, protein products), written by the build. The app fetches it once and keeps it offline. **Upload this too.** |
| `data/chains/` | The UK chains' own published figures, one file per chain with its source and date (Greggs, KFC, Five Guys, Domino's). The build puts them inside `index.html`. To add a chain, add a file in the same format and rebuild. |
| `sw.js` | Lets the app open with no signal, and keeps every picture and the food list on the phone. **Upload this too**, every time `index.html` changes. |
| `manifest.json`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `zxing.min.js` | Home Screen icon (V19: the orange Rank-up chevrons, drawn from `src/brand/icon.svg` by `node tools/icons.mjs`), install details and the barcode reader. **Upload the three icons again in V19.** |
| `worker/worker.js` | The System: a Cloudflare Worker for food search (FatSecret, CoFID, Open Food Facts), InBody photo reading, the Apple Health inbox, the cloud copy and (V19) the iPhone reminders. **Changed in V19:** paste it into Cloudflare, add the FatSecret secrets and a Cron Trigger (below). |
| `hosted/winter-arc.html` | The same app built to live inside Claude (no GitHub, no Cloudflare). |
| `src/` | Source: `core.js` (every rule), `app.js` (screens), `intro.js` (the opening: Sae Itoshi's and Natsu's cards), `aura.js` (today's character and their aura), `hosted.js`, `styles.css`, `tests.js`, `index.src.html`, `brand/icon.svg`. |
| `art400/` | The source of the 273 pictures (83 bosses, 83 weapons, 11 heroes, 11 powers, and in `art400/a/` the 85 daily characters, numbered as in Pavi's list). `art400/unused/` holds the 14 that belonged to the seven bosses removed in v14. |
| `test/` | The tests (see the end of this page). |

No key, passcode or Worker address is written anywhere in this folder or in the page. They live only in your
Cloudflare account and in the storage of the device you type them into.

### New in VF (the final version)

- **The full opening every time** (it no longer shortens after a few opens), and the character's aura waits for it to
  finish, so it starts at full sharpness.
- **Sharper characters:** the 85 daily characters are AI-upscaled to three times their original size (`art_uhd/`), drawn
  at the iPhone's full 3× resolution on Home, and the aura no longer stays soft after a busy moment: it climbs back to
  full sharpness as soon as the phone keeps up. A touch more brightness and colour on the characters.
- **More vibrant:** every dark theme's cards carry their own colour with a lit edge and a soft glow; buttons, tiles and
  quest icons are richer; Inferno is warmer ember instead of brown. Text colours are unchanged and still pass the
  4.5:1 readability check.
- **Bedtime 10–11pm:** the Lights out quest reads "In bed 10–11pm" (an old 9:45pm setting moves to it).
- **FatSecret check:** ⚙️ → Test connection now says whether FatSecret really answers and, if not, shows the Worker's
  internet address to approve in FatSecret → IP Restrictions. Needs the new `worker.js` (version 7).
- **Smoother opening and tabs (same quality):** the light rays, nebula, flashes and shock rings are drawn once and then
  only faded, turned or scaled, so the phone never repaints the whole screen mid-scene; sparks are stamped from
  ready-made glows; both cards are decoded before they turn over; each scene is timed to the screen's own frames; and
  syncing, picture caching and the food list wait until the opening is over. Switching tabs builds the new page first
  and brings the aura in one frame later, with a slightly quicker slide.

### New in V19

- **The opening:** two 3D playing cards. Sae Itoshi (the ten, pink aura) flips in and bursts pink, is thrown aside in a
  flash, then Natsu (the ace, fire) flips in, ignites and explodes into the Rank-up icon and ASCEND. The full version on
  the first three opens on a device, a short one (both cards together) after that. Tap anywhere to skip.
- **About 20% brighter** dark themes, and the new orange Rank-up icon on the Home Screen and in the header.
- **Quick add** (just the calories, and protein/carbs/fat if you know them), **My recipes** (add a whole pot once, say
  how many portions, log a plate in one tap) and **＋ Add on every meal** of the Log tab, like MyFitnessPal.
- **iPhone reminders:** water every 2 hours from 9am to 9pm when you're behind on 3L, protein checks at 4pm and 8pm, and
  a nudge at 1pm if nothing is logged. ⚙️ → Reminders.
- **More food:** about 620 MyFitnessPal foods (Sri Lankan and South Indian dishes, UK supermarket and takeaway items,
  protein products) and Domino's official per-slice figures.

### iPhone reminders (V19)

They come from your Worker, so it needs three things: the **new worker.js**, the **`SYNC` KV binding** you already use for
the cloud copy, and a **Cron Trigger**: Worker → **Settings → Triggers → Cron Triggers → Add** → *Every 30 minutes*
(`*/30 * * * *`) → **Add**. The Worker makes its own signing keys the first time, so there are no new secrets.
On the iPhone (iOS 16.4 or later) open Ascend **from its Home Screen icon** → ⚙️ → Reminders → **Turn on
notifications** → Allow → **Send a test**. The Worker reads your cloud copy every 30 minutes and sends a reminder only
when you're behind, at most once per slot.

### Food data (V18)

Search looks in this order, all at once: **your own foods** → **UK menus & foods built into the app** (the chains' own
published figures, then generic foods per 100g; instant and offline) → **online databases through the System**: the
UK government's CoFID database (when a `COFID_KEY` is set), **FatSecret** (2.3 million foods incl. UK restaurants) and
**Open Food Facts** (packaged products and barcodes). Nothing is sent to Claude. Claude is used only to read InBody
screenshots.

**Cloudflare secrets for food search** (Worker → Settings → Variables and Secrets → Add → type *Secret*):

| Name | Value |
|---|---|
| `FATSECRET_ID` | your FatSecret Platform API Client ID |
| `FATSECRET_SECRET` | your FatSecret Platform API Client Secret |
| `COFID_KEY` | optional: a CoFID API key from the Quadram Institute (email fn-nbri@quadram.ac.uk) |

FatSecret only answers from internet addresses approved in your FatSecret account (*IP Restrictions*). If it refuses,
the app shows the exact address under “Online databases” in the food search: add it there. On the free Basic plan the
UK-only results are not available, so FatSecret searches its whole database.

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
| Secret heroes | One for every whole kg down on the scale: the first weigh-in at 89.5kg or less frees the first, 79.5kg the eleventh. It counts the moment you weigh in, a freed hero stays freed, and correcting a mistyped weigh-in re-works them. Heroes won under the old weekly rule (before v16) are kept |
| Penalty Quests | Gone from v16. A missed Daily Clear just ends the streak. Penalty Quests already done keep their XP |
| Look | ⚙️ → Look: your own profile picture (from Photos, cropped to a circle), 13 themes (nine dark including Blue Lock, four light: Daylight, Blossom, Matcha, Lilac), Glass cards (extra see-through), and Puzzle pieces (glowing Blue Lock pieces drifting up; this was the snowfall switch) |
| Effects (v18) | The v16 look (frosted cards, glows, cards sliding in, the aura drawn round the character) with: glowing puzzle pieces bursting from every tap and streaming out of every finished quest; a gold puzzle piece with your level on it for a level-up; Pavi's own gold LUCK piece for a Daily Clear. Everything animated is drawn as fast as the screen refreshes, the aura at up to twice screen sharpness. The pictures are AI-upscaled to twice their resolution |
| Aura tab | Today's character large, and a collection of every character met so far (none still to come). Awards are now in Stats |

Nothing logged before 8 Oct or after 31 Dec earns XP, streaks, awards, bosses or heroes. It is still saved.

---

## 1. Put the app on GitHub Pages

1. github.com → your **road-to-lean** repository (or **New repository**, Public, if you are starting again).
2. **Add file → Upload files**. Drag in `index.html`, `sw.js`, `foods.json` and the `art` folder (first time, and in V19:
   also `manifest.json`, the three icons and `zxing.min.js`). **Commit changes**.
3. First time only: **Settings → Pages → Deploy from a branch → main / (root) → Save**.
4. A minute or two later it is live at `https://<your-github-name>.github.io/road-to-lean/`.

## 2. The Cloudflare Worker (the System)

VF changes `worker.js` (the FatSecret check): paste the new one into Cloudflare (Edit code → select all → paste → Deploy), add the FatSecret secrets above if you haven't, and add the Cron Trigger for reminders. To check: open the app →
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
5. Open `https://<your-worker-address>/health`. You should see `"auth":true,"kv":true,"push":true,"version":7`.

Set a monthly spend limit at console.anthropic.com. Each food log is one short Claude Haiku call.

## 3. On your iPhone

1. Open the app's address in **Safari** → Share → **Add to Home Screen**. Open it from that icon from then on.
2. ⚙️ → paste the **System URL** (your Worker address) and **App key** → **Save** → **Test connection**. Every line
   should be blue with no ⚠.
3. ⚙️ → **Diagnostics**: every line should say PASS (two of them check today's character and all 85 pictures).

**Updating an iPhone that already has the app:** open it with signal, wait ten seconds, close it fully (swipe it
away), open it again. ⚙️ should now end with "Ascend VF · data v10". For the new icon and name, delete the old Home Screen icon and add it again from Safari. Your logs are never removed by an update. v16 only adds to your save: a place for
your profile picture, your theme, and the date Penalty Quests stopped.

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
| `node test/e2e.mjs` | 118 browser tests (speed budgets included) of the built `index.html` in Chromium at iPhone, iPad and laptop sizes, talking to the real Worker code, including the whole 85-day arc played day by day for three people and every one of the 85 auras checked for its colour |
| `node test/hosted.mjs` | 14 browser tests of the Claude-hosted build |
| `./test/webkit/run.sh` | The built app opened in WebKit (the engine Safari is built on) at phone and laptop sizes: 64 views checked for errors, anything wider than the screen, and today's character showing. Needs `gir1.2-webkit2-4.1`, `python3-gi` and `xvfb` |
| `node test/shots.mjs` | Screenshots of every tab at eight sizes, for looking at |
| `./test/all.sh` | All of the above, one after another |

The browser tests need Playwright with Chromium. They use ports 8123 and 8124: never run two at once. The full browser run takes about 80 minutes, most of it the three day-by-day seasons.
