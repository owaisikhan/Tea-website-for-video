// GLSL for the tea scene. Everything is procedural: no textures or models.

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
    float strip = smoothstep(0.86, 0.99, dot(r, normalize(vec3(-0.55, 0.35, 0.75))));
    float top = smoothstep(0.6, 1.0, r.y);
    vec3 c = vec3(1.0, 0.72, 0.38) * win * 2.4;
    c += vec3(1.0, 0.93, 0.82) * strip * 1.6;
    c += vec3(0.9, 0.7, 0.45) * top * 0.35;
    c += vec3(0.16, 0.09, 0.05) * (0.6 + 0.4 * r.y);
    return c;
  }
`;

export const glassShader = {
  vertexShader: worldVert,
  fragmentShader: /* glsl */ `
    uniform float uOpacity;
    uniform vec3 uGlow;
    varying vec3 vWorld;
    varying vec3 vNormal;
    ${env}
    void main() {
      vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
      vec3 V = normalize(cameraPosition - vWorld);
      float ndv = abs(dot(N, V));
      float fres = pow(1.0 - ndv, 3.0);
      vec3 R = reflect(-V, N);
      vec3 col = studio(R);
      vec3 L = normalize(vec3(0.6, 0.7, -0.4));
      float spec = pow(max(dot(R, L), 0.0), 90.0) * 3.0;
      float rim = smoothstep(0.55, 1.0, 1.0 - ndv);
      float a = 0.02 + 0.5 * fres + 0.12 * rim + spec * 0.4;
      col = col * (0.3 + 0.9 * fres) + spec + uGlow * rim;
      gl_FragColor = vec4(col, clamp(a, 0.0, 0.95) * uOpacity);
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
    varying vec3 vWorld;
    varying vec3 vNormal;
    ${env}
    void main() {
      float wave = sin(vWorld.x * 7.0 + uTime * 2.2) * 0.012 + sin(vWorld.z * 9.0 - uTime * 1.7) * 0.01;
      float lvl = uLevel + wave * (0.4 + uWave);
      if (vWorld.y > lvl) discard;
      vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
      vec3 V = normalize(cameraPosition - vWorld);
      float ndv = abs(dot(N, V));
      float depth = clamp((lvl - vWorld.y) / max(lvl - uBottom, 0.01), 0.0, 1.0);

      vec3 water = vec3(0.42, 0.36, 0.28);
      vec3 teaLight = vec3(0.86, 0.38, 0.05);
      vec3 teaDeep = vec3(0.32, 0.09, 0.01);
      vec3 tea = mix(teaLight, teaDeep, smoothstep(0.0, 1.0, depth));
      vec3 col = mix(water, tea, uBrew);

      // Back light glowing through the body of the liquid.
      float back = pow(1.0 - ndv, 1.5);
      col += vec3(1.0, 0.5, 0.08) * back * 0.45 * uBrew;
      col *= 0.45 + 0.6 * (1.0 - depth * 0.6);

      // Bright meniscus line at the surface.
      float men = smoothstep(lvl - 0.035, lvl, vWorld.y);
      col += vec3(1.0, 0.8, 0.5) * men * (0.25 + 0.35 * uBrew);
      col += studio(reflect(-V, N)) * pow(1.0 - ndv, 4.0) * 0.5;

      float a = mix(0.07 + men * 0.2, 0.86, uBrew);
      if (!gl_FrontFacing) a *= 0.7;
      gl_FragColor = vec4(col, a * uOpacity);
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

      // Window glow high on the right.
      float win = exp(-pow(length((uv - vec2(0.68, 0.72)) * vec2(1.3, 1.0)) * 2.4, 2.0));
      col += vec3(0.7, 0.36, 0.1) * win * (0.3 + 0.15 * uWarm);

      // Light shafts falling from the window.
      vec2 o = vec2(0.82, 1.05);
      vec2 d = uv - o;
      float ang = atan(d.y, d.x);
      float shafts = fbm(vec2(ang * 9.0, uTime * 0.05));
      shafts = smoothstep(0.45, 0.85, shafts) * smoothstep(1.2, 0.2, length(d));
      col += vec3(0.9, 0.55, 0.22) * shafts * 0.13;

      // Out-of-focus lamps along the far wall.
      float b = 0.0;
      b += disc(uv, vec2(0.18, 0.44), 0.035, 0.02) * 0.5;
      b += disc(uv, vec2(0.27, 0.40), 0.025, 0.015) * 0.35;
      b += disc(uv, vec2(0.84, 0.47), 0.03, 0.018) * 0.45;
      b += disc(uv, vec2(0.93, 0.52), 0.02, 0.012) * 0.3;
      col += vec3(1.0, 0.6, 0.22) * b * 0.35;

      col *= 0.85 + 0.15 * fbm(uv * 6.0);
      // Darken the edges.
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
    varying vec3 vWorld;
    ${noise}
    void main() {
      vec2 p = vWorld.xz;
      float grain = fbm(vec2(p.x * 0.35, p.y * 7.0 + fbm(p * 0.6) * 3.0));
      float rings = sin((p.y + fbm(p * 0.4) * 1.2) * 38.0) * 0.5 + 0.5;
      vec3 wood = mix(vec3(0.03, 0.017, 0.009), vec3(0.1, 0.052, 0.024), grain);
      wood = mix(wood, wood * 1.25, rings * 0.25);

      // Warm light pool and an amber caustic under the glass.
      float d = length((p - uPool.xz) * vec2(0.55, 1.0));
      float pool = exp(-d * d * 0.35);
      vec3 col = wood * (0.3 + 1.0 * pool);
      float caus = fbm(p * 5.0 + vec2(0.0, uBrew)) * exp(-d * d * 1.4);
      col += vec3(1.0, 0.5, 0.1) * caus * 0.35 * uBrew;
      float dc = length(p - uCup.xz);
      col += vec3(1.0, 0.55, 0.12) * exp(-dc * dc * 2.5) * 0.35 * uCupAmt;
      // Contact shadow.
      col *= 0.55 + 0.45 * smoothstep(0.4, 1.4, d);

      // Fade into darkness toward the back and sides.
      float fade = smoothstep(-11.0, -3.0, vWorld.z) * 0.85 + 0.15 * (1.0 - smoothstep(6.0, 12.0, abs(vWorld.x)));
      col = mix(vec3(0.012, 0.007, 0.004), col, fade);
      // Glossy reflection of the window.
      col += vec3(0.35, 0.18, 0.06) * exp(-pow((p.x - 2.5) * 0.3, 2.0)) * smoothstep(-6.0, -1.0, p.y) * smoothstep(3.0, -1.0, p.y) * 0.25;
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
      gl_FragColor = vec4(vec3(1.0, 0.9, 0.78), a * uAmount * 0.35);
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
    void main() {
      if (vUv.x > uFlow) discard;
      vec3 V = normalize(cameraPosition - vWorld);
      float ndv = abs(dot(normalize(vNormal), V));
      float streak = fbm(vec2(vUv.y * 6.0, vUv.x * 14.0 - uTime * 6.0));
      vec3 col = mix(vec3(0.75, 0.3, 0.04), vec3(1.0, 0.72, 0.3), streak);
      col += vec3(1.0, 0.85, 0.6) * pow(ndv, 6.0) * 0.8;
      gl_FragColor = vec4(col * 1.2, 0.85);
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
      c.rgb += (h(vUv * 800.0 + uTime) - 0.5) * 0.025;
      gl_FragColor = c;
    }
  `,
};
