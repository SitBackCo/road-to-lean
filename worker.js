/* ═══════════════════════════════════════════════════════════════════════════
   ASCEND — Cloudflare Worker
   • GET  /sync    → returns your cloud copy (needs the SYNC KV binding); /sync?meta=1 returns only its details
   • PUT  /sync    → saves your cloud copy (refuses to overwrite a newer one; keeps earlier versions)
   • GET  /sync/versions, /sync/version?key=… → the earlier versions you can restore
   • POST /scan    → Claude reads InBody screenshots, returns the numbers as JSON (the only paid route)
   • POST /inbox   → your iPhone Shortcut drops Apple Health body data here (needs SYNC)
   • GET  /inbox   → the app collects it; POST /inbox/ack removes confirmed items
   • GET  /food/search?q=  → food search across FatSecret (UK), the UK government database (CoFID) and Open Food Facts
   • GET  /food/barcode/:code → product by barcode (Open Food Facts)
   • GET  /food/check → is FatSecret answering, and this Worker's internet address (for FatSecret's IP Restrictions)
   • GET  /push/key, POST /push/subscribe|unsubscribe|test → iPhone reminders (needs SYNC); a Cron Trigger every 30
     minutes sends water and protein reminders when you're behind
   • GET  /health  → shows what's configured
   Food logging no longer uses Claude: /parse, /food/label and /food/web answer 410 (gone).
   Secrets (Settings → Variables and Secrets) — never written in this file:
     APP_KEY            a long passcode you choose      (secret) — typed once into the app
     FATSECRET_ID       FatSecret Platform API Client ID      (secret)
     FATSECRET_SECRET   FatSecret Platform API Client Secret  (secret)
     COFID_KEY          optional: a CoFID API key from the Quadram Institute (secret)
     ANTHROPIC_API_KEY  only for reading InBody screenshots   (secret)
   Optional variables:
     ALLOWED_ORIGINS    default https://sitbackco.github.io
     MODEL              default claude-haiku-4-5-20251001
     LIMIT_SCAN         daily ceiling for InBody reads (default 12)
   Optional binding:
     SYNC               a KV namespace for cloud backup
   ═══════════════════════════════════════════════════════════════════════════ */

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_ORIGINS = 'https://sitbackco.github.io';
const MAX_SYNC_BYTES = 5 * 1024 * 1024;

export const SCAN_PROMPT = `You read screenshots from the InBody app (body composition scans) and return the numbers as JSON. Reply with ONE JSON object and nothing else.

{"found":true,"date":"YYYY-MM-DD or null","weight_kg":null,"skeletal_muscle_mass_kg":null,"body_fat_mass_kg":null,"percent_body_fat":null,"lean_body_mass_kg":null,"inbody_score":null,"inbody_age":null,"visceral_fat_level":null,"bmr_kcal":null,"waist_hip_ratio":null,
 "segmental_lean_kg":{"trunk":null,"left_arm":null,"right_arm":null,"left_leg":null,"right_leg":null},
 "segmental_lean_pct":{"trunk":null,"left_arm":null,"right_arm":null,"left_leg":null,"right_leg":null}}

Rules:
- Copy numbers exactly as shown. Use null for anything not visible. Never guess or calculate a value that isn't on screen.
- Ignore the small change badges (like +3.1 or +0.9). Those are changes since the last scan, not values.
- The InBody date format "26.09.07(Mon)" means 2026-09-07 (YY.MM.DD).
- "Skeletal Muscle Mass" is skeletal_muscle_mass_kg. "Body Fat Mass" is body_fat_mass_kg. "PBF" or "Percent Body Fat" is percent_body_fat.
- Segmental Analysis, Soft Lean Mass tab: the kg values go in segmental_lean_kg and the percentages (e.g. 115.2%) in segmental_lean_pct. Do not use the Fat tab values for these.
- If the images are not InBody results, reply {"found":false,"message":"short reason"}.`;

