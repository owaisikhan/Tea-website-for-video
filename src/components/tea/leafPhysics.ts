// Leaf physics, simulated once when the page loads and then played back by scroll.
//
// Each leaf is released from the pouch mouth, falls through air (gravity, drag,
// flutter and tumble), splashes into the pot, is carried by the water (buoyancy
// that fades as the leaf soaks, a swirling current, the glass walls and floor),
// and finally settles. Because the whole run is recorded frame by frame against
// simulated time, scrolling backwards simply plays it in reverse.

import * as THREE from "three";

export const LEAF_KINDS = ["rolled", "leaf", "petal", "mint"] as const;
export type LeafKind = 0 | 1 | 2 | 3;

type KindParams = {
  airDrag: number; // linear drag in air
  flutter: number; // side-to-side glide strength
  spin: number; // tumble rate in air (rad/s)
  buoy: number; // buoyancy relative to weight when dry (>1 floats)
  soak: number; // how fast buoyancy is lost per second in water
  waterDrag: number; // how quickly the leaf follows the water
};

const PARAMS: Record<LeafKind, KindParams> = {
  0: { airDrag: 1.1, flutter: 0.25, spin: 8, buoy: 0.8, soak: 0, waterDrag: 3.5 }, // rolled tea: drops fast, sinks
  1: { airDrag: 2.6, flutter: 1.5, spin: 4, buoy: 1.1, soak: 0.08, waterDrag: 4.5 }, // whole leaf: glides, floats, then sinks
  2: { airDrag: 3.6, flutter: 2.1, spin: 5, buoy: 1.2, soak: 0.015, waterDrag: 5.5 }, // petal: drifts, mostly floats
  3: { airDrag: 2.9, flutter: 1.8, spin: 4, buoy: 1.15, soak: 0.05, waterDrag: 5 }, // mint: floats for a while
};

export type Mouth = { pos: THREE.Vector3; dir: THREE.Vector3; side: THREE.Vector3 };

export type SimInput = {
  kinds: LeafKind[];
  sizes: number[];
  release: number[]; // seconds after the start when each leaf leaves the pouch
  duration: number; // simulated seconds
  fps: number; // recorded frames per second
  seed: number;
  mouth: (t: number, out: Mouth) => void; // pouch opening at simulated time t
  swirl: (t: number) => number; // current strength 0..1 at time t
  level: number; // water surface height
  floorY: number; // inside floor of the pot
  rimY: number; // top of the pot wall
  wallRadius: (y: number) => number; // inner wall radius at height y
};

export type SimResult = {
  frames: number;
  fps: number;
  pos: Float32Array; // frames * count * 3
  quat: Float32Array; // frames * count * 4
};

const G = 7;

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

  const mouth: Mouth = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), side: new THREE.Vector3() };
  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const current = new THREE.Vector3();
  const dq = new THREE.Quaternion();
  const flat = new THREE.Quaternion();

  let t = 0;
  for (let f = 0; f < frames; f++) {
    for (let s = 0; s < (f === 0 ? 1 : steps); s++) {
      if (f > 0) t += dt;
      const S = inp.swirl(t);
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
          w[i].copy(spinAxis[i]).multiplyScalar(PARAMS[inp.kinds[i]].spin * (0.5 + rand()));
        }
        const P = PARAMS[inp.kinds[i]];
        const x = p[i];
        const vel = v[i];
        const r = Math.hypot(x.x, x.z);
        const inPot = x.y < inp.rimY && r < inp.wallRadius(Math.max(x.y, inp.floorY)) + 0.02;
        const inWater = inPot && x.y < inp.level;

        if (inWater && !wet[i]) {
          // Splash: the surface soaks up most of the fall.
          wet[i] = 1;
          vel.multiplyScalar(0.3);
          w[i].multiplyScalar(0.4);
        }

        if (!inWater) {
          // Air: gravity and drag, plus a flutter that glides the leaf along its tilt.
          vel.y -= G * dt;
          vel.addScaledVector(vel, -P.airDrag * dt);
          normal.set(0, 0, 1).applyQuaternion(q[i]);
          const glide = Math.sin(phase[i] + t * freq[i]) * P.flutter * Math.min(1, Math.abs(vel.y));
          vel.x += normal.x * glide * dt * 3;
          vel.z += normal.z * glide * dt * 3;
          // Broad leaves resist falling flat-side down.
          vel.y += Math.abs(normal.y) * P.flutter * 0.25 * Math.max(0, -vel.y) * dt * 3;
          // Leaves above the pot drift toward its opening (the pour is aimed at it).
          if (x.y < inp.rimY + 1.2 && x.y > inp.rimY - 0.1) {
            vel.x -= x.x * 1.4 * dt;
            vel.z -= x.z * 1.4 * dt;
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
          const radial = S * 0.5 * (x.y / inp.level - 0.55);
          current.set(tx * spinSpeed + (r > 1e-4 ? (x.x / r) * radial : 0), rise, tz * spinSpeed + (r > 1e-4 ? (x.z / r) * radial : 0));
          vel.y += -G * (1 - buoy) * 0.55 * dt;
          vel.addScaledVector(tmp.copy(current).sub(vel), Math.min(1, P.waterDrag * dt));
          // Slow tumbling in water, stirred by the current.
          w[i].multiplyScalar(Math.exp(-2.2 * dt));
          w[i].y += S * 1.2 * dt;
          w[i].addScaledVector(spinAxis[i], S * 2 * dt);
        }

        x.addScaledVector(vel, dt);

        // Surface: floating leaves rest on it and turn flat.
        const surf = inp.level - 0.012;
        if (wet[i] && x.y > surf) {
          x.y = surf;
          if (vel.y > 0) vel.y = 0;
          normal.set(0, 0, 1).applyQuaternion(q[i]);
          flat.setFromUnitVectors(normal, normal.y >= 0 ? up : tmp.set(0, -1, 0)).multiply(q[i]);
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
        if (x.y < 0.02) {
          x.y = 0.02;
          vel.set(0, 0, 0);
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
  return { frames, fps: inp.fps, pos, quat };
}
