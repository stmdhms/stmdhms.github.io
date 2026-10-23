// AR floor-plan capture (WebXR immersive-ar + hit-test + dom-overlay, optional depth-sensing and plane-detection)
// plus a 2D edit view that works without AR. Pure geometry lives in geometry.js.
import * as THREE from 'three';
import * as G from './geometry.js?v=2';

const $ = (id) => document.getElementById(id);
const KEY_PLAN = 'fp.plan.v1', KEY_LIGHTS = 'fp.lights.v1', KEY_UI = 'fp.ui.v1';

// ---------- storage (always try/catch: private mode or blocked storage must not break capture) ----------
function load(key, fallback) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
function store(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch { return false; }
}

// ---------- state ----------
let plan;
try { plan = G.normalisePlan(load(KEY_PLAN, null) || G.newPlan()); } catch { plan = G.newPlan(); }
let lightList = load(KEY_LIGHTS, null);
try { lightList = G.parseLightList(lightList || { lights: [] }); } catch { lightList = { lights: [], switches: [], areas: [] }; }
const ui = Object.assign({ mode: 'room', roomTool: 'corner', itemType: 'outlet', doorKind: 'door' }, load(KEY_UI, {}));
let openRoom = null;            // room object being captured (also in plan.rooms)
let wallFirst = null;           // first point of the wall being tapped (walls mode)
let doorFirst = null;           // first door/opening side while placing
let lastDoor = null;            // door just placed (for the optional swing buttons)
let align = null;               // {room, step:0|1, n1}
let paused = false;             // modal open: AR taps ignored
let pendingWarn = null;         // {key, t}: second press confirms placing outside every room
let session = null, renderer, scene, camera, hitSource = null, refSpace = null;
let sessionInfo = null;         // entry in plan.capture.sessions for this AR session
let transform = null;           // maps this session's raw plan coords into the plan frame
let reticleHit = null;          // {pos, raw, horizontal, vertical, ceiling, upY}
let fp = null;                  // floor point under the crosshair this frame: {ok, how, pos, raw} (plan frame)
let viewer = null;              // {raw, heading, y, pos:{x,y,z}, fwd:{x,y,z}}
let tracking = 'none';          // 'ok' | 'lost' | 'none'
let depthOK = false, noDepthNextTime = false;
let pole = null;                // {pos (xr), h}
const ceilSamples = [];         // {h, src, t}
let ceilPlaneY = null;
const floorSamples = [];
let floorY = null;

function savePlan() {
  plan.updated = new Date().toISOString();
  plan.capture.floor_y = floorY ?? plan.capture.floor_y;
  store(KEY_PLAN, plan);
  refreshLanding();
}
const saveUI = () => store(KEY_UI, ui);

// ---------- coordinate helpers ----------
const toPlan = (raw) => (transform ? G.applyTransform(raw, transform) : raw);
function planToXR(p, h = 0.01) { // inverse of toPlan + xrToPlan, at floor height + h
  let q = p;
  if (transform) { q = [p[0] - transform.tx, p[1] - transform.ty]; q = G.rotate(q, -transform.ang); }
  return new THREE.Vector3(q[0], (floorY ?? -1.4) + h, -q[1]);
}
function hasEarlierData() { return plan.rooms.some((r) => r.points.length >= 2); }
function frameUnknown() { return !!(sessionInfo && sessionInfo.need_align && !transform && !sessionInfo.skipped_align); }
const rot = () => G.viewRotation(plan);

// First wall of the house reads horizontal (view only; raw coordinates are unchanged).
function maybeSetOrientation() {
  if (plan.orientation) return;
  for (const r of plan.rooms) {
    const w = r.seq && r.seq.find((e) => e.w);
    const [a, b] = w && r.seq[0] === w ? w.w : r.points.length >= 2 ? r.points : [null, null];
    if (a && b && G.dist(a, b) > 0.3) {
      plan.orientation = { rot_deg: Math.round(G.orientationForWall(a, b) * 180 / Math.PI * 100) / 100, source: 'first-wall' };
      return;
    }
  }
}

// ---------- drawing (shared by the AR mini map and the edit view) ----------
const COL = { room: '#4fa3ff', open: '#ffb020', light: '#ffd84a', door: '#c98a4b', opening: '#40c8b0', outlet: '#7fe0ff', switch: '#c79bff', other: '#b9c2cc', sel: '#ff5ad1' };

// view: {s (px per m), cx, cy (view-frame centre), w, h, rot}
function makeView(points, w, h, rotA, minSpan = 4, pad = 24) {
  const vp = points.map((p) => G.rotate(p, rotA));
  const b = G.bounds(vp);
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, minSpan);
  return { s: (Math.min(w, h) - pad) / span, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, w, h, rot: rotA };
}
const toScr = (v, p) => { const q = G.rotate(p, v.rot); return [v.w / 2 + (q[0] - v.cx) * v.s, v.h / 2 - (q[1] - v.cy) * v.s]; };
const fromScr = (v, x, y) => G.rotate([(x - v.w / 2) / v.s + v.cx, -(y - v.h / 2) / v.s + v.cy], -v.rot);

function planPoints() {
  const pts = [];
  plan.rooms.forEach((r) => pts.push(...r.points));
  plan.lights.forEach((l) => pts.push([l.x, l.y]));
  plan.items.forEach((i) => pts.push([i.x, i.y]));
  plan.doors.forEach((d) => pts.push(d.a, d.b));
  return pts;
}

function itemIcon(ctx, type, x, y, r = 6, label = '') {
  ctx.save();
  ctx.lineWidth = 1.5;
  if (type === 'outlet') {
    ctx.fillStyle = '#0c0f13'; ctx.strokeStyle = COL.outlet;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - r * 0.35, y - r * 0.45); ctx.lineTo(x - r * 0.35, y + r * 0.45);
    ctx.moveTo(x + r * 0.35, y - r * 0.45); ctx.lineTo(x + r * 0.35, y + r * 0.45); ctx.stroke();
  } else if (type === 'switch') {
    ctx.fillStyle = '#0c0f13'; ctx.strokeStyle = COL.switch;
    ctx.fillRect(x - r * 0.8, y - r, r * 1.6, r * 2); ctx.strokeRect(x - r * 0.8, y - r, r * 1.6, r * 2);
    ctx.beginPath(); ctx.moveTo(x, y - r * 0.5); ctx.lineTo(x, y + r * 0.2); ctx.stroke();
  } else {
    ctx.fillStyle = COL.other;
    ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill();
    if (label) { ctx.fillStyle = '#dfe5ec'; ctx.textAlign = 'left'; ctx.fillText(label, x + r + 2, y + 4); }
  }
  ctx.restore();
}

