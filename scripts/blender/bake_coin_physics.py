"""
Bakes the vault coin-eruption physics with Blender's rigid-body solver (Bullet), headless:

    /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/bake_coin_physics.py -- src/game/physics/coinSims.ts

Writes a generated TypeScript module with two sims that the app plays back on the UI thread
(it draws the coins itself from the coin_spin sprite sheet; nothing is rendered here):

  COIN_BURST    a normal vault hit: 14 coins erupt out of the cell at (0, 0), land 0.8-2.5 cells
                away, bounce, skid and settle. 1.0 s, no walls.
  COIN_JACKPOT  board complete: 48 coins erupt from the board centre, rain down inside the board
                frame (passive walls at x, y = +-5), ricochet, collide, roll and settle. 2.2 s.

World: 1 Blender unit = 1 board cell. The board is the plane z = 0 (top face of a thick passive
box). Gravity is -9.81 * GRAVITY_SCALE cells/s^2 along -z: real-world gravity at real cell sizes
looks floaty on a phone, so it is scaled until the apex arrives in ~0.25-0.35 s; launch speeds are
derived from the wanted apex/landing distance, so the motion reads fast and heavy.

Initial velocities: from its launch frame each coin is keyed kinematic ("Animated") for KIN_FRAMES
sim frames, moving along its launch velocity and spinning about its tumble axis with LINEAR keys,
then keyed dynamic. Bullet hands the kinematic motion over as the body's linear + angular velocity
(verified in 5.2: it needs linear keys and >= 3 kinematic frames, otherwise the velocity is ~0).
Coins leave the vault a few per sim frame (burst ~0.11 s, jackpot ~0.13 s); until its launch a coin
is parked under the board so the tumbling coins already in the air can't hit it (the export shows
it lying flat at its spawn point meanwhile).

Physics quirks handled (see the constants): Bullet multiplies restitution/friction of the two
bodies; a perfect cylinder rolls on its rim forever (12-gon hull instead); coins launched from the
same spot clip each other (staggered, fastest first); the burst's 1 s leaves only ~0.45 s after
touchdown, so it lands coins near-flat and, after their first contact, ramps damping up as a
rolling-resistance stand-in (two passes: pass 1 finds each coin's touchdown frame).

Deterministic: fixed RNG seed, the sim is stepped frame by frame from the cache start, and the
script re-runs itself in a single-threaded Blender (`-t 1`, see below). Run twice and the output
is byte-identical.
"""

import math
import os
import random
import sys

import bpy
from mathutils import Quaternion, Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else "src/game/physics/coinSims.ts")

# Determinism: with Blender's multi-threaded depsgraph the 48-coin bake occasionally diverges
# (a race somewhere in the rigid-body sync: two different results showed up across identical runs,
# depending on machine load). Single-threaded it is bit-identical every time, so re-run this script in a `-t 1` Blender unless already in one.
_blender_args = sys.argv[: sys.argv.index("--")] if "--" in sys.argv else sys.argv
if "-t" not in _blender_args and "--threads" not in _blender_args:
    import subprocess

    cmd = [bpy.app.binary_path, "-b", "-t", "1", "-P", os.path.abspath(__file__), "--", OUT]
    sys.exit(subprocess.run(cmd).returncode)

