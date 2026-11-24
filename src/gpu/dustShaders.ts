import * as d from 'typegpu/data';

/**
 * GPU light layer: schemas, constants and WGSL.
 *
 * Pure data + strings (no React Native imports) so the same shaders can be validated and rendered
 * headlessly outside the app.
 */

/** Total particles. [0, AMBIENT) are the always-alive motes; the rest is a ring pool for bursts. */
export const COUNT = 16384;
export const AMBIENT = 512;
export const POOL = COUNT - AMBIENT;
export const WORKGROUP = 64;
/** Spawn requests per frame (uniform array). */
export const MAX_EMIT = 24;

/** Particle kinds (how a particle moves and looks). */
export const Kind = {
  Mote: 0,
  Ember: 1,
  Spark: 2,
  Glitter: 3,
  Stream: 4,
  Puff: 5,
  Shell: 6,
  Flare: 7,
  Flash: 8,
} as const;

/** Spawn programs (what an emitter request creates). */
export const Prog = {
  Spark: 1,
  Ember: 2,
  Glitter: 3,
  Flash: 4,
  Puff: 5,
  Stream: 6,
  Shell: 7,
  Flare: 8,
  Rain: 9,
  Trail: 10,
  Sparkle: 11,
  /** motes climbing the loot beam over a claimed cell, in the treasure's colour */
  Rise: 12,
} as const;

/**
 * Longest life (s, at lifeScale 1) a program can roll, used by the CPU to know when every burst
 * particle is dead so the burst pool, the bloom chain and the composite can be skipped.
 */
export const PROG_MAX_LIFE = [0, 0.64, 1.9, 2.6, 0.26, 1.6, 1.08, 1, 1.6, 3.4, 0.66, 0.96, 1.5];

/** Colour ramps (life: white-hot → tint → deep tint → fade). */
export const Pal = { Gold: 0, Rose: 1, Ice: 2, Lavender: 3, Emerald: 4, Azure: 5, Mixed: -1 } as const;

export const Particle = d
  .struct({
    pos: d.vec2f,
    vel: d.vec2f,
    /** per-kind data: (gravity, drag, curl, flash gain) · stream: (start.xy, control.xy) */
    aux: d.vec4f,
    life: d.f32,
    maxLife: d.f32,
    size: d.f32,
    seed: d.f32,
    kind: d.u32,
    tint: d.f32,
  })
  .$name('Particle');

/** a = (start, count, program, seed) · b = (x, y, p0, p1) · c = (palette, size, life, extra) */
export const Emitter = d.struct({ a: d.vec4f, b: d.vec4f, c: d.vec4f }).$name('Emitter');

export const Params = d
  .struct({
    /** (time s, dt s, viewW, viewH) */
    clock: d.vec4f,
    /** (mote density 0..1, mote gain, wind pt/s, wheel pivot y) */
    ambient: d.vec4f,
    /** (wheel cx, wheel number radius, wheel band, 0) */
    wheel: d.vec4f,
    /** (counter x, counter y, grid x0, grid y0) */
    goal: d.vec4f,
    /** (grid x1, grid y1, emitter count, bloom gain) */
    misc: d.vec4f,
    /** world camera, as the Skia stage applies it: (pivot x + shake x, pivot y + shake y, roll, zoom) */
    cam: d.vec4f,
    /** (camera pivot x, camera pivot y, 0, 0) */
    pivot: d.vec4f,
    em: d.arrayOf(Emitter, MAX_EMIT),
  })
  .$name('Params');

export const HEADER_FLOATS = 28;
export const EMITTER_FLOATS = 12;
export const PARAM_FLOATS = HEADER_FLOATS + MAX_EMIT * EMITTER_FLOATS;

const kindConsts = Object.entries(Kind)
  .map(([k, v]) => `const K_${k.toUpperCase()}: u32 = ${v}u;`)
  .join('\n');
const progConsts = Object.entries(Prog)
  .map(([k, v]) => `const E_${k.toUpperCase()}: u32 = ${v}u;`)
  .join('\n');