function drawPlan(ctx, v, opt = {}) {
  const { w, h } = v, S = (p) => toScr(v, p);
  ctx.clearRect(0, 0, w, h);
  // 1 m grid (in the view frame)
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
  const half = Math.max(w, h) / v.s;
  for (let g = Math.floor(v.cx - half); g <= v.cx + half; g++) { const x = v.w / 2 + (g - v.cx) * v.s; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let g = Math.floor(v.cy - half); g <= v.cy + half; g++) { const y = v.h / 2 - (g - v.cy) * v.s; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  let sel = opt.sel || null;
  ctx.font = '12px system-ui'; ctx.textAlign = 'center';
  plan.rooms.forEach((r, ri) => {
    if (!r.points.length) return;
    ctx.beginPath();
    r.points.forEach((p, i) => { const [x, y] = S(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (r.closed) { ctx.closePath(); ctx.fillStyle = sel && sel.kind === 'room' && sel.i === ri ? 'rgba(255,90,209,.18)' : 'rgba(79,163,255,.15)'; ctx.fill(); }
    ctx.strokeStyle = r === openRoom ? COL.open : COL.room; ctx.lineWidth = 2; ctx.stroke();
    if (r === openRoom && opt.cur) {
      const last = wallFirst || r.points[r.points.length - 1];
      if (last) { ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(...S(last)); ctx.lineTo(...S(opt.cur)); ctx.stroke(); ctx.setLineDash([]); }
    }
    // tapped wall segments (walls mode) drawn thicker on top
    if (r.seq) for (const e of r.seq) if (e.w) { ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(...S(e.w[0])); ctx.lineTo(...S(e.w[1])); ctx.stroke(); }
    ctx.fillStyle = r === openRoom ? COL.open : COL.room;
    r.points.forEach((p) => { const [x, y] = S(p); ctx.fillRect(x - 2, y - 2, 4, 4); });
    if (r.closed && r.points.length >= 3 && opt.labels !== false) {
      const [x, y] = S(G.centroid(r.points)); ctx.fillStyle = '#cfe3ff';
      ctx.fillText(r.name, x, y);
      ctx.fillStyle = '#8fa3b8';
      ctx.fillText(`${G.area(r.points).toFixed(1)} m²${r.ceiling_m ? ' · ' + r.ceiling_m.toFixed(2) + ' m' : ''}`, x, y + 14);
    }
  });
  if (sel && (sel.kind === 'edge' || sel.kind === 'vertex') && !(plan.rooms[sel.i] && plan.rooms[sel.i].points[sel.j])) sel = null;
  if (sel && sel.kind === 'edge') {
    const pts = plan.rooms[sel.i].points, a = pts[sel.j], b = pts[(sel.j + 1) % pts.length];
    ctx.strokeStyle = COL.sel; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(...S(a)); ctx.lineTo(...S(b)); ctx.stroke();
  }
  if (sel && sel.kind === 'vertex') { const [x, y] = S(plan.rooms[sel.i].points[sel.j]); ctx.strokeStyle = COL.sel; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.stroke(); }
  if (wallFirst && opt.ar) { const [x, y] = S(wallFirst); ctx.fillStyle = COL.open; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); }
  if (opt.predicted) { const [x, y] = S(opt.predicted); ctx.strokeStyle = COL.sel; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6); ctx.stroke(); }
  // align references
  if (align && align.room) {
    const [A, B] = align.room.points;
    for (const [p, t] of [[A, 'A'], [B, 'B']]) {
      const [x, y] = S(p); ctx.fillStyle = COL.sel; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
      ctx.fillStyle = '#000'; ctx.fillText(t, x, y + 4);
    }
  }
  // doors (solid brown) and openings (dashed teal)
  plan.doors.forEach((d, i) => {
    const isSel = sel && sel.kind === 'door' && sel.i === i;
    ctx.strokeStyle = isSel ? COL.sel : d.kind === 'opening' ? COL.opening : COL.door; ctx.lineWidth = 4;
    if (d.kind === 'opening') ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(...S(d.a)); ctx.lineTo(...S(d.b)); ctx.stroke(); ctx.setLineDash([]);
    if (d.swing) { // small tick showing the hinge end and opening side
      const hinge = d.swing.hinge === 'a' ? d.a : d.b, dx = d.b[0] - d.a[0], dy = d.b[1] - d.a[1], L = Math.hypot(dx, dy) || 1;
      const n = [-dy / L * d.swing.side * L, dx / L * d.swing.side * L];
      ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(...S(hinge)); ctx.lineTo(...S([hinge[0] + n[0], hinge[1] + n[1]])); ctx.stroke();
    }
  });
  if (doorFirst) { const [x, y] = S(doorFirst); ctx.fillStyle = COL.door; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); }
  // lights and items
  plan.lights.forEach((l, i) => {
    const [x, y] = S([l.x, l.y]); ctx.fillStyle = COL.light; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
    if (sel && sel.kind === 'light' && sel.i === i) { ctx.strokeStyle = COL.sel; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.stroke(); }
    if (opt.names) { ctx.fillStyle = '#e8d78a'; ctx.textAlign = 'left'; ctx.fillText(l.name, x + 8, y + 4); ctx.textAlign = 'center'; }
  });
  plan.items.forEach((it, i) => {
    const [x, y] = S([it.x, it.y]); itemIcon(ctx, it.type, x, y, 6, opt.names ? it.label || it.name : '');
    if (sel && sel.kind === 'item' && sel.i === i) { ctx.strokeStyle = COL.sel; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.stroke(); }
  });
  // candidate marker (what a tap would place) and me
  if (opt.cur) {
    const [x, y] = S(opt.cur);
    ctx.strokeStyle = opt.curBad ? COL.sel : opt.curColor || '#fff'; ctx.lineWidth = opt.curBad ? 3 : 1.5;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.stroke();
  }
  if (pole && opt.ar) { const [x, y] = S(toPlan(G.xrToPlan(pole.pos))); ctx.fillStyle = '#ff7b3a'; ctx.fillRect(x - 3, y - 3, 6, 6); }
  if (opt.me && viewer) {
    const me = opt.me, hd = G.rotate(transform ? G.rotate(viewer.heading, transform.ang) : viewer.heading, v.rot);
    const [x, y] = S(me);
    ctx.fillStyle = tracking === 'ok' ? '#3fcf7f' : '#ff5a5a';
    ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
    ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + hd[0] * 0.8 * v.s, y - hd[1] * 0.8 * v.s); ctx.stroke();
  }
  // scale bar (1 m)
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(8, h - 8); ctx.lineTo(8 + v.s, h - 8); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText('1 m', 10, h - 12);
}

function prepCanvas(c) {
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth || 300, h = c.clientHeight || 300;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// ---------- AR mini map ----------
const mapCanvas = document.createElement('canvas');
$('mapWrapAR').appendChild(mapCanvas);
let liveMarker = null;          // {p, bad, color}
let livePredicted = null;
function drawMap() {
  if (!session) return;
  const { ctx, w, h } = prepCanvas(mapCanvas);
  const pts = planPoints();
  const me = viewer ? toPlan(viewer.raw) : null;
  if (me) pts.push(me);
  if (liveMarker) pts.push(liveMarker.p);
  drawPlan(ctx, makeView(pts, w, h, rot()), { ar: true, me, cur: liveMarker && liveMarker.p, curBad: liveMarker && liveMarker.bad, curColor: liveMarker && liveMarker.color, predicted: livePredicted, labels: true });
}

// ---------- modal (top of screen, opaque; pauses AR taps; keyboard-safe) ----------
function setVVH() { const vv = window.visualViewport; document.documentElement.style.setProperty('--vvh', (vv ? vv.height : window.innerHeight) + 'px'); }
window.visualViewport && window.visualViewport.addEventListener('resize', setVVH); setVVH();
function modal({ title, html = '', input = null, chips = [], ok = 'OK', cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    paused = true;
    $('mTitle').textContent = title; $('mBody').innerHTML = html;
    const inp = $('mInput');
    inp.style.display = input ? '' : 'none';
    if (input) { inp.value = input.value ?? ''; inp.placeholder = input.placeholder || ''; inp.inputMode = input.inputmode || 'text'; inp.type = input.type || 'text'; if (input.step) inp.step = input.step; }
    const box = $('mChips'); box.innerHTML = '';
    for (const c of chips) {
      const b = document.createElement('button'); b.textContent = c.label ?? c;
      b.onclick = () => done(c.value !== undefined ? c.value : c);
      box.appendChild(b);
    }
    $('mOk').textContent = ok; $('mOk').style.display = ok ? '' : 'none';
    $('mCancel').textContent = cancel; $('mCancel').style.display = cancel ? '' : 'none';
    $('modal').classList.add('on');
    function done(v) {
      $('modal').classList.remove('on'); inp.blur(); paused = false;
      $('mOk').onclick = $('mCancel').onclick = inp.onkeydown = null;
      setTimeout(() => resolve(v), 0);
    }
    $('mOk').onclick = () => done(input ? inp.value.trim() : true);
    $('mCancel').onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim()); };
    if (input && input.focus !== false) setTimeout(() => inp.focus(), 50);
  });
}

const HELP_HTML = `<ol>
<li><b>Start in a central room</b> with good light. Sweep the phone slowly over the floor until the ring turns green.</li>
<li><b>Walk slowly</b>; keep the camera seeing the floor and walls, never cover the camera.</li>
<li><b>Room</b> tab → <i>New room…</i> → pick the name. Use <b>Corner</b> to tap visible floor corners in order round the room, or <b>Wall</b> to tap two points along the base of a wall where the corner is hidden (bookshelf, sofa) — the corner between two walls is computed and shown as a pink ✕. Mix both freely, then <i>Close room</i>. A hallway can be its own room.</li>
<li><b>Entering the next room:</b> stop in the doorway, mark the <b>Door</b> (two jambs) or <b>Opening</b> (two sides of a doorless gap) first, then capture the room. Doorways are good pauses for tracking.</li>
<li><b>Keep the AR session running</b> between rooms — don't Exit until the house is done.</li>
<li><b>Ceiling</b>: point the phone at the ceiling (auto, if the phone can see it) or use the <i>Pole</i> and raise it until it touches the ceiling.</li>
<li><b>Lights</b>: aim at the floor straight below the light. <b>Outlets / switches</b>: aim at the outlet on the wall (gives its height) or the floor below it.</li>
<li><b>Tracking lost</b> (red banner): stop, point at a textured area, step back to where you were. If AR restarts, re-anchor with the <b>Align</b> tab (two corners of a room you already captured).</li>
<li>When done: <i>Exit</i>, fix anything in the edit view, <i>Save plan file</i>.</li></ol>`;
$('helpLanding').innerHTML = HELP_HTML;
$('btnHelp').onclick = () => modal({ title: 'How to scan', html: HELP_HTML, cancel: null, ok: 'Close' });

async function askRoomName(def = '') {
  const used = new Set(plan.rooms.map((r) => r.name));
  const chips = lightList.areas.filter((a) => !used.has(a)).concat(['Hallway']).filter((a, i, s) => s.indexOf(a) === i);
  return modal({ title: 'Room name', input: { value: def, placeholder: 'Type a name or pick one below', focus: !chips.length }, chips, ok: 'Start' });
}

