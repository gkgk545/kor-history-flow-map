/*
 * 지도 그리기: 메르카토르 투영 + SVG (라이브러리 없음)
 * - 나라 면은 육지 모양으로 잘라(clipPath) 해안선은 또렷하게, 내륙 경계는 흐리게(blur) 그린다.
 * - confidence "논쟁" 도형은 Model.edgeStyle 규칙대로 점선 테두리를 덧그린다.
 * - 이름표는 확대해도 글자 크기가 변하지 않도록 화면 좌표의 HTML로 올린다.
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
    this.gEdges = el('g', { class: 'edges' }, clipped);
    this.gPrev = el('g', { class: 'prev' }, clipped);
    this.gLines = el('g', { class: 'lines' }, clipped);
    this.gHl = el('g', { class: 'hl' }, clipped);
    this.gScreen = el('g', { class: 'screen' }, svg); // 화면 좌표(작은 섬 표시)
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

  /*
   * 그리기
   *   features: 지금 보이는 도형
   *   prevFeatures: 바로 앞 스냅샷의 마지막 모습 (점선)
   */
  MapView.prototype.render = function (features, prevFeatures) {
    var self = this;
    [this.gFill, this.gEdges, this.gPrev, this.gLines, this.gHl].forEach(function (g) { g.textContent = ''; });
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

    names.forEach(function (name) {
      var fs = byName.get(name);
      var p0 = fs[0].properties;
      var colorName = p0.fillAs || name;
      var color = self._color(colorName, p0.role);
      var pol = self.atlas.polities[colorName] || {};
      var fill = pol.pattern === 'hatch' ? self._hatch(color) : color;
      var g = el('g', { class: 'polity ' + p0.role + (self.rendered ? ' layer-enter' : ''), filter: 'url(#soft)', 'data-name': name }, self.gFill);
      self.groups[name] = { g: g, features: fs, color: color, role: p0.role, fillAs: p0.fillAs || null };
      fs.forEach(function (f) {
        var path = el('path', { d: geomD(f.geometry), fill: fill }, g);
        path.__feature = f;
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
      self.labels.push({ text: name, at: best.f.properties.anchor, cls: isIslet ? 'islet' : p0.role, name: name });
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

    // 바로 앞 스냅샷 경계 (우리 역사 나라만)
    if (prevFeatures && prevFeatures.length) {
      var prevBy = new Map();
      prevFeatures.forEach(function (f) {
        var p = f.properties;
        if (p.role !== 'korea' || p.kind === 'line' || p.fillAs) return;
        if (!prevBy.has(p.name)) prevBy.set(p.name, []);
        prevBy.get(p.name).push(f);
      });
      var now = edgeKeys(areas.filter(function (f) { return f.properties.role === 'korea' && !f.properties.fillAs; }));
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
    var PRI = { korea: 0, islet: 1, line: 2, 'line black': 2, sea: 3, neighbor: 4, river: 5 };
    this.labelEls = this.labels.map(function (l) {
      var d = document.createElement('div');
      d.className = 'lbl ' + l.cls;
      d.textContent = l.text;
      box.appendChild(d);
      return { el: d, w: project(l.at), name: l.name, dy: l.dy || 0, pri: PRI[l.cls] == null ? 6 : PRI[l.cls] };
    }).sort(function (a, b) { return a.pri - b.pri; });
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
    // 이름표 크기: 지도 너비에 맞춤
    var base = Math.max(14, Math.min(22, W / 52));
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
  };

  // ---------- 보기 범위 ----------
  MapView.prototype.fit = function (bounds) {
    var b = bounds || DEFAULT_VIEW;
    var a = project([b[0], b[3]]), c = project([b[2], b[1]]);
    var W = this.svg.clientWidth || 800, H = this.svg.clientHeight || 600;
    var s = Math.min(W / (c[0] - a[0]), H / (c[1] - a[1]));
    this.fitScale = s;
    this.view = { s: s, tx: (W - (a[0] + c[0]) * s) / 2, ty: (H - (a[1] + c[1]) * s) / 2 };
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
    function hoverAt(e) {
      var f = featureAt(e);
      if (f) self._emit('hover', f, e.clientX, e.clientY); else self._emit('leave');
    }
    function tapAt(e) {
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