const COMMON = /* wgsl */ `
const TAU: f32 = 6.2831853;
const PI: f32 = 3.14159265;
const AMBIENT: u32 = ${AMBIENT}u;
const MAX_EMIT: u32 = ${MAX_EMIT}u;
${kindConsts}
${progConsts}

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rnd(s: ptr<function, u32>) -> f32 {
  *s = pcg(*s);
  return f32(*s) * (1.0 / 4294967296.0);
}

// Stream function of a few drifting sine waves; its curl is divergence-free, so the dust swirls
// and folds without bunching up or thinning out.
fn psi(p: vec2f, t: f32) -> f32 {
  return sin(p.x * 1.7 + t * 0.9) * cos(p.y * 1.3 - t * 0.6)
       + 0.5 * sin(p.x * 3.1 - p.y * 2.3 + t * 1.7)
       + 0.25 * cos(p.x * 5.3 + p.y * 4.1 - t * 2.3);
}

fn curl(p: vec2f, t: f32) -> vec2f {
  let e = 0.01;
  let dx = (psi(p + vec2f(0.0, e), t) - psi(p - vec2f(0.0, e), t)) / (2.0 * e);
  let dy = (psi(p + vec2f(e, 0.0), t) - psi(p - vec2f(e, 0.0), t)) / (2.0 * e);
  return vec2f(dx, -dy);
}

// Colour over life: white-hot → pale tint → tint → deep tint (the fade is applied as alpha).
fn ramp(age: f32, pal: f32) -> vec3f {
  var k1 = vec3f(1.0, 0.914, 0.69);     // #FFE9B0 pale gold
  var k2 = vec3f(0.969, 0.788, 0.282);  // #F7C948 gold
  var k3 = vec3f(1.0, 0.604, 0.235);    // #FF9A3C amber
  if (pal > 0.5 && pal < 1.5) {
    k1 = vec3f(1.0, 0.82, 0.87);
    k2 = vec3f(1.0, 0.478, 0.612);      // #FF7A9C rose
    k3 = vec3f(0.86, 0.26, 0.47);
  } else if (pal > 1.5 && pal < 2.5) {
    k1 = vec3f(0.95, 0.96, 1.0);
    k2 = vec3f(0.902, 0.918, 1.0);      // #E6EAFF ice
    k3 = vec3f(0.56, 0.66, 1.0);
  } else if (pal > 2.5 && pal < 3.5) {
    k1 = vec3f(0.93, 0.92, 1.0);        // silver
    k2 = vec3f(0.79, 0.75, 1.0);        // lavender
    k3 = vec3f(0.6, 0.56, 0.86);
  } else if (pal > 3.5 && pal < 4.5) {
    k1 = vec3f(0.86, 1.0, 0.9);
    k2 = vec3f(0.36, 1.0, 0.56);        // emerald
    k3 = vec3f(0.1, 0.68, 0.36);
  } else if (pal > 4.5) {
    k1 = vec3f(0.88, 0.94, 1.0);
    k2 = vec3f(0.46, 0.67, 1.0);        // sapphire
    k3 = vec3f(0.22, 0.38, 0.95);
  }
  let a = clamp(age, 0.0, 1.0);
  if (a < 0.08) {
    return mix(vec3f(1.0, 0.97, 0.88), k1, a / 0.08);
  }
  if (a < 0.32) {
    return mix(k1, k2, (a - 0.08) / 0.24);
  }
  return mix(k2, k3, clamp((a - 0.32) / 0.45, 0.0, 1.0));
}
`;

/** Compute: spawn (from the uniform emitter list) + integrate, one thread per particle. */
export const SIM_WGSL = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> params: Params;

fn spawnMote(i: u32, first: bool, t: f32) -> Particle {
  var p: Particle;
  var s = pcg((i * 2654435761u) ^ bitcast<u32>(t + 1.0));
  let view = params.clock.zw;
  p.pos = vec2f(rnd(&s) * view.x, rnd(&s) * view.y);
  p.maxLife = 7.0 + 8.0 * rnd(&s);
  let warm = p.maxLife * (0.1 + 0.9 * rnd(&s));
  p.life = select(p.maxLife, warm, first);
  p.vel = vec2f(0.0, -10.0);
  let r = rnd(&s);
  p.size = 0.7 + 1.6 * r * r;
  p.seed = rnd(&s);
  p.kind = K_MOTE;
  p.tint = 0.0;
  p.aux = vec4f(rnd(&s), rnd(&s), 0.0, 0.0);
  return p;
}

// Centre line of the wheel's number band at screen x (the band is an arc of a huge circle).
fn wheelY(x: f32) -> f32 {
  let dx = x - params.wheel.x;
  let rn = params.wheel.y;
  return params.ambient.w - sqrt(max(rn * rn - dx * dx, 0.0));
}

