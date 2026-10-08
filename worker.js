/* ═══════════════════════════════════════════════════════════════════════════
   WINTER ARC — Cloudflare Worker
   • POST /parse   → sends your text to Claude, returns Claude's JSON reply
   • GET  /sync    → returns your cloud copy (needs the SYNC KV binding); /sync?meta=1 returns only its details
   • PUT  /sync    → saves your cloud copy (refuses to overwrite a newer one; keeps earlier versions)
   • GET  /sync/versions, /sync/version?key=… → the earlier versions you can restore
   • POST /scan    → Claude reads InBody screenshots, returns the numbers as JSON
   • POST /inbox   → your iPhone Shortcut drops Apple Health body data here (needs SYNC)
   • GET  /inbox   → the app collects it; POST /inbox/ack removes confirmed items
   • GET  /food/search?q=  → food database search (Open Food Facts, UK products first)
   • GET  /food/barcode/:code → product by barcode
   • POST /food/label      → Claude reads a nutrition-label photo
   • POST /food/web        → Claude finds exact figures online (needs web search enabled in Console)
   • GET  /health  → shows what's configured
   Secrets (Settings → Variables and Secrets):
     ANTHROPIC_API_KEY  your Claude API key            (secret)
     APP_KEY            a long passcode you choose      (secret) — typed once into the app
   Optional variables:
     ALLOWED_ORIGINS    default https://sitbackco.github.io
     MODEL              default claude-haiku-4-5-20251001
     LIMIT_PARSE, LIMIT_SCAN, LIMIT_LABEL, LIMIT_WEB   daily ceilings (defaults 120, 12, 30, 8)
   Optional binding:
     SYNC               a KV namespace for cloud backup
   ═══════════════════════════════════════════════════════════════════════════ */

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_ORIGINS = 'https://sitbackco.github.io';
const MAX_TEXT = 1200;
const MAX_SYNC_BYTES = 5 * 1024 * 1024;
const AI_TIMEOUT_MS = 14000;

export const SYSTEM_PROMPT = `You are the logging engine inside "Winter Arc", a UK fitness tracker. The user types what they ate, trained, did, measured or drank. Convert it into JSON for the app.

Reply with ONE JSON object and nothing else — no prose, no markdown fences.

Shape:
{"type":"food"|"training"|"activity"|"body"|"water"|"mixed"|"unknown","items":[...],"message":"only when type is unknown: a short hint"}
Use "mixed" when the message contains more than one kind. Every item has a "kind".

FOOD item:
{"kind":"food","name":"Vegetable samosa","quantity":"2 medium (~100g each)","meal":null,"calories":520,"protein_g":10,"carbs_g":52,"sugar_g":3,"fat_g":30,"fibre_g":5,"confidence":"medium","assumption":"2 medium deep-fried veg samosas"}
- One item per distinct food. Multiples go in one item (quantity "2").
- Numbers only (no strings, no ranges). Round calories to whole numbers, grams to 1 decimal.
- UK portions and UK products by default (Tesco, Sainsbury's, Greggs, Nando's, McDonald's UK, etc.). Use the brand's published values when a brand is named.
- The user often eats South Asian / Sri Lankan Tamil home food (rice and curry, dhal, string hoppers, dosa, kothu, samosa, bhaji, pakora). Estimate typical home portions honestly — do not lowball fried food.
- If the user gives weights, use them exactly. If the user gives their own macros, use them.
- "meal" is "breakfast"/"lunch"/"dinner"/"snack" only if the user says so, otherwise null.
- confidence: "high" ONLY when the user gave the weight or their own macros, or the food is in the user's own foods list in the context. Brand or restaurant figures you are recalling from memory are "medium" at most, because menus and recipes change. "medium" for typical portions, "low" for vague descriptions. assumption: one short sentence on the portion you assumed.
- Sugar must not exceed carbs. protein*4 + carbs*4 + fat*9 should roughly match calories.
- The user is lactose intolerant and uses whey ISOLATE. Their "protein bowl" = 250g fat-free Greek yogurt + 65g whey isolate.

TRAINING item (one per exercise):
{"kind":"exercise","name":"Lat pulldown","sets":[{"kg":60,"reps":10},{"kg":60,"reps":10},{"kg":60,"reps":10}]}
- Expand "3x10 at 60kg" into 3 set objects. Bodyweight moves (push-ups, pull-ups, dips) use kg 0 unless weight is added.
- Convert lb to kg (÷2.2046). Keep the exercise name the user used.

ACTIVITY item:
{"kind":"activity","type":"steps","steps":11400}
{"kind":"activity","type":"football","minutes":60,"kcal":null}
- type is one of: steps, gym, football, cardio, sprint, ballwork, abs, other. "gym done"/"trained" with no details = gym, 60 minutes. Incline walk/run/cycle = cardio. Sprints = sprint. Ball drills/wall passes/skills = ballwork. A home abs or core session (planks, crunches, leg raises) = abs.
- kcal only if the user states it, otherwise null.

BODY item (only the fields given):
{"kind":"body","weight_kg":88.6,"body_fat_pct":null,"waist_cm":96}
- "weighed 88.6" = weight_kg. Convert stone/lb to kg, inches to cm. Allowed fields: weight_kg, body_fat_pct, waist_cm, chest_cm, shoulders_cm, arms_cm.

WATER item:
{"kind":"water","ml":750}
- 1 glass = 250ml, 1 bottle = 500ml unless stated, litres ×1000.

If nothing is loggable, reply {"type":"unknown","items":[],"message":"..."}.`;

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