const OFF_UA = 'Ascend/1.0 (personal fitness tracker)';
const OFF_FIELDS = 'code,product_name,product_name_en,generic_name,brands,nutriments,serving_size,serving_quantity,countries_tags,quantity';
function offNum(v) { const x = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(x) ? x : null; }
/* Open Food Facts product → compact food (per 100g + serving). Returns null if there are no usable calories. */
export function offCompact(p) {
  if (!p || typeof p !== 'object') return null;
  const n = p.nutriments || {};
  let kcal = offNum(n['energy-kcal_100g']);
  if (kcal == null) { const kj = offNum(n['energy-kj_100g']) ?? offNum(n['energy_100g']); if (kj != null) kcal = kj / 4.184; }
  if (kcal == null || kcal < 0 || kcal > 950) return null;
  const name = String(p.product_name_en || p.product_name || p.generic_name || '').trim();
  if (!name) return null;
  const v = k => { const x = offNum(n[k]); return x == null ? 0 : Math.round(x * 10) / 10; };
  const sq = offNum(p.serving_quantity);
  return {
    code: String(p.code || '').replace(/\D/g, ''), name: name.slice(0, 80), brand: String(p.brands || '').split(',')[0].trim().slice(0, 60), source: 'off',
    per100: { kcal: Math.round(kcal), protein_g: v('proteins_100g'), carbs_g: v('carbohydrates_100g'), sugar_g: v('sugars_100g'), fat_g: v('fat_100g'), fibre_g: v('fiber_100g') },
    serving: sq && sq > 0 && sq < 3000 ? { g: sq, label: String(p.serving_size || (sq + 'g')).slice(0, 40) } : null,
    uk: Array.isArray(p.countries_tags) && p.countries_tags.indexOf('en:united-kingdom') >= 0, size: String(p.quantity || '').slice(0, 30)
  };
}
async function offFetch(url) {
  const cache = typeof caches !== 'undefined' ? caches.default : null, key = new Request(url);
  if (cache) { const hit = await cache.match(key); if (hit) return hit.json(); }
  const res = await fetch(url, { headers: { 'User-Agent': OFF_UA, 'Accept': 'application/json' } });
  if (!res.ok) { const e = new Error('Food database error ' + res.status); e.status = res.status; throw e; }
  const data = await res.json();
  if (cache) { try { await cache.put(key, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' } })); } catch (e) {} }
  return data;
}
async function offSearch(q) {
  let list = null, lastErr = null;
  try {
    const d = await offFetch('https://search.openfoodfacts.org/search?q=' + encodeURIComponent(q) + '&page_size=30&langs=en&fields=' + OFF_FIELDS);
    if (d && Array.isArray(d.hits)) list = d.hits;
  } catch (e) { lastErr = e; }
  if (!list || !list.length) {
    try {
      const d = await offFetch('https://world.openfoodfacts.org/cgi/search.pl?search_terms=' + encodeURIComponent(q) + '&search_simple=1&action=process&json=1&page_size=30&fields=' + OFF_FIELDS);
      if (d && Array.isArray(d.products)) list = d.products;
    } catch (e) { lastErr = e; }
  }
  if (!list) throw new Error(lastErr && lastErr.status === 429 ? 'Open Food Facts is busy' : 'Open Food Facts unreachable');
  const seen = {}, items = [];
  list.map(offCompact).filter(Boolean).forEach(x => { const k = x.code || (x.name + '|' + x.brand).toLowerCase(); if (!seen[k]) { seen[k] = 1; items.push(x); } });
  items.sort((a, b) => (b.uk ? 1 : 0) - (a.uk ? 1 : 0));
  return items.slice(0, 12);
}

/* ── FatSecret Platform API: 2.3 million foods incl. UK restaurant chains. Signs in with the two secrets (OAuth 2 client
   credentials), keeps the token until it expires, and asks for UK results (a Premier plan feature: on the free Basic plan it
   quietly searches without the region). FatSecret only answers from addresses approved in your account: if it refuses, the
   reply says which address to approve. ── */
const FS_TOKEN_URL = 'https://oauth.fatsecret.com/connect/token', FS_API = 'https://platform.fatsecret.com/rest/server.api';
let FS_TOKEN = null, FS_REGION = true;
export function _resetFatSecret() { FS_TOKEN = null; FS_REGION = true; }
const b64 = s => (typeof btoa === 'function' ? btoa(s) : Buffer.from(s).toString('base64'));
function fsError(j, status) {
  const e = j && j.error, code = e && (e.code != null ? Number(e.code) : null), msg = String(e && (e.message || e) || ('FatSecret error ' + status));
  const ip = /(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{6,})/i.exec(msg);
  if (code === 21 || /ip address/i.test(msg)) return 'FatSecret refused this Worker’s address' + (ip ? ' (' + ip[1] + ')' : '') + '. Approve it under IP Restrictions in your FatSecret account.';
  if (code === 2 || code === 13 || /invalid_client|credential|token/i.test(msg)) return 'FatSecret didn’t accept the Client ID or Secret. Check FATSECRET_ID and FATSECRET_SECRET in Cloudflare (no spaces, and the newest secret), and that this Worker’s address is approved under IP Restrictions in FatSecret.';
  if (code === 22 || /quota|limit/i.test(msg)) return 'FatSecret’s daily limit is used up. It resets tomorrow.';
  return 'FatSecret: ' + msg.slice(0, 160);
}
async function fsToken(env) {
  if (FS_TOKEN && FS_TOKEN.exp > Date.now() + 60000) return FS_TOKEN.t;
  const res = await fetch(FS_TOKEN_URL, { method: 'POST', headers: { 'Authorization': 'Basic ' + b64(env.FATSECRET_ID + ':' + env.FATSECRET_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&scope=basic' });
  let j = null; try { j = await res.json(); } catch (e) {}
  if (!res.ok || !j || !j.access_token) throw new Error(fsError(j && j.error ? { error: { message: j.error_description || j.error } } : j, res.status));
  FS_TOKEN = { t: j.access_token, exp: Date.now() + Math.max(300, Number(j.expires_in) || 86400) * 1000 };
  return FS_TOKEN.t;
}
const r1w = x => Math.round(x * 10) / 10;
/* one FatSecret search result → a compact food. Its description reads "Per 1 wing - Calories: 91kcal | Fat: 6.20g | Carbs: 3.80g | Protein: 4.90g". */
export function fsCompact(f) {
  if (!f || typeof f !== 'object') return null;
  const m = /^Per\s+(.+?)\s+-\s+Calories:\s*([\d.]+)\s*kcal\s*\|\s*Fat:\s*([\d.]+)\s*g\s*\|\s*Carbs:\s*([\d.]+)\s*g\s*\|\s*Protein:\s*([\d.]+)\s*g/i.exec(String(f.food_description || ''));
  const name = String(f.food_name || '').trim();
  if (!m || !name) return null;
  const label = m[1].trim(), mac = { kcal: Math.round(+m[2]), protein_g: r1w(+m[5]), carbs_g: r1w(+m[4]), sugar_g: 0, fat_g: r1w(+m[3]), fibre_g: 0 };
  if (!(mac.kcal >= 0 && mac.kcal < 5000)) return null;
  const is100 = /^100\s*g$/i.test(label), gm = /(\d+(?:\.\d+)?)\s*g\b/i.exec(label), g = gm ? +gm[1] : null;
  const per100 = is100 ? mac : g && g > 0 && g <= 3000 ? { kcal: Math.round(mac.kcal * 100 / g), protein_g: r1w(mac.protein_g * 100 / g), carbs_g: r1w(mac.carbs_g * 100 / g), sugar_g: 0, fat_g: r1w(mac.fat_g * 100 / g), fibre_g: 0 } : null;
  if (per100 && per100.kcal > 950) return null;
  return { id: 'fs-' + String(f.food_id || '').replace(/\D/g, '').slice(0, 20), code: '', name: name.slice(0, 80), brand: String(f.brand_name || '').trim().slice(0, 60), source: 'fatsecret',
    per100, serving: is100 ? null : Object.assign({ label: label.slice(0, 40), g: g && g <= 3000 ? g : null }, mac), uk: true };
}
/* VF: is FatSecret answering, and from which internet address is this Worker calling? (FatSecret only answers addresses
   approved under IP Restrictions in your FatSecret account; Test connection in the app shows this) */
async function handleFoodCheck(env, cors) {
  let ip = null, fatsecret = 'not set up';
  try { const r = await fetch('https://api.ipify.org?format=json'); const j = await r.json(); if (j && typeof j.ip === 'string' && j.ip.length < 64) ip = j.ip; } catch (e) {}
  if (env.FATSECRET_ID && env.FATSECRET_SECRET) { try { const r = await fatSecretSearch(env, 'apple'); fatsecret = r.status; } catch (e) { fatsecret = String(e && e.message || e).slice(0, 220); } }
  return json({ ok: true, fatsecret, ip }, 200, cors);
}
async function fatSecretSearch(env, q) {
  if (!env.FATSECRET_ID || !env.FATSECRET_SECRET) return { status: 'not set up', items: [] };
  const token = await fsToken(env);
  const call = async region => {
    const res = await fetch(FS_API + '?method=foods.search&format=json&max_results=20&search_expression=' + encodeURIComponent(q) + (region ? '&region=GB&language=en' : ''), { headers: { 'Authorization': 'Bearer ' + token } });
    let j = null; try { j = await res.json(); } catch (e) {}
    return { res, j };
  };
  let r = await call(FS_REGION);
  if (FS_REGION && (!r.res.ok || (r.j && r.j.error)) && !(r.j && r.j.error && Number(r.j.error.code) === 21)) { FS_REGION = false; r = await call(false); }
  if (!r.res.ok || !r.j || r.j.error) { if (r.res.status === 401) FS_TOKEN = null; throw new Error(fsError(r.j, r.res.status)); }
  const list = r.j.foods && r.j.foods.food, arr = Array.isArray(list) ? list : list ? [list] : [];
  return { status: 'ok', items: arr.map(fsCompact).filter(Boolean) };
}

/* ── CoFID: the UK government's McCance & Widdowson food database (Quadram Institute API). Optional: works once a COFID_KEY
   secret is added (request one from fn-nbri@quadram.ac.uk). ── */
const COFID_API = 'https://api.cofid.quadram.ac.uk/api/v1/foods';
export function cofidCompact(d) {
  if (!d || typeof d !== 'object') return null;
  const p = d.proximates || {}, n = v => v === 'Tr' || v === 'tr' ? 0 : v == null || v === '' || !Number.isFinite(+v) ? null : r1w(+v);
  const kcal = n(p.energy_kcal), name = String(d.food_name || '').trim();
  if (kcal == null || kcal < 0 || kcal > 950 || !name) return null;
  return { id: 'cofid-' + String(d.food_code || '').replace(/[^0-9A-Za-z-]/g, '').slice(0, 12), code: '', name: name.slice(0, 80), brand: '', source: 'cofid',
    per100: { kcal: Math.round(kcal), protein_g: n(p.protein) || 0, carbs_g: n(p.carbohydrate) || 0, sugar_g: n(p.total_sugars != null ? p.total_sugars : p.sugars) || 0, fat_g: n(p.fat) || 0, fibre_g: n(p.fibre != null ? p.fibre : p.aoac_fibre) || 0 }, serving: null, uk: true };
}
async function cofidSearch(env, q) {
  if (!env.COFID_KEY) return { status: 'not set up', items: [] };
  const h = { 'X-API-Key': env.COFID_KEY, 'Accept': 'application/json' };
  const s = await fetch(COFID_API + '/search?q=' + encodeURIComponent(q) + '&limit=6', { headers: h });
  if (!s.ok) throw new Error(s.status === 403 ? 'CoFID didn’t accept COFID_KEY.' : s.status === 429 ? 'CoFID’s daily limit is used up.' : 'CoFID error ' + s.status);
  const j = await s.json(), hits = (j && Array.isArray(j.results) ? j.results : []).slice(0, 6);
  const det = await Promise.all(hits.map(r => fetch(COFID_API + '/' + encodeURIComponent(r.food_code), { headers: h }).then(x => x.ok ? x.json() : null).catch(() => null)));
  return { status: 'ok', items: det.map(cofidCompact).filter(Boolean) };
}

/* every online source at once; whichever answer, the app gets them, UK government data first, then FatSecret, then Open Food Facts */
async function handleFoodSearch(url, env, cors) {
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
  if (q.length < 2) return json({ ok: false, error: 'Type at least 2 letters.' }, 400, cors);
  const [co, fs, off] = await Promise.allSettled([cofidSearch(env, q), fatSecretSearch(env, q), offSearch(q)]);
  const status = r => r.status === 'fulfilled' ? (r.value && r.value.status) || 'ok' : String(r.reason && r.reason.message || r.reason);
  const sources = { cofid: status(co), fatsecret: status(fs), off: off.status === 'fulfilled' ? 'ok' : status(off) };
  const items = [].concat(co.status === 'fulfilled' ? co.value.items.slice(0, 5) : [], fs.status === 'fulfilled' ? fs.value.items.slice(0, 12) : [], off.status === 'fulfilled' ? off.value : []);
  if (!items.length && [co, fs, off].every(r => r.status === 'rejected' || (r.value && r.value.status === 'not set up'))) return json({ ok: false, error: 'Couldn’t reach the food databases.', sources }, 502, cors);
  return json({ ok: true, items: items.slice(0, 24), sources }, 200, cors);
}
async function handleBarcode(code, cors) {
  code = String(code || '').replace(/\D/g, '');
  if (code.length < 6 || code.length > 14) return json({ ok: false, error: 'That barcode doesn’t look right.' }, 400, cors);
  let d;
  try { d = await offFetch('https://world.openfoodfacts.org/api/v2/product/' + code + '.json?fields=' + OFF_FIELDS); }
  catch (e) { if (e.status === 404) return json({ ok: true, found: false }, 200, cors); return json({ ok: false, error: 'Couldn’t reach the food database.' }, 502, cors); }
  const item = d && d.status === 1 ? offCompact(Object.assign({ code }, d.product)) : null;
  return json(item ? { ok: true, found: true, item } : { ok: true, found: false }, 200, cors);
}
function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim()).filter(Boolean);
  const ok = origin && (allowed.includes(origin) || allowed.includes('*') ||
    (env.ALLOW_LOCALHOST === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)));
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (ok) h['Access-Control-Allow-Origin'] = origin;
  return { headers: h, ok: !!ok };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors) });
}

/* ───────────── limits (F26) ─────────────
   Wrong passcodes: after 10 from one connection inside 10 minutes, that connection is locked out for 15 minutes,
   and the right passcode is refused too until it ends. Counting is in memory; only the lock itself is written to KV
   (one write per lock), so guessing cannot use up the free storage writes.
   Paid routes: each has a daily ceiling so a loop or a stolen passcode cannot run up a bill. One small KV write per paid call. */
const LOCK_AFTER = 10, LOCK_WINDOW_MS = 10 * 60 * 1000, LOCK_SECS = 15 * 60;
const FAILS = new Map(), LOCKS = new Map(), USED = new Map();
const DAILY = { scan: 12 };
const KIND_NAME = { scan: 'InBody screenshot reads' };
export function _resetLimits() { FAILS.clear(); LOCKS.clear(); USED.clear(); }
const ipOf = req => cleanTok(req.headers.get('CF-Connecting-IP') || 'unknown', 45) || 'unknown';
async function lockedOut(env, ip) {
  const until = LOCKS.get(ip); if (until) { if (until > Date.now()) return true; LOCKS.delete(ip); }
  if (env.SYNC) { try { const v = await env.SYNC.get('lock:' + ip); if (v) { const u = Number(v); if (u > Date.now()) { LOCKS.set(ip, u); return true; } } } catch (e) {} }
  return false;
}
async function noteWrongKey(env, ip) {
  const now = Date.now(); let f = FAILS.get(ip); if (!f || now - f.first > LOCK_WINDOW_MS) f = { n: 0, first: now };
  f.n++; FAILS.set(ip, f); if (FAILS.size > 5000) FAILS.clear();
  if (f.n < LOCK_AFTER) return false;
  const until = now + LOCK_SECS * 1000; LOCKS.set(ip, until); FAILS.delete(ip);
  if (env.SYNC) { try { await env.SYNC.put('lock:' + ip, String(until), { expirationTtl: LOCK_SECS }); } catch (e) {} }
  return true;
}
/* count one paid call; false-y `ok` means today's ceiling for that kind is reached */
async function spend(env, kind) {
  const day = new Date().toISOString().slice(0, 10), key = 'use:' + day, limit = Math.max(0, Math.round(Number(env['LIMIT_' + kind.toUpperCase()]) || DAILY[kind]));
  let mem = USED.get(day); if (!mem) { USED.clear(); mem = {}; USED.set(day, mem); }
  let kv = {}; if (env.SYNC) { try { kv = JSON.parse(await env.SYNC.get(key) || '{}') || {}; } catch (e) { kv = {}; } }
  const used = Math.max(Number(kv[kind]) || 0, mem[kind] || 0);
  if (used >= limit) return { ok: false, used, limit };
  mem[kind] = used + 1; kv[kind] = used + 1;
  if (env.SYNC) { try { await env.SYNC.put(key, JSON.stringify(kv), { expirationTtl: 3 * 86400 }); } catch (e) {} } // a busy second can refuse the write; the in-memory count still holds
  return { ok: true, used: used + 1, limit };
}
function overLimit(kind, u, cors) { return json({ ok: false, limit: true, error: 'Daily limit reached: ' + u.limit + ' ' + KIND_NAME[kind] + ' a day. It resets overnight. Manual entry still works.' }, 429, cors); }

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const MAX_IMAGES = 4, MAX_IMAGE_B64 = 5 * 1024 * 1024;
async function handleScan(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'ANTHROPIC_API_KEY is not set on the worker.' }, 500, cors);
  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'Bad request body.' }, 400, cors); }
  const imgs = Array.isArray(body && body.images) ? body.images : [];
  if (!imgs.length) return json({ ok: false, error: 'No screenshots received.' }, 400, cors);
  if (imgs.length > MAX_IMAGES) return json({ ok: false, error: 'Send at most ' + MAX_IMAGES + ' screenshots.' }, 400, cors);
  const content = [];
  for (const im of imgs) {
    const mt = String(im && im.media_type || ''), data = String(im && im.data || '');
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mt)) return json({ ok: false, error: 'Screenshots must be JPEG, PNG, WebP or GIF.' }, 400, cors);
    if (!data || data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200))) return json({ ok: false, error: 'A screenshot was empty or too large.' }, 400, cors);
    content.push({ type: 'image', source: { type: 'base64', media_type: mt, data } });
  }
  const u = await spend(env, 'scan'); if (!u.ok) return overLimit('scan', u, cors);
  content.push({ type: 'text', text: 'Today is ' + String(body.today || '').slice(0, 10) + '. Read these InBody screenshots.' });
  return callClaude(env, cors, SCAN_PROMPT, content, 30000, 1200);
}

