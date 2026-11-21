#!/usr/bin/env node
// Gemini 검토용 입력 파일을 review/ 에 만든다 (좌표 대신 속성만, 점은 좌표 포함)
//   node scripts/review-input.mjs
// → review/input-history-{elementary,middle}.json, review/input-text-{elementary,middle}.json
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(read('js/model.js'), ctx);
const Model = ctx.Model;
const content = JSON.parse(read('data/content.json'));
const points = JSON.parse(read('data/points.geojson')).features;
const geo = (key) => JSON.parse(read('data/s-' + Model.fileKey(key) + '.geojson')).features;
const NAME = { elementary: '초등', middle: '중등' };

for (const lv of ['elementary', 'middle']) {
  const snaps = content.snapshots.map((s) => ({
    key: s.key, 적용범위: `${Model.keyLabel(s.from)} ~ ${Model.keyLabel(s.to)}`, 성취기준: s.standards,
    ...s[lv],
    도형: geo(s.key).map((f) => {
      const p = { ...f.properties };
      delete p.anchor;
      return p;
    }),
  }));
  const history = {
    수준: NAME[lv],
    시대_띠: content.eras.map((e) => ({ name: e.name, from: e.from, to: e.to })),
    스냅샷: snaps,
    도읍_전투_점: points.map((f) => ({ ...f.properties, desc: f.properties.desc[lv], 좌표_경도_위도: f.geometry.coordinates })),
    나라_소개: Object.fromEntries(Object.entries(content.polities).map(([k, v]) => [k, v.intro[lv]])),
  };
  fs.writeFileSync(path.join(ROOT, `review/input-history-${lv}.json`), JSON.stringify(history, null, 1));

  // 화면 문구: index.html의 글자(태그 밖 글과 aria-label), 수준별 고정 문구, 스냅샷 글, 나라 소개, 점 설명
  const html = read('index.html');
  const fixed = [...new Set([
    ...[...html.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter((t) => t && !/^[\s▾✕＋－⟲›▶◀]+$/.test(t)),
    ...[...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]),
  ])];
  const text = {
    수준: NAME[lv],
    화면_고정_문구: fixed,
    수준별_화면_문구_참고: '중등 화면(?level=middle)에서는 범례 점선 설명·패널 아래 안내·툴팁 문구를 js/app.js의 UI.middle 문구로 바꿔 보여 줌',
    시대_띠: content.eras.map((e) => e.name),
    스냅샷: content.snapshots.map((s) => ({ key: s.key, ...s[lv] })),
    나라_소개: Object.fromEntries(Object.entries(content.polities).map(([k, v]) => [k, v.intro[lv]])),
    점_설명: Object.fromEntries(points.map((f) => [f.properties.name + (f.properties.start > 793 && f.properties.name === '상경' ? '(794~)' : ''), f.properties.desc[lv]])),
  };
  fs.writeFileSync(path.join(ROOT, `review/input-text-${lv}.json`), JSON.stringify(text, null, 1));
}
console.log('review/input-history-*.json, review/input-text-*.json');
