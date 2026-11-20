// ==UserScript==
// @id             iitc-plugin-mu-s2-calc@reirei0000
// @name           IITC plugin: S2 MU Calculator & Cell Overlay
// @category       Info
// @version        0.1.0
// @namespace      https://github.com/reirei0000/ingress-mu-heatmap
// @description    [Experimental] Highlight S2 covering cells (max 20, L6-L13) and estimate MU for a 3-portal control field using GRUMP v1 shards.
// @match          https://intel.ingress.com/*
// @grant          none
// ==/UserScript==

function wrapper(plugin_info) {
  if (typeof window.plugin !== "function") window.plugin = function () {};

  window.plugin.muS2Calculator = {};
  const self = window.plugin.muS2Calculator;

  // Hosted population data base URL (GitHub Pages supports CORS by default)
  const DATA_BASE_URL = "https://reirei0000.github.io/ingress-mu-heatmap/data/";

  // ==========================================================================
  // 1. S2 Geometry & Covering Engine (2011 Java PriorityQueue, L6..L13)
  // ==========================================================================
  const POS_TO_IJ = [
    [0, 1, 3, 2],
    [0, 2, 3, 1],
    [3, 2, 0, 1],
    [3, 1, 0, 2],
  ];
  const IJ_TO_POS = [
    [0, 1, 3, 2],
    [0, 3, 1, 2],
    [2, 3, 1, 0],
    [2, 1, 3, 0],
  ];
  const POS_TO_ORIENTATION_XOR = [1, 0, 0, 3];
  const RAD2DEG = 180.0 / Math.PI;
  const DEG2RAD = Math.PI / 180.0;
  const RE_KM = 6371.01;
  const KMINWIDTH = (2 * Math.SQRT2) / 3;

  function stToUv(s) {
    return s >= 0.5 ? (4 * s * s - 1) / 3 : (1 - 4 * (1 - s) * (1 - s)) / 3;
  }
  function uvToSt(u) {
    return u >= 0 ? 0.5 * Math.sqrt(1 + 3 * u) : 1 - 0.5 * Math.sqrt(1 - 3 * u);
  }
  function faceUvToXyz(face, u, v) {
    switch (face) {
      case 0: return [1, u, v];
      case 1: return [-u, 1, v];
      case 2: return [-u, -v, 1];
      case 3: return [-1, -v, -u];
      case 4: return [v, -1, -u];
      case 5: return [v, u, -1];
    }
  }
  function xyzToFaceUv(x, y, z) {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    let face = ax > ay ? (ax > az ? 0 : 2) : (ay > az ? 1 : 2);
    if ((face === 0 && x < 0) || (face === 1 && y < 0) || (face === 2 && z < 0)) face += 3;
    switch (face) {
      case 0: return [face, y / x, z / x];
      case 1: return [face, -x / y, z / y];
      case 2: return [face, -x / z, -y / z];
      case 3: return [face, z / x, y / x];
      case 4: return [face, z / y, -x / y];
      case 5: return [face, -y / z, -x / z];
    }
  }
  function xyzToLatLng(xyz) {
    return [
      Math.atan2(xyz[2], Math.hypot(xyz[0], xyz[1])) * RAD2DEG,
      Math.atan2(xyz[1], xyz[0]) * RAD2DEG,
    ];
  }
  function latLngToXyz(latDeg, lngDeg) {
    const la = latDeg * DEG2RAD, ln = lngDeg * DEG2RAD;
    const cla = Math.cos(la);
    return [cla * Math.cos(ln), cla * Math.sin(ln), Math.sin(la)];
  }
  function encodeCellId(face, i, j) {
    let o = face & 1, pos = 0n;
    for (let k = 29; k >= 0; k--) {
      const ij = (((i >> k) & 1) << 1) | ((j >> k) & 1);
      const p = IJ_TO_POS[o][ij];
      pos = (pos << 2n) | BigInt(p);
      o ^= POS_TO_ORIENTATION_XOR[p];
    }
    return (BigInt(face) << 61n) | (pos << 1n) | 1n;
  }
  function cellParent(id, level) {
    const m = 1n << BigInt(2 * (30 - level));
    return (id & -m) | m;
  }
  function getCellLevel(id) {
    const lsb = id & -id;
    let lvl = 30, m = 1n;
    while (m < lsb && lvl > 0) {
      m <<= 2n;
      lvl--;
    }
    return lvl;
  }
  function cellChild(id, k) {
    const lsb = id & -id;
    const newLsb = lsb >> 2n;
    return (id ^ lsb) | (BigInt(k) * (newLsb << 1n)) | newLsb;
  }
  function cellContainsId(a, b) {
    const lsb = a & -a;
    return (a - lsb + 1n) <= b && b <= (a + lsb - 1n);
  }
  function toToken(id) {
    return id.toString(16).padStart(16, "0").replace(/0+$/, "") || "X";
  }
  function indexToCellId(globalIndex, level) {
    return (BigInt(2 * globalIndex + 1)) << BigInt(60 - 2 * level);
  }
  function latLngToLevel6Index(latDeg, lngDeg) {
    const la = latDeg * DEG2RAD, ln = lngDeg * DEG2RAD;
    const x = Math.cos(la) * Math.cos(ln), y = Math.cos(la) * Math.sin(ln), z = Math.sin(la);
    const [face, u, v] = xyzToFaceUv(x, y, z);
    const i = Math.max(0, Math.min(1073741823, Math.floor(1073741824 * uvToSt(u))));
    const j = Math.max(0, Math.min(1073741823, Math.floor(1073741824 * uvToSt(v))));
    const l6 = cellParent(encodeCellId(face, i, j), 6);
    return Number(l6 >> 49n);
  }

  const _geomCache = new Map();
  function getCellGeometryCached(id, level) {
    let g = _geomCache.get(id);
    if (g) return g;
    if (_geomCache.size > 120000) _geomCache.clear();
    const d = getCellS2Data(id, level);
    g = { verts: d.vertsLatLng, center: d.center };
    _geomCache.set(id, g);
    return g;
  }

  function vecNorm(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  function vecDot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }
  function vecCross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function getCellS2Data(id, level) {
    const face = Number(id >> 61n);
    let o = face & 1, i = 0, j = 0;
    for (let k = 0; k < level; k++) {
      const p = Number((id >> BigInt(59 - 2 * k)) & 3n);
      const ij = POS_TO_IJ[o][p];
      i = (i << 1) | (ij >> 1);
      j = (j << 1) | (ij & 1);
      o ^= POS_TO_ORIENTATION_XOR[p];
    }
    const sz = 2 ** (30 - level);
    const i0 = i * sz, j0 = j * sz;
    const u0 = stToUv(i0 / 1073741824);
    const u1 = stToUv((i0 + sz) / 1073741824);
    const v0 = stToUv(j0 / 1073741824);
    const v1 = stToUv((j0 + sz) / 1073741824);
    const uc = stToUv((i0 + sz * 0.5) / 1073741824);
    const vc = stToUv((j0 + sz * 0.5) / 1073741824);

    const vertsXyz = [
      vecNorm(faceUvToXyz(face, u0, v0)),
      vecNorm(faceUvToXyz(face, u1, v0)),
      vecNorm(faceUvToXyz(face, u1, v1)),
      vecNorm(faceUvToXyz(face, u0, v1)),
    ];
    const vertsLatLng = vertsXyz.map(xyzToLatLng);
    const center = xyzToLatLng(faceUvToXyz(face, uc, vc));
    return { id, level, face, u0, u1, v0, v1, vertsXyz, vertsLatLng, center };
  }

  function getVertexNeighbors(xyz, level) {
    const [face, u, v] = xyzToFaceUv(xyz[0], xyz[1], xyz[2]);
    const i = Math.max(0, Math.min(1073741823, Math.floor(1073741824 * uvToSt(u))));
    const j = Math.max(0, Math.min(1073741823, Math.floor(1073741824 * uvToSt(v))));
    const sz = 1 << (30 - level);
    const half = sz >> 1;
    const iBase = i & ~(sz - 1);
    const jBase = j & ~(sz - 1);
    const di = (i & half) ? sz : -sz;
    const dj = (j & half) ? sz : -sz;
    const offsets = [
      [iBase, jBase],
      [iBase + di, jBase],
      [iBase, jBase + dj],
      [iBase + di, jBase + dj],
    ];
    const seen = new Set();
    const out = [];
    for (const [ii, jj] of offsets) {
      let cid;
      if (ii >= 0 && ii < 1073741824 && jj >= 0 && jj < 1073741824) {
        cid = cellParent(encodeCellId(face, ii, jj), level);
      } else {
        const uc = stToUv((ii + 0.5 * sz) / 1073741824);
        const vc = stToUv((jj + 0.5 * sz) / 1073741824);
        const p = faceUvToXyz(face, uc, vc);
        const [nf, nu, nv] = xyzToFaceUv(p[0], p[1], p[2]);
        const ni = Math.max(0, Math.min(1073741823, Math.floor(1073741824 * uvToSt(nu))));
        const nj = Math.max(0, Math.min(1073741823, Math.floor(1073741824 * uvToSt(nv))));
        cid = cellParent(encodeCellId(nf, ni, nj), level);
      }
      if (!seen.has(cid)) {
        seen.add(cid);
        out.push(cid);
      }
    }
    return out;
  }

  function onArc(p, u, v, n) {
    return vecDot(p, [u[0] + v[0], u[1] + v[1], u[2] + v[2]]) > 0 &&
           vecDot(vecCross(u, p), n) >= -1e-12 &&
           vecDot(vecCross(p, v), n) >= -1e-12;
  }
  function arcsIntersect(a, b, c, d) {
    const n1 = vecCross(a, b);
    const n2 = vecCross(c, d);
    const x = vecCross(n1, n2);
    const len = Math.hypot(x[0], x[1], x[2]);
    if (len < 1e-14) return false;
    const p = [x[0] / len, x[1] / len, x[2] / len];
    if (onArc(p, a, b, n1) && onArc(p, c, d, n2)) return true;
    const np = [-p[0], -p[1], -p[2]];
    return onArc(np, a, b, n1) && onArc(np, c, d, n2);
  }

  class TriangleRegion {
    constructor(latLngs) {
      this.vs = latLngs.map(([la, ln]) => latLngToXyz(la, ln));
      const c = vecNorm([
        this.vs[0][0] + this.vs[1][0] + this.vs[2][0],
        this.vs[0][1] + this.vs[1][1] + this.vs[2][1],
        this.vs[0][2] + this.vs[1][2] + this.vs[2][2],
      ]);
      this.center = c;
      this.normals = [];
      for (let i = 0; i < 3; i++) {
        let n = vecCross(this.vs[i], this.vs[(i + 1) % 3]);
        if (vecDot(n, c) < 0) n = [-n[0], -n[1], -n[2]];
        this.normals.push(n);
      }
      this.capAngle = Math.max(
        Math.acos(Math.max(-1, Math.min(1, vecDot(c, this.vs[0])))),
        Math.acos(Math.max(-1, Math.min(1, vecDot(c, this.vs[1])))),
        Math.acos(Math.max(-1, Math.min(1, vecDot(c, this.vs[2]))))
      );
    }
    containsPoint(p) {
      return vecDot(this.normals[0], p) >= -1e-14 &&
             vecDot(this.normals[1], p) >= -1e-14 &&
             vecDot(this.normals[2], p) >= -1e-14;
    }
    contains(cell) {
      for (let k = 0; k < 4; k++) {
        if (!this.containsPoint(cell.vertsXyz[k])) return false;
      }
      return true;
    }
    mayIntersect(cell) {
      for (let k = 0; k < 4; k++) {
        if (this.containsPoint(cell.vertsXyz[k])) return true;
      }
      for (let k = 0; k < 3; k++) {
        const [f, u, v] = xyzToFaceUv(this.vs[k][0], this.vs[k][1], this.vs[k][2]);
        if (f === cell.face && u >= cell.u0 && u <= cell.u1 && v >= cell.v0 && v <= cell.v1) {
          return true;
        }
      }
      for (let i = 0; i < 3; i++) {
        const a = this.vs[i], b = this.vs[(i + 1) % 3];
        for (let j = 0; j < 4; j++) {
          const c = cell.vertsXyz[j], d = cell.vertsXyz[(j + 1) % 4];
          if (arcsIntersect(a, b, c, d)) return true;
        }
      }
      return false;
    }
  }

  class JHeap {
    constructor() { this.q = []; }
    get length() { return this.q.length; }
    push(x) {
      const q = this.q;
      q.push(x);
      let k = q.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        const e = q[p];
        if (x[0] <= e[0]) break;
        q[k] = e;
        k = p;
      }
      q[k] = x;
    }
    pop() {
      const q = this.q;
      const res = q[0];
      const x = q.pop();
      const n = q.length;
      if (n > 0) {
        let k = 0;
        const half = n >> 1;
        while (k < half) {
          let child = 2 * k + 1;
          let c = q[child];
          const r = child + 1;
          if (r < n && c[0] < q[r][0]) {
            child = r;
            c = q[child];
          }
          if (x[0] >= c[0]) break;
          q[k] = c;
          k = child;
        }
        q[k] = x;
      }
      return res;
    }
  }

  function maxLevelFor(value) {
    if (value <= 0) return 30;
    return Math.max(0, Math.min(30, Math.floor(Math.log2(KMINWIDTH / value))));
  }

  function normalizeCellIds(ids, minLevel = 6) {
    const uniq = Array.from(new Set(ids)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out = [];
    for (const cid of uniq) {
      let c = cid;
      if (out.length > 0 && cellContainsId(out[out.length - 1], c)) continue;
      while (out.length > 0 && cellContainsId(c, out[out.length - 1])) out.pop();
      while (out.length >= 3 && getCellLevel(c) > minLevel) {
        const lvl = getCellLevel(c);
        const p = cellParent(c, lvl - 1);
        const tail = out.slice(-3);
        if (tail.every(o => getCellLevel(o) === lvl && cellParent(o, lvl - 1) === p) && new Set(tail).size === 3) {
          out.splice(-3, 3);
          c = p;
        } else {
          break;
        }
      }
      out.push(c);
    }
    return out;
  }

  function coverTriangle(latLngs, maxCells = 20, maxLevel = 13, minLevel = 6) {
    const R = new TriangleRegion(latLngs);
    const result = [];
    const pq = new JHeap();

    function newCandidate(cid) {
      const lvl = getCellLevel(cid);
      const cell = getCellS2Data(cid, lvl);
      if (!R.mayIntersect(cell)) return null;
      let terminal = false;
      if (lvl >= minLevel && (lvl + 1 > maxLevel || R.contains(cell))) {
        terminal = true;
      }
      return { cid, lvl, cell, terminal, children: [], nterm: 0 };
    }

    function add(cand) {
      if (!cand) return 0;
      if (cand.terminal) {
        result.push(cand.cid);
        return 1;
      }
      let nterm = 0;
      for (let k = 0; k < 4; k++) {
        const ch = newCandidate(cellChild(cand.cid, k));
        if (ch) {
          cand.children.push(ch);
          if (ch.terminal) nterm++;
        }
      }
      cand.nterm = nterm;
      if (cand.children.length === 0) return 0;
      if (nterm === 4 && cand.lvl >= minLevel) {
        cand.terminal = true;
        return add(cand);
      }
      const priority = -(((cand.lvl << 2) + cand.children.length << 2) + nterm);
      pq.push([priority, cand]);
      return 0;
    }

    let started = false;
    if (maxCells >= 4) {
      const level = Math.min(maxLevelFor(2 * R.capAngle), Math.min(maxLevel, 29));
      if (level > 0) {
        for (const cid of getVertexNeighbors(R.center, level)) {
          add(newCandidate(cid));
        }
        started = true;
      }
    }
    if (!started) {
      for (let face = 0; face < 6; face++) {
        add(newCandidate((BigInt(face) << 61n) | (1n << 60n)));
      }
    }

    while (pq.length > 0) {
      const [, cand] = pq.pop();
      const n = cand.children.length;
      const expand = cand.lvl < minLevel || n === 1 || (result.length + pq.length + n <= maxCells);
      if (expand) {
        for (const ch of cand.children) add(ch);
      } else {
        cand.terminal = true;
        add(cand);
      }
    }

    return normalizeCellIds(result, minLevel);
  }

  function clipPolyByNormal(poly, n) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = vecDot(n, a);
      const db = vecDot(n, b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push(vecNorm([
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
        ]));
      }
    }
    return out;
  }

  function sphArea(poly) {
    if (poly.length < 3) return 0;
    let total = 0;
    const a = poly[0];
    for (let i = 1; i < poly.length - 1; i++) {
      const b = poly[i], c = poly[i + 1];
      total += 2 * Math.atan2(
        Math.abs(vecDot(a, vecCross(b, c))),
        1 + vecDot(a, b) + vecDot(b, c) + vecDot(c, a)
      );
    }
    return total;
  }

  function interpolateGreatCircle(p1, p2, steps = 16) {
    const v1 = latLngToXyz(p1[0], p1[1]);
    const v2 = latLngToXyz(p2[0], p2[1]);
    const pts = [];
    for (let i = 0; i < steps; i++) {
      const f = i / steps;
      pts.push(xyzToLatLng(vecNorm([
        v1[0] * (1 - f) + v2[0] * f,
        v1[1] * (1 - f) + v2[1] * f,
        v1[2] * (1 - f) + v2[2] * f,
      ])));
    }
    return pts;
  }

  // ==========================================================================
  // 2. Population Data Fetcher (world.json + Level-3 Binary Shards)
  // ==========================================================================
  let worldData = null;
  let worldPromise = null;
  let l3AvailableSet = new Set();
  const l3ShardLoaded = new Set();
  const l3ShardPromises = new Map();
  const l13RegionCache = new Map();

  async function ensureWorldIndex() {
    if (worldPromise) return worldPromise;
    worldPromise = (async () => {
      const res = await fetch(DATA_BASE_URL + "world.json");
      if (!res.ok) throw new Error("Failed to fetch world.json: HTTP " + res.status);
      worldData = await res.json();
      l3AvailableSet = new Set(worldData.l3_shards || []);
      return worldData;
    })();
    return worldPromise;
  }

  async function fetchDecompressedBuffer(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = await res.arrayBuffer();
    const u8 = new Uint8Array(buf);
    if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([buf]).stream().pipeThrough(ds);
      return await new Response(stream).arrayBuffer();
    }
    return buf;
  }

  async function loadL3Shard(l3Idx) {
    if (l3ShardLoaded.has(l3Idx)) return;
    if (l3ShardPromises.has(l3Idx)) return l3ShardPromises.get(l3Idx);
    const p = (async () => {
      try {
        const buf = await fetchDecompressedBuffer(`${DATA_BASE_URL}l13/s_${l3Idx}.bin`);
        const dv = new DataView(buf);
        let offset = 0;
        const regionCount = dv.getUint16(offset, true);
        offset += 2;

        for (let r = 0; r < regionCount; r++) {
          const l6Index = dv.getUint16(offset, true);
          const cellCount = dv.getUint16(offset + 2, true);
          offset += 4;

          const idxArr = new Uint16Array(cellCount);
          for (let i = 0; i < cellCount; i++) {
            idxArr[i] = dv.getUint16(offset + i * 2, true);
          }
          offset += cellCount * 2;

          const valArr = new Float32Array(cellCount);
          for (let i = 0; i < cellCount; i++) {
            valArr[i] = dv.getFloat32(offset + i * 4, true);
          }
          offset += cellCount * 4;

          l13RegionCache.set(l6Index, { l6_index: l6Index, idx: idxArr, val: valArr });
        }

        l3ShardLoaded.add(l3Idx);
        l3AvailableSet.delete(l3Idx);
      } finally {
        l3ShardPromises.delete(l3Idx);
      }
    })();
    l3ShardPromises.set(l3Idx, p);
    return p;
  }

  function getCellDensityFromCache(cid, lvl) {
    const l6Idx = Number(cellParent(cid, 6) >> 49n);
    const region = l13RegionCache.get(l6Idx);
    if (!region) return 0;
    const lsb = cid & -cid;
    const cidMin13 = (cid - lsb) | (1n << 34n);
    const subStart = Number(cidMin13 >> 35n) - l6Idx * 16384;
    const count13 = 1 << (2 * (13 - lvl));
    const subEnd = subStart + count13;
    const idx = region.idx;
    const val = region.val;
    let lo = 0, hi = idx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (idx[mid] < subStart) lo = mid + 1;
      else hi = mid;
    }
    let sum = 0;
    for (let k = lo; k < idx.length && idx[k] < subEnd; k++) {
      sum += val[k];
    }
    return sum / count13;
  }

  // ==========================================================================
  // 2.5 S2 Density Heatmap Overlay Layer (L6 / L8 / L13)
  // ==========================================================================
  const COLORS_12 = [
    "#0000b8", "#0055ff", "#00aaff", "#00ffff",
    "#00ff88", "#00ee00", "#99ff00", "#ffff00",
    "#ffaa00", "#ff4400", "#e60026", "#9600c8",
  ];
  const PALETTES = {
    step12_detail: {
      thresholds: [0, 100, 250, 500, 1000, 2000, 3500, 5000, 6500, 8000, 10000, 12000],
      colors: COLORS_12,
    },
    step12_1000: {
      thresholds: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000],
      colors: COLORS_12,
    },
    step6_2000: {
      thresholds: [0, 2000, 4000, 6000, 8000, 10000],
      colors: ["#0000ff", "#00ffff", "#00ff00", "#ffff00", "#ff0000", "#9600c8"],
    },
  };
  let heatmapPaletteKey = "step12_detail";
  let heatmapOpacity = 0.45;
  let heatmapShowLabels = true;
  let heatmapLayer = null;

  function getColorForDensity(d) {
    const p = PALETTES[heatmapPaletteKey];
    const th = p.thresholds;
    for (let i = th.length - 1; i >= 0; i--) {
      if (d >= th[i]) return p.colors[i];
    }
    return p.colors[0];
  }

  function getVisibleL6Indices(south, north, west, east) {
    const indices = new Set();
    const s = south - 0.03, n = north + 0.03;
    const w = west - 0.03, e = east + 0.03;
    const latSpan = Math.max(0.01, n - s);
    const lngSpan = Math.max(0.01, e - w);
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const la = Math.max(-89.9, Math.min(89.9, s + (latSpan * i) / steps));
      for (let j = 0; j <= steps; j++) {
        const ln = Math.max(-179.9, Math.min(179.9, w + (lngSpan * j) / steps));
        indices.add(latLngToLevel6Index(la, ln));
      }
    }
    return indices;
  }

  function createHeatmapLayer() {
    const LayerBase = L.Layer || L.Class;
    const S2HeatmapOverlay = LayerBase.extend({
      onAdd: function (map) {
        this._map = map;
        this._canvas = L.DomUtil.create("canvas", "leaflet-layer");
        this._canvas.style.position = "absolute";
        this._canvas.style.pointerEvents = "none";
        this._ctx = this._canvas.getContext("2d");
        map.getPanes().overlayPane.appendChild(this._canvas);
        map.on("moveend zoomend resize", this._resetAndDraw, this);
        this._resetAndDraw();
        if (!worldData) {
          ensureWorldIndex().then(() => this.draw()).catch(err => console.error("[IITC MU S2 Calc]", err));
        }
      },
      onRemove: function (map) {
        if (this._canvas && this._canvas.parentNode) {
          this._canvas.parentNode.removeChild(this._canvas);
        }
        map.off("moveend zoomend resize", this._resetAndDraw, this);
        this._map = null;
      },
      _resetAndDraw: function () {
        if (!this._map) return;
        const size = this._map.getSize();
        const topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, topLeft);
        this._canvas.width = size.x;
        this._canvas.height = size.y;
        this.draw();
      },
      draw: function () {
        if (!this._map || !this._ctx) return;
        const ctx = this._ctx;
        const size = this._map.getSize();
        ctx.clearRect(0, 0, size.x, size.y);
        if (!worldData) return;

        const zoom = this._map.getZoom();
        const bounds = this._map.getBounds();
        const south = bounds.getSouth(), north = bounds.getNorth();
        const west = bounds.getWest(), east = bounds.getEast();
        const showLabels = heatmapShowLabels && zoom >= 16;

        if (zoom <= 6) {
          this._drawCellList(worldData.l6.idx, worldData.l6.val, 6, 0, south, north, west, east, false);
        } else if (zoom <= 10) {
          this._drawCellList(worldData.l8.idx, worldData.l8.val, 8, 0, south, north, west, east, false);
        } else {
          const visibleL6Indices = getVisibleL6Indices(south, north, west, east);
          let drawnL13Regions = 0;
          for (const l6Idx of visibleL6Indices) {
            const cached = l13RegionCache.get(l6Idx);
            if (cached) {
              drawnL13Regions++;
              const baseGlobalIdx = cached.l6_index * 16384;
              this._drawCellList(cached.idx, cached.val, 13, baseGlobalIdx, south, north, west, east, showLabels);
            } else {
              const l3Idx = l6Idx >> 6;
              if (l3AvailableSet.has(l3Idx) && !l3ShardPromises.has(l3Idx)) {
                loadL3Shard(l3Idx).then(() => this.draw()).catch(() => {});
              }
            }
          }
          if (drawnL13Regions === 0) {
            this._drawCellList(worldData.l8.idx, worldData.l8.val, 8, 0, south, north, west, east, false);
          }
        }
      },
      _drawCellList: function (indices, values, level, baseGlobalIdx, south, north, west, east, showLabels) {
        const ctx = this._ctx;
        const map = this._map;
        const margin = level === 13 ? 0.02 : level === 8 ? 0.6 : 2.5;
        const sLim = south - margin, nLim = north + margin;
        const wLim = west - margin, eLim = east + margin;

        ctx.lineWidth = level === 13 ? 1.0 : 0.6;
        ctx.strokeStyle = "rgba(51, 51, 51, 0.75)";
        ctx.globalAlpha = heatmapOpacity;

        const labelQueue = [];
        for (let i = 0; i < indices.length; i++) {
          const globalIdx = baseGlobalIdx + indices[i];
          const cid = indexToCellId(globalIdx, level);
          const geom = getCellGeometryCached(cid, level);
          const [clat, clng] = geom.center;
          if (clat < sLim || clat > nLim || clng < wLim || clng > eLim) continue;

          const verts = geom.verts;
          if (Math.abs(verts[0][1] - verts[2][1]) > 90) continue;

          const p0 = map.latLngToContainerPoint(verts[0]);
          const p1 = map.latLngToContainerPoint(verts[1]);
          const p2 = map.latLngToContainerPoint(verts[2]);
          const p3 = map.latLngToContainerPoint(verts[3]);

          const dens = values[i];
          ctx.fillStyle = getColorForDensity(dens);
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.lineTo(p3.x, p3.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          if (showLabels) {
            const pc = map.latLngToContainerPoint(geom.center);
            labelQueue.push({ dens, pc });
          }
        }

        if (showLabels && labelQueue.length > 0) {
          ctx.globalAlpha = 1.0;
          ctx.font = "bold 12px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "#ffffff";
          ctx.fillStyle = "#000000";
          for (let i = 0; i < labelQueue.length; i++) {
            const text = Math.round(labelQueue[i].dens).toLocaleString("en-US");
            ctx.strokeText(text, labelQueue[i].pc.x, labelQueue[i].pc.y);
            ctx.fillText(text, labelQueue[i].pc.x, labelQueue[i].pc.y);
          }
        }
        ctx.globalAlpha = 1.0;
      },
    });
    return new S2HeatmapOverlay();
  }

  // ==========================================================================
  // 3. IITC Map Overlay, Portal Pick, DrawTools Integration & Dialog UI
  // ==========================================================================
  let fieldLayerGroup = null;
  let pickMode = false;
  let pickedPortals = [];
  let lastPts = null;

  function parseLatLngText(str) {
    const m = String(str || "").trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return null;
    }
    return [lat, lng];
  }

  function setStatus(html) {
    const el = document.getElementById("mu-s2-summary");
    if (el) el.innerHTML = html;
  }

  function setPickMode(on) {
    pickMode = on;
    const btn = document.getElementById("mu-s2-pick");
    if (btn) {
      btn.textContent = on ? "ポータル3つ選択中..." : "ポータル3点選択";
      btn.style.background = on ? "#d63e2a" : "";
      btn.style.color = on ? "#fff" : "";
    }
    if (on) {
      pickedPortals = [];
      setStatus("Intel Map 上でポータルを <b>1/3</b> つ選択してください...");
    }
  }

  function onPortalSelected(data) {
    if (!pickMode || !data || !data.selectedPortalGuid) return;
    const p = window.portals && window.portals[data.selectedPortalGuid];
    if (!p) return;
    const ll = p.getLatLng();
    const coordStr = `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;
    if (pickedPortals.some(pt => pt[0] === ll.lat && pt[1] === ll.lng)) return;

    pickedPortals.push([ll.lat, ll.lng]);
    const idx = pickedPortals.length;
    const input = document.getElementById(`mu-s2-p${idx}`);
    if (input) input.value = coordStr;

    if (idx >= 3) {
      setPickMode(false);
      self.calculateAndDraw(false);
    } else {
      setStatus(`Intel Map 上でポータルを <b>${idx + 1}/3</b> つ選択してください...`);
    }
  }

  self.loadFromDrawTools = function () {
    if (!window.plugin || !window.plugin.drawTools || !window.plugin.drawTools.drawnItems) {
      setStatus('<span style="color:#d63e2a;">DrawTools プラグインが見つかりません。</span>');
      return;
    }
    const layers = window.plugin.drawTools.drawnItems.getLayers();
    let triLatLngs = null;
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (typeof L !== "undefined" && layer instanceof L.Polygon && !(layer instanceof L.Rectangle)) {
        const raw = layer.getLatLngs();
        const ring = Array.isArray(raw[0]) ? raw[0] : raw;
        if (ring && ring.length === 3) {
          triLatLngs = ring.map(ll => [ll.lat, ll.lng]);
          break;
        }
      }
    }
    if (!triLatLngs) {
      setStatus('<span style="color:#d63e2a;">DrawTools に3頂点の三角形ポリゴンが見つかりません。</span>');
      return;
    }
    triLatLngs.forEach((pt, idx) => {
      const el = document.getElementById(`mu-s2-p${idx + 1}`);
      if (el) el.value = `${pt[0].toFixed(6)}, ${pt[1].toFixed(6)}`;
    });
    self.calculateAndDraw(false);
  };

  self.calculateAndDraw = async function (fitBounds = false) {
    if (!fieldLayerGroup) return;
    const pts = [1, 2, 3].map(i => parseLatLngText(document.getElementById(`mu-s2-p${i}`)?.value));
    if (pts.some(p => !p)) {
      setStatus('<span style="color:#d63e2a;">三角形になる有効な3点の座標を入力してください。</span>');
      return;
    }
    const vs = pts.map(([la, ln]) => latLngToXyz(la, ln));
    if (Math.abs(vecDot(vs[0], vecCross(vs[1], vs[2]))) < 1e-13) {
      setStatus('<span style="color:#d63e2a;">3点が一直線上にあり三角形になりません。</span>');
      return;
    }

    lastPts = pts;
    fieldLayerGroup.clearLayers();

    try {
      setStatus("S2 セルと人口データを読み込み中...");
      await ensureWorldIndex();

      const cellIds = coverTriangle(pts, 20, 13, 6);
      const neededShards = new Set();
      for (const cid of cellIds) {
        const l6Idx = Number(cellParent(cid, 6) >> 49n);
        if (!l13RegionCache.has(l6Idx)) {
          const l3Idx = l6Idx >> 6;
          if (l3AvailableSet.has(l3Idx) || l3ShardPromises.has(l3Idx)) {
            neededShards.add(l3Idx);
          }
        }
      }
      if (neededShards.size > 0) {
        await Promise.all(Array.from(neededShards).map(id => loadL3Shard(id)));
      }

      const tri = new TriangleRegion(pts);
      const triAreaKm2 = sphArea(tri.vs) * RE_KM * RE_KM;
      const levelCounts = {};
      const regionRawMu = new Map();
      const cellRows = [];
      const allBounds = L.latLngBounds(pts);
      const showLabels = document.getElementById("mu-s2-labels")?.checked !== false;

      for (const cid of cellIds) {
        const lvl = getCellLevel(cid);
        levelCounts[lvl] = (levelCounts[lvl] || 0) + 1;
        const cell = getCellS2Data(cid, lvl);
        const token = toToken(cid);
        const r6Token = toToken(cellParent(cid, 6));

        let clipped = cell.vertsXyz;
        for (const n of tri.normals) {
          clipped = clipPolyByNormal(clipped, n);
          if (clipped.length === 0) break;
        }
        const overlapKm2 = sphArea(clipped) * RE_KM * RE_KM;
        const dens = getCellDensityFromCache(cid, lvl);
        const cellRawMu = overlapKm2 * dens;
        regionRawMu.set(r6Token, (regionRawMu.get(r6Token) || 0) + cellRawMu);
        cellRows.push({ token, lvl, overlapKm2, dens, cellRawMu });

        L.polygon(cell.vertsLatLng, {
          color: "#ffffff",
          weight: 5,
          opacity: 0.9,
          fill: false,
          interactive: false,
        }).addTo(fieldLayerGroup);

        L.polygon(cell.vertsLatLng, {
          color: "#ff00aa",
          weight: 2.5,
          opacity: 1.0,
          fillColor: "#ffe600",
          fillOpacity: 0.14,
          interactive: false,
        }).addTo(fieldLayerGroup);

        if (showLabels) {
          const muLabel = cellRawMu >= 10 ? Math.round(cellRawMu).toLocaleString("en-US") : cellRawMu.toFixed(1);
          L.marker(cell.center, {
            interactive: false,
            icon: L.divIcon({
              className: "",
              html: `<div class="mu-s2-cover-label">${token} (L${lvl}) · ${muLabel} MU</div>`,
              iconSize: null,
              iconAnchor: [0, 0],
            }),
          }).addTo(fieldLayerGroup);
        }

        cell.vertsLatLng.forEach(v => allBounds.extend(v));
      }

      let regionalTotal = 0;
      for (const rMu of regionRawMu.values()) {
        regionalTotal += Math.max(1.0, rMu);
      }
      const totalMu = Math.max(1, Math.floor(regionalTotal + 0.5));

      const triRing = [
        ...interpolateGreatCircle(pts[0], pts[1], 16),
        ...interpolateGreatCircle(pts[1], pts[2], 16),
        ...interpolateGreatCircle(pts[2], pts[0], 16),
      ];
      L.polygon(triRing, { color: "#ffffff", weight: 5, opacity: 0.9, fill: false, interactive: false }).addTo(fieldLayerGroup);
      L.polygon(triRing, { color: "#00e5ff", weight: 2.5, opacity: 1.0, fillColor: "#00e5ff", fillOpacity: 0.08, interactive: false }).addTo(fieldLayerGroup);

      pts.forEach((p, idx) => {
        L.marker(p, {
          interactive: false,
          icon: L.divIcon({
            className: "mu-s2-vertex-marker",
            html: String(idx + 1),
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
        }).addTo(fieldLayerGroup);
      });

      if (fitBounds && window.map) {
        window.map.fitBounds(allBounds, { padding: [50, 50] });
      }

      const lvlSummary = Object.keys(levelCounts)
        .sort((a, b) => Number(a) - Number(b))
        .map(lv => `L${lv}:${levelCounts[lv]}`)
        .join(", ");

      cellRows.sort((a, b) => b.cellRawMu - a.cellRawMu);
      const tableRows = cellRows.map(r =>
        `<tr><td><code>${r.token}</code></td><td>L${r.lvl}</td><td style="text-align:right;">${r.overlapKm2.toFixed(2)}</td><td style="text-align:right;">${r.dens.toFixed(1)}</td><td style="text-align:right;"><b>${Math.round(r.cellRawMu).toLocaleString("en-US")}</b></td></tr>`
      ).join("");

      setStatus(
        `<div style="font-size:15px;font-weight:700;color:#ff40b3;margin-bottom:4px;">合計 MU: ${totalMu.toLocaleString("ja-JP")} MU</div>` +
        `<div>面積: <b>${triAreaKm2.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}</b> km² | セル数: <b>${cellIds.length}</b> (${lvlSummary})</div>` +
        `<details style="margin-top:6px;"><summary style="cursor:pointer;">セル別内訳 (${cellRows.length}件)</summary>` +
        `<div style="max-height:160px;overflow:auto;margin-top:4px;"><table class="mu-s2-table"><thead><tr><th>Token</th><th>Lv</th><th>km²</th><th>密度</th><th>MU</th></tr></thead><tbody>${tableRows}</tbody></table></div></details>`
      );
    } catch (err) {
      console.error("[IITC MU S2 Calc]", err);
      setStatus(`<span style="color:#d63e2a;">エラー: ${err.message}</span>`);
    }
  };

  self.clearOverlay = function () {
    if (pickMode) setPickMode(false);
    pickedPortals = [];
    lastPts = null;
    if (fieldLayerGroup) fieldLayerGroup.clearLayers();
    [1, 2, 3].forEach(i => {
      const el = document.getElementById(`mu-s2-p${i}`);
      if (el) el.value = "";
    });
    setStatus("");
  };

  self.openDialog = function () {
    if (document.getElementById("mu-s2-dialog")) return;
    const html = `
      <div id="mu-s2-dialog" style="font-size:12px;">
        <div style="margin-bottom:6px;display:flex;align-items:center;gap:6px;">
          <span style="background:#fff3cd;color:#856404;border:1px solid #ffeeba;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:700;">実験的機能 / Experimental</span>
          <span style="font-size:11px;color:#aaa;">GRUMP v1 + S2 (L6–L13, max 20)</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div>P1: <input id="mu-s2-p1" type="text" placeholder="緯度, 経度 (3行貼付可)" style="width:230px;"></div>
          <div>P2: <input id="mu-s2-p2" type="text" placeholder="緯度, 経度" style="width:230px;"></div>
          <div>P3: <input id="mu-s2-p3" type="text" placeholder="緯度, 経度" style="width:230px;"></div>
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;">
          <button id="mu-s2-pick" type="button">ポータル3点選択</button>
          <button id="mu-s2-drawtools" type="button">DrawToolsから読込</button>
          <button id="mu-s2-calc" type="button" style="font-weight:700;">計算 &amp; 強調</button>
          <button id="mu-s2-clear" type="button">クリア</button>
        </div>
        <div style="margin-top:6px;">
          <label><input id="mu-s2-labels" type="checkbox" checked> セルラベルを表示</label>
        </div>
        <div style="margin-top:8px;padding-top:6px;border-top:1px solid #444;">
          <div style="font-weight:700;margin-bottom:4px;">ヒートマップ表示 (MU Density Heatmap)</div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <label><input id="mu-s2-hm-toggle" type="checkbox"> レイヤー表示</label>
            <label>不透明度: <input id="mu-s2-hm-opacity" type="range" min="0.1" max="0.85" step="0.05" value="${heatmapOpacity}" style="width:85px;vertical-align:middle;"></label>
          </div>
          <div style="margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <select id="mu-s2-hm-palette" style="font-size:11px;">
              <option value="step12_detail"${heatmapPaletteKey === "step12_detail" ? " selected" : ""}>12段階 (郊外〜都心詳細)</option>
              <option value="step12_1000"${heatmapPaletteKey === "step12_1000" ? " selected" : ""}>12段階 (1,000刻み)</option>
              <option value="step6_2000"${heatmapPaletteKey === "step6_2000" ? " selected" : ""}>6段階 (2,000刻み)</option>
            </select>
            <label><input id="mu-s2-hm-labels" type="checkbox"${heatmapShowLabels ? " checked" : ""}> 拡大時数値(z≧16)</label>
          </div>
        </div>
        <div id="mu-s2-summary" style="margin-top:8px;line-height:1.45;"></div>
        <div style="margin-top:8px;padding-top:6px;border-top:1px solid #444;font-size:10px;color:#999;">
          Data: GRUMP v1 (CIESIN / NASA SEDAC) · Reconstruction: InvestigateXM
        </div>
      </div>
    `;
    window.dialog({
      html,
      id: "plugin-mu-s2-calc",
      title: "MU S2 Calculator (Experimental)",
      width: 340,
    });

    document.getElementById("mu-s2-p1").addEventListener("paste", function (e) {
      const text = (e.clipboardData || window.clipboardData).getData("text");
      const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length >= 3) {
        e.preventDefault();
        document.getElementById("mu-s2-p1").value = lines[0];
        document.getElementById("mu-s2-p2").value = lines[1];
        document.getElementById("mu-s2-p3").value = lines[2];
        self.calculateAndDraw(true);
      }
    });
    document.getElementById("mu-s2-pick").addEventListener("click", () => setPickMode(!pickMode));
    document.getElementById("mu-s2-drawtools").addEventListener("click", () => self.loadFromDrawTools());
    document.getElementById("mu-s2-calc").addEventListener("click", () => self.calculateAndDraw(true));
    document.getElementById("mu-s2-clear").addEventListener("click", () => self.clearOverlay());
    document.getElementById("mu-s2-labels").addEventListener("change", () => {
      if (lastPts) self.calculateAndDraw(false);
    });

    const hmToggle = document.getElementById("mu-s2-hm-toggle");
    if (heatmapLayer && window.map) {
      hmToggle.checked = window.map.hasLayer(heatmapLayer);
      hmToggle.addEventListener("change", function () {
        if (this.checked) {
          if (!window.map.hasLayer(heatmapLayer)) window.map.addLayer(heatmapLayer);
        } else {
          if (window.map.hasLayer(heatmapLayer)) window.map.removeLayer(heatmapLayer);
        }
      });
    }
    document.getElementById("mu-s2-hm-opacity").addEventListener("input", function () {
      heatmapOpacity = parseFloat(this.value) || 0.45;
      if (heatmapLayer && window.map && window.map.hasLayer(heatmapLayer)) heatmapLayer.draw();
    });
    document.getElementById("mu-s2-hm-palette").addEventListener("change", function () {
      heatmapPaletteKey = this.value;
      if (heatmapLayer && window.map && window.map.hasLayer(heatmapLayer)) heatmapLayer.draw();
    });
    document.getElementById("mu-s2-hm-labels").addEventListener("change", function () {
      heatmapShowLabels = this.checked;
      if (heatmapLayer && window.map && window.map.hasLayer(heatmapLayer)) heatmapLayer.draw();
    });
  };

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .mu-s2-vertex-marker {
        background: #111;
        color: #fff;
        border: 2px solid #fff;
        border-radius: 50%;
        font-size: 11px;
        font-weight: 700;
        text-align: center;
        line-height: 18px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.5);
      }
      .mu-s2-cover-label {
        display: inline-block;
        transform: translate(-50%, -50%);
        background: rgba(15, 23, 42, 0.9);
        color: #ffffff;
        border: 1px solid #ff40b3;
        border-radius: 4px;
        padding: 1px 5px;
        font-size: 10px;
        font-weight: 700;
        line-height: 1.3;
        white-space: nowrap;
        pointer-events: none;
        box-shadow: 0 1px 3px rgba(0,0,0,0.45);
      }
      .mu-s2-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
      }
      .mu-s2-table th, .mu-s2-table td {
        border-bottom: 1px solid #333;
        padding: 2px 4px;
      }
    `;
    document.head.appendChild(style);
  }

  function setup() {
    injectStyles();
    fieldLayerGroup = new L.LayerGroup();
    heatmapLayer = createHeatmapLayer();
    window.addLayerGroup("MU S2 Cells (Experimental)", fieldLayerGroup, true);
    window.addLayerGroup("MU Density Heatmap", heatmapLayer, false);
    window.addHook("portalSelected", onPortalSelected);

    const toolbox = document.getElementById("toolbox");
    if (toolbox) {
      const a = document.createElement("a");
      a.textContent = "MU S2 Calc";
      a.title = "S2 Covering & MU Calculator (Experimental)";
      a.addEventListener("click", () => self.openDialog());
      toolbox.appendChild(a);
    }
  }

  setup.info = plugin_info;
  if (!window.bootPlugins) window.bootPlugins = [];
  window.bootPlugins.push(setup);
  if (window.iitcLoaded && typeof setup === "function") setup();
}

var script = document.createElement("script");
var info = {};
if (typeof GM_info !== "undefined" && GM_info && GM_info.script) {
  info.script = {
    version: GM_info.script.version,
    name: GM_info.script.name,
    description: GM_info.script.description,
  };
}
script.appendChild(document.createTextNode("(" + wrapper + ")(" + JSON.stringify(info) + ");"));
(document.body || document.head || document.documentElement).appendChild(script);
