// Geometry and materials for the four kinds of leaf in the pot. Everything is
// generated here: curled 3D blades with painted, cut-out textures, and rolled
// loose-tea spindles. Leaves glow where the window light shines through them.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type Blade = { width: number; fold: number; curl: number; twist: number; segs?: number };

/** A leaf blade along x (-0.5..0.5): folded at the midrib, curled along its length and slightly twisted. */
function blade({ width, fold, curl, twist, segs = 18 }: Blade) {
  const g = new THREE.PlaneGeometry(1, width, segs, 8);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    let z = Math.abs(y) * fold + x * x * curl;
    // Twist around the midrib.
    const a = x * twist;
    const yy = y * Math.cos(a) - z * Math.sin(a);
    z = y * Math.sin(a) + z * Math.cos(a);
    p.setXYZ(i, x, yy, z);
  }
  g.computeVertexNormals();
  return g;
}

/** Rolled loose tea: a twisted, creased spindle. */
function rolled() {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    pts.push(new THREE.Vector2(0.11 * Math.pow(Math.sin(Math.PI * t), 0.75) + 0.004, t - 0.5));
  }
  const g = new THREE.LatheGeometry(pts, 10);
  g.rotateZ(Math.PI / 2); // axis along x
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const ang = Math.atan2(z, y);
    const rad = Math.hypot(y, z) * (1 + 0.22 * Math.sin(ang * 3 + x * 14));
    const tw = ang + x * 7;
    p.setXYZ(i, x, Math.cos(tw) * rad + x * x * 0.25, Math.sin(tw) * rad);
  }
  g.computeVertexNormals();
  return g;
}

type Paint = { base: string; edge: string; vein: string; serrate: number; width: number; tipRound: number; veins: number };

/** Painted leaf texture with a cut-out outline, serrated edge and veins. */
function paint({ base, edge, vein, serrate, width, tipRound, veins }: Paint) {
  const W = 256;
  const H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d")!;
  // Outline: half-width along the length, with tiny teeth.
  const half = (u: number) => {
    const s = Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
    const shape = Math.pow(s, tipRound) * (1 - 0.25 * u);
    const teeth = serrate > 0 ? 1 - serrate * (0.5 + 0.5 * Math.sin(u * 90)) : 1;
    return shape * teeth * (H / 2 - 4) * width;
  };
  const path = new Path2D();
  const steps = 160;
  path.moveTo(4, H / 2);
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    path.lineTo(4 + u * (W - 8), H / 2 - half(u));
  }
  for (let i = steps; i >= 0; i--) {
    const u = i / steps;
    path.lineTo(4 + u * (W - 8), H / 2 + half(u));
  }
  path.closePath();
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, edge);
  g.addColorStop(0.5, base);
  g.addColorStop(1, edge);
  x.fillStyle = g;
  x.fill(path);
  x.save();
  x.clip(path);
  // Mottling.
  let seed = 9;
  const r = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < 1400; i++) {
    x.fillStyle = r() > 0.5 ? "rgba(255,255,220,0.05)" : "rgba(0,0,0,0.07)";
    const s = 1 + r() * 3;
    x.fillRect(r() * W, r() * H, s, s);
  }
  // Midrib and side veins.
  x.strokeStyle = vein;
  x.lineWidth = 2.4;
  x.beginPath();
  x.moveTo(6, H / 2);
  x.quadraticCurveTo(W / 2, H / 2 - 2, W - 6, H / 2);
  x.stroke();
  x.lineWidth = 1.1;
  for (let i = 1; i <= veins; i++) {
    const u = i / (veins + 1);
    const vx = 6 + u * (W - 20);
    const reach = half(u + 0.08) * 0.92;
    for (const s of [-1, 1]) {
      x.beginPath();
      x.moveTo(vx, H / 2);
      x.quadraticCurveTo(vx + 12, H / 2 + s * reach * 0.5, vx + 30, H / 2 + s * reach);
      x.stroke();
    }
  }
  // Darker rim.
  x.lineWidth = 3;
  x.strokeStyle = "rgba(0,0,0,0.25)";
  x.stroke(path);
  x.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Makes a standard material glow where light passes through it from behind. */
