import * as THREE from 'three';
import { R, CITIES, surfDist, dirTo, moveOnSphere, tangentize, offsetPoint, randomLand } from './geo.js';

export const START_A = 0.5;
export const GAIN = 0.05; // área ganada = s² * GAIN
export const EAT_RATIO = 0.82; // un objeto entra si s < r * EAT_RATIO
export const HOLE_RATIO = 1.12; // un hueco come a otro si r > r2 * HOLE_RATIO
export const MAX_BOMBS = 3;

export const TITLES = [
  [0, 'Bache'], [1, 'Alcantarilla'], [2, 'Socavón'], [3.6, 'Cráter'], [6, 'Sumidero'], [9.5, 'Abismo'], [14, 'Agujero Negro'], [21, 'Devoramundos'],
];
export function titleOf(r) { let t = TITLES[0][1]; for (const [min, name] of TITLES) if (r >= min) t = name; return t; }
export function titleIndex(r) { let k = 0; TITLES.forEach(([min], i) => { if (r >= min) k = i; }); return k; }

const BOT_NAMES = ['Tragón', 'La Sinkhole', 'Don Bache', 'Pozo Loco', 'Mr. Hoyo', 'Abismito', 'El Socavón', 'Cráter Kid', 'Doña Grieta',
  'Agujerín', 'Bachemán', 'Glotón 3000', 'Topo Gigio', 'Zanja', 'Hoyuelo', 'Remolino', 'Vórtice', 'Sumidero Sam'];
const BOT_COLORS = [0xff5252, 0xffab40, 0xffee58, 0x69f0ae, 0x40c4ff, 0xb388ff, 0xff80ab, 0x64ffda, 0xeeff41, 0xff6e40, 0x8c9eff, 0xea80fc, 0x18ffff, 0xccff90, 0xffd180, 0xf48fb1];

let nextId = 1;
export class Hole {
  constructor({ name, color, isPlayer = false }) {
    this.id = nextId++;
    this.name = name;
    this.color = new THREE.Color(color);
    this.isPlayer = isPlayer;
    this.pos = new THREE.Vector3(0, 1, 0);
    this.dir = new THREE.Vector3(1, 0, 0);
    this.alive = false;
    this.score = 0;
    this.kills = 0; this.eaten = 0; this.splits = 0; this.deaths = 0;
    this.landmarks = [];
    this.bombs = 0;
    this.setArea(START_A);
    this.stun = 0; this.rush = 0; this.boost = false; this.throttle = 1; this.bombCd = 0;
    this.combo = 0; this.comboT = 0;
    this.bestR = this.r;
    this.respawnAt = 0;
    this.killer = null;
    this.ai = isPlayer ? null : {
      think: Math.random() * 0.3, desired: new THREE.Vector3(), wander: null, wanderT: 0,
      aggr: 0.3 + Math.random() * 0.7, greed: 0.5 + Math.random() * 0.8, caution: 0.5 + Math.random() * 0.8,
      turn: 3 + Math.random() * 3, fleeing: false, pace: 0.72 + Math.random() * 0.22,
    };
  }
  setArea(A) { this.A = Math.max(START_A * 0.8, A); this.r = Math.sqrt(this.A); }
  speed() {
    let v = 9.5 / (1 + 0.075 * this.r);
    if (this.boost) v *= 1.65;
    if (this.stun > 0) v *= 0.3;
    if (this.rush > 0) v *= 1.35;
    if (this.ai) v *= this.ai.pace;
    return v;
  }
  spawnAt(p) {
    this.pos.copy(p).normalize();
    this.dir.set(0, 1, 0); tangentize(this.dir, this.pos);
    this.setArea(START_A); this.alive = true; this.bombs = 0; this.combo = 0; this.stun = 0; this.shield = 3;
  }
}

export function makeBots(n) {
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  return Array.from({ length: n }, (_, i) => new Hole({ name: names[i % names.length], color: BOT_COLORS[i % BOT_COLORS.length] }));
}