async function callClaude(env, cors, system, content, timeoutMs, maxTokens, opts) {
  opts = opts || {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: opts.model || env.MODEL || DEFAULT_MODEL, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: 'user', content }] })
    });
  } catch (e) {
    clearTimeout(timer);
    return json({ ok: false, error: e && e.name === 'AbortError' ? 'The System took too long.' : 'The System could not reach its AI.' }, 504, cors);
  }
  clearTimeout(timer);
  let data = null;
  try { data = await res.json(); } catch (e) { /* fall through */ }
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : ('AI error ' + res.status);
    return json({ ok: false, error: msg }, 502, cors);
  }
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  const out = blocks.filter(c => c.type === 'text').map(c => c.text).join('');
  if (!out) return json({ ok: false, error: 'The System got an empty reply.' }, 502, cors);
  return json({ ok: true, text: out, model: data.model || env.MODEL || DEFAULT_MODEL }, 200, cors);
}

const MAX_INBOX = 20, MAX_INBOX_ITEM = 4096;
async function readInbox(env) { try { const r = await env.SYNC.get('inbox'); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; } }
async function handleInbox(req, env, cors, path) {
  if (!env.SYNC) return json({ ok: false, error: 'The inbox needs the SYNC KV binding (see README step 2.4).' }, 501, cors);
  if (req.method === 'GET') return json({ ok: true, items: await readInbox(env) }, 200, cors);
  const text = await req.text();
  if (text.length > MAX_INBOX_ITEM) return json({ ok: false, error: 'Too much data.' }, 413, cors);
  let body; try { body = JSON.parse(text); } catch (e) { return json({ ok: false, error: 'Send JSON, e.g. {"weight":"89.2 kg","pbf":"24.9%","lbm":"67 kg"}.' }, 400, cors); }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'Send a JSON object.' }, 400, cors);
  const items = await readInbox(env);
  if (path === '/inbox/ack') {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const left = items.filter(x => ids.indexOf(x.id) < 0);
    await env.SYNC.put('inbox', JSON.stringify(left));
    return json({ ok: true, removed: items.length - left.length }, 200, cors);
  }
  const keys = ['weight', 'pbf', 'lbm', 'smm', 'bfm', 'score', 'date', 'w', 'bf', 'body_fat', 'lean'];
  const data = {};
  keys.forEach(k => { if (body[k] != null && body[k] !== '') data[k] = String(body[k]).slice(0, 60); });
  if (!data.weight && !data.w && !data.pbf && !data.bf && !data.lbm) return json({ ok: false, error: 'No weight, body fat or lean mass found. Check the Shortcut sends fields named weight, pbf and lbm.' }, 400, cors);
  const item = { id: 'ib-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), at: new Date().toISOString(), data };
  items.push(item);
  await env.SYNC.put('inbox', JSON.stringify(items.slice(-MAX_INBOX)));
  return json({ ok: true, id: item.id, message: 'Sent to Winter Arc. Open the app to confirm.' }, 200, cors);
}