// ---------- landing page ----------
function refreshLanding() {
  const closed = plan.rooms.filter((r) => r.closed).length;
  const doors = plan.doors.filter((d) => d.kind !== 'opening').length;
  $('planSummary').textContent = `${plan.rooms.length} room(s) (${closed} closed), ${plan.lights.length} light(s), ${plan.items.length} outlet/switch/other, ${doors} door(s), ${plan.doors.length - doors} opening(s)` +
    (plan.rooms.length ? ' — ' + plan.rooms.map((r) => r.name + (r.ceiling_m ? ` (${r.ceiling_m.toFixed(2)} m)` : '')).join(', ') : '');
  const placed = new Set(plan.lights.map((l) => l.entity_id || l.name));
  $('lightsSummary').textContent = lightList.lights.length
    ? `${lightList.lights.length} light(s) in list, ${lightList.lights.filter((l) => placed.has(l.entity_id || l.name)).length} placed; ${lightList.switches.length} switch/plug entities.`
    : 'No list loaded — you can still type a name for each light in AR.';
  drawEditor();
}

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function readFile(input, cb) {
  input.onchange = () => {
    const f = input.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { cb(String(r.result)); } catch (e) { alert('Could not read that file: ' + e.message); } input.value = ''; };
    r.readAsText(f);
  };
  input.click();
}

$('btnSave').onclick = () => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  download(`floorplan-${stamp}.json`, G.exportPlan(plan));
};
$('btnLoadPlanProxy').onclick = () => readFile($('filePlan'), (t) => {
  plan = G.normalisePlan(JSON.parse(t)); openRoom = null; edSel = null; edView = null; savePlan();
  alert('Plan loaded. When you start AR you will be asked to align with two corners of a room.');
});
$('btnClear').onclick = () => {
  if (!confirm('Delete the captured plan on this device? (Save the file first if you need it.)')) return;
  pushUndo(); plan = G.newPlan(); openRoom = null; edSel = null; edView = null; savePlan();
};
function setLightList(list, note) {
  lightList = list; store(KEY_LIGHTS, lightList); refreshLanding();
  if (note) $('linkNote').textContent = note;
}
$('btnLoadLightsProxy').onclick = () => readFile($('fileLights'), (t) => setLightList(G.parseLightList(t)));
$('btnAddTyped').onclick = () => {
  const names = $('typedLights').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const extra = G.parseLightList(JSON.stringify(names)).lights;
  lightList.lights.push(...extra); $('typedLights').value = ''; setLightList(lightList);
};
$('btnClearLights').onclick = () => setLightList({ lights: [], switches: [], areas: [] });

// ---------- 2D edit view ----------
const edCanvas = $('editCanvas');
let edView = null, edSel = null, edDrag = null;
const undoStack = [];
function pushUndo() { undoStack.push(JSON.stringify(plan)); if (undoStack.length > 40) undoStack.shift(); }
$('btnEdUndo').onclick = () => {
  if (!undoStack.length) return;
  plan = G.normalisePlan(JSON.parse(undoStack.pop())); openRoom = plan.rooms.find((r) => !r.closed) || null; edSel = null; savePlan();
};
$('btnEdFit').onclick = () => { edView = null; drawEditor(); };
$('btnEdSquare').onclick = () => {
  if (!plan.rooms.some((r) => r.points.length >= 3)) return;
  if (!confirm('Square up walls: walls within 12° of the plan axes become exactly straight and shared walls of neighbouring rooms (closer than 15 cm) are snapped together. Undo is available.')) return;
  pushUndo();
  const out = G.squareRooms(plan.rooms, rot());
  plan.rooms.forEach((r, i) => { if (r.points.length >= 3) { r.points = out[i]; r.seq = out[i].map((c) => ({ c: [...c] })); } });
  edSel = null; savePlan();
};

function fitView(w, h) { return makeView(planPoints(), w, h, rot(), 4, 40); }
function drawEditor() {
  if (session) return;
  const { ctx, w, h } = prepCanvas(edCanvas);
  if (!edView || edView.w !== w || edView.h !== h || edView.rot !== rot()) {
    const keep = edView && edView.w === w && edView.h === h && edView.userMoved;
    if (!keep) edView = fitView(w, h); else edView.rot = rot();
  }
  drawPlan(ctx, edView, { sel: edSel, names: true });
  renderSelPanel();
}

// Hit-test the edit view in screen space: draggable points first, then walls, then rooms.
function edPick(x, y) {
  const v = edView, d = (p) => Math.hypot(toScr(v, p)[0] - x, toScr(v, p)[1] - y);
  let best = null;
  const consider = (o, dd, r) => { if (dd <= r && (!best || dd < best.d)) best = { ...o, d: dd }; };
  plan.lights.forEach((l, i) => consider({ kind: 'light', i }, d([l.x, l.y]), 22));
  plan.items.forEach((it, i) => consider({ kind: 'item', i }, d([it.x, it.y]), 22));
  plan.doors.forEach((dr, i) => { consider({ kind: 'door', i, end: 'a' }, d(dr.a), 18); consider({ kind: 'door', i, end: 'b' }, d(dr.b), 18); });
  plan.rooms.forEach((r, i) => r.points.forEach((p, j) => consider({ kind: 'vertex', i, j }, d(p), 16)));
  if (best) return best;
  const P = fromScr(v, x, y);
  plan.doors.forEach((dr, i) => consider({ kind: 'door', i }, G.segDist(P, dr.a, dr.b) * v.s, 12));
  plan.rooms.forEach((r, i) => r.points.forEach((p, j) => { if (r.closed || j < r.points.length - 1) consider({ kind: 'edge', i, j }, G.segDist(P, p, r.points[(j + 1) % r.points.length]) * v.s, 12); }));
  if (best) return best;
  const ri = plan.rooms.findIndex((r) => r.closed && r.points.length >= 3 && G.pointInPolygon(P, r.points));
  return ri >= 0 ? { kind: 'room', i: ri } : null;
}

const pointers = new Map();
let pinch = null;
edCanvas.addEventListener('pointerdown', (e) => {
  edCanvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: edView.s, mid: [(a.x + b.x) / 2, (a.y + b.y) / 2], c: [edView.cx, edView.cy] };
    edDrag = null; return;
  }
  const hit = edPick(e.offsetX, e.offsetY);
  const draggable = hit && ['light', 'item', 'vertex'].includes(hit.kind) || (hit && hit.kind === 'door' && hit.end);
  edDrag = { hit, draggable, x0: e.offsetX, y0: e.offsetY, moved: false, pan: !draggable, c0: [edView.cx, edView.cy] };
});
edCanvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    edView.s = Math.max(5, Math.min(2000, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / (pinch.d || 1)));
    const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    edView.cx = pinch.c[0] - (mid[0] - pinch.mid[0]) / edView.s; edView.cy = pinch.c[1] + (mid[1] - pinch.mid[1]) / edView.s;
    edView.userMoved = true; drawEditor(); return;
  }
  const g = edDrag; if (!g) return;
  if (!g.moved && Math.hypot(e.offsetX - g.x0, e.offsetY - g.y0) < 6) return;
  if (!g.moved) {
    g.moved = true;
    if (g.draggable) { pushUndo(); edSel = g.hit; if (g.hit.kind === 'vertex') G.freezeRoom(plan.rooms[g.hit.i]); }
  }
  if (g.pan) {
    edView.cx = g.c0[0] - (e.offsetX - g.x0) / edView.s; edView.cy = g.c0[1] + (e.offsetY - g.y0) / edView.s;
    edView.userMoved = true; drawEditor(); return;
  }
  const P = fromScr(edView, e.offsetX, e.offsetY).map(G.round3), h = g.hit;
  if (h.kind === 'light') Object.assign(plan.lights[h.i], { x: P[0], y: P[1] });
  else if (h.kind === 'item') Object.assign(plan.items[h.i], { x: P[0], y: P[1] });
  else if (h.kind === 'door') plan.doors[h.i][h.end] = P;
  else if (h.kind === 'vertex') { const r = plan.rooms[h.i]; r.points[h.j] = P; r.seq[h.j] = { c: P }; }
  drawEditor();
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinch) { if (pointers.size < 2) pinch = null; edDrag = null; return; }
  const g = edDrag; edDrag = null; if (!g) return;
  if (!g.moved) { edSel = g.hit; drawEditor(); return; }
  if (g.draggable) {
    const h = g.hit;
    if (h.kind === 'light') { const l = plan.lights[h.i]; l.room = G.roomAt(plan, [l.x, l.y]); }
    if (h.kind === 'item') { const it = plan.items[h.i]; it.room = G.roomNear(plan, [it.x, it.y], 0.3); }
    savePlan();
  }
}
edCanvas.addEventListener('pointerup', endPointer);
edCanvas.addEventListener('pointercancel', endPointer);
edCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = fromScr(edView, e.offsetX, e.offsetY);
  edView.s = Math.max(5, Math.min(2000, edView.s * Math.exp(-e.deltaY * 0.0015)));
  const after = fromScr(edView, e.offsetX, e.offsetY);
  const b = G.rotate(before, edView.rot), a = G.rotate(after, edView.rot);
  edView.cx += b[0] - a[0]; edView.cy += b[1] - a[1]; edView.userMoved = true; drawEditor();
}, { passive: false });

