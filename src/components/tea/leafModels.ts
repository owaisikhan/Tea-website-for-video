// Geometry and materials for the four kinds of leaf in the pot. Everything is
// generated here: curled 3D blades with painted, cut-out textures, and rolled
// loose-tea spindles. Leaves glow where the window light shines through them.

import * as THREE from "three";

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

export type LeafSet = {
  geometries: THREE.BufferGeometry[]; // index = LeafKind
  materials: THREE.Material[];
  textures: THREE.Texture[];
  mintMaterial: THREE.MeshStandardMaterial; // for the sprigs on the table
  lightView: { value: THREE.Vector3 };
};

export function buildLeafSet(): LeafSet {
  const lightView = { value: new THREE.Vector3(0, 0, -1) };
  const leafTex = paint({ base: "#5d6a24", edge: "#3b4415", vein: "rgba(200,210,120,0.45)", serrate: 0.06, width: 0.95, tipRound: 0.8, veins: 7 });
  const petalTex = paint({ base: "#f3a81e", edge: "#d9790c", vein: "rgba(255,220,120,0.4)", serrate: 0, width: 0.85, tipRound: 0.45, veins: 5 });
  const mintTex = paint({ base: "#5c9a2e", edge: "#3e7420", vein: "rgba(190,235,140,0.5)", serrate: 0.1, width: 1, tipRound: 0.7, veins: 6 });

  const geometries = [
    rolled(),
    blade({ width: 0.44, fold: 0.35, curl: 0.35, twist: 0.5 }),
    blade({ width: 0.55, fold: 0.1, curl: 0.45, twist: 0.2, segs: 10 }),
    blade({ width: 0.6, fold: 0.28, curl: 0.3, twist: 0.35 }),
  ];
  const cut = (map: THREE.Texture, rough: number) =>
    translucent(
      new THREE.MeshStandardMaterial({ map, bumpMap: map, bumpScale: 1.5, alphaTest: 0.45, roughness: rough, side: THREE.DoubleSide }),
      lightView,
      0.9,
    );
  const rolledMat = new THREE.MeshStandardMaterial({ color: 0x3a3514, roughness: 0.55, metalness: 0.05 });
  const materials = [rolledMat, cut(leafTex, 0.5), cut(petalTex, 0.6), cut(mintTex, 0.45)];
  const mintMaterial = cut(mintTex, 0.45);
  return { geometries, materials, textures: [leafTex, petalTex, mintTex], mintMaterial, lightView };
}