SEED = 20261124
GRAVITY_SCALE = 9.0  # g = 9.81 * 9 = 88.3 cells/s^2
G = 9.81 * GRAVITY_SCALE
EXPORT_FPS = 30
SIM_FPS = 120  # scene frame rate the solver runs at (4 sim frames per exported frame)
SUBSTEPS = 16  # -> 1920 Bullet steps/s: a 30 cells/s coin moves 0.016 per step; at 8 a
# landing coin sank up to 0.025 into the board for a frame before the solver pushed it out
SOLVER_ITERATIONS = 40
KIN_FRAMES = 3  # kinematic for 3 sim frames from its launch frame, then dynamic
PARK_DEPTH = 40.0
# Per-sim launch tuning. vz (cells/s) -> apex after vz/g s, vz^2/2g cells up; ang_damp = Bullet
# angular damping (fraction of spin lost per s). Jackpot: tumble = |angular velocity| rad/s about a
# mostly horizontal axis. Burst: the spin is solved per coin so it lands near-flat after
# `half_turns` flips (see flat_landing_tumble), and `settle` ramps damping after touchdown
# (see add_settle): the burst has 1 s in total and should be nearly still from ~0.8 s.
BURST = {  # apex ~0.2-0.24 s after leaving the vault, 1.8-2.5 cells up
    "vz": (18.0, 21.0),
    "half_turns": (1, 2, 2, 3),  # half-turns (face -> edge -> face) before touchdown
    "ang_damp": 0.92,
    "settle": {"delay": 0.06, "ramp": 0.08, "lin": 0.99, "ang": 0.999},
}
JACKPOT = {"vz": (27.0, 30.0), "tumble": (16.0, 30.0), "ang_damp": 0.6}  # apex ~0.31-0.34 s, 4.1-5.1 up

COIN_RADIUS = 0.26
COIN_THICK = 0.07
COIN_DENSITY = 19.3  # gold, arbitrary mass units; only ratios matter
COIN_FRICTION = 0.5
COIN_RESTITUTION = 0.45
COIN_LIN_DAMP = 0.04
# Collision shape: convex hull of a 12-sided coin with a chamfered rim.
# - A perfect Bullet cylinder that lands on its rim rolls on like a hoop (Blender exposes no rolling
#   friction) and is still crossing cells when the sim ends. 12 sides are invisible at this size
#   (the rim deviates < 0.01 cell from round) but lose ~10% spin per facet, so rolling coins wobble
#   down onto a face within a cell or so, like real milled coins.
# - A flat 0.07-wide rim lets a coin rest standing on its edge (stable within ~8 deg of vertical),
#   which happened in the bake and reads as a stuck sliver. The chamfer narrows the rim band to
#   0.024 (stable within ~2.6 deg), so coins topple onto a face.
COIN_SIDES = 12
COIN_RIM_HALF = 0.012  # half-height of the full-radius rim band
COIN_FACE_RADIUS = 0.245  # radius where the chamfer meets the faces
BOARD_FRICTION = 0.55  # x coin 0.5 -> 0.275 effective (Bullet multiplies, see below)
# Bullet MULTIPLIES the two bodies' restitution (and friction). 0.45 * 0.4 = 0.18 leaves no
# visible bounce, so the board's coefficient is raised: 0.45 * 0.9 ~= 0.4 effective coin/board.
BOARD_RESTITUTION = 0.9
WALL_RESTITUTION = 1.0  # 0.45 * 1.0 ~= 0.45-0.5 effective coin/wall
WALL_FRICTION = 0.3
MARGIN = 0.004


def coin_mass():
    return math.pi * COIN_RADIUS**2 * COIN_THICK * COIN_DENSITY


# ---------------------------------------------------------------- scene helpers
def new_scene(duration):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # rigid bodies only inherit the kinematic motion when the keys are linear
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    scene = bpy.context.scene
    scene.render.fps = SIM_FPS
    scene.render.fps_base = 1.0
    sim_frames = int(round(duration * SIM_FPS)) + 1
    scene.frame_start = 1
    scene.frame_end = sim_frames
    bpy.ops.rigidbody.world_add()
    rw = scene.rigidbody_world
    rw.substeps_per_frame = SUBSTEPS
    rw.solver_iterations = SOLVER_ITERATIONS
    rw.use_split_impulse = True  # depenetration without injecting energy
    rw.time_scale = 1.0
    rw.point_cache.frame_start = 1
    rw.point_cache.frame_end = sim_frames
    scene.use_gravity = True
    scene.gravity = (0.0, 0.0, -G)
    return scene, sim_frames


