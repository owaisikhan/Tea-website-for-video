// GLSL for the tea scene. Everything is procedural: no image or model files.
//
// Glass, tea and the pour stream refract a half-resolution copy of the opaque
// scene (`uScene`), so the leaves and the room bend through them like real glass.

const worldVert = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const noise = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return s;
  }
`;

// Fake warm studio: a bright window behind and to the right, a soft strip in front.
const env = /* glsl */ `
  vec3 studio(vec3 r) {
    float win = smoothstep(0.35, 0.95, dot(r, normalize(vec3(0.55, 0.45, -0.7))));
    // Window mullions break the reflection into panes.
    vec3 wr = normalize(r);
    float panes = smoothstep(0.02, 0.06, abs(fract(wr.x * 5.0) - 0.5)) * smoothstep(0.02, 0.06, abs(fract(wr.y * 4.0) - 0.5));
    float strip = smoothstep(0.86, 0.99, dot(r, normalize(vec3(-0.55, 0.35, 0.75))));
    float top = smoothstep(0.6, 1.0, r.y);
    vec3 c = vec3(1.0, 0.72, 0.38) * win * (1.9 + 0.7 * panes);
    c += vec3(1.0, 0.93, 0.82) * strip * 1.6;
    c += vec3(0.9, 0.7, 0.45) * top * 0.35;
    c += vec3(0.16, 0.09, 0.05) * (0.6 + 0.4 * r.y);
    return c;
  }
`;

// Screen-space helpers shared by everything that refracts.
const screen = /* glsl */ `
  uniform sampler2D uScene;
  uniform vec2 uRes;
  vec3 sceneAt(vec2 uv) { return texture2D(uScene, clamp(uv, 0.001, 0.999)).rgb; }
  vec3 refracted(vec2 uv, vec2 off) {
    // Slight chromatic split, as thick glass does.
    return vec3(sceneAt(uv + off).r, sceneAt(uv + off * 1.04).g, sceneAt(uv + off * 1.09).b);
  }