fn stepMote(pin: Particle, i: u32, dt: f32, t: f32) -> Particle {
  var p = pin;
  let view = params.clock.zw;
  if (p.maxLife <= 0.0 || p.life <= 0.0 || p.pos.y < -24.0 || p.pos.y > view.y + 40.0) {
    p = spawnMote(i, p.maxLife <= 0.0, t);
  }
  let rise = 8.0 + 20.0 * p.aux.y;
  var goal = vec2f(0.0, -rise) + curl(p.pos * 0.0065, t * 0.07) * 16.0;
  // The air reacts to the wheel: motes near its band are swept along with the numbers.
  let band = max(params.wheel.z, 1.0);
  let dy = (p.pos.y - wheelY(p.pos.x)) / band;
  let close = exp(-dy * dy * 1.4) + 0.3 * exp(-dy * dy * 0.12);
  let wind = params.ambient.z;
  goal.x = goal.x + wind * close;
  let rate = 1.1 + 3.5 * close * min(abs(wind) / 240.0, 1.0);
  p.vel = mix(p.vel, goal, 1.0 - exp(-dt * rate));
  p.pos = p.pos + p.vel * dt;
  p.life = p.life - dt;
  if (p.pos.x < -16.0) {
    p.pos.x = p.pos.x + view.x + 32.0;
  } else if (p.pos.x > view.x + 16.0) {
    p.pos.x = p.pos.x - view.x - 32.0;
  }
  return p;
}

