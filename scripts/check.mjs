#!/usr/bin/env node
// 데이터·표기 원칙·오프라인 동작 검사 (의존성 없음)
//   node scripts/check.mjs
// 실패가 하나라도 있으면 종료 코드 1.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const results = [];
let failures = 0;
function section(name) { results.push({ name, errors: [], notes: [] }); }
function fail(msg) { results.at(-1).errors.push(msg); failures++; }
function note(msg) { results.at(-1).notes.push(msg); }

// 앱과 같은 Model 코드를 불러온다
const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(read('js/model.js'), ctx);
const Model = ctx.Model;

const DISCLAIMER = '세력 범위는 대략적인 모습입니다.';
// 어디서나 넣지 않는 표기
const FORBIDDEN = ['임나', '한사군', '안동도호부', '일본해', 'Sea of Japan', '현도군', '진번군', '임둔군'];
// 도형·이름표·점·화면 고정 문구·초등 글에서는 넣지 않고, 중등 글에서만 쓰는 표기 (명세 Q8·Q23)
const MIDDLE_ONLY = ['한 군현', '낙랑'];
const ROLES = ['korea', 'neighbor'];
const CONF = ['대략', '논쟁'];

const content = JSON.parse(read('data/content.json'));
const snapFiles = fs.readdirSync(DATA).filter((f) => /^s-.*\.geojson$/.test(f));
const geo = {};
const keyOf = (f) => f.replace(/^s-/, '').replace(/\.geojson$/, '').replace(/^m/, '-');

// ---------- 1. GeoJSON 유효성 ----------
section('GeoJSON 유효성 (RFC 7946)');

function isPos(p) {
  return Array.isArray(p) && p.length >= 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;
}
function segX(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function checkRing(r, where) {
  if (!Array.isArray(r) || r.length < 4) return fail(`${where}: 고리 꼭짓점이 4개보다 적음`);
  if (!r.every(isPos)) return fail(`${where}: 좌표 형식 오류`);
  const a = r[0], z = r.at(-1);
  if (a[0] !== z[0] || a[1] !== z[1]) fail(`${where}: 고리가 닫혀 있지 않음`);
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  if (s <= 0) fail(`${where}: 바깥 고리가 반시계 방향이 아님`);
  for (let i = 0; i < r.length - 1; i++) {
    for (let j = i + 2; j < r.length - 1; j++) {
      if (i === 0 && j === r.length - 2) continue;
      if (segX(r[i], r[i + 1], r[j], r[j + 1])) { fail(`${where}: 고리가 스스로 교차함 (${r[i]} / ${r[j]})`); return; }
    }
  }
}
function checkGeometry(g, where) {
  if (!g || typeof g !== 'object') return fail(`${where}: geometry 없음`);
  if (g.type === 'Polygon') g.coordinates.forEach((r, i) => checkRing(r, `${where} 고리${i}`));
  else if (g.type === 'MultiPolygon') g.coordinates.forEach((poly, j) => poly.forEach((r, i) => checkRing(r, `${where} 조각${j} 고리${i}`)));
  else if (g.type === 'LineString') { if (!(g.coordinates.length >= 2 && g.coordinates.every(isPos))) fail(`${where}: 선 좌표 오류`); }
  else if (g.type === 'MultiLineString') g.coordinates.forEach((l) => { if (!(l.length >= 2 && l.every(isPos))) fail(`${where}: 선 좌표 오류`); });
  else if (g.type === 'Point') { if (!isPos(g.coordinates)) fail(`${where}: 점 좌표 오류`); }
  else fail(`${where}: 지원하지 않는 geometry ${g.type}`);
}
function checkFC(file) {
  let fc;
  try { fc = JSON.parse(read('data/' + file)); } catch (e) { fail(`${file}: JSON 파싱 실패 — ${e.message}`); return null; }
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) { fail(`${file}: FeatureCollection 아님`); return null; }
  fc.features.forEach((f, i) => {
    if (f.type !== 'Feature') fail(`${file}#${i}: type이 Feature 아님`);
    checkGeometry(f.geometry, `${file}#${i}(${f.properties?.name ?? ''})`);
  });
  return fc;
}
for (const f of ['base-land.geojson', 'base-rivers.geojson', 'rivers-schematic.geojson', 'labels.geojson']) checkFC(f);
let vertexTotal = 0;
const vertexWarn = [];
for (const f of snapFiles) {
  const fc = checkFC(f);
  if (!fc) continue;
  geo[keyOf(f)] = fc;
  for (const ft of fc.features) {
    const g = ft.geometry;
    const rings = g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
    for (const r of rings) {
      vertexTotal += r.length - 1;
      if (r.length - 1 > 90) vertexWarn.push(`${f} ${ft.properties.name} ${r.length - 1}개`);
    }
  }
}
note(`스냅샷 파일 ${snapFiles.length}개, 나라 도형 꼭짓점 합계 ${vertexTotal}개`);
if (vertexWarn.length) note('꼭짓점이 많은 고리: ' + vertexWarn.join(', '));

