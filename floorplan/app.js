// AR floor-plan capture (WebXR immersive-ar + hit-test + dom-overlay). Pure geometry lives in geometry.js.
import * as THREE from 'three';
import * as G from './geometry.js';

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
let lightList = load(KEY_LIGHTS, { lights: [], areas: [] });
const ui = load(KEY_UI, { mode: 'room' });
let openRoom = null;            // room object being captured (also in plan.rooms)
let doorFirst = null;           // first door point while placing a door
let align = null;               // {room, step:0|1, n1}
let session = null, renderer, scene, camera, hitSource = null, refSpace = null;
let sessionInfo = null;         // entry in plan.capture.sessions for this AR session
let transform = null;           // maps this session's raw plan coords into the plan frame
let reticleHit = null;          // {raw:[x,y], y, horizontal, floor}
let viewer = null;              // {raw:[x,y], heading:[dx,dy], y}
let tracking = 'none';          // 'ok' | 'lost' | 'none'
const floorSamples = [];
let floorY = null;

function savePlan() {
  plan.updated = new Date().toISOString();
  plan.capture.floor_y = floorY;
  store(KEY_PLAN, plan);
  refreshLanding();
}

// ---------- coordinate helpers ----------
const toPlan = (raw) => (transform ? G.applyTransform(raw, transform) : raw);
function planToXR(p) { // inverse of toPlan + xrToPlan, at floor height
  let q = p;
  if (transform) { q = [p[0] - transform.tx, p[1] - transform.ty]; q = G.rotate(q, -transform.ang); }
  return new THREE.Vector3(q[0], (floorY ?? -1.4) + 0.01, -q[1]);
}
// Points captured in an earlier AR session use that session's origin, so a new session must be aligned first.
function hasEarlierData() { return plan.rooms.some((r) => r.points.length >= 2); }
function frameUnknown() { return !!(sessionInfo && sessionInfo.need_align && !transform && !sessionInfo.skipped_align); }

// ---------- mini map ----------
const mapCanvas = document.createElement('canvas');
function placeMap() { (session ? $('mapWrapAR') : $('mapWrapLanding')).appendChild(mapCanvas); drawMap(); }