fn spawn(em: Emitter, i: u32, j: u32) -> Particle {
  var p: Particle;
  var s = pcg((i * 1664525u) ^ u32(em.a.w * 16777215.0));
  let r1 = rnd(&s);
  let r2 = rnd(&s);
  let r3 = rnd(&s);
  let r4 = rnd(&s);
  let r5 = rnd(&s);
  let prog = u32(em.a.z + 0.5);
  let count = max(em.a.y, 1.0);
  // evenly spaced around a ring (with a little jitter) for ring-shaped programs
  let u = (f32(j) + 0.5 + (r5 - 0.5) * 0.7) / count;
  let origin = em.b.xy;
  let power = em.b.z;
  let spread = em.b.w;
  let sz = em.c.y;
  let lifeK = em.c.z;
  let extra = em.c.w;
  let a1 = r1 * TAU;
  let d1 = vec2f(cos(a1), sin(a1));
  let view = params.clock.zw;

  p.pos = origin;
  p.vel = vec2f(0.0);
  p.aux = vec4f(0.0);
  p.size = sz;
  p.maxLife = lifeK;
  p.seed = r4;
  p.tint = em.c.x;
  p.kind = K_EMBER;

  if (prog == E_SPARK) {
    // fast ring of velocity-stretched sparks: gravity + drag
    let a = u * TAU + (r1 - 0.5) * 0.12;
    let dir = vec2f(cos(a), sin(a));
    let speed = (380.0 + 520.0 * pow(r2, 1.6)) * power;
    p.kind = K_SPARK;
    p.pos = origin + dir * spread * (0.8 + 0.2 * r3);
    p.vel = dir * speed + vec2f(0.0, -80.0 * power);
    p.maxLife = (0.26 + 0.36 * r3) * lifeK;
    p.size = (0.6 + 0.7 * r4) * sz;
    p.aux = vec4f(980.0, 3.0, 0.0, 0.0);
  } else if (prog == E_EMBER) {
    // slower embers riding the curl-noise flow, a little buoyant
    let speed = (50.0 + 330.0 * r2 * r2) * power;
    p.kind = K_EMBER;
    p.pos = origin + d1 * spread * sqrt(r3);
    p.vel = d1 * speed + vec2f(0.0, -70.0 * power);
    p.maxLife = (0.9 + 1.0 * r3) * lifeK;
    p.size = (0.9 + 2.0 * r4 * r4 * r4) * sz;
    p.aux = vec4f(-60.0, 2.3, 240.0, 0.0);
  } else if (prog == E_GLITTER) {
    // star glints thrown upwards, then they flutter down twinkling
    let a = -0.5 * PI + (r1 - 0.5) * PI * 1.6;
    let dir = vec2f(cos(a), sin(a));
    let speed = (40.0 + 260.0 * r2 * r2) * power;
    p.kind = K_GLITTER;
    p.pos = origin + dir * spread * r3;
    p.vel = dir * speed;
    p.maxLife = (1.3 + 1.3 * r3) * lifeK;
    p.size = (2.4 + 3.6 * r4 * r4) * sz;
    p.aux = vec4f(70.0, 2.6, 60.0, 0.0);
  } else if (prog == E_FLASH) {
    p.kind = K_FLASH;
    p.maxLife = 0.26 * lifeK;
    p.aux = vec4f(0.0, 0.0, 0.0, extra);
  } else if (prog == E_PUFF) {
    if (f32(j) < count * 0.25) {
      // soft blobs
      p.kind = K_PUFF;
      p.pos = origin + d1 * spread * 0.6 * r3;
      p.vel = d1 * (14.0 + 26.0 * r2);
      p.size = (8.0 + 10.0 * r4) * sz;
      p.maxLife = (1.0 + 0.5 * r3) * lifeK;
      p.aux = vec4f(-14.0, 1.5, 40.0, 0.0);
    } else {
      // silver specks
      p.kind = K_EMBER;
      p.pos = origin + d1 * spread * 0.5 * r3;
      p.vel = d1 * (30.0 + 70.0 * r2) * power + vec2f(0.0, -25.0);
      p.size = (0.8 + 1.2 * r4) * sz;
      p.maxLife = (0.9 + 0.7 * r3) * lifeK;
      p.aux = vec4f(-20.0, 2.0, 120.0, 0.0);
    }
  } else if (prog == E_STREAM) {
    // a mote on a curved path from the cell into the counter (positioned explicitly)
    let start = origin + (vec2f(r1, r2) - 0.5) * spread * 1.4;
    let goal = params.goal.xy;
    let delta = goal - start;
    let len = max(length(delta), 1.0);
    let perp = vec2f(-delta.y, delta.x) / len;
    let ctrl = start + delta * (0.42 + 0.16 * r3) + perp * len * (extra * (0.5 + 0.7 * r5) + (r2 - 0.5) * 0.18)
             + vec2f(0.0, -0.2 * len);
    p.kind = K_STREAM;
    p.pos = start;
    p.aux = vec4f(start, ctrl);
    p.maxLife = lifeK * (0.92 + 0.16 * r3);
    p.size = (0.7 + 1.1 * r4 * r4) * sz;
  } else if (prog == E_SHELL) {
    // firework shell: exact ballistic flight, explodes (CPU-scheduled) when its life ends
    p.kind = K_SHELL;
    p.vel = em.b.zw;
    p.maxLife = lifeK;
    p.aux = vec4f(extra, 0.0, 0.0, 0.0);
  } else if (prog == E_FLARE) {
    // ring burst: outer ring in the main palette, inner ring (every third) in the second one
    let inner = (j % 3u) == 0u;
    let a = u * TAU + (r1 - 0.5) * 0.05;
    let dir = vec2f(cos(a), sin(a));
    // a sphere of stars seen from the front: rim-heavy, but with depth inside the ring
    let z = r2 * 2.0 - 1.0;
    let speed = extra * select(1.0, 0.56, inner) * mix(sqrt(max(1.0 - z * z, 0.0)), 1.0, 0.45);
    p.kind = K_FLARE;
    p.vel = dir * speed + vec2f(0.0, -20.0);
    p.maxLife = (1.0 + 0.6 * r3) * lifeK;
    p.size = (1.2 + 1.0 * r4) * sz;
    p.tint = select(em.c.x, em.b.w, inner);
    p.aux = vec4f(150.0, 1.7, 0.0, 0.0);
  } else if (prog == E_RAIN) {
    // glitter rain over the whole screen
    let pick = fract(r1 * 17.0 + r2 * 31.0);
    p.kind = K_GLITTER;
    p.pos = vec2f(r1 * view.x, -30.0 + r2 * (view.y * 0.62 + 30.0));
    p.vel = vec2f((r3 - 0.5) * 30.0, 70.0 + 90.0 * r4);
    p.maxLife = (2.0 + 1.4 * r5) * lifeK;
    p.size = (1.8 + 3.0 * r4 * r4) * sz;
    p.tint = select(select(2.0, 1.0, pick < 0.82), 0.0, pick < 0.62);
    p.aux = vec4f(40.0, 0.35, 40.0, 0.0);
  } else if (prog == E_TRAIL) {
    // embers shed by a rising shell
    p.kind = K_EMBER;
    p.pos = origin + d1 * 1.5 * r3;
    p.vel = d1 * (20.0 + 50.0 * r2) + vec2f(0.0, 30.0);
    p.maxLife = (0.3 + 0.36 * r3) * lifeK;
    p.size = (0.9 + 1.0 * r4) * sz;
    p.aux = vec4f(220.0, 2.5, 0.0, 0.0);
  } else if (prog == E_RISE) {
    // motes climbing the loot beam: a narrow column, buoyant, swirling a little on the curl flow;
    // power > 1 throws the first ones up fast as the beam shoots
    p.kind = select(K_EMBER, K_GLITTER, r5 < 0.35);
    p.pos = origin + vec2f((r1 - 0.5) * spread, (r2 - 0.5) * spread * 0.3);
    p.vel = vec2f((r3 - 0.5) * 40.0, -(90.0 + 190.0 * r2)) * power;
    p.maxLife = (0.7 + 0.8 * r3) * lifeK;
    p.size = (0.9 + 1.7 * r4 * r4) * sz * select(1.0, 1.5, r5 < 0.35);
    p.aux = vec4f(-110.0, 1.4, 70.0, 0.0);
  } else if (prog == E_SPARKLE) {
    // glints where the gold lands in the counter
    p.kind = select(K_EMBER, K_GLITTER, r5 < 0.5);
    p.pos = origin + (vec2f(r1, r2) - 0.5) * vec2f(spread, spread * 0.35);
    p.vel = d1 * (30.0 + 90.0 * r3) * power + vec2f(0.0, -30.0);
    p.maxLife = (0.45 + 0.5 * r3) * lifeK;
    p.size = (1.6 + 2.2 * r4) * sz * select(0.6, 1.0, r5 < 0.5);
    p.aux = vec4f(60.0, 3.0, 0.0, 0.0);
  }
  p.life = p.maxLife;
  return p;
}