// ---------- 2. 필수 속성 ----------
section('필수 속성');
for (const [key, fc] of Object.entries(geo)) {
  fc.features.forEach((f, i) => {
    const p = f.properties || {};
    const w = `s-${key} #${i} ${p.name ?? '(이름 없음)'}`;
    if (typeof p.name !== 'string' || !p.name.trim()) fail(`${w}: name 없음`);
    if (!Number.isInteger(p.start) || !Number.isInteger(p.end)) fail(`${w}: start/end가 정수 연도가 아님`);
    else if (p.start > p.end) fail(`${w}: start가 end보다 큼`);
    if (!ROLES.includes(p.role)) fail(`${w}: role은 korea 또는 neighbor`);
    if (!CONF.includes(p.confidence)) fail(`${w}: confidence는 "대략" 또는 "논쟁"`);
    if (typeof p.basis !== 'string' || p.basis.trim().length < 4) fail(`${w}: basis(근거) 없음`);
    if (!isPos(p.anchor)) fail(`${w}: anchor(이름표 위치) 없음`);
    if (p.kind && p.kind !== 'line' && p.kind !== 'zone') fail(`${w}: 알 수 없는 kind ${p.kind}`);
    if (p.kind === 'line' && f.geometry.type !== 'LineString') fail(`${w}: 선 도형은 LineString이어야 함`);
    if (p.kind === 'zone' && !/Polygon$/.test(f.geometry.type)) fail(`${w}: 영역(zone) 도형은 Polygon/MultiPolygon이어야 함`);
    if (!p.kind && !/Polygon$/.test(f.geometry.type)) fail(`${w}: 나라 도형은 Polygon/MultiPolygon이어야 함`);
    if (!content.polities[p.name]) fail(`${w}: content.json polities에 소개가 없음`);
    if (p.fillAs && !fc.features.some((g) => g.properties.name === p.fillAs)) fail(`${w}: fillAs "${p.fillAs}"인 도형이 같은 스냅샷에 없음`);
  });
}
// 수준별 글 규칙 (명세 spec-middle.md '글 기준')
const LEVEL_RULES = {
  elementary: { name: '초등', sentences: [2, 3], events: [3, 5], questions: [1, 2] },
  middle: { name: '중등', sentences: [3, 4], events: [4, 6], questions: [1, 2] },
};
const missingMiddle = { snapshots: [], polities: [] };
for (const [name, p] of Object.entries(content.polities)) {
  if (!p.intro || typeof p.intro !== 'object') { fail(`polities.${name}: intro가 {elementary, middle} 두 벌이 아님`); continue; }
  if (!p.intro.elementary || p.intro.elementary.length < 5) fail(`polities.${name}: 초등 한 줄 소개 없음`);
  if (!p.intro.middle) missingMiddle.polities.push(name);
  else if (p.intro.middle.length < 5) fail(`polities.${name}: 중등 소개가 너무 짧음`);
}

