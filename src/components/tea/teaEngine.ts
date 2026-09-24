import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { clamp01, phases, pourFlow, range, smoothstep, teaCenter } from "@/lib/teaTimeline";
import { buildLeafSet, type LeafSet } from "./leafModels";
import { simulateLeaves, type LeafKind, type Mouth, type SimResult } from "./leafPhysics";
import {
  backdropShader,
  dustShader,
  glassShader,
  liquidShader,
  steamShader,
  streamShader,
  tableShader,
  vignetteShader,
} from "./shaders";

type Options = { canvas: HTMLCanvasElement; lite?: boolean };

/** Uniforms every refracting material shares: the opaque scene and the buffer size. */
type Shared = { uScene: { value: THREE.Texture }; uRes: { value: THREE.Vector2 } };

// ---------------------------------------------------------------- profiles
// Lathe profiles as [radius, height]. The spout sits on -x, the handle on +x.
const POT_BODY: [number, number][] = [
  [0, 0.02], [0.5, 0.0], [0.8, 0.05], [1.05, 0.24], [1.2, 0.55], [1.25, 0.9],
  [1.17, 1.25], [0.98, 1.54], [0.8, 1.7], [0.8, 1.78],
];
const POT_LID: [number, number][] = [
  [0.84, 1.77], [0.83, 1.82], [0.7, 1.93], [0.42, 2.02], [0.14, 2.06], [0.08, 2.12], [0, 2.13],
];
const CUP: [number, number][] = [
  [0, 0.0], [0.55, 0.0], [0.64, 0.12], [0.7, 0.45], [0.77, 0.9], [0.8, 1.06], [0.74, 1.07],
  [0.7, 0.92], [0.63, 0.5], [0.5, 0.27], [0, 0.22],
];
const CUP_INNER: [number, number][] = [
  [0, 0.23], [0.49, 0.28], [0.61, 0.5], [0.68, 0.92], [0.7, 1.02],
];
const GLASS_WALL = 0.045;

const SPOUT_TIP = new THREE.Vector3(-2.02, 1.62, 0);
const POUR_POS = new THREE.Vector3(2.6, 2.2, 0.35);
const CUP_POS = new THREE.Vector3(0, 0, 0.35);
const CUP_SCALE = 1.3;

// Leaf physics runs over this slice of the scroll, as SIM_SECONDS of simulated time.
const SIM_P0 = 0.2;
const SIM_P1 = 0.68;
const SIM_SECONDS = 8;
const simTime = (p: number) => ((p - SIM_P0) / (SIM_P1 - SIM_P0)) * SIM_SECONDS;
const simProgress = (t: number) => SIM_P0 + (t / SIM_SECONDS) * (SIM_P1 - SIM_P0);
const WATER_LEVEL = 0.95;
const POUCH_MOUTH = new THREE.Vector3(0, 0.76, 0);
// Where the lid rests on the table while the leaves go in (pot space).
const LID_REST = new THREE.Vector3(3.1, -1.72, -0.6);

function lathe(profile: [number, number][], scale = 1, segs = 144) {
  // A Catmull-Rom pass through the profile keeps the silhouette free of facets.
  const spline = new THREE.SplineCurve(profile.map(([r, y]) => new THREE.Vector2(r * scale, y)));
  const g = new THREE.LatheGeometry(spline.getPoints(profile.length * 14), segs);
  g.computeVertexNormals();
  return g;
}

/** Tube whose radius eases from r0 to r1 along the curve. */
function taperedTube(curve: THREE.Curve<THREE.Vector3>, r0: number, r1: number, segs = 128) {
  const radial = 32;
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const c = curve.getPointAt(t);
    const r = THREE.MathUtils.lerp(r0, r1, t * t * (3 - 2 * t));
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
  for (let i = 1; i < profile.length; i++) {
    const [r0, y0] = profile[i - 1];
    const [r1, y1] = profile[i];
    if (y >= Math.min(y0, y1) && y <= Math.max(y0, y1) && y1 !== y0) {
      return r0 + ((y - y0) / (y1 - y0)) * (r1 - r0);
    }
  }
  return profile[profile.length - 1][0];
}