def passive_box(name, center, size, friction, restitution):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.rigidbody.object_add(type="PASSIVE")
    rb = obj.rigid_body
    rb.collision_shape = "BOX"
    rb.friction = friction
    rb.restitution = restitution
    rb.use_margin = True
    rb.collision_margin = MARGIN
    return obj


def board():
    # top face at z = 0; thick so nothing can tunnel through it
    passive_box("Board", (0, 0, -1.0), (60, 60, 2.0), BOARD_FRICTION, BOARD_RESTITUTION)


def walls(half=5.0, height=1.5, thick=1.0):
    span = 2 * half + 2 * thick
    for name, c, s in (
        ("WallE", (half + thick / 2, 0, height / 2), (thick, span, height)),
        ("WallW", (-half - thick / 2, 0, height / 2), (thick, span, height)),
        ("WallN", (0, half + thick / 2, height / 2), (span, thick, height)),
        ("WallS", (0, -half - thick / 2, height / 2), (span, thick, height)),
    ):
        passive_box(name, c, s, WALL_FRICTION, WALL_RESTITUTION)


def coin_mesh():
    """Chamfered 12-gon coin, axis = local z."""
    rings = [
        (COIN_FACE_RADIUS, 0.5 * COIN_THICK),
        (COIN_RADIUS, COIN_RIM_HALF),
        (COIN_RADIUS, -COIN_RIM_HALF),
        (COIN_FACE_RADIUS, -0.5 * COIN_THICK),
    ]
    n = COIN_SIDES
    verts = [
        (rad * math.cos(2 * math.pi * k / n), rad * math.sin(2 * math.pi * k / n), z)
        for rad, z in rings
        for k in range(n)
    ]
    faces = [tuple(range(n))[::-1], tuple(range(3 * n, 4 * n))]
    for r in range(3):
        for k in range(n):
            a, b = r * n + k, r * n + (k + 1) % n
            faces.append((a, b, b + n, a + n))
    me = bpy.data.meshes.new("Coin")
    me.from_pydata(verts, [], faces)
    me.update()
    return me


def coin(i, pos, vel, omega, q0, launch, ang_damp):
    """Active cylinder (axis = local z) launched at sim frame `launch` with `vel`, spinning at
    `omega` (world). Until then it is parked kinematic far below the board so the coins still in
    the vault cannot be hit by the tumbling coins leaving it (they are exported at `pos`)."""
    obj = bpy.data.objects.new(f"Coin{i:02d}", coin_mesh())
    obj.location = pos
    bpy.context.scene.collection.objects.link(obj)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    obj.rotation_mode = "QUATERNION"
    bpy.ops.rigidbody.object_add(type="ACTIVE")
    rb = obj.rigid_body
    rb.collision_shape = "CONVEX_HULL"
    rb.mass = coin_mass()
    rb.friction = COIN_FRICTION
    rb.restitution = COIN_RESTITUTION
    rb.linear_damping = COIN_LIN_DAMP
    rb.angular_damping = ang_damp
    rb.use_margin = True
    rb.collision_margin = MARGIN
    rb.use_deactivation = False
    w = Vector(omega)
    speed = w.length
    axis = w.normalized() if speed > 1e-9 else Vector((1, 0, 0))
    p0 = Vector(pos)
    v = Vector(vel)
    keys = []
    if launch > 1:
        # parked straight below the spawn point (the way up only crosses the passive board)
        keys.append((1, p0 - Vector((0, 0, PARK_DEPTH)), q0, True))
        keys.append((launch - 1, p0 - Vector((0, 0, PARK_DEPTH)), q0, True))
    for k in range(KIN_FRAMES + 1):
        t = k / SIM_FPS
        keys.append((launch + k, p0 + v * t, Quaternion(axis, speed * t) @ q0, k < KIN_FRAMES))
    for f, loc, rot, kin in keys:
        obj.location = loc
        obj.rotation_quaternion = rot
        rb.kinematic = kin
        obj.keyframe_insert("location", frame=f)
        obj.keyframe_insert("rotation_quaternion", frame=f)
        rb.keyframe_insert("kinematic", frame=f)
    obj["launch"] = launch
    obj["spawn"] = tuple(pos)
    return obj