// ---------- 3. 스냅샷 완결성 ----------
section('스냅샷 완결성');
const snaps = Model.prepare(content.snapshots.map((s) => ({ ...s, features: geo[s.key]?.features || [] })));
for (const s of content.snapshots) if (!geo[s.key]) fail(`스냅샷 ${s.key}: data/s-${Model.fileKey(s.key)}.geojson 없음`);
for (const k of Object.keys(geo)) if (!content.snapshots.some((s) => s.key === k)) fail(`s-${Model.fileKey(k)}.geojson: content.json에 스냅샷 글이 없음`);
for (const s of snaps) {
  const w = `스냅샷 ${s.key}`;
  if (s.keyT < s.fromT || s.keyT > s.toT) fail(`${w}: 키가 적용 범위(${s.from}~${s.to}) 밖에 있음`);
  for (const [lv, R] of Object.entries(LEVEL_RULES)) {
    const x = s[lv];
    if (!x) { if (lv === 'middle') missingMiddle.snapshots.push(s.key); else fail(`${w}: ${R.name} 글 없음`); continue; }
    const wl = `${w} ${R.name}`;
    if (!x.caption) fail(`${wl}: 캡션 없음`);
    const sentences = (x.summary || '').split(/(?<=[.?!])\s+/).filter(Boolean);
    if (sentences.length < R.sentences[0] || sentences.length > R.sentences[1]) fail(`${wl}: 시대 요약은 ${R.sentences.join('~')}문장 (지금 ${sentences.length}문장)`);
    if (!Array.isArray(x.events) || x.events.length < R.events[0] || x.events.length > R.events[1]) fail(`${wl}: 사건은 ${R.events.join('~')}개 (지금 ${x.events?.length ?? 0}개)`);
    (x.events || []).forEach((e) => { if (!Model.parseKey(e.year) || !e.text) fail(`${wl}: 사건 형식 오류 ${JSON.stringify(e)}`); });
    if (!Array.isArray(x.questions) || x.questions.length < R.questions[0] || x.questions.length > R.questions[1]) fail(`${wl}: 탐구 질문은 ${R.questions.join('~')}개`);
  }
}
// 중등 글은 5단계(글 쓰기) 전까지 비어 있을 수 있다 — 지금은 경고만
if (missingMiddle.snapshots.length) note(`경고: 중등 글이 없는 스냅샷 ${missingMiddle.snapshots.length}장 (초등 글로 대신 보임)`);
if (missingMiddle.polities.length) note(`경고: 중등 소개가 없는 나라 ${missingMiddle.polities.length}곳`);
// 수준 읽기
for (const [q, want] of [['', 'elementary'], ['?level=middle', 'middle'], ['?year=-108&level=middle', 'middle'], ['?level=high', 'elementary'], ['?level=Middle', 'elementary']]) {
  if (Model.levelFromSearch(q) !== want) fail(`주소 "${q}"의 수준이 ${want}가 아님`);
}
if (Model.search('middle', '-108') !== '?level=middle&year=-108' || Model.search('elementary', '475') !== '?year=475') fail('딥링크 주소가 수준을 유지하지 않음');
// 구간이 빈틈없이 이어지는지 (월 단위)
for (let i = 0; i < snaps.length; i++) {
  if (i > 0 && snaps[i].fromT !== snaps[i - 1].toT + 1) fail(`스냅샷 ${snaps[i - 1].key}→${snaps[i].key}: 구간이 이어지지 않음`);
}
const RANGE = `${Model.keyLabel(String(Model.MIN_YEAR))}~${Model.keyLabel(String(Model.MAX_YEAR))}`;
if (snaps[0].fromT !== Model.yearT(Model.MIN_YEAR)) fail(`첫 스냅샷이 ${Model.keyLabel(String(Model.MIN_YEAR))} 1월에 시작하지 않음`);
if (snaps.at(-1).toT !== Model.yearT(Model.MAX_YEAR, 12)) fail(`마지막 스냅샷이 ${Model.MAX_YEAR}년 12월에 끝나지 않음`);
// 모든 연도·월에서 지도가 비지 않는지 (슬라이더 규칙과 월 단위 모두)
let emptyCount = 0, yearCount = 0;
for (let y = Model.MIN_YEAR; y <= Model.MAX_YEAR; y = Model.nextYear(y)) {
  yearCount++;
  const st = Model.stateForYear(snaps, y);
  if (st.idx < 0) { fail(`${y}년: 스냅샷 없음`); continue; }
  const vis = Model.visibleFeatures(snaps[st.idx], st.t).filter((f) => f.properties.role === 'korea' && !f.properties.kind);
  if (!vis.length) { fail(`${y}년: 보이는 우리 역사 나라 도형이 없음 (스냅샷 ${snaps[st.idx].key})`); emptyCount++; }
}
for (let t = Model.yearT(Model.MIN_YEAR); t <= Model.yearT(Model.MAX_YEAR, 12); t++) {
  const idx = Model.indexAtT(snaps, t);
  if (idx < 0) { fail(`${Model.yearOf(t)}년 ${Model.monthOf(t)}월: 스냅샷 없음`); break; }
  if (!Model.visibleFeatures(snaps[idx], t).some((f) => f.properties.role === 'korea' && !f.properties.kind)) {
    fail(`${Model.yearOf(t)}년 ${Model.monthOf(t)}월: 지도가 빔`); break;
  }
}
note(`${RANGE} ${yearCount}개 연도 모두 검사, 빈 지도 ${emptyCount}건`);
// 같은 해 스냅샷이 여러 장인 경우 첫 장을 보여 주는지
const byYear = {};
snaps.forEach((s, i) => { (byYear[s.keyYear] ||= []).push(i); });
for (const [y, list] of Object.entries(byYear)) {
  if (list.length > 1) {
    const st = Model.stateForYear(snaps, +y);
    if (st.idx !== list[0]) fail(`${y}년: 슬라이더가 첫 스냅샷을 보여 주지 않음`);
    else note(`${y}년 스냅샷 ${list.map((i) => snaps[i].key).join(', ')} → 슬라이더는 ${snaps[list[0]].key}, ←/→로 나머지`);
  }
}
// 시대 띠
if (content.eras.length !== 10) fail(`시대 띠는 10개 (지금 ${content.eras.length}개)`);
for (let i = 1; i < content.eras.length; i++) {
  if (Model.startT(content.eras[i].from) !== Model.endT(content.eras[i - 1].to) + 1) fail(`시대 띠 ${content.eras[i - 1].name}→${content.eras[i].name} 사이가 끊김`);
}
for (const e of content.eras) if (!(typeof e.weight === 'number' && e.weight > 0)) fail(`시대 띠 ${e.name}: 너비 몫(weight)이 없음`);

