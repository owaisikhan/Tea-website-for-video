// Leaf physics, simulated once when the page loads and then played back by scroll.
//
// Each leaf is released from the pouch mouth, falls through air (gravity, drag,
// flutter and tumble), splashes into the pot, is carried by the water (buoyancy
// that fades as the leaf soaks, a swirling current, the glass walls and floor),
// and finally settles. Because the whole run is recorded frame by frame against
// simulated time, scrolling backwards simply plays it in reverse.

import * as THREE from "three";

import type { KindParams } from "./leafModels";

export type Mouth = { pos: THREE.Vector3; dir: THREE.Vector3; side: THREE.Vector3 };

export type SimInput = {
  kinds: number[]; // index into params
  params: KindParams[];
  sizes: number[];
  release: number[]; // seconds after the start when each leaf leaves the pouch
  duration: number; // simulated seconds
  fps: number; // recorded frames per second
  seed: number;
  mouth: (t: number, out: Mouth) => void; // pouch opening at simulated time t
  swirl: (t: number) => number; // current strength 0..1 at time t
  // Pot tilt (rotation about z, radians) and the water surface's height along world-up,
  // both measured in the pot's own frame, which is where the whole simulation runs.
  // When the pot tips to pour, gravity and the surface tilt with respect to it.
  tilt: (t: number) => number;
  level: (t: number) => number;
  floorY: number; // inside floor of the pot
  rimY: number; // top of the pot wall
  wallRadius: (y: number) => number; // inner wall radius at height y
};

export type SimResult = {
  frames: number;
  fps: number;
  pos: Float32Array; // frames * count * 3
  quat: Float32Array; // frames * count * 4
  entry: Float32Array; // per leaf: [time it hit the water (-1 if never), x, z]
};

const G = 7;
/** Largest size an ingredient reaches (leaves unfurl as they steep); containment uses it. */
export const GROWTH = 1.25;
/** Probe points in the ingredient's own frame: [axis, fraction of half-size, side]. */
const PROBES: [number, number, number][] = [
  [0, 1, -1],
  [0, 1, 1],
  [1, 0.5, -1],
  [1, 0.5, 1],
  [2, 0.5, -1],
  [2, 0.5, 1],
];

