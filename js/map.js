/*
 * 지도 그리기: 메르카토르 투영 + SVG (라이브러리 없음)
 * - 나라 면은 육지 모양으로 잘라(clipPath) 해안선은 또렷하게, 내륙 경계는 흐리게(blur) 그린다.
 * - confidence "논쟁" 도형은 Model.edgeStyle 규칙대로 점선 테두리를 덧그린다.
 * - 이름표는 확대해도 글자 크기가 변하지 않도록 화면 좌표의 HTML로 올린다.
 * - kind "zone"(간도처럼 영토가 아닌 영역)은 영토 색 대신 옅은 빗금과 점선으로만 그린다.
 * - 지도가 바뀔 때는 바뀐 땅만 움직인다. 좌표가 같은 조각은 같은 땅으로 보고,
 *   주인이 바뀌면 색만 옛 나라 색에서 새 나라 색으로 넘어가고(테두리가 한 번 반짝임),
 *   새로 생긴 조각은 나타나고 없어진 조각은 서서히 사라진다. 그대로인 땅은 움직이지 않는다.
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var BBOX = [115, 32, 135, 48];
  var DEG = Math.PI / 180;
  var K = 1000 / ((BBOX[2] - BBOX[0]) * DEG); // 세계 좌표: 가로 1000
  function mercY(lat) { return Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2)); }
  var Y0 = mercY(BBOX[3]);
  function project(p) { return [(p[0] - BBOX[0]) * DEG * K, (Y0 - mercY(p[1])) * K]; }
  var WORLD_H = (Y0 - mercY(BBOX[1])) * K;

  var NEIGHBOR_FILL = '#9b9b9b';
  var DEFAULT_VIEW = [119.3, 33.0, 134.2, 47.2]; // 처음 보이는 범위 (경도·위도)

  function el(name, attrs, parent) {
    var e = document.createElementNS(NS, name);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function f1(v) { return Math.round(v * 10) / 10; }
  function ringD(r) {
    var s = '';
    for (var i = 0; i < r.length; i++) { var q = project(r[i]); s += (i ? 'L' : 'M') + f1(q[0]) + ',' + f1(q[1]); }
    return s + 'Z';
  }
  function lineD(l) {
    var s = '';
    for (var i = 0; i < l.length; i++) { var q = project(l[i]); s += (i ? 'L' : 'M') + f1(q[0]) + ',' + f1(q[1]); }
    return s;
  }
  function rings(g) {
    if (g.type === 'Polygon') return g.coordinates;
    if (g.type === 'MultiPolygon') return g.coordinates.reduce(function (a, p) { return a.concat(p); }, []);
    return [];
  }
  function geomD(g) { return rings(g).map(ringD).join(''); }
  function ringArea(r) {
    var a = 0;
    for (var i = 0; i < r.length - 1; i++) { var p = project(r[i]), q = project(r[i + 1]); a += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(a / 2);
  }
  function geomArea(g) { return rings(g).reduce(function (s, r) { return s + ringArea(r); }, 0); }

  // 같은 이름 조각들의 바깥 테두리만 남긴다 (공유 변은 지움)
  function edgeKeys(features) {
    var set = new Set();
    features.forEach(function (f) {
      rings(f.geometry).forEach(function (r) {
        for (var i = 0; i < r.length - 1; i++) {
          var a = r[i][0] + ',' + r[i][1], b = r[i + 1][0] + ',' + r[i + 1][1];
          set.add(a + '>' + b); set.add(b + '>' + a);
        }
      });
    });
    return set;
  }
  function outlineD(features, skip) {
    var edges = new Map();
    features.forEach(function (f) {
      rings(f.geometry).forEach(function (r) {
        for (var i = 0; i < r.length - 1; i++) {
          var a = r[i][0] + ',' + r[i][1], b = r[i + 1][0] + ',' + r[i + 1][1];
          if (edges.has(b + '>' + a)) edges.delete(b + '>' + a);
          else edges.set(a + '>' + b, [r[i], r[i + 1]]);
        }
      });
    });
    // 지금 장면에도 그대로 있는 변은 빼서, 바뀐 경계만 남긴다
    if (skip) edges.forEach(function (e, key) { if (skip.has(key)) edges.delete(key); });
    // 이어진 변끼리 묶어 점선이 고르게 이어지게 한다
    var next = new Map();
    edges.forEach(function (e) { next.set(e[0][0] + ',' + e[0][1], e); });
    var used = new Set(), d = '';
    edges.forEach(function (e, key) {
      if (used.has(key)) return;
      var cur = e, pts = [e[0]];
      while (cur && !used.has(cur[0][0] + ',' + cur[0][1] + '>' + cur[1][0] + ',' + cur[1][1])) {
        used.add(cur[0][0] + ',' + cur[0][1] + '>' + cur[1][0] + ',' + cur[1][1]);
        pts.push(cur[1]);
        cur = next.get(cur[1][0] + ',' + cur[1][1]);
      }
      d += lineD(pts);
    });
    return d;
  }

  function MapView(svg, labelsEl, atlas) {
    this.svg = svg;
    this.labelsEl = labelsEl;
    this.atlas = atlas;
    this.view = { s: 1, tx: 0, ty: 0 };
    this.fitScale = 1;
    this.handlers = {};
    this.labels = [];
    this.islets = [];
    this.highlight = null;
    this.showPrev = true;
    this._build();
    this._bindGestures();
  }

  MapView.prototype.on = function (ev, fn) { this.handlers[ev] = fn; };
  MapView.prototype._emit = function (ev, a, b, c) { if (this.handlers[ev]) this.handlers[ev](a, b, c); };

  MapView.prototype._build = function () {
    var svg = this.svg;
    var defs = el('defs', null, svg);
    var landD = this.atlas.land.map(function (poly) { return ringD(poly[0]); }).join('');
    var clip = el('clipPath', { id: 'land-clip', clipPathUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: landD }, clip);
    var filt = el('filter', { id: 'soft', x: '-10%', y: '-10%', width: '120%', height: '120%', 'color-interpolation-filters': 'sRGB' }, defs);
    this.blur = el('feGaussianBlur', { stdDeviation: '2' }, filt);
    this.defs = defs;

    this.root = el('g', { id: 'viewport' }, svg);
    // 바탕 지도 범위(경도 115~135°, 위도 32~48°) 바깥은 종이색으로 둔다
    el('rect', { class: 'outside', x: -3000, y: -3000, width: 7000, height: 7000 }, this.root);
    el('rect', { class: 'sea', x: 0, y: 0, width: 1000, height: f1(WORLD_H) }, this.root);
    el('path', { class: 'land', d: landD }, this.root);
    var rv = el('g', { class: 'rivers' }, this.root);
    this.atlas.rivers.forEach(function (r) {
      el('path', { class: 'river' + (r.schematic ? ' schematic' : ''), d: r.lines.map(lineD).join('') }, rv);
    });
    var clipped = el('g', { 'clip-path': 'url(#land-clip)' }, this.root);
    this.gFill = el('g', { class: 'fills' }, clipped);
    this.gGhost = el('g', { class: 'ghosts' }, clipped); // 사라지는 조각(잠깐)
    // 지형 음영: 바탕 지도 범위(경도 115~135°, 위도 32~48°)를 메르카토르로 편 회색+알파 이미지(data/hillshade.png).
    // 나라 색 위, 경계선 아래에 얹어 색과 경계는 그대로 두고 산줄기만 드러낸다
    this.relief = el('image', { class: 'relief', href: 'data/hillshade.png', x: 0, y: 0, width: 1000, height: WORLD_H, preserveAspectRatio: 'none' }, clipped);
    this.gEdges = el('g', { class: 'edges' }, clipped);
    this.gFx = el('g', { class: 'fx' }, clipped); // 바뀐 땅 테두리 반짝임(잠깐)
    this.gPrev = el('g', { class: 'prev' }, clipped);
    this.gLines = el('g', { class: 'lines' }, clipped);
    this.gHl = el('g', { class: 'hl' }, clipped);
    this.gScreen = el('g', { class: 'screen' }, svg); // 화면 좌표(작은 섬 표시)
    this.gPoints = el('g', { class: 'points' }, svg); // 화면 좌표(도읍·전투 점)
    this.gFlash = el('g', { class: 'flashes' }, svg); // 화면 좌표(사건 자리 반짝임)
    this.points = [];
  };

  /*
   * 도읍·전투 점: 그 시점에 보이는 점만 받는다. 표시는 화면 좌표라 확대해도 크기가 같다.
   * 보이는 표시(도읍 네모, 전투 동그라미)와 별도로 지름 48px의 투명한 터치 영역을 둔다.
   * 위치 학설이 갈리는 점(confidence "논쟁")은 점선 테두리로 그린다.
   */
  MapView.prototype.setPoints = function (points) {
    var sig = points.map(function (f) { return f.properties.name + f.properties.start; }).join('|');
    if (sig === this._pointSig) return;
    this._pointSig = sig;
    this.points = points;
    var g = this.gPoints;
    g.textContent = '';
    this.pointEls = points.map(function (f) {
      var p = f.properties;
      var grp = el('g', { class: 'pt ' + (p.kind === '도읍' ? 'capital' : 'battle') + (p.confidence === '논쟁' ? ' disputed' : '') }, g);
      var mark = p.kind === '도읍'
        ? el('rect', { x: -6.5, y: -6.5, width: 13, height: 13, rx: 2 }, grp)
        : el('circle', { r: 7 }, grp);
      if (p.confidence === '논쟁') mark.setAttribute('stroke-dasharray', '3 2');
      if (p.kind === '전투') el('path', { class: 'x', d: 'M-3.2,-3.2L3.2,3.2M3.2,-3.2L-3.2,3.2' }, grp);
      var hit = el('circle', { class: 'hit', r: 24 }, grp);
      hit.__point = f;
      return { el: grp, w: project(f.geometry.coordinates) };
    });
    this._buildLabels();
    this._applyView();
  };

  MapView.prototype._color = function (name, role) {
    var p = this.atlas.polities[name];
    if (role === 'neighbor') return NEIGHBOR_FILL;
    return (p && p.color) || '#888';
  };

  MapView.prototype._hatch = function (color) {
    var id = 'hatch-' + color.replace('#', '');
    if (!this.defs.querySelector('#' + id)) {
      var pat = el('pattern', { id: id, patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: 'rotate(45)' }, this.defs);
      el('rect', { width: 6, height: 6, fill: color }, pat);
      el('rect', { width: 2.4, height: 6, fill: '#ffffff', 'fill-opacity': '0.55' }, pat);
    }
    return 'url(#' + id + ')';
  };

  // 영토가 아닌 영역: 투명 바탕에 가는 빗금만
  MapView.prototype._zoneHatch = function (color) {
    var id = 'zone-' + color.replace('#', '');
    if (!this.defs.querySelector('#' + id)) {
      var pat = el('pattern', { id: id, patternUnits: 'userSpaceOnUse', width: 7, height: 7, patternTransform: 'rotate(45)' }, this.defs);
      el('rect', { width: 1.6, height: 7, fill: color }, pat);
    }
    return 'url(#' + id + ')';
  };

  // 조각을 알아보는 열쇠: 좌표가 같으면 같은 땅
  function sigOf(f) {
    if (!f.__sig) Object.defineProperty(f, '__sig', { value: JSON.stringify(f.geometry.coordinates) });
    return f.__sig;
  }
  var ENTER_MS = 500, COLOR_MS = 700, PULSE_MS = 1100;
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function canAnimate(node) { return typeof node.animate === 'function'; }
  // 애니메이션이 끝나면 지운다(창이 가려져 애니메이션 시계가 멈춰도 타이머로 한 번 더)
  function removeLater(node, a, ms) {
    function rm() { if (node.parentNode) node.parentNode.removeChild(node); }
    a.onfinish = rm;
    setTimeout(rm, ms + 200);
  }

  /*
   * 그리기
   *   features: 지금 보이는 도형
   *   prevFeatures: 바로 앞 스냅샷의 마지막 모습 (점선)
   *   opts.sceneChanged: 장면이 바뀌었는가 (같은 장면 안에서 조각만 바뀌면 false)
   */
  MapView.prototype.render = function (features, prevFeatures, opts) {
    var self = this;
    opts = opts || {};
    [this.gFill, this.gEdges, this.gPrev, this.gLines, this.gHl, this.gGhost].forEach(function (g) { g.textContent = ''; });
    var anim = !!this.rendered && !reducedMotion() && canAnimate(this.svg);
    var last = this._lastPieces || new Map();
    var nowPieces = new Map();
    var pulses = [];
    this.labels = [];
    this.islets = [];
    this.groups = {};

    var areas = features.filter(function (f) { return f.properties.kind !== 'line'; });
    var lines = features.filter(function (f) { return f.properties.kind === 'line'; });

    // 이름별로 묶기 (주변 세력 먼저, 우리 역사 나라는 위에)
    var byName = new Map();
    areas.forEach(function (f) {
      var n = f.properties.name;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(f);
    });
    var names = Array.from(byName.keys()).sort(function (a, b) {
      var ra = byName.get(a)[0].properties.role === 'korea' ? 1 : 0;
      var rb = byName.get(b)[0].properties.role === 'korea' ? 1 : 0;
      return ra - rb;
    });

    // 주변 세력은 모두 같은 회색이다. 나라마다 따로 흐리면 맞닿은 경계에서 두 흐림이 겹쳐
    // 밝은 줄이 생기므로(예: 거란·여진), 한 묶음으로 모아 한 번만 흐린다
    var gNeighbors = el('g', { class: 'neighbors', filter: 'url(#soft)' }, self.gFill);

    names.forEach(function (name) {
      var fs = byName.get(name);
      var p0 = fs[0].properties;
      var colorName = p0.fillAs || name;
      var color = self._color(colorName, p0.role);
      var pol = self.atlas.polities[colorName] || {};
      var isZone = p0.kind === 'zone';
      var fill = isZone ? self._zoneHatch(color) : pol.pattern === 'hatch' ? self._hatch(color) : color;
      var gCls = 'polity ' + (isZone ? 'zone' : p0.role);
      var inNeighbors = p0.role === 'neighbor' && !isZone;
      var g = el('g', { class: gCls, 'data-name': name }, inNeighbors ? gNeighbors : self.gFill);
      if (!isZone && !inNeighbors) g.setAttribute('filter', 'url(#soft)');
      self.groups[name] = { g: g, features: fs, color: color, role: p0.role, fillAs: p0.fillAs || null };
      fs.forEach(function (f) {
        var d = geomD(f.geometry);
        var path = el('path', { d: d, fill: fill }, g);
        path.__feature = f;
        var sig = sigOf(f);
        nowPieces.set(sig, { d: d, fill: fill, cls: gCls, soft: !isZone });
        if (!anim) return;
        var old = last.get(sig);
        if (!old) {
          // 새로 생긴 조각: 나타난다. 같은 장면 안에서 생긴 우리 역사 나라 땅이면 테두리도 반짝인다
          path.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ENTER_MS, easing: 'ease-out' });
          if (!opts.sceneChanged && p0.role === 'korea' && !isZone && !p0.fillAs) pulses.push({ d: d, color: color });
        } else if (old.fill !== fill) {
          // 같은 땅의 주인이 바뀜: 색이 넘어간다(무늬 칠은 겹쳐 바뀜)
          if (old.fill.indexOf('url(') < 0 && fill.indexOf('url(') < 0) {
            path.animate([{ fill: old.fill }, { fill: fill }], { duration: COLOR_MS, easing: 'ease-in-out' });
          } else {
            path.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ENTER_MS, easing: 'ease-out' });
            self._ghost(old);
          }
          if (p0.role === 'korea' && !isZone && !p0.fillAs) pulses.push({ d: d, color: color });
        }
      });
      // 논쟁 도형: 점선 테두리 (Model.edgeStyle 규칙)
      fs.forEach(function (f) {
        var st = Model.edgeStyle(f);
        if (!st.dashed) return;
        el('path', {
          class: 'edge disputed', d: geomD(f.geometry), stroke: p0.role === 'neighbor' ? '#666' : shade(color, -0.35),
          'stroke-dasharray': st.dasharray,
        }, self.gEdges);
      });

      // 이름표: 보이는 조각 중 가장 큰 조각의 anchor
      var best = fs.reduce(function (a, f) { var ar = geomArea(f.geometry); return !a || ar > a.ar ? { f: f, ar: ar } : a; }, null);
      var isIslet = !!p0.fillAs;
      var lbl = { text: name, at: best.f.properties.anchor, cls: isIslet ? 'islet' : isZone ? 'zone' : p0.role, name: name };
      // 우리 역사 나라 이름표는 영역 넓이에 맞춰 크기를 정한다
      if (p0.role === 'korea' && !isIslet && !isZone) lbl.area = fs.reduce(function (s, f) { return s + geomArea(f.geometry); }, 0);
      self.labels.push(lbl);
      if (isIslet) self.labels[self.labels.length - 1].dy = name === '독도' ? 15 : -15;
      if (isIslet) {
        // 작은 섬은 화면에서 점으로도 보이게 한다
        var c = rings(fs[0].geometry)[0];
        var cx = 0, cy = 0;
        c.slice(0, -1).forEach(function (q) { cx += q[0]; cy += q[1]; });
        self.islets.push({ name: name, at: [cx / (c.length - 1), cy / (c.length - 1)], color: color, feature: fs[0] });
        self.labels[self.labels.length - 1].at = self.islets[self.islets.length - 1].at;
      }
    });

    // 없어진 조각은 서서히 사라지고, 바뀐 땅은 테두리가 한 번 반짝인다
    if (anim) {
      last.forEach(function (old, sig) { if (!nowPieces.has(sig)) self._ghost(old); });
      pulses.forEach(function (p) { self._pulse(p.d, p.color); });
    }
    this._lastPieces = nowPieces;

    // 바로 앞 스냅샷 경계 (우리 역사 나라만)
    if (prevFeatures && prevFeatures.length) {
      var prevBy = new Map();
      prevFeatures.forEach(function (f) {
        var p = f.properties;
        if (p.role !== 'korea' || p.kind || p.fillAs) return;
        if (!prevBy.has(p.name)) prevBy.set(p.name, []);
        prevBy.get(p.name).push(f);
      });
      var now = edgeKeys(areas.filter(function (f) { return f.properties.role === 'korea' && !f.properties.fillAs && !f.properties.kind; }));
      prevBy.forEach(function (fs) { el('path', { class: 'edge prev', d: outlineD(fs, now) }, self.gPrev); });
    }
    this.gPrev.style.display = this.showPrev ? '' : 'none';

    // 선 (38도선·전선·휴전선)
    lines.forEach(function (f) {
      var p = f.properties;
      var color = self._color(p.name, 'korea');
      el('path', { class: 'front', d: lineD(f.geometry.coordinates), stroke: color }, self.gLines);
      self.labels.push({ text: p.name, at: p.anchor, cls: 'line' + (color === '#222222' ? ' black' : ''), name: p.name });
    });

    // 바다·강 이름
    this.atlas.labels.forEach(function (l) { self.labels.push({ text: l.name, at: l.at, cls: l.kind }); });

    this.rendered = true; // 첫 화면은 바로 보이게, 그다음 장면부터 서서히 나타나게
    this._buildLabels();
    this._applyView();
    this.setHighlight(this.highlight && this.groups[this.highlight] ? this.highlight : null);
  };

  // 지난 그림의 조각을 잠깐 위에 두고 투명하게 만든 뒤 지운다
  MapView.prototype._ghost = function (old) {
    var g = el('g', { class: old.cls + ' ghost' }, this.gGhost);
    if (old.soft) g.setAttribute('filter', 'url(#soft)');
    el('path', { d: old.d, fill: old.fill }, g);
    var a = g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ENTER_MS, easing: 'ease-in', fill: 'forwards' });
    removeLater(g, a, ENTER_MS);
  };
  // 바뀐 땅의 테두리: 굵게 나타났다가 사라짐 (화면 기준 굵기)
  MapView.prototype._pulse = function (d, color) {
    var p = el('path', { class: 'fx-pulse', d: d, stroke: shade(color, -0.3), 'vector-effect': 'non-scaling-stroke' }, this.gFx);
    var a = p.animate([
      { opacity: 0, strokeWidth: 1 },
      { opacity: 1, strokeWidth: 5, offset: 0.25 },
      { opacity: 0, strokeWidth: 2 },
    ], { duration: PULSE_MS, easing: 'ease-out', fill: 'forwards' });
    removeLater(p, a, PULSE_MS);
  };

  MapView.prototype.setShowPrev = function (on) {
    this.showPrev = on;
    this.gPrev.style.display = on ? '' : 'none';
  };

  MapView.prototype.setHighlight = function (name) {
    this.highlight = name;
    this.svg.classList.toggle('has-hl', !!name);
    var self = this;
    Object.keys(this.groups || {}).forEach(function (n) {
      var gr = self.groups[n];
      var on = !!name && (n === name || gr.fillAs === name);
      gr.g.classList.toggle('hl', on);
    });
    this.gHl.textContent = '';
    if (name && this.groups[name]) {
      el('path', { class: 'hl-ring', d: outlineD(this.groups[name].features) }, this.gHl);
    }
    this.labelEls && this.labelEls.forEach(function (o) {
      o.el.classList.toggle('dim', !!name && !!o.name && o.name !== name && !(self.groups[o.name] && self.groups[o.name].fillAs === name));
    });
    this.isletEls && this.isletEls.forEach(function (o) {
      o.el.classList.toggle('hl', !!name && (o.name === name || (self.groups[o.name] && self.groups[o.name].fillAs === name)));
    });
  };

  // ---------- 이름표·작은 섬 (화면 좌표) ----------
  MapView.prototype._buildLabels = function () {
    var box = this.labelsEl;
    box.textContent = '';
    var PRI = { korea: 0, point: 0.5, islet: 1, line: 2, 'line black': 2, zone: 2, sea: 3, neighbor: 4, river: 5 };
    var pointLabels = (this.points || []).map(function (f) {
      return { text: f.properties.name, at: f.geometry.coordinates, cls: 'point', dy: -17 };
    });
    this.labelEls = this.labels.concat(pointLabels).map(function (l) {
      var d = document.createElement('div');
      d.className = 'lbl ' + l.cls;
      d.textContent = l.text;
      box.appendChild(d);
      return { el: d, w: project(l.at), name: l.name, dy: l.dy || 0, pri: PRI[l.cls] == null ? 6 : PRI[l.cls], area: l.area || 0 };
    }).sort(function (a, b) { return a.pri - b.pri || b.area - a.area; }); // 넓은 나라 이름표가 먼저 자리를 잡는다
    this._sizesDirty = true;
    var self = this;
    this.gScreen.textContent = '';
    this.isletEls = this.islets.map(function (it) {
      var c = el('circle', { class: 'islet', r: it.name === '독도' ? 5 : 6, fill: it.color, 'data-name': it.name }, self.gScreen);
      c.__feature = it.feature;
      return { el: c, w: project(it.at), name: it.name };
    });
  };

  MapView.prototype._applyView = function () {
    var v = this.view;
    this.root.setAttribute('transform', 'matrix(' + v.s + ',0,0,' + v.s + ',' + v.tx + ',' + v.ty + ')');
    // 흐림 정도와 빗금 간격은 화면 기준으로 일정하게
    this.blur.setAttribute('stdDeviation', (2.2 / v.s).toFixed(3));
    var pats = this.defs.querySelectorAll('pattern');
    for (var i = 0; i < pats.length; i++) pats[i].setAttribute('patternTransform', 'rotate(45) scale(' + (1 / v.s).toFixed(4) + ')');
    var W = this.svg.clientWidth, H = this.svg.clientHeight;
    // 이름표 크기: 지도 너비에 맞춤 (발표 모드에서는 labelScale배)
    var base = Math.max(14, Math.min(22, W / 52)) * (this.labelScale || 1);
    if (base !== this._labelBase) {
      this._labelBase = base;
      this._sizesDirty = true;
      this.labelsEl.style.setProperty('--lbl-korea', base.toFixed(1) + 'px');
      this.labelsEl.style.setProperty('--lbl-nb', Math.max(12, base * 0.68).toFixed(1) + 'px');
      this.labelsEl.style.setProperty('--lbl-islet', Math.max(13, base * 0.75).toFixed(1) + 'px');
      this.labelsEl.style.setProperty('--lbl-sea', Math.max(14, base * 0.85).toFixed(1) + 'px');
    }
    var els = this.labelEls || [];
    if (this._sizesDirty) {
      // 나라 이름표: 처음 보기 크기에서 영역 한 변 길이(px)에 비례, 기본 크기의 0.75~1.6배
      var fs0 = this.fitScale;
      els.forEach(function (o) {
        if (!o.area) return;
        var side = Math.sqrt(o.area) * fs0;
        o.el.style.fontSize = Math.max(base * 0.75, Math.min(base * 1.6, 9 + side / 9)).toFixed(1) + 'px';
      });
      els.forEach(function (o) { o.el.style.visibility = ''; o.bw = o.el.offsetWidth; o.bh = o.el.offsetHeight; });
      this._sizesDirty = false;
    }
    // 겹치는 이름표는 중요도가 낮은 쪽을 숨긴다 (나라 > 섬 > 선 > 바다 > 주변 세력 > 강)
    var placed = [];
    els.forEach(function (o) {
      var x = o.w[0] * v.s + v.tx, y = o.w[1] * v.s + v.ty + o.dy;
      o.el.style.left = x + 'px';
      o.el.style.top = y + 'px';
      var r = [x - o.bw / 2 - 2, y - o.bh / 2 - 1, x + o.bw / 2 + 2, y + o.bh / 2 + 1];
      var out = r[2] < 0 || r[3] < 0 || r[0] > W || r[1] > H;
      var hit = !out && placed.some(function (q) { return r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]; });
      o.el.style.visibility = out || hit ? 'hidden' : '';
      if (!out && !hit) placed.push(r);
    });
    (this.isletEls || []).forEach(function (o) {
      o.el.setAttribute('cx', o.w[0] * v.s + v.tx);
      o.el.setAttribute('cy', o.w[1] * v.s + v.ty);
    });
    (this.pointEls || []).concat(this.flashEls || []).forEach(function (o) {
      o.el.setAttribute('transform', 'translate(' + (o.w[0] * v.s + v.tx).toFixed(1) + ',' + (o.w[1] * v.s + v.ty).toFixed(1) + ')');
    });
  };

  MapView.prototype.setLabelScale = function (k) {
    this.labelScale = k;
    this._labelBase = null;
    this._applyView();
  };

  /*
   * 사건 자리 반짝임: 사건을 누르면 그 사건의 도읍·전투 자리에 동심원이 퍼지고 이름이 잠깐 보인다.
   * 점 층을 꺼 두었어도 보인다. 화면 좌표라 확대해도 크기가 같다.
   */
  MapView.prototype.flash = function (features) {
    var self = this;
    (this.flashEls || []).forEach(function (o) { if (o.el.parentNode) o.el.parentNode.removeChild(o.el); });
    this.flashEls = [];
    if (!features.length) return;
    var still = reducedMotion() || !canAnimate(this.svg);
    this.flashEls = features.map(function (f) {
      var g = el('g', { class: 'flash' }, self.gFlash);
      [0, 1, 2].forEach(function (i) {
        var c = el('circle', { r: 10 + i * 12 }, g);
        if (!still) c.animate([{ r: 6, opacity: 0.95 }, { r: 46, opacity: 0 }], { duration: 1200, delay: i * 260, iterations: 2, easing: 'ease-out', fill: 'backwards' });
      });
      el('circle', { class: 'core', r: 6 }, g);
      var t = el('text', { y: -24, 'text-anchor': 'middle' }, g);
      t.textContent = f.properties.name;
      return { el: g, w: project(f.geometry.coordinates) };
    });
    this._applyView();
    var mine = this.flashEls;
    setTimeout(function () {
      mine.forEach(function (o) { if (o.el.parentNode) o.el.parentNode.removeChild(o.el); });
      if (self.flashEls === mine) self.flashEls = [];
    }, 3000);
  };

  /** 지형 음영 켜기·끄기 */
  MapView.prototype.setRelief = function (on) {
    this.relief.style.display = on ? '' : 'none';
  };

  // ---------- 보기 범위 ----------
  // padLeft: 왼쪽 위 범례가 차지한 너비. 처음 범위를 범례 오른쪽 공간에 맞춘다
  MapView.prototype.fit = function (bounds) {
    var b = bounds || DEFAULT_VIEW;
    var a = project([b[0], b[3]]), c = project([b[2], b[1]]);
    var W = this.svg.clientWidth || 800, H = this.svg.clientHeight || 600;
    var pad = Math.max(0, Math.min(W * 0.4, this.padLeft || 0));
    var s = Math.min((W - pad) / (c[0] - a[0]), H / (c[1] - a[1]));
    this.fitScale = s;
    this._sizesDirty = true;
    this.view = { s: s, tx: pad + (W - pad - (a[0] + c[0]) * s) / 2, ty: (H - (a[1] + c[1]) * s) / 2 };
    this._applyView();
  };

  MapView.prototype.zoomBy = function (k, cx, cy) {
    var v = this.view;
    var W = this.svg.clientWidth, H = this.svg.clientHeight;
    if (cx == null) { cx = W / 2; cy = H / 2; }
    var s2 = Math.max(this.fitScale * 0.85, Math.min(this.fitScale * 10, v.s * k));
    k = s2 / v.s;
    this.view = { s: s2, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    this._clampPan();
    this._applyView();
  };

  MapView.prototype._clampPan = function () {
    var v = this.view, W = this.svg.clientWidth, H = this.svg.clientHeight;
    var minX = W * 0.5 - 1000 * v.s, maxX = W * 0.5;
    var minY = H * 0.5 - WORLD_H * v.s, maxY = H * 0.5;
    v.tx = Math.max(minX, Math.min(maxX, v.tx));
    v.ty = Math.max(minY, Math.min(maxY, v.ty));
  };

  MapView.prototype._bindGestures = function () {
    var self = this, svg = this.svg;
    var pts = new Map(), start = null, moved = false;

    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = svg.getBoundingClientRect();
      self.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    svg.addEventListener('pointerdown', function (e) {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
      start = snapshotGesture();
      moved = false;
    });
    svg.addEventListener('pointermove', function (e) {
      if (!pts.has(e.pointerId)) {
        if (e.pointerType === 'mouse') hoverAt(e);
        return;
      }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      var g = snapshotGesture();
      if (!start || !g) return;
      var dist = Math.hypot(g.cx - start.cx, g.cy - start.cy);
      if (!moved && dist < 6 && Math.abs(g.d - start.d) < 6) return;
      if (!moved) { moved = true; svg.classList.add('dragging'); self._emit('gesture'); }
      var r = svg.getBoundingClientRect();
      var k = start.d && g.d ? g.d / start.d : 1;
      var s2 = Math.max(self.fitScale * 0.85, Math.min(self.fitScale * 10, start.view.s * k));
      k = s2 / start.view.s;
      var ox = start.cx - r.left, oy = start.cy - r.top;
      self.view = {
        s: s2,
        tx: ox - (ox - start.view.tx) * k + (g.cx - start.cx),
        ty: oy - (oy - start.view.ty) * k + (g.cy - start.cy),
      };
      self._clampPan();
      self._applyView();
    });
    function end(e) {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      start = snapshotGesture();
      if (!pts.size) {
        svg.classList.remove('dragging');
        if (!moved && e.type === 'pointerup') tapAt(e);
      }
    }
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !pts.size) self._emit('leave'); });

    function snapshotGesture() {
      if (!pts.size) return null;
      var a = Array.from(pts.values());
      var cx = a.reduce(function (s, p) { return s + p.x; }, 0) / a.length;
      var cy = a.reduce(function (s, p) { return s + p.y; }, 0) / a.length;
      var d = a.length > 1 ? Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) : 0;
      return { cx: cx, cy: cy, d: d, view: Object.assign({}, self.view) };
    }
    function featureAt(e) {
      var t = document.elementFromPoint(e.clientX, e.clientY);
      return t && t.__feature ? t.__feature : null;
    }
    function pointAt(e) {
      var t = document.elementFromPoint(e.clientX, e.clientY);
      return t && t.__point ? t.__point : null;
    }
    function hoverAt(e) {
      var pt = pointAt(e);
      if (pt) { self._emit('pointhover', pt, e.clientX, e.clientY); return; }
      var f = featureAt(e);
      if (f) self._emit('hover', f, e.clientX, e.clientY); else self._emit('leave');
    }
    function tapAt(e) {
      var pt = pointAt(e);
      if (pt) { self._emit('pointtap', pt, e.clientX, e.clientY); return; }
      var f = featureAt(e);
      self._emit('tap', f, e.clientX, e.clientY);
    }
  };

  // 색을 어둡게(-)/밝게(+)
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    function f(c) { return Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt); }
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  }

  window.MapView = MapView;
  window.MapView.project = project;
})();