// ---------- 시간 모델 ----------
section('시간 모델 (0년 없음, 연도↔위치 변환)');
const FULL_MIN = -400, FULL_MAX = 2026; // 명세의 전체 범위
// 1024×768에서 슬라이더 막대 너비(px): 1024 − 좌우 여백 32 − 재생·속도 120 − 이전·다음 96 − 간격 30
const TRACK_1024 = 746;
const MIN_BAND_PX = 48;
if (Model.parseKey('0') !== null || Model.parseKey('0-05') !== null) fail('0년을 연도로 받음');
let yr = 0;
for (let y = FULL_MIN; y <= FULL_MAX; y = Model.nextYear(y)) {
  yr++;
  if (y === 0) { fail('연도를 하나씩 넘기다 0년을 지남'); break; }
  if (Model.yearOf(Model.yearT(y)) !== y || Model.yearOf(Model.yearT(y, 12)) !== y) { fail(`${y}년: 연도→월 번호→연도가 되돌아오지 않음`); break; }
  if (y < FULL_MAX && Model.yearT(Model.nextYear(y)) !== Model.yearT(y) + 12) { fail(`${y}년 다음 해가 12달 뒤가 아님`); break; }
}
if (Model.nextYear(-1) !== 1) fail('기원전 1년 다음이 1년이 아님');
if (yr !== FULL_MAX - FULL_MIN) fail(`기원전 400년~2026년은 ${FULL_MAX - FULL_MIN}개 해여야 함 (지금 ${yr})`);
for (const [st, want] of [[{ t: Model.yearT(-108), hasMonth: false }, '기원전 108년'], [{ t: Model.yearT(-1), hasMonth: false }, '기원전 1년'],
  [{ t: Model.yearT(1), hasMonth: false }, '1년'], [{ t: Model.yearT(1950, 8), hasMonth: true }, '1950년 8월']]) {
  if (Model.label(st) !== want) fail(`표시 "${Model.label(st)}" ≠ "${want}"`);
}
if (Model.keyParam({ t: Model.yearT(-108), hasMonth: false }) !== '-108') fail('기원전 108년 딥링크 값이 -108이 아님');
if (Model.periodLabel({ from: '-107', to: '-1' }) !== '기원전 107년 ~ 기원전 1년') fail('기원전 기간 표시 오류');
if (Model.fileKey('-108') !== 'm108' || Model.keyOfFileKey('m108') !== '-108') fail('기원전 파일 이름 변환 오류');
// 데이터 어디에도 0년이 없는지
const zeroYear = [];
for (const s of content.snapshots) {
  for (const k of [s.key, s.from, s.to]) if (!Model.parseKey(k)) zeroYear.push(`스냅샷 ${s.key}: "${k}"`);
  for (const e of s.events || []) if (!Model.parseKey(e.year)) zeroYear.push(`스냅샷 ${s.key} 사건: "${e.year}"`);
}
for (const e of content.eras) for (const k of [e.from, e.to]) if (!Model.parseKey(k)) zeroYear.push(`시대 띠 ${e.name}: "${k}"`);
for (const [key, fc] of Object.entries(geo)) for (const f of fc.features) {
  if (f.properties.start === 0 || f.properties.end === 0) zeroYear.push(`s-${Model.fileKey(key)} ${f.properties.name}`);
}
for (const z of zeroYear) fail(`0년이거나 읽을 수 없는 연도: ${z}`);
// 시대 띠가 전체 범위를 덮는지
if (content.eras[0].from !== String(FULL_MIN)) fail(`첫 시대 띠가 기원전 400년에 시작하지 않음 (${content.eras[0].from})`);
if (content.eras.at(-1).to !== String(FULL_MAX)) fail(`마지막 시대 띠가 2026년에 끝나지 않음 (${content.eras.at(-1).to})`);
// 연도↔위치 변환: 전체 범위와 지금 데이터 범위 모두
const scales = {
  '전체 범위': Model.makeScale(content.eras, Model.yearT(FULL_MIN), Model.yearT(FULL_MAX, 12)),
  '앱 범위': Model.makeScale(content.eras, Model.yearT(Model.MIN_YEAR), Model.yearT(Model.MAX_YEAR, 12)),
};
for (const [nm, sc] of Object.entries(scales)) {
  let bad = 0;
  if (sc.tToFrac(sc.minT) !== 0 || Math.abs(sc.tToFrac(sc.maxT + 1) - 1) > 1e-12) fail(`${nm}: 양 끝 위치가 0과 1이 아님`);
  for (let t = sc.minT; t <= sc.maxT && bad < 3; t++) {
    const f = sc.tToFrac(t), f2 = sc.tToFrac(t + 1);
    if (!(f2 > f)) { fail(`${nm}: ${Model.yearOf(t)}년 ${Model.monthOf(t)}월에서 위치가 늘지 않음`); bad++; }
    if (sc.fracToT(f) !== t || sc.fracToT((f + f2) / 2) !== t) { fail(`${nm}: ${Model.yearOf(t)}년 ${Model.monthOf(t)}월 위치→시점이 되돌아오지 않음`); bad++; }
  }
  for (const y of [-400, -108, -1, 1, 300, 1950, 2026]) {
    if (y < Model.yearOf(sc.minT)) continue;
    if (sc.fracToYear(sc.yearToFrac(y)) !== y) fail(`${nm}: ${y}년 위치 변환이 되돌아오지 않음`);
  }
}
const fullSc = scales['전체 범위'];
const narrow = fullSc.bands.map((b) => ({ name: b.era.name, px: (b.f1 - b.f0) * TRACK_1024 }));
for (const b of narrow) if (b.px < MIN_BAND_PX) fail(`시대 띠 ${b.name}: 1024px 화면에서 ${b.px.toFixed(0)}px (${MIN_BAND_PX}px보다 좁음)`);
note(`기원전 400년~2026년 ${yr}개 해, 0년 없음. 1024px 화면 띠 너비 ${narrow.map((b) => b.name + ' ' + b.px.toFixed(0)).join(', ')}px`);