export function simulateLeaves(inp: SimInput): SimResult {
  const n = inp.kinds.length;
  const steps = 4; // physics steps per recorded frame
  const dt = 1 / (inp.fps * steps);
  const frames = Math.ceil(inp.duration * inp.fps) + 1;
  const pos = new Float32Array(frames * n * 3);
  const quat = new Float32Array(frames * n * 4);

  let seed = inp.seed;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

  const p = Array.from({ length: n }, () => new THREE.Vector3());
  const v = Array.from({ length: n }, () => new THREE.Vector3());
  const w = Array.from({ length: n }, () => new THREE.Vector3());
  const q = Array.from({ length: n }, () => new THREE.Quaternion());
  const spinAxis = Array.from({ length: n }, () => new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize());
  const phase = Array.from({ length: n }, () => rand() * Math.PI * 2);
  const freq = Array.from({ length: n }, () => 2.2 + rand() * 2.5);
  const soaked = new Float32Array(n);
  const spawned = new Uint8Array(n);
  const wet = new Uint8Array(n);
  const entry = new Float32Array(n * 3).fill(-1);

  const mouth: Mouth = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), side: new THREE.Vector3() };
  const up = new THREE.Vector3(0, 1, 0);
  const upL = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const current = new THREE.Vector3();
  const dq = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const end = new THREE.Vector3();
  const along = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const flat = new THREE.Quaternion();

  let t = 0;
  for (let f = 0; f < frames; f++) {
    for (let s = 0; s < (f === 0 ? 1 : steps); s++) {
      if (f > 0) t += dt;
      const S = inp.swirl(t);
      const theta = inp.tilt(t);
      upL.set(Math.sin(theta), Math.cos(theta), 0);
      const lvl = inp.level(t);
      const upright = theta < 0.03;
      for (let i = 0; i < n; i++) {
        if (!spawned[i]) {
          if (t < inp.release[i]) {
            // Still inside the pouch: park at the mouth so playback has a sane value.
            inp.mouth(Math.max(t, 0), mouth);
            p[i].copy(mouth.pos);
            continue;
          }
          inp.mouth(inp.release[i], mouth);
          spawned[i] = 1;
          p[i]
            .copy(mouth.pos)
            .addScaledVector(mouth.side, (rand() - 0.5) * 0.45)
            .add(tmp.set((rand() - 0.5) * 0.12, (rand() - 0.5) * 0.08, (rand() - 0.5) * 0.12));
          v[i]
            .copy(mouth.dir)
            .multiplyScalar(0.25 + rand() * 0.4)
            .add(tmp.set((rand() - 0.5) * 0.5, (rand() - 0.2) * 0.3, (rand() - 0.5) * 0.5));
          q[i].setFromEuler(new THREE.Euler(rand() * 6.28, rand() * 6.28, rand() * 6.28));
          w[i].copy(spinAxis[i]).multiplyScalar(inp.params[inp.kinds[i]].spin * (0.5 + rand()));
        }
        const P = inp.params[inp.kinds[i]];
        const x = p[i];
        const vel = v[i];
        const r = Math.hypot(x.x, x.z);
        const inPot = x.y < inp.rimY && r < inp.wallRadius(Math.max(x.y, inp.floorY)) + 0.02;
        const height = x.dot(upL);
        const inWater = inPot && height < lvl;

        if (inWater && !wet[i]) {
          // Splash: the surface soaks up most of the fall.
          wet[i] = 1;
          entry.set([t, x.x, x.z], i * 3);
          vel.multiplyScalar(0.3);
          w[i].multiplyScalar(0.4);
        }

        if (!inWater) {
          // Air: gravity and drag, plus a flutter that glides the leaf along its tilt.
          vel.addScaledVector(upL, -G * dt);
          vel.addScaledVector(vel, -P.airDrag * dt);
          const flutter = wet[i] ? 0 : P.flutter;
          normal.set(0, 0, 1).applyQuaternion(q[i]);
          const vUp = vel.dot(upL);
          const glide = Math.sin(phase[i] + t * freq[i]) * flutter * Math.min(1, Math.abs(vUp));
          vel.x += normal.x * glide * dt * 3;
          vel.z += normal.z * glide * dt * 3;
          // Broad leaves resist falling flat-side down.
          vel.addScaledVector(upL, Math.abs(normal.dot(upL)) * flutter * 0.25 * Math.max(0, -vUp) * dt * 3);
          // The pour is aimed at the middle of the pot: anything falling toward it is guided
          // to the centre of the opening, well clear of the collar and the glass.
          if (upright && !wet[i] && x.y < inp.rimY + 2.6 && x.y > inp.rimY - 0.3) {
            vel.x -= x.x * 3 * dt;
            vel.z -= x.z * 3 * dt;
            const damp = Math.exp(-1.5 * dt);
            vel.x *= damp;
            vel.z *= damp;
            const rNow = Math.hypot(x.x, x.z);
            const lim = 0.48;
            if (x.y < inp.rimY + 0.7 && rNow > lim) {
              const k = THREE.MathUtils.lerp(1, lim / rNow, 0.25);
              x.x *= k;
              x.z *= k;
            }
          }
          tmp.copy(spinAxis[i]).multiplyScalar(P.spin * (0.6 + 0.4 * Math.sin(phase[i] + t * freq[i] * 0.5)));
          w[i].lerp(tmp, Math.min(1, dt * 2));
        } else {
          soaked[i] += dt;
          const buoy = Math.max(0.72, P.buoy - P.soak * soaked[i]);
          // Water current: a slow vortex that rises through the middle and sinks along the glass.
          const R = Math.max(0.2, inp.wallRadius(x.y));
          const rr = Math.min(1, r / R);
          const tx = r > 1e-4 ? -x.z / r : 0;
          const tz = r > 1e-4 ? x.x / r : 0;
          const spinSpeed = S * 1.5 * (r / (r + 0.25));
          const rise = S * (0.9 * (1 - rr * 1.6));
          const radial = S * 0.5 * (x.y / Math.max(0.3, lvl) - 0.55);
          current.set(tx * spinSpeed + (r > 1e-4 ? (x.x / r) * radial : 0), rise, tz * spinSpeed + (r > 1e-4 ? (x.z / r) * radial : 0));
          vel.addScaledVector(upL, -G * (1 - buoy) * 0.55 * dt);
          vel.addScaledVector(tmp.copy(current).sub(vel), Math.min(1, P.waterDrag * dt));
          // Slow tumbling in water, stirred by the current.
          w[i].multiplyScalar(Math.exp(-2.2 * dt));
          w[i].y += S * 1.2 * dt;
          w[i].addScaledVector(spinAxis[i], S * 2 * dt);
        }

        x.addScaledVector(vel, dt);

        // Surface: floating leaves rest on it and turn flat.
        const surf = lvl - 0.012;
        const hNow = x.dot(upL);
        if (wet[i] && inPot && hNow > surf && hNow < surf + 0.12) {
          x.addScaledVector(upL, surf - hNow);
          const vu = vel.dot(upL);
          if (vu > 0) vel.addScaledVector(upL, -vu);
          normal.set(0, 0, 1).applyQuaternion(q[i]);
          flat.setFromUnitVectors(normal, normal.dot(upL) >= 0 ? upL : tmp.copy(upL).negate()).multiply(q[i]);
          q[i].slerp(flat, Math.min(1, dt * 4));
          w[i].multiplyScalar(Math.exp(-4 * dt));
        }

        // Glass walls and floor.
        if (x.y < inp.rimY + 0.05) {
          const margin = 0.03 + inp.sizes[i] * 0.3;
          const R = inp.wallRadius(Math.max(x.y, inp.floorY)) - margin;
          const rNow = Math.hypot(x.x, x.z);
          if (rNow > R && R > 0 && (wet[i] || rNow < R + 0.35)) {
            const nx = x.x / rNow;
            const nz = x.z / rNow;
            x.x = nx * R;
            x.z = nz * R;
            const vr = vel.x * nx + vel.z * nz;
            if (vr > 0) {
              vel.x -= nx * vr * 1.3;
              vel.z -= nz * vr * 1.3;
            }
            vel.multiplyScalar(0.985);
          }
        }
        const floor = inp.floorY + inp.sizes[i] * 0.15;
        if (x.y < floor && Math.hypot(x.x, x.z) < inp.wallRadius(inp.floorY) + 0.1) {
          x.y = floor;
          if (vel.y < 0) vel.y *= -0.1;
          const fr = Math.exp(-6 * dt);
          vel.x *= fr;
          vel.z *= fr;
          w[i].multiplyScalar(Math.exp(-5 * dt));
          // Settle flat on the glass.
          normal.set(0, 0, 1).applyQuaternion(q[i]);
          flat.setFromUnitVectors(normal, normal.y >= 0 ? up : tmp.set(0, -1, 0)).multiply(q[i]);
          q[i].slerp(flat, Math.min(1, dt * 2));
        }

        // Whole-body containment: ends and edges of every piece (not just its centre) must stay
        // inside the glass, so a cinnamon stick or a wide leaf can never poke through the wall.
        if (wet[i] || (x.y < inp.rimY && Math.hypot(x.x, x.z) < inp.wallRadius(Math.max(x.y, inp.floorY)) + 0.05)) {
          // Checked at full brewed size (leaves unfurl by up to a quarter in the hot water).
          const half = inp.sizes[i] * 0.5 * GROWTH;
          for (let pass = 0; pass < 3; pass++) {
            for (const [ax, ext, sgn] of PROBES) {
              axis.set(ax === 0 ? 1 : 0, ax === 1 ? 1 : 0, ax === 2 ? 1 : 0).applyQuaternion(q[i]);
              end.copy(x).addScaledVector(axis, half * ext * sgn);
              const ey = Math.min(inp.rimY, Math.max(end.y, inp.floorY));
              const R = inp.wallRadius(ey) - 0.04;
              const re = Math.hypot(end.x, end.z);
              if (re > R && re > 1e-4) {
                const nx = end.x / re;
                const nz = end.z / re;
                const excess = re - R;
                x.x -= nx * excess;
                x.z -= nz * excess;
                const vr = vel.x * nx + vel.z * nz;
                if (vr > 0) {
                  vel.x -= nx * vr;
                  vel.z -= nz * vr;
                }
                // Turn a long piece to lie along the glass instead of pointing into it.
                if (ax === 0) {
                  along.copy(axis).addScaledVector(tmp.set(nx, 0, nz), -(axis.x * nx + axis.z * nz));
                  if (along.lengthSq() > 1e-6) {
                    turn.setFromUnitVectors(axis, along.normalize());
                    q[i].premultiply(turn.slerp(dq.identity(), 0.6)).normalize();
                  }
                }
              }
              const floorEnd = inp.floorY + 0.015;
              if (end.y < floorEnd) x.y += floorEnd - end.y;
              // Nothing climbs out over the collar.
              const top = inp.rimY - 0.12;
              if (end.y > top) x.y -= end.y - top;
            }
          }
        }

        // Integrate orientation.
        const om = w[i];
        dq.set(om.x * dt * 0.5, om.y * dt * 0.5, om.z * dt * 0.5, 1);
        q[i].premultiply(dq).normalize();
      }
    }
    for (let i = 0; i < n; i++) {
      pos.set([p[i].x, p[i].y, p[i].z], (f * n + i) * 3);
      quat.set([q[i].x, q[i].y, q[i].z, q[i].w], (f * n + i) * 4);
    }
  }
  return { frames, fps: inp.fps, pos, quat, entry };
}
