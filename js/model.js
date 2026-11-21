/*
 * 시간·스냅샷 계산과 도형 표시 규칙 (화면과 무관한 순수 함수)
 * 브라우저에서는 window.Model, 검사 스크립트(scripts/check.mjs)에서도 같은 코드를 쓴다.
 *
 * 시간은 "월 번호" t = 천문 연도 × 12 + (월 − 1) 로 다룬다.
 * 연도 표기에는 0년이 없다(기원전 1년 다음이 서기 1년). 기원전은 음수로 쓴다(-108 = 기원전 108년).
 * 계산할 때만 천문 연도(기원전 1년 = 0, 기원전 108년 = -107)로 바꾸고, 보여 줄 때 되돌린다.
 */
(function (root) {
  'use strict';

  var MIN_YEAR = 375;
  var MAX_YEAR = 2026;

  // "475" → {y:475, m:null}, "1950-08" → {y:1950, m:8}, "-108" → {y:-108, m:null}. 0년은 없다.
  function parseKey(s) {
    var m = /^(-?\d{1,4})(?:-(\d{2}))?$/.exec(String(s).trim());
    if (!m) return null;
    var y = parseInt(m[1], 10);
    if (y === 0) return null;
    var mo = m[2] ? parseInt(m[2], 10) : null;
    if (mo !== null && (mo < 1 || mo > 12)) return null;
    return { y: y, m: mo };
  }

  // 표기 연도 ↔ 천문 연도
  function astro(y) { return y < 0 ? y + 1 : y; }
  function histYear(a) { return a <= 0 ? a - 1 : a; }
  // 그해 그달(월이 없으면 1월)의 월 번호
  function yearT(y, m) { return astro(y) * 12 + (m ? m - 1 : 0); }
  // 다음 해 (기원전 1년 다음은 1년)
  function nextYear(y) { return y === -1 ? 1 : y + 1; }

  // 구간 시작: 월이 없으면 그해 1월
  function startT(s) { var p = parseKey(s); return yearT(p.y, p.m); }
  // 구간 끝: 월이 없으면 그해 12월
  function endT(s) { var p = parseKey(s); return yearT(p.y, p.m || 12); }
  function yearOf(t) { return histYear(Math.floor(t / 12)); }
  function monthOf(t) { return (((t % 12) + 12) % 12) + 1; }

  // 화면 표기: -108 → "기원전 108"
  function yearText(y) { return y < 0 ? '기원전 ' + -y : String(y); }
  // "-108" → "기원전 108년", "1950-08" → "1950년 8월"
  function keyLabel(s) { var p = parseKey(s); return yearText(p.y) + '년' + (p.m ? ' ' + p.m + '월' : ''); }
  // 파일 이름용 키: "-108" → "m108"
  function fileKey(key) { return String(key).replace(/^-/, 'm'); }
  function keyOfFileKey(fk) { return String(fk).replace(/^m/, '-'); }

  // 스냅샷 목록을 시간 순으로 정리하고 계산값을 붙인다
  function prepare(snapshots) {
    return snapshots
      .map(function (s) {
        var k = parseKey(s.key);
        return Object.assign({}, s, {
          keyT: startT(s.key),
          keyYear: k.y,
          keyHasMonth: k.m !== null,
          fromT: startT(s.from),
          toT: endT(s.to),
        });
      })
      .sort(function (a, b) { return a.keyT - b.keyT; });
  }

  // t를 포함하는 스냅샷 번호
  function indexAtT(snaps, t) {
    for (var i = 0; i < snaps.length; i++) if (t >= snaps[i].fromT && t <= snaps[i].toT) return i;
    return -1;
  }

  // 슬라이더 연도 → 상태. 그해에 시작하는 스냅샷이 여러 장이면 첫 장을 보여 준다.
  function stateForYear(snaps, year) {
    year = Math.max(MIN_YEAR, Math.min(MAX_YEAR, Math.round(year)));
    if (year === 0) year = 1;
    for (var i = 0; i < snaps.length; i++) {
      if (snaps[i].keyYear === year) return { idx: i, t: snaps[i].keyT, hasMonth: snaps[i].keyHasMonth };
    }
    var t = yearT(year);
    return { idx: indexAtT(snaps, t), t: t, hasMonth: false };
  }

  // 스냅샷 번호 → 상태 (그 스냅샷의 시작 시점)
  function stateForIndex(snaps, i) {
    i = Math.max(0, Math.min(snaps.length - 1, i));
    return { idx: i, t: snaps[i].keyT, hasMonth: snaps[i].keyHasMonth };
  }

  // 딥링크 ?year=475, ?year=1950-08, ?year=-108
  function stateForParam(snaps, param) {
    var p = parseKey(param || '');
    if (!p) return null;
    if (p.m === null) return stateForYear(snaps, p.y);
    var t = yearT(p.y, p.m);
    var minT = yearT(MIN_YEAR), maxT = yearT(MAX_YEAR, 12);
    t = Math.max(minT, Math.min(maxT, t));
    var idx = indexAtT(snaps, t);
    if (idx < 0) return null;
    return { idx: idx, t: t, hasMonth: true };
  }

  // 다음/이전 스냅샷 (같은 해 안의 스냅샷도 한 장씩)
  function step(snaps, state, dir) {
    if (dir > 0) return state.idx + 1 < snaps.length ? stateForIndex(snaps, state.idx + 1) : state;
    // 스냅샷 중간에 있으면 먼저 그 스냅샷의 시작으로
    if (state.t > snaps[state.idx].keyT) return stateForIndex(snaps, state.idx);
    return state.idx > 0 ? stateForIndex(snaps, state.idx - 1) : state;
  }

  // 그 시점(월 번호 t)에 보이는 도형인가: 존속 연도 start~end.
  // 현대처럼 달까지 갈라야 하면 startMonth/endMonth(1~12)를 덧붙인다.
  function featureStartT(p) { return yearT(p.start, p.startMonth); }
  function featureEndT(p) { return yearT(p.end, p.endMonth || 12); }
  function isVisible(feature, t) {
    var p = feature.properties;
    return t >= featureStartT(p) && t <= featureEndT(p);
  }

  function visibleFeatures(snap, t) {
    return snap.features.filter(function (f) { return isVisible(f, t); });
  }

  // 선 모양 규칙: 논쟁 도형은 점선, 대략 도형은 흐린 가장자리
  function edgeStyle(feature) {
    var p = feature.properties;
    if (p.confidence === '논쟁') return { dashed: true, dasharray: '7 5', soft: true };
    return { dashed: false, dasharray: '', soft: true };
  }

  function label(state) {
    var ys = yearText(yearOf(state.t)) + '년';
    return state.hasMonth ? ys + ' ' + monthOf(state.t) + '월' : ys;
  }

  function keyParam(state) {
    var y = yearOf(state.t);
    if (!state.hasMonth) return String(y);
    var m = monthOf(state.t);
    return y + '-' + (m < 10 ? '0' : '') + m;
  }

  function periodLabel(snap) {
    return snap.from === snap.to ? keyLabel(snap.from) : keyLabel(snap.from) + ' ~ ' + keyLabel(snap.to);
  }

  // 시대 띠 찾기
  function eraAt(eras, t) {
    for (var i = 0; i < eras.length; i++) {
      if (t >= startT(eras[i].from) && t <= endT(eras[i].to)) return eras[i];
    }
    return null;
  }

  // 재생할 때 들르는 지점
  //  - 시대 띠가 바뀌는 때(kind "era"): 잠깐 멈춘다
  //  - 스냅샷 시작(kind "snapshot"): 멈추지 않고 지나가되, 같은 해 안의 장면도 한 장씩 그린다
  function playStops(snaps, eras) {
    var byT = {};
    snaps.forEach(function (s, i) {
      byT[s.keyT] = { t: s.keyT, idx: i, hasMonth: s.keyHasMonth, kind: 'snapshot' };
    });
    (eras || []).forEach(function (e, i) {
      if (i === 0) return; // 첫 시대는 재생 시작점
      var t = startT(e.from);
      var idx = indexAtT(snaps, t);
      if (idx < 0) return;
      var hasMonth = parseKey(e.from).m !== null;
      if (byT[t]) byT[t].kind = 'era';
      else byT[t] = { t: t, idx: idx, hasMonth: hasMonth, kind: 'era' };
    });
    return Object.keys(byT).map(function (k) { return byT[k]; }).sort(function (a, b) { return a.t - b.t; });
  }

  /*
   * 연도 ↔ 막대 위치(0~1) 변환. 시대 띠마다 너비 몫(weight)만큼 자리를 주고, 띠 안에서는 시간을 고르게 나눈다.
   * 슬라이더·눈금·시대 띠·장면 틱·재생이 모두 이 변환만 쓴다. '넘기는 막대' 방식으로 바꿀 때도 여기만 고치면 된다.
   * 범위 [minT, maxT] 밖으로 나간 띠는 잘라 내고, 잘린 만큼 몫도 줄인다.
   */
  function makeScale(eras, minT, maxT) {
    var bands = [];
    eras.forEach(function (e) {
      var a0 = startT(e.from), b0 = endT(e.to) + 1;
      var a = Math.max(minT, a0), b = Math.min(maxT + 1, b0);
      if (b <= a) return;
      bands.push({ era: e, a: a, b: b, w: (e.weight || 1) * (b - a) / (b0 - a0) });
    });
    var total = bands.reduce(function (s, x) { return s + x.w; }, 0), acc = 0;
    bands.forEach(function (x) { x.f0 = acc / total; acc += x.w; x.f1 = acc / total; });
    bands[bands.length - 1].f1 = 1;

    // 월 번호 → 위치 (그달이 시작하는 자리)
    function tToFrac(t) {
      t = Math.max(minT, Math.min(maxT + 1, t));
      for (var i = 0; i < bands.length; i++) {
        var x = bands[i];
        if (t < x.b || i === bands.length - 1) return x.f0 + ((t - x.a) / (x.b - x.a)) * (x.f1 - x.f0);
      }
      return 1;
    }
    // 위치 → 그 자리가 속한 달의 월 번호
    function fracToT(f) {
      f = Math.max(0, Math.min(1, f));
      for (var i = 0; i < bands.length; i++) {
        var x = bands[i];
        if (f < x.f1 || i === bands.length - 1) {
          var t = x.a + Math.floor(((f - x.f0) / (x.f1 - x.f0)) * (x.b - x.a) + 1e-9);
          return Math.max(x.a, Math.min(x.b - 1, t));
        }
      }
      return maxT;
    }
    return {
      bands: bands, minT: minT, maxT: maxT, tToFrac: tToFrac, fracToT: fracToT,
      yearToFrac: function (y) { return tToFrac(yearT(y)); },
      fracToYear: function (f) { return yearOf(fracToT(f)); },
    };
  }

  var Model = {
    MIN_YEAR: MIN_YEAR, MAX_YEAR: MAX_YEAR,
    parseKey: parseKey, startT: startT, endT: endT, yearOf: yearOf, monthOf: monthOf,
    yearT: yearT, nextYear: nextYear, yearText: yearText, keyLabel: keyLabel, fileKey: fileKey, keyOfFileKey: keyOfFileKey,
    makeScale: makeScale,
    featureStartT: featureStartT, featureEndT: featureEndT,
    prepare: prepare, indexAtT: indexAtT, stateForYear: stateForYear, stateForIndex: stateForIndex,
    stateForParam: stateForParam, step: step, isVisible: isVisible, visibleFeatures: visibleFeatures,
    edgeStyle: edgeStyle, label: label, keyParam: keyParam, periodLabel: periodLabel, eraAt: eraAt,
    playStops: playStops,
  };
  root.Model = Model;
})(typeof window !== 'undefined' ? window : globalThis);