// ---------- 도읍·전투 점 ----------
section('도읍·전투 점 (data/points.geojson)');
const ptFC = checkFC('points.geojson');
const PT_KINDS = ['도읍', '전투'];
const BBOX = [115, 32, 135, 48];
if (ptFC) {
  const kinds = { 도읍: 0, 전투: 0 };
  ptFC.features.forEach((f, i) => {
    const p = f.properties || {};
    const w = `점 #${i} ${p.name ?? '(이름 없음)'}`;
    if (f.geometry?.type !== 'Point') { fail(`${w}: Point가 아님`); return; }
    const [x, y] = f.geometry.coordinates;
    if (x < BBOX[0] || x > BBOX[2] || y < BBOX[1] || y > BBOX[3]) fail(`${w}: 바탕 지도 범위 밖`);
    if (typeof p.name !== 'string' || !p.name.trim()) fail(`${w}: name 없음`);
    if (!PT_KINDS.includes(p.kind)) fail(`${w}: 종류(kind)는 도읍 또는 전투`); else kinds[p.kind]++;
    if (!Number.isInteger(p.start) || !Number.isInteger(p.end) || p.start > p.end) fail(`${w}: start/end 오류`);
    if (p.start === 0 || p.end === 0) fail(`${w}: 0년`);
    if (p.start < Model.MIN_YEAR || p.end > Model.MAX_YEAR) fail(`${w}: 타임라인 범위 밖`);
    for (const k of ['startMonth', 'endMonth']) if (p[k] != null && !(Number.isInteger(p[k]) && p[k] >= 1 && p[k] <= 12)) fail(`${w}: ${k}는 1~12`);
    for (const lv of Model.LEVELS) if (typeof p.desc?.[lv] !== 'string' || p.desc[lv].length < 8) fail(`${w}: ${LEVEL_RULES[lv].name} 설명 없음`);
    if (!CONF.includes(p.confidence)) fail(`${w}: confidence는 "대략" 또는 "논쟁"`);
    if (typeof p.basis !== 'string' || p.basis.trim().length < 2) fail(`${w}: basis(근거) 없음`);
    // 자기 시기에만 보이는지 (앞뒤 한 달 밖에서는 숨음)
    const a = Model.featureStartT(p), z = Model.featureEndT(p);
    if (!Model.isVisible(f, a) || !Model.isVisible(f, z) || Model.isVisible(f, a - 1) || Model.isVisible(f, z + 1)) fail(`${w}: 자기 시기(${p.start}~${p.end})에만 보이지 않음`);
    if (!snaps.some((s) => s.fromT <= z && s.toT >= a)) fail(`${w}: 어느 장면에서도 보이지 않음`);
  });
  if (kinds.도읍 < 12 || kinds.전투 < 15) fail(`도읍 ${kinds.도읍}곳, 전투 ${kinds.전투}곳 — 명세(도읍 15곳 안팎, 전투 20곳 안팎)보다 적음`);
  const appJs = read('js/app.js');
  if (!/points-toggle/.test(read('index.html')) || /id="points-toggle"[^>]*checked/.test(read('index.html'))) fail('범례에 "도읍·전투 보기" 상자가 없거나 기본으로 켜져 있음');
  if (!/Model\.isVisible\(f, state\.t\)/.test(appJs)) fail('js/app.js가 그 시점에 보이는 점만 고르지 않음');
  note(`도읍 ${kinds.도읍}곳, 전투 ${kinds.전투}곳, 논쟁 위치 ${ptFC.features.filter((f) => f.properties.confidence === '논쟁').length}곳`);
}

