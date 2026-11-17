import * as THREE from 'three';
import './style.css';
import { R, CITIES, LANDMARKS, buildLand, surfDist, dirTo, moveOnSphere, tangentize, offsetPoint } from './geo.js';
import { createGlobe, MAX_HOLES } from './globe.js';
import { World } from './objects.js';
import { Hole, makeBots, safeSpawn, thinkBot, steer, START_A, GAIN, EAT_RATIO, HOLE_RATIO, MAX_BOMBS, titleOf, titleIndex, TITLES } from './holes.js';
import { initAudio, sfx } from './audio.js';

const ROUND = 300;
const N_BOTS = 15;
const $ = (id) => document.getElementById(id);

// ---------- Escena ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03040a);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 5000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4a5a, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
scene.add(sun, sun.target);
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

buildLand();
const globe = createGlobe(scene);
const world = new World(scene);
world.populate();
$('loading').classList.add('hidden');

// ---------- Huecos ----------
const player = new Hole({ name: 'Vos', color: 0x00e5ff, isPlayer: true });
const bots = makeBots(N_BOTS);
const holes = [player, ...bots];
for (const b of bots) { b.spawnAt(safeSpawn(holes)); b.setArea(START_A * (1 + Math.random() * 6)); }

const game = {
  holes, world, now: 0, event: null, leader: null, state: 'menu', roundT: ROUND, nextEvent: 25, frenzy: false,
  throwBomb,
};

// ---------- Guardado ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('tm_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tm_' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};
let coleccion = new Set(store.get('coleccion', []));
function showRecords() {
  const best = store.get('best', 0), bestR = store.get('bestR', 0);
  $('records').innerHTML = `Récord: <b>${best.toLocaleString('es')}</b> pts · Máximo: <b>${titleOf(bestR)}</b> · Monumentos coleccionados: <b>${coleccion.size}/${LANDMARKS.length}</b>`;
}
showRecords();
$('name').value = store.get('name', '');
$('city').innerHTML = '<option value="-1">🎲 Empezar en un lugar al azar</option>' +
  CITIES.map((c, i) => [c, i]).sort((a, b) => a[0].name.localeCompare(b[0].name)).map(([c, i]) => `<option value="${i}">${c.name}</option>`).join('');
$('city').value = store.get('city', '-1');

// ---------- Bombas ----------
const projectiles = [];
const bombGeo = new THREE.SphereGeometry(0.5, 12, 10);
const bombMat = new THREE.MeshBasicMaterial({ color: 0xff3b2f });
const rings = [];
const ringGeo = new THREE.RingGeometry(0.85, 1, 48);

function throwBomb(h, dir) {
  if (h.bombs <= 0 || h.bombCd > game.now || !h.alive) return;
  h.bombs--; h.bombCd = game.now + 0.5;
  const p = { owner: h, pos: h.pos.clone(), dir: dir.clone(), travelled: 0, max: 22 + h.r * 1.6, mesh: new THREE.Mesh(bombGeo, bombMat) };
  tangentize(p.dir, p.pos);
  moveOnSphere(p.pos, p.dir, h.r * 0.9 + 0.4);
  p.mesh.scale.setScalar(1 + h.r * 0.05);
  scene.add(p.mesh);
  projectiles.push(p);
  if (nearPlayer(h.pos, 30)) sfx.throw();
}

function ring(pos, size, color, dur = 0.7) {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  m.position.copy(pos).multiplyScalar(R + 0.15);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), pos);
  scene.add(m);
  rings.push({ m, t: 0, dur, size });
}

function explode(p, target) {
  ring(p.pos, 6 + (target ? target.r * 2 : 0), 0xff7a2f);
  if (nearPlayer(p.pos, 40)) { sfx.boom(); shake = Math.max(shake, 0.6); }
  if (!target) return;
  const o = p.owner;
  target.stun = 1.3;
  if (target.r > 1.3) {
    const lost = target.A * 0.42;
    target.setArea(target.A - lost);
    world.scatterDebris(target.pos, target.r, lost * 0.6, Math.max(6, Math.min(70, Math.round(lost * 2.5))));
    target.splits++; o.splits++;
    o.score += 100 + Math.round(lost * 25);
    feed(`💣 <b style="color:${css(o)}">${o.name}</b> partió a <b style="color:${css(target)}">${target.name}</b>`);
    if (o === player) { popup(player.pos, `💥 +${100 + Math.round(lost * 25)}`, '#ff9d2f'); banner(`💥 ¡Partiste a ${target.name}!`); }
    if (target === player) banner('💥 ¡Te partieron con una bomba!');
  }
}