function btn(label, fn, cls = '') { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b; }
function entityChips(kind) {
  const ents = kind === 'light' ? lightList.lights.filter((l) => l.entity_id) : lightList.switches;
  return [{ label: '— none —', value: '' }, ...ents.map((l) => ({ label: `${l.name}${l.area ? ' · ' + l.area : ''}`, value: l.entity_id }))];
}
async function askNumber(title, value, html = '') {
  const v = await modal({ title, html, input: { value: value ?? '', type: 'number', inputmode: 'decimal', step: '0.01', placeholder: 'metres' } });
  if (v === null) return undefined;
  if (v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? G.round3(n) : undefined;
}
function edit(fn) { return async () => { const snap = JSON.stringify(plan); const r = await fn(); if (r !== false) { undoStack.push(snap); savePlan(); } }; }

function renderSelPanel() {
  const p = $('selPanel'); p.innerHTML = '';
  const s = edSel;
  if (!s) { p.textContent = 'Nothing selected. Tap a room, a wall, a corner, a light or an item.'; return; }
  const info = document.createElement('div'), row = document.createElement('div');
  row.className = 'row'; row.style.marginTop = '8px';
  const del = (arr, i) => edit(() => { arr.splice(i, 1); edSel = null; });
  if (s.kind === 'room' || s.kind === 'vertex' || s.kind === 'edge') {
    const r = plan.rooms[s.i]; if (!r) { edSel = null; return; }
    const mode = !r.seq ? 'corners' : r.seq.every((e) => e.w) ? 'walls' : r.seq.some((e) => e.w) ? 'mixed' : 'corners';
    info.textContent = `${r.name}: ${r.points.length} corners (${mode}), ${r.closed ? G.area(r.points).toFixed(2) + ' m²' : 'not closed'}, ceiling ${r.ceiling_m ? r.ceiling_m.toFixed(2) + ' m (' + (r.ceiling_src || 'set') + ')' : 'not set'}`;
    if (s.kind === 'edge') {
      const a = r.points[s.j], b = r.points[(s.j + 1) % r.points.length];
      info.textContent += ` — wall ${G.dist(a, b).toFixed(2)} m`;
      row.append(btn('Make this wall horizontal', edit(() => { plan.orientation = { rot_deg: Math.round(G.orientationForWall(a, b) * 18000 / Math.PI) / 100, source: 'manual' }; edView = null; })));
    }
    if (s.kind === 'vertex') row.append(btn('Delete corner', edit(() => { if (r.points.length <= 3) return false; G.freezeRoom(r); r.points.splice(s.j, 1); r.seq.splice(s.j, 1); edSel = { kind: 'room', i: s.i }; })));
    row.append(btn('Rename', edit(async () => { const n = await modal({ title: 'Room name', input: { value: r.name } }); if (!n) return false; r.name = n; })));
    row.append(btn('Ceiling height', edit(async () => { const n = await askNumber(`Ceiling height of ${r.name}`, r.ceiling_m, 'Leave empty to clear.'); if (n === undefined) return false; r.ceiling_m = n; r.ceiling_src = n == null ? null : 'typed'; })));
    if (!r.closed && r.points.length >= 3) row.append(btn('Close room', edit(() => { G.closeRoom(r); if (openRoom === r) openRoom = null; })));
    row.append(btn('Delete room', edit(() => { if (!confirm(`Delete ${r.name}?`)) return false; plan.rooms.splice(s.i, 1); if (openRoom === r) openRoom = null; edSel = null; }), 'danger'));
  } else if (s.kind === 'light') {
    const l = plan.lights[s.i]; if (!l) { edSel = null; return; }
    info.textContent = `Light: ${l.name}${l.entity_id ? ' (' + l.entity_id + ')' : ' — no entity id, will not be on the card'}${l.room ? ' · ' + l.room : ' · outside every room!'}`;
    row.append(btn('Rename', edit(async () => { const n = await modal({ title: 'Light name', input: { value: l.name } }); if (!n) return false; l.name = n; })));
    if (lightList.lights.some((x) => x.entity_id)) row.append(btn('Link entity', edit(async () => { const v = await modal({ title: 'Which light entity?', chips: entityChips('light'), ok: null }); if (v === null) return false; l.entity_id = v; const e = lightList.lights.find((x) => x.entity_id === v); if (e) l.name = e.name; })));
    row.append(btn('Delete', del(plan.lights, s.i), 'danger'));
  } else if (s.kind === 'item') {
    const it = plan.items[s.i]; if (!it) { edSel = null; return; }
    info.textContent = `${it.type}${it.label ? ': ' + it.label : ''}${it.entity_id ? ' → ' + it.entity_id : ''}${it.height_m != null ? ', ' + it.height_m.toFixed(2) + ' m up' : ''}${it.room ? ' · ' + it.room : ' · outside every room'}`;
    row.append(btn('Type', edit(async () => { const v = await modal({ title: 'Item type', chips: G.ITEM_TYPES, ok: null }); if (!v) return false; it.type = v; })));
    row.append(btn('Label', edit(async () => { const v = await modal({ title: 'Label', input: { value: it.label } }); if (v === null) return false; it.label = v; })));
    row.append(btn('Height', edit(async () => { const n = await askNumber('Height above the floor', it.height_m, 'Leave empty if unknown.'); if (n === undefined) return false; it.height_m = n; })));
    row.append(btn('Link smart plug / switch', edit(async () => { const v = await modal({ title: 'Home Assistant entity (switch / plug)', chips: entityChips('switch'), input: { value: it.entity_id, placeholder: 'or type an entity id', focus: false } }); if (v === null) return false; it.entity_id = v; const e = lightList.switches.find((x) => x.entity_id === v); if (e && !it.label) it.label = e.name; })));
    row.append(btn('Delete', del(plan.items, s.i), 'danger'));
  } else if (s.kind === 'door') {
    const d = plan.doors[s.i]; if (!d) { edSel = null; return; }
    info.textContent = `${d.kind === 'opening' ? 'Opening' : 'Door'} ${G.dist(d.a, d.b).toFixed(2)} m${d.swing ? `, hinge side ${d.swing.hinge === 'a' ? 1 : 2}` : ''}`;
    row.append(btn(d.kind === 'opening' ? 'Make it a door' : 'Make it an opening', edit(() => { d.kind = d.kind === 'opening' ? 'door' : 'opening'; if (d.kind === 'opening') delete d.swing; })));
    if (d.kind === 'door') {
      row.append(btn('Swap hinge', edit(() => { d.swing = { hinge: d.swing && d.swing.hinge === 'a' ? 'b' : 'a', side: d.swing ? d.swing.side : 1 }; })));
      row.append(btn('Flip swing side', edit(() => { d.swing = { hinge: d.swing ? d.swing.hinge : 'a', side: d.swing ? -d.swing.side : -1 }; })));
    }
    row.append(btn('Delete', del(plan.doors, s.i), 'danger'));
  }
  p.append(info, row);
}

// ---------- AR overlay UI ----------
function toast(msg, ms = 1800) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), ms);
}
function buzz(ms = 30) { try { navigator.vibrate && navigator.vibrate(ms); } catch {} }

