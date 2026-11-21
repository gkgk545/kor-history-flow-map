#!/usr/bin/env node
// 데이터 빌드 스크립트 (의존성 없음)
//
//   node scripts/build-data.mjs
//       data/*.geojson 과 data/content.json 을 읽어 data/data.js (window.ATLAS = …) 를 만든다.
//
//   node scripts/build-data.mjs --ne <Natural Earth 압축 해제 폴더>
//       Natural Earth 1:10m 원본(shp/dbf)에서 바탕 지도를 잘라 단순화한 뒤
//       data/base-land.geojson, data/base-rivers.geojson 을 다시 만들고, 이어서 data.js 도 만든다.
//       폴더 안에 ne_10m_land/ 와 ne_10m_rivers_lake_centerlines/ 가 있어야 한다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

// 바탕 지도 범위 (경도 115~135°, 위도 32~48°)
export const BBOX = [115, 32, 135, 48];

// 쓸 하천: Natural Earth 이름 → 한국어 이름
const RIVERS = {
  'Yalu': '압록강',
  'Tumen': '두만강',
  'Taedong': '대동강',
  'Han': '한강',
  'Namhan': '한강',
  'Naktong': '낙동강',
  'Nakdong': '낙동강',
  'Liao': '요하',
  'Songhua': '송화강',
  'Sungari': '송화강',
  'Di’er Songhua': '송화강',
};

// ---------- Shapefile / DBF 읽기 ----------

export function readShp(file) {
  const buf = fs.readFileSync(file);
  const shapes = [];
  let off = 100;
  while (off + 8 <= buf.length) {
    const lenWords = buf.readInt32BE(off + 4);
    const start = off + 8;
    const type = buf.readInt32LE(start);
    if (type === 3 || type === 5) {
      const numParts = buf.readInt32LE(start + 36);
      const numPoints = buf.readInt32LE(start + 40);
      const partsAt = start + 44;
      const ptsAt = partsAt + numParts * 4;
      const parts = [];
      for (let p = 0; p < numParts; p++) {
        const a = buf.readInt32LE(partsAt + p * 4);
        const b = p + 1 < numParts ? buf.readInt32LE(partsAt + (p + 1) * 4) : numPoints;
        const ring = [];
        for (let i = a; i < b; i++) {
          ring.push([buf.readDoubleLE(ptsAt + i * 16), buf.readDoubleLE(ptsAt + i * 16 + 8)]);
        }
        parts.push(ring);
      }
      shapes.push({ type, parts });
    } else {
      shapes.push({ type, parts: [] });
    }
    off = start + lenWords * 2;
  }
  return shapes;
}

export function readDbf(file) {
  const buf = fs.readFileSync(file);
  const n = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recLen = buf.readUInt16LE(10);
  const fields = [];
  for (let o = 32; buf[o] !== 0x0d; o += 32) {
    const name = buf.toString('latin1', o, o + 11).replace(/\0.*$/, '');
    const type = String.fromCharCode(buf[o + 11]);
    // 문자 필드는 길이가 255를 넘으면 다음 바이트까지 길이로 쓴다
    const len = type === 'C' ? buf[o + 16] + buf[o + 17] * 256 : buf[o + 16];
    fields.push({ name, len });
  }
  const rows = [];
  for (let r = 0; r < n; r++) {
    let o = headerLen + r * recLen + 1;
    const row = {};
    for (const f of fields) {
      row[f.name] = buf.toString('utf8', o, o + f.len).replace(/[\0\s]+$/, '').trim();
      o += f.len;
    }
    rows.push(row);
  }
  return rows;
}

// ---------- 기하 도구 ----------

function clipRingToBox(ring, [x0, y0, x1, y1]) {
  // Sutherland–Hodgman: 사각형 네 변으로 차례로 자른다.
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1,
  ];
  const cut = [
    (a, b) => { const t = (x0 - a[0]) / (b[0] - a[0]); return [x0, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (x1 - a[0]) / (b[0] - a[0]); return [x1, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (y0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y0]; },
    (a, b) => { const t = (y1 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y1]; },
  ];
  let out = ring.slice(0, -1);
  for (let e = 0; e < 4 && out.length; e++) {
    const inp = out;
    out = [];
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i];
      const prev = inp[(i + inp.length - 1) % inp.length];
      const cIn = edges[e](cur), pIn = edges[e](prev);
      if (cIn) {
        if (!pIn) out.push(cut[e](prev, cur));
        out.push(cur);
      } else if (pIn) {
        out.push(cut[e](prev, cur));
      }
    }
  }
  if (out.length < 3) return null;
  out.push(out[0]);
  return out;
}

function ringArea(r) {
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return a / 2;
}

function simplify(pts, tol) {
  // Douglas–Peucker
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const L = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      // 닫힌 고리처럼 양 끝점이 같으면 끝점까지의 거리로 잰다
      const d = L < 1e-12
        ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay)
        : Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / L;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const roundPts = (pts) => pts.map(([x, y]) => [r4(x), r4(y)]);

function inBox([x, y], [x0, y0, x1, y1]) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

// ---------- 바탕 지도 만들기 ----------