export const LABEL_PROMPT = `You read a photo of a UK food nutrition label and return JSON only. Reply with ONE JSON object and nothing else.
{"found":true,"name":null,"brand":null,"barcode":null,"per100":{"kcal":0,"protein_g":0,"carbs_g":0,"sugar_g":0,"fat_g":0,"fibre_g":0},"serving_g":null,"serving_label":null,"per_serving":null}
- per100 is the "per 100g" (or per 100ml) column. per_serving is the per-portion column if the label has one, with serving_g and serving_label (e.g. "1 bar (60g)").
- Use kcal, never kJ. Copy the numbers exactly. Use null for anything not visible. Never estimate.
- "of which sugars" is sugar_g. "Fibre" is fibre_g. Name, brand and the barcode digits only if they're visible.
- If this isn't a nutrition label, reply {"found":false,"message":"short reason"}.`;

export const WEB_PROMPT = `You find exact nutrition information for UK foods using web search. The user names a food: a branded product, a supermarket item, or a restaurant or café item.
Search official sources first: the brand's or restaurant's own UK website, then UK supermarket product pages (Tesco, Sainsbury's, Asda, Morrisons, Ocado, Waitrose), then reputable nutrition databases.
Finish with ONE JSON object as the very last thing in your reply:
{"found":true,"name":"...","brand":"...","serving_label":"1 roll","serving_g":null,"per_serving":{"kcal":0,"protein_g":0,"carbs_g":0,"sugar_g":0,"fat_g":0,"fibre_g":0},"per100":null,"source_url":"https://...","source_title":"..."}
- per_serving is ONE serving exactly as the source lists it (one roll, one wrap, one bar). Do not scale it to the user's amount.
- Include per100 only if the source lists per-100g values. Use kcal, not kJ. Use the UK version of the product or menu.
- If you can't find reliable figures, reply {"found":false,"message":"short reason"}. Never invent or estimate numbers.`;

