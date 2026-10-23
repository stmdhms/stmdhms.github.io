// Pure 2D geometry and plan-model helpers for the AR floor-plan capture page.
// No DOM or WebXR here, so it can be tested with node (homeassistant/floorplan_web/test_geometry.mjs).
// Plan coordinates: metres, x to the right, y "up" on the map. WebXR's horizontal plane is (x, z) with -z
// forward, so a floor point (x, y, z) in XR maps to plan (x, -z).

export const CLOSE_TOLERANCE_M = 0.30;

export function xrToPlan(pos) {
  return [round3(pos.x), round3(-pos.z)];
}

export function round3(v) {
  return Math.round(v * 1000) / 1000;
}

export function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// Signed area (positive = counter-clockwise).
export function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function area(pts) {
  return Math.abs(signedArea(pts));
}

export function perimeter(pts, closed = true) {
  let s = 0;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) s += dist(pts[i], pts[(i + 1) % pts.length]);
  return s;
}

export function centroid(pts) {
  const A = signedArea(pts);
  if (Math.abs(A) < 1e-9) {
    const n = pts.length || 1;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const f = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * f;
    cy += (a[1] + b[1]) * f;
  }
  return [cx / (6 * A), cy / (6 * A)];
}

export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// True when a new tap near the first corner should close the room instead of adding a corner.
export function shouldClose(pts, p, tol = CLOSE_TOLERANCE_M) {
  return pts.length >= 3 && dist(pts[0], p) <= tol;
}

// Drop repeated points (closer than minLen) and nearly straight corners (turn below minTurnDeg).
export function simplify(pts, minLen = 0.05, minTurnDeg = 4) {
  let out = [];
  for (const p of pts) if (!out.length || dist(out[out.length - 1], p) >= minLen) out.push(p);
  if (out.length > 2 && dist(out[0], out[out.length - 1]) < minLen) out.pop();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const turn = Math.abs(angleDiff(Math.atan2(c[1] - b[1], c[0] - b[0]), Math.atan2(b[1] - a[1], b[0] - a[0])));
      if (turn < (minTurnDeg * Math.PI) / 180) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// Dominant wall direction (radians in [-pi/4, pi/4)) of a set of polygons, length-weighted, modulo 90 degrees.
export function dominantAngle(polys) {
  let sx = 0, sy = 0;
  for (const pts of polys) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const len = dist(a, b);
      const th = Math.atan2(b[1] - a[1], b[0] - a[0]) * 4;
      sx += len * Math.cos(th);
      sy += len * Math.sin(th);
    }
  }
  if (sx === 0 && sy === 0) return 0;
  return Math.atan2(sy, sx) / 4;
}

export function rotate(p, ang, origin = [0, 0]) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const x = p[0] - origin[0], y = p[1] - origin[1];
  return [origin[0] + c * x - s * y, origin[1] + s * x + c * y];
}

// Straighten a room: rotate so walls align with the axes (by `ang`, normally -dominantAngle), make each edge
// within tolDeg of horizontal/vertical exactly axis-aligned, then rebuild corners as intersections of
// neighbouring wall lines. Edges further off-axis are kept as they are. Returns points in the rotated frame.
export function straighten(pts, ang = 0, tolDeg = 12) {
  const p = simplify(pts).map((q) => rotate(q, ang));
  const n = p.length;
  if (n < 3) return p;
  const tol = (tolDeg * Math.PI) / 180;
  // Each edge -> line {kind:'h'|'v'|'free', c (offset) or a,b}
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const th = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const offH = Math.abs(angleDiff(th * 2, 0)) / 2; // distance from 0 or 180
    const offV = Math.abs(angleDiff(th * 2, Math.PI)) / 2; // distance from 90 or 270
    if (offH <= tol) lines.push({ kind: 'h', c: (a[1] + b[1]) / 2 });
    else if (offV <= tol) lines.push({ kind: 'v', c: (a[0] + b[0]) / 2 });
    else lines.push({ kind: 'free', a, b });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i - 1 + n) % n], L2 = lines[i];
    const orig = p[i];
    if (L1.kind !== 'free' && L1.kind === L2.kind) {
      // Two parallel axis walls meet: keep a short perpendicular jog at the original corner.
      if (Math.abs(L1.c - L2.c) < 0.05) continue;
      if (L1.kind === 'h') out.push([orig[0], L1.c], [orig[0], L2.c]);
      else out.push([L1.c, orig[1]], [L2.c, orig[1]]);
      continue;
    }
    const x = intersect(L1, L2);
    out.push(x || orig);
  }
  return out.map((q) => [round3(q[0]), round3(q[1])]);
}

function lineCoeffs(L) {
  // a*x + b*y = c
  if (L.kind === 'h') return [0, 1, L.c];
  if (L.kind === 'v') return [1, 0, L.c];
  const [x1, y1] = L.a, [x2, y2] = L.b;
  const a = y2 - y1, b = x1 - x2;
  return [a, b, a * x1 + b * y1];
}

function intersect(L1, L2) {
  const [a1, b1, c1] = lineCoeffs(L1), [a2, b2, c2] = lineCoeffs(L2);
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-9) return null;
  return [(c1 * b2 - c2 * b1) / det, (a1 * c2 - a2 * c1) / det];
}