/* ───────────── cloud copy ─────────────
   The state is stored exactly as the app sends it and is never parsed here (parsing ~0.4 MB on every change was most of
   this worker's processor time). What the worker needs to know about a copy travels beside it as KV metadata:
     { savedAt, pushId, days, kg, changedAt, seq, ringAt }
   Safety net: the last copy of each day is kept for 30 days (snap:YYYY-MM-DD), a copy that is deliberately replaced is kept
   for 30 days (snap:…-replaced), and the 5 most recent earlier versions at least 5 minutes apart are kept (ver:0…4). */
const SNAP_TTL = 30 * 86400, RING = 5, RING_GAP_MS = 5 * 60 * 1000;
const cleanTok = (v, n) => String(v == null ? '' : v).replace(/[^A-Za-z0-9_.:\-]/g, '').slice(0, n || 64);
const numOrNull = v => { if (v == null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
function looksLikeState(t) { return t.length > 20 && t.charCodeAt(0) === 123 && t.charCodeAt(t.length - 1) === 125 && /"version":\s*\d/.test(t) && /"days":\s*\{/.test(t) && /"profile":\s*\{/.test(t); }
async function kvGetMeta(env, key, stream) {
  if (env.SYNC.getWithMetadata) { const r = await env.SYNC.getWithMetadata(key, stream ? { type: 'stream' } : undefined); return r || { value: null, metadata: null }; }
  return { value: await env.SYNC.get(key), metadata: null };
}
/* one stored copy → { raw: the state as text, meta }. Copies written by the previous worker ({"savedAt","data"}) are read once the old way. */
async function readCopy(env, key) {
  const r = await kvGetMeta(env, key);
  if (r.value == null) return null;
  if (r.metadata && r.metadata.savedAt) return { raw: r.value, meta: r.metadata };
  let o = null; try { o = JSON.parse(r.value); } catch (e) {}
  if (!o || typeof o !== 'object' || !o.data || typeof o.data !== 'object') return { raw: null, meta: null, broken: true };
  return { raw: JSON.stringify(o.data), meta: { savedAt: o.savedAt || null, pushId: null, days: null, kg: null, changedAt: null, seq: 0, ringAt: 0 }, old: true };
}
const metaOut = m => ({ savedAt: m.savedAt || null, pushId: m.pushId || null, days: m.days == null ? null : m.days, kg: m.kg == null ? null : m.kg, changedAt: m.changedAt == null ? null : m.changedAt });
function rawReply(meta, raw, cors) { // {"ok":true,…,"data":<the state, untouched>}
  const head = JSON.stringify(Object.assign({ ok: true }, metaOut(meta)));
  return new Response(head.slice(0, -1) + ',"data":' + raw + '}', { status: 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors) });
}
async function handleSync(req, env, cors, url) {
  if (!env.SYNC) return json({ ok: false, error: 'Cloud backup is not set up (no SYNC KV binding).' }, 501, cors);
  const q = url.searchParams;
  if (req.method === 'GET') {
    if (q.get('meta') === '1') { // what the cloud holds, without sending (or reading) the copy itself
      const r = await kvGetMeta(env, 'state', true);
      if (r.value && r.value.cancel) { try { r.value.cancel(); } catch (e) {} }
      if (r.value == null) return json({ ok: true, has: false, savedAt: null }, 200, cors);
      if (r.metadata && r.metadata.savedAt) return json(Object.assign({ ok: true, has: true }, metaOut(r.metadata)), 200, cors);
      const old = await readCopy(env, 'state');
      if (!old || old.broken) return json({ ok: false, error: 'Stored backup is unreadable.' }, 500, cors);
      return json(Object.assign({ ok: true, has: true }, metaOut(old.meta)), 200, cors);
    }
    const cur = await readCopy(env, 'state');
    if (!cur) return json({ ok: true, data: null, savedAt: null }, 200, cors);
    if (cur.broken) return json({ ok: false, error: 'Stored backup is unreadable.' }, 500, cors);
    return rawReply(cur.meta, cur.raw, cors);
  }
  if (Number(req.headers.get('content-length') || 0) > MAX_SYNC_BYTES) return json({ ok: false, error: 'Backup too large.' }, 413, cors);
  const text = await req.text();
  if (text.length > MAX_SYNC_BYTES) return json({ ok: false, error: 'Backup too large.' }, 413, cors);
  let body, base, checkBase, force, pushId = '', days = null, kg = null, changedAt = null;
  if (q.get('v') === '2') { // current app: the state is the body, the details are in the address
    if (!looksLikeState(text)) return json({ ok: false, error: 'Backup is not a Winter Arc save.' }, 400, cors);
    body = text; base = q.get('base') || null; checkBase = true; force = q.get('force') === '1';
    pushId = cleanTok(q.get('id'), 40); days = numOrNull(q.get('days')); kg = numOrNull(q.get('kg')); changedAt = numOrNull(q.get('changed'));
  } else { // older app versions: {"data":…,"base":…,"force":…}
    let parsed; try { parsed = JSON.parse(text); } catch (e) { return json({ ok: false, error: 'Backup is not valid JSON.' }, 400, cors); }
    if (!parsed || typeof parsed !== 'object' || !parsed.data || typeof parsed.data !== 'object') return json({ ok: false, error: 'Backup is missing data.' }, 400, cors);
    const pd = parsed.data; if (Array.isArray(pd) || typeof pd.version !== 'number' || !pd.days || typeof pd.days !== 'object' || Array.isArray(pd.days)) return json({ ok: false, error: 'Backup is not a Winter Arc save.' }, 400, cors);
    body = JSON.stringify(parsed.data); base = parsed.base == null ? null : parsed.base; checkBase = 'base' in parsed; force = !!parsed.force;
  }
  const cur = await readCopy(env, 'state');
  let savedAt = new Date().toISOString(), seq = 0, ringAt = 0;
  if (cur && cur.meta) {
    const m = cur.meta;
    if (m.savedAt && checkBase && !force && base !== m.savedAt) {
      // the same upload arriving a second time (its first reply never reached the phone) is not a conflict
      if (pushId && m.pushId === pushId) return json({ ok: true, savedAt: m.savedAt, repeat: true }, 200, cors);
      return json({ ok: false, conflict: true, savedAt: m.savedAt, pushId: m.pushId || null, error: 'The cloud copy changed on another device.' }, 409, cors);
    }
    // a copy with clearly fewer logged days never replaces a fuller one unless you chose that on the phone (the replaced copy is then kept for 30 days)
    if (!force && days != null && m.days != null && m.days - days >= 2) return json({ ok: false, conflict: true, smaller: true, savedAt: m.savedAt, pushId: m.pushId || null, error: 'The cloud copy holds more logged days than this one.' }, 409, cors);
    if (m.savedAt && savedAt <= m.savedAt) savedAt = new Date((Date.parse(m.savedAt) || Date.now()) + 1).toISOString(); // every version gets its own time
    seq = m.seq || 0; ringAt = m.ringAt || 0;
    if (cur.raw) {
      const pm = Object.assign(metaOut(m), {}), prevDay = String(m.savedAt || '').slice(0, 10), now = Date.now();
      if (force) await env.SYNC.put('snap:' + cleanTok(m.savedAt || String(now), 30) + '-replaced', cur.raw, { expirationTtl: SNAP_TTL, metadata: Object.assign(pm, { kind: 'replaced' }) });
      else if (prevDay && prevDay !== savedAt.slice(0, 10)) await env.SYNC.put('snap:' + prevDay, cur.raw, { expirationTtl: SNAP_TTL, metadata: Object.assign(pm, { kind: 'daily' }) });
      else if (now - ringAt >= RING_GAP_MS) { await env.SYNC.put('ver:' + (seq % RING), cur.raw, { metadata: Object.assign(pm, { kind: 'recent' }) }); seq++; ringAt = now; }
    }
  }
  await env.SYNC.put('state', body, { metadata: { savedAt, pushId, days, kg, changedAt, seq, ringAt } });
  return json({ ok: true, savedAt }, 200, cors);
}
/* earlier versions you can go back to */
const VERSION_KEY = /^(snap:[A-Za-z0-9_.:\-]{1,60}|ver:[0-9]|state_prev)$/;
async function handleVersions(req, env, cors, url) {
  if (!env.SYNC) return json({ ok: false, error: 'Cloud backup is not set up (no SYNC KV binding).' }, 501, cors);
  if (url.pathname === '/sync/versions') {
    const out = [];
    for (const prefix of ['snap:', 'ver:', 'state_prev']) {
      const l = env.SYNC.list ? await env.SYNC.list({ prefix }) : { keys: [] };
      (l.keys || []).forEach(k => {
        const m = k.metadata || {}, day = /^snap:(\d{4}-\d{2}-\d{2})$/.exec(k.name);
        out.push({ key: k.name, savedAt: m.savedAt || (day ? day[1] + 'T23:59:00.000Z' : null), days: m.days == null ? null : m.days, kg: m.kg == null ? null : m.kg, kind: m.kind || (/-replaced$/.test(k.name) ? 'replaced' : prefix === 'snap:' ? 'daily' : 'recent') });
      });
    }
    out.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    return json({ ok: true, versions: out.slice(0, 60) }, 200, cors);
  }
  const key = String(url.searchParams.get('key') || '');
  if (!VERSION_KEY.test(key)) return json({ ok: false, error: 'Unknown version.' }, 400, cors);
  const c = await readCopy(env, key);
  if (!c) return json({ ok: false, error: 'That version is no longer kept.' }, 404, cors);
  if (c.broken) return json({ ok: false, error: 'That version is unreadable.' }, 500, cors);
  return rawReply(c.meta, c.raw, cors);
}

/* ═══════════════ iPhone reminders (Web Push) ═══════════════
   The app sends its push subscription to POST /push/subscribe. A Cron Trigger (every 30 minutes) runs scheduled() below:
   it reads your cloud copy, works out today's water and protein in London time and, only when you are behind, sends a
   reminder. The keys that sign the pushes (VAPID) are made by the Worker itself the first time and kept in the SYNC KV,
   so there is nothing extra to paste. Messages are encrypted for your phone only (RFC 8291 aes128gcm). */
const b64u = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = str => { const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s + '==='.slice((s.length + 3) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const cat = (...arrs) => { const n = arrs.reduce((a, x) => a + x.length, 0), out = new Uint8Array(n); let o = 0; arrs.forEach(x => { out.set(x, o); o += x.length; }); return out; };
const TXT = s => new TextEncoder().encode(s);
async function hkdf(salt, ikm, info, bytes) { const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8)); }
/* the payload, encrypted for one subscription (keys.p256dh, keys.auth) → the request body */
export async function encryptPush(sub, text, saltIn, asKeys) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  if (uaPub.length !== 65 || auth.length < 16) throw new Error('bad subscription keys');
  const as = asKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, cat(TXT('WebPush: info\0'), uaPub, asPub), 32);
  const salt = saltIn || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, TXT('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(salt, ikm, TXT('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(TXT(text), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt, 0); new DataView(head.buffer).setUint32(16, 4096); head[20] = 65;
  return cat(head, asPub, ct);
}
/* the Worker's own signing keys, made once and kept in KV */
export async function vapidKeys(env) {
  let j = null; try { j = JSON.parse(await env.SYNC.get('push:vapid') || 'null'); } catch (e) {}
  if (!j || !j.d || !j.x || !j.y) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jw = await crypto.subtle.exportKey('jwk', kp.privateKey); j = { d: jw.d, x: jw.x, y: jw.y };
    await env.SYNC.put('push:vapid', JSON.stringify(j));
  }
  const pub = b64u(cat(new Uint8Array([4]), unb64u(j.x), unb64u(j.y)));
  const priv = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: j.d, x: j.x, y: j.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { pub, priv };
}
async function vapidAuth(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin, now = Math.floor(Date.now() / 1000);
  const head = b64u(TXT(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))), body = b64u(TXT(JSON.stringify({ aud, exp: now + 12 * 3600, sub: subject || 'mailto:ascend@example.com' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.priv, TXT(head + '.' + body));
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + keys.pub;
}
async function sendPush(env, sub, msg, keys) {
  const body = await encryptPush(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, { method: 'POST', headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'normal', Authorization: await vapidAuth(sub.endpoint, keys, env.PUSH_SUBJECT) }, body });
  return r.status;
}
async function readSubs(env) { try { const a = JSON.parse(await env.SYNC.get('push:subs') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function cleanSub(x) {
  if (!x || typeof x !== 'object' || typeof x.endpoint !== 'string' || !/^https:\/\//.test(x.endpoint) || x.endpoint.length > 1000 || !x.keys || typeof x.keys.p256dh !== 'string' || typeof x.keys.auth !== 'string') return null;
  return { endpoint: x.endpoint, keys: { p256dh: x.keys.p256dh.slice(0, 200), auth: x.keys.auth.slice(0, 100) }, added: Date.now() };
}
async function pushToAll(env, msg) {
  const subs = await readSubs(env); if (!subs.length) return { sent: 0, subs: 0 };
  const keys = await vapidKeys(env); let sent = 0; const keep = [];
  for (const sub of subs) {
    let st = 0; try { st = await sendPush(env, sub, msg, keys); } catch (e) { st = -1; }
    if (st === 404 || st === 410) continue; // the phone dropped this subscription
    keep.push(sub); if (st >= 200 && st < 300) sent++;
  }
  if (keep.length !== subs.length) await env.SYNC.put('push:subs', JSON.stringify(keep));
  return { sent, subs: keep.length };
}
async function handlePush(req, env, cors, path) {
  if (!env.SYNC) return json({ ok: false, error: 'Reminders need the SYNC KV binding (the same one cloud backup uses).' }, 501, cors);
  if (path === '/push/key') return json({ ok: true, key: (await vapidKeys(env)).pub }, 200, cors);
  let body = {}; try { body = await req.json(); } catch (e) {}
  if (path === '/push/subscribe') {
    const sub = cleanSub(body && body.sub); if (!sub) return json({ ok: false, error: 'That isn’t a push subscription.' }, 400, cors);
    const subs = (await readSubs(env)).filter(x => x.endpoint !== sub.endpoint); subs.push(sub);
    await env.SYNC.put('push:subs', JSON.stringify(subs.slice(-5)));
    return json({ ok: true, devices: Math.min(5, subs.length) }, 200, cors);
  }
  if (path === '/push/unsubscribe') {
    const ep = body && body.endpoint; const subs = (await readSubs(env)).filter(x => ep ? x.endpoint !== ep : false);
    await env.SYNC.put('push:subs', JSON.stringify(subs)); return json({ ok: true, devices: subs.length }, 200, cors);
  }
  if (path === '/push/test') {
    const r = await pushToAll(env, { title: 'Ascend', body: 'Reminders are on. You’ll hear from the System when you fall behind on water or protein.', tag: 'test', url: './' });
    return json(Object.assign({ ok: r.sent > 0, error: r.subs ? (r.sent ? '' : 'The phone’s push service refused it. Turn notifications off and on again in Settings.') : 'No phone is signed up yet. Tap “Turn on notifications” first.' }, r), 200, cors);
  }
  return json({ ok: false, error: 'Not found.' }, 404, cors);
}
/* London wall-clock for an instant: { day: 'YYYY-MM-DD', h, m } */
export function londonNow(ms) {
  const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  return { day: p.year + '-' + p.month + '-' + p.day, h: +p.hour, m: +p.minute };
}
export const WATER_HOURS = [9, 11, 13, 15, 17, 19, 21], MACRO_HOURS = [13, 16, 20];
/* the reminder due now, if any: state = the cloud copy; sent = slots already sent today. Returns { slot, msg } or null */
export function reminderDue(state, now, sent) {
  if (!state || typeof state !== 'object') return null;
  const st = state.settings && state.settings.remind; if (!st || st.on !== true) return null;
  const d = (state.days && state.days[now.day]) || {}, T = state.targets || {}, done = sent || [];
  const water = Math.max(0, Number(d.water) || 0), wt = Number(T.waterMl) || 3000, foods = Array.isArray(d.foods) ? d.foods : [];
  const prot = foods.reduce((a, f) => a + (Number(f && f.p) || 0), 0), pt = Number(T.protein) || 160, kcal = foods.reduce((a, f) => a + (Number(f && f.cal) || 0), 0);
  const nf = v => Math.round(v).toLocaleString('en-GB');
  if (st.water !== false && WATER_HOURS.indexOf(now.h) >= 0 && done.indexOf('w' + now.h) < 0) {
    const want = Math.round(wt * (now.h - 8) / 13 / 50) * 50;
    if (water < wt && water < want - 100) return { slot: 'w' + now.h, msg: { title: '💧 Water check', body: nf(water) + 'ml of ' + (wt / 1000) + 'L so far. Aim for about ' + nf(want) + 'ml by now. Have a glass, then tap to log it.', tag: 'water', url: './?do=water' } };
  }
  if (st.macros !== false && MACRO_HOURS.indexOf(now.h) >= 0 && done.indexOf('m' + now.h) < 0) {
    if (now.h === 13 && !foods.length) return { slot: 'm13', msg: { title: '🍽️ Nothing logged yet', body: 'Log breakfast and lunch so the System can keep your calories and protein on track.', tag: 'macros', url: './?do=log' } };
    const want = Math.round(pt * (now.h - 8) / 14);
    if (now.h > 13 && prot < want - 10) return { slot: 'm' + now.h, msg: { title: '🥩 Protein check', body: Math.round(prot) + 'g of ' + pt + 'g protein so far (' + nf(kcal) + ' kcal). ' + (now.h >= 20 ? Math.round(pt - prot) + 'g to go: a shake or a high-protein snack closes most of it.' : 'Aim for about ' + want + 'g by now.'), tag: 'macros', url: './?do=log' } };
  }
  return null;
}
export async function runReminders(env, ms) {
  if (!env.SYNC) return { skipped: 'no KV' };
  const subs = await readSubs(env); if (!subs.length) return { skipped: 'no phones' };
  const cur = await readCopy(env, 'state'); if (!cur || !cur.raw) return { skipped: 'no cloud copy' };
  let state = null; try { state = JSON.parse(cur.raw); } catch (e) { return { skipped: 'unreadable' }; }
  const now = londonNow(ms || Date.now());
  let log = { day: '', slots: [] }; try { log = JSON.parse(await env.SYNC.get('push:sent') || 'null') || log; } catch (e) {}
  if (log.day !== now.day) log = { day: now.day, slots: [] };
  const due = reminderDue(state, now, log.slots); if (!due) return { skipped: 'nothing due' };
  log.slots.push(due.slot); await env.SYNC.put('push:sent', JSON.stringify(log)); // marked first, so a slow run never sends it twice
  return Object.assign({ slot: due.slot }, await pushToAll(env, due.msg));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const c = corsHeaders(origin, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
    if (origin && !c.ok) return json({ ok: false, error: 'Origin not allowed.' }, 403, c.headers);
    if (url.pathname === '/health' || url.pathname === '/') {
      return json({ ok: true, app: 'ascend', version: 7, food: true, push: !!env.SYNC, fatsecret: !!(env.FATSECRET_ID && env.FATSECRET_SECRET), cofid: !!env.COFID_KEY, ai: !!env.ANTHROPIC_API_KEY, kv: !!env.SYNC, auth: !!env.APP_KEY, model: env.MODEL || DEFAULT_MODEL }, 200, c.headers);
    }
    if (!env.APP_KEY) return json({ ok: false, error: 'APP_KEY is not set on the worker.' }, 500, c.headers);
    const ip = ipOf(req);
    if (await lockedOut(env, ip)) return json({ ok: false, locked: true, error: 'Too many wrong app keys from this connection. It is locked for 15 minutes; then try again with the right key.' }, 429, c.headers);
    if (!safeEqual(req.headers.get('X-App-Key'), env.APP_KEY)) { const locked = await noteWrongKey(env, ip); return json({ ok: false, locked, error: locked ? 'Too many wrong app keys. This connection is locked for 15 minutes.' : 'Wrong app key.' }, locked ? 429 : 401, c.headers); }
    FAILS.delete(ip); // the right key clears the count of earlier slips
    try {
      if (url.pathname === '/parse' || url.pathname === '/food/label' || url.pathname === '/food/web') return json({ ok: false, gone: true, error: 'Logging by Claude has been removed. Close and reopen the app to update it.' }, 410, c.headers);
      if (url.pathname === '/sync' && (req.method === 'GET' || req.method === 'PUT')) return await handleSync(req, env, c.headers, url);
      if ((url.pathname === '/sync/versions' || url.pathname === '/sync/version') && req.method === 'GET') return await handleVersions(req, env, c.headers, url);
      if (url.pathname === '/scan' && req.method === 'POST') return await handleScan(req, env, c.headers);
      if (url.pathname === '/food/search' && req.method === 'GET') return await handleFoodSearch(url, env, c.headers);
      if (url.pathname === '/food/check' && req.method === 'GET') return await handleFoodCheck(env, c.headers);
      if (url.pathname.indexOf('/food/barcode/') === 0 && req.method === 'GET') return await handleBarcode(url.pathname.split('/').pop(), c.headers);
      if ((url.pathname === '/push/key' && req.method === 'GET') || (['/push/subscribe', '/push/unsubscribe', '/push/test'].indexOf(url.pathname) >= 0 && req.method === 'POST')) return await handlePush(req, env, c.headers, url.pathname);
      if ((url.pathname === '/inbox' && (req.method === 'GET' || req.method === 'POST')) || (url.pathname === '/inbox/ack' && req.method === 'POST')) return await handleInbox(req, env, c.headers, url.pathname);
      return json({ ok: false, error: 'Not found.' }, 404, c.headers);
    } catch (e) {
      return json({ ok: false, error: 'Worker error: ' + (e && e.message || e) }, 500, c.headers);
    }
  },
  // Cron Trigger (Settings → Triggers → Cron, every 30 minutes): water and protein reminders
  async scheduled(event, env, ctx) { ctx.waitUntil(runReminders(env, event && event.scheduledTime || Date.now()).catch(() => {})); }
};
