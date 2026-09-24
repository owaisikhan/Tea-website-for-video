// GLSL for the tea scene. Everything is procedural: no image or model files.
//
// Glass, tea and the pour stream refract a half-resolution copy of the opaque
// scene (`uScene`), so the leaves and the room bend through them like real glass.

const worldVert = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;
  varying vec3 vLocal;
  void main() {
    vUv = uv;
    vLocal = position;
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

// Reflections. When the HDR photo of a studio is loaded (uEnvOn = 1) every reflection samples
// it; before that, a painted warm studio stands in.
const env = /* glsl */ `
  uniform sampler2D uEnv;
  uniform float uEnvOn;
  uniform float uEnvYaw;
  uniform float uEnvStrength;
  vec3 paintedStudio(vec3 r) {
    float win = smoothstep(0.35, 0.95, dot(r, normalize(vec3(0.55, 0.45, -0.7))));
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
  vec3 studio(vec3 r) {
    vec3 painted = paintedStudio(r);
    if (uEnvOn < 0.5) return painted;
    r = normalize(r);
    float c = cos(uEnvYaw), s = sin(uEnvYaw);
    vec3 d = vec3(c * r.x - s * r.z, r.y, s * r.x + c * r.z);
    vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
    // Warm the photo to match the room, and keep a touch of the painted window for continuity.
    // A slightly blurred sample keeps thin ceiling lights from drawing hard lines on the glass.
    vec3 photo = texture2D(uEnv, uv, 1.5).rgb;
    // The photo is a bright white studio; squaring it keeps the lights and the window bright
    // but drops the walls toward the dark room this scene is set in.
    photo = min(photo * photo * 0.55, vec3(5.0));
    // Ceiling lights matter less than the window and the room at eye level.
    photo *= mix(1.0, 0.35, smoothstep(0.25, 0.8, d.y));
    return photo * vec3(1.0, 0.8, 0.58) * uEnvStrength + painted * 0.3;
  }
`;

// Parts that join the pot body (spout, handle, the tea in the spout) are trimmed where they
// pass inside it, so the joins look clean through the glass. Geometry is in pot space.
const clip = /* glsl */ `
  uniform float uClip;
  uniform float uClipProfile[32];
  uniform float uClipTop;
  varying vec3 vLocal;
  void clipInsideBody() {
    if (uClip < 0.5 || vLocal.y > uClipTop) return;
    float f = clamp(vLocal.y / uClipTop, 0.0, 1.0) * 31.0;
    int i = int(floor(f));
    int j = min(i + 1, 31);
    if (length(vLocal.xz) < mix(uClipProfile[i], uClipProfile[j], fract(f))) discard;
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
    ${clip}
    void main() {
      clipInsideBody();
      vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
      // Hand-blown glass is never perfectly even: a faint waviness bends the reflections.
      vec3 wv = sin(vWorld.yzx * vec3(7.1, 9.3, 8.7) + sin(vWorld.zxy * 5.3) * 1.7);
      N = normalize(N + wv * 0.014);
      vec3 V = normalize(cameraPosition - vWorld);
      float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
      float grazing = 1.0 - ndv;
      float fres = 0.04 + 0.96 * pow(grazing, 5.0);

      // Lensing: the background slides sideways where the glass curves away.
      vec2 suv = gl_FragCoord.xy / uRes;
      vec3 Nv = normalize((viewMatrix * vec4(N, 0.0)).xyz);
      vec2 off = -Nv.xy * uRefract * (0.25 + 1.5 * grazing * grazing);
      // Thick glass at a glancing angle picks up a faint green-grey tint.
      vec3 tint = mix(vec3(0.98, 0.97, 0.94), vec3(0.8, 0.88, 0.84), smoothstep(0.5, 1.0, grazing));
      vec3 bg = refracted(suv, off) * tint;

      vec3 R = reflect(-V, N);
      vec3 refl = studio(R);
      float spec = pow(max(dot(R, normalize(vec3(0.6, 0.7, -0.4))), 0.0), 220.0) * 3.0;

      float lens = smoothstep(0.2, 0.9, grazing);
      vec3 col = mix(bg, refl, clamp(fres * 1.25, 0.0, 1.0));
      // Glass reads by its edges: a dark core line with a warm rim of light inside it.
      float edge = smoothstep(0.84, 0.98, grazing);
      col *= 1.0 - 0.5 * edge;
      col += uGlow * smoothstep(0.55, 0.9, grazing) * (1.0 - edge);
      col += spec;

      // Mostly clear face-on; the reflection itself carries the opacity.
      float reflLum = dot(refl, vec3(0.3, 0.5, 0.2));
      float a = max(lens * 0.72, fres * 0.9) + clamp(reflLum * fres * 0.6, 0.0, 0.5) + spec * 0.4 + 0.01;
      if (!gl_FrontFacing) a *= 0.5;
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
    ${clip}
    void main() {
      clipInsideBody();
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
    uniform sampler2D uWood;
    uniform sampler2D uWoodNor;
    uniform sampler2D uWoodRough;
    uniform float uWoodOn;
    varying vec3 vWorld;
    ${noise}
    ${env}
    void main() {
      vec2 p = vWorld.xz;
      vec2 wuv = vec2(p.x * 0.16, p.y * 0.22);

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
      float rough = 0.5;
      vec3 nts = vec3(0.0, 0.0, 1.0);
      if (uWoodOn > 0.5) {
        // Scanned walnut: colour, surface normal and roughness from real wood.
        wood = texture2D(uWood, wuv).rgb * 0.32;
        nts = texture2D(uWoodNor, wuv * 2.0).rgb * 2.0 - 1.0;
        rough = texture2D(uWoodRough, wuv * 2.0).g;
        seam = 1.0;
      }

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
      vec3 Nw = uWoodOn > 0.5
        ? normalize(vec3(nts.x * 0.6, nts.z, nts.y * 0.6))
        : normalize(vec3((grain - 0.5) * 0.04, 1.0, (rings - 0.5) * 0.03));
      float fres = 0.03 + 0.97 * pow(1.0 - max(dot(Nw, V), 0.0), 5.0);
      col += studio(reflect(-V, Nw)) * fres * 0.07 * seam * (1.2 - rough);

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
      // A falling column of tea is a lens: it flips and tints what is behind it.
      vec3 bg = refracted(suv, -Nv.xy * 0.06);
      float thick = 0.35 + 0.9 * ndv;
      vec3 absorb = exp(-vec3(0.16, 0.9, 2.9) * 1.6 * thick);
      float streak = fbm(vec2(vUv.y * 5.0, vUv.x * 18.0 - uTime * 7.0));
      vec3 col = bg * absorb * 1.2 + vec3(1.0, 0.5, 0.09) * (0.18 + 0.3 * streak) * thick;
      vec3 R = reflect(-V, N);
      col = mix(col, studio(R), pow(1.0 - ndv, 3.0) * 0.8);
      // Bright glints running down the stream.
      col += vec3(1.0, 0.85, 0.6) * pow(max(dot(R, normalize(vec3(0.6, 0.7, -0.4))), 0.0), 30.0) * (0.6 + streak);
      gl_FragColor = vec4(col, 0.92);
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

export const MAX_RIPPLES = 48;
export const PROFILE_SAMPLES = 32;

// A horizontal water surface that ripples where ingredients land and churns as it boils.
// It is clipped to the inside of its vessel (profile + inverse matrix), so it stays level
// in world space even while the pot tilts to pour.
export const surfaceShader = {
  vertexShader: /* glsl */ `
    uniform float uTime;
    uniform float uBoil;
    uniform float uSwirl;
    uniform vec4 uRipples[${MAX_RIPPLES}]; // x, z, age (s), amplitude
    uniform int uRippleCount;
    varying vec3 vWorld;
    varying vec3 vNormal;
    ${noise}
    float heightAt(vec2 p) {
      float h = 0.0;
      for (int i = 0; i < ${MAX_RIPPLES}; i++) {
        if (i >= uRippleCount) break;
        vec4 r = uRipples[i];
        float d = distance(p, r.xy);
        float front = r.z * 0.85;
        float packet = exp(-pow((d - front) / 0.22, 2.0));
        h += r.w * exp(-r.z * 1.6) * packet * sin((d - front) * 32.0);
      }
      // Boiling: churning noise that turns with the swirl.
      float c = cos(uSwirl), s = sin(uSwirl);
      vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
      // Rolling domes where bubbles reach the top, plus a finer shiver.
      h += uBoil * 0.018 * (vnoise(q * 5.0 + uTime * 1.4) - 0.5);
      h += uBoil * 0.004 * (vnoise(q * 11.0 - uTime * 2.1) - 0.5);
      return h;
    }
    void main() {
      vec4 w = modelMatrix * vec4(position, 1.0);
      float e = 0.012;
      float h = heightAt(w.xz);
      float hx = heightAt(w.xz + vec2(e, 0.0));
      float hz = heightAt(w.xz + vec2(0.0, e));
      w.y += h;
      vWorld = w.xyz;
      vNormal = normalize(vec3(-(hx - h) / e, 1.0, -(hz - h) / e));
      gl_Position = projectionMatrix * viewMatrix * w;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uBrew;
    uniform float uDepth;
    uniform float uOpacity;
    uniform mat4 uVesselInv;
    uniform float uProfile[${PROFILE_SAMPLES}];
    uniform float uProfileTop;
    varying vec3 vWorld;
    varying vec3 vNormal;
    ${env}
    ${screen}
    float innerRadius(float y) {
      float f = clamp(y / uProfileTop, 0.0, 1.0) * float(${PROFILE_SAMPLES - 1});
      int i = int(floor(f));
      int j = min(i + 1, ${PROFILE_SAMPLES - 1});
      return mix(uProfile[i], uProfile[j], fract(f));
    }
    void main() {
      vec3 local = (uVesselInv * vec4(vWorld, 1.0)).xyz;
      float R = innerRadius(local.y);
      float r = length(local.xz);
      if (r > R) discard;

      vec3 N = normalize(vNormal);
      vec3 V = normalize(cameraPosition - vWorld);
      float ndv = clamp(dot(N, V), 0.0, 1.0);
      float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

      // Looking down into the tea: the refracted pot and leaves, absorbed by depth.
      vec2 suv = gl_FragCoord.xy / uRes;
      vec3 Nv = normalize((viewMatrix * vec4(N, 0.0)).xyz);
      vec3 bg = refracted(suv, Nv.xy * 0.03);
      vec3 sigma = vec3(0.16, 0.9, 2.9) * (0.4 + 0.8 * uBrew);
      vec3 absorb = exp(-uDepth * 2.2 * sigma * uBrew);
      // Seen from above, brewed tea is a deep amber with the light caught in it.
      vec3 col = bg * mix(vec3(0.94, 0.96, 0.95), absorb * 0.6, uBrew);
      col += vec3(0.8, 0.34, 0.05) * uBrew * 0.1;

      vec3 R3 = reflect(-V, N);
      // The room around the pot is dark, so the surface mirrors mostly shadow and the window's glints.
      vec3 env3 = studio(R3);
      env3 *= 0.18 + 0.82 * smoothstep(1.2, 4.0, dot(env3, vec3(0.33)));
      col = mix(col, env3, clamp(fres * 1.1 + 0.03, 0.0, 1.0));
      col += pow(max(dot(R3, normalize(vec3(0.6, 0.7, -0.4))), 0.0), 300.0) * 4.0;
      // Meniscus: the surface climbs and brightens where it meets the glass.
      float men = smoothstep(R - 0.05, R, r);
      col += vec3(1.0, 0.85, 0.6) * men * 0.35;
      gl_FragColor = vec4(col, uOpacity);
    }
  `,
};

// Rising bubbles: clear spheres that show only their bright rims and a speck of highlight.
export const bubbleShader = {
  vertexShader: /* glsl */ `
    varying vec3 vWorld;
    varying vec3 vNormal;
    void main() {
      mat4 m = modelMatrix * instanceMatrix;
      vec4 w = m * vec4(position, 1.0);
      vWorld = w.xyz;
      vNormal = normalize(mat3(m) * normal);
      gl_Position = projectionMatrix * viewMatrix * w;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uOpacity;
    varying vec3 vWorld;
    varying vec3 vNormal;
    ${env}
    void main() {
      vec3 N = normalize(vNormal);
      vec3 V = normalize(cameraPosition - vWorld);
      float ndv = clamp(dot(N, V), 0.0, 1.0);
      float rim = pow(1.0 - ndv, 2.5);
      vec3 R = reflect(-V, N);
      vec3 col = studio(R) * 0.6 + vec3(1.0, 0.85, 0.6) * rim;
      float spec = pow(max(dot(R, normalize(vec3(0.6, 0.7, -0.4))), 0.0), 60.0);
      col += spec * 2.0;
      gl_FragColor = vec4(col, (rim * 0.85 + spec) * uOpacity);
    }
  `,
};