function setMode(m) {
  ui.mode = m; saveUI();
  document.querySelectorAll('#tabs button[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  document.querySelectorAll('.modepanel').forEach((p) => p.classList.toggle('on', p.dataset.panel === m));
  if (m === 'align') startAlign(); else align = null;
  if (m !== 'ceiling') { pole = null; updatePoleMesh(); }
  ceilSamples.length = 0; pendingWarn = null;
  refreshModeUI();
}
document.querySelectorAll('#tabs button[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

function refreshModeUI() {
  $('roomIdle').style.display = openRoom ? 'none' : '';
  $('roomActive').style.display = openRoom ? '' : 'none';
  $('roomIdleInfo').textContent = `${plan.rooms.filter((r) => r.closed).length} room(s) done. Mark the door/opening first when you enter a new room.`;
  document.querySelectorAll('#roomActive .seg button').forEach((b) => b.classList.toggle('on', b.dataset.tool === ui.roomTool));
  if (openRoom) {
    const n = openRoom.points.length;
    $('roomInfo').textContent = ui.roomTool === 'wall'
      ? `${openRoom.name}: ${n} corner(s). Tap two points along the base of the next wall (anywhere it is visible). Walls go round the room in order.`
      : `${openRoom.name}: ${n} corner(s). Tap floor corners in order; aim at the first corner again (or Close) to finish.`;
    $('btnCorner').textContent = ui.roomTool === 'wall' ? (wallFirst ? 'Wall: point 2' : 'Wall: point 1') : 'Add corner';
    $('btnClose').disabled = G.polygonFromSeq(openRoom.seq || openRoom.points.map((c) => ({ c })), true).length < 3;
  }
  // light select: unplaced first, then placed (re-placing moves it)
  const placed = new Set(plan.lights.map((l) => l.entity_id || l.name));
  const sel = $('lightSelect'), prev = sel.value;
  sel.innerHTML = '';
  const here = fp && fp.ok ? G.roomAt(plan, fp.raw) : null;
  const sorted = [...lightList.lights].sort((a, b) =>
    (placed.has(a.entity_id || a.name) - placed.has(b.entity_id || b.name)) ||
    ((b.area === here) - (a.area === here)) || String(a.area).localeCompare(String(b.area)) || a.name.localeCompare(b.name));
  if (!sorted.length) sel.innerHTML = '<option value="">(no list loaded — use Type…)</option>';
  for (const l of sorted) {
    const o = document.createElement('option');
    o.value = l.entity_id || l.name;
    o.textContent = `${placed.has(o.value) ? '✓ ' : ''}${l.name}${l.area ? ' · ' + l.area : ''}`;
    sel.appendChild(o);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  // items
  document.querySelectorAll('[data-item]').forEach((b) => b.classList.toggle('on', b.dataset.item === ui.itemType));
  $('plugRow').style.display = ui.itemType === 'outlet' || ui.itemType === 'switch' ? '' : 'none';
  const ps = $('plugSelect'), pprev = ps.value; ps.innerHTML = '';
  const none = document.createElement('option'); none.value = ''; none.textContent = ui.itemType === 'outlet' ? 'Smart plug: none (plain outlet)' : 'Linked entity: none'; ps.appendChild(none);
  for (const s of lightList.switches) { const o = document.createElement('option'); o.value = s.entity_id; o.textContent = `${s.name}${s.area ? ' · ' + s.area : ''}`; ps.appendChild(o); }
  if ([...ps.options].some((o) => o.value === pprev)) ps.value = pprev;
  $('btnItem').textContent = { outlet: 'Place outlet', switch: 'Place switch', other: 'Place item…' }[ui.itemType];
  $('itemInfo').textContent = ui.itemType === 'other' ? 'Aim at it (or the floor below it); you will be asked for a label.' : 'Aim at it on the wall (records its height) or at the floor right below it.';
  // doors
  document.querySelectorAll('[data-door]').forEach((b) => b.classList.toggle('on', b.dataset.door === ui.doorKind));
  const kindName = ui.doorKind === 'opening' ? 'opening' : 'doorway';
  $('btnDoor').textContent = doorFirst ? 'Side 2' : 'Side 1';
  $('doorInfo').textContent = doorFirst ? `Now aim at the other side of the ${kindName} on the floor.` : ui.doorKind === 'opening'
    ? 'Opening without a door (arch, hallway): aim at the floor at one side, then the other.'
    : 'Aim at the floor at one door jamb, then the other.';
  $('swingRow').style.display = lastDoor && !doorFirst && ui.doorKind === 'door' ? '' : 'none';
  // ceiling room list
  const cr = $('ceilRoom'), cprev = cr.value; cr.innerHTML = '';
  plan.rooms.forEach((r, i) => { const o = document.createElement('option'); o.value = i; o.textContent = `${r.name}${r.ceiling_m ? ' — ' + r.ceiling_m.toFixed(2) + ' m' : ''}`; cr.appendChild(o); });
  if (!plan.rooms.length) cr.innerHTML = '<option value="">(capture a room first)</option>';
  else if (cprev !== '' && plan.rooms[cprev]) cr.value = cprev;
  else { const me = viewer && G.roomAt(plan, toPlan(viewer.raw)); const i = plan.rooms.findIndex((r) => r.name === me); cr.value = String(i >= 0 ? i : plan.rooms.length - 1); }
  $('ceilMain').style.display = pole ? 'none' : '';
  $('poleUI').style.display = pole ? '' : 'none';
  // align
  const rs = $('alignRoom'); const rprev = rs.value; rs.innerHTML = '';
  plan.rooms.forEach((r, i) => { if (r.points.length >= 2) { const o = document.createElement('option'); o.value = i; o.textContent = r.name; rs.appendChild(o); } });
  if (align) rs.value = String(plan.rooms.indexOf(align.room)); else if (rprev) rs.value = rprev;
  drawMap();
}

function guard() {
  if (frameUnknown() && ui.mode !== 'align') { toast('Align first (Align tab), or press Skip there'); return false; }
  if (tracking !== 'ok') { toast('Tracking lost — hold still and point at a textured area'); return false; }
  return true;
}
// Floor-constrained point under the crosshair (plan frame), or null with a toast.
function currentFloorPoint() {
  if (!guard()) return null;
  if (!fp || !fp.ok) { toast(floorY == null ? 'Floor not found yet — sweep the phone slowly over the floor' : 'Aim lower, at the floor'); return null; }
  return fp.raw;
}
// Warn (and require a second press) when an item would land outside every room.
function confirmOutside(key, p) {
  if (!G.outsideAllRooms(plan, p, key === 'item' ? 0.3 : 0.15)) { pendingWarn = null; return true; }
  if (pendingWarn && pendingWarn.key === key && performance.now() - pendingWarn.t < 5000) { pendingWarn = null; return true; }
  pendingWarn = { key, t: performance.now() };
  toast('⚠ That spot is outside every room — check the map. Press again to place anyway.', 3500); buzz(120);
  return false;
}

// ----- rooms -----
async function startRoom() {
  const name = await askRoomName();
  if (name === null) return;
  openRoom = G.newRoom(name || `Room ${plan.rooms.length + 1}`); plan.rooms.push(openRoom);
  wallFirst = null; savePlan(); refreshModeUI(); rebuildScene();
}
function roomTapAction() {
  if (!openRoom) { startRoom(); return; }
  const p = currentFloorPoint(); if (!p) return;
  if (ui.roomTool === 'wall') {
    if (!wallFirst) { wallFirst = p; buzz(); refreshModeUI(); rebuildScene(); return; }
    try { G.addWall(openRoom, wallFirst, p); } catch { toast('Tap the two wall points further apart (≥ 25 cm)'); return; }
    wallFirst = null; buzz(); maybeSetOrientation(); savePlan(); refreshModeUI(); rebuildScene();
    return;
  }
  const res = G.addCorner(openRoom, p);
  buzz(); maybeSetOrientation();
  if (res === 'closed') finishRoom(); else { savePlan(); refreshModeUI(); rebuildScene(); }
}
function finishRoom() {
  toast(`${openRoom.name} closed: ${G.area(openRoom.points).toFixed(1)} m²`, 2500);
  openRoom = null; wallFirst = null; maybeSetOrientation(); savePlan(); refreshModeUI(); rebuildScene();
}
$('btnRoomStart').onclick = startRoom;
$('btnCorner').onclick = roomTapAction;
document.querySelectorAll('#roomActive .seg button').forEach((b) => (b.onclick = () => { ui.roomTool = b.dataset.tool; wallFirst = null; saveUI(); refreshModeUI(); rebuildScene(); }));
$('btnUndo').onclick = () => {
  if (!openRoom) return;
  if (wallFirst) wallFirst = null; else G.undoCorner(openRoom);
  savePlan(); refreshModeUI(); rebuildScene();
};
$('btnClose').onclick = () => {
  if (!openRoom) return;
  try { G.closeRoom(openRoom); } catch { toast('Need at least 3 corners'); return; }
  finishRoom();
};
$('btnCancelRoom').onclick = () => {
  if (!openRoom || (openRoom.points.length > 1 && !confirm(`Discard ${openRoom.name}?`))) return;
  plan.rooms = plan.rooms.filter((r) => r !== openRoom); openRoom = null; wallFirst = null; savePlan(); refreshModeUI(); rebuildScene();
};

// ----- lights -----
async function placeLightAction(typed) {
  const p = currentFloorPoint(); if (!p) return;
  let light;
  if (typed) light = { entity_id: typed.startsWith('light.') ? typed : '', name: typed };
  else {
    const v = $('lightSelect').value;
    light = lightList.lights.find((l) => (l.entity_id || l.name) === v);
    if (!light) { toast('Pick a light from the list or use Type…'); return; }
  }
  if (!confirmOutside('light', p)) return;
  const e = G.placeLight(plan, light, p, fp.how);
  buzz(); toast(`${e.name} placed${e.room ? ' in ' + e.room : ''}${fp.how === 'projected' ? ' (projected to floor)' : ''}`);
  savePlan(); $('lightSelect').value = ''; refreshModeUI(); rebuildScene();
}
$('btnLight').onclick = () => placeLightAction();
$('btnLightType').onclick = async () => { const n = await modal({ title: 'Light name or entity id', input: { placeholder: 'light.kitchen_ceiling or Kitchen ceiling' }, ok: 'Place here' }); if (n) placeLightAction(n); };
$('btnLightUndo').onclick = () => { plan.lights.pop(); savePlan(); refreshModeUI(); rebuildScene(); };

// ----- outlets, switches, other -----
document.querySelectorAll('[data-item]').forEach((b) => (b.onclick = () => { ui.itemType = b.dataset.item; saveUI(); refreshModeUI(); }));
async function placeItemAction() {
  if (!guard()) return;
  // Wall hit: use it directly (gives the height). Otherwise the floor point below.
  let p, height = null, onWall = false;
  if (reticleHit && reticleHit.vertical && floorY != null && reticleHit.pos.y - floorY > -0.05 && reticleHit.pos.y - floorY < 2.6) {
    p = reticleHit.raw; height = G.round3(Math.max(0, reticleHit.pos.y - floorY)); onWall = true;
  } else { p = currentFloorPoint(); if (!p) return; }
  if (!confirmOutside('item', p)) return;
  let label = '';
  const entity = ui.itemType !== 'other' ? $('plugSelect').value : '';
  if (ui.itemType === 'other') {
    label = await modal({ title: 'What is it?', input: { placeholder: 'e.g. Router, Thermostat, Smoke alarm' }, chips: ['Router', 'Thermostat', 'Smoke alarm', 'Speaker', 'Camera', 'TV'], ok: 'Place' });
    if (label === null) return;
  } else if (entity) label = (lightList.switches.find((s) => s.entity_id === entity) || {}).name || '';
  const e = G.placeItem(plan, { type: ui.itemType, height_m: height, entity_id: entity, label, on_wall: onWall }, p);
  buzz(); toast(`${e.type}${e.label ? ' ' + e.label : ''} placed${height != null ? ` at ${height.toFixed(2)} m` : ''}${e.room ? ' in ' + e.room : ''}`);
  savePlan(); refreshModeUI(); rebuildScene();
}
$('btnItem').onclick = placeItemAction;
$('btnItemUndo').onclick = () => { plan.items.pop(); savePlan(); refreshModeUI(); rebuildScene(); };

// ----- doors and openings -----
document.querySelectorAll('[data-door]').forEach((b) => (b.onclick = () => { ui.doorKind = b.dataset.door; doorFirst = null; lastDoor = null; saveUI(); refreshModeUI(); }));
function doorAction() {
  const p = currentFloorPoint(); if (!p) return;
  if (!doorFirst) { doorFirst = p; lastDoor = null; buzz(); }
  else {
    const mid = [(doorFirst[0] + p[0]) / 2, (doorFirst[1] + p[1]) / 2];
    const d = { a: doorFirst, b: p, room: G.roomAt(plan, mid), kind: ui.doorKind };
    plan.doors.push(d); lastDoor = d.kind === 'door' ? d : null;
    toast(`${d.kind === 'opening' ? 'Opening' : 'Door'} ${G.dist(doorFirst, p).toFixed(2)} m`); doorFirst = null; buzz(); savePlan(); rebuildScene();
  }
  refreshModeUI();
}
$('btnDoor').onclick = doorAction;
$('btnDoorUndo').onclick = () => { if (doorFirst) doorFirst = null; else { plan.doors.pop(); lastDoor = null; } savePlan(); refreshModeUI(); rebuildScene(); };
document.querySelectorAll('[data-hinge]').forEach((b) => (b.onclick = () => {
  if (!lastDoor) return; lastDoor.swing = { hinge: b.dataset.hinge, side: lastDoor.swing ? lastDoor.swing.side : 1 }; buzz(); savePlan(); drawMap(); toast('Hinge side set');
}));
document.querySelectorAll('[data-swing]').forEach((b) => (b.onclick = () => {
  if (!lastDoor || !viewer) return;
  const me = toPlan(viewer.raw), a = lastDoor.a, bb = lastDoor.b;
  const cross = (bb[0] - a[0]) * (me[1] - a[1]) - (bb[1] - a[1]) * (me[0] - a[0]);
  const toward = Math.sign(cross) || 1;
  lastDoor.swing = { hinge: lastDoor.swing ? lastDoor.swing.hinge : 'a', side: b.dataset.swing === 'toward' ? toward : -toward };
  buzz(); savePlan(); drawMap(); toast('Swing side set');
}));

// ----- ceiling -----
const ceilRoomObj = () => plan.rooms[Number($('ceilRoom').value)] || null;
function ceilEstimate() {
  const now = performance.now();
  while (ceilSamples.length && now - ceilSamples[0].t > 1500) ceilSamples.shift();
  if (ceilSamples.length < 5) return null;
  const hs = ceilSamples.map((s) => s.h), m = G.median(hs);
  const spread = G.median(hs.map((h) => Math.abs(h - m)));
  const srcs = ceilSamples.map((s) => s.src);
  const src = ['depth', 'plane', 'hit'].sort((a, b) => srcs.filter((x) => x === b).length - srcs.filter((x) => x === a).length)[0];
  return { h: m, spread, src, n: hs.length };
}
function setCeiling(room, h, src) {
  room.ceiling_m = G.round3(h); room.ceiling_src = src; buzz(80);
  toast(`${room.name}: ceiling ${h.toFixed(2)} m (${src})`, 2500); savePlan(); refreshModeUI();
}
$('btnCeilUse').onclick = () => {
  const r = ceilRoomObj(); if (!r) { toast('Capture a room first'); return; }
  const e = ceilEstimate(); if (!e) { toast('No ceiling detected — point the phone up at the ceiling, or use the Pole'); return; }
  setCeiling(r, e.h, e.src);
};
$('btnCeilType').onclick = async () => {
  const r = ceilRoomObj(); if (!r) return;
  const n = await askNumber(`Ceiling height of ${r.name}`, r.ceiling_m);
  if (n) setCeiling(r, n, 'typed');
};
$('btnPole').onclick = () => {
  if (!ceilRoomObj()) { toast('Capture a room first'); return; }
  if (!guard()) return;
  if (!fp || !fp.ok) { toast('Aim at the floor where the pole should stand'); return; }
  const r = ceilRoomObj();
  pole = { pos: { ...fp.pos }, h: r.ceiling_m || 2.4 };
  $('poleRange').value = pole.h; updatePoleMesh(); refreshModeUI(); buzz();
};
function poleSet(h) { if (!pole) return; pole.h = Math.max(1.5, Math.min(5, G.round3(h))); $('poleRange').value = pole.h; updatePoleMesh(); }
$('poleRange').oninput = (e) => poleSet(Number(e.target.value));
document.querySelectorAll('#poleUI [data-d]').forEach((b) => {
  let t1, t2;
  const step = () => poleSet(pole.h + Number(b.dataset.d));
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); step(); t1 = setTimeout(() => (t2 = setInterval(step, 90)), 400); });
  const stop = () => { clearTimeout(t1); clearInterval(t2); };
  b.addEventListener('pointerup', stop); b.addEventListener('pointercancel', stop); b.addEventListener('pointerleave', stop);
});
$('btnPoleSave').onclick = () => { const r = ceilRoomObj(); if (r && pole) setCeiling(r, pole.h, 'pole'); pole = null; updatePoleMesh(); refreshModeUI(); };
$('btnPoleCancel').onclick = () => { pole = null; updatePoleMesh(); refreshModeUI(); };
$('ceilRoom').onchange = () => refreshModeUI();