// ---------- 4. 존속 연도와 스냅샷 범위 ----------
section('존속 연도와 스냅샷 범위');
for (const s of snaps) {
  const y0 = Model.yearOf(s.fromT), y1 = Model.yearOf(s.toT);
  for (const f of s.features) {
    const p = f.properties;
    if (Model.featureEndT(p) < s.fromT || Model.featureStartT(p) > s.toT) fail(`스냅샷 ${s.key}(${s.from}~${s.to}) ${p.name}(${p.start}~${p.end}): 이 스냅샷에서 한 번도 보이지 않음`);
    for (const k of ['startMonth', 'endMonth']) if (p[k] != null && !(Number.isInteger(p[k]) && p[k] >= 1 && p[k] <= 12)) fail(`스냅샷 ${s.key} ${p.name}: ${k}는 1~12`);
  }
  // 같은 해에 이름이 같은 '대략' 나라 도형이 서로 다른 나라 이름과 같은 자리에 동시에 보이지 않는지 (같은 도형 재사용 검사)
  for (let t = s.fromT; t <= s.toT; t++) {
    const y = `${Model.yearOf(t)}-${Model.monthOf(t)}`;
    const vis = s.features.filter((f) => Model.isVisible(f, t) && !f.properties.kind);
    const seen = new Map();
    for (const f of vis) {
      const sig = JSON.stringify(f.geometry.coordinates);
      if (seen.has(sig) && seen.get(sig) !== f.properties.name) {
        fail(`스냅샷 ${s.key} ${y}년: 같은 자리에 "${seen.get(sig)}"와 "${f.properties.name}"가 함께 보임`);
      }
      seen.set(sig, f.properties.name);
    }
  }
}
// 대표 사례
const exp = [
  ['발해', 926, true], ['발해', 927, false], ['고려', 1391, true], ['조선', 1391, false], ['조선', 1392, true],
  ['탐라총관부', 1272, false], ['탐라총관부', 1273, true], ['백제', 660, true], ['백제', 661, false],
  ['미군정', '1948-07', true], ['대한민국', '1948-07', false], ['대한민국', '1948-08', true], ['북한', '1948-08', false], ['북한', '1948-09', true],
];
for (const [name, y, want] of exp) {
  const st = typeof y === 'string' ? Model.stateForParam(snaps, y) : Model.stateForYear(snaps, y);
  const has = Model.visibleFeatures(snaps[st.idx], st.t).some((f) => f.properties.name === name);
  if (has !== want) fail(`${y}년에 ${name}이(가) ${want ? '보여야' : '숨어야'} 함`);
}

