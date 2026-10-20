// Builds the two shippable pages from src/. Run:  node build.mjs
//   index.html              the app for GitHub Pages (phone Home Screen and laptop browser)
//   hosted/winter-arc.html  the same app for hosting inside Claude (no GitHub, no Cloudflare)
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const END = '<!--winter-arc:end-->'; // sw.js only stores a page that ends with this (proof the whole file arrived)

// every picture is carried inside the page, keyed the way app.js asks for it: art/<b|w|h|p|a>/<nn>.webp
// Only the pictures the app uses go in: the bosses still on the list (their numbers come from core.js), the 11 heroes
// and the 85 daily aura characters (Pavi's own art, numbered as in his list).
const require = createRequire(import.meta.url);
const CORE = require(path.join(ROOT, 'src', 'core.js'));
const nn = n => String(n).padStart(2, '0');
const wanted = [...CORE.DUEL_ART.flatMap(n => ['b/' + nn(n), 'w/' + nn(n)]), ...CORE.HEROES.flatMap((_, i) => ['h/' + nn(i + 1), 'p/' + nn(i + 1)]), ...CORE.AURA.map((_, i) => 'a/' + nn(i + 1)), 'x/luck', 'x/sae', 'x/natsu'];  // x/sae, x/natsu: the two cards in the opening  // x/luck: Pavi's own gold LUCK puzzle piece (Daily Clear)
// v17: the GitHub app keeps its pictures as separate files in art/ (the page opens twice as fast and uses a quarter of
// the memory; the phone stores each picture once it has it). Each address carries a fingerprint of the picture, so a
// changed picture is fetched again and an unchanged one never is. The Claude-hosted page still carries them inside.
const art = {}, artFiles = {}; let hdCount = 0, thumbCount = 0;
fs.rmSync(path.join(ROOT, 'art'), { recursive: true, force: true });
for (const w of wanted) {
  const file = path.join(ROOT, 'art400', w + '.webp');
  if (!fs.existsSync(file)) throw new Error('Missing picture art400/' + w + '.webp');
  // v18: the app on GitHub uses the AI-upscaled, twice-as-sharp version from art_hd/ where there is one; the page that
  // lives inside Claude keeps the original size (it has to fit in one file)
  const hd = path.join(ROOT, 'art_hd', w + '.webp'), buf = fs.readFileSync(file), hbuf = fs.existsSync(hd) ? fs.readFileSync(hd) : buf, out = path.join(ROOT, 'art', w + '.webp');
  if (hbuf !== buf) hdCount++;
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, hbuf);
  artFiles['art/' + w + '.webp'] = 'art/' + w + '.webp?v=' + crypto.createHash('sha256').update(hbuf).digest('hex').slice(0, 10);
  art['art/' + w + '.webp'] = 'data:image/webp;base64,' + buf.toString('base64');
  // V17PRO: a grid-sized copy (art_thumb/, sharp on a 3x iPhone) for the boss, weapon and hero tiles, so the Bosses and
  // Armoury tabs open without decoding dozens of full-size pictures; the big views and sheets still use the full one
  const th = path.join(ROOT, 'art_thumb', w + '.webp');
  if (fs.existsSync(th)) { const tbuf = fs.readFileSync(th), tout = path.join(ROOT, 'art', 't', w + '.webp'); fs.mkdirSync(path.dirname(tout), { recursive: true }); fs.writeFileSync(tout, tbuf); thumbCount++;
    artFiles['art/t/' + w + '.webp'] = 'art/t/' + w + '.webp?v=' + crypto.createHash('sha256').update(tbuf).digest('hex').slice(0, 10); }
}
const counts = ['b', 'w', 'h', 'p', 'a'].map(d => Object.keys(art).filter(k => k.indexOf('art/' + d + '/') === 0).length);
if (counts.join() !== [CORE.DUELS.length, CORE.DUELS.length, 11, 11, 85].join() || CORE.AURA.length !== 85) throw new Error('Pictures do not match the boss, hero and character lists: ' + counts.join());