// ----- align: after a restart the AR origin is new; tap corner A and B of an existing room to map back -----
function startAlign() {
  const rooms = plan.rooms.filter((r) => r.points.length >= 2);
  if (!rooms.length) { align = null; $('alignInfo').textContent = 'Nothing to align to yet.'; return; }
  const idx = Number($('alignRoom').value);
  const room = plan.rooms[idx] && plan.rooms[idx].points.length >= 2 ? plan.rooms[idx] : rooms[rooms.length - 1];
  align = { room, step: 0, n1: null };
  updateAlignText();
}
function updateAlignText() {
  if (!align) return;
  $('alignInfo').textContent = `Aim at corner ${align.step ? 'B' : 'A'} of ${align.room.name} (pink on the map).`;
  $('btnAlign').textContent = align.step ? 'Mark B' : 'Mark A';
}
$('alignRoom').onchange = () => startAlign();
$('btnAlign').onclick = () => {
  if (!align || !guard()) return;
  if (!fp || !fp.ok) { toast('Aim at the floor corner'); return; }
  const raw = fp.rawSession; // this session's own frame, before any transform
  if (align.step === 0) { align.n1 = raw; align.step = 1; buzz(); updateAlignText(); drawMap(); return; }
  const [o1, o2] = align.room.points;
  const t = G.rigidFrom2Points(align.n1, raw, o1, o2);
  if (Math.abs(t.lengthRatio - 1) > 0.15) { toast(`A–B distance differs by ${Math.round(Math.abs(t.lengthRatio - 1) * 100)}% — try again`, 3000); startAlign(); return; }
  transform = t; sessionInfo.transform = t; sessionInfo.aligned_to = align.room.name;
  buzz(80); toast('Aligned — check the outlines match the real walls', 3000);
  savePlan(); rebuildScene(); setMode('room');
};
$('btnAlignSkip').onclick = () => {
  if (!confirm('Skip aligning? New rooms will not line up with the ones already captured.')) return;
  sessionInfo.transform = null; sessionInfo.skipped_align = true; setMode('room'); rebuildScene();
};