const OFF_UA = 'WinterArc/1.0 (personal fitness tracker)';
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
async function handleFoodSearch(url, cors) {
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
  if (q.length < 2) return json({ ok: false, error: 'Type at least 2 letters.' }, 400, cors);
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
  if (!list) return json({ ok: false, error: lastErr && lastErr.status === 429 ? 'The food database is busy. Try again in a minute.' : 'Couldn’t reach the food database.' }, 502, cors);
  const seen = {}, items = [];
  list.map(offCompact).filter(Boolean).forEach(x => { const k = x.code || (x.name + '|' + x.brand).toLowerCase(); if (!seen[k]) { seen[k] = 1; items.push(x); } });
  items.sort((a, b) => (b.uk ? 1 : 0) - (a.uk ? 1 : 0));
  return json({ ok: true, items: items.slice(0, 20) }, 200, cors);
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
async function handleLabel(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'ANTHROPIC_API_KEY is not set on the worker.' }, 500, cors);
  let body; try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'Bad request body.' }, 400, cors); }
  const im = body && body.image, mt = String(im && im.media_type || ''), data = String(im && im.data || '');
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mt) || !data || data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200))) return json({ ok: false, error: 'Send one JPEG or PNG photo of the label.' }, 400, cors);
  const u = await spend(env, 'label'); if (!u.ok) return overLimit('label', u, cors);
  return callClaude(env, cors, LABEL_PROMPT, [{ type: 'image', source: { type: 'base64', media_type: mt, data } }, { type: 'text', text: 'Read this nutrition label.' + (body.barcode ? ' Barcode scanned: ' + String(body.barcode).replace(/\D/g, '').slice(0, 14) : '') }], 30000, 800);
}
async function handleWeb(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'ANTHROPIC_API_KEY is not set on the worker.' }, 500, cors);
  let body; try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'Bad request body.' }, 400, cors); }
  const q = String(body && body.query || '').trim();
  if (q.length < 2 || q.length > 200) return json({ ok: false, error: 'Describe the food in 2–200 characters.' }, 400, cors);
  const u = await spend(env, 'web'); if (!u.ok) return overLimit('web', u, cors);
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'GB', timezone: 'Europe/London' } }];
  return callClaude(env, cors, WEB_PROMPT, [{ type: 'text', text: 'Find the nutrition for: ' + q }], 55000, 1500, { tools, model: env.WEB_MODEL || 'claude-sonnet-5-5', afterSearch: true });
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
const DAILY = { parse: 120, scan: 12, label: 30, web: 8 };
const KIND_NAME = { parse: 'text logs', scan: 'InBody screenshot reads', label: 'label photo reads', web: 'web lookups' };
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

