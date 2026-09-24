// A glass teapot of tea, ray traced in one fragment shader.
//
// The pot is a signed distance field: an ellipsoid body with a flat base, a collar, a spout
// and a handle, all smooth-blended into one piece of glass, hollowed to a real wall thickness
// with a thick base. Each pixel follows its light ray through every interface it meets (air to
// glass, glass to tea, tea to air), bending it by Snell's law, reflecting a share by Fresnel,
// and absorbing colour inside the tea by depth (Beer-Lambert). The spout's channel is part of
// the same cavity, so it holds tea up to the same level as the pot.

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
}

@group(0) @binding(0) var<uniform> params: Params;

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
  let ripple = 0.004 * sin(p.x * 11.0 + params.time * 2.0) * sin(p.z * 9.0 - params.time * 1.6);
  return max(cavity(p), p.y - params.level - ripple);
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

fn background(ro: vec3f, rd: vec3f) -> vec3f {
  if (rd.y < -0.0001) {
    let t = -ro.y / rd.y;
    if (t > 0.0) {
      return table(ro + rd * t, rd);
    }
  }
  return room(rd);
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

fn trace(ro0: vec3f, rd0: vec3f) -> vec3f {
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
    return background(ro, rd);
  }
  let t_enter = max(0.0, -bq - sqrt(disc));
  ro = ro + rd * t_enter;
  var medium = medium_at(ro);
  var t = 0.0;
  var hits = 0;
  // Brewed tea absorbs blue strongly and green less, leaving amber; clear water barely at all.
  let tea_sigma = mix(vec3f(0.02, 0.02, 0.03), vec3f(0.35, 1.25, 3.6), params.brew);
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
    if (medium == AIR && p.y <= 0.0005 && rd.y < 0.0) {
      color += through * table(vec3f(p.x, 0.0, p.z), rd);
      return color;
    }
    if (medium == AIR && dot(away, away) > bound * bound + 0.01 && dot(away, rd) > 0.0) {
      color += through * background(p, rd);
      return color;
    }
    if (d > 0.0008) {
      var step = max(d, 0.002);
      // Never step through the table top.
      if (medium == AIR && rd.y < 0.0) {
        step = min(step, max(p.y / -rd.y, 0.0) + 0.0002);
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
    color += through * f * background(p + n * 0.004, refl);
    if (dot(refr, refr) < 0.0001) {
      // Total internal reflection: stay in this medium, going the other way.
      ro = p + n * 0.003;
      rd = refl;
    } else {
      through *= 1.0 - f;
      ro = p - n * 0.003;
      rd = refr;
      medium = beyond;
    }
    t = 0.0;
    hits += 1;
    if (hits > 14 || max(through.x, max(through.y, through.z)) < 0.01) {
      break;
    }
  }
  color += through * background(ro, rd);
  return color;
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
  var col = trace(params.cam_pos, rd) * params.exposure;
  // Gentle vignette, film tone curve, display gamma.
  let v = uv - 0.5;
  col *= 1.0 - dot(v, v) * 0.9;
  col = aces(col);
  col = pow(col, vec3f(1.0 / 2.2));
  return vec4f(col, 1.0);
}