$('btnExit').onclick = () => session && session.end();

// Taps on the camera view (not on the panels) also act as the main button of the current mode.
for (const el of document.querySelectorAll('#ar .ui, #modal')) el.addEventListener('beforexrselect', (e) => e.preventDefault());
function onSelect() {
  if (paused) return;
  const m = ui.mode;
  if (m === 'room') roomTapAction();
  else if (m === 'light') placeLightAction();
  else if (m === 'item') placeItemAction();
  else if (m === 'door') doorAction();
  else if (m === 'align') $('btnAlign').click();
}

// ---------- three.js scene ----------
let reticle, fpMarker, predMarker, poleMesh, planGroup;
function initThree() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.domElement.style.display = 'none';
  document.body.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
  reticle = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3fcf7f }));
  reticle.matrixAutoUpdate = false; reticle.visible = false; scene.add(reticle);
  fpMarker = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.075, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd84a }));
  fpMarker.visible = false; scene.add(fpMarker);
  predMarker = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.6, 8).translate(0, 0.3, 0), new THREE.MeshBasicMaterial({ color: 0xff5ad1 }));
  predMarker.visible = false; scene.add(predMarker);
  poleMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 12).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0xff7b3a }));
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.004, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
  tip.name = 'tip'; scene.add(tip); poleMesh.userData.tip = tip;
  poleMesh.visible = tip.visible = false; scene.add(poleMesh);
  planGroup = new THREE.Group(); scene.add(planGroup);
}
function updatePoleMesh() {
  if (!poleMesh) return;
  const tip = poleMesh.userData.tip;
  poleMesh.visible = tip.visible = !!pole;
  if (!pole) return;
  poleMesh.position.set(pole.pos.x, pole.pos.y, pole.pos.z); poleMesh.scale.set(1, pole.h, 1);
  tip.position.set(pole.pos.x, pole.pos.y + pole.h, pole.pos.z);
  $('poleH').textContent = `${pole.h.toFixed(2)} m`;
}

function rebuildScene() {
  if (!planGroup) return;
  for (const c of [...planGroup.children]) { planGroup.remove(c); c.geometry && c.geometry.dispose(); }
  if (frameUnknown()) return; // this session's frame is not yet tied to the plan: draw nothing
  const dot = (p, color, h = 0.01, r = 0.03) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.02, 12), new THREE.MeshBasicMaterial({ color })); m.position.copy(planToXR(p, h)); planGroup.add(m); };
  const line = (pts, color) => planGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color })));
  for (const r of plan.rooms) {
    if (r.points.length < 1) continue;
    const pts = r.points.map((p) => planToXR(p));
    if (r.closed) pts.push(pts[0]);
    line(pts, r === openRoom ? 0xffb020 : 0x4fa3ff);
    r.points.forEach((p) => dot(p, 0x4fa3ff));
    if (r.seq) for (const e of r.seq) if (e.w) line([planToXR(e.w[0], 0.02), planToXR(e.w[1], 0.02)], 0xffffff);
  }
  if (wallFirst) dot(wallFirst, 0xffb020, 0.01, 0.04);
  for (const l of plan.lights) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.25, 16), new THREE.MeshBasicMaterial({ color: 0xffd84a }));
    m.position.copy(planToXR([l.x, l.y], 0.125)); planGroup.add(m);
  }
  const icol = { outlet: 0x7fe0ff, switch: 0xc79bff, other: 0xb9c2cc };
  for (const it of plan.items) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), new THREE.MeshBasicMaterial({ color: icol[it.type] }));
    m.position.copy(planToXR([it.x, it.y], (it.height_m ?? 0) + 0.04)); planGroup.add(m);
  }
  for (const d of plan.doors) line([planToXR(d.a), planToXR(d.b)], d.kind === 'opening' ? 0x40c8b0 : 0xc98a4b);
  if (doorFirst) dot(doorFirst, 0xc98a4b, 0.01, 0.04);
}

// ---------- WebXR session ----------
async function checkSupport() {
  if (!window.isSecureContext) { $('support').textContent = 'This page must be opened over https.'; return; }
  if (!navigator.xr) { $('support').textContent = 'WebXR is not available here (fine for editing). For capture use Chrome on Android with Google Play Services for AR.'; return; }
  try {
    const ok = await navigator.xr.isSessionSupported('immersive-ar');
    if (ok) { $('btnStart').disabled = false; $('support').textContent = hasEarlierData() ? 'Ready. You will align with an existing room first.' : 'Ready.'; }
    else $('support').textContent = 'immersive-ar is not supported here (install/update "Google Play Services for AR"). Editing still works.';
  } catch (e) { $('support').textContent = 'AR check failed: ' + e.message; }
}

async function requestAR() {
  const base = { requiredFeatures: ['hit-test', 'dom-overlay'], optionalFeatures: ['plane-detection'], domOverlay: { root: $('app') } };
  if (!noDepthNextTime) {
    try {
      return await navigator.xr.requestSession('immersive-ar', { ...base, optionalFeatures: [...base.optionalFeatures, 'depth-sensing'],
        depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] } });
    } catch (e) { noDepthNextTime = true; console.warn('AR with depth failed, retrying without', e); }
  }
  return navigator.xr.requestSession('immersive-ar', base);
}

$('btnStart').onclick = async () => {
  try {
    if (!renderer) initThree();
    session = await requestAR();
  } catch (e) { alert('Could not start AR: ' + e.message + (noDepthNextTime ? '\nPress Start AR again (depth sensing is switched off now).' : '')); session = null; return; }
  depthOK = !!(session.enabledFeatures && session.enabledFeatures.includes('depth-sensing') && session.depthUsage === 'cpu-optimized');
  document.documentElement.classList.add('in-ar');
  $('app').classList.add('in-ar');
  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(session);
  refSpace = renderer.xr.getReferenceSpace();
  const viewerSpace = await session.requestReferenceSpace('viewer');
  hitSource = await session.requestHitTestSource({ space: viewerSpace });
  const align0 = hasEarlierData();
  transform = null;
  openRoom = plan.rooms.find((r) => !r.closed) || null;
  sessionInfo = { started: new Date().toISOString(), need_align: align0, transform: null, depth: depthOK };
  plan.capture.sessions.push(sessionInfo);
  floorSamples.length = 0; floorY = null; ceilPlaneY = null;
  refSpace.addEventListener('reset', () => {
    sessionInfo.reset = true; transform = null;
    toast('AR tracking restarted — align again with two known corners', 4000);
    sessionInfo.ended = new Date().toISOString();
    sessionInfo = { started: new Date().toISOString(), need_align: hasEarlierData(), transform: null, after_reset: true, depth: depthOK };
    plan.capture.sessions.push(sessionInfo);
    savePlan(); setMode('align'); rebuildScene();
  });
  session.addEventListener('select', onSelect);
  session.addEventListener('end', onEnd);
  try { await navigator.wakeLock?.request('screen'); } catch {}
  if (align0) setMode('align'); else setMode(ui.mode === 'align' ? 'room' : ui.mode);
  rebuildScene();
  renderer.setAnimationLoop(onFrame);
};

function onEnd() {
  renderer.setAnimationLoop(null);
  if (sessionInfo) sessionInfo.ended = new Date().toISOString();
  wallFirst = null; doorFirst = null; lastDoor = null; align = null; hitSource = null; session = null; viewer = null; reticleHit = null; fp = null; pole = null;
  openRoom = plan.rooms.find((r) => !r.closed) || null;
  savePlan();
  document.documentElement.classList.remove('in-ar');
  $('app').classList.remove('in-ar');
  edView = null; refreshLanding(); checkSupport();
}

