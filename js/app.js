/*
 * 화면 동작: 타임라인(슬라이더·재생·속도·이전/다음), 범례, 오른쪽 패널, 키보드, 딥링크
 * 수준: ?level=middle 이면 중등 글, 아니면 초등 글(화면 안에 전환 버튼은 없다).
 * 저장하는 것은 localStorage의 "직전 시점" 하나뿐이다(수준마다 따로, 실패하면 조용히 무시).
 */
(function () {
  'use strict';

  var A = window.ATLAS;
  var snaps = Model.prepare(A.snapshots);
  var MIN_T = Model.yearT(Model.MIN_YEAR);
  var MAX_T = Model.yearT(Model.MAX_YEAR, 12);
  // 연도↔막대 위치 변환 (시대 띠 너비 몫). 막대 위의 모든 위치는 이것만 쓴다.
  var scale = Model.makeScale(A.eras, MIN_T, MAX_T);
  var LEVEL = Model.levelFromSearch(location.search);
  var STORE_KEY = LEVEL === 'middle' ? 'hist-timeline:last:middle' : 'hist-timeline:last';
  // 수준마다 다른 화면 문구
  var UI = {
    elementary: { disputed: '점선 부분은 학자마다 생각이 달라요.' },
    middle: { disputed: '점선은 학설이 갈리는 경계입니다.' },
  }[LEVEL];
  function txt(snap) { return snap[LEVEL] || snap.elementary; }
  function intro(pol) { return Model.pick(pol && pol.intro, LEVEL) || ''; }
  var SPEEDS = [0.5, 1, 2, 4];
  var SECONDS_PER_TRACK = 90; // 1배속에서 막대 끝까지 움직이는 시간(멈춤 제외)

  var $ = function (id) { return document.getElementById(id); };
  var app = $('app');
  var svg = $('map');
  var map = new MapView(svg, $('map-labels'), A);

  var state = null;
  var renderedSig = '';
  var pinned = null; // 탭·클릭으로 고정한 나라
  var hoverName = null;
  var playing = false;
  var speedIdx = 1;
  var stops = Model.playStops(snaps, A.eras);

  // ---------- 시작 상태 ----------
  function initialState() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('year'); } catch (e) { /* 무시 */ }
    var st = q ? Model.stateForParam(snaps, q) : null;
    if (st) return st;
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved) st = Model.stateForParam(snaps, saved);
    } catch (e) { /* 저장소를 못 쓰면 무시 */ }
    return st || Model.stateForYear(snaps, Model.MIN_YEAR);
  }

  // ---------- 타임라인 그리기 ----------
  function frac(t) { return scale.tToFrac(t); }

  function buildTimeline() {
    var bands = $('bands');
    bands.textContent = '';
    scale.bands.forEach(function (x) {
      var e = x.era;
      var d = document.createElement('div');
      d.className = 'band';
      d.style.width = (x.f1 - x.f0) * 100 + '%';
      d.style.background = e.color;
      d.title = e.name;
      d.dataset.id = e.id;
      var s = document.createElement('span');
      s.textContent = e.short;
      d.appendChild(s);
      bands.appendChild(d);
    });
    var ticks = $('ticks');
    ticks.textContent = '';
    snaps.forEach(function (s) {
      var t = document.createElement('div');
      t.className = 'tick';
      t.style.left = frac(s.keyT) * 100 + '%';
      ticks.appendChild(t);
    });
    layoutAxis();
  }

  // 연도 눈금: 시대 띠마다 따로, 띠 너비에 맞는 간격으로 찍고 겹치는 것은 뺀다
  var AXIS_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  function layoutAxis() {
    var axis = $('axis');
    axis.textContent = '';
    var w = $('track').clientWidth;
    var placed = [];
    scale.bands.forEach(function (x) {
      var y0 = Model.yearOf(x.a), y1 = Model.yearOf(x.b - 1);
      var px = (x.f1 - x.f0) * w;
      var pxPerYear = px / ((x.b - x.a) / 12);
      var minGap = y0 < 0 ? 84 : 46;
      var step = AXIS_STEPS.find(function (st) { return st * pxPerYear >= minGap; }) || 1000;
      var first = Math.ceil(y0 / step) * step;
      for (var y = first; y <= y1; y += step) {
        if (y === 0) continue;
        var at = frac(Model.yearT(y)) * w;
        var s = document.createElement('span');
        s.textContent = Model.yearText(y);
        s.style.left = (at / w) * 100 + '%';
        axis.appendChild(s);
        var half = s.offsetWidth / 2 + 4;
        var hit = at - half < 0 || at + half > w || placed.some(function (q) { return at - half < q[1] && at + half > q[0]; });
        if (hit) axis.removeChild(s); else placed.push([at - half, at + half]);
      }
    });
    // 밴드 이름이 칸보다 길면 숨긴다
    Array.prototype.forEach.call($('bands').children, function (b) {
      b.firstChild.style.visibility = b.clientWidth < b.firstChild.scrollWidth + 4 ? 'hidden' : '';
    });
  }

  // ---------- 상태 적용 ----------
  function prevFeaturesFor(idx) {
    if (idx <= 0) return [];
    var p = snaps[idx - 1];
    return Model.visibleFeatures(p, p.toT);
  }

  function setState(st, opts) {
    if (!st || st.idx < 0) return;
    opts = opts || {};
    state = st;
    var snap = snaps[st.idx];
    var vis = Model.visibleFeatures(snap, st.t);
    var sig = st.idx + '|' + vis.map(function (f) { return snap.features.indexOf(f); }).join(',');
    if (sig !== renderedSig) {
      var newSnap = renderedSig.split('|')[0] !== String(st.idx);
      renderedSig = sig;
      map.render(vis, prevFeaturesFor(st.idx));
      renderLegend(vis);
      if (newSnap) renderPanel(snap);
      else markCurrentEvent();
    } else {
      markCurrentEvent();
    }
    renderTime();
    if (!opts.silent) remember();
  }

  function renderTime() {
    var label = Model.label(state);
    var x = frac(state.t);
    var trackW = $('track').clientWidth;
    $('thumb').style.left = x * 100 + '%';
    var bubble = $('bubble');
    bubble.textContent = label;
    var bw = bubble.offsetWidth;
    var px = Math.max(bw / 2, Math.min(trackW - bw / 2, x * trackW));
    bubble.style.left = px + 'px';
    $('top-time').textContent = label;
    var tr = $('track');
    tr.setAttribute('aria-valuenow', Model.yearOf(state.t));
    tr.setAttribute('aria-valuemin', Model.MIN_YEAR);
    tr.setAttribute('aria-valuemax', Model.MAX_YEAR);
    tr.setAttribute('aria-valuetext', label + ', ' + txt(snaps[state.idx]).caption);
    var era = Model.eraAt(A.eras, state.t);
    ['top-era', 'panel-era'].forEach(function (id) {
      var e = $(id);
      e.textContent = era ? era.name : '';
      e.style.background = era ? era.color : '';
    });
    Array.prototype.forEach.call($('bands').children, function (b) {
      b.classList.toggle('current', !!era && b.dataset.id === era.id);
    });
    $('prev').disabled = state.idx === 0 && state.t <= snaps[0].keyT;
    $('next').disabled = state.idx === snaps.length - 1;
  }

  var rememberTimer = null;
  function remember() {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(function () {
      var key = Model.keyParam(state);
      try { localStorage.setItem(STORE_KEY, key); } catch (e) { /* 무시 */ }
      try { history.replaceState(null, '', Model.search(LEVEL, key)); } catch (e) { /* file:// 등에서 막히면 무시 */ }
    }, 300);
  }

  // ---------- 범례 ----------
  function renderLegend(vis) {
    var list = $('legend-list'), nb = $('legend-neighbors');
    list.textContent = '';
    nb.textContent = '';
    var seen = {};
    vis.forEach(function (f) {
      var p = f.properties;
      if (p.fillAs || seen[p.name]) return;
      seen[p.name] = true;
      var pol = A.polities[p.name] || {};
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.className = 'lg-item ' + p.role;
      b.dataset.name = p.name;
      var sw = document.createElement('span');
      sw.className = 'swatch' + (pol.pattern === 'hatch' ? ' hatch' : '') + (p.kind === 'line' ? ' line' : '');
      sw.style.background = p.role === 'neighbor' ? '#9b9b9b' : pol.color;
      if (pol.pattern === 'hatch') sw.style.backgroundColor = pol.color;
      b.appendChild(sw);
      b.appendChild(document.createTextNode(p.name));
      b.setAttribute('aria-pressed', pinned === p.name ? 'true' : 'false');
      b.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') hover(p.name); });
      b.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') hover(null); });
      b.addEventListener('focus', function () { hover(p.name); });
      b.addEventListener('blur', function () { hover(null); });
      b.addEventListener('click', function () { togglePin(p.name); });
      li.appendChild(b);
      (p.role === 'neighbor' ? nb : list).appendChild(li);
    });
    nb.style.display = nb.children.length ? '' : 'none';
    if (pinned && !seen[pinned]) unpin();
    applyHighlight();
  }

  function hover(name) { hoverName = name; applyHighlight(); }
  function applyHighlight() {
    var name = pinned || hoverName;
    map.setHighlight(name);
    Array.prototype.forEach.call(document.querySelectorAll('.lg-item'), function (b) {
      b.classList.toggle('hl', b.dataset.name === name);
      b.setAttribute('aria-pressed', b.dataset.name === pinned ? 'true' : 'false');
    });
  }
  function togglePin(name) {
    if (pinned === name) { unpin(); return; }
    pinned = name;
    showPolity(name);
    applyHighlight();
  }
  function unpin() {
    pinned = null;
    $('polity-box').hidden = true;
    applyHighlight();
  }
  function showPolity(name) {
    var pol = A.polities[name] || {};
    var f = snaps[state.idx].features.find(function (x) { return x.properties.name === name; });
    var role = f ? f.properties.role : 'korea';
    $('polity-name').textContent = name;
    var sw = $('polity-swatch');
    sw.className = 'swatch' + (pol.pattern === 'hatch' ? ' hatch' : '');
    sw.style.backgroundColor = role === 'neighbor' ? '#9b9b9b' : pol.color || '#888';
    $('polity-intro').textContent = intro(pol);
    $('polity-box').hidden = false;
    if (app.classList.contains('panel-closed')) { app.classList.add('animate'); setPanel(true); }
  }

  // ---------- 오른쪽 패널 ----------
  function renderPanel(snap) {
    var x = txt(snap);
    $('panel-caption').textContent = x.caption;
    $('panel-period').textContent = Model.periodLabel(snap);
    $('panel-summary').textContent = x.summary;
    var ol = $('panel-events');
    ol.textContent = '';
    x.events.forEach(function (ev) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.dataset.year = ev.year;
      var y = document.createElement('span');
      y.className = 'ev-year';
      var p = Model.parseKey(ev.year);
      y.textContent = Model.yearText(p.y) + (p.m ? '.' + p.m : '');
      if (p.y < 0) y.classList.add('bc');
      var t = document.createElement('span');
      t.textContent = ev.text;
      b.appendChild(y);
      b.appendChild(t);
      b.setAttribute('aria-label', Model.keyLabel(ev.year) + ': ' + ev.text + ' — 이때로 가기');
      b.addEventListener('click', function () {
        stopPlay();
        dismissHint();
        var st = p.m ? Model.stateForParam(snaps, ev.year) : Model.stateForYear(snaps, p.y);
        // 사건의 해가 다른 장면 범위에 있으면 그 장면으로, 아니면 지금 장면 안에서 그해로
        if (!p.m && st.idx !== state.idx) {
          var t2 = Model.yearT(p.y);
          var i2 = Model.indexAtT(snaps, t2);
          if (i2 >= 0) st = { idx: i2, t: Math.max(t2, snaps[i2].fromT), hasMonth: false };
        }
        setState(st);
      });
      li.appendChild(b);
      ol.appendChild(li);
    });
    var qs = $('panel-questions');
    qs.textContent = '';
    x.questions.forEach(function (q, i) {
      var d = document.createElement('details');
      var s = document.createElement('summary');
      s.textContent = '질문 ' + (i + 1);
      var pEl = document.createElement('p');
      pEl.textContent = q;
      d.appendChild(s);
      d.appendChild(pEl);
      qs.appendChild(d);
    });
    $('panel').querySelector('.panel-inner').scrollTop = 0;
    markCurrentEvent();
  }

  function markCurrentEvent() {
    var y = Model.yearOf(state.t), m = Model.monthOf(state.t);
    Array.prototype.forEach.call($('panel-events').querySelectorAll('button'), function (b) {
      var p = Model.parseKey(b.dataset.year);
      b.classList.toggle('current', p.y === y && (!p.m || !state.hasMonth || p.m === m));
    });
  }

  function setPanel(open) {
    app.classList.toggle('panel-closed', !open);
    var t = $('panel-toggle');
    t.setAttribute('aria-expanded', open ? 'true' : 'false');
    t.setAttribute('aria-label', open ? '설명 패널 접기' : '설명 패널 펼치기');
  }

  // ---------- 툴팁 ----------
  var tipTimer = null;
  function showTip(f, x, y, autoHide) {
    var tip = $('tooltip');
    var p = f.properties;
    var pol = A.polities[p.name] || {};
    tip.innerHTML = '';
    var s = document.createElement('strong');
    s.textContent = p.name;
    tip.appendChild(s);
    tip.appendChild(document.createTextNode(intro(pol)));
    if (p.confidence === '논쟁') {
      var n = document.createElement('div');
      n.style.marginTop = '4px';
      n.style.opacity = '0.85';
      n.textContent = UI.disputed;
      tip.appendChild(n);
    }
    tip.hidden = false;
    var r = $('map-wrap').getBoundingClientRect();
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = Math.min(r.width - tw - 8, Math.max(8, x - r.left + 14));
    var top = y - r.top + 14;
    if (top + th > r.height - 8) top = y - r.top - th - 14;
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, top) + 'px';
    clearTimeout(tipTimer);
    if (autoHide) tipTimer = setTimeout(hideTip, 3500);
  }
  function hideTip() { $('tooltip').hidden = true; }

  map.on('hover', function (f, x, y) { hover(f.properties.name); showTip(f, x, y, false); });
  map.on('leave', function () { hover(null); hideTip(); });
  map.on('gesture', function () { hideTip(); });
  map.on('tap', function (f, x, y) {
    if (!f) { unpin(); hideTip(); return; }
    var name = f.properties.name;
    pinned = name;
    showPolity(name);
    applyHighlight();
    showTip(f, x, y, true);
  });

  // ---------- 슬라이더 ----------
  function stateAtClientX(clientX) {
    var r = $('track').getBoundingClientRect();
    var x = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return Model.stateForYear(snaps, scale.fracToYear(x));
  }
  (function bindTrack() {
    var tr = $('track'), dragging = false;
    tr.addEventListener('pointerdown', function (e) {
      dragging = true;
      stopPlay();
      dismissHint();
      try { tr.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
      setState(stateAtClientX(e.clientX));
      e.preventDefault();
    });
    tr.addEventListener('pointermove', function (e) { if (dragging) setState(stateAtClientX(e.clientX)); });
    function up() { dragging = false; }
    tr.addEventListener('pointerup', up);
    tr.addEventListener('pointercancel', up);
  })();

  // ---------- 이전/다음 ----------
  function step(dir) {
    stopPlay();
    dismissHint();
    setState(Model.step(snaps, state, dir));
  }
  $('prev').addEventListener('click', function () { step(-1); });
  $('next').addEventListener('click', function () { step(1); });

  // ---------- 재생 ----------
  var cursor = 0, holdUntil = 0, nextStop = 0, lastTs = 0, raf = 0; // cursor: 막대 위치(0~1)

  function startPlay() {
    if (state.idx === snaps.length - 1) setState(Model.stateForYear(snaps, Model.MIN_YEAR));
    playing = true;
    cursor = frac(state.t);
    nextStop = stops.findIndex(function (s) { return s.t > state.t; });
    if (nextStop < 0) nextStop = stops.length;
    holdUntil = performance.now() + 500;
    lastTs = 0;
    updatePlayBtn();
    raf = requestAnimationFrame(tick);
  }
  function stopPlay() {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(raf);
    updatePlayBtn();
    remember();
  }
  function togglePlay() { dismissHint(); if (playing) stopPlay(); else startPlay(); }
  function updatePlayBtn() {
    var b = $('play');
    b.textContent = playing ? '❚❚' : '▶';
    b.setAttribute('aria-label', playing ? '정지' : '재생');
  }
  function tick(ts) {
    if (!playing) return;
    var dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    var speed = SPEEDS[speedIdx];
    if (ts >= holdUntil) {
      // 막대 위를 고른 빠르기로 지나간다(시대 띠가 좁으면 그 시대는 빨리 지나감)
      cursor += (dt * speed) / SECONDS_PER_TRACK;
      var stop = stops[nextStop];
      if (stop && cursor >= frac(stop.t)) {
        cursor = frac(stop.t);
        nextStop++;
        setState({ idx: stop.idx, t: stop.t, hasMonth: stop.hasMonth }, { silent: true });
        // 시대가 바뀔 때만 멈춘다. 장면이 바뀌는 지점은 그리고 바로 지나간다.
        holdUntil = stop.kind === 'era' ? ts + 1800 / Math.sqrt(speed) : ts;
      } else if (cursor >= frac(MAX_T)) {
        setState(Model.stateForIndex(snaps, snaps.length - 1));
        stopPlay();
        return;
      } else {
        var t = scale.fracToT(cursor);
        var idx = Model.indexAtT(snaps, t);
        if (idx >= 0 && Model.yearOf(t) !== Model.yearOf(state.t)) setState({ idx: idx, t: Model.yearT(Model.yearOf(t)), hasMonth: false }, { silent: true });
      }
    }
    raf = requestAnimationFrame(tick);
  }
  $('play').addEventListener('click', togglePlay);
  $('speed').addEventListener('click', function () {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    var v = SPEEDS[speedIdx];
    var b = $('speed');
    b.textContent = v + '×';
    b.setAttribute('aria-label', '재생 빠르기 ' + v + '배');
  });

  // ---------- 키보드 ----------
  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      step(e.key === 'ArrowLeft' ? -1 : 1);
    } else if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'Escape') {
      unpin();
      hideTip();
    }
  });

  // ---------- 그 밖의 조작 ----------
  function dismissHint() { $('hint').hidden = true; }
  $('hint-close').addEventListener('click', dismissHint);
  $('prev-toggle').addEventListener('change', function (e) { map.setShowPrev(e.target.checked); });
  $('legend-toggle').addEventListener('click', function () {
    var c = $('legend').classList.toggle('collapsed');
    $('legend-toggle').setAttribute('aria-expanded', c ? 'false' : 'true');
  });
  $('polity-close').addEventListener('click', unpin);
  $('panel-toggle').addEventListener('click', function () {
    app.classList.add('animate'); // 처음 열 때나 창 크기가 바뀔 때는 움직임 없이
    setPanel(app.classList.contains('panel-closed'));
  });
  $('zoom-in').addEventListener('click', function () { map.zoomBy(1.4); });
  $('zoom-out').addEventListener('click', function () { map.zoomBy(1 / 1.4); });
  $('zoom-reset').addEventListener('click', function () { map.fit(); });

  var resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { map.fit(); layoutAxis(); renderTime(); }, 60);
  }
  if (window.ResizeObserver) new ResizeObserver(onResize).observe($('map-wrap'));
  else window.addEventListener('resize', onResize);
  // 좁은 화면에서는 범례를 접어 둔다
  if ($('map-wrap').clientHeight < 460) $('legend').classList.add('collapsed');

  // ---------- 시작 ----------
  if (LEVEL === 'middle') {
    $('level-badge').hidden = false;
    document.title += ' (중학교)';
  }
  buildTimeline();
  map.fit();
  setState(initialState());
})();