function translucent(mat: THREE.MeshStandardMaterial, lightView: { value: THREE.Vector3 }, amount: number) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLightView = lightView;
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform vec3 uLightView;\nvoid main() {")
      .replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>
        {
          // vViewPosition points from the surface to the camera; light behind the leaf faces away from it.
          vec3 toCamera = normalize(vViewPosition);
          float back = pow(max(dot(uLightView, -toCamera), 0.0), 2.0);
          float thin = 0.35 + 0.65 * abs(dot(normal, uLightView));
          reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(1.0, 0.8, 0.45) * back * thin * ${amount.toFixed(2)};
        }`,
      );
  };
  return mat;
}

/** Irregular ginger slice: a thin wobbly disc; the side is skin, the faces are fibrous flesh. */
function gingerSlice() {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 0.16, 28, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const a = Math.atan2(z, x);
    const k = 1 + 0.12 * Math.sin(a * 3 + 1) + 0.07 * Math.sin(a * 7 + 2);
    p.setX(i, x * k * 1.15);
    p.setZ(i, z * k * 0.9);
    p.setY(i, p.getY(i) + Math.sin(x * 3) * 0.03);
  }
  g.computeVertexNormals();
  return g;
}

/** Cinnamon quill: a strip of bark rolled one and a half times. */
function cinnamon() {
  const L = 16;
  const W = 14;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= L; i++) {
    for (let j = 0; j <= W; j++) {
      const u = i / L;
      const v = j / W;
      const theta = v * Math.PI * 3;
      const r = 0.1 - 0.035 * v;
      pos.push(u - 0.5, Math.cos(theta) * r, Math.sin(theta) * r);
      uv.push(u, v);
    }
  }
  for (let i = 0; i < L; i++) {
    for (let j = 0; j < W; j++) {
      const a = i * (W + 1) + j;
      const b = a + W + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Star anise: eight boat-shaped pods around a small hub. */
function starAnise() {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 8; k++) {
    const pod = new THREE.SphereGeometry(0.5, 12, 8);
    const p = pod.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      // Pointed at the tip, split open along the top.
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const tip = 1 - 0.5 * Math.max(0, x);
      p.setXYZ(i, x * 0.5 + 0.25, (y > 0 ? y * 0.35 : y * 0.7) * 0.32 * tip, z * 0.26 * tip);
    }
    pod.rotateY((k / 8) * Math.PI * 2);
    parts.push(pod);
  }
  const hub = new THREE.SphereGeometry(0.07, 10, 8);
  parts.push(hub);
  const g = mergeGeometries(parts.map((q) => q.toNonIndexed()));
  g.computeVertexNormals();
  return g;
}

/** Green cardamom pod: a ridged, pointed oval. */
function cardamom() {
  const g = new THREE.SphereGeometry(0.5, 18, 12);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const a = Math.atan2(z, x);
    const ridge = 1 + 0.12 * Math.cos(a * 3);
    const taper = 1 - 0.25 * Math.max(0, y) ** 2;
    p.setXYZ(i, x * 0.34 * ridge * taper, y, z * 0.34 * ridge * taper);
  }
  g.rotateZ(Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

/** Clove: a thin stem with a round bud and four points. */
function clove() {
  const stem = new THREE.CylinderGeometry(0.05, 0.035, 0.75, 8);
  stem.translate(0, -0.1, 0);
  const bud = new THREE.SphereGeometry(0.12, 12, 10);
  bud.translate(0, 0.38, 0);
  const parts: THREE.BufferGeometry[] = [stem, bud];
  for (let k = 0; k < 4; k++) {
    const s = new THREE.ConeGeometry(0.05, 0.16, 6);
    s.rotateZ(-0.7);
    s.translate(0.09, 0.3, 0);
    s.rotateY((k / 4) * Math.PI * 2);
    parts.push(s);
  }
  const g = mergeGeometries(parts.map((q) => q.toNonIndexed()));
  g.rotateZ(Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

function canvasTexture(w: number, h: number, draw: (x: CanvasRenderingContext2D, r: () => number) => void, srgb = true) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  let seed = 13;
  const r = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  draw(c.getContext("2d")!, r);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Physical behaviour of each ingredient in the simulation. */
export type KindParams = {
  airDrag: number; // linear drag in air
  flutter: number; // side-to-side glide strength
  spin: number; // tumble rate in air (rad/s)
  buoy: number; // buoyancy relative to weight when dry (>1 floats)
  soak: number; // how fast buoyancy is lost per second in water
  waterDrag: number; // how quickly it follows the water
};

export type Ingredient = {
  name: string;
  count: number;
  liteCount: number;
  size: [number, number];
  physics: KindParams;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
};

export type LeafSet = {
  ingredients: Ingredient[];
  disposables: { dispose(): void }[];
  mintGeometry: THREE.BufferGeometry;
  mintMaterial: THREE.MeshStandardMaterial; // for the sprigs on the table
  lightView: { value: THREE.Vector3 };
};

export function buildLeafSet(): LeafSet {
  const lightView = { value: new THREE.Vector3(0, 0, -1) };
  const leafTex = paint({ base: "#56621f", edge: "#343c12", vein: "rgba(200,210,120,0.45)", serrate: 0.06, width: 0.95, tipRound: 0.8, veins: 8 });
  const petalTex = paint({ base: "#f3a81e", edge: "#d9790c", vein: "rgba(255,220,120,0.4)", serrate: 0, width: 0.85, tipRound: 0.45, veins: 5 });
  const mintTex = paint({ base: "#5c9a2e", edge: "#3e7420", vein: "rgba(190,235,140,0.5)", serrate: 0.1, width: 1, tipRound: 0.7, veins: 6 });
  // Ginger flesh: pale yellow with radial fibres and a darker ring under the skin.
  const gingerFlesh = canvasTexture(256, 256, (x, r) => {
    const g = x.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, "#f2dd8a");
    g.addColorStop(0.72, "#e8c96a");
    g.addColorStop(0.8, "#c9a24a");
    g.addColorStop(0.92, "#b28a45");
    g.addColorStop(1, "#8a6434");
    x.fillStyle = g;
    x.fillRect(0, 0, 256, 256);
    x.strokeStyle = "rgba(255,245,200,0.18)";
    for (let i = 0; i < 160; i++) {
      const a = r() * Math.PI * 2;
      const r0 = r() * 40;
      x.beginPath();
      x.moveTo(128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0);
      x.lineTo(128 + Math.cos(a) * 110, 128 + Math.sin(a) * 110);
      x.stroke();
    }
    for (let i = 0; i < 500; i++) {
      x.fillStyle = `rgba(160,120,40,${0.1 + r() * 0.15})`;
      x.fillRect(r() * 256, r() * 256, 2, 2);
    }
  });
  const gingerSkin = canvasTexture(256, 64, (x, r) => {
    x.fillStyle = "#9c7446";
    x.fillRect(0, 0, 256, 64);
    for (let i = 0; i < 400; i++) {
      x.fillStyle = r() > 0.5 ? "rgba(70,45,20,0.25)" : "rgba(200,160,100,0.2)";
      x.fillRect(r() * 256, r() * 64, 1 + r() * 4, 1);
    }
  });
  // Cinnamon bark: warm brown with lengthwise striations; the inside of the roll is darker.
  const bark = canvasTexture(256, 256, (x, r) => {
    const g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "#7a3f1c");
    g.addColorStop(1, "#5a2c12");
    x.fillStyle = g;
    x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 260; i++) {
      x.strokeStyle = r() > 0.5 ? "rgba(40,18,6,0.35)" : "rgba(170,100,50,0.25)";
      x.lineWidth = 0.5 + r() * 1.5;
      const y = r() * 256;
      x.beginPath();
      x.moveTo(r() * 60, y);
      x.lineTo(120 + r() * 136, y + (r() - 0.5) * 6);
      x.stroke();
    }
  });

  const cut = (map: THREE.Texture, rough: number) =>
    translucent(
      new THREE.MeshStandardMaterial({ map, bumpMap: map, bumpScale: 1.5, alphaTest: 0.45, roughness: rough, side: THREE.DoubleSide }),
      lightView,
      0.9,
    );
  const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.6, ...o });
  const gingerSliceMats = [
    std({ map: gingerSkin, roughness: 0.8 }),
    translucent(std({ map: gingerFlesh, bumpMap: gingerFlesh, bumpScale: 2, roughness: 0.55 }), lightView, 0.5),
    translucent(std({ map: gingerFlesh, bumpMap: gingerFlesh, bumpScale: 2, roughness: 0.55 }), lightView, 0.5),
  ];
  const mintGeometry = blade({ width: 0.6, fold: 0.28, curl: 0.3, twist: 0.35 });
  const mintMaterial = cut(mintTex, 0.45);

  const P = (airDrag: number, flutter: number, spin: number, buoy: number, soak: number, waterDrag: number): KindParams => ({
    airDrag,
    flutter,
    spin,
    buoy,
    soak,
    waterDrag,
  });
  const ingredients: Ingredient[] = [
    { name: "rolled tea", count: 170, liteCount: 90, size: [0.15, 0.24], physics: P(1.1, 0.25, 8, 0.8, 0, 3.5), geometry: rolled(), material: std({ color: 0x3a3514, roughness: 0.55, metalness: 0.05 }) },
    { name: "tea leaf", count: 80, liteCount: 40, size: [0.3, 0.44], physics: P(2.6, 1.5, 4, 1.1, 0.08, 4.5), geometry: blade({ width: 0.44, fold: 0.35, curl: 0.35, twist: 0.5 }), material: cut(leafTex, 0.5) },
    { name: "petal", count: 30, liteCount: 16, size: [0.14, 0.2], physics: P(3.6, 2.1, 5, 1.2, 0.015, 5.5), geometry: blade({ width: 0.55, fold: 0.1, curl: 0.45, twist: 0.2, segs: 10 }), material: cut(petalTex, 0.6) },
    { name: "mint", count: 18, liteCount: 10, size: [0.26, 0.36], physics: P(2.9, 1.8, 4, 1.15, 0.05, 5), geometry: mintGeometry, material: cut(mintTex, 0.45) },
    { name: "ginger slice", count: 10, liteCount: 6, size: [0.2, 0.28], physics: P(1.3, 0.5, 5, 0.9, 0, 3), geometry: gingerSlice(), material: gingerSliceMats },
    { name: "cinnamon", count: 3, liteCount: 2, size: [0.55, 0.7], physics: P(1.0, 0.2, 3, 1.08, 0.01, 3), geometry: cinnamon(), material: std({ map: bark, bumpMap: bark, bumpScale: 3, roughness: 0.75, side: THREE.DoubleSide }) },
    { name: "star anise", count: 5, liteCount: 3, size: [0.26, 0.32], physics: P(1.4, 0.4, 5, 1.06, 0.01, 3.5), geometry: starAnise(), material: std({ color: 0x5a2a14, roughness: 0.7 }) },
    { name: "cardamom", count: 14, liteCount: 8, size: [0.12, 0.16], physics: P(1.0, 0.1, 7, 1.02, 0.02, 3), geometry: cardamom(), material: std({ color: 0x8a9a52, roughness: 0.65 }) },
    { name: "clove", count: 16, liteCount: 8, size: [0.12, 0.16], physics: P(1.0, 0.1, 8, 1.04, 0.015, 3), geometry: clove(), material: std({ color: 0x3e2212, roughness: 0.7 }) },
  ];
  const disposables: { dispose(): void }[] = [leafTex, petalTex, mintTex, gingerFlesh, gingerSkin, bark, mintGeometry, mintMaterial];
  for (const ing of ingredients) {
    disposables.push(ing.geometry);
    for (const m of Array.isArray(ing.material) ? ing.material : [ing.material]) disposables.push(m);
  }
  return { ingredients, disposables, mintGeometry, mintMaterial, lightView };
}