async function handleParse(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'ANTHROPIC_API_KEY is not set on the worker.' }, 500, cors);
  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'Bad request body.' }, 400, cors); }
  const text = String((body && body.text) || '').trim();
  if (!text) return json({ ok: false, error: 'Nothing to log.' }, 400, cors);
  if (text.length > MAX_TEXT) return json({ ok: false, error: 'Message too long (max ' + MAX_TEXT + ' characters).' }, 400, cors);
  const u = await spend(env, 'parse'); if (!u.ok) return overLimit('parse', u, cors);
  let ctx = 'Context: today is ' + String(body.today || '').slice(0, 10) + ', time ' + String(body.time || '').slice(0, 5) + ' (UK), day type ' + String(body.dayType || '').slice(0, 10) + '.';
  if (Array.isArray(body.known) && body.known.length) {
    const lines = body.known.slice(0, 25).map(k => k && typeof k === 'object' ? '- ' + String(k.name).slice(0, 60) + ' | ' + String(k.qty || '').slice(0, 30) + ' | ' + [k.cal, k.p, k.c, k.s, k.f, k.fib].map(Number).map(x => Number.isFinite(x) ? x : 0).join('/') : '').filter(Boolean).join('\n');
    ctx += '\nThe user\'s own foods (name | portion | kcal/protein/carbs/sugar/fat/fibre). When the message mentions one of these, use these exact values, scaled to the amount they ate, with confidence "high":\n' + lines.slice(0, 3000);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.MODEL || DEFAULT_MODEL, max_tokens: 1500, temperature: 0, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: ctx + '\n\nUser: ' + text }] })
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
  const out = data && Array.isArray(data.content) ? data.content.filter(c => c.type === 'text').map(c => c.text).join('') : '';
  if (!out) return json({ ok: false, error: 'The System got an empty reply.' }, 502, cors);
  return json({ ok: true, text: out, model: data.model || env.MODEL || DEFAULT_MODEL }, 200, cors);
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
      body: JSON.stringify(Object.assign({ model: opts.model || env.MODEL || DEFAULT_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }, opts.tools ? { tools: opts.tools } : { temperature: 0 }))
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
    return json({ ok: false, error: opts.tools && /web.?search/i.test(msg) ? 'Web search is switched off for your Anthropic account. Turn it on at platform.claude.com → Settings → Privacy/Capabilities, then try again.' : msg }, 502, cors);
  }
  let blocks = data && Array.isArray(data.content) ? data.content : [];
  if (opts.afterSearch) { let last = -1; blocks.forEach((b, i) => { if (b.type === 'web_search_tool_result') last = i; }); blocks = blocks.slice(last + 1); }
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const c = corsHeaders(origin, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
    if (origin && !c.ok) return json({ ok: false, error: 'Origin not allowed.' }, 403, c.headers);
    if (url.pathname === '/health' || url.pathname === '/') {
      return json({ ok: true, app: 'winter-arc', version: 4, food: true, ai: !!env.ANTHROPIC_API_KEY, kv: !!env.SYNC, auth: !!env.APP_KEY, model: env.MODEL || DEFAULT_MODEL }, 200, c.headers);
    }
    if (!env.APP_KEY) return json({ ok: false, error: 'APP_KEY is not set on the worker.' }, 500, c.headers);
    const ip = ipOf(req);
    if (await lockedOut(env, ip)) return json({ ok: false, locked: true, error: 'Too many wrong app keys from this connection. It is locked for 15 minutes; then try again with the right key.' }, 429, c.headers);
    if (!safeEqual(req.headers.get('X-App-Key'), env.APP_KEY)) { const locked = await noteWrongKey(env, ip); return json({ ok: false, locked, error: locked ? 'Too many wrong app keys. This connection is locked for 15 minutes.' : 'Wrong app key.' }, locked ? 429 : 401, c.headers); }
    FAILS.delete(ip); // the right key clears the count of earlier slips
    try {
      if (url.pathname === '/parse' && req.method === 'POST') return await handleParse(req, env, c.headers);
      if (url.pathname === '/sync' && (req.method === 'GET' || req.method === 'PUT')) return await handleSync(req, env, c.headers, url);
      if ((url.pathname === '/sync/versions' || url.pathname === '/sync/version') && req.method === 'GET') return await handleVersions(req, env, c.headers, url);
      if (url.pathname === '/scan' && req.method === 'POST') return await handleScan(req, env, c.headers);
      if (url.pathname === '/food/search' && req.method === 'GET') return await handleFoodSearch(url, c.headers);
      if (url.pathname.indexOf('/food/barcode/') === 0 && req.method === 'GET') return await handleBarcode(url.pathname.split('/').pop(), c.headers);
      if (url.pathname === '/food/label' && req.method === 'POST') return await handleLabel(req, env, c.headers);
      if (url.pathname === '/food/web' && req.method === 'POST') return await handleWeb(req, env, c.headers);
      if ((url.pathname === '/inbox' && (req.method === 'GET' || req.method === 'POST')) || (url.pathname === '/inbox/ack' && req.method === 'POST')) return await handleInbox(req, env, c.headers, url.pathname);
      return json({ ok: false, error: 'Not found.' }, 404, c.headers);
    } catch (e) {
      return json({ ok: false, error: 'Worker error: ' + (e && e.message || e) }, 500, c.headers);
    }
  }
};
