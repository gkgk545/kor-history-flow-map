#!/usr/bin/env node
// 시스템 Chrome 헤드리스로 검토용 스크린샷을 review/ 에 만든다 (의존성 없음)
//   node scripts/screenshots.mjs                      해상도별 레이아웃(초등·중등) + 스냅샷별 지도(초등)
//   node scripts/screenshots.mjs layout [middle]      레이아웃만 (수준을 주면 그 수준만)
//   node scripts/screenshots.mjs snapshots [middle]   스냅샷만 (middle이면 snap-<키>-middle.png)
//   CHROME=/path/to/chrome node scripts/screenshots.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'review');
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('Chrome을 찾지 못했습니다. CHROME 환경 변수로 경로를 알려 주세요.'); process.exit(1); }

const url = (q) => 'file://' + path.join(ROOT, 'index.html') + (q ? '?' + q : '');
function shot(file, w, h, q) {
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=1', `--window-size=${w},${h}`, '--virtual-time-budget=4000',
    `--screenshot=${path.join(OUT, file)}`, url(q),
  ], { stdio: 'ignore' });
  console.log('review/' + file);
}

fs.mkdirSync(OUT, { recursive: true });
const only = process.argv[2];
const levelArg = process.argv[3];
const q = (lv, rest) => (lv === 'middle' ? 'level=middle&' : '') + rest;
const sfx = (lv) => (lv === 'middle' ? '-middle' : '');
if (!only || only === 'layout') {
  for (const lv of levelArg ? [levelArg] : ['elementary', 'middle']) {
    for (const [w, h] of [[1920, 1080], [1366, 768], [1180, 820], [1024, 768]]) {
      shot(`layout-${w}x${h}${sfx(lv)}.png`, w, h, lv === 'middle' ? 'level=middle&year=-400' : '');
      shot(`layout-${w}x${h}-1950-08${sfx(lv)}.png`, w, h, q(lv, 'year=1950-08'));
    }
  }
}
if (!only || only === 'snapshots') {
  const content = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/content.json'), 'utf8'));
  const lv = levelArg || 'elementary';
  for (const s of content.snapshots) shot(`snap-${s.key.replace(/^-/, 'm')}${sfx(lv)}.png`, 1920, 1080, q(lv, 'year=' + s.key));
}