// V17PRO / Ascend: built-in foods. data/chains/*.txt are the chains' own published figures (one file per chain, with its
// source and date); data/generic-usda.json is ~7,200 generic foods per 100g. The chains go inside the page; the generic list is
// its own file (foods.json) that the app fetches once and keeps offline. The Claude-hosted page carries both inside.
const chains = fs.readdirSync(path.join(ROOT, 'data', 'chains')).filter(f => f.endsWith('.txt')).sort().map(f => {
  const txt = rd('data/chains/' + f), meta = {}, rows = [];
  txt.split('\n').forEach(line => {
    const m = /^#\s*(chain|source|date):\s*(.+)$/.exec(line); if (m) { meta[m[1]] = m[2].trim(); return; }
    if (!line.trim() || line[0] === '#') return;
    const c = line.split('|').map(x => x.trim()); if (c.length !== 8) throw new Error(f + ': bad row: ' + line);
    const n = v => v === 'na' || v === '' ? null : Number(v);
    const r = [c[0], n(c[1]), n(c[2]), n(c[3]), n(c[4]), n(c[5]), n(c[6]), n(c[7])];
    if (!(r[2] >= 0) || [3, 4, 5, 6].some(i => !(r[i] >= 0))) throw new Error(f + ': missing numbers: ' + line);
    if (r[5] > r[4] + 0.05) throw new Error(f + ': sugar above carbs: ' + line);
    rows.push(r);
  });
  if (!meta.chain || !meta.source || !meta.date || !rows.length) throw new Error(f + ' needs # chain, # source and # date lines and some rows');
  return { chain: meta.chain, date: meta.date, source: meta.source, rows };
});
const generic = JSON.parse(rd('data/generic-usda.json'));
// Ascend: foods copied from MyFitnessPal's database (data/mfp/*.txt, one per line: name|brand|serving|grams|kcal|protein|carbs|sugar|fat|fibre|verified).
// User-added entries, so each is checked: the calories must match the macros, sugar can't be more than the carbs.
const mfp = [], mfpSeen = {};
for (const f of fs.readdirSync(path.join(ROOT, 'data', 'mfp')).filter(f => f.endsWith('.txt')).sort()) {
  rd('data/mfp/' + f).split('\n').forEach(line => {
    if (!line.trim() || line[0] === '#') return;
    const c = line.split('|').map(x => x.trim()); if (c.length !== 11) throw new Error('data/mfp/' + f + ': bad row: ' + line);
    const n = v => v === '' ? null : Number(v), [name, brand, label] = c, g = n(c[3]), kcal = n(c[4]), p = n(c[5]), cb = n(c[6]), f2 = n(c[8]);
    let s = n(c[7]), fib = n(c[9]);
    if (!name || !(kcal > 0) || [p, cb, f2].some(v => !(v >= 0))) throw new Error('data/mfp/' + f + ': missing numbers: ' + line);
    if (Math.abs(4 * p + 4 * cb + 9 * f2 - kcal) > Math.max(25, kcal * 0.22)) throw new Error('data/mfp/' + f + ': calories do not match the macros: ' + line);
    if (s == null) s = 0; s = Math.min(s, cb); if (fib == null) fib = 0;
    const key = (name + '|' + brand + '|' + label).toLowerCase(); if (mfpSeen[key]) return; mfpSeen[key] = 1;
    mfp.push([name, brand, label || '1 serving', g && g > 0 ? g : null, Math.round(kcal), p, cb, s, f2, fib]);
  });
}
const foodsData = { g: generic.rows, m: mfp };
fs.writeFileSync(path.join(ROOT, 'foods.json'), JSON.stringify(foodsData));
const foodsVer = crypto.createHash('sha256').update(JSON.stringify(foodsData)).digest('hex').slice(0, 10);
const chainsTag = '<script>window.RTL_CHAINS=' + JSON.stringify(chains.map(c => ({ chain: c.chain, date: c.date, rows: c.rows }))).replace(/<\/script/gi, '<\\/script') + ';window.RTL_FOODS_URL="foods.json?v=' + foodsVer + '";</script>';
const safe = js => js.replace(/<\/script/gi, '<\\/script'); // nothing inside a file may close the script block early
const file = (label, body) => '<script>/* ' + label + ' */\n' + safe(body).replace(/\n*$/, '\n') + '\n</script>';
const tpl = rd('src/index.src.html');
const css = rd('src/styles.css').replace(/\n*$/, '\n');
function fill(html, extraCss, extraFiles, artMap) {
  const artTag = '<script>window.RTL_ART=' + safe(JSON.stringify(artMap)) + ';</script>';
  // function replacements throughout: the code contains "$" sequences that a plain string replacement would mangle
  html = html.replace('<style>/*STYLES*/</style>', () => '<style>\n' + css + (extraCss || '') + '</style>');
  html = html.replace('<script>/*ART*/</script>', () => artTag + chainsTag);
  // the self-tests (Settings → Diagnostics) are carried as text and only compiled when you run them: the app opens faster
  html = html.replace(/<script>\/\*FILE ([^*]+)\*\/<\/script>/g, (m, f) => (f === 'src/app.js' ? (extraFiles || '') : '') + (f === 'src/tests.js' ? '<script type="text/plain" id="tests-src">\n' + safe(rd(f)) + '\n</script>' : file(f, rd(f))));
  if (/\/\*(STYLES|ART|FILE)/.test(html.replace(/<script>[\s\S]*?<\/script>/g, ''))) throw new Error('A placeholder was left unfilled');
  return html;
}