function buildBasemap(neDir) {
  const landDir = path.join(neDir, 'ne_10m_land');
  const rivDir = path.join(neDir, 'ne_10m_rivers_lake_centerlines');
  const landVer = fs.readFileSync(path.join(landDir, 'ne_10m_land.VERSION.txt'), 'utf8').trim();
  const rivVer = fs.readFileSync(path.join(rivDir, 'ne_10m_rivers_lake_centerlines.VERSION.txt'), 'utf8').trim();

  // 육지
  const polys = [];
  for (const s of readShp(path.join(landDir, 'ne_10m_land.shp'))) {
    for (const ring of s.parts) {
      const c = clipRingToBox(ring, BBOX);
      if (!c) continue;
      if (Math.abs(ringArea(c)) < 0.0006) continue; // 아주 작은 섬은 뺀다 (약 6㎢ 미만)
      let sRing = roundPts(simplify(c, 0.006));
      if (sRing.length < 4) continue;
      if (ringArea(sRing) < 0) sRing.reverse(); // RFC 7946: 바깥 고리는 반시계 방향
      polys.push([sRing]);
    }
  }
  const land = {
    type: 'FeatureCollection',
    source: `Natural Earth 1:10m Land v${landVer} (public domain)`,
    features: [{ type: 'Feature', properties: { kind: 'land' }, geometry: { type: 'MultiPolygon', coordinates: polys } }],
  };

  // 하천
  const rows = readDbf(path.join(rivDir, 'ne_10m_rivers_lake_centerlines.dbf'));
  const shapes = readShp(path.join(rivDir, 'ne_10m_rivers_lake_centerlines.shp'));
  const byName = new Map();
  shapes.forEach((s, i) => {
    const ko = RIVERS[rows[i].name] || RIVERS[rows[i].name_en];
    if (!ko) return;
    for (const part of s.parts) {
      // 범위 안의 연속 구간만 남긴다
      let seg = [];
      const flush = () => { if (seg.length > 1) push(seg); seg = []; };
      const push = (pts) => {
        if (!byName.has(ko)) byName.set(ko, []);
        byName.get(ko).push(roundPts(simplify(pts, 0.01)));
      };
      for (const p of part) {
        if (inBox(p, BBOX)) seg.push(p); else flush();
      }
      flush();
    }
  });
  const rivers = {
    type: 'FeatureCollection',
    source: `Natural Earth 1:10m Rivers + lake centerlines v${rivVer} (public domain)`,
    features: [...byName].map(([name, lines]) => ({
      type: 'Feature',
      properties: { kind: 'river', name },
      geometry: { type: 'MultiLineString', coordinates: lines },
    })),
  };

  fs.writeFileSync(path.join(DATA, 'base-land.geojson'), JSON.stringify(land));
  fs.writeFileSync(path.join(DATA, 'base-rivers.geojson'), JSON.stringify(rivers));
  const nPts = polys.reduce((n, p) => n + p[0].length, 0);
  console.log(`바탕 지도: 육지 고리 ${polys.length}개(꼭짓점 ${nPts}개), 하천 ${[...byName.keys()].join(', ')}`);
  const missing = [...new Set(Object.values(RIVERS))].filter((k) => !byName.has(k));
  if (missing.length) console.log(`Natural Earth에 없는 하천: ${missing.join(', ')}`);
}

// ---------- data.js 만들기 ----------

export function snapshotFiles() {
  return fs.readdirSync(DATA).filter((f) => /^s-\d{3,4}(-\d{2})?\.geojson$/.test(f)).sort();
}

export function keyOfFile(f) {
  return f.replace(/^s-/, '').replace(/\.geojson$/, '');
}

function buildDataJs() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  const content = read('content.json');
  const shapes = {};
  for (const f of snapshotFiles()) shapes[keyOfFile(f)] = read(f).features;
  const atlas = {
    land: read('base-land.geojson').features[0].geometry.coordinates,
    // Natural Earth 하천 + Natural Earth에 없는 하천을 지형 기준점으로 그린 도식선(rivers-schematic.geojson)
    rivers: [...read('base-rivers.geojson').features, ...read('rivers-schematic.geojson').features]
      .map((f) => ({ name: f.properties.name, lines: f.geometry.coordinates, schematic: !!f.properties.schematic })),
    labels: read('labels.geojson').features.map((f) => ({ ...f.properties, at: f.geometry.coordinates })),
    eras: content.eras,
    polities: content.polities,
    snapshots: content.snapshots.map((s) => ({ ...s, features: shapes[s.key] || [] })),
  };
  const js = '// 자동 생성 파일 — 직접 고치지 말고 data/*.geojson, data/content.json 을 고친 뒤\n' +
    '// node scripts/build-data.mjs 를 실행하세요.\n' +
    'window.ATLAS = ' + JSON.stringify(atlas) + ';\n';
  fs.writeFileSync(path.join(DATA, 'data.js'), js);
  console.log(`data/data.js: 스냅샷 ${atlas.snapshots.length}장, ${(js.length / 1024).toFixed(0)} KB`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--ne');
  if (i > 0) buildBasemap(path.resolve(process.argv[i + 1]));
  buildDataJs();
}
