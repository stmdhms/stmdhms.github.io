// Pure 2D geometry and plan-model helpers for the AR floor-plan capture page.
// No DOM or WebXR here, so it can be tested with node (homeassistant/floorplan_web/test_geometry.mjs).
// Plan coordinates: metres, x to the right, y "up" on the map. WebXR's horizontal plane is (x, z) with -z
// forward, so a floor point (x, y, z) in XR maps to plan (x, -z).
// Stored coordinates are always the raw capture frame; plan.orientation.rot_deg only rotates the *view*
// (mini map, edit view, and the PC build) so the first wall reads horizontal.

export const PLAN_VERSION = 2;
export const CLOSE_TOLERANCE_M = 0.30;
export const FLOOR_TOL_M = 0.10;        // floor-item hits further than this from the floor height are not used
export const PARALLEL_DEG = 12;         // consecutive walls closer than this in angle are "parallel"
export const SAME_WALL_M = 0.15;        // parallel walls with offsets closer than this are one wall
export const ITEM_TYPES = ['outlet', 'switch', 'other'];

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

// ---- orientation ------------------------------------------------------------------------------------

// Smallest view rotation (radians, in [-pi/4, pi/4]) that makes the wall a->b horizontal or vertical.
export function orientationForWall(a, b) {
  const th = Math.atan2(b[1] - a[1], b[0] - a[0]);
  let r = -th;
  r = r - (Math.PI / 2) * Math.round(r / (Math.PI / 2));
  return r;
}

export function viewRotation(plan) {
  const d = plan && plan.orientation && Number(plan.orientation.rot_deg);
  return Number.isFinite(d) ? (d * Math.PI) / 180 : 0;
}

// ---- straightening (axis snapping) ------------------------------------------------------------------

function classifyEdges(p, tol) {
  const lines = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const th = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const offH = Math.abs(angleDiff(th * 2, 0)) / 2; // distance from 0 or 180
    const offV = Math.abs(angleDiff(th * 2, Math.PI)) / 2; // distance from 90 or 270
    const len = dist(a, b);
    if (offH <= tol) lines.push({ kind: 'h', c: (a[1] + b[1]) / 2, len, span: [Math.min(a[0], b[0]), Math.max(a[0], b[0])] });
    else if (offV <= tol) lines.push({ kind: 'v', c: (a[0] + b[0]) / 2, len, span: [Math.min(a[1], b[1]), Math.max(a[1], b[1])] });
    else lines.push({ kind: 'free', a, b, len });
  }
  return lines;
}

// Merge parallel axis walls (across rooms) whose offsets are within snapM and whose extents overlap or nearly
// touch onto their length-weighted mean, so rooms sharing a wall line up instead of overlapping/gapping.
export function snapOffsets(allLines, snapM) {
  for (const kind of ['h', 'v']) {
    const ls = allLines.filter((l) => l.kind === kind).sort((a, b) => a.c - b.c);
    const clusters = [];
    for (const l of ls) {
      const cl = clusters.find((c) => Math.abs(c.c - l.c) <= snapM &&
        c.m.some((o) => l.span[0] <= o.span[1] + 1.0 && o.span[0] <= l.span[1] + 1.0));
      if (cl) {
        cl.m.push(l);
        const w = cl.m.reduce((s, o) => s + o.len, 0) || 1;
        cl.c = cl.m.reduce((s, o) => s + o.c * o.len, 0) / w;
      } else clusters.push({ c: l.c, m: [l] });
    }
    for (const cl of clusters) for (const l of cl.m) l.c = cl.c;
  }
}