`;

export const glassShader = {
  vertexShader: worldVert,
  fragmentShader: /* glsl */ `
    uniform float uOpacity;
    uniform float uRefract;
    uniform vec3 uGlow;
    varying vec3 vWorld;
    varying vec3 vNormal;
    ${env}
    ${screen}
    void main() {
      vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
      vec3 V = normalize(cameraPosition - vWorld);
      float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
      float grazing = 1.0 - ndv;
      float fres = 0.04 + 0.96 * pow(grazing, 5.0);

      // Lensing: the background slides sideways where the glass curves away.
      vec2 suv = gl_FragCoord.xy / uRes;
      vec3 Nv = normalize((viewMatrix * vec4(N, 0.0)).xyz);
      vec2 off = -Nv.xy * uRefract * (0.25 + 1.5 * grazing * grazing);
      vec3 bg = refracted(suv, off) * vec3(0.97, 0.95, 0.9);

      vec3 R = reflect(-V, N);
      vec3 refl = studio(R);
      vec3 L = normalize(vec3(0.6, 0.7, -0.4));
      float spec = pow(max(dot(R, L), 0.0), 140.0) * 4.0 + pow(max(dot(R, normalize(vec3(-0.5, 0.4, 0.8))), 0.0), 60.0) * 0.8;

      // How much of the lensed copy shows: none face-on, most at the silhouette.
      float lens = smoothstep(0.15, 0.85, grazing);
      vec3 col = mix(bg, refl, clamp(fres * 1.4, 0.0, 1.0));
      // Glass reads by its edges: a dark core line with a warm rim of light inside it.
      float edge = smoothstep(0.82, 0.97, grazing);
      col *= 1.0 - 0.45 * edge;
      col += uGlow * smoothstep(0.55, 0.9, grazing) * (1.0 - edge);
      col += spec;

      float a = max(lens * 0.9, fres * 0.9) + spec * 0.4 + 0.015;
      if (!gl_FrontFacing) a *= 0.55;
      gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * uOpacity);
    }
  `,
};

export const liquidShader = {
  vertexShader: worldVert,
  fragmentShader: /* glsl */ `
    uniform float uLevel;
    uniform float uBottom;
    uniform float uBrew;
    uniform float uTime;
    uniform float uWave;
    uniform float uOpacity;
    uniform float uThick;
    varying vec3 vWorld;
    varying vec3 vNormal;
    ${env}
    ${screen}
    void main() {
      float wave = sin(vWorld.x * 7.0 + uTime * 2.2) * 0.012 + sin(vWorld.z * 9.0 - uTime * 1.7) * 0.01
        + sin((vWorld.x + vWorld.z) * 15.0 + uTime * 3.1) * 0.004;
      float lvl = uLevel + wave * (0.4 + uWave);
      if (vWorld.y > lvl) discard;

      vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
      vec3 V = normalize(cameraPosition - vWorld);
      float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
      float grazing = 1.0 - ndv;
      float fres = 0.02 + 0.98 * pow(grazing, 5.0);
      float depth = clamp((lvl - vWorld.y) / max(lvl - uBottom, 0.01), 0.0, 1.0);

      vec2 suv = gl_FragCoord.xy / uRes;
      vec3 Nv = normalize((viewMatrix * vec4(N, 0.0)).xyz);
      bool surface = !gl_FrontFacing;
      // The body of liquid acts like a lens; the surface only ripples.
      vec2 off = surface ? vec2(sin(vWorld.x * 12.0 + uTime * 2.0), cos(vWorld.z * 12.0 - uTime * 1.6)) * 0.006
                         : -Nv.xy * (0.035 + 0.05 * grazing);
      vec3 bg = refracted(suv, off);

      // Beer-Lambert absorption: thicker tea through the middle, amber deepening with brew time.
      float thick = uThick * (0.35 + 0.65 * ndv) * (0.6 + 0.4 * depth);
      vec3 sigma = vec3(0.16, 0.9, 2.9) * (0.4 + 0.8 * uBrew);
      vec3 absorb = exp(-thick * sigma * uBrew);
      vec3 water = vec3(0.93, 0.95, 0.93);
      vec3 col = bg * mix(water, absorb, uBrew);

      // Light scattering inside the tea, strongest where the window shines through.
      float back = pow(grazing, 1.5);
      col += vec3(1.0, 0.52, 0.1) * uBrew * (0.2 + 0.35 * back) * (1.0 - 0.45 * depth);

      // Surface: a darker body with the window reflected in it.
      vec3 refl = studio(reflect(-V, N));
      if (surface) {
        col = col * 0.8 + refl * (0.12 + 0.3 * fres);
      } else {
        col = mix(col, refl, fres * 0.6);
      }
      // Bright meniscus where the tea meets the glass.
      float men = smoothstep(lvl - 0.03, lvl, vWorld.y);
      col += vec3(1.0, 0.82, 0.55) * men * (0.18 + 0.3 * uBrew);

      gl_FragColor = vec4(col, uOpacity);
    }
  `,
};

export const backdropShader = {
  vertexShader: worldVert,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform float uWarm;
    varying vec2 vUv;
    ${noise}
    float disc(vec2 uv, vec2 c, float r, float soft) {
      return 1.0 - smoothstep(r - soft, r, length((uv - c) * vec2(2.0, 1.0)));
    }
    void main() {
      vec2 uv = vUv;
      vec3 col = mix(vec3(0.012, 0.007, 0.004), vec3(0.055, 0.03, 0.014), smoothstep(0.0, 1.0, uv.y * 0.6 + uv.x * 0.5));

      // Window glow high on the right, with soft out-of-focus panes.
      vec2 w = (uv - vec2(0.68, 0.72)) * vec2(1.3, 1.0);
      float win = exp(-pow(length(w) * 2.4, 2.0));
      float panes = smoothstep(0.0, 0.12, abs(fract(uv.x * 14.0) - 0.5)) * smoothstep(0.0, 0.12, abs(fract(uv.y * 9.0) - 0.5));
      col += vec3(0.7, 0.36, 0.1) * win * (0.3 + 0.15 * uWarm) * (0.92 + 0.08 * panes);

      // Light shafts falling from the window, drifting slowly.
      vec2 o = vec2(0.82, 1.05);
      vec2 d = uv - o;
      float ang = atan(d.y, d.x);
      float shafts = fbm(vec2(ang * 9.0, uTime * 0.05));
      shafts = smoothstep(0.45, 0.85, shafts) * smoothstep(1.2, 0.2, length(d));
      col += vec3(0.9, 0.55, 0.22) * shafts * 0.13;

      // Out-of-focus lamps along the far wall, with a brighter rim like real bokeh.
      float b = 0.0;
      vec2 cs[5];
      cs[0] = vec2(0.18, 0.44); cs[1] = vec2(0.27, 0.40); cs[2] = vec2(0.84, 0.47); cs[3] = vec2(0.93, 0.52); cs[4] = vec2(0.08, 0.5);
      float rs[5];
      rs[0] = 0.035; rs[1] = 0.025; rs[2] = 0.03; rs[3] = 0.02; rs[4] = 0.018;
      for (int i = 0; i < 5; i++) {
        float body = disc(uv, cs[i], rs[i], rs[i] * 0.35);
        float rim = body - disc(uv, cs[i], rs[i] * 0.8, rs[i] * 0.3);
        b += (body * 0.35 + rim * 0.4) * (0.6 + 0.4 * sin(uTime * 0.4 + float(i) * 2.0));
      }
      col += vec3(1.0, 0.6, 0.22) * b * 0.45;

      col *= 0.85 + 0.15 * fbm(uv * 6.0);
      col *= smoothstep(0.1, 0.45, uv.y) * 0.8 + 0.2;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export const tableShader = {
  vertexShader: worldVert,
  fragmentShader: /* glsl */ `
    uniform float uBrew;
    uniform vec3 uPool;
    uniform vec3 uCup;
    uniform float uCupAmt;
    uniform float uPotAmt;
    varying vec3 vWorld;
    ${noise}
    ${env}
    void main() {
      vec2 p = vWorld.xz;

      // Planks run left to right; each has its own tone and grain offset.
      float plank = floor(p.y / 1.35);
      float seam = smoothstep(0.0, 0.02, abs(fract(p.y / 1.35) - 0.5) - 0.485);
      seam = 1.0 - seam;
      float tone = hash(vec2(plank, 3.1));
      vec2 q = vec2(p.x * 0.22 + tone * 7.0, p.y * 3.2);
      vec2 warp = vec2(fbm(q * 0.8), fbm(q * 0.8 + 5.2));
      float grain = fbm(q + warp * 1.6);
      float rings = sin((p.y * 5.0 + warp.x * 6.0 + tone * 20.0) * 3.0) * 0.5 + 0.5;
      float pores = smoothstep(0.62, 0.8, vnoise(vec2(p.x * 3.0, p.y * 90.0)));
      vec3 dark = mix(vec3(0.026, 0.014, 0.008), vec3(0.04, 0.02, 0.01), tone);
      vec3 light = mix(vec3(0.09, 0.046, 0.021), vec3(0.12, 0.062, 0.028), tone);
      vec3 wood = mix(dark, light, grain);
      wood = mix(wood, wood * 1.3, rings * 0.22);
      wood *= 1.0 - pores * 0.25;
      wood *= mix(0.35, 1.0, seam);

      // Warm light pool and an amber caustic under the glass.
      float d = length((p - uPool.xz) * vec2(0.55, 1.0));
      float pool = exp(-d * d * 0.35);
      vec3 col = wood * (0.3 + 1.0 * pool);
      float caus = fbm(p * 5.0 + vec2(0.0, uBrew)) * exp(-d * d * 1.4);
      col += vec3(1.0, 0.5, 0.1) * caus * 0.3 * uBrew * uPotAmt;
      float dc = length(p - uCup.xz);
      col += vec3(1.0, 0.55, 0.12) * exp(-dc * dc * 2.5) * 0.3 * uCupAmt;
      // Soft contact shadows.
      col *= mix(1.0, 0.55 + 0.45 * smoothstep(0.4, 1.4, d), uPotAmt);
      col *= mix(1.0, 0.6 + 0.4 * smoothstep(0.55, 1.2, dc), uCupAmt);

      // Varnish: a soft reflection of the room that grows toward grazing angles.
      vec3 V = normalize(cameraPosition - vWorld);
      vec3 Nw = normalize(vec3((grain - 0.5) * 0.04, 1.0, (rings - 0.5) * 0.03));
      float fres = 0.03 + 0.97 * pow(1.0 - max(dot(Nw, V), 0.0), 5.0);
      col += studio(reflect(-V, Nw)) * fres * 0.04 * seam;

      // Fade into darkness toward the back and sides.
      float fade = (smoothstep(-11.0, -3.0, vWorld.z) * 0.85 + 0.15) * (1.0 - smoothstep(6.0, 12.0, abs(vWorld.x)));
      col = mix(vec3(0.012, 0.007, 0.004), col, fade);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export const steamShader = {
  vertexShader: worldVert,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform float uAmount;
    uniform float uSeed;
    varying vec2 vUv;
    ${noise}
    void main() {
      vec2 uv = vUv;
      float x = uv.x - 0.5 + (fbm(vec2(uv.y * 2.0 - uTime * 0.3, uSeed)) - 0.5) * 0.5 * uv.y;
      float body = exp(-x * x * 30.0 / (0.3 + uv.y));
      float n = fbm(vec2(x * 4.0 + uSeed, uv.y * 3.0 - uTime * 0.45));
      float a = body * smoothstep(0.35, 0.8, n) * smoothstep(0.0, 0.2, uv.y) * (1.0 - smoothstep(0.55, 1.0, uv.y));
      gl_FragColor = vec4(vec3(1.0, 0.9, 0.78), a * uAmount * 0.3);
    }
  `,
};

export const streamShader = {
  vertexShader: worldVert,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform float uFlow;
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vWorld;
    ${noise}
    ${env}
    ${screen}
    void main() {
      if (vUv.x > uFlow) discard;
      vec3 N = normalize(vNormal);
      vec3 V = normalize(cameraPosition - vWorld);
      float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
      vec2 suv = gl_FragCoord.xy / uRes;
      vec3 Nv = normalize((viewMatrix * vec4(N, 0.0)).xyz);
      float streak = fbm(vec2(vUv.y * 6.0, vUv.x * 14.0 - uTime * 6.0));
      vec3 bg = refracted(suv, -Nv.xy * 0.03);
      vec3 absorb = exp(-vec3(0.16, 0.9, 2.9) * (0.4 + 0.5 * ndv));
      vec3 col = bg * absorb * 0.7 + vec3(0.95, 0.5, 0.1) * (0.45 + 0.4 * streak);
      col = mix(col, studio(reflect(-V, N)), pow(1.0 - ndv, 4.0) * 0.7);
      col += vec3(1.0, 0.8, 0.5) * pow(max(dot(reflect(-V, N), normalize(vec3(0.6, 0.7, -0.4))), 0.0), 40.0);
      gl_FragColor = vec4(col, 0.55 + 0.4 * ndv);
    }
  `,
};

export const dustShader = {
  vertexShader: /* glsl */ `
    uniform float uTime;
    uniform float uSize;
    attribute float aSeed;
    varying float vAlpha;
    void main() {
      vec3 p = position;
      p.y += mod(uTime * (0.05 + aSeed * 0.08) + aSeed * 10.0, 6.0) - 1.0;
      p.x += sin(uTime * 0.3 + aSeed * 30.0) * 0.3;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = uSize * (0.5 + aSeed) / -mv.z;
      vAlpha = 0.35 + 0.65 * fract(aSeed * 7.13);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uOpacity;
    varying float vAlpha;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.1, d);
      gl_FragColor = vec4(vec3(1.0, 0.7, 0.3), a * vAlpha * uOpacity);
    }
  `,
};

export const vignetteShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    varying vec2 vUv;
    float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - dot(d, d) * 1.1;
      c.rgb += (h(vUv * 800.0 + uTime) - 0.5) * 0.02;
      gl_FragColor = c;
    }
  `,
};