function drawMap() {
  const c = mapCanvas, dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 300, h = c.clientHeight || 300;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pts = [];
  plan.rooms.forEach((r) => pts.push(...r.points));
  plan.lights.forEach((l) => pts.push([l.x, l.y]));
  plan.doors.forEach((d) => pts.push(d.a, d.b));
  const me = viewer ? toPlan(viewer.raw) : null;
  const cur = reticleHit ? toPlan(reticleHit.raw) : null;
  if (me) pts.push(me);
  if (cur) pts.push(cur);
  let b = G.bounds(pts);
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 4);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const s = (Math.min(w, h) - 24) / span;
  const X = (p) => w / 2 + (p[0] - cx) * s, Y = (p) => h / 2 - (p[1] - cy) * s;
  // 1 m grid
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
  for (let gx = Math.floor(cx - span); gx <= cx + span; gx++) { ctx.beginPath(); ctx.moveTo(X([gx, 0]), 0); ctx.lineTo(X([gx, 0]), h); ctx.stroke(); }
  for (let gy = Math.floor(cy - span); gy <= cy + span; gy++) { ctx.beginPath(); ctx.moveTo(0, Y([0, gy])); ctx.lineTo(w, Y([0, gy])); ctx.stroke(); }
  // rooms
  ctx.font = '12px system-ui'; ctx.textAlign = 'center';
  for (const r of plan.rooms) {
    if (!r.points.length) continue;
    ctx.beginPath();
    r.points.forEach((p, i) => (i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p))));
    if (r.closed) { ctx.closePath(); ctx.fillStyle = 'rgba(79,163,255,.15)'; ctx.fill(); }
    ctx.strokeStyle = r === openRoom ? '#ffb020' : '#4fa3ff'; ctx.lineWidth = 2; ctx.stroke();
    if (r === openRoom && cur) {
      const last = r.points[r.points.length - 1];
      ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(X(last), Y(last)); ctx.lineTo(X(cur), Y(cur)); ctx.stroke(); ctx.setLineDash([]);
    }
    r.points.forEach((p) => { ctx.fillStyle = ctx.strokeStyle; ctx.fillRect(X(p) - 2, Y(p) - 2, 4, 4); });
    if (r.closed && r.points.length >= 3) {
      const cc = G.centroid(r.points); ctx.fillStyle = '#cfe3ff'; ctx.fillText(r.name, X(cc), Y(cc) + 4);
    }
  }
  // align references
  if (align && align.room) {
    const [A, B] = align.room.points;
    for (const [p, t] of [[A, 'A'], [B, 'B']]) {
      ctx.fillStyle = '#ff5ad1'; ctx.beginPath(); ctx.arc(X(p), Y(p), 7, 0, 7); ctx.fill();
      ctx.fillStyle = '#000'; ctx.fillText(t, X(p), Y(p) + 4);
    }
  }
  // doors
  ctx.strokeStyle = '#c98a4b'; ctx.lineWidth = 4;
  for (const d of plan.doors) { ctx.beginPath(); ctx.moveTo(X(d.a), Y(d.a)); ctx.lineTo(X(d.b), Y(d.b)); ctx.stroke(); }
  if (doorFirst) { ctx.fillStyle = '#c98a4b'; ctx.beginPath(); ctx.arc(X(doorFirst), Y(doorFirst), 4, 0, 7); ctx.fill(); }
  // lights
  for (const l of plan.lights) { ctx.fillStyle = '#ffd84a'; ctx.beginPath(); ctx.arc(X([l.x, l.y]), Y([l.x, l.y]), 4, 0, 7); ctx.fill(); }
  // reticle + me
  if (cur && !align) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(cur), Y(cur), 5, 0, 7); ctx.stroke(); }
  if (me && viewer) {
    const hd = transform ? G.rotate(viewer.heading, transform.ang) : viewer.heading;
    ctx.fillStyle = tracking === 'ok' ? '#3fcf7f' : '#ff5a5a';
    ctx.beginPath(); ctx.arc(X(me), Y(me), 5, 0, 7); ctx.fill();
    ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(X(me), Y(me));
    ctx.lineTo(X([me[0] + hd[0] * 0.8, me[1] + hd[1] * 0.8]), Y([me[0] + hd[0] * 0.8, me[1] + hd[1] * 0.8])); ctx.stroke();
  }
  // scale bar (1 m)
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(8, h - 8); ctx.lineTo(8 + s, h - 8); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText('1 m', 10, h - 12);
}

// ---------- landing page ----------
function refreshLanding() {
  const closed = plan.rooms.filter((r) => r.closed).length;
  $('planSummary').textContent = `${plan.rooms.length} room(s) (${closed} closed), ${plan.lights.length} light(s), ${plan.doors.length} door(s)` +
    (plan.rooms.length ? ' — ' + plan.rooms.map((r) => r.name).join(', ') : '');
  const placed = new Set(plan.lights.map((l) => l.entity_id || l.name));
  $('lightsSummary').textContent = lightList.lights.length
    ? `${lightList.lights.length} light(s) in list, ${lightList.lights.filter((l) => placed.has(l.entity_id || l.name)).length} placed.`
    : 'No list loaded — you can still type a name for each light in AR.';
  $('areaList').innerHTML = '';
  for (const a of lightList.areas) { const o = document.createElement('option'); o.value = a; $('areaList').appendChild(o); }
  drawMap();
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
  plan = G.normalisePlan(JSON.parse(t)); openRoom = null; savePlan();
  alert('Plan loaded. When you start AR you will be asked to align with two corners of a room.');
});
$('btnClear').onclick = () => {
  if (!confirm('Delete the captured plan on this phone? (Save the file first if you need it.)')) return;
  plan = G.newPlan(); openRoom = null; savePlan();
};
$('btnLoadLightsProxy').onclick = () => readFile($('fileLights'), (t) => { lightList = G.parseLightList(t); store(KEY_LIGHTS, lightList); refreshLanding(); });
$('btnAddTyped').onclick = () => {
  const names = $('typedLights').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const extra = G.parseLightList(JSON.stringify(names)).lights;
  lightList.lights.push(...extra); store(KEY_LIGHTS, lightList); $('typedLights').value = ''; refreshLanding();
};
$('btnClearLights').onclick = () => { lightList = { lights: [], areas: [] }; store(KEY_LIGHTS, lightList); refreshLanding(); };

