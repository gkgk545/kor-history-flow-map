#!/usr/bin/env node
// 상호작용 검사: 시스템 Chrome 헤드리스를 DevTools 프로토콜로 조작해 file://로 연 앱을 확인한다 (의존성 없음)
//   node scripts/interact-check.mjs
//   CHROME=/path/to/chrome node scripts/interact-check.mjs
// 실패가 하나라도 있으면 종료 코드 1.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('Chrome을 찾지 못했습니다. CHROME 환경 변수로 경로를 알려 주세요.'); process.exit(1); }

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(read('js/model.js'), ctx);
const Model = ctx.Model;
const content = JSON.parse(read('data/content.json'));
const snapKeys = content.snapshots.map((s) => s.key);
const keyLabel = (k) => Model.keyLabel(k);

const BASE = 'file://' + path.join(ROOT, 'index.html');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-check-'));
const chrome = spawn(CHROME, [
  '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--allow-file-access-from-files', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error('Chrome DevTools 주소를 받지 못함')), 15000);
});
const port = new URL(wsUrl).port;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value).join(' '));
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate 실패');
  return r.result?.result?.value;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function size(w, h) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); }
async function open(q) {
  await send('Page.navigate', { url: BASE + (q ? '?' + q : '') });
  await wait(700);
}
await send('Runtime.enable');
await send('Page.enable');

const results = [];
async function check(name, fn) {
  try {
    const r = await fn();
    results.push({ name, ok: r === true, detail: r === true ? '' : JSON.stringify(r) });
  } catch (e) { results.push({ name, ok: false, detail: e.message }); }
}
// 페이지 안에서 쓰는 도구
const H = `
  const $ = (id) => document.getElementById(id);
  const time = () => $('top-time').textContent;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : k, bubbles: true }));
  const tapAt = async (el, x, y) => { const o = { clientX: x, clientY: y, pointerId: 7, bubbles: true, pointerType: 'touch' };
    el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', o)); await sleep(150); };
  const center = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
`;

await size(1366, 768);
await open('');
await check('첫 화면이 기원전 400년', () => ev(`${H} return time() === '기원전 400년' || time();`));
await check('안내 문구·면책 문구 보임', () => ev(`${H} return !$('hint').hidden && $('map-disclaimer').offsetHeight > 0;`));
await check(`→로 ${snapKeys.length}장 차례 이동`, () => ev(`${H}
  const seen = [time()];
  for (let i = 1; i < ${snapKeys.length}; i++) { key('ArrowRight'); await sleep(40); seen.push(time()); }
  const want = ${JSON.stringify(snapKeys.map(keyLabel))};
  return JSON.stringify(seen) === JSON.stringify(want) || seen.filter((s, i) => s !== want[i]);`));
await check('←로 이전 장면', () => ev(`${H} key('ArrowLeft'); await sleep(40); return time() === ${JSON.stringify(keyLabel(snapKeys.at(-2)))} || time();`));
await check('URL ?year= 갱신', async () => { await wait(400); return ev(`return location.search === '?year=1953-07' || location.search;`); });
await check('localStorage 저장과 복원', async () => { await open(''); return ev(`${H} return time() === '1953년 7월' || time();`); });
await check('슬라이더: 1950년을 누르면 그해 첫 장면(1950년 6월)', () => ev(`${H}
  const sc = Model.makeScale(ATLAS.eras, Model.yearT(Model.MIN_YEAR), Model.yearT(Model.MAX_YEAR, 12));
  const f = (sc.yearToFrac(1950) + sc.yearToFrac(1951)) / 2;
  const r = $('track').getBoundingClientRect();
  $('track').dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + f * r.width, clientY: r.top + 10, pointerId: 3, bubbles: true }));
  $('track').dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + f * r.width, clientY: r.top + 10, pointerId: 3, bubbles: true }));
  return time() === '1950년 6월' || time();`));
await check('같은 해 다음 장면(1950년 7월)', () => ev(`${H} $('next').click(); return time() === '1950년 7월' || time();`));
await check('슬라이더 위치↔연도: 띠마다 양 끝', () => ev(`${H}
  const r = $('track').getBoundingClientRect(), out = [];
  for (const b of document.querySelectorAll('.band')) { const br = b.getBoundingClientRect();
    $('track').dispatchEvent(new PointerEvent('pointerdown', { clientX: br.left + 2, clientY: r.top + 10, pointerId: 3, bubbles: true }));
    $('track').dispatchEvent(new PointerEvent('pointerup', { clientX: br.left + 2, clientY: r.top + 10, pointerId: 3, bubbles: true }));
    out.push([b.title, $('top-era').textContent]); }
  const bad = out.filter(([a, b]) => a !== b); return !bad.length || bad;`));