/** Punto de reaparición lejos de huecos grandes */
export function safeSpawn(holes, preferCity = true) {
  const p = new THREE.Vector3();
  for (let t = 0; t < 30; t++) {
    if (preferCity && Math.random() < 0.75) {
      const c = CITIES[Math.floor(Math.random() * CITIES.length)];
      offsetPoint(c.pos, 3 + Math.random() * 6, Math.random() * 7, p);
    } else randomLand(p);
    let ok = true;
    for (const h of holes) if (h.alive && h.r > 1.2 && surfDist(h.pos, p) < h.r * 3 + 10) { ok = false; break; }
    if (ok) return p;
  }
  return p;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion();

/** Gira dir hacia desired (ambos tangentes en n) a lo sumo maxAng */
export function steer(dir, desired, n, maxAng) {
  if (desired.lengthSq() < 1e-8) return;
  _a.crossVectors(dir, desired);
  const ang = Math.atan2(_a.dot(n), dir.dot(desired));
  const k = Math.max(-maxAng, Math.min(maxAng, ang));
  _q.setFromAxisAngle(n, k);
  dir.applyQuaternion(_q);
  tangentize(dir, n);
}

/** IA de un hueco */
export function thinkBot(h, game) {
  const ai = h.ai;
  const { holes, world, event } = game;
  const des = ai.desired.set(0, 0, 0);
  const flee = _b.set(0, 0, 0);
  let threat = 0;
  let bestScore = 0, bestPos = null, bestHole = null;

  for (const o of holes) {
    if (o === h || !o.alive) continue;
    const d = surfDist(h.pos, o.pos);
    if (o.r > h.r * HOLE_RATIO) {
      const danger = o.r + 5 + o.r * 1.2 * ai.caution;
      if (d < danger) {
        const w = (danger - d) / danger;
        threat = Math.max(threat, w);
        flee.addScaledVector(dirTo(h.pos, o.pos, _a), -w * 2);
      }
      // ¿tirarle una bomba?
      if (h.bombs > 0 && o.r > Math.max(1.6, h.r * 1.15) && d < 14 + h.r && d > o.r * 0.6 && Math.random() < 0.25 * ai.aggr + (o === game.leader ? 0.2 : 0)) {
        game.throwBomb(h, dirTo(h.pos, o.pos, _a));
      }
    } else if (h.r > o.r * HOLE_RATIO * 1.03) {
      if (d < 16 + h.r * 2) {
        const sc = (o.A * 6 * ai.aggr + (o.isPlayer ? 0.5 : 0)) / (d + 2);
        if (sc > bestScore) { bestScore = sc; bestPos = o.pos; bestHole = o; }
      }
    }
  }

  world.query(h.pos, 9 + h.r * 3, (o) => {
    if (!o.alive) return;
    let v;
    if (o.kind === 'bomb') { if (h.bombs >= 3) return; v = 0.5 * ai.aggr; }
    else {
      if (o.s > h.r * EAT_RATIO) return;
      v = o.s * o.s * (o.kind === 'gold' ? 6 : o.landmark ? 3 : 1) * ai.greed;
      if (o.kind === 'debris') v *= 2;
    }
    const d = surfDist(h.pos, o.pos);
    const sc = v / (d + 1.2);
    if (sc > bestScore) { bestScore = sc; bestPos = o.pos; bestHole = null; }
  });

  if (bestPos) dirTo(h.pos, bestPos, des);
  else {
    // pasear: hacia el evento si está cerca o hacia una ciudad
    if (event && surfDist(h.pos, event.city.pos) < R) ai.wander = event.city.pos;
    else if (!ai.wander || game.now > ai.wanderT || surfDist(h.pos, ai.wander) < 3) {
      const c = CITIES[Math.floor(Math.random() * CITIES.length)];
      ai.wander = surfDist(h.pos, c.pos) < R * 0.8 ? c.pos : offsetPoint(h.pos, 20, Math.random() * 7);
      ai.wanderT = game.now + 25;
    }
    dirTo(h.pos, ai.wander, des);
  }

  ai.fleeing = threat > 0.15;
  if (ai.fleeing) des.multiplyScalar(0.4).add(flee);
  tangentize(des, h.pos);
  h.boost = (threat > 0.45 && h.A > 1.2) || (bestHole && surfDist(h.pos, bestHole.pos) < 7 + h.r && h.A > 2 && ai.aggr > 0.6);
}
