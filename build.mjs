// Builds the two shippable pages from src/. Run:  node build.mjs
//   index.html              the app for GitHub Pages (phone Home Screen and laptop browser)
//   hosted/winter-arc.html  the same app for hosting inside Claude (no GitHub, no Cloudflare)
import fs from 'fs';
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
const wanted = [...CORE.DUEL_ART.flatMap(n => ['b/' + nn(n), 'w/' + nn(n)]), ...CORE.HEROES.flatMap((_, i) => ['h/' + nn(i + 1), 'p/' + nn(i + 1)]), ...CORE.AURA.map((_, i) => 'a/' + nn(i + 1))];
const art = {};
for (const w of wanted) {
  const file = path.join(ROOT, 'art400', w + '.webp');
  if (!fs.existsSync(file)) throw new Error('Missing picture art400/' + w + '.webp');
  art['art/' + w + '.webp'] = 'data:image/webp;base64,' + fs.readFileSync(file).toString('base64');
}
const counts = ['b', 'w', 'h', 'p', 'a'].map(d => Object.keys(art).filter(k => k.indexOf('art/' + d + '/') === 0).length);
if (counts.join() !== [CORE.DUELS.length, CORE.DUELS.length, 11, 11, 85].join() || CORE.AURA.length !== 85) throw new Error('Pictures do not match the boss, hero and character lists: ' + counts.join());

const safe = js => js.replace(/<\/script/gi, '<\\/script'); // nothing inside a file may close the script block early
const file = (label, body) => '<script>/* ' + label + ' */\n' + safe(body).replace(/\n*$/, '\n') + '\n</script>';
const tpl = rd('src/index.src.html');
const css = rd('src/styles.css').replace(/\n*$/, '\n');
const artTag = '<script>window.RTL_ART=' + safe(JSON.stringify(art)) + ';</script>';
function fill(html, extraCss, extraFiles) {
  // function replacements throughout: the code contains "$" sequences that a plain string replacement would mangle
  html = html.replace('<style>/*STYLES*/</style>', () => '<style>\n' + css + (extraCss || '') + '</style>');
  html = html.replace('<script>/*ART*/</script>', () => artTag);
  html = html.replace(/<script>\/\*FILE ([^*]+)\*\/<\/script>/g, (m, f) => (f === 'src/app.js' ? (extraFiles || '') : '') + file(f, rd(f)));
  if (/\/\*(STYLES|ART|FILE)/.test(html.replace(/<script>[\s\S]*?<\/script>/g, ''))) throw new Error('A placeholder was left unfilled');
  return html;
}

// 1. the normal app
const page = fill(tpl).replace(/\s*$/, '\n') + END + '\n';
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
const hosted = fill(h, hostedCss, workerTag + file('src/hosted.js', rd('src/hosted.js')) + '\n');
fs.mkdirSync(path.join(ROOT, 'hosted'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'hosted', 'winter-arc.html'), hosted.replace(/\s*$/, '\n'));

const kb = f => Math.round(fs.statSync(path.join(ROOT, f)).size / 1024);
console.log('index.html ' + kb('index.html') + ' KB · hosted/winter-arc.html ' + kb('hosted/winter-arc.html') + ' KB · ' + Object.keys(art).length + ' pictures');