// ---------- AR overlay UI ----------
function toast(msg, ms = 1800) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), ms);
}
function buzz(ms = 30) { try { navigator.vibrate && navigator.vibrate(ms); } catch {} }

function setMode(m) {
  ui.mode = m; store(KEY_UI, ui);
  document.querySelectorAll('#tabs button[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  document.querySelectorAll('.modepanel').forEach((p) => p.classList.toggle('on', p.dataset.panel === m));
  if (m === 'align') startAlign(); else align = null;
  refreshModeUI();
}
document.querySelectorAll('#tabs button[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

function refreshModeUI() {
  $('roomIdle').style.display = openRoom ? 'none' : '';
  $('roomActive').style.display = openRoom ? '' : 'none';
  if (openRoom) {
    const n = openRoom.points.length;
    $('roomInfo').textContent = `${openRoom.name}: ${n} corner(s). Go round the room in order; aim at the first corner again (or press Close) to finish.`;
    $('btnClose').disabled = n < 3;
  }
  // light select: unplaced first, then placed (re-placing moves it)
  const placed = new Set(plan.lights.map((l) => l.entity_id || l.name));
  const sel = $('lightSelect'), prev = sel.value;
  sel.innerHTML = '';
  const here = reticleHit ? G.roomAt(plan, toPlan(reticleHit.raw)) : null;
  const sorted = [...lightList.lights].sort((a, b) =>
    (placed.has(a.entity_id || a.name) - placed.has(b.entity_id || b.name)) ||
    ((b.area === here) - (a.area === here)) || String(a.area).localeCompare(String(b.area)) || a.name.localeCompare(b.name));
  for (const l of sorted) {
    const o = document.createElement('option');
    o.value = l.entity_id || l.name;
    o.textContent = `${placed.has(o.value) ? '✓ ' : ''}${l.name}${l.area ? ' · ' + l.area : ''}`;
    sel.appendChild(o);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  $('btnDoor').textContent = doorFirst ? 'Door side 2' : 'Door side 1';
  $('doorInfo').textContent = doorFirst ? 'Now aim at the other side of the doorway.' : 'Aim at one side of the doorway on the floor.';
  const rs = $('alignRoom'); const rprev = rs.value; rs.innerHTML = '';
  plan.rooms.forEach((r, i) => { if (r.points.length >= 2) { const o = document.createElement('option'); o.value = i; o.textContent = r.name; rs.appendChild(o); } });
  if (align) rs.value = String(plan.rooms.indexOf(align.room)); else if (rprev) rs.value = rprev;
  drawMap();
}

function currentPoint() {
  if (frameUnknown() && ui.mode !== 'align') { toast('Align first (Align tab), or press Skip there'); return null; }
  if (tracking !== 'ok') { toast('Tracking lost — hold still and point at a textured area'); return null; }
  if (!reticleHit) { toast('No surface under the crosshair yet — move the phone slowly'); return null; }
  return reticleHit.raw;
}

function addCornerAction() {
  const raw = currentPoint(); if (!raw || !openRoom) return;
  if (!reticleHit.floor) toast('Not on the floor — that is OK, only the position counts');
  const res = G.addCorner(openRoom, toPlan(raw));
  buzz();
  if (res === 'closed') finishRoom(); else { savePlan(); refreshModeUI(); rebuildScene(); }
}
function finishRoom() {
  toast(`${openRoom.name} closed: ${G.area(openRoom.points).toFixed(1)} m²`, 2500);
  openRoom = null; savePlan(); refreshModeUI(); rebuildScene();
}
$('btnRoomStart').onclick = () => {
  const name = $('roomName').value.trim() || `Room ${plan.rooms.length + 1}`;
  openRoom = { name, points: [], closed: false }; plan.rooms.push(openRoom);
  $('roomName').value = ''; savePlan(); refreshModeUI();
};
$('btnCorner').onclick = addCornerAction;
$('btnUndo').onclick = () => { if (openRoom) { G.undoCorner(openRoom); savePlan(); refreshModeUI(); rebuildScene(); } };
$('btnClose').onclick = () => { if (openRoom && openRoom.points.length >= 3) { G.closeRoom(openRoom); finishRoom(); } };
$('btnCancelRoom').onclick = () => {
  if (!openRoom || (openRoom.points.length > 1 && !confirm(`Discard ${openRoom.name}?`))) return;
  plan.rooms = plan.rooms.filter((r) => r !== openRoom); openRoom = null; savePlan(); refreshModeUI(); rebuildScene();
};

function placeLightAction() {
  const raw = currentPoint(); if (!raw) return;
  const typed = $('lightCustom').value.trim();
  let light;
  if (typed) light = { entity_id: typed.startsWith('light.') ? typed : '', name: typed };
  else {
    const v = $('lightSelect').value;
    light = lightList.lights.find((l) => (l.entity_id || l.name) === v);
    if (!light) { toast('Pick a light from the list or type a name'); return; }
  }
  const e = G.placeLight(plan, light, toPlan(raw));
  $('lightCustom').value = ''; buzz(); toast(`${e.name} placed${e.room ? ' in ' + e.room : ''}`);
  // advance to the next unplaced light
  savePlan(); $('lightSelect').value = ''; refreshModeUI(); rebuildScene();
}
$('btnLight').onclick = placeLightAction;
$('btnLightUndo').onclick = () => { plan.lights.pop(); savePlan(); refreshModeUI(); rebuildScene(); };

function doorAction() {
  const raw = currentPoint(); if (!raw) return;
  const p = toPlan(raw);
  if (!doorFirst) { doorFirst = p; buzz(); }
  else {
    const mid = [(doorFirst[0] + p[0]) / 2, (doorFirst[1] + p[1]) / 2];
    plan.doors.push({ a: doorFirst, b: p, room: G.roomAt(plan, mid) });
    toast(`Door ${G.dist(doorFirst, p).toFixed(2)} m`); doorFirst = null; buzz(); savePlan(); rebuildScene();
  }
  refreshModeUI();
}
$('btnDoor').onclick = doorAction;
$('btnDoorUndo').onclick = () => { if (doorFirst) doorFirst = null; else plan.doors.pop(); savePlan(); refreshModeUI(); rebuildScene(); };

// Align: after a restart the AR origin is new; tap corner A and B of an existing room to map back.
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
  $('alignInfo').textContent = `Aim at corner ${align.step ? 'B' : 'A'} of ${align.room.name} (pink on the map: A is the first corner you tapped there, B the second).`;
  $('btnAlign').textContent = align.step ? 'Mark B' : 'Mark A';
}
$('alignRoom').onchange = () => startAlign();
$('btnAlign').onclick = () => {
  if (!align) return;
  const raw = currentPoint(); if (!raw) return;
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
  sessionInfo.transform = null; sessionInfo.skipped_align = true; setMode('room');
};

$('btnExit').onclick = () => session && session.end();

// Taps on the camera view (not on the panels) also act as the main button of the current mode.
for (const el of document.querySelectorAll('#ar .ui')) el.addEventListener('beforexrselect', (e) => e.preventDefault());
function onSelect() {
  const m = ui.mode;
  if (m === 'room') { if (openRoom) addCornerAction(); else toast('Name the room and press Start room first'); }
  else if (m === 'light') placeLightAction();
  else if (m === 'door') doorAction();
  else if (m === 'align') $('btnAlign').click();
}

// ---------- three.js scene ----------
let reticle, planGroup;
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
  planGroup = new THREE.Group(); scene.add(planGroup);
}

function rebuildScene() {
  if (!planGroup) return;
  for (const c of [...planGroup.children]) { planGroup.remove(c); c.geometry && c.geometry.dispose(); }
  if (frameUnknown()) return; // this session's frame is not yet tied to the plan: draw nothing
  for (const r of plan.rooms) {
    if (r.points.length < 1) continue;
    const pts = r.points.map(planToXR);
    if (r.closed) pts.push(pts[0]);
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    planGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: r === openRoom ? 0xffb020 : 0x4fa3ff })));
    for (const p of pts) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 12), new THREE.MeshBasicMaterial({ color: 0x4fa3ff }));
      m.position.copy(p); planGroup.add(m);
    }
  }
  for (const l of plan.lights) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.25, 16), new THREE.MeshBasicMaterial({ color: 0xffd84a }));
    m.position.copy(planToXR([l.x, l.y])); m.position.y += 0.125; planGroup.add(m);
  }
  for (const d of plan.doors) {
    const g = new THREE.BufferGeometry().setFromPoints([planToXR(d.a), planToXR(d.b)]);
    planGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xc98a4b })));
  }
}

