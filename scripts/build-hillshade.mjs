#!/usr/bin/env node
// 지형 음영 이미지 만들기 (의존성 없음)
//
//   node scripts/build-hillshade.mjs <타일 폴더> [배율=0.75]
//       Terrain Tiles(terrarium PNG) z7, x 104~111, y 44~51 (파일 이름 7-<x>-<y>.png) 64장을 이어 붙여
//       언덕 음영(빛: 북서 315°, 높이 45°)을 계산하고, 바탕 지도 범위(경도 115~135°, 위도 32~48°)로 잘라
//       data/hillshade.png (회색+알파) 로 쓴다. 그림자는 검정, 햇빛 면은 흰색이고 진하기는 알파로 나타낸다.
//       바다(고도 0 이하)는 투명하다. 앱은 이 이미지를 메르카토르 세계 좌표 그대로 펴서 육지 모양으로 잘라 그린다.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'hillshade.png');
const [, , TILES, SCALE = '0.75'] = process.argv;
if (!TILES) { console.error('사용법: node scripts/build-hillshade.mjs <타일 폴더> [배율]'); process.exit(1); }

const BBOX = [115, 32, 135, 48];
const Z = 7, X0 = 104, Y0 = 44, N = 8, T = 256, W = N * T, WORLD = T * 2 ** Z;
const EXAG = 3; // 고도 과장(이 축척에서 산줄기가 보이도록)
const MAX_ELEV = 3100; // 튀는 값 자르기(이 범위 최고봉은 오대산 약 3,060m, 백두산 2,744m)
const SHADOW = 0.62, LIGHT = 0.42; // 그림자·햇빛 면의 최대 진하기

// ---------- PNG 읽기·쓰기 (8비트, 비월주사 없음) ----------
function readPng(buf) {
  let p = 8, w, h, ct; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12]) throw new Error('지원하지 않는 PNG'); }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[ct]; if (!bpp) throw new Error('지원하지 않는 색 형식 ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = up ? up[i] : 0, c = up && i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[i] = v & 255;
    }
  }
  return { w, h, bpp, px };
}
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(b) { let c = 0xffffffff; for (const v of b) c = CRC[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function writeGrayAlpha(w, h, data) { // data: w*h*2 (회색, 알파). 줄마다 Up 필터
  const stride = w * 2, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 2;
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = (data[y * stride + i] - (y ? data[(y - 1) * stride + i] : 0)) & 255;
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 4;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 고도 ----------
const elev = new Float32Array(W * W);
for (let tx = 0; tx < N; tx++) for (let ty = 0; ty < N; ty++) {
  const f = path.join(TILES, `${Z}-${X0 + tx}-${Y0 + ty}.png`);
  const { w, bpp, px } = readPng(fs.readFileSync(f));
  if (w !== T) throw new Error(f + ': 256×256 이 아님');
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const i = (y * T + x) * bpp;
    elev[(ty * T + y) * W + tx * T + x] = Math.min(MAX_ELEV, px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768);
  }
}

// ---------- 언덕 음영: -1(가장 어두움) ~ 0(평지) ~ 1(가장 밝음), 바다는 NaN ----------
const AZ = (315 * Math.PI) / 180, ALT = (45 * Math.PI) / 180, FLAT = Math.sin(ALT);
const at = (x, y) => Math.max(0, elev[Math.min(W - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]);
const shade = new Float32Array(W * W);
for (let y = 0; y < W; y++) {
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (Y0 * T + y + 0.5)) / WORLD)));
  const cell = ((2 * Math.PI * 6378137) / WORLD) * Math.cos(lat); // 화소 한 칸의 땅 위 길이(m)
  for (let x = 0; x < W; x++) {
    if (elev[y * W + x] <= 0) { shade[y * W + x] = NaN; continue; }
    const dx = ((at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))) / (8 * cell) * EXAG;
    const dy = ((at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))) / (8 * cell) * EXAG;
    const slope = Math.atan(Math.hypot(dx, dy)), aspect = Math.atan2(dy, -dx);
    const s = Math.max(0, Math.sin(ALT) * Math.cos(slope) + Math.cos(ALT) * Math.sin(slope) * Math.cos(AZ - Math.PI / 2 - aspect));
    shade[y * W + x] = s < FLAT ? -(FLAT - s) / FLAT : (s - FLAT) / (1 - FLAT);
  }
}

// ---------- 바탕 지도 범위로 자르고 줄이기 ----------
const gx = (lon) => ((lon + 180) / 360) * WORLD - X0 * T;
const gy = (lat) => ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * WORLD - Y0 * T;
const sx0 = gx(BBOX[0]), sx1 = gx(BBOX[2]), sy0 = gy(BBOX[3]), sy1 = gy(BBOX[1]);
const k = Number(SCALE);
const ow = Math.round((sx1 - sx0) * k), oh = Math.round((sy1 - sy0) * k);
const out = Buffer.alloc(ow * oh * 2);
for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
  // 출력 화소가 덮는 원본 칸을 평균(바다 칸은 0으로 셈하고 바다 비율만큼 옅게)
  const ax = sx0 + x / k, bx = sx0 + (x + 1) / k, ay = sy0 + y / k, by = sy0 + (y + 1) / k;
  let sum = 0, n = 0, land = 0;
  for (let yy = Math.floor(ay); yy < Math.ceil(by); yy++) for (let xx = Math.floor(ax); xx < Math.ceil(bx); xx++) {
    const v = shade[Math.min(W - 1, yy) * W + Math.min(W - 1, xx)]; n++;
    if (!Number.isNaN(v)) { sum += v; land++; }
  }
  const v = land ? sum / n : 0, o = (y * ow + x) * 2;
  out[o] = v > 0 ? 255 : 0;
  out[o + 1] = Math.min(255, Math.round((Math.abs(v) * (v > 0 ? LIGHT : SHADOW) * 255) / 4) * 4); // 4단계씩 묶어 압축을 돕는다
}
fs.writeFileSync(OUT, writeGrayAlpha(ow, oh, out));
console.log(`data/hillshade.png ${ow}×${oh}, ${(fs.statSync(OUT).size / 1024).toFixed(0)}KB`);