def flight_time(vz, z0):
    """Time for a body launched at height z0 with vertical speed vz to come back to z = 0."""
    return (vz + math.sqrt(vz * vz + 2 * G * z0)) / G


def flat_landing_tumble(rng, flight, ang_damp, half_turns):
    """Spin about a horizontal diameter (a principal axis: the flip stays clean) at the rate that,
    after Bullet's angular damping, turns the coin a whole number of half-turns by touchdown, give
    or take ~15 deg. Coins then land near face-down/face-up: they bounce and skid to a stop instead
    of landing on the rim and rolling away like hoops (the burst only has ~0.45 s after landing)."""
    lam = -math.log(1.0 - ang_damp)
    turned_per_rad_s = (1.0 - math.exp(-lam * flight)) / lam  # angle turned per rad/s of spin
    n = rng.choice(half_turns)
    angle = n * math.pi + rng.uniform(-0.25, 0.25)
    a = rng.uniform(0, 2 * math.pi)
    sign = rng.choice((-1, 1))
    axis = Vector((math.cos(a), math.sin(a), 0.0))
    return tuple(axis * (sign * angle / turned_per_rad_s))


def tumble(rng, lo, hi):
    """Mostly-horizontal spin axis (so the coin flips face/edge), random speed and sign."""
    a = rng.uniform(0, 2 * math.pi)
    axis = Vector((math.cos(a), math.sin(a), rng.uniform(-0.35, 0.35))).normalized()
    return tuple(axis * rng.uniform(lo, hi))