// Rigid 2D transform (rotation + translation, no scale) that maps two points measured in a new AR session
// (n1, n2) onto the same two points recorded earlier (o1, o2). Used to resume after the AR session restarts.
export function rigidFrom2Points(n1, n2, o1, o2) {
  const angN = Math.atan2(n2[1] - n1[1], n2[0] - n1[0]);
  const angO = Math.atan2(o2[1] - o1[1], o2[0] - o1[0]);
  const ang = angleDiff(angO, angN);
  const r1 = rotate(n1, ang), r2 = rotate(n2, ang);
  // Translate so the midpoints coincide (splits the error between the two points).
  const tx = (o1[0] + o2[0]) / 2 - (r1[0] + r2[0]) / 2;
  const ty = (o1[1] + o2[1]) / 2 - (r1[1] + r2[1]) / 2;
  const scaleCheck = dist(n1, n2) > 0 ? dist(o1, o2) / dist(n1, n2) : 0;
  return { ang, tx, ty, lengthRatio: scaleCheck };
}

export function applyTransform(p, t) {
  if (!t) return p;
  const r = rotate(p, t.ang);
  return [round3(r[0] + t.tx), round3(r[1] + t.ty)];
}

export function bounds(points) {
  if (!points.length) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

// ---- Plan model -------------------------------------------------------------------------------------

export function newPlan() {
  const now = new Date().toISOString();
  return {
    format: 'ha-floorplan-capture',
    version: 1,
    units: 'm',
    created: now,
    updated: now,
    capture: { tool: 'webxr-floorplan', sessions: [], floor_y: null },
    rooms: [],
    lights: [],
    doors: [],
  };
}

// Validate and normalise a plan (e.g. loaded from localStorage or a file). Throws on garbage.
export function normalisePlan(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('not an object');
  const plan = newPlan();
  Object.assign(plan, { created: obj.created || plan.created, updated: obj.updated || plan.updated });
  if (obj.capture && typeof obj.capture === 'object') plan.capture = { ...plan.capture, ...obj.capture };
  const pt = (q) => {
    if (!Array.isArray(q) || q.length < 2 || !q.every(Number.isFinite)) throw new Error('bad point');
    return [Number(q[0]), Number(q[1])];
  };
  plan.rooms = (obj.rooms || []).map((r) => ({
    name: String(r.name || 'Room'),
    points: (r.points || []).map(pt),
    closed: !!r.closed,
  }));
  plan.lights = (obj.lights || []).map((l) => ({
    entity_id: String(l.entity_id || ''),
    name: String(l.name || l.entity_id || 'Light'),
    x: Number(l.x),
    y: Number(l.y),
    room: l.room ? String(l.room) : null,
  })).filter((l) => Number.isFinite(l.x) && Number.isFinite(l.y));
  plan.doors = (obj.doors || []).map((d) => ({ a: pt(d.a), b: pt(d.b), room: d.room ? String(d.room) : null }));
  return plan;
}

// Room-containing-point lookup (closed rooms only); returns the room name or null.
export function roomAt(plan, p) {
  for (const r of plan.rooms) if (r.closed && r.points.length >= 3 && pointInPolygon(p, r.points)) return r.name;
  return null;
}

// Add a corner to the open room; closes it if the tap is near the first corner. Returns 'added'|'closed'.
export function addCorner(room, p) {
  if (room.closed) throw new Error('room already closed');
  if (shouldClose(room.points, p)) {
    room.closed = true;
    return 'closed';
  }
  room.points.push(p);
  return 'added';
}

export function closeRoom(room) {
  if (room.points.length < 3) throw new Error('a room needs at least 3 corners');
  room.closed = true;
}

export function undoCorner(room) {
  if (room.closed) { room.closed = false; return true; }
  return room.points.pop() !== undefined;
}

// Place (or move) a light. Re-placing an entity replaces its old position.
export function placeLight(plan, light, p) {
  plan.lights = plan.lights.filter((l) => !(light.entity_id && l.entity_id === light.entity_id));
  const entry = { entity_id: light.entity_id || '', name: light.name || light.entity_id || 'Light', x: p[0], y: p[1], room: roomAt(plan, p) };
  plan.lights.push(entry);
  return entry;
}

export function exportPlan(plan) {
  const out = normalisePlan(plan);
  out.updated = new Date().toISOString();
  out.summary = {
    rooms: out.rooms.map((r) => ({ name: r.name, corners: r.points.length, closed: r.closed, area_m2: r.points.length >= 3 ? round3(area(r.points)) : 0 })),
    lights: out.lights.length,
    doors: out.doors.length,
  };
  return JSON.stringify(out, null, 2);
}

// Parse the lights list JSON produced by homeassistant/floorplan_lights.py (or a hand-written one).
// Accepts {lights:[{entity_id,name,area}], areas:[...]} or a plain array of lights or names.
export function parseLightList(text) {
  const obj = JSON.parse(text);
  const raw = Array.isArray(obj) ? obj : obj.lights || [];
  const lights = raw.map((l) => (typeof l === 'string' ? { entity_id: l.includes('.') ? l : '', name: l, area: null } : {
    entity_id: String(l.entity_id || ''), name: String(l.name || l.entity_id || ''), area: l.area ? String(l.area) : null,
  })).filter((l) => l.name || l.entity_id);
  const areas = Array.isArray(obj.areas) ? obj.areas.map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean)
    : [...new Set(lights.map((l) => l.area).filter(Boolean))];
  return { lights, areas };
}
