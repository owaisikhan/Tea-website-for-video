import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { clamp01, phases, pourFlow, range, smoothstep, teaCenter } from "@/lib/teaTimeline";
import { buildLeafSet, type LeafSet } from "./leafModels";
import { GROWTH, simulateLeaves, type Mouth, type SimResult } from "./leafPhysics";
import {
  backdropShader,
  bubbleShader,
  dustShader,
  MAX_RIPPLES,
  PROFILE_SAMPLES,
  surfaceShader,
  glassShader,
  liquidShader,
  steamShader,
  streamShader,
  tableShader,
  vignetteShader,
} from "./shaders";

type Options = { canvas: HTMLCanvasElement; lite?: boolean };

/** Uniforms every refracting material shares: the opaque scene and the buffer size. */
type Shared = {
  uScene: { value: THREE.Texture };
  uRes: { value: THREE.Vector2 };
  uEnv: { value: THREE.Texture };
  uEnvOn: { value: number };
  uEnvYaw: { value: number };
  uEnvStrength: { value: number };
};

// ---------------------------------------------------------------- profiles
// Lathe profiles as [radius, height]. The spout sits on -x, the handle on +x.
// A classic round glass teapot. The shell runs up the outside, rolls over the rim of the
// collar and back down the inside, so the glass has real thickness and a thick base.
const POT_OUTER: [number, number][] = [
  [0, 0], [0.55, 0], [0.66, 0.015], [0.7, 0.05], [0.8, 0.12], [1.0, 0.26], [1.17, 0.5], [1.25, 0.82],
  [1.2, 1.14], [1.04, 1.43], [0.86, 1.6], [0.8, 1.68], [0.79, 1.78], [0.785, 1.815],
];
const POT_INNER: [number, number][] = [
  [0, 0.13], [0.5, 0.13], [0.76, 0.17], [0.96, 0.28], [1.13, 0.5], [1.21, 0.82], [1.16, 1.13],
  [1.0, 1.41], [0.82, 1.57], [0.745, 1.7], [0.74, 1.81],
];
const POT_SHELL: [number, number][] = [...POT_OUTER, [0.76, 1.83], ...[...POT_INNER].reverse()];
// Lid: knob on a short stem, a shallow dome, a flange that rests on the collar and a plug inside it.
const POT_LID: [number, number][] = [
  [0, 2.34], [0.06, 2.33], [0.1, 2.29], [0.1, 2.24], [0.065, 2.2], [0.045, 2.16], [0.05, 2.12],
  [0.14, 2.1], [0.4, 2.04], [0.62, 1.95], [0.78, 1.88], [0.82, 1.855], [0.835, 1.845], [0.82, 1.832],
  [0.73, 1.832], [0.715, 1.76], [0.69, 1.745], [0.66, 1.8], [0.45, 1.93], [0.2, 2.0], [0, 2.02],
];
const CUP: [number, number][] = [
  [0, 0.0], [0.55, 0.0], [0.64, 0.12], [0.7, 0.45], [0.77, 0.9], [0.8, 1.06], [0.74, 1.07],
  [0.7, 0.92], [0.63, 0.5], [0.5, 0.27], [0, 0.22],
];
const CUP_INNER: [number, number][] = [
  [0, 0.23], [0.49, 0.28], [0.61, 0.5], [0.68, 0.92], [0.7, 1.02],
];
const SPOUT_TIP = new THREE.Vector3(-2.0, 1.66, 0);
const POUR_POS = new THREE.Vector3(2.6, 2.2, 0.35);
const CUP_POS = new THREE.Vector3(-0.35, 0, 0.35);
const CUP_SCALE = 1.3;

// Leaf physics runs over this slice of the scroll, as SIM_SECONDS of simulated time.
const SIM_P0 = 0.2;
const SIM_P1 = 1;
const SIM_SECONDS = 13.3;
const simTime = (p: number) => ((p - SIM_P0) / (SIM_P1 - SIM_P0)) * SIM_SECONDS;
const simProgress = (t: number) => SIM_P0 + (t / SIM_SECONDS) * (SIM_P1 - SIM_P0);
const WATER_LEVEL = 0.95;
const POUCH_MOUTH = new THREE.Vector3(0, 0.76, 0);
// Where the lid rests on the table while the leaves go in (pot space).
const LID_REST = new THREE.Vector3(3.1, -1.72, -0.6);

function lathe(profile: [number, number][], scale = 1, segs = 144) {
  // A Catmull-Rom pass through the profile keeps the silhouette free of facets.
  const spline = new THREE.CatmullRomCurve3(profile.map(([r, y]) => new THREE.Vector3(r * scale, y, 0)), false, "centripetal");
  const pts = spline.getPoints(profile.length * 14).map((v) => new THREE.Vector2(Math.max(0, v.x), v.y));
  const g = new THREE.LatheGeometry(pts, segs);
  g.computeVertexNormals();
  return g;
}

/** Tube whose radius follows `radius(t)` along the curve (or eases from r0 to r1). */
function taperedTube(curve: THREE.Curve<THREE.Vector3>, r0: number | ((t: number) => number), r1 = 0, segs = 128) {
  const radial = 32;
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const c = curve.getPointAt(t);
    const r = typeof r0 === "function" ? r0(t) : THREE.MathUtils.lerp(r0, r1, t * t * (3 - 2 * t));
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(r).add(c);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
  }
  g.computeVertexNormals();
  return g;
}