# ---------------------------------------------------------------- sims
def launch_frames(n, per_frame):
    """Coins leave the vault a few per sim frame (a short gush rather than one solid block)."""
    return [1 + i // per_frame for i in range(n)]


def launch_speeds(rng, n, rng_vz):
    """Upward speeds, fastest first: a coin leaving a slot later is never faster than the one
    ahead of it, so it cannot catch up from below and kick it (that read as random pops)."""
    return sorted((rng.uniform(*rng_vz) for _ in range(n)), reverse=True)


def build_burst(rng):
    """14 coins gush out of the cell through its four quadrants, 1 per sim frame (~0.11 s).

    A slot is reused only every 4 sim frames (the coin ahead is ~0.65 cells up by then) and
    consecutive coins of a slot veer to alternate sides, so the tumbling coins don't clip each
    other on the way out."""
    slots = [(0.27, 0.27), (-0.27, -0.27), (-0.27, 0.27), (0.27, -0.27)]  # 0.54 apart > 0.52
    launches = launch_frames(14, 1)
    vzs = launch_speeds(rng, 14, BURST["vz"])
    coins = []
    for i in range(14):
        sx, sy = slots[i % 4]
        pos = (sx + rng.uniform(-0.006, 0.006), sy + rng.uniform(-0.006, 0.006), 0.06)
        side = 1 if (i // 4) % 2 == 0 else -1
        ang = math.atan2(sy, sx) + side * rng.uniform(0.15, 0.75)
        vz = vzs[i]
        land = rng.uniform(0.8, 2.2)
        vr = max(0.0, land - math.hypot(sx, sy)) / flight_time(vz, pos[2])
        vel = (vr * math.cos(ang), vr * math.sin(ang), vz)
        omega = flat_landing_tumble(rng, flight_time(vz, pos[2]), BURST["ang_damp"], BURST["half_turns"])
        q0 = Quaternion((0, 0, 1), rng.uniform(0, 2 * math.pi))
        coins.append(coin(i, pos, vel, omega, q0, launches[i], BURST["ang_damp"]))
    return coins


def build_jackpot(rng):
    """48 coins gush out of a 3x3 patch at the board centre, 3 per sim frame (~0.13 s)."""
    sp = 0.56  # > coin diameter 0.52
    grid = [(gx * sp, gy * sp) for gy in (-1, 0, 1) for gx in (-1, 0, 1)]
    order = [0, 4, 8, 2, 6, 1, 3, 5, 7]  # 3 consecutive slots never touch; reuse after 3 frames
    launches = launch_frames(48, 3)
    vzs = launch_speeds(rng, 48, JACKPOT["vz"])
    coins = []
    for i in range(48):
        gx, gy = grid[order[i % 9]]
        pos = (gx + rng.uniform(-0.01, 0.01), gy + rng.uniform(-0.01, 0.01), 0.06)
        if gx == 0 and gy == 0:
            ang = rng.uniform(0, 2 * math.pi)
        else:
            ang = math.atan2(gy, gx) + rng.uniform(-0.55, 0.55)
        vz = vzs[i]
        # distance to the frame along this direction; land well inside it so nothing flies over
        d_wall = 5.0 / max(abs(math.cos(ang)), abs(math.sin(ang)))
        land = (0.8 * d_wall - 0.4) * math.sqrt(rng.uniform(0.04, 1.0))
        vr = max(0.0, land - math.hypot(gx, gy)) / flight_time(vz, pos[2])
        vel = (vr * math.cos(ang), vr * math.sin(ang), vz)
        omega = tumble(rng, *JACKPOT["tumble"])
        q0 = Quaternion((0, 0, 1), rng.uniform(0, 2 * math.pi))
        coins.append(coin(i, pos, vel, omega, q0, launches[i], JACKPOT["ang_damp"]))
    return coins


# ---------------------------------------------------------------- bake + sample
def sample(scene, coins, sim_frames):
    step = SIM_FPS // EXPORT_FPS
    out_frames = (sim_frames - 1) // step + 1
    data = []
    prev_roll = [None] * len(coins)
    touchdown = [None] * len(coins)
    deepest = 0.0  # lowest hull point of any launched coin over the whole sim (tunnelling check)
    for f in range(1, sim_frames + 1):
        scene.frame_set(f)  # sequential stepping from the cache start bakes the sim
        for ci, obj in enumerate(coins):
            if f <= obj["launch"]:
                continue
            low = lowest_point(obj)
            deepest = min(deepest, low)
            if touchdown[ci] is None and f > obj["launch"] + 10 and low < TOUCH:
                touchdown[ci] = f
        if (f - 1) % step:
            continue
        for ci, obj in enumerate(coins):
            if f < obj["launch"]:
                # still waiting in the vault: flat at its spawn point
                sx, sy, sz = obj["spawn"]
                data.append((sx, -sy, sz - 0.5 * COIN_THICK, 0.0, prev_roll[ci] or 0.0))
                continue
            m = obj.matrix_world
            p = m.translation
            n = (m.to_3x3() @ Vector((0, 0, 1))).normalized()
            nz = min(1.0, abs(n.z))
            tilt = math.acos(nz)
            # clearance of the drawn (round, flat-rimmed) coin's lowest point above the board; the
            # chamfered 12-gon hull can sit up to ~0.015 lower than that model, clamped on export
            z = p.z - (COIN_RADIUS * math.sin(tilt) + 0.5 * COIN_THICK * nz)
            # screen space: x right, y DOWN (Blender y flipped)
            sx, sy = n.x, -n.y
            if math.hypot(sx, sy) < 1e-3:
                roll = prev_roll[ci] if prev_roll[ci] is not None else 0.0
            else:
                roll = math.atan2(sy, sx)
                # the squash direction is only defined mod pi: unwrap against the previous frame
                if prev_roll[ci] is not None:
                    roll += math.pi * round((prev_roll[ci] - roll) / math.pi)
                elif roll > math.pi / 2:
                    roll -= math.pi
                elif roll <= -math.pi / 2:
                    roll += math.pi
            prev_roll[ci] = roll
            data.append((p.x, -p.y, z, tilt, roll))
    return out_frames, data, touchdown, deepest


TOUCH = 0.15  # a falling coin covers ~0.15-0.2 cells per sim frame: closer than this = touching down


def lowest_point(obj):
    """World height of the collision hull's lowest vertex (exact for a convex hull)."""
    m = obj.matrix_world
    return min((m @ v.co).z for v in obj.data.vertices)


def add_settle(coins, touchdown, settle):
    """Rolling resistance stand-in: from `delay` s after a coin first touches the board, ramp its
    damping up over `ramp` s. The first bounce and skid stay pure Bullet; the long hoop-rolling /
    Euler's-disk wobble tail that would outlast a 1 s effect is drained instead."""
    for obj, td in zip(coins, touchdown):
        if td is None:
            continue
        rb = obj.rigid_body
        f0 = td + round(settle["delay"] * SIM_FPS)
        f1 = f0 + max(1, round(settle["ramp"] * SIM_FPS))
        for f, lin, ang in ((f0, rb.linear_damping, rb.angular_damping), (f1, settle["lin"], settle["ang"])):
            rb.linear_damping = lin
            rb.angular_damping = ang
            rb.keyframe_insert("linear_damping", frame=f)
            rb.keyframe_insert("angular_damping", frame=f)


def build(name, duration, builder, rng, touchdown=None, settle=None):
    scene, sim_frames = new_scene(duration)
    board()
    if name == "COIN_JACKPOT":
        walls()
    coins = builder(rng)
    if settle and touchdown:
        add_settle(coins, touchdown, settle)
    return scene, coins, sim_frames


def run(name, duration, builder, rng, settle=None):
    state = rng.getstate()
    scene, coins, sim_frames = build(name, duration, builder, rng)
    frames, data, touchdown, deepest = sample(scene, coins, sim_frames)
    if settle:
        # second pass, same seed: identical up to each coin's touchdown, then the settle ramp
        rng.setstate(state)
        scene, coins, sim_frames = build(name, duration, builder, rng, touchdown, settle)
        frames, data, _, deepest = sample(scene, coins, sim_frames)
    assert len(data) == frames * len(coins)
    return {"name": name, "frames": frames, "coins": len(coins), "data": data, "deepest": deepest}


def fmt(v):
    r = round(v, 3)
    if r == 0:
        r = 0.0  # no "-0"
    s = f"{r:.3f}".rstrip("0").rstrip(".")
    return s


HEADER = """/**
 * GENERATED by scripts/blender/bake_coin_physics.py - do not edit by hand. Regenerate with:
 *
 *   /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/bake_coin_physics.py -- src/game/physics/coinSims.ts
 *
 * Baked Blender rigid-body (Bullet) sims of gold coins erupting out of a vault cell, for playback
 * on the UI thread. Deterministic (fixed seed {seed}).
 *
 * Units: 1 = one board cell. Origin = the cell / board centre the coins erupt from.
 * Time:  {fps} samples per second; frame f is at t = f / fps seconds, frame 0 = the vault opens.
 *        Coins leave a few at a time over the first ~0.1 s; until then a coin lies flat at its
 *        spawn point inside the cell. Interpolate between frames for higher refresh rates (roll is
 *        unwrapped so it can be lerped directly). Hold the last frame after the sim ends.
 * Gravity: -9.81 * {gscale} = -{g:.1f} cells/s^2 (scaled so the apex comes after ~0.25-0.35 s and the
 *        motion reads heavy on a phone). Coin: radius {r} cells, thickness {th} cells.
 *        Effective (Bullet-multiplied) restitution coin/board {eb:.2f}, coin/wall {ew:.2f}; friction coin/board {fb:.3f}.
 *
 * Layout: data[(frame * coins + coin) * 5 + k], numbers rounded to 3 decimals, k =
 *   0 x     board-plane position, cells, +x = screen right
 *   1 y     board-plane position, cells, +y = toward the BOTTOM of the screen
 *   2 z     clearance of the coin's lowest point above the board, cells (>= 0; 0 = touching the board).
 *           Height of the coin's centre = z + {r} * sin(tilt) + {hth} * cos(tilt).
 *   3 tilt  angle between the coin's face normal and the camera axis (camera looks straight down),
 *           folded to [0, pi/2]: 0 = face-on, pi/2 = edge-on.
 *           Sprite frame for the 16-frame coin_spin sheet (one turn about the sheet's vertical axis,
 *           frame 0 face-on, frame 4 edge-on): frame = round(tilt / (pi/2) * 4), i.e. 0..4.
 *   4 roll  radians, screen space (x right, y down; positive = clockwise on screen):
 *           roll = atan2(ny, nx) of the coin's face normal projected on the screen, i.e. the
 *           direction along which the coin looks foreshortened (squashed). Rotate the sprite by roll
 *           radians about its centre (RN Skia transform [{{ rotate: roll }}], which maps the sprite's
 *           +x axis to (cos roll, sin roll) on a y-down screen): the sheet's horizontal (squash) axis
 *           then lies along that direction and its VERTICAL spin axis along the coin's tilt axis
 *           (the board-plane axis the coin is tipped about). Defined mod pi; exported unwrapped
 *           (continuous) per coin. Face-on (|normal_xy| < 1e-3) the direction is undefined: the
 *           previous frame's value is held (0 before the first defined frame), which avoids a snap.
 */

export type CoinSim = {{ fps: number; frames: number; coins: number; data: readonly number[] }};"""


def write_ts(sims):
    parts = [
        HEADER.format(
            seed=SEED,
            fps=EXPORT_FPS,
            gscale=fmt(GRAVITY_SCALE),
            g=G,
            r=COIN_RADIUS,
            th=COIN_THICK,
            hth=COIN_THICK / 2,
            eb=COIN_RESTITUTION * BOARD_RESTITUTION,
            ew=COIN_RESTITUTION * WALL_RESTITUTION,
            fb=COIN_FRICTION * BOARD_FRICTION,
        )
    ]
    docs = {
        "COIN_BURST": "/** Normal vault hit: {coins} coins out of the cell at (0, 0); {dur} s, no walls. */",
        "COIN_JACKPOT": "/** Board complete: {coins} coins from the board centre, walls at x, y = +-5 (board frame); {dur} s. */",
    }
    for s in sims:
        # z is clamped at 0: the solver's contact margin leaves at most a few thousandths of overlap
        rows = []
        for f in range(s["frames"]):
            vals = []
            for c in range(s["coins"]):
                x, y, z, tilt, roll = s["data"][f * s["coins"] + c]
                vals += [x, y, max(0.0, z), tilt, roll]
            rows.append("    " + ",".join(fmt(v) for v in vals) + ",")
        dur = (s["frames"] - 1) / EXPORT_FPS
        parts.append("")
        parts.append(docs[s["name"]].format(coins=s["coins"], dur=fmt(dur)))
        parts.append(f"export const {s['name']}: CoinSim = {{")
        parts.append(f"  fps: {EXPORT_FPS},")
        parts.append(f"  frames: {s['frames']},")
        parts.append(f"  coins: {s['coins']},")
        parts.append("  // one line per frame")
        parts.append("  data: [")
        parts.extend(rows)
        parts.append("  ],")
        parts.append("};")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        fh.write("\n".join(parts) + "\n")


def main():
    rng = random.Random(SEED)
    sims = [
        run("COIN_BURST", 1.0, build_burst, rng, BURST["settle"]),
        run("COIN_JACKPOT", 2.2, build_jackpot, rng),
    ]
    deepest = {s["name"]: round(s["deepest"], 4) for s in sims}
    # a few thousandths is Bullet's contact slop; more means a coin sank into / tunnelled the board
    assert min(deepest.values()) > -0.01, f"coin penetrated the board: {deepest}"
    write_ts(sims)
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes); deepest hull point {deepest}")


main()
