import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { clamp01, phases, smoothstep, teaCenter } from "@/lib/teaTimeline";
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

const SPOUT_TIP = new THREE.Vector3(-2.02, 1.62, 0);
const POUR_POS = new THREE.Vector3(2.6, 2.2, 0.35);
const CUP_POS = new THREE.Vector3(0, 0, 0.35);
const CUP_SCALE = 1.3;

function lathe(profile: [number, number][], scale = 1, segs = 64) {
  // Smooth the profile so the silhouette has no facets.
  const spline = new THREE.SplineCurve(profile.map(([r, y]) => new THREE.Vector2(r * scale, y)));
  const g = new THREE.LatheGeometry(spline.getPoints(profile.length * 6), segs);
  g.computeVertexNormals();
  return g;
}

/** Tube whose radius tapers along the curve. */
function taperedTube(curve: THREE.Curve<THREE.Vector3>, r0: number, r1: number, segs = 48) {
  const radial = 20;
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const c = curve.getPointAt(t);
    const r = THREE.MathUtils.lerp(r0, r1, t);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(r).add(c);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
  }
  g.computeVertexNormals();
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

function glassPair(geo: THREE.BufferGeometry, glow = new THREE.Color(0.12, 0.07, 0.025)) {
  const make = (side: THREE.Side, order: number) => {
    const m = new THREE.ShaderMaterial({
      ...glassShader,
      uniforms: { uOpacity: { value: 1 }, uGlow: { value: glow } },
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

function liquidPair(geo: THREE.BufferGeometry) {
  const uniforms = {
    uLevel: { value: 1 },
    uBottom: { value: 0 },
    uBrew: { value: 0 },
    uTime: { value: 0 },
    uWave: { value: 0 },
    uOpacity: { value: 1 },
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

function leafGeometry() {
  const g = new THREE.PlaneGeometry(1, 0.46, 6, 3);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const w = Math.sqrt(Math.max(0, 1 - (2 * x) ** 2));
    p.setXYZ(i, x, y * w, x * x * 0.35 + Math.abs(y) * 0.25);
  }
  g.computeVertexNormals();
  return g;
}

function pouchTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 360;
  const x = c.getContext("2d")!;
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
  x.lineWidth = 2;
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
  for (let i = 0; i < 256; i += 8) x.fillRect(i, 8, 3, 28);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function pouchGeometry() {
  const g = new THREE.BoxGeometry(1.1, 1.55, 0.36, 12, 16, 4);
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

type Leaf = { a: number; r: number; h: number; float: boolean; delay: number; spin: number; size: number; s: number[] };

type CamKey = { pos: THREE.Vector3; target: THREE.Vector3 };

export class TeaEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private vignette: ShaderPass;
  private pmrem: THREE.PMREMGenerator;
  private raf = 0;
  private running = false;
  private last = 0;
  private time = 0;
  private progress = 0;
  private target = 0;
  private pointer = new THREE.Vector2();
  private pointerSmooth = new THREE.Vector2();
  private narrow = false;
  private disposables: { dispose(): void }[] = [];

  private pot = new THREE.Group();
  private potLiquid: ReturnType<typeof liquidPair>;
  private cup = new THREE.Group();
  private cupLiquid: ReturnType<typeof liquidPair>;
  private cupGlass: THREE.Mesh[];
  private pouch: THREE.Mesh;
  private leaves: THREE.InstancedMesh;
  private leafData: Leaf[] = [];
  private mint: THREE.InstancedMesh;
  private stream: THREE.Mesh;
  private streamUniforms = { uTime: { value: 0 }, uFlow: { value: 0 } };
  private steam: THREE.Mesh[] = [];
  private cupSteam: THREE.Mesh[] = [];
  private dust: THREE.Points;
  private backdrop: THREE.Mesh;
  private table: THREE.Mesh;
  private camKeys: CamKey[];
  private dummy = new THREE.Object3D();
  private tmp = new THREE.Vector3();

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
      },
    });
    this.table = new THREE.Mesh(new THREE.PlaneGeometry(40, 24), tableMat);
    this.table.rotation.x = -Math.PI / 2;
    this.table.position.z = -2;
    this.scene.add(this.table);

    // Teapot.
    const bodyGeo = lathe(POT_BODY);
    const lidGeo = lathe(POT_LID);
    const knob = new THREE.SphereGeometry(0.11, 24, 16);
    knob.translate(0, 2.2, 0);
    const spoutCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-1.02, 0.42, 0),
      new THREE.Vector3(-1.45, 0.78, 0),
      new THREE.Vector3(-1.78, 1.28, 0),
      SPOUT_TIP.clone(),
    ]);
    const spoutGeo = taperedTube(spoutCurve, 0.2, 0.075);
    const handleCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(1.0, 1.42, 0),
      new THREE.Vector3(1.6, 1.52, 0),
      new THREE.Vector3(1.88, 1.1, 0),
      new THREE.Vector3(1.64, 0.55, 0),
      new THREE.Vector3(1.14, 0.38, 0),
    ]);
    const handleGeo = new THREE.TubeGeometry(handleCurve, 48, 0.085, 16, false);
    for (const g of [bodyGeo, lidGeo, knob, spoutGeo, handleGeo]) {
      this.pot.add(...glassPair(g));
      this.disposables.push(g);
    }
    const potLiquidGeo = lathe(POT_BODY.slice(0, 8), 0.94);
    this.potLiquid = liquidPair(potLiquidGeo);
    this.pot.add(...this.potLiquid.meshes);
    this.disposables.push(potLiquidGeo);
    this.scene.add(this.pot);

    // Leaves, petals and mint inside the pot.
    const count = lite ? 150 : 260;
    const leafGeo = leafGeometry();
    const leafMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    this.leaves = new THREE.InstancedMesh(leafGeo, leafMat, count);
    this.leaves.frustumCulled = false;
    const rand = rng(7);
    const palettes = [
      [0x3b3a14, 0x4d4418, 0x2d2a10, 0x5a4a1c], // rolled leaf
      [0xe0a21c, 0xf2b93b], // marigold petal
      [0x4f7a24, 0x6a9a31], // mint
    ];
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const t = rand();
      const kind = t < 0.68 ? 0 : t < 0.86 ? 1 : 2;
      const pal = palettes[kind];
      col.setHex(pal[Math.floor(rand() * pal.length)]);
      this.leaves.setColorAt(i, col);
      const float = rand() < 0.22;
      this.leafData.push({
        a: rand() * Math.PI * 2,
        r: Math.sqrt(rand()),
        h: float ? -1 : 0.1 + rand() * 0.35,
        float,
        delay: rand(),
        spin: (rand() - 0.5) * 12,
        size: (kind === 1 ? 0.1 : 0.15) + rand() * 0.09,
        s: [rand(), rand(), rand(), rand()],
      });
    }
    this.pot.add(this.leaves);
    this.disposables.push(leafGeo, leafMat);

    // Tea pouch.
    const pouchGeo = pouchGeometry();
    const tex = pouchTexture();
    const pouchMat = new THREE.MeshStandardMaterial({ map: tex, metalness: 0.75, roughness: 0.32 });
    this.pouch = new THREE.Mesh(pouchGeo, pouchMat);
    this.scene.add(this.pouch);
    this.disposables.push(pouchGeo, tex, pouchMat);

    // Double-walled cup.
    const cupGeo = lathe(CUP);
    this.cupGlass = glassPair(cupGeo, new THREE.Color(0.16, 0.09, 0.03));
    this.cup.add(...this.cupGlass);
    const cupLiquidGeo = lathe(CUP_INNER, 0.97);
    this.cupLiquid = liquidPair(cupLiquidGeo);
    this.cup.add(...this.cupLiquid.meshes);
    this.cup.position.copy(CUP_POS);
    this.cup.scale.setScalar(CUP_SCALE);
    this.scene.add(this.cup);
    this.disposables.push(cupGeo, cupLiquidGeo);

    // Mint sprigs on the table beside the cup.
    const mintMat = new THREE.MeshStandardMaterial({ color: 0x3f6d1f, roughness: 0.5, side: THREE.DoubleSide });
    this.mint = new THREE.InstancedMesh(leafGeo, mintMat, 7);
    const mr = rng(3);
    for (let i = 0; i < 7; i++) {
      this.dummy.position.set(-2.1 + mr() * 0.7 + (i > 3 ? 3.4 : 0), 0.04 + mr() * 0.08, 0.9 + mr() * 0.8);
      this.dummy.rotation.set(-Math.PI / 2 + (mr() - 0.5) * 0.6, mr() * 0.4, mr() * Math.PI * 2);
      this.dummy.scale.setScalar(0.45 + mr() * 0.25);
      this.dummy.updateMatrix();
      this.mint.setMatrixAt(i, this.dummy.matrix);
    }
    this.scene.add(this.mint);
    this.disposables.push(mintMat);

    // Pour stream (geometry rebuilt each frame while pouring).
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

    // Camera keyframes, one per section (see content/tea.ts for which side the copy sits).
    const k = (px: number, py: number, pz: number, tx: number, ty: number, tz: number): CamKey => ({
      pos: new THREE.Vector3(px, py, pz),
      target: new THREE.Vector3(tx, ty, tz),
    });
    this.camKeys = [
      k(0, 2.9, 10.2, 0, 2.45, 0), // hero: pot under the headline
      k(-0.9, 3.3, 10.2, 1.2, 2.45, 0), // unwrap: pouch above, copy right
      k(1.2, 2.9, 8.2, -1.2, 1.9, 0), // glass: copy left
      k(-0.6, 2.4, 6.6, 1.0, 1.15, 0), // stir: copy right
      k(0.6, 1.5, 5.6, -1.1, 1.0, 0), // gold: close, copy left
      k(-1.2, 2.7, 10.6, 2.3, 1.85, 0), // pour: copy right
      k(-2.2, 2.6, 9.8, -1.3, 1.95, 0.3), // calm: scene right, copy left: cup under the headline
    ];

    // Post-processing.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.55, 0.86);
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
      this.progress += (this.target - this.progress) * (1 - Math.exp(-dt * 6));
      this.pointerSmooth.lerp(this.pointer, 1 - Math.exp(-dt * 3));
      this.update(this.progress);
      this.composer.render();
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

  setPointer(x: number, y: number) {
    this.pointer.set(x, y);
  }

  /** Deterministic render for video capture: exact progress and time, no easing. */
  renderFrame(p: number, t: number) {
    this.progress = this.target = clamp01(p);
    this.time = t;
    this.update(this.progress);
    this.composer.render();
  }

  resize() {
    const w = this.renderer.domElement.clientWidth || window.innerWidth;
    const h = this.renderer.domElement.clientHeight || window.innerHeight;
    this.narrow = w / h < 0.9;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h;
    this.camera.fov = this.narrow ? 48 : 32;
    this.camera.updateProjectionMatrix();
  }

  private cameraAt(p: number) {
    const centers = this.camKeys.map((_, i) => teaCenter(i));
    let i = 0;
    while (i < centers.length - 2 && p > centers[i + 1]) i++;
    const t = smoothstep(centers[i], centers[i + 1], p);
    const a = this.camKeys[i];
    const b = this.camKeys[i + 1];
    const pos = a.pos.clone().lerp(b.pos, t);
    const target = a.target.clone().lerp(b.target, t);
    if (this.narrow) {
      // Phones: centre everything and pull back; copy sits above and below.
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

    // Pot: lifts to the upper right and tips to pour.
    const lift = smoothstep(0, 0.4, ph.pour);
    const tilt = smoothstep(0.25, 0.6, ph.pour);
    this.pot.position.set(0, 0, 0).lerp(POUR_POS, lift);
    this.pot.position.y += Math.sin(t * 0.8) * 0.015 * lift;
    this.pot.rotation.z = tilt * 0.72 + Math.sin(t * 0.7) * 0.01 * tilt;
    this.pot.updateMatrixWorld();

    // Pot liquid: level falls a little while pouring. The surface stays level in world space.
    const pl = this.potLiquid.uniforms;
    const localLevel = 0.95 - tilt * 0.12 - ph.calm * 0.05;
    pl.uLevel.value = this.pot.position.y + localLevel - tilt * 0.35;
    pl.uBottom.value = this.pot.position.y;
    pl.uBrew.value = ph.brew;
    pl.uTime.value = t;
    pl.uWave.value = Math.sin(ph.stir * Math.PI) * 1.5 + tilt;

    // Pouch drops in, tips over, then leaves.
    const drop = smoothstep(0, 0.55, ph.pouch);
    const tip = smoothstep(0.4, 1, ph.pouch);
    const shake = Math.sin(t * 9) * 0.04 * tip * (1 - ph.pouchOut) * (ph.fall < 1 ? 1 : 0);
    this.pouch.position.set(
      THREE.MathUtils.lerp(0.4, -0.05, tip),
      THREE.MathUtils.lerp(8.5, 3.45, drop) + ph.pouchOut * 6 + Math.sin(t * 1.1) * 0.03,
      0.1,
    );
    this.pouch.rotation.set(0.1, -0.35 + tip * 0.2, tip * 2.55 + shake);
    this.pouch.visible = ph.pouch > 0 && ph.pouchOut < 1;
    this.pouch.updateMatrixWorld();

    // Leaves: fall from the pouch mouth, sink, swirl, then settle.
    const mouth = new THREE.Vector3(0.05, 3.0, 0.1);
    const swirl = ph.stir;
    const dance = Math.sin(swirl * Math.PI);
    for (let i = 0; i < this.leafData.length; i++) {
      const L = this.leafData[i];
      const f = clamp01((ph.fall - L.delay * 0.62) / 0.38);
      if (f <= 0) {
        this.dummy.scale.setScalar(0);
        this.dummy.updateMatrix();
        this.leaves.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      const restY = L.float ? localLevel - 0.03 - L.s[0] * 0.05 : L.h;
      const maxR = radiusAt(POT_BODY, Math.max(0.1, restY)) * 0.88;
      const ang = L.a + swirl * (4 + L.s[1] * 4) + t * 0.05 * (0.3 + dance);
      const rad = maxR * L.r * (0.7 + 0.3 * Math.cos(swirl * 6 + L.s[2] * 6));
      const y = restY + dance * (0.25 + L.s[3] * 0.6) + Math.sin(t * 1.2 + L.a * 5) * 0.02 * (1 + dance);
      const rx = Math.cos(ang) * rad;
      const rz = Math.sin(ang) * rad;
      // Parabolic fall from the mouth into the pot.
      const e = f * f;
      const fx = THREE.MathUtils.lerp(mouth.x + (L.s[0] - 0.5) * 0.3, rx, Math.sqrt(f));
      const fz = THREE.MathUtils.lerp(mouth.z + (L.s[1] - 0.5) * 0.3, rz, Math.sqrt(f));
      const fy = THREE.MathUtils.lerp(mouth.y, restY, e);
      const settle = smoothstep(0.85, 1, f);
      this.dummy.position.set(
        THREE.MathUtils.lerp(fx, rx, settle),
        THREE.MathUtils.lerp(fy, y, settle),
        THREE.MathUtils.lerp(fz, rz, settle),
      );
      const spin = L.spin * (f + swirl * 0.6) + t * 0.2 * dance;
      this.dummy.rotation.set(L.a + spin, spin * 0.7, L.s[2] * 6 + spin * 0.4);
      this.dummy.scale.setScalar(L.size * (1 + ph.brew * 0.35) * smoothstep(0, 0.08, f));
      this.dummy.updateMatrix();
      this.leaves.setMatrixAt(i, this.dummy.matrix);
    }
    this.leaves.instanceMatrix.needsUpdate = true;

    // Cup slides in from the left.
    const cupIn = ph.cup;
    this.cup.position.set(CUP_POS.x - (1 - cupIn) * 5, CUP_POS.y, CUP_POS.z);
    this.cup.visible = cupIn > 0.001;
    this.mint.visible = cupIn > 0.001;
    this.mint.position.x = -(1 - cupIn) * 5;
    for (const m of this.cupGlass) (m.material as THREE.ShaderMaterial).uniforms.uOpacity.value = cupIn;
    const flow = smoothstep(0.5, 0.62, ph.pour);
    const cl = this.cupLiquid.uniforms;
    const fill = smoothstep(0.55, 1, ph.pour) * 0.95 + ph.calm * 0.05;
    const cupBottom = this.cup.position.y + 0.24 * CUP_SCALE;
    cl.uLevel.value = cupBottom + fill * 0.72 * CUP_SCALE;
    cl.uBottom.value = cupBottom;
    cl.uBrew.value = 1;
    cl.uTime.value = t;
    cl.uWave.value = flow * 2.5;
    cl.uOpacity.value = fill > 0.01 ? 1 : 0;

    // Pour stream from the spout into the cup.
    this.streamUniforms.uTime.value = t;
    this.streamUniforms.uFlow.value = flow;
    this.stream.visible = flow > 0.001;
    if (this.stream.visible) {
      const tip3 = SPOUT_TIP.clone().applyMatrix4(this.pot.matrixWorld);
      const end = new THREE.Vector3(this.cup.position.x + 0.05, cl.uLevel.value, this.cup.position.z);
      const mid = tip3.clone().lerp(end, 0.5);
      mid.x = tip3.x + (end.x - tip3.x) * 0.25;
      const curve = new THREE.QuadraticBezierCurve3(tip3, mid, end);
      this.stream.geometry.dispose();
      this.stream.geometry = new THREE.TubeGeometry(curve, 32, 0.045 + Math.sin(t * 20) * 0.003, 10, false);
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
    table.uniforms.uBrew.value = ph.brew * (1 - lift);
    table.uniforms.uPool.value.set(this.pot.position.x * (1 - lift), 0, 0);
    table.uniforms.uCupAmt.value = fill;
    const dust = this.dust.material as THREE.ShaderMaterial;
    dust.uniforms.uTime.value = t;
    dust.uniforms.uOpacity.value = 0.35 + ph.brew * 0.3 + ph.calm * 0.35;
    this.vignette.uniforms.uTime.value = t % 10;
    this.bloom.strength = 0.32 + ph.brew * 0.15;
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