/** A rounded glass lip: a torus lying flat at height y. */
function rim(radius: number, tube: number, y: number) {
  const g = new THREE.TorusGeometry(radius, tube, 20, 160);
  g.rotateX(Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/** Radius of a lathe profile at height y. */
function radiusAt(profile: [number, number][], y: number) {
  if (y <= profile[0][1]) return profile[1][0];
  for (let i = 1; i < profile.length; i++) {
    const [r0, y0] = profile[i - 1];
    const [r1, y1] = profile[i];
    if (y >= Math.min(y0, y1) && y <= Math.max(y0, y1) && y1 !== y0) {
      return r0 + ((y - y0) / (y1 - y0)) * (r1 - r0);
    }
  }
  return profile[profile.length - 1][0];
}

/** Outer radius of the pot body sampled for the trimming in `clipInsideBody` (shaders.ts). */
const CLIP_TOP = 1.8;
const CLIP_PROFILE = Array.from({ length: 32 }, (_, i) => radiusAt(POT_OUTER, (i / 31) * CLIP_TOP) - 0.004);
const clipUniforms = (on: boolean) => ({
  uClip: { value: on ? 1 : 0 },
  uClipProfile: { value: CLIP_PROFILE },
  uClipTop: { value: CLIP_TOP },
});

function glassPair(
  geo: THREE.BufferGeometry,
  shared: Shared,
  { glow = new THREE.Color(0.12, 0.07, 0.025), refract = 0.05, opacity = 1, clip = false } = {},
) {
  const make = (side: THREE.Side, order: number) => {
    const m = new THREE.ShaderMaterial({
      ...glassShader,
      uniforms: {
        ...shared,
        uOpacity: { value: opacity },
        uRefract: { value: refract },
        uGlow: { value: glow },
        ...clipUniforms(clip),
      },
      transparent: true,
      depthWrite: false,
      side,
    });
    const mesh = new THREE.Mesh(geo, m);
    mesh.renderOrder = order;
    return mesh;
  };
  return [make(THREE.BackSide, 1), make(THREE.FrontSide, 4)];
}

function liquidPair(geo: THREE.BufferGeometry, shared: Shared, thick: number) {
  const uniforms = {
    ...shared,
    uLevel: { value: 1 },
    uBottom: { value: 0 },
    uBrew: { value: 0 },
    uTime: { value: 0 },
    uWave: { value: 0 },
    uOpacity: { value: 1 },
    uThick: { value: thick },
    ...clipUniforms(false),
  };
  const make = (side: THREE.Side, order: number) => {
    const m = new THREE.ShaderMaterial({
      ...liquidShader,
      uniforms,
      transparent: true,
      depthWrite: false,
      side,
    });
    const mesh = new THREE.Mesh(geo, m);
    mesh.renderOrder = order;
    return mesh;
  };
  return { meshes: [make(THREE.BackSide, 2), make(THREE.FrontSide, 3)], uniforms };
}

function pouchTexture() {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 720;
  const x = c.getContext("2d")!;
  x.scale(2, 2);
  const g = x.createLinearGradient(0, 0, 256, 360);
  g.addColorStop(0, "#e9c36a");
  g.addColorStop(0.45, "#a8741f");
  g.addColorStop(0.7, "#f3d58a");
  g.addColorStop(1, "#7c5212");
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 360);
  x.fillStyle = "#1a1109";
  x.fillRect(0, 120, 256, 150);
  x.strokeStyle = "#d9b25a";
  x.lineWidth = 1.5;
  x.strokeRect(14, 132, 228, 126);
  x.fillStyle = "#e8c577";
  x.textAlign = "center";
  x.font = "600 34px Georgia, serif";
  x.fillText("KINARI", 128, 190);
  x.font = "italic 22px Georgia, serif";
  x.fillText("Golden Hour", 128, 225);
  x.font = "12px Georgia, serif";
  x.fillText("LOOSE LEAF  100G", 128, 248);
  // Crimped top seal.
  x.fillStyle = "rgba(60,35,5,0.35)";
  for (let i = 0; i < 256; i += 6) x.fillRect(i, 8, 2.5, 26);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Crumpled foil: random creases, blurred, used as a bump map. */
function foilBump() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 360;
  const x = c.getContext("2d")!;
  x.fillStyle = "#808080";
  x.fillRect(0, 0, 256, 360);
  let seed = 5;
  const r = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  x.filter = "blur(1.5px)";
  for (let i = 0; i < 70; i++) {
    const v = r() > 0.5 ? 200 : 50;
    x.strokeStyle = `rgba(${v},${v},${v},${0.15 + r() * 0.25})`;
    x.lineWidth = 1 + r() * 3;
    x.beginPath();
    const sx = r() * 256;
    const sy = r() * 360;
    x.moveTo(sx, sy);
    x.lineTo(sx + (r() - 0.5) * 160, sy + (r() - 0.5) * 160);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  return t;
}

function pouchGeometry() {
  const g = new THREE.BoxGeometry(1.1, 1.55, 0.36, 24, 32, 6);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / 0.55;
    const y = p.getY(i) / 0.775;
    const puff = Math.max(0, (1 - x * x) * (1 - Math.pow(Math.abs(y), 6)));
    p.setZ(i, p.getZ(i) * (0.25 + puff));
  }
  g.computeVertexNormals();
  return g;
}

// A tiny seeded RNG so every visitor sees the same leaves.
function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

type LeafInstance = { kind: number; index: number; size: number; release: number };

/** The pot's pour motion and water level over the scroll, shared by the scene and the physics. */
function potState(p: number) {
  const pour = range(p, 0.72, 0.86);
  const lift = smoothstep(0, 0.4, pour);
  const tip = smoothstep(0.25, 0.6, pour);
  const calm = smoothstep(0.86, 0.98, p);
  const localLevel = WATER_LEVEL - tip * 0.12 - calm * 0.05;
  return {
    lift,
    tip,
    angle: tip * 0.72,
    localLevel,
    // Height of the water surface above the pot's origin, along world-up.
    levelAbove: localLevel - tip * 0.35,
  };
}

/** Pouch pose over the scroll. `t` only adds a gentle hover and shake on the live site. */
function pouchPose(p: number, t: number, o: THREE.Object3D) {
  const ph = phases(p);
  const drop = smoothstep(0, 0.55, ph.pouch);
  const tip = smoothstep(0.4, 1, ph.pouch);
  const pouring = tip * (1 - smoothstep(0.3, 0.42, p));
  const away = smoothstep(0, 1, ph.pouchOut);
  o.position.set(
    THREE.MathUtils.lerp(0.4, 0.2, tip),
    // It lifts slowly as it empties, so the ingredients fall a little further each moment.
    THREE.MathUtils.lerp(8.5, 3.45, drop) + smoothstep(0.235, 0.38, p) * 1.3 + away * 6 + Math.sin(t * 1.1) * 0.03 * (t > 0 ? 1 : 0),
    0.1,
  );
  // A slow, gentle sway while it empties (tied to the scroll, so it never jitters).
  const sway = Math.sin((p - 0.23) * 45) * 0.04 * pouring;
  o.rotation.set(0.1, -0.35 + tip * 0.2, tip * 2.55 + sway);
  o.updateMatrixWorld();
  // Keep the opening right above the middle of the pot while it pours.
  const m = POUCH_MOUTH.clone().applyMatrix4(o.matrixWorld);
  o.position.x -= m.x * tip;
  o.position.z -= m.z * tip;
  o.updateMatrixWorld();
}

export class TeaEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private vignette: ShaderPass;
  private pmrem: THREE.PMREMGenerator;
  private sceneRT: THREE.WebGLRenderTarget;
  private shared: Shared;
  private seeThrough: THREE.Object3D[] = [];
  private raf = 0;
  private running = false;
  private last = 0;
  private time = 0;
  private progress = 0;
  private target = 0;
  private velocity = 0;
  private flow = 0;
  private pointer = new THREE.Vector2();
  private pointerSmooth = new THREE.Vector2();
  private narrow = false;
  private disposables: { dispose(): void }[] = [];

  private pot = new THREE.Group();
  private potLiquid: ReturnType<typeof liquidPair>;
  private cup = new THREE.Group();
  private cupLiquid: ReturnType<typeof liquidPair>;
  private cupGlass: THREE.Mesh[] = [];
  private pouch: THREE.Mesh;
  private lid = new THREE.Group();
  private leafSet: LeafSet;
  private leafMeshes: THREE.InstancedMesh[] = [];
  private leafList: LeafInstance[] = [];
  private sim: SimResult;
  private potSurface: THREE.Mesh;
  private cupSurface: THREE.Mesh;
  private bubbles: THREE.InstancedMesh;
  private bubbleSeeds: number[][] = [];
  private foam: THREE.InstancedMesh;
  private mint: THREE.InstancedMesh;
  private stream: THREE.Mesh;
  private streamUniforms: Record<string, THREE.IUniform>;
  private steam: THREE.Mesh[] = [];
  private cupSteam: THREE.Mesh[] = [];
  private dust: THREE.Points;
  private backdrop: THREE.Mesh;
  private table: THREE.Mesh;
  private camPath: THREE.CatmullRomCurve3;
  private camAim: THREE.CatmullRomCurve3;
  private dummy = new THREE.Object3D();

  constructor({ canvas, lite = false }: Options) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.5 : 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const envTex = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = envTex;
    this.scene.environmentIntensity = 0.55;
    this.scene.background = new THREE.Color(0x050302);
    this.disposables.push(envTex);

    // Half-resolution copy of everything opaque, for glass and tea to refract.
    this.sceneRT = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType });
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
    this.shared = {
      uScene: { value: this.sceneRT.texture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uEnv: { value: blank },
      uEnvOn: { value: 0 },
      uEnvYaw: { value: 0 },
      uEnvStrength: { value: 0.9 },
    };
    this.disposables.push(blank);
    this.disposables.push(this.sceneRT);

    // Lights for the leaves, mint and pouch (glass and tea are shaded by hand).
    this.scene.add(new THREE.AmbientLight(0xffd7a0, 0.35));
    const key = new THREE.DirectionalLight(0xffb566, 2.6);
    key.position.set(4, 6, -5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xfff0dd, 0.9);
    fill.position.set(-3, 3, 6);
    this.scene.add(fill);

    // Backdrop and table.
    const backMat = new THREE.ShaderMaterial({
      ...backdropShader,
      uniforms: { uTime: { value: 0 }, uWarm: { value: 0 } },
    });
    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(52, 26), backMat);
    this.backdrop.position.set(0, 6, -12);
    this.scene.add(this.backdrop);

    const tableMat = new THREE.ShaderMaterial({
      ...tableShader,
      uniforms: {
        uBrew: { value: 0 },
        uPool: { value: new THREE.Vector3() },
        uCup: { value: CUP_POS.clone() },
        uCupAmt: { value: 0 },
        uPotAmt: { value: 1 },
        uWood: { value: blank },
        uWoodNor: { value: blank },
        uWoodRough: { value: blank },
        uWoodOn: { value: 0 },
        ...this.shared,
      },
    });
    this.table = new THREE.Mesh(new THREE.PlaneGeometry(40, 24), tableMat);
    this.table.rotation.x = -Math.PI / 2;
    this.table.position.z = -2;
    this.scene.add(this.table);

    // Teapot: one thick glass shell, a spout that flares out of the body and a tapered handle.
    // The spout starts well inside the belly, so its flared root is hidden by the body wall
    // and it grows out of the side of the pot in one piece.
    const spoutCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.72, 0.58, 0),
      new THREE.Vector3(-1.12, 0.7, 0),
      new THREE.Vector3(-1.5, 1.02, 0),
      new THREE.Vector3(-1.84, 1.43, 0),
      SPOUT_TIP.clone(),
    ], false, "centripetal");
    const spoutLip = new THREE.TorusGeometry(0.072, 0.018, 16, 64);
    spoutLip.applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), spoutCurve.getTangentAt(1)),
    );
    spoutLip.translate(SPOUT_TIP.x, SPOUT_TIP.y, SPOUT_TIP.z);
    const handleCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.95, 1.45, 0),
      new THREE.Vector3(1.5, 1.6, 0),
      new THREE.Vector3(1.9, 1.3, 0),
      new THREE.Vector3(1.86, 0.75, 0),
      new THREE.Vector3(1.5, 0.45, 0),
      new THREE.Vector3(1.02, 0.42, 0),
    ], false, "centripetal");
    const spoutRadius = (t: number) => 0.072 + 0.19 * Math.pow(1 - t, 2.6);
    const potParts: [THREE.BufferGeometry, { refract?: number; opacity?: number; clip?: boolean }][] = [
      [lathe(POT_SHELL, 1, 160), {}],
      [taperedTube(spoutCurve, spoutRadius), { clip: true }],
      [spoutLip, {}],
      [taperedTube(handleCurve, (t) => 0.072 + 0.05 * Math.pow(Math.abs(t - 0.5) * 2, 3)), { clip: true }],
    ];
    for (const [g, opts] of potParts) {
      this.pot.add(...glassPair(g, this.shared, opts));
      this.disposables.push(g);
    }
    // The lid is its own group so it can be lifted off while the ingredients go in.
    const lidGeo = lathe(POT_LID, 1, 128);
    this.lid.add(...glassPair(lidGeo, this.shared));
    this.disposables.push(lidGeo);
    this.pot.add(this.lid);
    const potLiquidGeo = lathe(POT_INNER.slice(0, 9), 0.995);
    this.potLiquid = liquidPair(potLiquidGeo, this.shared, 1.9);
    this.pot.add(...this.potLiquid.meshes);
    this.disposables.push(potLiquidGeo);
    // Tea inside the spout. It shares the pot's water level (the spout and pot are one vessel),
    // so it fills as the pot tips, and the stream only starts once it reaches the tip.
    const spoutTeaGeo = taperedTube(spoutCurve, (t) => spoutRadius(t) * 0.8 - 0.008);
    const spoutTeaUniforms = { ...this.potLiquid.uniforms, uThick: { value: 0.45 }, ...clipUniforms(true) };
    for (const [side, order] of [[THREE.BackSide, 2], [THREE.FrontSide, 3]] as const) {
      const m = new THREE.ShaderMaterial({ ...liquidShader, uniforms: spoutTeaUniforms, transparent: true, depthWrite: false, side });
      const mesh = new THREE.Mesh(spoutTeaGeo, m);
      mesh.renderOrder = order;
      this.pot.add(mesh);
      this.disposables.push(m);
    }
    this.disposables.push(spoutTeaGeo);
    this.scene.add(this.pot);

    // Ingredients: tea (rolled and whole leaves), petals, mint, ginger, cinnamon, star anise,
    // cardamom and cloves.
    this.leafSet = buildLeafSet();
    const rand = rng(7);
    const col = new THREE.Color();
    this.leafSet.ingredients.forEach((ing, kind) => {
      const count = lite ? ing.liteCount : ing.count;
      const mesh = new THREE.InstancedMesh(ing.geometry, ing.material, count);
      mesh.frustumCulled = false;
      for (let i = 0; i < count; i++) {
        const shade = 0.8 + rand() * 0.4;
        col.setRGB(shade * (0.95 + rand() * 0.1), shade, shade * (0.92 + rand() * 0.08));
        mesh.setColorAt(i, col);
        const [a, b] = ing.size;
        // Most of it tumbles out early, like a real pour; a few stragglers follow.
        const release = simTime(0.232 + 0.14 * Math.pow(rand(), 1.3));
        this.leafList.push({ kind, index: i, size: a + rand() * (b - a), release });
      }
      this.leafMeshes.push(mesh);
      this.pot.add(mesh);
    });
    this.disposables.push(...this.leafSet.disposables);

    // Run the physics once; playback follows the scroll.
    const pose = new THREE.Object3D();
    this.sim = simulateLeaves({
      kinds: this.leafList.map((l) => l.kind),
      params: this.leafSet.ingredients.map((i) => i.physics),
      sizes: this.leafList.map((l) => l.size),
      release: this.leafList.map((l) => l.release),
      duration: SIM_SECONDS,
      fps: 30,
      seed: 21,
      mouth: (t: number, out: Mouth) => {
        pouchPose(simProgress(t), 0, pose);
        out.pos.copy(POUCH_MOUTH).applyMatrix4(pose.matrixWorld);
        out.dir.set(0, 1, 0).transformDirection(pose.matrixWorld);
        out.side.set(1, 0, 0).transformDirection(pose.matrixWorld);
      },
      swirl: (t: number) => Math.sin(Math.PI * range(simProgress(t), 0.4, 0.62)),
      tilt: (t: number) => potState(simProgress(t)).angle,
      level: (t: number) => potState(simProgress(t)).levelAbove,
      floorY: 0.14,
      rimY: 1.8,
      wallRadius: (y: number) => radiusAt(POT_INNER, Math.min(1.8, Math.max(0, y))),
    });

    // Tea pouch: printed foil with creases.
    const pouchGeo = pouchGeometry();
    const tex = pouchTexture();
    const bump = foilBump();
    const pouchMat = new THREE.MeshStandardMaterial({
      map: tex,
      bumpMap: bump,
      bumpScale: 4,
      metalness: 0.85,
      roughness: 0.28,
    });
    this.pouch = new THREE.Mesh(pouchGeo, pouchMat);
    this.scene.add(this.pouch);
    this.disposables.push(pouchGeo, tex, bump, pouchMat);

    // Double-walled cup with a rounded lip.
    const cupGlow = new THREE.Color(0.16, 0.09, 0.03);
    for (const g of [lathe(CUP), rim(0.77, 0.032, 1.065)]) {
      const pair = glassPair(g, this.shared, { glow: cupGlow });
      this.cupGlass.push(...pair);
      this.cup.add(...pair);
      this.disposables.push(g);
    }
    const cupLiquidGeo = lathe(CUP_INNER, 0.97);
    this.cupLiquid = liquidPair(cupLiquidGeo, this.shared, 0.9);
    this.cup.add(...this.cupLiquid.meshes);
    this.cup.position.copy(CUP_POS);
    this.cup.scale.setScalar(CUP_SCALE);
    this.scene.add(this.cup);
    this.disposables.push(cupLiquidGeo);

    // Mint leaves on the table beside the cup.
    this.mint = new THREE.InstancedMesh(this.leafSet.mintGeometry, this.leafSet.mintMaterial, 9);
    const mr = rng(3);
    for (let i = 0; i < 9; i++) {
      this.dummy.position.set(-2.1 + mr() * 0.8 + (i > 4 ? 3.4 : 0), 0.07 + mr() * 0.05, 0.9 + mr() * 0.8);
      this.dummy.rotation.set(-Math.PI / 2 + (mr() - 0.5) * 0.4, mr() * 0.3, mr() * Math.PI * 2);
      this.dummy.scale.setScalar(0.45 + mr() * 0.25);
      this.dummy.updateMatrix();
      this.mint.setMatrixAt(i, this.dummy.matrix);
    }
    this.scene.add(this.mint);

    // Water surfaces: rippling, boiling, clipped to the inside of the pot and the cup.
    const makeSurface = (profile: [number, number][], top: number, order: number) => {
      const g = new THREE.PlaneGeometry(1, 1, lite ? 64 : 110, lite ? 64 : 110);
      g.rotateX(-Math.PI / 2);
      const samples = Array.from({ length: PROFILE_SAMPLES }, (_, i) => radiusAt(profile, (i / (PROFILE_SAMPLES - 1)) * top));
      const m = new THREE.ShaderMaterial({
        ...surfaceShader,
        uniforms: {
          ...this.shared,
          uTime: { value: 0 },
          uBoil: { value: 0 },
          uSwirl: { value: 0 },
          uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4()) },
          uRippleCount: { value: 0 },
          uBrew: { value: 0 },
          uDepth: { value: 0.8 },
          uOpacity: { value: 1 },
          uVesselInv: { value: new THREE.Matrix4() },
          uProfile: { value: samples },
          uProfileTop: { value: top },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.disposables.push(g, m);
      return mesh;
    };
    this.potSurface = makeSurface(POT_INNER, 1.8, 3.5);
    this.cupSurface = makeSurface(CUP_INNER.map(([r, y]): [number, number] => [r * 0.97, y]), 1.02, 3.5);

    // Bubbles rising through the tea as it heats, and a little foam where the pour lands.
    const bubbleGeo = new THREE.IcosahedronGeometry(1, 2);
    const bubbleMat = new THREE.ShaderMaterial({
      ...bubbleShader,
      uniforms: { ...this.shared, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
    });
    const br = rng(29);
    const nb = lite ? 80 : 160;
    this.bubbles = new THREE.InstancedMesh(bubbleGeo, bubbleMat, nb);
    this.bubbles.renderOrder = 3.2;
    this.bubbles.frustumCulled = false;
    for (let i = 0; i < nb; i++) this.bubbleSeeds.push([br(), br(), br(), br(), br()]);
    this.pot.add(this.bubbles);
    this.foam = new THREE.InstancedMesh(bubbleGeo, bubbleMat, 48);
    this.foam.renderOrder = 3.7;
    this.foam.frustumCulled = false;
    this.scene.add(this.foam);
    this.disposables.push(bubbleGeo, bubbleMat);

    // Pour stream (geometry rebuilt each frame while pouring).
    this.streamUniforms = { ...this.shared, uTime: { value: 0 }, uFlow: { value: 0 } };
    const streamMat = new THREE.ShaderMaterial({
      ...streamShader,
      uniforms: this.streamUniforms,
      transparent: true,
      depthWrite: false,
    });
    this.stream = new THREE.Mesh(new THREE.BufferGeometry(), streamMat);
    this.stream.renderOrder = 3;
    this.stream.frustumCulled = false;
    this.scene.add(this.stream);
    this.disposables.push(streamMat);

    // Steam wisps.
    const steamGeo = new THREE.PlaneGeometry(1.4, 2.6);
    steamGeo.translate(0, 1.3, 0);
    const makeSteam = (seed: number) => {
      const m = new THREE.ShaderMaterial({
        ...steamShader,
        uniforms: { uTime: { value: 0 }, uAmount: { value: 0 }, uSeed: { value: seed } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.disposables.push(m);
      const s = new THREE.Mesh(steamGeo, m);
      s.renderOrder = 6;
      this.scene.add(s);
      return s;
    };
    this.steam = [makeSteam(1.3), makeSteam(5.1)];
    this.cupSteam = [makeSteam(8.7), makeSteam(2.4)];
    this.disposables.push(steamGeo);

    // Floating gold dust.
    const dustCount = lite ? 160 : 320;
    const dPos = new Float32Array(dustCount * 3);
    const dSeed = new Float32Array(dustCount);
    const dr = rng(11);
    for (let i = 0; i < dustCount; i++) {
      dPos.set([(dr() - 0.5) * 16, dr() * 5 - 0.5, -6 + dr() * 9], i * 3);
      dSeed[i] = dr();
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dPos, 3));
    dustGeo.setAttribute("aSeed", new THREE.BufferAttribute(dSeed, 1));
    const dustMat = new THREE.ShaderMaterial({
      ...dustShader,
      uniforms: { uTime: { value: 0 }, uSize: { value: 60 }, uOpacity: { value: 0.5 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.dust = new THREE.Points(dustGeo, dustMat);
    this.dust.renderOrder = 7;
    this.scene.add(this.dust);
    this.disposables.push(dustGeo, dustMat);

    // Camera path: one key per section (see content/tea.ts for which side the copy sits),
    // joined by a spline so the camera glides through each key instead of stopping.
    const keys: [number, number, number, number, number, number][] = [
      [0, 2.9, 10.2, 0, 2.45, 0], // hero: pot under the headline
      [-0.9, 3.3, 10.2, 1.2, 2.45, 0], // unwrap: pouch above, copy right
      [1.2, 2.9, 8.2, -1.2, 1.9, 0], // glass: copy left
      [-0.6, 2.4, 6.6, 1.0, 1.15, 0], // stir: copy right
      [0.6, 1.5, 5.6, -1.1, 1.0, 0], // gold: close, copy left
      [-1.2, 2.7, 10.6, 2.3, 1.85, 0], // pour: copy right
      [-2.2, 2.6, 9.8, -1.3, 1.95, 0.3], // calm: scene right, copy left
    ];
    this.camPath = new THREE.CatmullRomCurve3(keys.map((k) => new THREE.Vector3(k[0], k[1], k[2])), false, "centripetal");
    this.camAim = new THREE.CatmullRomCurve3(keys.map((k) => new THREE.Vector3(k[3], k[4], k[5])), false, "centripetal");

    // Everything that refracts is left out of the opaque pre-pass.
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !Array.isArray(m) && m.transparent) this.seeThrough.push(o);
    });

    // Post-processing.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.55, 0.86);
    this.composer.addPass(this.bloom);
    this.vignette = new ShaderPass(vignetteShader);
    this.composer.addPass(this.vignette);
    this.composer.addPass(new OutputPass());

    this.resize();
    this.update(0);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = () => {
      if (!this.running) return;
      const now = performance.now();
      const dt = Math.min((now - this.last) / 1000, 0.05);
      this.last = now;
      this.time += dt;
      // Lenis already smooths the scroll; this only irons out wheel steps and touch jitter.
      const prev = this.progress;
      this.progress += (this.target - this.progress) * (1 - Math.exp(-dt * 10));
      if (Math.abs(this.target - this.progress) < 1e-5) this.progress = this.target;
      const v = dt > 0 ? (this.progress - prev) / dt : 0;
      this.velocity += (v - this.velocity) * (1 - Math.exp(-dt * 8));
      this.pointerSmooth.lerp(this.pointer, 1 - Math.exp(-dt * 3));
      this.update(this.progress);
      this.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Scroll target; the render loop eases toward it. */
  setProgress(p: number) {
    this.target = clamp01(p);
  }

  /** Current eased progress, for the HTML overlay to follow. */
  getProgress() {
    return this.progress;
  }

  /** What the sound layer listens to: scroll speed (progress per second) and pour flow. */
  getMotion() {
    return { velocity: this.velocity, flow: this.flow };
  }

  setPointer(x: number, y: number) {
    this.pointer.set(x, y);
  }

  /** Deterministic render for video capture: exact progress and time, no easing. */
  renderFrame(p: number, t: number) {
    this.progress = this.target = clamp01(p);
    this.time = t;
    this.update(this.progress);
    this.render();
  }

  /**
   * Swap in the photographed assets once they arrive: an HDR studio for reflections and
   * scanned wood for the table. Everything works without them.
   */
  async loadAssets(base = "/assets") {
    const tex = new THREE.TextureLoader();
    const [hdr, wood, nor, rough] = await Promise.allSettled([
      new HDRLoader().setDataType(THREE.HalfFloatType).loadAsync(`${base}/hdri/studio_1k.hdr`),
      tex.loadAsync(`${base}/wood/dark_wood_diff_2k.jpg`),
      tex.loadAsync(`${base}/wood/dark_wood_nor_gl_1k.jpg`),
      tex.loadAsync(`${base}/wood/dark_wood_rough_1k.jpg`),
    ]);
    if (hdr.status === "fulfilled") {
      const env = hdr.value;
      env.minFilter = THREE.LinearMipmapLinearFilter;
      env.magFilter = THREE.LinearFilter;
      env.generateMipmaps = true;
      env.wrapS = THREE.RepeatWrapping;
      env.needsUpdate = true;
      this.shared.uEnv.value = env;
      this.shared.uEnvOn.value = 1;
      env.mapping = THREE.EquirectangularReflectionMapping;
      const pm = this.pmrem.fromEquirectangular(env);
      this.scene.environment = pm.texture;
      this.scene.environmentIntensity = 0.4;
      this.scene.environmentRotation.y = -this.shared.uEnvYaw.value;
      this.disposables.push(env, pm);
    }
    if (wood.status === "fulfilled" && nor.status === "fulfilled" && rough.status === "fulfilled") {
      const aniso = this.renderer.capabilities.getMaxAnisotropy();
      wood.value.colorSpace = THREE.SRGBColorSpace;
      for (const t of [wood.value, nor.value, rough.value]) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = aniso;
        t.needsUpdate = true;
        this.disposables.push(t);
      }
      const u = (this.table.material as THREE.ShaderMaterial).uniforms;
      u.uWood.value = wood.value;
      u.uWoodNor.value = nor.value;
      u.uWoodRough.value = rough.value;
      u.uWoodOn.value = 1;
    }
  }

  /**
   * Scans the whole physics run for anything outside the glass: how far (scene units) the worst
   * probe point of any ingredient pokes past the inner wall or under the inner floor.
   */
  containmentReport() {
    const { frames, pos, quat } = this.sim;
    const n = this.leafList.length;
    const q = new THREE.Quaternion();
    const a = new THREE.Vector3();
    const e = new THREE.Vector3();
    const c = new THREE.Vector3();
    let worst = 0;
    let bad = 0;
    for (let f = 0; f < frames; f += 2) {
      const tSim = f / this.sim.fps;
      for (let i = 0; i < n; i++) {
        const L = this.leafList[i];
        if (tSim < L.release) continue;
        c.fromArray(pos, (f * n + i) * 3);
        if (c.y > 1.8) continue; // still falling toward the pot
        q.fromArray(quat, (f * n + i) * 4);
        const half = L.size * 0.5 * GROWTH;
        let over = 0;
        for (const [ax, ext] of [[0, 1], [1, 0.5], [2, 0.5]]) {
          for (const sgn of [-1, 1]) {
            a.set(ax === 0 ? 1 : 0, ax === 1 ? 1 : 0, ax === 2 ? 1 : 0).applyQuaternion(q);
            e.copy(c).addScaledVector(a, half * ext * sgn);
            const R = radiusAt(POT_INNER, Math.min(1.8, Math.max(0.13, e.y)));
            over = Math.max(over, Math.hypot(e.x, e.z) - R, 0.13 - e.y);
          }
        }
        if (over > 0.005) bad++;
        worst = Math.max(worst, over);
      }
    }
    return { worst, bad };
  }

  resize() {
    const w = this.renderer.domElement.clientWidth || window.innerWidth;
    const h = this.renderer.domElement.clientHeight || window.innerHeight;
    this.narrow = w / h < 0.9;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.shared.uRes.value.copy(buf);
    this.sceneRT.setSize(Math.ceil(buf.x / 2), Math.ceil(buf.y / 2));
    this.camera.aspect = w / h;
    this.camera.fov = this.narrow ? 48 : 32;
    this.camera.updateProjectionMatrix();
  }

  private render() {
    // 1. Opaque scene only, into the refraction buffer.
    for (const o of this.seeThrough) o.userData.wasVisible = o.visible;
    for (const o of this.seeThrough) o.visible = false;
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    for (const o of this.seeThrough) o.visible = o.userData.wasVisible;
    // 2. Full scene with glass, tea and post-processing.
    this.composer.render();
  }

  private cameraAt(p: number) {
    const n = this.camPath.points.length;
    let i = 0;
    while (i < n - 2 && p > teaCenter(i + 1)) i++;
    const a = teaCenter(i);
    const b = teaCenter(i + 1);
    const local = clamp01((p - a) / (b - a));
    // Mostly linear so the camera keeps moving; a little ease lingers on each headline.
    const eased = THREE.MathUtils.lerp(local, local * local * (3 - 2 * local), 0.4);
    const u = (i + eased) / (n - 1);
    const pos = this.camPath.getPoint(u);
    const target = this.camAim.getPoint(u);
    if (this.narrow) {
      // Phones: centre everything and pull back; copy sits above.
      pos.x *= 0.15;
      target.x *= 0.15;
      pos.z += 4.5;
      pos.y += 0.4;
      target.y += 1.5;
    }
    pos.x += this.pointerSmooth.x * 0.35 + Math.sin(this.time * 0.25) * 0.08;
    pos.y += this.pointerSmooth.y * 0.2 + Math.sin(this.time * 0.31) * 0.05;
    return { pos, target };
  }

  private update(p: number) {
    const t = this.time;
    const ph = phases(p);

    const cam = this.cameraAt(p);
    this.camera.position.copy(cam.pos);
    this.camera.lookAt(cam.target);
    this.camera.updateMatrixWorld();

    // Pot: lifts to the upper right and tips to pour.
    const pot = potState(p);
    const lift = pot.lift;
    const tilt = pot.tip;
    this.pot.position.set(0, 0, 0).lerp(POUR_POS, lift);
    this.pot.position.y += Math.sin(t * 0.8) * 0.015 * lift;
    // No wobble on the tilt: the leaves are simulated against this exact angle.
    this.pot.rotation.z = pot.angle;
    this.pot.updateMatrixWorld();

    // Pot liquid: level falls a little while pouring. The surface stays level in world space.
    const pl = this.potLiquid.uniforms;
    const localLevel = pot.localLevel;
    pl.uLevel.value = this.pot.position.y + pot.levelAbove;
    pl.uBottom.value = this.pot.position.y;
    pl.uBrew.value = ph.brew;
    pl.uTime.value = t;
    pl.uWave.value = Math.sin(ph.stir * Math.PI) * 0.3 + tilt * 0.2;

    // Pot surface: centred where the pot's axis crosses the water level, ripples where
    // ingredients landed, churning while it boils.
    const boil = smoothstep(0.44, 0.52, p) * (1 - smoothstep(0.64, 0.72, p));
    const rz = this.pot.rotation.z;
    const axisT = (pl.uLevel.value - this.pot.position.y) / Math.cos(rz);
    this.potSurface.position.set(this.pot.position.x - Math.sin(rz) * axisT, pl.uLevel.value, this.pot.position.z);
    this.potSurface.scale.setScalar(3.4);
    const ps = (this.potSurface.material as THREE.ShaderMaterial).uniforms;
    ps.uTime.value = t;
    ps.uBoil.value = boil;
    ps.uSwirl.value = range(p, 0.4, 0.62) * 5 + t * 0.15 * boil;
    ps.uBrew.value = ph.brew;
    ps.uDepth.value = Math.max(0.1, pl.uLevel.value - this.pot.position.y - 0.13);
    ps.uVesselInv.value.copy(this.pot.matrixWorld).invert();
    {
      const simNow = simTime(p);
      const e = this.sim.entry;
      const list: [number, number, number, number][] = [];
      for (let i = 0; i < this.leafList.length; i++) {
        const age = simNow - e[i * 3];
        if (e[i * 3] >= 0 && age > 0 && age < 3) list.push([e[i * 3 + 1], e[i * 3 + 2], age, Math.min(0.035, 0.01 + this.leafList[i].size * 0.05)]);
      }
      list.sort((a, b) => a[2] - b[2]);
      const rip = ps.uRipples.value as THREE.Vector4[];
      const n = Math.min(MAX_RIPPLES, list.length);
      for (let i = 0; i < n; i++) rip[i].set(list[i][0] + this.pot.position.x, list[i][1] + this.pot.position.z, list[i][2], list[i][3]);
      ps.uRippleCount.value = n;
    }

    // Bubbles: born on the hot glass floor, growing as they rise, bursting at the surface.
    const bubblesOn = boil * (1 - tilt);
    for (let i = 0; i < this.bubbleSeeds.length; i++) {
      const s = this.bubbleSeeds[i];
      if (s[0] > bubblesOn) {
        this.dummy.scale.setScalar(0);
      } else {
        const period = 1.1 + s[1] * 1.6;
        const phase = (t / period + s[2]) % 1;
        const y = 0.16 + phase * (localLevel - 0.2);
        const rad = Math.sqrt(s[3]) * radiusAt(POT_INNER, y) * 0.85;
        const ang = s[4] * Math.PI * 2 + phase * 1.2;
        this.dummy.position.set(Math.cos(ang) * rad + Math.sin(t * 7 + i) * 0.012, y, Math.sin(ang) * rad);
        this.dummy.scale.setScalar((0.012 + 0.03 * phase * (0.5 + s[1])) * (1 - smoothstep(0.9, 1, phase)));
      }
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.bubbles.setMatrixAt(i, this.dummy.matrix);
    }
    this.bubbles.instanceMatrix.needsUpdate = true;

    // Lid: lifted off onto the table behind the pot, then put back before the close-up.
    const lidOff = smoothstep(0.165, 0.225, p) * (1 - smoothstep(0.545, 0.61, p));
    this.lid.position.copy(LID_REST).multiplyScalar(lidOff);
    this.lid.position.y += Math.sin(Math.PI * lidOff) * 0.9;
    this.lid.rotation.set(Math.sin(Math.PI * lidOff) * 0.35, 0, -Math.sin(Math.PI * lidOff) * 0.2);

    // Pouch drops in, tips over and pours, then leaves.
    pouchPose(p, t, this.pouch);
    this.pouch.visible = ph.pouch > 0 && ph.pouchOut < 1;

    // Leaves: play back the physics run at this point of the scroll.
    const simT = simTime(p);
    const sim = this.sim;
    const fr = clamp01(simT / SIM_SECONDS) * (sim.frames - 1);
    const f0 = Math.floor(fr);
    const f1 = Math.min(sim.frames - 1, f0 + 1);
    const k = fr - f0;
    const n = this.leafList.length;
    const qa = new THREE.Quaternion();
    const qb = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const L = this.leafList[i];
      const mesh = this.leafMeshes[L.kind];
      const age = simT - L.release;
      if (age <= 0) {
        this.dummy.scale.setScalar(0);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(L.index, this.dummy.matrix);
        continue;
      }
      const a3 = (f0 * n + i) * 3;
      const b3 = (f1 * n + i) * 3;
      this.dummy.position.set(
        THREE.MathUtils.lerp(sim.pos[a3], sim.pos[b3], k),
        THREE.MathUtils.lerp(sim.pos[a3 + 1], sim.pos[b3 + 1], k),
        THREE.MathUtils.lerp(sim.pos[a3 + 2], sim.pos[b3 + 2], k),
      );
      qa.fromArray(sim.quat, (f0 * n + i) * 4);
      qb.fromArray(sim.quat, (f1 * n + i) * 4);
      this.dummy.quaternion.copy(qa).slerp(qb, k);
      // Gentle drift once the leaves are in the water (time based, so it lives on after the run).
      if (this.dummy.position.y < WATER_LEVEL) {
        this.dummy.position.y += Math.sin(t * 1.1 + i * 1.7) * 0.004;
      }
      // Leaves unfurl a little as they steep.
      const unfurl = L.kind === 2 ? 1 : 1 + ph.brew * (GROWTH - 1);
      this.dummy.scale.setScalar(L.size * unfurl * THREE.MathUtils.lerp(0.6, 1, clamp01(age / 0.12)));
      this.dummy.updateMatrix();
      mesh.setMatrixAt(L.index, this.dummy.matrix);
    }
    for (const m of this.leafMeshes) m.instanceMatrix.needsUpdate = true;
    this.leafSet.lightView.value.set(4, 6, -5).normalize().transformDirection(this.camera.matrixWorldInverse);

    // Cup slides in from the left.
    const cupIn = ph.cup;
    this.cup.position.set(CUP_POS.x - (1 - cupIn) * 5, CUP_POS.y, CUP_POS.z);
    this.cup.visible = cupIn > 0.001;
    this.mint.visible = cupIn > 0.001;
    this.mint.position.x = -(1 - cupIn) * 5;
    for (const m of this.cupGlass) (m.material as THREE.ShaderMaterial).uniforms.uOpacity.value = cupIn;
    // Tea only leaves the spout once the water inside reaches its tip.
    const tipY = SPOUT_TIP.clone().applyMatrix4(this.pot.matrixWorld).y;
    const flow = Math.min(pourFlow(p), smoothstep(-0.01, 0.08, pl.uLevel.value - tipY));
    this.flow = flow;
    const cl = this.cupLiquid.uniforms;
    const fill = smoothstep(0.55, 1, ph.pour) * 0.95 + ph.calm * 0.05;
    const cupBottom = this.cup.position.y + 0.24 * CUP_SCALE;
    cl.uLevel.value = cupBottom + fill * 0.72 * CUP_SCALE;
    cl.uBottom.value = cupBottom;
    cl.uBrew.value = 1;
    cl.uTime.value = t;
    cl.uWave.value = flow * 0.3;
    cl.uOpacity.value = fill > 0.01 ? 1 : 0;

    // Cup surface: rings spreading from where the stream lands, stirred up by the pour.
    this.cup.updateMatrixWorld();
    this.cupSurface.visible = fill > 0.01 && cupIn > 0.5;
    this.cupSurface.position.set(this.cup.position.x, cl.uLevel.value, this.cup.position.z);
    this.cupSurface.scale.setScalar(2.2 * CUP_SCALE);
    const cs = (this.cupSurface.material as THREE.ShaderMaterial).uniforms;
    cs.uTime.value = t;
    cs.uBoil.value = flow * 0.18;
    cs.uSwirl.value = t * 0.3;
    cs.uBrew.value = 1;
    cs.uDepth.value = Math.max(0.05, cl.uLevel.value - cupBottom);
    cs.uVesselInv.value.copy(this.cup.matrixWorld).invert();
    {
      const rip = cs.uRipples.value as THREE.Vector4[];
      // Gentle rings spreading from where the stream lands.
      const n = flow > 0.01 ? 12 : 0;
      for (let k = 0; k < n; k++) rip[k].set(this.cup.position.x + 0.05, this.cup.position.z, (t % 0.2) + k * 0.2, 0.0045 * flow);
      cs.uRippleCount.value = n;
    }
    // Foam: small bubbles drifting outward from the pour.
    for (let i = 0; i < 48; i++) {
      const s = this.bubbleSeeds[i];
      const phase = (t * (0.35 + s[0] * 0.3) + s[2]) % 1;
      const rr = (0.04 + phase * 0.5) * CUP_SCALE * 0.7;
      const ang = s[4] * Math.PI * 2 + phase * 0.8;
      this.dummy.position.set(this.cup.position.x + 0.05 + Math.cos(ang) * rr, cl.uLevel.value + 0.004, this.cup.position.z + Math.sin(ang) * rr);
      this.dummy.scale.setScalar(flow > 0.01 && cupIn > 0.5 ? (0.008 + 0.018 * s[1]) * (1 - phase) * (0.4 + 0.6 * flow) : 0);
      this.dummy.updateMatrix();
      this.foam.setMatrixAt(i, this.dummy.matrix);
    }
    this.foam.instanceMatrix.needsUpdate = true;

    // Pour stream from the spout into the cup: thicker at the spout, wobbling as it falls.
    this.streamUniforms.uTime.value = t;
    // The first trickle races down to the cup almost at once; after that the stream only thickens.
    this.streamUniforms.uFlow.value = Math.min(1, flow * 6);
    this.stream.visible = flow > 0.001;
    if (this.stream.visible) {
      const tip3 = SPOUT_TIP.clone().applyMatrix4(this.pot.matrixWorld);
      const end = new THREE.Vector3(this.cup.position.x + 0.05, cl.uLevel.value, this.cup.position.z);
      // Tea leaves the spout moving along it, then gravity bends it down: a short arc.
      const out = new THREE.Vector3(-1, -0.25, 0).applyQuaternion(this.pot.quaternion).normalize();
      const mid = tip3.clone().addScaledVector(out, 0.35);
      mid.y = Math.min(mid.y, tip3.y);
      mid.x += Math.sin(t * 3.1) * 0.01;
      const curve = new THREE.QuadraticBezierCurve3(tip3, mid, end);
      this.stream.geometry.dispose();
      // Thick at the spout, thinning as it falls, with a ripple running down it.
      this.stream.geometry = taperedTube(
        curve,
        (u) => (0.062 - 0.026 * u) * (0.35 + 0.65 * Math.sqrt(flow)) * (1 + 0.14 * Math.sin(u * 26 - t * 24) + 0.06 * Math.sin(u * 61 - t * 37)),
        0,
        64,
      );
    }

    // Steam.
    const potSteam = ph.brew * (1 - smoothstep(0.7, 1, ph.pour));
    this.steam.forEach((s, i) => {
      s.position.set(this.pot.position.x + (i - 0.5) * 0.3, this.pot.position.y + 2.15, this.pot.position.z);
      s.quaternion.copy(this.camera.quaternion);
      const u = (s.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = t;
      u.uAmount.value = potSteam * (i ? 0.8 : 1);
    });
    this.cupSteam.forEach((s, i) => {
      s.position.set(this.cup.position.x + (i - 0.5) * 0.35, this.cup.position.y + 1.1, this.cup.position.z);
      s.scale.setScalar(0.8);
      s.quaternion.copy(this.camera.quaternion);
      const u = (s.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = t;
      u.uAmount.value = smoothstep(0.6, 1, ph.pour) * 1.3 * (i ? 0.7 : 1);
    });

    // Environment.
    const back = this.backdrop.material as THREE.ShaderMaterial;
    back.uniforms.uTime.value = t;
    back.uniforms.uWarm.value = ph.brew;
    const table = this.table.material as THREE.ShaderMaterial;
    table.uniforms.uBrew.value = ph.brew;
    table.uniforms.uPool.value.set(this.pot.position.x * (1 - lift), 0, 0);
    table.uniforms.uPotAmt.value = 1 - lift;
    table.uniforms.uCupAmt.value = fill * cupIn;
    const dust = this.dust.material as THREE.ShaderMaterial;
    dust.uniforms.uTime.value = t;
    dust.uniforms.uOpacity.value = 0.35 + ph.brew * 0.3 + ph.calm * 0.35;
    this.vignette.uniforms.uTime.value = t % 10;
    this.bloom.strength = 0.3 + ph.brew * 0.15;
  }

  dispose() {
    this.stop();
    this.stream.geometry.dispose();
    for (const d of this.disposables) d.dispose();
    (this.backdrop.material as THREE.Material).dispose();
    this.backdrop.geometry.dispose();
    (this.table.material as THREE.Material).dispose();
    this.table.geometry.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.ShaderMaterial) o.material.dispose();
    });
    this.pmrem.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