let lastMapDraw = 0, lastStatus = '', frameNo = 0;
function onFrame(time, frame) {
  if (!frame) return;
  frameNo++;
  const pose = frame.getViewerPose(refSpace);
  const prevTracking = tracking;
  tracking = pose && !pose.emulatedPosition ? 'ok' : 'lost';
  if (pose) {
    const p = pose.transform.position, q = pose.transform.orientation;
    const fx = -2 * (q.x * q.z + q.w * q.y), fy = -2 * (q.y * q.z - q.w * q.x), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const hl = Math.hypot(fx, fz) || 1;
    viewer = { raw: G.xrToPlan(p), heading: [fx / hl, -fz / hl], y: p.y, pos: { x: p.x, y: p.y, z: p.z }, fwd: { x: fx, y: fy, z: fz } };
  }
  reticleHit = null; reticle.visible = false;
  if (hitSource && tracking === 'ok') {
    const hits = frame.getHitTestResults(hitSource);
    if (hits.length) {
      const hp = hits[0].getPose(refSpace);
      if (hp) {
        const q = hp.transform.orientation, pos = hp.transform.position;
        const upY = 1 - 2 * (q.x * q.x + q.z * q.z); // y component of the surface normal
        const horizontal = upY > 0.9, vertical = Math.abs(upY) < 0.35;
        if (horizontal && viewer && pos.y < viewer.y - 0.5) addFloorSample(pos.y);
        reticleHit = { pos: { x: pos.x, y: pos.y, z: pos.z }, raw: toPlan(G.xrToPlan(pos)), horizontal, vertical, upY,
          ceiling: viewer && pos.y > viewer.y + 0.2 && (upY < -0.9 || horizontal) };
        reticle.visible = true;
        reticle.matrix.fromArray(hp.transform.matrix);
        const floor = horizontal && floorY !== null && Math.abs(pos.y - floorY) <= G.FLOOR_TOL_M;
        reticle.material.color.set(floor ? 0x3fcf7f : horizontal ? 0xffb020 : 0xff5a5a);
      }
    }
  }
  // plane detection: extra floor samples and a ceiling candidate
  if (frame.detectedPlanes && viewer && frameNo % 15 === 0) {
    let ceil = null;
    for (const pl of frame.detectedPlanes) {
      if (pl.orientation !== 'horizontal' && pl.orientation !== 'Horizontal') continue;
      const pp = frame.getPose(pl.planeSpace, refSpace); if (!pp) continue;
      const y = pp.transform.position.y;
      if (y < viewer.y - 0.5) addFloorSample(y);
      else if (y > viewer.y + 0.2) ceil = ceil === null ? y : Math.min(ceil, y);
    }
    ceilPlaneY = ceil;
  }
  // floor-constrained point
  fp = null;
  if (viewer && tracking === 'ok') {
    const r = G.floorPoint(reticleHit, { origin: viewer.pos, dir: viewer.fwd }, floorY);
    if (r.ok) { const rawS = G.xrToPlan(r.pos); fp = { ...r, rawSession: rawS, raw: toPlan(rawS) }; } else fp = r;
  }
  fpMarker.visible = !!(fp && fp.ok && fp.how === 'projected');
  if (fpMarker.visible) fpMarker.position.set(fp.pos.x, fp.pos.y + 0.005, fp.pos.z);
  // ceiling samples (only in the Ceiling tab)
  if (ui.mode === 'ceiling' && viewer && floorY !== null && tracking === 'ok') {
    const t = performance.now();
    if (depthOK && viewer.fwd.y > 0.5 && pose) {
      try {
        const di = frame.getDepthInformation(pose.views[0]);
        const d = di && di.getDepthInMeters(0.5, 0.5);
        if (d > 0.2 && d < 6) ceilSamples.push({ h: viewer.pos.y + viewer.fwd.y * d - floorY, src: 'depth', t });
      } catch {}
    }
    if (reticleHit && reticleHit.ceiling) ceilSamples.push({ h: reticleHit.pos.y - floorY, src: 'hit', t });
    if (ceilPlaneY !== null && viewer.fwd.y > 0.3) ceilSamples.push({ h: ceilPlaneY - floorY, src: 'plane', t });
    while (ceilSamples.length > 60) ceilSamples.shift();
  }
  // live marker / predicted corner
  liveMarker = null; livePredicted = null; predMarker.visible = false;
  const cur = fp && fp.ok ? fp.raw : null;
  if (cur && !frameUnknown()) {
    if (ui.mode === 'light' || ui.mode === 'item') {
      const p = ui.mode === 'item' && reticleHit && reticleHit.vertical ? reticleHit.raw : cur;
      liveMarker = { p, bad: G.outsideAllRooms(plan, p, ui.mode === 'item' ? 0.3 : 0.15), color: ui.mode === 'light' ? COL.light : COL[ui.itemType] };
    } else if (ui.mode === 'room' && openRoom) {
      liveMarker = { p: cur };
      if (ui.roomTool === 'wall' && wallFirst) {
        livePredicted = G.predictCorner(openRoom.seq || [], wallFirst, cur);
        if (livePredicted) { predMarker.visible = true; predMarker.position.copy(planToXR(livePredicted, 0)); }
      }
    } else if (ui.mode !== 'ceiling') liveMarker = { p: cur };
  }
  // status line
  let msg, cls = '';
  if (paused) msg = 'Paused';
  else if (tracking !== 'ok') { msg = 'Tracking lost — stop, point at a well-lit textured area, move slowly back to where you were.'; cls = 'bad'; }
  else if (ui.mode === 'align' && align) msg = 'Align: ' + (align.step ? 'mark corner B' : 'mark corner A') + ' of ' + align.room.name;
  else if (floorY === null) { msg = 'Sweep the phone slowly over the floor to find it.'; cls = 'warn'; }
  else if (ui.mode === 'ceiling') {
    const e = ceilEstimate();
    msg = pole ? `Pole ${pole.h.toFixed(2)} m — raise it to the ceiling` : e ? `Ceiling ≈ ${e.h.toFixed(2)} m (${e.src}${e.spread > 0.05 ? ', unsteady' : ''})` : 'Point the phone at the ceiling, or use the Pole';
    $('ceilInfo').textContent = e ? `Detected: ${e.h.toFixed(2)} m ±${Math.max(0.01, e.spread).toFixed(2)} via ${e.src}. ${depthOK ? '' : '(no depth sensing on this session)'}` : depthOK ? 'Point the phone straight up at the ceiling (depth sensing is on).' : 'Point at the ceiling; if nothing is detected (plain ceilings often are not), use the Pole.';
  } else if (!fp || !fp.ok) { msg = 'Aim at the floor.'; cls = 'warn'; }
  else {
    const proj = fp.how === 'projected' ? ` · projected to floor${fp.rejected != null ? ` (surface ${fp.rejected > 0 ? '+' : ''}${fp.rejected.toFixed(2)} m ignored)` : ''}` : '';
    const out = liveMarker && liveMarker.bad ? ' · ⚠ outside every room' : '';
    if (ui.mode === 'room') msg = openRoom ? (ui.roomTool === 'wall' ? `${openRoom.name}: wall point ${wallFirst ? 2 : 1}` : `Corner ${openRoom.points.length + 1} of ${openRoom.name}`) + proj : 'Room mode — New room…';
    else if (ui.mode === 'light') msg = 'Aim at the floor under the light' + proj + out;
    else if (ui.mode === 'item') msg = (reticleHit && reticleHit.vertical ? `On the wall, ${(reticleHit.pos.y - floorY).toFixed(2)} m up` : 'On the floor' + proj) + out;
    else if (ui.mode === 'door') msg = (ui.doorKind === 'opening' ? 'Opening' : 'Door') + proj;
    else msg = 'Ready';
    if (out) cls = 'warn';
  }
  if (prevTracking === 'lost' && tracking === 'ok') toast('Tracking back — check the outlines still match the walls before continuing', 3500);
  if (msg !== lastStatus) { $('status').textContent = msg; $('status').className = 'ui ' + cls; lastStatus = msg; }
  // live measurement
  const meas = $('measure');
  if (openRoom && cur && ui.mode === 'room') {
    const last = wallFirst || openRoom.points[openRoom.points.length - 1];
    const firstC = openRoom.seq && openRoom.seq[0] && openRoom.seq[0].c;
    const extra = livePredicted ? ' · corner ✕' : ui.roomTool === 'corner' && firstC && openRoom.points.length >= 3 && G.dist(firstC, cur) <= G.CLOSE_TOLERANCE_M ? ' · will close' : '';
    if (last) { meas.style.display = 'block'; meas.textContent = `${G.dist(last, cur).toFixed(2)} m${extra}`; } else meas.style.display = 'none';
  } else if (doorFirst && cur && ui.mode === 'door') {
    meas.style.display = 'block'; meas.textContent = `${G.dist(doorFirst, cur).toFixed(2)} m`;
  } else meas.style.display = 'none';
  if (time - lastMapDraw > 150) { lastMapDraw = time; drawMap(); }
  renderer.render(scene, camera);
}

function addFloorSample(y) {
  floorSamples.push(y); if (floorSamples.length > 300) floorSamples.shift();
  const sorted = [...floorSamples].sort((a, b) => a - b);
  floorY = sorted[Math.floor(sorted.length * 0.1)];
}

// ---------- boot ----------
document.addEventListener('visibilitychange', () => { if (document.hidden) savePlan(); });
window.addEventListener('resize', () => { drawMap(); drawEditor(); });
async function readFragment() {
  if (!location.hash || !/lightsz?=/.test(location.hash)) return;
  try {
    const list = await G.decodeFragment(location.hash);
    if (list) setLightList(list, `Loaded ${list.lights.length} light(s), ${list.switches.length} switch/plug(s) and ${list.areas.length} area(s) from the link.`);
  } catch (e) { $('linkNote').textContent = 'The link’s light list could not be read: ' + e.message; }
  // drop the list from the address bar / history (it never left the phone)
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
}
// Read-only handle for headless tests and console debugging (no data leaves the page).
window.__fp = { get plan() { return plan; }, get edView() { return edView; }, get floorY() { return floorY; }, toScr, readFragment };
openRoom = plan.rooms.find((r) => !r.closed) || null;
if (!plan.rooms.length) $('helpDetails').open = true;
refreshLanding(); checkSupport(); readFragment();
