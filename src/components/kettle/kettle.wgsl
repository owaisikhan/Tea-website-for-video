// A glass teapot of tea, ray traced in one fragment shader.
//
// The pot is a signed distance field: an ellipsoid body with a flat base, a collar, a spout
// and a handle, all smooth-blended into one piece of glass, hollowed to a real wall thickness
// with a thick base. Each pixel follows its light ray through every interface it meets (air to
// glass, glass to tea, tea to air), bending it by Snell's law, reflecting a share by Fresnel,
// and absorbing colour inside the tea by depth (Beer-Lambert). The spout's channel is part of
// the same cavity, so it holds tea up to the same level as the pot.
//
// Two modes. On /kettle (site = 0) it paints a whole room. On the main site (site = 1) it is a
// transparent layer over the three.js scene: rays are traced in the pot's own frame (the pot
// lifts and tilts to pour), the tea stays level in world space, and whatever lies behind the
// glass is read from the site's own rendered frame (scene_tex) at the right screen position,
// so the leaves and spices inside are seen bent through real glass and tea.

struct Params {
  resolution: vec2f,
  time: f32,
  level: f32, // tea surface height (pot space, base at y = 0)
  cam_pos: vec3f,
  brew: f32, // 0 clear water .. 1 deep amber tea
  cam_fwd: vec3f,
  tan_half_fov: f32,
  cam_right: vec3f,
  lid: f32, // 1 lid on, 0 lid off
  cam_up: vec3f,
  exposure: f32,
  pot_to_world: mat4x4f,
  world_to_pot: mat4x4f,
  site: f32, // 1 when layered over the site's scene
  boil: f32, // 0 calm .. 1 rolling boil on the tea surface
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;
@group(0) @binding(2) var scene_samp: sampler;

fn to_world(p: vec3f) -> vec3f {
  return (params.pot_to_world * vec4f(p, 1.0)).xyz;
}

fn dir_to_world(d: vec3f) -> vec3f {
  return (params.pot_to_world * vec4f(d, 0.0)).xyz;
}

const PI = 3.14159265;
const IOR_GLASS = 1.5;
const IOR_TEA = 1.333;
const AIR = 0;
const GLASS = 1;
const TEA = 2;

// ------------------------------------------------------------------ shape helpers

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

fn smax(a: f32, b: f32, k: f32) -> f32 {
  return -smin(-a, -b, k);
}

fn sd_ellipsoid(p: vec3f, r: vec3f) -> f32 {
  let k0 = length(p / r);
  let k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / k1;
}

// Vertical capped cylinder from y0 to y1.
fn sd_cylinder(p: vec3f, r: f32, y0: f32, y1: f32) -> f32 {
  let h = 0.5 * (y1 - y0);
  let q = vec3f(p.x, p.y - (y0 + h), p.z);
  let d = abs(vec2f(length(q.xz), q.y)) - vec2f(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
}

// Cone with rounded ends between a (radius r1) and b (radius r2).
fn sd_round_cone(p: vec3f, a: vec3f, b: vec3f, r1: f32, r2: f32) -> f32 {
  let ba = b - a;
  let l2 = dot(ba, ba);
  let rr = r1 - r2;
  let a2 = l2 - rr * rr;
  let il2 = 1.0 / l2;
  let pa = p - a;
  let y = dot(pa, ba);
  let z = y - l2;
  let xv = pa * l2 - ba * y;
  let x2 = dot(xv, xv);
  let y2 = y * y * l2;
  let z2 = z * z * l2;
  let k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) {
    return sqrt(x2 + z2) * il2 - r2;
  }
  if (sign(y) * a2 * y2 < k) {
    return sqrt(x2 + y2) * il2 - r1;
  }
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

// ------------------------------------------------------------------ the teapot

const WALL = 0.045;

fn bezier(a: vec3f, b: vec3f, c: vec3f, d: vec3f, t: f32) -> vec3f {
  let u = 1.0 - t;
  return a * (u * u * u) + b * (3.0 * u * u * t) + c * (3.0 * u * t * t) + d * (t * t * t);
}

// A smooth tube along a cubic curve: short tapered cones between curve samples, blended.
fn curved_tube(p: vec3f, a: vec3f, b: vec3f, c: vec3f, d: vec3f, r0: f32, r1: f32, bulge: f32, inset: f32) -> f32 {
  var dist = 1e5;
  var prev = a;
  var prev_r = r0 - inset;
  for (var i = 1; i <= 12; i++) {
    let t = f32(i) / 12.0;
    let q = bezier(a, b, c, d, t);
    let e = abs(2.0 * t - 1.0);
    let r = mix(r0, r1, t * t * (3.0 - 2.0 * t)) + bulge * e * e * e - inset;
    // Neighbouring cones share an end and its radius, so a plain union is already seamless.
    dist = min(dist, sd_round_cone(p, prev, q, prev_r, r));
    prev = q;
    prev_r = r;
  }
  return dist;
}

const SPOUT_A = vec3f(-0.72, 0.5, 0.0);
const SPOUT_B = vec3f(-1.55, 0.6, 0.0);
const SPOUT_C = vec3f(-1.78, 1.28, 0.0);
const SPOUT_D = vec3f(-1.99, 1.64, 0.0);

// Distance to an axis-aligned box: a cheap lower bound used to skip detailed shapes.
fn sd_box(p: vec3f, lo: vec3f, hi: vec3f) -> f32 {
  let c = 0.5 * (lo + hi);
  let q = abs(p - c) - 0.5 * (hi - lo);
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// The spout flares where it leaves the belly and narrows to a fine lip.
fn spout(p: vec3f, inset: f32) -> f32 {
  let b = sd_box(p, vec3f(-2.15, 0.2, -0.3), vec3f(-0.45, 1.8, 0.3));
  if (b > 0.05) {
    return b;
  }
  return curved_tube(p, SPOUT_A, SPOUT_B, SPOUT_C, SPOUT_D, 0.24, 0.072, 0.0, inset);
}

// A looping handle, thicker where it joins the pot.
fn handle(p: vec3f) -> f32 {
  let b = sd_box(p, vec3f(0.75, 0.25, -0.2), vec3f(2.05, 1.9, 0.2));
  if (b > 0.05) {
    return b;
  }
  return curved_tube(p, vec3f(0.9, 1.44, 0.0), vec3f(2.05, 1.8, 0.0), vec3f(2.2, 0.45, 0.0), vec3f(1.0, 0.42, 0.0), 0.075, 0.075, 0.04, 0.0);
}

// Solid outline of the pot (as if it were filled glass).
fn outer_solid(p: vec3f) -> f32 {
  var body = sd_ellipsoid(p - vec3f(0.0, 0.86, 0.0), vec3f(1.26, 0.9, 1.26));
  body = smax(body, -p.y, 0.12); // flat base with a rounded edge
  let collar = sd_cylinder(p, 0.8, 1.45, 1.84) - 0.012;
  var d = smin(body, collar, 0.14);
  d = smin(d, spout(p, 0.0), 0.12);
  d = smin(d, handle(p), 0.09);
  // Open the spout at its tip.
  let tip_dir = normalize(SPOUT_D - bezier(SPOUT_A, SPOUT_B, SPOUT_C, SPOUT_D, 0.9));
  d = max(d, dot(p - SPOUT_D, tip_dir) - 0.01);
  return d;
}

// The inside of the pot: body, collar opening and the spout's channel, one connected vessel.
fn cavity(p: vec3f) -> f32 {
  var inner = sd_ellipsoid(p - vec3f(0.0, 0.86, 0.0), vec3f(1.26 - WALL, 0.9 - WALL, 1.26 - WALL));
  inner = smax(inner, 0.14 - p.y, 0.1); // thick glass base
  let neck = sd_cylinder(p, 0.745, 1.2, 2.6);
  var c = smin(inner, neck, 0.1);
  c = min(c, spout(p, 0.04));
  return c;
}

fn lid(p: vec3f) -> f32 {
  let dome = sd_ellipsoid(p - vec3f(0.0, 1.83, 0.0), vec3f(0.86, 0.3, 0.86));
  var shell = max(abs(dome) - 0.016, 1.83 - p.y);
  let knob = length(p - vec3f(0.0, 2.24, 0.0)) - 0.1;
  let stem = sd_cylinder(p, 0.045, 2.08, 2.2);
  shell = smin(shell, smin(knob, stem, 0.04), 0.05);
  return shell;
}

fn glass_sdf(p: vec3f) -> f32 {
  var g = max(outer_solid(p), -cavity(p));
  if (params.lid > 0.5) {
    g = min(g, lid(p));
  }
  return g;
}

fn tea_sdf(p: vec3f) -> f32 {
  // The surface is level in the world, even while the pot tips to pour.
  let w = to_world(p);
  var ripple = 0.004 * sin(w.x * 11.0 + params.time * 2.0) * sin(w.z * 9.0 - params.time * 1.6);
  ripple += params.boil * 0.012 * (vnoise(w.xz * 6.0 + params.time * 1.5) - 0.5);
  return max(cavity(p), w.y - params.level - ripple);
}

fn medium_at(p: vec3f) -> i32 {
  if (glass_sdf(p) < 0.0) {
    return GLASS;
  }
  if (tea_sdf(p) < 0.0) {
    return TEA;
  }
  return AIR;
}

fn glass_normal(p: vec3f) -> vec3f {
  let e = vec2f(0.0015, 0.0);
  return normalize(vec3f(
    glass_sdf(p + e.xyy) - glass_sdf(p - e.xyy),
    glass_sdf(p + e.yxy) - glass_sdf(p - e.yxy),
    glass_sdf(p + e.yyx) - glass_sdf(p - e.yyx)
  ));
}

fn tea_normal(p: vec3f) -> vec3f {
  let e = vec2f(0.0015, 0.0);
  return normalize(vec3f(
    tea_sdf(p + e.xyy) - tea_sdf(p - e.xyy),
    tea_sdf(p + e.yxy) - tea_sdf(p - e.yxy),
    tea_sdf(p + e.yyx) - tea_sdf(p - e.yyx)
  ));
}

// ------------------------------------------------------------------ the room

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x), mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var s = 0.0;
  var a = 0.5;
  for (var i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

// A warm, dim room: a tall paned window behind and to the right, two strip softboxes for the
// rim light a product photographer would use, and a faint warm ceiling.
fn room(rd: vec3f) -> vec3f {
  var c = mix(vec3f(0.012, 0.008, 0.005), vec3f(0.024, 0.015, 0.008), smoothstep(-0.2, 0.8, rd.y));
  let win_dir = normalize(vec3f(0.55, 0.32, -0.77));
  let w = dot(rd, win_dir);
  if (w > 0.8) {
    // Project onto the window plane for panes.
    let right = normalize(cross(win_dir, vec3f(0.0, 1.0, 0.0)));
    let up = cross(right, win_dir);
    let q = vec2f(dot(rd, right), dot(rd, up)) / w;
    let frame = step(abs(q.x), 0.36) * step(abs(q.y), 0.5);
    let bars = smoothstep(0.012, 0.02, abs(fract(q.x * 2.8 + 0.5) - 0.5)) * smoothstep(0.012, 0.02, abs(fract(q.y * 2.0 + 0.5) - 0.5));
    c += vec3f(1.0, 0.78, 0.5) * 5.0 * frame * bars;
  }
  // The window's glow fades out smoothly in every direction.
  c += vec3f(1.0, 0.7, 0.4) * 0.6 * exp(-pow(max(1.0 - w, 0.0) * 9.0, 2.0));
  // Softboxes: tall bright strips left-front and right-back.
  let s1 = normalize(vec3f(-0.85, 0.15, 0.5));
  let a1 = rd - s1 * dot(rd, s1);
  if (dot(rd, s1) > 0.0) {
    c += vec3f(1.0, 0.93, 0.85) * 3.2 * smoothstep(0.1, 0.07, abs(dot(a1, normalize(cross(s1, vec3f(0.0, 1.0, 0.0)))))) * smoothstep(0.55, 0.4, abs(rd.y - 0.15));
  }
  let s2 = normalize(vec3f(0.9, 0.2, 0.35));
  let a2 = rd - s2 * dot(rd, s2);
  if (dot(rd, s2) > 0.0) {
    c += vec3f(1.0, 0.85, 0.65) * 1.8 * smoothstep(0.07, 0.05, abs(dot(a2, normalize(cross(s2, vec3f(0.0, 1.0, 0.0)))))) * smoothstep(0.5, 0.35, abs(rd.y - 0.2));
  }
  return c;
}

// Dark walnut table under the pot, with the pot's soft shadow and the amber light its tea throws.
fn table(p: vec3f, rd: vec3f) -> vec3f {
  let q = vec2f(p.x * 0.35, p.z * 4.0);
  let warp = vec2f(fbm(q * 0.7), fbm(q * 0.7 + 5.2));
  let grain = fbm(q + warp * 1.8);
  let rings = 0.5 + 0.5 * sin((p.z * 6.0 + warp.x * 7.0) * 2.5);
  var wood = mix(vec3f(0.035, 0.018, 0.009), vec3f(0.13, 0.066, 0.03), grain);
  wood = mix(wood, wood * 1.35, rings * 0.25);
  let r = length(p.xz);
  var col = wood * (0.35 + 1.1 * exp(-r * r * 0.12));
  col *= 0.35 + 0.65 * smoothstep(0.7, 1.9, r); // contact shadow
  // Light that passed through the tea lands on the table as an amber caustic.
  let caustic = fbm(p.xz * 4.0 + vec2f(params.time * 0.1, 0.0));
  col += vec3f(1.0, 0.5, 0.1) * params.brew * caustic * exp(-pow(length(p.xz - vec2f(0.5, 0.35)), 2.0) * 1.6) * 0.5;
  // Varnish reflects the room.
  let fres = 0.03 + 0.97 * pow(1.0 - abs(rd.y), 5.0);
  col += room(reflect(rd, vec3f(0.0, 1.0, 0.0))) * fres * 0.25;
  // Far away the table melts into the dark room rather than ending at a line.
  return mix(room(rd), col, smoothstep(9.0, 3.0, r));
}

// three.js's ACES filmic tone mapping (the site's OutputPass) and its exact inverse, plus
// exact sRGB transfer. Light read back from the site's finished frame goes through the inverse
// before it passes through the glass and the forward curve after, so anything seen through
// the glass keeps exactly the colours the site gave it.
const ACES_IN = mat3x3f(vec3f(0.59719, 0.07600, 0.02840), vec3f(0.35458, 0.90834, 0.13383), vec3f(0.04823, 0.01566, 0.83777));
const ACES_OUT = mat3x3f(vec3f(1.60475, -0.10208, -0.00327), vec3f(-0.53108, 1.10813, -0.07276), vec3f(-0.07367, -0.00605, 1.07602));
const ACES_IN_INV = mat3x3f(vec3f(1.764741, -0.147028, -0.036337), vec3f(-0.675778, 1.160252, -0.162436), vec3f(-0.088963, -0.013224, 1.198773));
const ACES_OUT_INV = mat3x3f(vec3f(0.643038, 0.059269, 0.005962), vec3f(0.311187, 0.931436, 0.063929), vec3f(0.045775, 0.009295, 0.930118));

fn three_aces(c: vec3f) -> vec3f {
  let v = ACES_IN * (c * params.exposure / 0.6);
  let fit = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  return clamp(ACES_OUT * fit, vec3f(0.0), vec3f(1.0));
}

fn three_aces_inverse(y0: vec3f) -> vec3f {
  let y = clamp(ACES_OUT_INV * y0, vec3f(0.0), vec3f(0.98));
  // Solve (y c - 1) v^2 + (y d - a) v + (y e + b) = 0 for the fitted curve's positive root.
  let qa = y * 0.983729 - 1.0;
  let qb = y * 0.4329510 - 0.0245786;
  let qc = y * 0.238081 + 0.000090537;
  let v = (-qb - sqrt(max(qb * qb - 4.0 * qa * qc, vec3f(0.0)))) / (2.0 * qa);
  return max(ACES_IN_INV * v, vec3f(0.0)) * 0.6 / params.exposure;
}

fn srgb_decode(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

fn srgb_encode(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

fn vignette(uv: vec2f) -> f32 {
  let d = uv - 0.5;
  return 1.0 - dot(d, d) * 1.1;
}

// The site's frame at the screen position of world point q, as scene light.
fn scene_at(q: vec3f) -> vec3f {
  let v = q - params.cam_pos;
  let z = max(dot(v, params.cam_fwd), 0.05);
  let aspect = params.resolution.x / params.resolution.y;
  let sx = dot(v, params.cam_right) / (z * params.tan_half_fov * aspect);
  let sy = dot(v, params.cam_up) / (z * params.tan_half_fov);
  let uv = clamp(vec2f(sx * 0.5 + 0.5, 0.5 - sy * 0.5), vec2f(0.001), vec2f(0.999));
  let shown = textureSampleLevel(scene_tex, scene_samp, uv, 0.0).rgb;
  // The site applies its vignette before tone mapping, so undo them in reverse order.
  return three_aces_inverse(srgb_decode(shown)) / max(vignette(uv), 0.2);
}

// What a ray sees once it has left the glass. ro and rd are in pot space.
fn background(ro: vec3f, rd: vec3f) -> vec3f {
  let wo = to_world(ro);
  let wd = normalize(dir_to_world(rd));
  if (params.site > 0.5) {
    if (wd.y < -0.0001 && wo.y > 0.0) {
      return scene_at(wo + wd * (-wo.y / wd.y));
    }
    return scene_at(wo + wd * 8.0);
  }
  if (wd.y < -0.0001) {
    let t = -wo.y / wd.y;
    if (t > 0.0) {
      return table(wo + wd * t, wd);
    }
  }
  return room(wd);
}

// What a reflection sees. A flat frame cannot show what is behind the camera, so reflections
// use the studio room (window, softboxes) in both modes; only the table below comes from
// the site's frame, where it is on screen.
fn reflection(ro: vec3f, rd: vec3f) -> vec3f {
  let wo = to_world(ro);
  let wd = normalize(dir_to_world(rd));
  if (params.site > 0.5) {
    if (wd.y < -0.0001 && wo.y > 0.0) {
      return scene_at(wo + wd * (-wo.y / wd.y));
    }
    return room(wd) * 1.4;
  }
  return background(ro, rd);
}

// ------------------------------------------------------------------ light transport

fn fresnel(cos_i: f32, n1: f32, n2: f32) -> f32 {
  let r0 = pow((n1 - n2) / (n1 + n2), 2.0);
  return r0 + (1.0 - r0) * pow(1.0 - cos_i, 5.0);
}

fn ior_of(m: i32) -> f32 {
  if (m == GLASS) {
    return IOR_GLASS;
  }
  if (m == TEA) {
    return IOR_TEA;
  }
  return 1.0;
}

// Site mode, once a ray is inside the pot. The leaves and spices exist only in the site's frame,
// so: cross the air above the tea to its surface (reflecting a share of light off it), bend into
// the tea, measure how much tea lies ahead, and read the contents about halfway in, tinted by
// the tea in front of them, plus the amber glow of window light scattering through the tea.
fn inside_view(ro: vec3f, rd: vec3f, medium: i32, through0: vec3f, tea_sigma: vec3f) -> vec3f {
  var p = ro;
  var d = rd;
  var through = through0;
  var col = vec3f(0.0);
  if (medium == AIR) {
    var t = 0.0;
    var wet = false;
    for (var i = 0; i < 48; i++) {
      let q = p + d * t;
      let w = tea_sdf(q);
      if (w < 0.002) {
        wet = true;
        break;
      }
      let c = cavity(q);
      if (c > 0.0) {
        break;
      }
      t += max(min(-c, w), 0.01);
    }
    if (!wet) {
      // Above the tea (leaves falling in, or the pot's far side).
      return through * scene_at(to_world(p + d * min(t * 0.5, 0.8)));
    }
    let q = p + d * t;
    var n = tea_normal(q);
    if (dot(n, d) > 0.0) {
      n = -n;
    }
    let f = fresnel(clamp(-dot(d, n), 0.0, 1.0), 1.0, IOR_TEA);
    col += through * f * reflection(q + n * 0.004, reflect(d, n));
    through *= 1.0 - f;
    let r = refract(d, n, 1.0 / IOR_TEA);
    if (dot(r, r) > 0.0001) {
      d = r;
    }
    p = q - n * 0.003;
  }
  // In the tea: how far to the other side?
  var len = 0.0;
  for (var i = 0; i < 48; i++) {
    let w = tea_sdf(p + d * len);
    if (w > 0.0) {
      break;
    }
    len += max(-w, 0.01);
  }
  let depth = min(len * 0.45, 0.9);
  col += through * exp(-tea_sigma * depth) * scene_at(to_world(p + d * depth));
  let glow = 1.0 - exp(-dot(tea_sigma, vec3f(0.333)) * len);
  col += through * glow * vec3f(0.95, 0.5, 0.1) * 0.22 * params.brew;
  return col;
}

// Returns light (rgb) and whether the ray touched the pot at all (a).
fn trace(ro0: vec3f, rd0: vec3f) -> vec4f {
  var ro = ro0;
  var rd = rd0;
  var color = vec3f(0.0);
  var through = vec3f(1.0);
  // Start the march where the ray enters the pot's bounding sphere; miss it and see the room.
  let centre = vec3f(-0.1, 1.0, 0.0);
  let bound = 2.6;
  let oc = ro - centre;
  let bq = dot(oc, rd);
  let disc = bq * bq - (dot(oc, oc) - bound * bound);
  if (disc < 0.0) {
    return vec4f(background(ro, rd), 0.0);
  }
  let t_enter = max(0.0, -bq - sqrt(disc));
  ro = ro + rd * t_enter;
  var medium = medium_at(ro);
  var t = 0.0;
  var hits = 0;
  var touched = 0.0;
  // Brewed tea absorbs blue strongly and green less, leaving amber; clear water barely at all.
  // Light crosses the whole pot, so keep it thin enough to see the leaves inside: golden amber.
  let tea_sigma = mix(vec3f(0.02, 0.02, 0.03), vec3f(0.16, 0.62, 1.9), params.brew);
  let glass_sigma = vec3f(0.06, 0.02, 0.05);

  for (var i = 0; i < 260; i++) {
    let p = ro + rd * t;
    let g = glass_sdf(p);
    let w = tea_sdf(p);
    var d: f32;
    if (medium == GLASS) {
      d = -g;
    } else if (medium == TEA) {
      d = min(-w, g);
    } else {
      d = min(g, w);
    }
    // Nothing more to hit: this ray leaves the pot's neighbourhood.
    let away = p - centre;
    let wp = to_world(p);
    let wdir = dir_to_world(rd);
    if (medium == AIR && wp.y <= 0.0005 && wdir.y < 0.0) {
      color += through * background(p, rd);
      return vec4f(color, touched);
    }
    if (medium == AIR && dot(away, away) > bound * bound + 0.01 && dot(away, rd) > 0.0) {
      color += through * background(p, rd);
      return vec4f(color, touched);
    }
    if (d > 0.0008) {
      var step = max(d, 0.002);
      // Never step through the table top.
      if (medium == AIR && wdir.y < 0.0) {
        step = min(step, max(wp.y / -wdir.y, 0.0) + 0.0002);
      }
      t += step;
      continue;
    }

    // At an interface: work out which medium lies beyond it.
    let beyond = medium_at(p + rd * 0.004);
    if (beyond == medium) {
      t += 0.004;
      continue;
    }
    // Absorb along the whole segment just travelled.
    if (medium == TEA) {
      through *= exp(-tea_sigma * t);
    } else if (medium == GLASS) {
      through *= exp(-glass_sigma * t);
    }
    var n: vec3f;
    if (medium == GLASS || beyond == GLASS) {
      n = glass_normal(p);
    } else {
      n = tea_normal(p);
    }
    if (dot(n, rd) > 0.0) {
      n = -n;
    }
    let n1 = ior_of(medium);
    let n2 = ior_of(beyond);
    let cos_i = clamp(-dot(rd, n), 0.0, 1.0);
    let f = fresnel(cos_i, n1, n2);
    let refl = reflect(rd, n);
    let refr = refract(rd, n, n1 / n2);

    // Reflections off the outside of the glass and off the tea are what the eye reads as shine.
    color += through * f * reflection(p + n * 0.004, refl);
    if (dot(refr, refr) < 0.0001) {
      // Total internal reflection: stay in this medium, going the other way.
      ro = p + n * 0.003;
      rd = refl;
    } else {
      through *= 1.0 - f;
      ro = p - n * 0.003;
      rd = refr;
      medium = beyond;
      // On the site, the leaves and spices inside the pot only exist in the site's frame. Once
      // the ray is inside the pot (in the tea, or the air above it), read that frame at a point
      // among the contents, seen through the tea in front of them, and stop there.
      if (params.site > 0.5 && (medium == TEA || (medium == AIR && cavity(ro) < 0.0))) {
        color += inside_view(ro, rd, medium, through, tea_sigma);
        return vec4f(color, 1.0);
      }
    }
    t = 0.0;
    hits += 1;
    touched = 1.0;
    if (hits > 14 || max(through.x, max(through.y, through.z)) < 0.01) {
      break;
    }
  }
  color += through * background(ro, rd);
  return vec4f(color, touched);
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let aspect = params.resolution.x / params.resolution.y;
  let rd = normalize(
    params.cam_fwd +
    params.cam_right * ndc.x * params.tan_half_fov * aspect +
    params.cam_up * ndc.y * params.tan_half_fov
  );
  // Trace in the pot's frame.
  let ro = (params.world_to_pot * vec4f(params.cam_pos, 1.0)).xyz;
  let rdl = normalize((params.world_to_pot * vec4f(rd, 0.0)).xyz);
  let r = trace(ro, rdl);
  if (params.site > 0.5 && r.a < 0.5) {
    // Not the pot: leave the site's own pixel showing.
    return vec4f(0.0);
  }
  if (params.site > 0.5) {
    // Same finish as the site: vignette, three.js ACES, sRGB.
    return vec4f(srgb_encode(three_aces(r.rgb * vignette(uv))), 1.0);
  }
  var col = r.rgb * params.exposure;
  let v = uv - 0.5;
  col *= 1.0 - dot(v, v) * 0.9;
  col = aces(col);
  col = pow(col, vec3f(1.0 / 2.2));
  return vec4f(col, 1.0);
}