await check('927년: 발해 숨김, 거란 보임', async () => { await open('year=927'); return ev(`${H}
  const names = [...document.querySelectorAll('.lg-item')].map((b) => b.dataset.name);
  return (!names.includes('발해') && names.includes('거란')) || names;`); });
await check('범례 누르면 강조·나라 소개', () => ev(`${H}
  document.querySelector('.lg-item').click(); await sleep(100);
  return (!$('polity-box').hidden && document.querySelector('#map g.polity.hl') !== null) || 'no';`));
await check('지도 누르면 툴팁', () => ev(`${H}
  $('polity-close').click();
  const p = document.querySelector('#map g.polity.korea path'); const b = p.getBBox(); const svg = $('map');
  const m = p.getScreenCTM(); const x = m.a * (b.x + b.width / 2) + m.e, y = m.d * (b.y + b.height / 2) + m.f;
  await tapAt(svg, x, y); return !$('tooltip').hidden || 'hidden';`));
await check('바로 앞 장면 경계 끄기', () => ev(`${H} $('prev-toggle').click(); return document.querySelector('#map g.prev').style.display === 'none';`));
await check('기원전 400년: 고조선 논쟁 점선', async () => { await open('year=-400'); return ev(`return document.querySelectorAll('#map .edge.disputed[stroke-dasharray]').length > 0;`); });
await check('속도 버튼 4×', () => ev(`${H} $('speed').click(); $('speed').click(); return $('speed').textContent === '4×' || $('speed').textContent;`));
await check('Space로 재생/정지', () => ev(`${H} key(' '); await sleep(300); const a = $('play').getAttribute('aria-label'); key(' '); await sleep(50); return (a === '정지' && $('play').getAttribute('aria-label') === '재생') || a;`));
await check('4배속으로 끝까지 재생(1900년부터)', async () => {
  await open('year=1900');
  return ev(`${H} $('speed').click(); $('speed').click(); $('play').click();
    for (let i = 0; i < 120 && $('play').getAttribute('aria-label') === '정지'; i++) await sleep(250);
    return time() === '2026년' || time();`);
});
await check('딥링크 ?year=475', async () => { await open('year=475'); return ev(`${H} return time() === '475년' || time();`); });
await check('딥링크 ?year=1948-05 → 미군정', async () => { await open('year=1948-05'); return ev(`${H}
  return (time() === '1948년 5월' && [...document.querySelectorAll('.lg-item')].some((b) => b.dataset.name === '미군정')) || time();`); });
await check('딥링크 ?year=-108 → 기원전 108년, 고조선', async () => { await open('year=-108'); return ev(`${H}
  const names = [...document.querySelectorAll('.lg-item')].map((b) => b.dataset.name);
  return (time() === '기원전 108년' && names.includes('고조선') && $('panel-period').textContent.startsWith('기원전 194년')) || [time(), names];`); });
await check('기원전 사건 연도 표시', () => ev(`return [...document.querySelectorAll('.ev-year')].map((e) => e.textContent).includes('기원전 108') || 'no';`));
await check('기원전 107년~312년: 대동강 유역에 나라 면 없음', async () => {
  for (const y of [-107, 1, 200, 312]) {
    await open('year=' + y);
    const r = await ev(`${H}
      const [x, yy] = MapView.project([125.75, 39.03]); const g = $('viewport').getScreenCTM();
      const el = document.elementFromPoint(g.a * x + g.e, g.d * yy + g.f);
      return !(el && el.__feature) || el.__feature.properties.name;`);
    if (r !== true) return [y, r];
  }
  return true;
});
await check('1900년: 간도는 빗금 영역(영토 색 아님)', async () => { await open('year=1900'); return ev(`
  const g = document.querySelector('#map g.polity.zone');
  return (!!g && /url\\(#zone-/.test(g.querySelector('path').getAttribute('fill')) && !!document.querySelector('.swatch.zone')) || 'no';`); });
await check('패널 접기', () => ev(`${H} $('panel-toggle').click(); await sleep(350); return $('app').classList.contains('panel-closed');`));
await check('지도 확대', () => ev(`${H} const a = $('viewport').getAttribute('transform'); $('zoom-in').click(); return a !== $('viewport').getAttribute('transform');`));

// 도읍·전투 점
await check('점 층은 기본으로 꺼짐', async () => { await open('year=612'); return ev(`${H} return (!$('points-toggle').checked && !document.querySelector('#map .pt')) || 'on';`); });
await check('612년 점 켜기 → 그해 점만(살수 대첩)', () => ev(`${H}
  $('points-toggle').click(); await sleep(100);
  const names = [...document.querySelectorAll('#map .pt .hit')].map((h) => h.__point.properties.name);
  return (names.includes('살수 대첩') && names.includes('평양성') && !names.includes('안시성 전투')) || names;`));