// ---------- Input ----------
const input = { mx: innerWidth / 2, my: innerHeight / 2 - 80, keys: new Set(), boostBtn: false, rmb: false, touching: false };
addEventListener('pointermove', (e) => { input.mx = e.clientX; input.my = e.clientY; });
renderer.domElement.addEventListener('pointerdown', (e) => {
  input.mx = e.clientX; input.my = e.clientY;
  if (e.pointerType === 'touch') { input.touching = true; return; }
  if (e.button === 0 && game.state === 'play') throwBomb(player, playerAimDir());
  if (e.button === 2) input.rmb = true;
});
addEventListener('pointerup', (e) => { if (e.button === 2) input.rmb = false; if (e.pointerType === 'touch') input.touching = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('keydown', (e) => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  input.keys.add(e.code);
  if (e.code === 'Space') {
    e.preventDefault();
    if (game.state === 'play') throwBomb(player, playerAimDir());
    else if (game.state === 'dead') revive();
  }
});
addEventListener('keyup', (e) => input.keys.delete(e.code));
$('btnBomb').addEventListener('pointerdown', (e) => { e.stopPropagation(); if (game.state === 'play') throwBomb(player, playerAimDir()); });
$('btnBoost').addEventListener('pointerdown', (e) => { e.stopPropagation(); input.boostBtn = true; });
$('btnBoost').addEventListener('pointerup', () => { input.boostBtn = false; });
$('btnBoost').addEventListener('pointerleave', () => { input.boostBtn = false; });

const camF = new THREE.Vector3(0, 1, 0);
let camH = 10, shake = 0;
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _cr = new THREE.Vector3(), _cu = new THREE.Vector3();
const _proj = new THREE.Vector3();

function toScreen(v, out = { x: 0, y: 0, ok: false }) {
  _proj.copy(v).project(camera);
  out.x = (_proj.x * 0.5 + 0.5) * innerWidth;
  out.y = (-_proj.y * 0.5 + 0.5) * innerHeight;
  out.ok = _proj.z < 1;
  return out;
}
/** Dirección (tangente en el jugador) desde pantalla dx,dy */
function screenToWorldDir(dx, dy, out) {
  _cr.setFromMatrixColumn(camera.matrixWorld, 0);
  _cu.setFromMatrixColumn(camera.matrixWorld, 1);
  out.copy(_cr).multiplyScalar(dx).addScaledVector(_cu, -dy);
  return tangentize(out, player.pos);
}
const aim = new THREE.Vector3();
function playerAimDir() { return aim.lengthSq() > 0 ? aim : player.dir; }

function readPlayerInput() {
  let dx = 0, dy = 0, kb = false;
  const k = input.keys;
  if (k.has('KeyW') || k.has('ArrowUp')) { dy -= 1; kb = true; }
  if (k.has('KeyS') || k.has('ArrowDown')) { dy += 1; kb = true; }
  if (k.has('KeyA') || k.has('ArrowLeft')) { dx -= 1; kb = true; }
  if (k.has('KeyD') || k.has('ArrowRight')) { dx += 1; kb = true; }
  let throttle = 1;
  if (!kb) {
    const s = toScreen(_v1.copy(player.pos).multiplyScalar(R));
    dx = input.mx - s.x; dy = input.my - s.y;
    const len = Math.hypot(dx, dy);
    const touchIdle = matchMedia('(pointer: coarse)').matches && !input.touching;
    throttle = touchIdle ? 0 : Math.min(1, Math.max(0, (len - 12) / (Math.min(innerWidth, innerHeight) * 0.16)));
  }
  if (dx === 0 && dy === 0) { player.throttle = 0; return; }
  screenToWorldDir(dx, dy, aim);
  if (throttle > 0.02) steer(player.dir, aim, player.pos, 0.6);
  player.throttle = throttle;
  player.boost = (k.has('ShiftLeft') || k.has('ShiftRight') || input.rmb || input.boostBtn) && player.A > 1;
}

// ---------- HUD ----------
const css = (h) => '#' + h.color.getHexString();
const labelEls = new Map();
function labelFor(h) {
  let el = labelEls.get(h);
  if (!el) { el = document.createElement('div'); el.className = 'lbl'; $('labels').appendChild(el); labelEls.set(h, el); }
  return el;
}
const arrowEls = [];
function arrowEl(i) {
  while (arrowEls.length <= i) { const a = document.createElement('div'); a.className = 'arw'; a.innerHTML = '<span></span>'; $('arrows').appendChild(a); arrowEls.push(a); }
  return arrowEls[i];
}
function feed(html) {
  const d = document.createElement('div'); d.innerHTML = html;
  const f = $('feed'); f.prepend(d);
  while (f.children.length > 6) f.lastChild.remove();
  setTimeout(() => d.remove(), 6000);
}
function popup(pos, text, color = '#fff', size = 20) {
  const s = toScreen(_v3.copy(pos).multiplyScalar(R));
  const d = document.createElement('div');
  d.className = 'pop'; d.textContent = text; d.style.color = color; d.style.fontSize = size + 'px';
  d.style.left = (s.x + (Math.random() - 0.5) * 60) + 'px'; d.style.top = (s.y - 30) + 'px';
  $('popups').appendChild(d);
  setTimeout(() => d.remove(), 900);
}
function banner(text) {
  const b = $('banner'); b.textContent = text; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
}
let pending = 0, pendingT = 0;

function updateBoard() {
  const list = holes.filter((h) => h.alive || h === player).sort((a, b) => b.score - a.score);
  const rows = list.slice(0, 8);
  if (!rows.includes(player)) rows.push(player);
  $('board').innerHTML = rows.map((h) => {
    const pos = list.indexOf(h) + 1;
    return `<div class="row ${h === player ? 'me' : ''}"><span>${pos}.</span><span class="dot" style="background:${css(h)}"></span><span class="nm">${h === game.leader ? '👑 ' : ''}${h.name}</span><span class="pt">${h.score.toLocaleString('es')}</span></div>`;
  }).join('');
}

function updateMeHud() {
  $('score').textContent = player.score.toLocaleString('es');
  const mult = comboMult(player);
  const c = $('combo');
  c.textContent = player.combo >= 3 ? `COMBO ${player.combo}${mult > 1 ? `  ×${mult}` : ''}` : '';
  c.classList.toggle('hot', mult >= 3);
  $('mons').textContent = `🏛️ ${player.landmarks.length} esta ronda · ${coleccion.size}/${LANDMARKS.length} colección`;
  const ti = titleIndex(player.r);
  $('title').textContent = `${TITLES[ti][1]} · ${player.r.toFixed(1)} m`;
  const lo = TITLES[ti][0], hi = TITLES[ti + 1] ? TITLES[ti + 1][0] : lo * 1.5 + 5;
  $('barFill').style.width = Math.min(100, ((player.r - lo) / (hi - lo)) * 100) + '%';
  $('bombs').textContent = '💣'.repeat(player.bombs) + '◦'.repeat(MAX_BOMBS - player.bombs);
  const t = Math.max(0, game.roundT);
  $('timer').textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  $('timer').classList.toggle('low', t < 30);
  $('frenzy').classList.toggle('hidden', !game.frenzy);
}

function comboMult(h) { return Math.min(5, 1 + Math.floor(h.combo / 8)) * (game.frenzy ? 2 : 1); }

// ---------- Comer ----------
const toEat = [];
let lastTitle = 0;
function eatObjects(h) {
  toEat.length = 0;
  world.query(h.pos, h.r + 1, (o) => {
    if (!o.alive) return;
    const d = surfDist(h.pos, o.pos);
    if (o.kind === 'bomb') { if (d < h.r + 0.3 && h.bombs < MAX_BOMBS) toEat.push(o); }
    else if (o.s < h.r * EAT_RATIO && d + o.s * 0.4 < h.r) toEat.push(o);
  });
  for (const o of toEat) {
    if (!o.alive) continue;
    world.kill(o, h);
    if (o.kind === 'bomb') {
      h.bombs++;
      if (h === player) { sfx.bombPick(); popup(h.pos, '💣', '#ff5b4f', 26); }
      continue;
    }
    h.setArea(h.A + (o.area ?? o.s * o.s * GAIN));
    h.combo = h.comboT > 0 ? h.combo + 1 : 1;
    h.comboT = 1.6;
    const pts = o.pts * comboMult(h);
    h.score += pts; h.eaten++;
    if (o.kind === 'gold') h.rush = 3;
    if (o.landmark) {
      h.landmarks.push(o.landmark.name);
      h.score += 0;
      feed(`🏛️ <b style="color:${css(h)}">${h.name}</b> se tragó ${o.landmark.name}`);
    }
    if (h === player) {
      pending += pts;
      sfx.eat(h.combo, o.s);
      if (o.kind === 'gold') { sfx.gold(); popup(h.pos, `💛 +${pts}`, '#ffd23a', 26); }
      if (o.landmark) {
        sfx.landmark(); shake = 0.5;
        const nuevo = !coleccion.has(o.landmark.name);
        coleccion.add(o.landmark.name); store.set('coleccion', [...coleccion]);
        banner(`¡Te tragaste ${o.landmark.name}! +${pts}${nuevo ? '  ⭐ NUEVO' : ''}`);
      }
    }
  }
  if (h === player) {
    const ti = titleIndex(h.r);
    if (ti > lastTitle) { banner(`¡Ahora sos ${TITLES[ti][1].toUpperCase()}!`); sfx.level(); }
    lastTitle = Math.max(lastTitle, ti);
  }
}

function eatHole(big, small) {
  const bonus = small === game.leader ? 500 : 0;
  const pts = (150 + Math.round(small.A * 30) + bonus) * (game.frenzy ? 2 : 1);
  big.setArea(big.A + small.A * 0.6);
  big.score += pts; big.kills++;
  small.alive = false; small.deaths++; small.killer = big;
  small.respawnAt = game.now + 3 + Math.random() * 3;
  ring(small.pos, small.r * 3 + 3, small.color.getHex(), 0.6);
  feed(`🕳️ <b style="color:${css(big)}">${big.name}</b> se tragó a <b style="color:${css(small)}">${small.name}</b>${bonus ? ' 👑' : ''}`);
  if (big === player) { sfx.hole(); popup(big.pos, `🕳️ +${pts}`, '#5dff8f', 28); if (bonus) banner(`👑 ¡Te tragaste al líder ${small.name}!`); }
  if (small === player) die(big);
}

// ---------- Estados ----------
function startRound() {
  game.roundT = ROUND; game.nextEvent = ROUND - 25; game.event = null; game.frenzy = false;
  for (const h of holes) { h.score = 0; h.kills = 0; h.eaten = 0; h.splits = 0; h.deaths = 0; h.landmarks = []; h.bestR = 0; }
  for (const b of bots) { b.spawnAt(safeSpawn(holes)); b.setArea(START_A * (1 + Math.random() * 1.5)); }
  spawnPlayer();
  game.state = 'play';
  $('hud').classList.remove('hidden');
  ['start', 'end', 'dead'].forEach((id) => $(id).classList.add('hidden'));
}

function spawnPlayer() {
  const ci = +$('city').value;
  let p;
  if (ci >= 0 && game.state !== 'dead') p = offsetPoint(CITIES[ci].pos, 3, Math.random() * 7);
  else p = safeSpawn(holes);
  player.spawnAt(p);
  lastTitle = 0;
  camF.set(0, 1, 0); tangentize(camF, player.pos);
  player.dir.copy(camF);
  camH = 14;
}

function die(killer) {
  game.state = 'dead';
  sfx.death();
  $('killer').textContent = killer.name;
  $('killer').style.color = css(killer);
  $('deadStats').textContent = `Llegaste a ${titleOf(player.bestR)} (${player.bestR.toFixed(1)} m) · ${player.score.toLocaleString('es')} pts`;
  $('dead').classList.remove('hidden');
}
function revive() {
  if (game.state !== 'dead') return;
  $('dead').classList.add('hidden');
  spawnPlayer();
  game.state = 'play';
}

function endRound() {
  game.state = 'end';
  const list = [...holes].sort((a, b) => b.score - a.score);
  const place = list.indexOf(player) + 1;
  $('endPlace').textContent = place === 1 ? '🏆 ¡GANASTE LA RONDA!' : `Quedaste #${place} de ${list.length}`;
  $('endTable').innerHTML = list.slice(0, 10).map((h, i) =>
    `<tr class="${h === player ? 'me' : ''}"><td>${i + 1}.</td><td><span style="color:${css(h)}">●</span> ${h.name}</td><td>${titleOf(h.bestR)}</td><td>${h.score.toLocaleString('es')}</td></tr>`).join('');
  const best = store.get('best', 0);
  const record = player.score > best;
  if (record) store.set('best', player.score);
  if (player.bestR > store.get('bestR', 0)) store.set('bestR', player.bestR);
  $('endStats').innerHTML = `${record ? '⭐ <b>¡Nuevo récord!</b><br>' : ''}Objetos: <b>${player.eaten}</b> · Huecos tragados: <b>${player.kills}</b> · Bombazos: <b>${player.splits}</b> · Monumentos: <b>${player.landmarks.length}</b><br>Tamaño máximo: <b>${titleOf(player.bestR)}</b> (${player.bestR.toFixed(1)} m) · Colección: ${coleccion.size}/${LANDMARKS.length}`;
  $('end').classList.remove('hidden');
  $('dead').classList.add('hidden');
  showRecords();
}

$('play').addEventListener('click', () => {
  initAudio();
  player.name = ($('name').value.trim() || 'Vos').slice(0, 14);
  store.set('name', $('name').value.trim()); store.set('city', $('city').value);
  startRound();
});
$('revive').addEventListener('click', revive);
$('again').addEventListener('click', startRound);

// ---------- Eventos del mundo ----------
function worldEvents(dt) {
  if (game.state !== 'play' && game.state !== 'dead') return;
  game.roundT -= dt;
  game.frenzy = game.roundT < 30;
  if (game.roundT <= game.nextEvent) {
    game.nextEvent -= 55;
    let total = CITIES.reduce((s, c) => s + c.w, 0), r = Math.random() * total, city = CITIES[0];
    for (const c of CITIES) { r -= c.w; if (r <= 0) { city = c; break; } }
    world.goldRain(city, 34);
    game.event = { city, until: game.now + 35 };
    feed(`🌧️💛 ¡Lluvia de oro en <b>${city.name}</b>!`);
    banner(`🌧️💛 Lluvia de oro en ${city.name}`);
    sfx.event();
  }
  if (game.event && game.now > game.event.until) game.event = null;
  if (game.roundT <= 0 && game.state === 'play') endRound();
  else if (game.roundT <= 0 && game.state === 'dead') endRound();
}

function nearPlayer(pos, d) { return player.alive && game.state === 'play' && surfDist(pos, player.pos) < d + player.r; }

// ---------- Bucle ----------
const clock = new THREE.Timer();
let boardT = 0, menuAng = 0;

function tick() {
  clock.update(); const dt = Math.min(0.05, clock.getDelta());
  game.now += dt;
  const playing = game.state === 'play';

  // jugador
  if (playing && player.alive) readPlayerInput();

  // bots
  for (const h of bots) {
    if (!h.alive) {
      if (game.now > h.respawnAt) { h.spawnAt(safeSpawn(holes)); h.setArea(START_A * (1 + Math.random() * 2.5)); }
      continue;
    }
    h.ai.think -= dt;
    if (h.ai.think <= 0) { h.ai.think = 0.22 + Math.random() * 0.15; thinkBot(h, game); }
    steer(h.dir, h.ai.desired, h.pos, h.ai.turn * dt);
    h.throttle = 1;
  }

  // mover + comer + reglas de tamaño
  let leader = null;
  for (const h of holes) {
    if (!h.alive) continue;
    if (h.boost && h.A > 1) h.setArea(h.A - h.A * 0.03 * dt); else h.boost = false;
    if (h.r > 8) h.setArea(h.A - dt * h.A * 0.02 * (h.r - 8) / 8); // evaporación de gigantes
    h.stun = Math.max(0, h.stun - dt); h.shield = Math.max(0, (h.shield || 0) - dt); h.rush = Math.max(0, h.rush - dt);
    h.comboT -= dt; if (h.comboT <= 0) h.combo = 0;
    moveOnSphere(h.pos, h.dir, h.speed() * h.throttle * dt);
    eatObjects(h);
    h.bestR = Math.max(h.bestR, h.r);
    if (!leader || h.r > leader.r) leader = h;
  }
  game.leader = leader;
  for (let i = 0; i < holes.length; i++) {
    const a = holes[i]; if (!a.alive) continue;
    for (let j = i + 1; j < holes.length; j++) {
      const b = holes[j]; if (!b.alive || !a.alive) continue;
      const big = a.r >= b.r ? a : b, small = big === a ? b : a;
      if (!(small.shield > 0) && big.r > small.r * HOLE_RATIO && surfDist(big.pos, small.pos) < big.r - small.r * 0.4) eatHole(big, small);
    }
  }

  // proyectiles
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    const step = 34 * dt;
    moveOnSphere(p.pos, p.dir, step); p.travelled += step;
    const hop = 0.6 + Math.abs(Math.sin(p.travelled * 0.5)) * 2.2;
    p.mesh.position.copy(p.pos).multiplyScalar(R + hop);
    let hit = null;
    for (const h of holes) if (h !== p.owner && h.alive && surfDist(p.pos, h.pos) < h.r + 0.4) { hit = h; break; }
    if (hit || p.travelled > p.max) { explode(p, hit); scene.remove(p.mesh); projectiles.splice(i, 1); }
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.t += dt; const k = r.t / r.dur;
    r.m.scale.setScalar(0.5 + k * r.size); r.m.material.opacity = 1 - k;
    if (k >= 1) { scene.remove(r.m); r.m.material.dispose(); rings.splice(i, 1); }
  }

  worldEvents(dt);
  world.update(dt, game.now, holes);

  // shader de huecos
  const vis = holes.filter((h) => h.alive).sort((a, b) => b.r - a.r).slice(0, MAX_HOLES);
  globe.setHoles(vis);
  globe.uniforms.time.value = game.now;

  updateCamera(dt);
  sun.position.copy(camera.position).add(_v1.set(30, 60, 20)); sun.target.position.set(0, 0, 0);
  globe.uniforms.sunDir.value.copy(sun.position).normalize();

  renderer.render(scene, camera);
  updateLabels();

  // HUD
  if (playing || game.state === 'dead') {
    pendingT -= dt;
    if (pending > 0 && pendingT <= 0) { popup(player.pos, '+' + pending, player.combo >= 12 ? '#ffd23a' : '#fff', 16 + Math.min(14, Math.log2(pending + 1) * 2)); pending = 0; pendingT = 0.18; }
    updateMeHud();
    boardT -= dt;
    if (boardT <= 0) { boardT = 0.3; updateBoard(); }
  }
  requestAnimationFrame(tick);
}