// ---------- 5. 역사 표기 원칙 ----------
section('역사 표기 원칙');
for (const s of snaps) {
  if (s.keyYear < 1449) continue;
  const y0 = Model.yearOf(s.fromT), y1 = Model.yearOf(s.toT);
  for (let t = s.fromT; t <= s.toT; t++) {
    const dokdo = s.features.filter((f) => f.properties.name === '독도' && Model.isVisible(f, t));
    if (!dokdo.length) { fail(`스냅샷 ${s.key} ${Model.yearOf(t)}년 ${Model.monthOf(t)}월: 독도 도형이 없음`); break; }
    if (!dokdo.every((f) => /Polygon$/.test(f.geometry.type) && isPos(f.properties.anchor))) { fail(`스냅샷 ${s.key}: 독도 도형 또는 이름표 위치 오류`); break; }
  }
}
const seaLabels = JSON.parse(read('data/labels.geojson')).features.filter((f) => f.properties.kind === 'sea').map((f) => f.properties.name);
if (!seaLabels.includes('동해')) fail('바다 이름표에 "동해"가 없음');
// 금지어: 수준에 따라 나눈다
const stripMiddle = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'middle' ? undefined : v)));
const middleOnly = (o) => { const out = []; JSON.stringify(o, (k, v) => { if (k === 'middle' && v) out.push(JSON.stringify(v)); return v; }); return out.join('\n'); };
const pointsRaw = JSON.parse(read('data/points.geojson'));
const textSources = {
  'data/s-*.geojson·labels': snapFiles.map((f) => read('data/' + f)).join('\n') + read('data/labels.geojson'),
  'data/points.geojson(중등 설명 제외)': JSON.stringify(stripMiddle(pointsRaw)),
  'data/content.json(초등 글·공통)': JSON.stringify(stripMiddle(content)),
  'index.html': fs.existsSync(path.join(ROOT, 'index.html')) ? read('index.html') : '',
  'js/*.js': ['js/app.js', 'js/map.js', 'js/model.js'].map(read).join('\n'),
};
const middleText = middleOnly(content) + middleOnly(pointsRaw);
for (const [src, text] of Object.entries(textSources)) {
  for (const w of [...FORBIDDEN, ...MIDDLE_ONLY]) if (text.includes(w)) fail(`${src}: 넣지 않기로 한 표기 "${w}"가 있음`);
}
for (const w of FORBIDDEN) if (middleText.includes(w)) fail(`중등 글: 어디서나 넣지 않기로 한 표기 "${w}"가 있음`);
note(`중등 글에서만 허용: ${MIDDLE_ONLY.map((w) => `"${w}" ${middleText.split(w).length - 1}회`).join(', ')}`);
// 논쟁 도형은 점선
let disputed = 0;
for (const s of snaps) for (const f of s.features) {
  const st = Model.edgeStyle(f);
  if (f.properties.confidence === '논쟁') { disputed++; if (!st.dashed || !st.dasharray) fail(`스냅샷 ${s.key} ${f.properties.name}: 논쟁 도형인데 점선이 아님`); }
  else if (st.dashed) fail(`스냅샷 ${s.key} ${f.properties.name}: 대략 도형인데 점선임`);
}
note(`논쟁 도형 ${disputed}개 모두 점선 규칙 적용`);
if (fs.existsSync(path.join(ROOT, 'js/map.js'))) {
  const mapJs = read('js/map.js');
  if (!/Model\.edgeStyle\(/.test(mapJs) || !/stroke-dasharray/.test(mapJs)) fail('js/map.js가 Model.edgeStyle의 점선 규칙으로 그리지 않음');
}
// 면책 문구: 지도 위 상시 표시
const html = textSources['index.html'];
if (!html) fail('index.html 없음');
else {
  const m = /<[^>]+id="map-disclaimer"[^>]*>([\s\S]*?)<\//.exec(html);
  if (!m || !m[1].includes(DISCLAIMER)) fail(`지도 위 면책 문구(#map-disclaimer)에 "${DISCLAIMER}"가 없음`);
  if (!html.includes('아래 막대를 움직이거나')) fail('첫 화면 안내 문구가 없음');
  if (!html.includes('교과서 서술을 따르되 교과서마다 조금씩 다를 수 있어요')) fail('화면에 "교과서 서술을 따르되 교과서마다 조금씩 다를 수 있어요" 문구가 없음');
}

// ---------- 6. 오프라인 동작 ----------
section('오프라인 동작 (런타임 외부 요청 없음)');
function stripComments(text, kind) {
  if (kind === 'html') {
    text = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<meta\b[^>]*>/gi, '');
    text = text.replace(/xmlns(:\w+)?="[^"]*"/g, ''); // SVG 이름공간 선언은 요청이 아님
  }
  if (kind === 'js' || kind === 'css' || kind === 'html') {
    text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  }
  if (kind === 'js' || kind === 'html') {
    text = text.split('\n').map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
  }
  return text;
}
const runtimeFiles = ['index.html'];
for (const dir of ['js', 'css']) {
  if (fs.existsSync(path.join(ROOT, dir))) for (const f of fs.readdirSync(path.join(ROOT, dir))) runtimeFiles.push(`${dir}/${f}`);
}
runtimeFiles.push('data/data.js');
for (const f of runtimeFiles) {
  if (!fs.existsSync(path.join(ROOT, f))) { fail(`${f} 없음`); continue; }
  const kind = f.endsWith('.html') ? 'html' : f.endsWith('.css') ? 'css' : 'js';
  let text = f === 'data/data.js' ? read(f) : stripComments(read(f), kind);
  // SVG 이름공간 식별자는 주소처럼 생겼지만 요청을 보내지 않는다
  const nsCount = (text.match(/['"]http:\/\/www\.w3\.org\/2000\/svg['"]/g) || []).length;
  if (nsCount) { text = text.replace(/['"]http:\/\/www\.w3\.org\/2000\/svg['"]/g, "''"); note(`${f}: SVG 이름공간 식별자 ${nsCount}곳은 요청이 아니므로 제외`); }
  const hits = text.match(/https?:\/\/[^\s'"<>)]*/g);
  if (hits) fail(`${f}: 외부 주소 ${[...new Set(hits)].slice(0, 3).join(', ')}`);
  for (const api of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'importScripts', 'document.cookie']) {
    if (text.includes(api)) fail(`${f}: 네트워크·쿠키 API "${api}" 사용`);
  }
  if (kind === 'css' && /@import|url\(\s*['"]?(https?:|\/\/)/.test(text)) fail(`${f}: CSS 외부 불러오기`);
}
if (html) {
  for (const m of html.matchAll(/<(script|link|img|iframe)\b[^>]*(src|href)="([^"]+)"/gi)) {
    if (/^(https?:)?\/\//.test(m[3])) fail(`index.html: 외부 자원 ${m[3]}`);
    else if (!fs.existsSync(path.join(ROOT, m[3].split('?')[0]))) fail(`index.html: 없는 파일 ${m[3]}`);
  }
}
// data.js가 원본과 같은지
if (fs.existsSync(path.join(DATA, 'data.js'))) {
  const c2 = { window: {} };
  vm.createContext(c2);
  vm.runInContext(read('data/data.js'), c2);
  const A = c2.window.ATLAS;
  const same = A && A.snapshots.length === content.snapshots.length && ptFC &&
    JSON.stringify(A.points) === JSON.stringify(ptFC.features) &&
    A.snapshots.every((s) => JSON.stringify(s.features) === JSON.stringify(geo[s.key]?.features) &&
      JSON.stringify({ ...s, features: undefined }) === JSON.stringify({ ...content.snapshots.find((c) => c.key === s.key), features: undefined }));
  if (!same) fail('data/data.js가 data/*.geojson·content.json과 다름 — node scripts/build-data.mjs 를 다시 실행하세요');
}

// ---------- 결과 ----------
for (const r of results) {
  console.log(`${r.errors.length ? '✗' : '✓'} ${r.name}`);
  for (const e of r.errors.slice(0, 25)) console.log(`    - ${e}`);
  if (r.errors.length > 25) console.log(`    … 외 ${r.errors.length - 25}건`);
  for (const n of r.notes) console.log(`    · ${n}`);
}
console.log(failures ? `\n실패 ${failures}건` : '\n모든 검사 통과');
process.exit(failures ? 1 : 0);