await check('점 탭 → 설명 툴팁, 터치 영역 48px', () => ev(`${H}
  const hit = [...document.querySelectorAll('#map .pt .hit')].find((h) => h.__point.properties.name === '살수 대첩');
  const r = hit.getBoundingClientRect(); const [x, y] = center(hit);
  await tapAt($('map'), x, y);
  return (Math.round(r.width) >= 48 && $('tooltip').textContent.includes('을지문덕')) || [r.width, $('tooltip').textContent];`));
await check('다음 장면으로 가면 점이 바뀜(676년 기벌포)', () => ev(`${H}
  $('next').click(); await sleep(100);
  const names = [...document.querySelectorAll('#map .pt .hit')].map((h) => h.__point.properties.name);
  return (names.includes('기벌포 전투') && !names.includes('살수 대첩')) || names;`));
await check('논쟁 위치 점은 점선 테두리(645년 안시성)', async () => { await open('year=645'); return ev(`${H}
  $('points-toggle').click(); await sleep(100);
  return !!document.querySelector('#map .pt.disputed [stroke-dasharray]') || 'no';`); });

// 수준
await check('초등: 수준 표시 없음', async () => { await open('year=375'); return ev(`${H} return $('level-badge').hidden && !document.title.includes('중학교');`); });
await check('?level=middle: 중학교 표시와 중등 글', async () => {
  await open('level=middle&year=375');
  const cap = content.snapshots.find((s) => s.key === '375').middle.caption;
  return ev(`${H} return (!$('level-badge').hidden && document.title.includes('중학교') && $('panel-caption').textContent === ${JSON.stringify(cap)}) || $('panel-caption').textContent;`);
});
await check('중등: 나라 소개·패널 안내도 중등 문구', () => ev(`${H}
  document.querySelector('.lg-item').click(); await sleep(50);
  return ($('polity-intro').textContent === ATLAS.polities[$('polity-name').textContent].intro.middle && $('panel-disclaimer').textContent.includes('다를 수 있습니다')) || 'no';`));
await check('중등: 딥링크 갱신 때 level 유지', async () => { await ev(`${H} $('next').click();`); await wait(450); return ev(`return location.search === '?level=middle&year=475' || location.search;`); });
await check('직전 시점은 수준마다 따로 기억', async () => {
  await open('level=middle');
  const a = await ev(`${H} return time();`);
  await open('');
  const b = await ev(`${H} return time();`);
  return (a === '475년' && b !== '475년') || [a, b];
});
await check('중등 기원전 딥링크 ?level=middle&year=-108', async () => { await open('level=middle&year=-108'); return ev(`${H}
  return (time() === '기원전 108년' && $('panel-caption').textContent === ${JSON.stringify(content.snapshots.find((s) => s.key === '-194').middle.caption)}) || time();`); });

// 화면 크기
await check('1024×768: 시대 띠 10개 모두 48px 이상, 눈금 겹침 없음', async () => {
  await size(1024, 768); await open('year=1950-08');
  return ev(`
    const bands = [...document.querySelectorAll('.band')].map((b) => b.getBoundingClientRect().width);
    const ax = [...document.querySelectorAll('#axis span')].map((s) => s.getBoundingClientRect()).sort((a, b) => a.left - b.left);
    const overlap = ax.some((r, i) => i && r.left < ax[i - 1].right);
    return (bands.length === 10 && bands.every((w) => w >= 48) && !overlap) || { bands, overlap };`);
});
await check('1366×768: 기원전·기원후 경계 눈금(1)', async () => { await size(1366, 768); await open(''); return ev(`return [...document.querySelectorAll('#axis span')].some((s) => s.textContent === '1') || 'no';`); });
for (const [w, h] of [[1920, 1080], [1366, 768], [1180, 820], [1024, 768]]) {
  await check(`${w}×${h}: 보이는 조작 요소 모두 48px 이상`, async () => {
    await size(w, h); await open('level=middle&year=1950-08');
    return ev(`
      const els = [...document.querySelectorAll('button, [role=slider], summary, input[type=checkbox]')].filter((e) => e.offsetParent && getComputedStyle(e).visibility !== 'hidden');
      const small = els.map((e) => { const r = (e.type === 'checkbox' ? e.closest('label') : e).getBoundingClientRect(); return [e.id || e.className || e.textContent.slice(0, 8), Math.round(r.width), Math.round(r.height)]; })
        .filter(([, a, b]) => a < 48 || b < 48);
      return !small.length || small;`);
  });
}
await check('JS 오류 없음', () => (errors.length ? errors.slice(0, 5) : true));

ws.close();
await new Promise((r) => { chrome.once('exit', r); chrome.kill(); setTimeout(r, 3000); });
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* 임시 폴더는 남아도 됨 */ }
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '  — ' + r.detail}`);
}
console.log(failed ? `\n실패 ${failed}건 / ${results.length}항목` : `\n모든 상호작용 검사 통과 (${results.length}항목)`);
process.exit(failed ? 1 : 0);