// ---------- WebXR session ----------
async function checkSupport() {
  if (!window.isSecureContext) { $('support').textContent = 'This page must be opened over https.'; return; }
  if (!navigator.xr) { $('support').textContent = 'WebXR is not available in this browser. Use Chrome on Android with Google Play Services for AR installed.'; return; }
  try {
    const ok = await navigator.xr.isSessionSupported('immersive-ar');
    if (ok) { $('btnStart').disabled = false; $('support').textContent = hasEarlierData() ? 'Ready. You will align with an existing room first.' : 'Ready.'; }
    else $('support').textContent = 'immersive-ar is not supported here (install/update "Google Play Services for AR").';
  } catch (e) { $('support').textContent = 'AR check failed: ' + e.message; }
}

$('btnStart').onclick = async () => {
  try {
    if (!renderer) initThree();
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'dom-overlay'],
      optionalFeatures: ['plane-detection'],
      domOverlay: { root: $('app') },
    });
  } catch (e) { alert('Could not start AR: ' + e.message); session = null; return; }
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
  sessionInfo = { started: new Date().toISOString(), need_align: align0, transform: null };
  plan.capture.sessions.push(sessionInfo);
  floorSamples.length = 0; floorY = null;
  refSpace.addEventListener('reset', () => {
    sessionInfo.reset = true; transform = null;
    toast('AR tracking restarted — align again with two known corners', 4000);
    // continue in a fresh logical session so earlier points keep their transform
    sessionInfo.ended = new Date().toISOString();
    sessionInfo = { started: new Date().toISOString(), need_align: hasEarlierData(), transform: null, after_reset: true };
    plan.capture.sessions.push(sessionInfo);
    savePlan(); setMode('align'); rebuildScene();
  });
  session.addEventListener('select', onSelect);
  session.addEventListener('end', onEnd);
  try { await navigator.wakeLock?.request('screen'); } catch {}
  placeMap();
  if (align0) setMode('align'); else setMode(ui.mode === 'align' ? 'room' : ui.mode);
  rebuildScene();
  renderer.setAnimationLoop(onFrame);
};