// 1. the normal app
// the two opening cards are asked for straight away, so they are there by the time the cards flip face up
const preload = ['art/x/sae.webp', 'art/x/natsu.webp'].map(k => '<link rel="preload" as="image" href="' + artFiles[k] + '">').join('\n');
const page = fill(tpl.replace('<link rel="apple-touch-icon" href="apple-touch-icon.png">', m => m + '\n' + preload), '', '', artFiles).replace(/\s*$/, '\n') + END + '\n';
fs.writeFileSync(path.join(ROOT, 'index.html'), page);

// 2. the Claude-hosted app: the Worker runs inside the page, Claude supplies the AI and the storage
const worker = rd('worker/worker.js').replace(/^export default \{/m, 'var __worker = {').replace(/^export (const|function|async function) /gm, '$1 ');
if (/^export /m.test(worker)) throw new Error('worker.js still has an export the hosted build cannot carry');
const workerTag = '<script>/* worker/worker.js, run in the page */\nwindow.WA_WORKER = (function (fetch) {\n' + safe(worker).replace(/\n*$/, '\n') +
  '\nreturn __worker;\n})(function (u, i) { return window.WA_upstream(u, i); });\n</script>\n';
const hostedCss = '\n/* hosted in Claude: one deliberate dark look; the app handles the phone safe areas itself */\n:root{color-scheme:dark;padding:0!important}\n' +
  '/* no camera, web lookup or food database from inside Claude */\n[data-act="scan-barcode"],[data-act="web-food"],[data-act="ci-web"]{display:none!important}\n';
let h = tpl;
h = h.slice(h.indexOf('<title>'));                       // Claude supplies the outer page
h = h.replace(/<script>document\.documentElement\.className \+= ' js';<\/script>\n/, '');
h = h.replace(/<link rel="(manifest|icon|apple-touch-icon)"[^>]*>\n/g, '').replace(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\n/, '');
h = h.replace(/<\/head>\n<body>\n/, '<script>window.WA_HOSTED = true; document.documentElement.className += " js";</script>\n\n');
h = h.replace(/<div id="nojs">[\s\S]*?<\/div>\n(?=<script>)/, '');
h = h.replace(/<\/body>\s*<\/html>\s*$/, '');
if (/id="nojs"|<body>|rel="manifest"/.test(h)) throw new Error('The hosted page still carries a part meant only for the normal app');
const genericTag = '<script>window.RTL_GENERIC=' + JSON.stringify(generic.rows).replace(/<\/script/gi, '<\\/script') + ';window.RTL_MFP=' + JSON.stringify(mfp).replace(/<\/script/gi, '<\\/script') + ';</script>\n';
const hosted = fill(h, hostedCss, genericTag + workerTag + file('src/hosted.js', rd('src/hosted.js')) + '\n', art);
fs.mkdirSync(path.join(ROOT, 'hosted'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'hosted', 'winter-arc.html'), hosted.replace(/\s*$/, '\n'));

const kb = f => Math.round(fs.statSync(path.join(ROOT, f)).size / 1024);
console.log('index.html ' + kb('index.html') + ' KB (+ ' + (Object.keys(artFiles).length - thumbCount) + ' pictures in art/, ' + hdCount + ' in high resolution, ' + thumbCount + ' grid-sized copies) · ' + chains.length + ' chains (' + chains.reduce((a, c) => a + c.rows.length, 0) + ' items) · foods.json ' + kb('foods.json') + ' KB (' + generic.rows.length + ' generic + ' + mfp.length + ' MyFitnessPal foods) · hosted/winter-arc.html ' + kb('hosted/winter-arc.html') + ' KB · ' + Object.keys(art).length + ' pictures');