fn integrate(pin: Particle, dt: f32, t: f32) -> Particle {
  var p = pin;
  p.life = p.life - dt;
  if (p.kind == K_STREAM) {
    // quadratic Bézier, accelerating into the counter; a little curl wobble mid-flight
    let u = clamp(1.0 - p.life / p.maxLife, 0.0, 1.0);
    let e = u * u * (2.2 - 1.2 * u);
    let a = 1.0 - e;
    let jitter = (vec2f(fract(p.seed * 13.17), fract(p.seed * 7.31)) - 0.5) * vec2f(30.0, 8.0);
    let goal = params.goal.xy + jitter;
    var q = a * a * p.aux.xy + 2.0 * a * e * p.aux.zw + e * e * goal;
    q = q + curl(q * 0.012, t * 0.3) * (sin(PI * u) * 3.0);
    p.vel = (q - p.pos) / max(dt, 0.0001);
    p.pos = q;
    return p;
  }
  if (p.kind == K_SHELL) {
    let g = vec2f(0.0, p.aux.x);
    p.pos = p.pos + p.vel * dt + 0.5 * g * dt * dt;
    p.vel = p.vel + g * dt;
    return p;
  }
  var acc = vec2f(0.0, p.aux.x);
  if (p.aux.z > 0.0) {
    acc = acc + curl(p.pos * 0.018, t * 0.6) * p.aux.z;
  }
  if (p.kind == K_GLITTER) {
    acc.x = acc.x + sin(t * 2.7 + p.seed * 40.0) * 26.0;
  }
  p.vel = p.vel * exp(-p.aux.y * dt) + acc * dt;
  p.pos = p.pos + p.vel * dt;
  return p;
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&particles)) {
    return;
  }
  let dt = params.clock.y;
  let t = params.clock.x;
  if (i < AMBIENT) {
    particles[i] = stepMote(particles[i], i, dt, t);
    return;
  }
  var p = particles[i];
  let n = min(u32(params.misc.z + 0.5), MAX_EMIT);
  let fi = f32(i);
  for (var k = 0u; k < n; k = k + 1u) {
    let em = params.em[k];
    if (fi >= em.a.x && fi < em.a.x + em.a.y) {
      p = spawn(em, i, u32(fi - em.a.x));
    }
  }
  if (p.life > 0.0) {
    p = integrate(p, dt, t);
  }
  particles[i] = p;
}
`;

/**
 * Particle sprites. One instanced quad per particle; the fragment shader draws the shape
 * analytically (no textures): a capsule stretched along the velocity (white-hot core + tinted
 * halo, tapered tail) or a 4-point star glint. `fsLdr` targets the canvas (clamped, premultiplied),
 * `fsHdr` the bloom source (unclamped radiance).
 */
export const DRAW_WGSL = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> params: Params;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec3f,
  // x: star?, y: radius (pt), z: stretch length (pt), w: halo multiplier
  @location(2) shape: vec4f,
  // x: core gain, y: taper
  @location(3) look: vec2f,
};

fn culled() -> VOut {
  var o: VOut;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  return o;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = particles[ii];
  if (p.life <= 0.0 || p.maxLife <= 0.0) {
    return culled();
  }
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  let t = params.clock.x;
  let view = params.clock.zw;
  let age = clamp(1.0 - p.life / p.maxLife, 0.0, 1.0);
  let ageS = p.maxLife - p.life;
  // quick pop-in over ~80 ms (never from nothing to full in one frame)
  let pop = 1.0 - pow(1.0 - clamp(ageS / 0.08, 0.0, 1.0), 3.0);
  let speed = length(p.vel);
  var dir = vec2f(0.0, -1.0);
  if (speed > 0.001) {
    dir = p.vel / speed;
  }

  var col = ramp(age, p.tint);
  var energy = 1.0;
  var radius = p.size;
  var stretch = 0.0;
  var halo = 3.5;
  var core = 1.0;
  var taper = 0.4;
  var star = false;
  var spin = 0.0;

  if (p.kind == K_MOTE) {
    let env = pow(max(sin(PI * age), 0.0), 0.8);
    let vis = smoothstep(p.seed - 0.07, p.seed + 0.07, params.ambient.x);
    let tw = 0.62 + 0.38 * sin(t * (1.1 + 2.6 * p.aux.x) + p.seed * 40.0);
    var attn = 1.0;
    // quieter over the board so the cells stay readable
    if (p.pos.x > params.goal.z && p.pos.x < params.misc.x && p.pos.y > params.goal.w && p.pos.y < params.misc.y) {
      attn = 0.4;
    }
    energy = params.ambient.y * env * vis * tw * attn * 0.5;
    col = mix(vec3f(1.0, 0.914, 0.69), vec3f(0.969, 0.788, 0.282), p.aux.x);
    radius = p.size * 0.7;
    stretch = min(speed * 0.02, 24.0);
    halo = 4.0;
    core = 0.7;
    taper = 0.55;
  } else if (p.kind == K_EMBER) {
    let flicker = 0.85 + 0.15 * sin(t * 23.0 + p.seed * 60.0);
    energy = mix(1.25, 0.6, smoothstep(0.0, 0.35, age)) * pow(1.0 - age, 1.3) * flicker;
    radius = p.size * 0.5 * (1.0 - 0.45 * age) * pop;
    stretch = min(speed * 0.012, 14.0);
    halo = 4.5;
    core = 1.0;
    taper = 0.5;
  } else if (p.kind == K_SPARK) {
    col = ramp(0.06 + age * 0.9, p.tint);
    energy = 1.4 * pow(1.0 - age, 1.8);
    radius = p.size * 0.55 * (1.0 - 0.4 * age) * pop;
    stretch = min(speed * 0.032, 30.0) * pop;
    halo = 2.6;
    core = 1.2;
    taper = 0.85;
  } else if (p.kind == K_FLARE) {
    var crackle = 1.0;
    if (age > 0.62) {
      crackle = 0.45 + 0.55 * step(0.45, fract(t * 13.0 + p.seed * 7.0));
    }
    // brightens as the ring opens (over ~0.25 s): while the shell is still a tight ball, hundreds
    // of young flares would otherwise sum into a white disc
    energy = 1.5 * smoothstep(0.03, 0.26, ageS) * pow(1.0 - age, 1.5) * crackle;
    radius = p.size * 0.55 * pop;
    stretch = min(speed * 0.035, 30.0) * pop;
    halo = 3.0;
    core = 1.0;
    taper = 0.8;
  } else if (p.kind == K_SHELL) {
    col = ramp(0.1, p.tint);
    energy = 2.0;
    radius = p.size * 0.6 * pop;
    stretch = min(speed * 0.06, 52.0) * pop;
    halo = 3.0;
    core = 1.4;
    taper = 0.9;
  } else if (p.kind == K_STREAM) {
    col = ramp(0.2 + 0.3 * age, 0.0);
    energy = 1.3 * (1.0 - smoothstep(0.86, 1.0, age)) * (0.6 + 0.4 * sin(t * 21.0 + p.seed * 50.0));
    radius = p.size * 0.6 * pop;
    stretch = min(speed * 0.004, 4.0);
    halo = 5.5;
    core = 1.0;
    taper = 0.7;
  } else if (p.kind == K_FLASH) {
    col = mix(vec3f(1.0, 0.98, 0.92), ramp(0.3, p.tint), 0.7);
    energy = p.aux.w * pow(1.0 - age, 2.5);
    radius = p.size * (0.55 + 0.6 * sqrt(age));
    halo = 1.0;
    core = 0.0;
    taper = 0.0;
  } else if (p.kind == K_PUFF) {
    col = ramp(0.35, p.tint);
    energy = 0.55 * smoothstep(0.0, 0.2, age) * pow(1.0 - age, 1.5);
    radius = p.size * (0.7 + 0.8 * age);
    halo = 1.0;
    core = 0.0;
    taper = 0.0;
  } else if (p.kind == K_GLITTER) {
    let tw = pow(0.5 + 0.5 * sin(t * (7.0 + 6.0 * p.seed) + p.seed * 80.0), 3.0);
    col = ramp(0.12 + age * 0.6, p.tint);
    energy = (0.25 + 1.6 * tw) * (1.0 - smoothstep(0.72, 1.0, age)) * pop;
    radius = p.size * (0.6 + 0.6 * tw) * pop;
    star = true;
    spin = p.seed * TAU + t * 0.6 * (p.seed - 0.5);
  }
  if (p.kind != K_MOTE) {
    // alpha fades in from zero over the first ~70 ms: nothing is ever born at full brightness,
    // so a dense burst core can't sum into a flat plate on its first frame
    var fadeIn = 0.07;
    if (p.kind == K_SPARK || p.kind == K_EMBER || p.kind == K_FLARE) {
      fadeIn = 0.1;
    }
    energy = energy * smoothstep(0.0, fadeIn, ageS);
  }
  if (energy < 0.002 || radius < 0.02) {
    return culled();
  }

  var o: VOut;
  var world = p.pos;
  if (star) {
    let q = c * radius;
    let cs = vec2f(cos(spin), sin(spin));
    world = p.pos + vec2f(q.x * cs.x - q.y * cs.y, q.x * cs.y + q.y * cs.x);
    o.local = q;
  } else {
    let w = radius * halo;
    let along = mix(-w, stretch + w, c.x * 0.5 + 0.5);
    let across = c.y * w;
    let perp = vec2f(-dir.y, dir.x);
    world = p.pos - dir * along + perp * across;
    o.local = vec2f(along, across);
  }
  // the Skia world's camera (zoom / punch / shake / roll about the pivot), so dust stays glued
  // to the cell it bursts from
  let zq = (world - params.pivot.xy) * params.cam.w;
  let cr = cos(params.cam.z);
  let sr = sin(params.cam.z);
  world = vec2f(zq.x * cr - zq.y * sr, zq.x * sr + zq.y * cr) + params.cam.xy;
  o.pos = vec4f(world.x / view.x * 2.0 - 1.0, 1.0 - world.y / view.y * 2.0, 0.0, 1.0);
  o.color = col * energy;
  o.shape = vec4f(select(0.0, 1.0, star), radius, stretch, halo);
  o.look = vec2f(core, taper);
  return o;
}

fn shade(v: VOut) -> vec3f {
  let radius = max(v.shape.y, 0.02);
  let maxc = max(v.color.r, max(v.color.g, v.color.b));
  let hot = mix(v.color, vec3f(maxc), 0.45);
  if (v.shape.x > 0.5) {
    // 4-point star glint: two thin rays + white core + a little glow
    let q = v.local / radius;
    let ax = abs(q.x);
    let ay = abs(q.y);
    let rays = pow(max(1.0 - ax, 0.0), 3.0) * exp(-ay * ay * 160.0)
             + pow(max(1.0 - ay, 0.0), 3.0) * exp(-ax * ax * 160.0);
    let r2 = dot(q, q);
    let coreM = exp(-r2 * 70.0);
    let glow = exp(-r2 * 10.0) * 0.3 * max(1.0 - r2, 0.0);
    return v.color * (rays + glow) + hot * coreM * 1.4;
  }
  // capsule: head at along = 0, tail at along = len
  let along = v.local.x;
  let across = v.local.y;
  let len = v.shape.z;
  var dist = abs(across);
  var tt = 0.0;
  if (along < 0.0) {
    dist = length(v.local);
  } else if (along > len) {
    dist = length(vec2f(along - len, across));
    tt = select(0.0, 1.0, len > 0.01);
  } else {
    tt = along / max(len, 0.0001);
  }
  let width = radius * (1.0 - v.look.y * tt);
  let n = dist / max(width, 0.02);
  let coreM = exp(-n * n * 2.0);
  let h = dist / (radius * v.shape.w);
  let haloM = exp(-h * h * 5.0) * max(1.0 - h * h, 0.0);
  let head = 1.0 - 0.82 * v.look.y * tt;
  return (hot * coreM * v.look.x + v.color * haloM * 0.6) * head;
}

@fragment
fn fsLdr(v: VOut) -> @location(0) vec4f {
  let c = min(shade(v), vec3f(1.0));
  // premultiplied: rgb never exceeds alpha, so over the scene this reads as a screen blend
  return vec4f(c, max(c.r, max(c.g, c.b)));
}

@fragment
fn fsHdr(v: VOut) -> @location(0) vec4f {
  return vec4f(shade(v), 1.0);
}
`;