function glassPair(
  geo: THREE.BufferGeometry,
  shared: Shared,
  { glow = new THREE.Color(0.12, 0.07, 0.025), refract = 0.05, opacity = 1 } = {},
) {
  const make = (side: THREE.Side, order: number) => {
    const m = new THREE.ShaderMaterial({
      ...glassShader,
      uniforms: {
        ...shared,
        uOpacity: { value: opacity },
        uRefract: { value: refract },
        uGlow: { value: glow },
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

type LeafInstance = { kind: LeafKind; index: number; size: number; release: number };

/** Pouch pose over the scroll. `t` only adds a gentle hover and shake on the live site. */
function pouchPose(p: number, t: number, o: THREE.Object3D) {
  const ph = phases(p);
  const drop = smoothstep(0, 0.55, ph.pouch);
  const tip = smoothstep(0.4, 1, ph.pouch);
  const pouring = tip * (1 - smoothstep(0.3, 0.42, p));
  const away = smoothstep(0, 1, ph.pouchOut);
  o.position.set(
    THREE.MathUtils.lerp(0.4, 0.2, tip),
    THREE.MathUtils.lerp(8.5, 3.45, drop) + away * 6 + Math.sin(t * 1.1) * 0.03 * (t > 0 ? 1 : 0),
    0.1,
  );
  // A small shake while leaves spill out.
  const shake = Math.sin(p * 900) * 0.035 * pouring;
  o.rotation.set(0.1, -0.35 + tip * 0.2, tip * 2.55 + shake);
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
    this.shared = { uScene: { value: this.sceneRT.texture }, uRes: { value: new THREE.Vector2(1, 1) } };
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
      },
    });
    this.table = new THREE.Mesh(new THREE.PlaneGeometry(40, 24), tableMat);
    this.table.rotation.x = -Math.PI / 2;
    this.table.position.z = -2;
    this.scene.add(this.table);

    // Teapot: outer and inner walls give the glass real thickness; rounded lips close them.
    const innerProfile = POT_BODY.map(([r, y]): [number, number] => [Math.max(0, r - GLASS_WALL), y + (y < 0.1 ? 0.05 : 0)]);
    const spoutCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-1.02, 0.42, 0),
      new THREE.Vector3(-1.45, 0.78, 0),
      new THREE.Vector3(-1.78, 1.28, 0),
      SPOUT_TIP.clone(),
    ]);
    const spoutLip = new THREE.TorusGeometry(0.075, 0.02, 16, 64);
    spoutLip.applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), spoutCurve.getTangentAt(1)),
    );
    spoutLip.translate(SPOUT_TIP.x, SPOUT_TIP.y, SPOUT_TIP.z);
    const handleCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(1.0, 1.42, 0),
      new THREE.Vector3(1.6, 1.52, 0),
      new THREE.Vector3(1.88, 1.1, 0),
      new THREE.Vector3(1.64, 0.55, 0),
      new THREE.Vector3(1.14, 0.38, 0),
    ]);
    const handleEnds = [handleCurve.getPointAt(0), handleCurve.getPointAt(1)].map((p) => {
      const s = new THREE.SphereGeometry(0.095, 32, 20);
      s.translate(p.x, p.y, p.z);
      return s;
    });
    const knob = new THREE.SphereGeometry(0.11, 40, 24);
    knob.translate(0, 2.2, 0);
    const potParts: [THREE.BufferGeometry, { refract?: number; opacity?: number }][] = [
      [lathe(POT_BODY), {}],
      [lathe(innerProfile), { refract: 0.03, opacity: 0.6 }],
      [rim(0.8 - GLASS_WALL / 2, GLASS_WALL / 2 + 0.008, 1.78), {}],
      [rim(0.6, 0.035, 0.035), {}],
      [taperedTube(spoutCurve, 0.2, 0.075), {}],
      [spoutLip, {}],
      [new THREE.TubeGeometry(handleCurve, 128, 0.085, 24, false), {}],
      ...handleEnds.map((g): [THREE.BufferGeometry, object] => [g, {}]),
    ];
    for (const [g, opts] of potParts) {
      this.pot.add(...glassPair(g, this.shared, opts));
      this.disposables.push(g);
    }
    // The lid is its own group so it can be lifted off while the leaves go in.
    for (const g of [lathe(POT_LID), rim(0.835, 0.025, 1.77), knob]) {
      this.lid.add(...glassPair(g, this.shared));
      this.disposables.push(g);
    }
    this.pot.add(this.lid);
    const potLiquidGeo = lathe(innerProfile.slice(0, 8), 0.99);
    this.potLiquid = liquidPair(potLiquidGeo, this.shared, 1.2);
    this.pot.add(...this.potLiquid.meshes);
    this.disposables.push(potLiquidGeo);
    this.scene.add(this.pot);

    // Leaves: rolled loose tea, whole leaves, marigold petals and mint.
    this.leafSet = buildLeafSet();
    const counts = lite ? [80, 26, 20, 12] : [150, 50, 36, 24];
    const sizeRange: [number, number][] = [
      [0.13, 0.2],
      [0.22, 0.32],
      [0.12, 0.18],
      [0.2, 0.3],
    ];
    const rand = rng(7);
    const col = new THREE.Color();
    counts.forEach((count, kind) => {
      const mesh = new THREE.InstancedMesh(this.leafSet.geometries[kind], this.leafSet.materials[kind], count);
      mesh.frustumCulled = false;
      for (let i = 0; i < count; i++) {
        const shade = 0.75 + rand() * 0.5;
        col.setRGB(shade * (0.95 + rand() * 0.1), shade, shade * (0.9 + rand() * 0.1));
        mesh.setColorAt(i, col);
        const [a, b] = sizeRange[kind];
        // Most leaves tumble out early, like a real pour; a few stragglers follow.
        const release = simTime(0.232 + 0.13 * Math.pow(rand(), 1.4));
        this.leafList.push({ kind: kind as LeafKind, index: i, size: a + rand() * (b - a), release });
      }
      this.leafMeshes.push(mesh);
      this.pot.add(mesh);
    });
    this.disposables.push(...this.leafSet.geometries, ...this.leafSet.materials, ...this.leafSet.textures);

    // Run the physics once; playback follows the scroll.
    const pose = new THREE.Object3D();
    this.sim = simulateLeaves({
      kinds: this.leafList.map((l) => l.kind),
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
      level: WATER_LEVEL,
      floorY: 0.07,
      rimY: 1.78,
      wallRadius: (y: number) => radiusAt(POT_BODY, Math.min(1.78, Math.max(0, y))) - GLASS_WALL,
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
    this.mint = new THREE.InstancedMesh(this.leafSet.geometries[3], this.leafSet.mintMaterial, 9);
    const mr = rng(3);
    for (let i = 0; i < 9; i++) {
      this.dummy.position.set(-2.1 + mr() * 0.8 + (i > 4 ? 3.4 : 0), 0.07 + mr() * 0.05, 0.9 + mr() * 0.8);
      this.dummy.rotation.set(-Math.PI / 2 + (mr() - 0.5) * 0.4, mr() * 0.3, mr() * Math.PI * 2);
      this.dummy.scale.setScalar(0.45 + mr() * 0.25);
      this.dummy.updateMatrix();
      this.mint.setMatrixAt(i, this.dummy.matrix);
    }
    this.scene.add(this.mint);
    this.disposables.push(this.leafSet.mintMaterial);

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
    const lift = smoothstep(0, 0.4, ph.pour);
    const tilt = smoothstep(0.25, 0.6, ph.pour);
    this.pot.position.set(0, 0, 0).lerp(POUR_POS, lift);
    this.pot.position.y += Math.sin(t * 0.8) * 0.015 * lift;
    this.pot.rotation.z = tilt * 0.72 + Math.sin(t * 0.7) * 0.01 * tilt;
    this.pot.updateMatrixWorld();

    // Pot liquid: level falls a little while pouring. The surface stays level in world space.
    const pl = this.potLiquid.uniforms;
    const localLevel = WATER_LEVEL - tilt * 0.12 - ph.calm * 0.05;
    pl.uLevel.value = this.pot.position.y + localLevel - tilt * 0.35;
    pl.uBottom.value = this.pot.position.y;
    pl.uBrew.value = ph.brew;
    pl.uTime.value = t;
    pl.uWave.value = Math.sin(ph.stir * Math.PI) * 1.5 + tilt;

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
        this.dummy.position.y += Math.sin(t * 1.1 + i * 1.7) * 0.006;
        this.dummy.position.x += Math.sin(t * 0.7 + i) * 0.004;
      }
      // Leaves unfurl a little as they steep.
      const unfurl = L.kind === 2 ? 1 : 1 + ph.brew * 0.25;
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
    const flow = pourFlow(p);
    this.flow = flow;
    const cl = this.cupLiquid.uniforms;
    const fill = smoothstep(0.55, 1, ph.pour) * 0.95 + ph.calm * 0.05;
    const cupBottom = this.cup.position.y + 0.24 * CUP_SCALE;
    cl.uLevel.value = cupBottom + fill * 0.72 * CUP_SCALE;
    cl.uBottom.value = cupBottom;
    cl.uBrew.value = 1;
    cl.uTime.value = t;
    cl.uWave.value = flow * 2.5;
    cl.uOpacity.value = fill > 0.01 ? 1 : 0;

    // Pour stream from the spout into the cup: thicker at the spout, wobbling as it falls.
    this.streamUniforms.uTime.value = t;
    this.streamUniforms.uFlow.value = flow;
    this.stream.visible = flow > 0.001;
    if (this.stream.visible) {
      const tip3 = SPOUT_TIP.clone().applyMatrix4(this.pot.matrixWorld);
      const end = new THREE.Vector3(this.cup.position.x + 0.05, cl.uLevel.value, this.cup.position.z);
      const mid = tip3.clone().lerp(end, 0.5);
      mid.x = tip3.x + (end.x - tip3.x) * 0.25 + Math.sin(t * 3.1) * 0.01;
      const curve = new THREE.QuadraticBezierCurve3(tip3, mid, end);
      this.stream.geometry.dispose();
      this.stream.geometry = taperedTube(curve, 0.06, 0.036 + Math.sin(t * 17) * 0.003, 48);
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