function rebuildFromLines(p, lines) {
  const n = p.length, out = [];
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

// Straighten a room: rotate so walls align with the axes (by `ang`, normally -dominantAngle), make each edge
// within tolDeg of horizontal/vertical exactly axis-aligned, then rebuild corners as intersections of
// neighbouring wall lines. Edges further off-axis are kept as they are. Returns points in the rotated frame.
export function straighten(pts, ang = 0, tolDeg = 12) {
  const p = simplify(pts).map((q) => rotate(q, ang));
  if (p.length < 3) return p;
  return rebuildFromLines(p, classifyEdges(p, (tolDeg * Math.PI) / 180));
}

// Square up a whole plan in the view frame given by `ang`: straighten every room and snap shared walls of
// neighbouring rooms (parallel, within snapM) onto one line. Returns new point lists in the RAW frame.
export function squareRooms(rooms, ang = 0, tolDeg = 12, snapM = SAME_WALL_M) {
  const tol = (tolDeg * Math.PI) / 180;
  const ps = rooms.map((r) => (r.points.length >= 3 ? simplify(r.points).map((q) => rotate(q, ang)) : null));
  const ls = ps.map((p) => (p && p.length >= 3 ? classifyEdges(p, tol) : null));
  snapOffsets(ls.filter(Boolean).flat(), snapM);
  return rooms.map((r, i) => (ls[i] ? rebuildFromLines(ps[i], ls[i]).map((q) => rotate(q, -ang)).map(([x, y]) => [round3(x), round3(y)]) : r.points));
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

// ---- walls mode ---------------------------------------------------------------------------------------
// A room is captured as a sequence of elements: {c:[x,y]} (a corner tapped directly) or {w:[[x,y],[x,y]]}
// (two points anywhere along the base of one wall). Corners between two walls are the intersection of the
// wall lines, so a corner hidden behind a bookshelf never needs to be seen.

export function projectOnLine(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1e-12;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  return [a[0] + t * dx, a[1] + t * dy];
}

export function distToLine(p, a, b) {
  return dist(p, projectOnLine(p, a, b));
}

export function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

// Angle between two wall directions, 0..90 degrees.
export function wallAngleDeg(w1, w2) {
  const t1 = Math.atan2(w1[1][1] - w1[0][1], w1[1][0] - w1[0][0]);
  const t2 = Math.atan2(w2[1][1] - w2[0][1], w2[1][0] - w2[0][0]);
  const d = Math.abs(angleDiff(2 * t1, 2 * t2)) / 2;
  return (d * 180) / Math.PI;
}

// Where two consecutive walls meet. Returns a list of 0, 1 or 2 vertices:
//   []        the second wall continues the first (near-parallel and offset < sameM): no corner
//   [p]       the intersection of the two wall lines
//   [p1, p2]  near-parallel but offset (a step in the wall): a short jog halfway between the walls' ends
export function wallJunction(w1, w2, parallelDeg = PARALLEL_DEG, sameM = SAME_WALL_M) {
  const ang = wallAngleDeg(w1, w2);
  const m2 = [(w2[0][0] + w2[1][0]) / 2, (w2[0][1] + w2[1][1]) / 2];
  const jog = () => {
    const m = [(w1[1][0] + w2[0][0]) / 2, (w1[1][1] + w2[0][1]) / 2];
    return [projectOnLine(m, w1[0], w1[1]), projectOnLine(m, w2[0], w2[1])];
  };
  if (ang < parallelDeg) {
    if (distToLine(m2, w1[0], w1[1]) < sameM) return [];
    return jog();
  }
  const x = intersect({ kind: 'free', a: w1[0], b: w1[1] }, { kind: 'free', a: w2[0], b: w2[1] });
  if (!x) return jog();
  // Guard against a far-away intersection from badly tapped walls.
  const m1 = [(w1[0][0] + w1[1][0]) / 2, (w1[0][1] + w1[1][1]) / 2];
  if (Math.min(dist(x, m1), dist(x, m2)) > 15) return jog();
  return [x];
}

// Polygon (list of corners) for an element sequence. Open sequences keep the outer ends of the first and
// last wall so the drawing ends where the user tapped.
export function polygonFromSeq(seq, closed) {
  const n = seq.length, out = [];
  for (let i = 0; i < n; i++) {
    const e = seq[i];
    if (e.c) { out.push(e.c); continue; }
    const prev = closed ? seq[(i - 1 + n) % n] : i > 0 ? seq[i - 1] : null;
    if (!prev || prev === e) out.push(e.w[0]);
    else if (prev.w) out.push(...wallJunction(prev.w, e.w));
    if (!closed && i === n - 1) out.push(e.w[1]);
  }
  return out.map(([x, y]) => [round3(x), round3(y)]);
}

// Live prediction while the second point of the current wall is being aimed: the corner it will make with
// the previous wall (or null if there is no previous wall / the walls are parallel).
export function predictCorner(seq, a, b) {
  if (!seq.length || !a || !b || dist(a, b) < 0.05) return null;
  const prev = seq[seq.length - 1];
  if (!prev.w) return null;
  const j = wallJunction(prev.w, [a, b]);
  return j.length === 1 ? j[0] : null;
}

// Corner list of a room in either format (v1 rooms have only points).
export function roomPoints(room) {
  if (Array.isArray(room.seq) && room.seq.length) return polygonFromSeq(room.seq, !!room.closed);
  return room.points || [];
}

// ---- floor constraint -------------------------------------------------------------------------------

// Intersect a ray (origin {x,y,z}, unit dir {x,y,z}) with the horizontal plane y = floorY. Returns the XR point
// or null when the ray does not go down to the floor within maxDist.
export function rayFloor(origin, dir, floorY, maxDist = 8) {
  if (floorY == null || !(dir.y < -0.05)) return null;
  const t = (floorY - origin.y) / dir.y;
  if (!(t > 0) || t > maxDist) return null;
  return { x: origin.x + dir.x * t, y: floorY, z: origin.z + dir.z * t };
}

// Choose the floor point for a floor item (light, corner, wall base, door side).
//   hit: {pos:{x,y,z}, horizontal, vertical} or null; ray: {origin, dir} or null.
// A horizontal hit within tol of the floor is used as is; a hit on a wall near its base is used (projected to
// the floor); anything else (table top, sofa, far wall) is replaced by the ray's intersection with the floor.
export function floorPoint(hit, ray, floorY, tol = FLOOR_TOL_M) {
  if (floorY == null) return { ok: false, reason: 'no-floor' };
  if (hit && hit.horizontal && Math.abs(hit.pos.y - floorY) <= tol) return { ok: true, how: 'hit', pos: { ...hit.pos, y: floorY } };
  if (hit && hit.vertical && hit.pos.y - floorY >= -tol && hit.pos.y - floorY < 0.3) return { ok: true, how: 'wall-base', pos: { ...hit.pos, y: floorY } };
  const p = ray ? rayFloor(ray.origin, ray.dir, floorY) : null;
  if (p) return { ok: true, how: 'projected', pos: p, rejected: hit ? round3(hit.pos.y - floorY) : null };
  return { ok: false, reason: 'off-floor' };
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- plan model -------------------------------------------------------------------------------------

export function bounds(points) {
  if (!points.length) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
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

export function newPlan() {
  const now = new Date().toISOString();
  return {
    format: 'ha-floorplan-capture',
    version: PLAN_VERSION,
    units: 'm',
    created: now,
    updated: now,
    capture: { tool: 'webxr-floorplan', sessions: [], floor_y: null },
    orientation: null,         // {rot_deg, source:'first-wall'|'manual'}: view rotation, raw coords unchanged
    rooms: [],                 // {name, points, closed, seq?, ceiling_m, ceiling_src}
    lights: [],                // {entity_id, name, x, y, room, how?}
    doors: [],                 // {a, b, room, kind:'door'|'opening', swing?:{hinge:'a'|'b', side:1|-1}}
    items: [],                 // {type:'outlet'|'switch'|'other', x, y, height_m, label, entity_id, name, room, on_wall}
  };
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// Validate and normalise a plan (v1 or v2, e.g. from localStorage or a file). Throws on garbage.
export function normalisePlan(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('not an object');
  const plan = newPlan();
  Object.assign(plan, { created: obj.created || plan.created, updated: obj.updated || plan.updated });
  if (obj.capture && typeof obj.capture === 'object') plan.capture = { ...plan.capture, ...obj.capture };
  const pt = (q) => {
    if (!Array.isArray(q) || q.length < 2 || !q.slice(0, 2).every(Number.isFinite)) throw new Error('bad point');
    return [Number(q[0]), Number(q[1])];
  };
  if (obj.orientation && Number.isFinite(Number(obj.orientation.rot_deg))) {
    plan.orientation = { rot_deg: Number(obj.orientation.rot_deg), source: String(obj.orientation.source || 'manual') };
  }
  plan.rooms = (obj.rooms || []).map((r) => {
    const room = { name: String(r.name || 'Room'), points: (r.points || []).map(pt), closed: !!r.closed,
      ceiling_m: num(r.ceiling_m), ceiling_src: r.ceiling_src ? String(r.ceiling_src) : null };
    if (Array.isArray(r.seq) && r.seq.length) {
      room.seq = r.seq.map((e) => (e && e.w ? { w: [pt(e.w[0]), pt(e.w[1])] } : { c: pt(e && e.c) }));
      room.points = polygonFromSeq(room.seq, room.closed);
    }
    return room;
  });
  plan.lights = (obj.lights || []).map((l) => ({
    entity_id: String(l.entity_id || ''),
    name: String(l.name || l.entity_id || 'Light'),
    x: Number(l.x),
    y: Number(l.y),
    room: l.room ? String(l.room) : null,
    ...(l.how ? { how: String(l.how) } : {}),
  })).filter((l) => Number.isFinite(l.x) && Number.isFinite(l.y));
  plan.doors = (obj.doors || []).map((d) => {
    const door = { a: pt(d.a), b: pt(d.b), room: d.room ? String(d.room) : null, kind: d.kind === 'opening' ? 'opening' : 'door' };
    if (d.swing && (d.swing.hinge === 'a' || d.swing.hinge === 'b') && (d.swing.side === 1 || d.swing.side === -1)) door.swing = { hinge: d.swing.hinge, side: d.swing.side };
    return door;
  });
  plan.items = (obj.items || []).map((it) => ({
    type: ITEM_TYPES.includes(it.type) ? it.type : 'other',
    x: Number(it.x), y: Number(it.y),
    height_m: num(it.height_m),
    label: String(it.label || ''),
    entity_id: String(it.entity_id || ''),
    name: String(it.name || ''),
    room: it.room ? String(it.room) : null,
    on_wall: !!it.on_wall,
  })).filter((it) => Number.isFinite(it.x) && Number.isFinite(it.y));
  return plan;
}

// Room-containing-point lookup (closed rooms only); returns the room name or null.
export function roomAt(plan, p) {
  for (const r of plan.rooms) if (r.closed && r.points.length >= 3 && pointInPolygon(p, r.points)) return r.name;
  return null;
}

function distToPolygon(p, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i], pts[(i + 1) % pts.length]));
  return d;
}

// Room containing p, or (for wall-mounted things) the closed room whose boundary is within margin metres.
export function roomNear(plan, p, margin = 0) {
  const inside = roomAt(plan, p);
  if (inside || !margin) return inside;
  let best = null;
  for (const r of plan.rooms) {
    if (!r.closed || r.points.length < 3) continue;
    const d = distToPolygon(p, r.points);
    if (d <= margin && (!best || d < best.d)) best = { d, name: r.name };
  }
  return best ? best.name : null;
}

// True when there are closed rooms and p is outside all of them (by more than margin): a misplaced light/item.
export function outsideAllRooms(plan, p, margin = 0) {
  const closed = plan.rooms.filter((r) => r.closed && r.points.length >= 3);
  return closed.length > 0 && !closed.some((r) => pointInPolygon(p, r.points) || (margin > 0 && distToPolygon(p, r.points) <= margin));
}

// ---- room capture (corners or walls, mixed) ---------------------------------------------------------

function syncPoints(room) {
  if (room.seq) room.points = polygonFromSeq(room.seq, room.closed);
}

export function newRoom(name) {
  return { name, points: [], closed: false, seq: [], ceiling_m: null, ceiling_src: null };
}

// Add a corner to the open room; closes it if the tap is near the first corner. Returns 'added'|'closed'.
export function addCorner(room, p) {
  if (room.closed) throw new Error('room already closed');
  const firstCorner = room.seq ? (room.seq.length && room.seq[0].c) : room.points[0];
  if (room.points.length >= 3 && firstCorner && dist(firstCorner, p) <= CLOSE_TOLERANCE_M) {
    room.closed = true; syncPoints(room);
    return 'closed';
  }
  if (room.seq) { room.seq.push({ c: p }); syncPoints(room); } else room.points.push(p);
  return 'added';
}

// Add a wall given by two points along its base. Throws if the points are too close to define a direction.
export function addWall(room, a, b, minLen = 0.25) {
  if (room.closed) throw new Error('room already closed');
  if (dist(a, b) < minLen) throw new Error('wall points too close');
  if (!room.seq) room.seq = room.points.map((c) => ({ c }));
  room.seq.push({ w: [a, b] });
  syncPoints(room);
}

export function closeRoom(room) {
  const pts = room.seq ? polygonFromSeq(room.seq, true) : room.points;
  if (pts.length < 3) throw new Error('a room needs at least 3 corners');
  room.closed = true; syncPoints(room);
}

export function undoCorner(room) {
  if (room.closed) { room.closed = false; syncPoints(room); return true; }
  const ok = room.seq ? room.seq.pop() !== undefined : room.points.pop() !== undefined;
  syncPoints(room);
  return ok;
}

// Replace a room's element sequence by its plain corners (used when a corner is dragged in the edit view).
export function freezeRoom(room) {
  room.points = roomPoints(room);
  room.seq = room.points.map((c) => ({ c: [...c] }));
}

// Place (or move) a light. Re-placing an entity replaces its old position.
export function placeLight(plan, light, p, how) {
  plan.lights = plan.lights.filter((l) => !(light.entity_id && l.entity_id === light.entity_id));
  const entry = { entity_id: light.entity_id || '', name: light.name || light.entity_id || 'Light', x: p[0], y: p[1], room: roomAt(plan, p) };
  if (how) entry.how = how;
  plan.lights.push(entry);
  return entry;
}

export function placeItem(plan, item, p) {
  const entry = {
    type: ITEM_TYPES.includes(item.type) ? item.type : 'other', x: p[0], y: p[1],
    height_m: item.height_m == null ? null : round3(item.height_m), label: item.label || '',
    entity_id: item.entity_id || '', name: item.name || '', room: roomNear(plan, p, 0.3), on_wall: !!item.on_wall,
  };
  plan.items.push(entry);
  return entry;
}

export function exportPlan(plan) {
  const out = normalisePlan(plan);
  out.updated = new Date().toISOString();
  out.summary = {
    rooms: out.rooms.map((r) => ({ name: r.name, corners: r.points.length, closed: r.closed,
      area_m2: r.points.length >= 3 ? round3(area(r.points)) : 0, ceiling_m: r.ceiling_m,
      mode: !r.seq ? 'corners' : r.seq.every((e) => e.w) ? 'walls' : r.seq.some((e) => e.w) ? 'mixed' : 'corners' })),
    lights: out.lights.length,
    doors: out.doors.filter((d) => d.kind === 'door').length,
    openings: out.doors.filter((d) => d.kind === 'opening').length,
    items: out.items.length,
  };
  return JSON.stringify(out, null, 2);
}

// Parse the lights list JSON produced by homeassistant/floorplan_lights.py (or a hand-written one).
// Accepts {lights:[{entity_id,name,area}], switches:[...], areas:[...]} or a plain array of lights or names.
export function parseLightList(text) {
  const obj = typeof text === 'string' ? JSON.parse(text) : text;
  const raw = Array.isArray(obj) ? obj : obj.lights || [];
  const ent = (l) => (typeof l === 'string' ? { entity_id: l.includes('.') ? l : '', name: l, area: null } : {
    entity_id: String(l.entity_id || ''), name: String(l.name || l.entity_id || ''), area: l.area ? String(l.area) : null,
    ...(l.device_class ? { device_class: String(l.device_class) } : {}),
  });
  const lights = raw.map(ent).filter((l) => l.name || l.entity_id);
  const switches = (Array.isArray(obj) ? [] : obj.switches || []).map(ent).filter((l) => l.entity_id);
  const areas = !Array.isArray(obj) && Array.isArray(obj.areas) ? obj.areas.map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean)
    : [...new Set(lights.map((l) => l.area).filter(Boolean))];
  return { lights, switches, areas };
}

// ---- URL fragment (#lights=… / #lightsz=…) ------------------------------------------------------------
// The fragment never leaves the phone (browsers do not send it to the server). `lights` is base64url JSON;
// `lightsz` is base64url raw-DEFLATE JSON (smaller links), made by homeassistant/floorplan_link.py.

export function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Returns the parsed light list (see parseLightList) or null when the hash has no list. Throws on a bad list.
export async function decodeFragment(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  let bytes;
  if (params.get('lightsz')) bytes = await inflateRaw(b64urlToBytes(params.get('lightsz')));
  else if (params.get('lights')) bytes = b64urlToBytes(params.get('lights'));
  else return null;
  return parseLightList(new TextDecoder().decode(bytes));
}