const FULLSCREEN = /* wgsl */ `
struct FsIn {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> FsIn {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let q = pts[vi];
  var o: FsIn;
  o.pos = vec4f(q, 0.0, 1.0);
  o.uv = vec2f(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
  return o;
}
`;

/** Dual-Kawase down / up filters (progressive: each up pass is added onto the level below). */
export const BLUR_WGSL = /* wgsl */ `
${FULLSCREEN}
@group(0) @binding(0) var smp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

fn tap(uv: vec2f) -> vec3f {
  return textureSampleLevel(src, smp, uv, 0.0).rgb;
}

@fragment
fn fsDown(v: FsIn) -> @location(0) vec4f {
  let o = 1.0 / vec2f(textureDimensions(src));
  var s = tap(v.uv) * 4.0;
  s = s + tap(v.uv + vec2f(-o.x, -o.y));
  s = s + tap(v.uv + vec2f(o.x, -o.y));
  s = s + tap(v.uv + vec2f(-o.x, o.y));
  s = s + tap(v.uv + vec2f(o.x, o.y));
  return vec4f(s * 0.125, 1.0);
}

@fragment
fn fsUp(v: FsIn) -> @location(0) vec4f {
  let o = 0.75 / vec2f(textureDimensions(src));
  var s = tap(v.uv + vec2f(-2.0 * o.x, 0.0));
  s = s + tap(v.uv + vec2f(2.0 * o.x, 0.0));
  s = s + tap(v.uv + vec2f(0.0, -2.0 * o.y));
  s = s + tap(v.uv + vec2f(0.0, 2.0 * o.y));
  s = s + tap(v.uv + vec2f(-o.x, -o.y)) * 2.0;
  s = s + tap(v.uv + vec2f(o.x, -o.y)) * 2.0;
  s = s + tap(v.uv + vec2f(-o.x, o.y)) * 2.0;
  s = s + tap(v.uv + vec2f(o.x, o.y)) * 2.0;
  return vec4f(s * (1.0 / 12.0), 1.0);
}
`;

/**
 * Composite onto the canvas: sharp HDR core + multi-scale bloom, tone-mapped together, written
 * premultiplied (empty = fully transparent, rgb never above alpha → a screen blend over Skia).
 * The tone map is mostly hue-preserving, so a dense burst core saturates to gold-white instead
 * of a flat white plate.
 */
export const COMPOSITE_WGSL = /* wgsl */ `
${FULLSCREEN}
@group(0) @binding(0) var smp: sampler;
@group(0) @binding(1) var coreTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fsComposite(v: FsIn) -> @location(0) vec4f {
  let a = textureSampleLevel(coreTex, smp, v.uv, 0.0).rgb;
  let b = textureSampleLevel(bloomTex, smp, v.uv, 0.0).rgb;
  let hdr = a + b * params.misc.w;
  let m = max(hdr.r, max(hdr.g, hdr.b));
  if (m < 0.0005) {
    return vec4f(0.0);
  }
  let keepHue = hdr * ((1.0 - exp(-m)) / m);
  let perChannel = vec3f(1.0) - exp(-hdr);
  let c = mix(keepHue, perChannel, 0.3);
  return vec4f(c, max(c.r, max(c.g, c.b)));
}
`;