function onEnd() {
  renderer.setAnimationLoop(null);
  if (sessionInfo) sessionInfo.ended = new Date().toISOString();
  openRoom = null; doorFirst = null; align = null; hitSource = null; session = null; viewer = null; reticleHit = null;
  savePlan();
  document.documentElement.classList.remove('in-ar');
  $('app').classList.remove('in-ar');
  placeMap(); refreshLanding(); checkSupport();
}

let lastMapDraw = 0, lastStatus = '';
function onFrame(time, frame) {
  if (!frame) return;
  const pose = frame.getViewerPose(refSpace);
  const prevTracking = tracking;
  tracking = pose && !pose.emulatedPosition ? 'ok' : 'lost';
  if (pose) {
    const p = pose.transform.position, q = pose.transform.orientation;
    const fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const hl = Math.hypot(fx, fz) || 1;
    viewer = { raw: G.xrToPlan(p), heading: [fx / hl, -fz / hl], y: p.y };
  }
  reticleHit = null; reticle.visible = false;
  if (hitSource && tracking === 'ok') {
    const hits = frame.getHitTestResults(hitSource);
    if (hits.length) {
      const hp = hits[0].getPose(refSpace);
      if (hp) {
        const q = hp.transform.orientation, pos = hp.transform.position;
        const upY = 1 - 2 * (q.x * q.x + q.z * q.z); // y component of the surface normal
        const horizontal = upY > 0.9;
        if (horizontal && viewer && pos.y < viewer.y - 0.5) {
          floorSamples.push(pos.y); if (floorSamples.length > 300) floorSamples.shift();
          const sorted = [...floorSamples].sort((a, b) => a - b);
          floorY = sorted[Math.floor(sorted.length * 0.1)];
        }
        const floor = horizontal && floorY !== null && Math.abs(pos.y - floorY) < 0.12;
        reticleHit = { raw: G.xrToPlan(pos), y: pos.y, horizontal, floor };
        reticle.visible = true;
        reticle.matrix.fromArray(hp.transform.matrix);
        reticle.material.color.set(floor ? 0x3fcf7f : horizontal ? 0xffb020 : 0xff5a5a);
      }
    }
  }
  // status line
  let msg, cls = '';
  if (tracking !== 'ok') { msg = 'Tracking lost — stop, point at a well-lit textured area, move slowly back to where you were.'; cls = 'bad'; }
  else if (ui.mode === 'align' && align) msg = 'Align: ' + (align.step ? 'mark corner B' : 'mark corner A') + ' of ' + align.room.name;
  else if (!reticleHit) { msg = 'Sweep the phone slowly over the floor to find it.'; cls = 'warn'; }
  else if (!reticleHit.floor) msg = reticleHit.horizontal ? 'Surface above the floor (amber).' : 'Wall/vertical surface (red) — aim lower.';
  else msg = { room: openRoom ? `Corner ${openRoom.points.length + 1} of ${openRoom.name}` : 'Room mode', light: 'Aim at the floor under the light', door: 'Door mode' }[ui.mode] || 'Ready';
  if (prevTracking === 'lost' && tracking === 'ok') toast('Tracking back — check the outlines still match the walls before continuing', 3500);
  if (msg !== lastStatus) { $('status').textContent = msg; $('status').className = 'ui ' + cls; lastStatus = msg; }
  // live edge length while drawing a room
  const meas = $('measure');
  if (openRoom && openRoom.points.length && reticleHit && ui.mode === 'room') {
    const d = G.dist(openRoom.points[openRoom.points.length - 1], toPlan(reticleHit.raw));
    meas.style.display = 'block'; meas.textContent = `${d.toFixed(2)} m` + (G.shouldClose(openRoom.points, toPlan(reticleHit.raw)) ? ' · will close' : '');
  } else if (doorFirst && reticleHit && ui.mode === 'door') {
    meas.style.display = 'block'; meas.textContent = `${G.dist(doorFirst, toPlan(reticleHit.raw)).toFixed(2)} m`;
  } else meas.style.display = 'none';
  if (time - lastMapDraw > 150) { lastMapDraw = time; drawMap(); }
  renderer.render(scene, camera);
}

// ---------- boot ----------
document.addEventListener('visibilitychange', () => { if (document.hidden) savePlan(); });
window.addEventListener('resize', drawMap);
openRoom = plan.rooms.find((r) => !r.closed) || null;
placeMap(); refreshLanding(); checkSupport();