function updateCamera(dt) {
  if (game.state === 'menu' || (game.state === 'end')) {
    menuAng += dt * 0.04;
    camera.up.set(0, 1, 0);
    camera.position.set(Math.cos(menuAng) * R * 2.9, R * 0.9, Math.sin(menuAng) * R * 2.9);
    camera.lookAt(0, 0, 0);
    return;
  }
  const n = player.pos;
  tangentize(camF, n);
  const target = Math.min(220, 11 + player.r * 4.4 + (player.boost ? 3 : 0));
  camH += (target - camH) * Math.min(1, dt * 2.5);
  const H = camH;
  const base = _v1.copy(n).multiplyScalar(R);
  camera.position.copy(base).addScaledVector(n, H).addScaledVector(camF, -H * 0.38);
  if (shake > 0) { shake = Math.max(0, shake - dt * 1.5); camera.position.add(_v2.randomDirection().multiplyScalar(shake * (0.3 + H * 0.02))); }
  camera.up.copy(n);
  camera.lookAt(_v2.copy(base).addScaledVector(camF, H * 0.08));
  camera.updateMatrixWorld();
}

const _s = { x: 0, y: 0, ok: false }, _s2 = { x: 0, y: 0, ok: false };
const tanHalf = () => Math.tan((camera.fov * Math.PI) / 360);
function updateLabels() {
  const camLen = camera.position.length();
  for (const h of holes) {
    const el = labelFor(h);
    const w = _v1.copy(h.pos).multiplyScalar(R);
    const visible = h.alive && h.pos.dot(camera.position) > R * 1.0 && game.state !== 'menu';
    if (!visible) { el.style.display = 'none'; continue; }
    toScreen(w, _s);
    if (!_s.ok || _s.x < -50 || _s.y < -50 || _s.x > innerWidth + 50 || _s.y > innerHeight + 50) { el.style.display = 'none'; continue; }
    const dist = camera.position.distanceTo(w);
    const pxR = (h.r / (dist * tanHalf())) * (innerHeight / 2);
    if (pxR < 4) { el.style.display = 'none'; continue; }
    el.style.display = 'block';
    el.style.left = _s.x + 'px'; el.style.top = _s.y + 'px';
    el.style.fontSize = Math.max(10, Math.min(30, pxR * 0.42)) + 'px';
    el.style.color = h === player ? '#fff' : css(h);
    el.innerHTML = (h === game.leader ? '<span class="crown">👑</span>' : '') + (h.shield > 0 ? '🛡️ ' : '') + h.name;
  }
  // flechas al borde
  let ai = 0;
  if (game.state === 'play' && player.alive) {
    const cx = innerWidth / 2, cy = innerHeight / 2, rx = innerWidth / 2 - 40, ry = innerHeight / 2 - 50;
    const pw = _v3.copy(player.pos).multiplyScalar(R);
    toScreen(pw, _s2);
    const addArrow = (pos, color, label) => {
      const dir = dirTo(player.pos, pos, _v2);
      const t = toScreen(_v1.copy(player.pos).addScaledVector(dir, 0.02).normalize().multiplyScalar(R), _s);
      let dx = t.x - _s2.x, dy = t.y - _s2.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const k = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
      const a = arrowEl(ai++);
      a.style.display = 'block';
      a.style.left = cx + dx * k + 'px'; a.style.top = cy + dy * k + 'px';
      a.style.color = color;
      a.style.transform = `rotate(${Math.atan2(dy, dx) + Math.PI / 2}rad)`;
      a.firstChild.textContent = label;
      a.firstChild.style.transform = `translateX(-50%) rotate(${-(Math.atan2(dy, dx) + Math.PI / 2)}rad)`;
    };
    for (const h of holes) {
      if (h === player || !h.alive) continue;
      const d = surfDist(player.pos, h.pos);
      if (d > 45 + player.r * 2) continue;
      toScreen(_v1.copy(h.pos).multiplyScalar(R), _s);
      const onScreen = h.pos.dot(camera.position) > R && _s.ok && _s.x > 0 && _s.y > 0 && _s.x < innerWidth && _s.y < innerHeight;
      if (onScreen) continue;
      const color = h.r > player.r * HOLE_RATIO ? '#ff4d4d' : player.r > h.r * HOLE_RATIO ? '#5dff8f' : '#ffffff';
      addArrow(h.pos, color, `${Math.round(d)} m`);
    }
    if (game.event) {
      const d = surfDist(player.pos, game.event.city.pos);
      if (d > 6) addArrow(game.event.city.pos, '#ffd23a', `💛 ${game.event.city.name} ${Math.round(d)} m`);
    }
  }
  for (let i = ai; i < arrowEls.length; i++) arrowEls[i].style.display = 'none';
}

requestAnimationFrame(tick);
window.__tm = { game, player, holes, world };
