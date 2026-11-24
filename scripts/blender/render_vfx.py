"""
Renders the premium light-VFX sprites with Blender (Cycles + compositor Glare), headless:

    /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/render_vfx.py -- <out_dir> [burst glint spark ember godrays]

then pack with:

    python3 scripts/blender/pack_sprites.py <out_dir> assets/sprites

Every sprite is drawn in-app with ADDITIVE blending (Skia BlendMode.Plus) over the dark stage, so all
outputs are RGB light on PURE black (alpha = 1): black adds nothing. Outside the effect pixels are exactly
0, and every cell keeps a >= 4 px black margin so atlas sampling never bleeds between frames.

Outputs (final size, written straight to <out_dir>, no further resize needed):
  fx_burst_XX.png   16 frames, 256 x 256  impact flare. 00: small intense pop. 01-03: peak - long horizontal
                    anamorphic streak (~90% of the cell), shorter vertical streak, 11 fine needle rays of
                    varied length, soft gold bloom. 04-15: decay - streaks shrink + dim, rays turn ~12 deg and
                    fade, a thin shockwave ring (crisp leading edge, soft trailing inside, faint warm
                    chromatic fringe) expands 15% -> 90% of the cell. Ease-out timing; frame 15 ~ black.
                    -> fx_burst_sheet.png (4 x 4 cells of 256, row-major, frame 0 top-left)
  fx_glint_XX.png   16 frames, 128 x 128  4-point "diamond" sparkle: needle cross rays + small 45-deg
                    secondary rays, pin-point white core, gentle bloom. Scale 0 -> peak @05 -> 0 @15 while
                    turning 0 -> 45 deg.  -> fx_glint_sheet.png (4 x 4 cells of 128)
  fx_spark.png      128 x 32  motion-stretched spark: thin white-hot core, pale-gold glow, amber haze,
                    needle tail on the LEFT, bright rounded head on the RIGHT (head = direction of travel).
  fx_ember.png      64 x 64   soft round ember: pin-point white core, gold halo, smooth falloff to black.
  fx_pillar_XX.png  12 frames, 96 x 384  loot beam (the "you got it" light pillar over a claimed cell), in
                    WHITE light so the app tints it per treasure: soft volumetric column, light pool at the base,
                    three elliptical halo rings and five motes climbing it. 00-03: the beam shoots up from the
                    base; 04-11: a seamless 8-frame loop (rings/motes rise one slot per loop).
  fx_pillarcore_XX  12 frames, 96 x 384  the beam's white-hot core + base hot spot, same timing, drawn untinted.
                    -> fx_pillar_sheet.png (12 x 2 cells of 96 x 384: haze row, then core row)
  fx_godrays.png    512 x 512 21 soft volumetric light shafts of varied width/length/brightness with a
                    smooth radial falloff and a faint warm centre glow (rotated slowly behind wins).

How: every element is an emissive textured card (needles, gaussian discs, ring strips, wedge fans) whose
intensity profiles are generated in numpy, layered additively (Emission + Transparent) in an orthographic
Cycles render where 1 world unit = 1 output pixel, supersampled 2-4x. The compositor Glare node adds the
optical bloom (Fog Glow) and, on the glint, a faint lens Streaks shimmer. The linear HDR result is read back
from EXR and finished in numpy: box downsample, per-channel exposure tone curve 1 - exp(-E) (hot gold light
burns to white in the core and falls off white -> pale gold -> amber), sRGB encode, a soft safety window
inside the margin, a 1.5/255 black floor, and a gated 1-LSB luma dither against banding.
"""

import math
import os
import random
import shutil
import sys
import time

import bpy
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else "assets/sprites/raw_vfx")
ONLY = set(argv[1:]) or {"burst", "glint", "spark", "ember", "godrays", "pillar"}
os.makedirs(OUT, exist_ok=True)
TMP = os.path.join(OUT, "_exr")
os.makedirs(TMP, exist_ok=True)
MARGIN = 4  # px of guaranteed black around every cell

# linear-light tints (the tone curve turns any of them white where the light is hot)
WHITE = (1.0, 1.0, 1.0)
PALE = (1.0, 0.80, 0.46)  # ~ #FFE9B0 once encoded
GOLD = (1.0, 0.60, 0.17)
AMBER = (1.0, 0.45, 0.07)  # ~ #FFB347
EMBER = (1.0, 0.30, 0.05)  # warm orange-red fringe

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 64
scene.cycles.use_adaptive_sampling = False
scene.cycles.use_denoising = False  # emission-only scene: the only variance is AA jitter
scene.cycles.seed = 3
scene.cycles.max_bounces = 0
scene.cycles.transparent_max_bounces = 256
scene.cycles.filter_width = 1.5
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = "GPU"
except Exception:  # noqa: BLE001 - CPU fallback is fine
    pass
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.render.image_settings.file_format = "OPEN_EXR"
scene.render.image_settings.color_depth = "32"
scene.render.image_settings.exr_codec = "ZIP"
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"

world = bpy.data.worlds.new("Black")
scene.world = world
world.color = (0, 0, 0)
if world.node_tree is not None:
    for n in world.node_tree.nodes:
        if n.type == "BACKGROUND":
            n.inputs["Color"].default_value = (0, 0, 0, 1)
            n.inputs["Strength"].default_value = 0.0

cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
cam_data.clip_start = 0.1
cam_data.clip_end = 100.0
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
cam.location = (0, 0, 50)
scene.camera = cam


# ---------------------------------------------------------------- numpy helpers
def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def uv_grid(w, h):
    u = (np.arange(w) + 0.5) / w
    v = (np.arange(h) + 0.5) / h
    return np.meshgrid(u, v)  # [h, w]; row 0 = v ~ 0 (Blender stores images bottom-up)


def ease_out(t, p=3.0):
    t = min(max(t, 0.0), 1.0)
    return 1.0 - (1.0 - t) ** p


# ---------------------------------------------------------------- intensity textures
TEX = {}


def make_tex(name, intensity):
    h, w = intensity.shape
    img = bpy.data.images.new(name, w, h, float_buffer=True, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    i = intensity.astype(np.float32)
    img.pixels.foreach_set(np.stack([i, i, i, np.ones_like(i)], -1).ravel())
    img.pack()
    TEX[name] = img


def gauss_disc(sig=0.2):
    """Radial gaussian, sigma = sig * card half-size, compact support (0 at the card edge)."""
    u, v = uv_grid(512, 512)
    r = np.hypot(2 * u - 1, 2 * v - 1)
    return np.exp(-0.5 * (r / sig) ** 2) * smoothstep(1.0, 0.86, r)


def glow_disc(a=0.05, p=1.15):
    """Long-tailed lens PSF (1 + (r/a)^2)^-p, compact support, 1 at the centre."""
    u, v = uv_grid(512, 512)
    r = np.hypot(2 * u - 1, 2 * v - 1)
    edge = (1 + (1 / a) ** 2) ** -p
    g = np.clip(((1 + (r / a) ** 2) ** -p - edge) / (1 - edge), 0, None)
    return g * np.clip(1 - r * r, 0, 1) ** 2


def needle(along, sig=0.2, taper=0.7, centred=True, n=2048):
    """Line card along u. Cross-section gaussian (sigma = sig * half-width) thinning toward the tip(s)
    like a needle; along(s) is the brightness profile, s = 0 at the hot end, 1 at the tip."""
    u, v = uv_grid(n, 128)
    s = np.abs(2 * u - 1) if centred else u
    d = np.abs(2 * v - 1)
    sg = sig * (0.04 + 0.96 * (1 - s) ** taper)
    across = np.exp(-0.5 * (d / sg) ** 2) * smoothstep(1.0, 0.86, d)
    return along(s) * across * smoothstep(1.0, 0.985, s)


def ring_profile(v0=0.7, s_in=0.15, s_out=0.075):
    """Across a ring strip (v = 0 inside, 1 outside): crisp leading edge, soft trailing inside. Around it
    (u) a gentle 3 + 5 lobe brightness drift so the wave reads as energy, not a drawn circle."""
    u, v = uv_grid(1024, 512)
    sg = np.where(v < v0, s_in, s_out)
    lobes = 0.8 + 0.2 * (0.6 * np.sin(2 * math.pi * 3 * u + 0.7) + 0.4 * np.sin(2 * math.pi * 5 * u + 2.1))
    across = np.exp(-0.5 * ((v - v0) / sg) ** 2) * smoothstep(0.0, 0.06, v) * smoothstep(1.0, 0.94, v)
    return across * lobes


def shaft(sig=0.42, rise=0.05, fall=3.0, seed=0):
    """Wedge fan (u = r / length, v = across the angle): soft angular gaussian with fine radial striations
    (light through haze), quick rise off the hub, long smooth fall to 0 at the tip, gentle density drift."""
    u, v = uv_grid(512, 512)
    d = np.abs(2 * v - 1)
    rng = np.random.default_rng(seed)
    ph = rng.uniform(0, 2 * math.pi, 6)
    fq = rng.uniform(2.5, 4.0), rng.uniform(5.5, 7.5), rng.uniform(10.0, 13.0)
    striae = (0.5 * np.sin(2 * math.pi * fq[0] * v + ph[0]) + 0.3 * np.sin(2 * math.pi * fq[1] * v + ph[1])
              + 0.2 * np.sin(2 * math.pi * fq[2] * v + ph[2]))
    ang = np.exp(-0.5 * (d / sig) ** 2) * smoothstep(1.0, 0.8, d) * (1 + 0.32 * striae)
    drift = 1 + 0.08 * np.sin(u * 7.0 + ph[3]) + 0.05 * np.sin(u * 13.0 + ph[4] + v * 2.0)
    rad = smoothstep(0.0, rise, u) * (1 - u) ** fall
    return ang * rad * drift


def build_textures():
    make_tex("gauss", gauss_disc(0.2))
    make_tex("glow", glow_disc(0.05, 1.15))
    # anamorphic streak: white-hot centre, quick drop, long faint amber tail
    make_tex(
        "streak_core",
        needle(lambda s: (1 - s) ** 1.2 * (0.55 * np.exp(-s / 0.05) + 0.45 * np.exp(-s / 0.4)), taper=0.6),
    )
    make_tex("streak_glow", needle(lambda s: (1 - s) ** 1.5 * np.exp(-s / 0.45), taper=0.35))
    # rays / needles from the hot end outward
    make_tex(
        "ray",
        needle(lambda s: (1 - s) ** 1.7 * (0.55 + 0.45 * np.exp(-s / 0.18)), taper=0.85, centred=False),
    )
    make_tex(
        "glint_ray",
        needle(lambda s: (1 - s) ** 1.25 * (0.45 + 0.55 * np.exp(-s / 0.12)), taper=1.0),
    )
    make_tex("spark_line", needle(lambda s: (1 - s) ** 1.4 * (0.6 + 0.4 * np.exp(-s / 0.2)), taper=0.9,
                                  centred=False))
    make_tex("ring", ring_profile())
    # loot beam: a wide column that stays wide (low taper), brightest at the base, fading to the top
    make_tex("beam_haze", needle(lambda s: (1 - s) ** 1.3 * (0.35 + 0.65 * np.exp(-s / 0.25)), taper=0.15,
                                 centred=False))
    make_tex("beam_core", needle(lambda s: (1 - s) ** 1.1 * (0.5 + 0.5 * np.exp(-s / 0.15)), taper=0.5,
                                 centred=False))
    for k in range(6):
        make_tex(f"shaft{k}", shaft(sig=(0.40, 0.46, 0.52, 0.36, 0.44, 0.50)[k],
                                    fall=(2.6, 2.3, 2.9, 2.4, 2.7, 2.2)[k], seed=k))


# ---------------------------------------------------------------- scene elements
def node_tree_of(idblock):
    if idblock.node_tree is None:  # Blender < 5 needs use_nodes; 5.x always has a tree
        idblock.use_nodes = True
    return idblock.node_tree


def fx_material(name, tex, color, strength):
    m = bpy.data.materials.new(name)
    nt = node_tree_of(m)
    nt.nodes.clear()
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = TEX[tex]
    t.interpolation = "Linear"
    t.extension = "EXTEND"
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = strength
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*color, 1)
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    add = nt.nodes.new("ShaderNodeAddShader")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(t.outputs["Color"], mul.inputs[0])
    nt.links.new(mul.outputs[0], em.inputs["Strength"])
    nt.links.new(em.outputs[0], add.inputs[0])
    nt.links.new(tr.outputs[0], add.inputs[1])  # emission over full transmission = pure additive light
    nt.links.new(add.outputs[0], out.inputs["Surface"])
    return m


def mesh_from(name, verts, faces, uvs):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    layer = me.uv_layers.new(name="UVMap")
    li = 0
    for f in faces:
        for vi in f:
            layer.data[li].uv = uvs[vi]
            li += 1
    return me


def quad_mesh(name, x0, x1):
    return mesh_from(
        name,
        [(x0, -0.5, 0), (x1, -0.5, 0), (x1, 0.5, 0), (x0, 0.5, 0)],
        [(0, 1, 2, 3)],
        [(0, 0), (1, 0), (1, 1), (0, 1)],
    )


def ring_mesh(r_in, r_out, n=360):
    verts, uvs, faces = [], [], []
    for i in range(n + 1):  # duplicated seam so u runs 0..1 cleanly
        a = 2 * math.pi * i / n
        c, s = math.cos(a), math.sin(a)
        verts += [(r_in * c, r_in * s, 0), (r_out * c, r_out * s, 0)]
        uvs += [(i / n, 0), (i / n, 1)]
    for i in range(n):
        faces.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1))
    return mesh_from("ring", verts, faces, uvs)


def wedge_mesh(length, half_deg, r0=0.5, nr=48, na=8):
    verts, uvs, faces = [], [], []
    h = math.radians(half_deg)
    for k in range(nr + 1):
        r = r0 + (length - r0) * k / nr
        for j in range(na + 1):
            a = -h + 2 * h * j / na
            verts.append((r * math.cos(a), r * math.sin(a), 0))
            uvs.append((r / length, j / na))
    for k in range(nr):
        for j in range(na):
            i0 = k * (na + 1) + j
            faces.append((i0, i0 + na + 1, i0 + na + 2, i0 + 1))
    return mesh_from("wedge", verts, faces, uvs)


MESH = {}
LIVE = []


def clear_fx():
    for o in LIVE:
        me = o.data
        for m in list(me.materials):
            bpy.data.materials.remove(m)
        bpy.data.objects.remove(o)
        if me.users == 0 and me.name not in MESH:
            bpy.data.meshes.remove(me)
    LIVE.clear()
    for me in list(bpy.data.meshes):
        if me.users == 0 and me not in MESH.values():
            bpy.data.meshes.remove(me)


def el(kind, tex, color, strength, pos=(0, 0), rot=0.0, sx=1.0, sy=1.0, **kw):
    return dict(kind=kind, tex=tex, color=color, strength=strength, pos=pos, rot=rot, sx=sx, sy=sy, **kw)


def build(spec, idx):
    k = spec["kind"]
    if k in ("card", "line"):  # card: centred quad; line: quad from the pivot outward along +x
        key = "card" if k == "card" else "line"
        if key not in MESH:
            MESH[key] = quad_mesh(key, -0.5, 0.5) if key == "card" else quad_mesh(key, 0.0, 1.0)
        me = MESH[key].copy()  # own copy -> own material slot
    elif k == "ring":
        me = ring_mesh(spec["r_in"], spec["r_out"])
    elif k == "wedge":
        me = wedge_mesh(spec["length"], spec["half"])
    else:
        raise ValueError(k)
    o = bpy.data.objects.new(f"fx{idx}", me)
    scene.collection.objects.link(o)
    me.materials.append(fx_material(f"m{idx}", spec["tex"], spec["color"], spec["strength"]))
    o.location = (spec["pos"][0], spec["pos"][1], idx * 0.01)  # no coplanar transparent hits
    o.rotation_euler = (0, 0, math.radians(spec["rot"]))
    if k in ("card", "line", "ring"):  # rings take sy to become ellipses (a halo seen in perspective)
        o.scale = (spec["sx"], spec["sy"], 1)
    LIVE.append(o)


def setup_compositor(glares):
    ng = scene.compositing_node_group
    if ng is None:
        ng = bpy.data.node_groups.new("VFXComp", "CompositorNodeTree")
        ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        scene.compositing_node_group = ng
    ng.nodes.clear()
    src = ng.nodes.new("CompositorNodeRLayers").outputs["Image"]
    for cfg in glares:
        g = ng.nodes.new("CompositorNodeGlare")
        for key, val in cfg.items():
            g.inputs[key].default_value = val
        ng.links.new(src, g.inputs["Image"])
        src = g.outputs["Image"]
    ng.links.new(src, ng.nodes.new("NodeGroupOutput").inputs[0])


def render(specs, w, h, ss, glares, tag):
    """Render the element list into a linear float array [h*ss, w*ss, 3], row 0 = top."""
    clear_fx()
    for i, s in enumerate(specs):
        build(s, i)
    scene.render.resolution_x = w * ss
    scene.render.resolution_y = h * ss
    cam_data.ortho_scale = float(max(w, h))  # 1 world unit = 1 output pixel
    setup_compositor(glares)
    path = os.path.join(TMP, tag + ".exr")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    a = np.empty(img.size[0] * img.size[1] * img.channels, np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(img.size[1], img.size[0], img.channels)[::-1, :, :3].copy()
    bpy.data.images.remove(img)
    return a


# ---------------------------------------------------------------- finishing (linear HDR -> 8-bit sprite)
def to_srgb(x):
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(np.maximum(x, 0), 1 / 2.4) - 0.055)


def radial_window(w, h, fade):
    y, x = np.mgrid[0:h, 0:w]
    r = np.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2)
    r1 = min(w, h) / 2 - MARGIN - 1
    return smoothstep(r1, r1 - fade, r)


def rect_window(w, h, fx, fy):
    y, x = np.mgrid[0:h, 0:w]
    dx = np.abs(x + 0.5 - w / 2)
    dy = np.abs(y + 0.5 - h / 2)
    ex, ey = w / 2 - MARGIN - 1, h / 2 - MARGIN - 1
    return smoothstep(ex, ex - fx, dx) * smoothstep(ey, ey - fy, dy)


STATS = []


def finish(lin, ss, window, name, exposure=1.0, seed=0):
    h, w = lin.shape[0] // ss, lin.shape[1] // ss
    lin = lin.reshape(h, ss, w, ss, 3).mean(axis=(1, 3))
    e = np.maximum(lin, 0.0) * exposure
    tm = 1.0 - np.exp(-e)  # per-channel: hot gold light burns to white, faint light keeps its hue
    s = to_srgb(tm)
    cut = float((s * (1 - window[..., None])).max())  # how much the safety window had to remove
    s = s * window[..., None]
    floor = 1.5 / 255
    s = np.clip((s - floor) / (1 - floor), 0.0, 1.0)
    rng = np.random.default_rng(seed)
    n = (rng.random((h, w, 1)) - rng.random((h, w, 1))) / 255.0  # triangular luma dither, +-1 LSB
    s = s + n * smoothstep(3 / 255, 14 / 255, s.max(axis=2, keepdims=True))
    q = np.clip(np.round(s * 255.0), 0, 255).astype(np.uint8)
    save_png(q, os.path.join(OUT, name + ".png"))
    STATS.append((name, int(q.max()), round(cut * 255, 2)))
    return q


def save_png(q, path):
    h, w, _ = q.shape
    img = bpy.data.images.new("out", w, h, alpha=True)
    rgba = np.concatenate([q.astype(np.float32) / 255.0, np.ones((h, w, 1), np.float32)], -1)[::-1]
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def fog(strength, size, threshold=1.0, tint=(1.0, 0.85, 0.6, 1.0)):
    return {
        "Type": "Fog Glow",
        "Quality": "High",
        "Threshold": threshold,
        "Smoothness": 0.5,
        "Strength": strength,
        "Size": size,
        "Saturation": 1.0,
        "Tint": tint,
    }


# ---------------------------------------------------------------- 1. impact burst
def disp(x):
    """Display-space envelope (0..1) -> light multiplier, so fades read evenly after the sRGB encode."""
    return max(x, 0.0) ** 2.2


def streak_set(L, angle, k, sig_core=0.55):
    """Anamorphic streak: needle-thin hot core + soft glow sheath + wide faint amber haze."""
    if L <= 1 or k <= 1e-5:
        return []
    return [
        el("card", "streak_core", GOLD, 60 * k, rot=angle, sx=2 * L, sy=sig_core / 0.1),
        el("card", "streak_glow", AMBER, 4.0 * k, rot=angle, sx=1.8 * L, sy=1.8 / 0.1),
        el("card", "streak_glow", AMBER, 0.6 * k, rot=angle, sx=1.3 * L, sy=5.0 / 0.1),
    ]


# (angle deg, length px, sigma px, brightness): irregular, clear of the 0/90/180/270 streaks
BURST_RAYS = [
    (17, 66, 0.62, 1.00),
    (52, 38, 0.48, 0.60),
    (73, 84, 0.70, 0.90),
    (116, 50, 0.52, 0.70),
    (143, 74, 0.66, 0.95),
    (162, 34, 0.45, 0.55),
    (206, 80, 0.66, 0.85),
    (233, 44, 0.50, 0.65),
    (252, 60, 0.58, 0.80),
    (297, 90, 0.72, 1.00),
    (326, 42, 0.50, 0.60),
]
# sparkle motes riding just behind the shockwave: (angle deg, radius fraction, twinkle phase, brightness)
BURST_MOTES = [(34, 0.86, 0.0, 1.0), (101, 0.93, 0.35, 0.7), (158, 0.82, 0.7, 0.85), (224, 0.9, 0.2, 0.75),
               (281, 0.84, 0.55, 0.95), (338, 0.92, 0.85, 0.65)]


def burst_frame(f):
    S = []

    def q(a, b):  # 0..1 progress between frames a and b
        return min(max((f - a) / (b - a), 0.0), 1.0)

    # display-space envelopes: fast attack, long elegant ease-out tail
    core = (1.0, 1.0, 0.97, 0.93)[f] if f <= 3 else 0.93 * (1 - q(3, 15)) ** 1.15
    halo = (0.7, 1.0, 0.96, 0.88)[f] if f <= 3 else 0.88 * (1 - q(3, 15)) ** 1.35
    streak = (0.75, 1.0, 1.0, 0.93)[f] if f <= 3 else 0.93 * (1 - q(3, 14)) ** 1.1
    rays = (0.62, 1.0, 1.0, 0.9)[f] if f <= 3 else 0.9 * (1 - q(3, 13))
    # hot pin-point core + layered bloom (gold halo, long amber lens tail)
    sig_core = 2.0 if f == 0 else 2.5 - 0.7 * ease_out(f / 15)
    S.append(el("card", "gauss", GOLD, 85 * disp(core), sx=sig_core / 0.1, sy=sig_core / 0.1))
    hs = 6.5 if f == 0 else 9.0
    S.append(el("card", "gauss", GOLD, 3.0 * disp(halo), sx=hs / 0.1, sy=hs / 0.1))
    gr = 36 if f == 0 else 72
    S.append(el("card", "glow", AMBER, 1.8 * disp(halo), sx=2 * gr, sy=2 * gr))
    # anamorphic streaks: horizontal ~90% of the cell at the peak, vertical ~40% of it
    Lh = (44.0, 104.0, 116.0, 114.0)[f] if f <= 3 else 114.0 - 54.0 * ease_out(q(3, 15), 2.0)
    S += streak_set(Lh, 0.0, disp(streak))
    S += streak_set(Lh * 0.42, 90.0, 0.55 * disp(streak), sig_core=0.5)
    # fine needle rays: shoot out on the attack, then turn ~12 deg and fade
    grow = (0.38, 0.84, 1.0, 1.04)[f] if f <= 3 else 1.04 + 0.06 * ease_out(q(3, 15))
    turn = 12.0 * ease_out(q(1, 15), 2.0)
    for ang, length, sig, b in BURST_RAYS:
        a = ang + turn
        pos = (3.0 * math.cos(math.radians(a)), 3.0 * math.sin(math.radians(a)))
        k = disp(rays * b)
        S.append(el("line", "ray", GOLD, 13 * k, pos=pos, rot=a, sx=length * grow, sy=sig / 0.1))
        S.append(el("line", "ray", AMBER, 0.3 * k, pos=pos, rot=a, sx=length * grow * 0.8, sy=2.4 / 0.1))
    # shockwave ring: thin crisp leading edge, soft trailing inside, faint warm chromatic fringe
    if f >= 3:
        p = q(3, 15)
        R = 19.0 + 91.0 * ease_out(p, 3.0)  # 15% -> ~86% of the cell (diameter)
        wt = 7.0 + 5.0 * p  # strip width; leading-edge sigma = 0.075 * wt (~0.5 -> 0.9 px)
        k = disp((0.8 if f == 3 else 1.0) * (1 - p) ** 1.2)

        def ring(dr, width, color, strength):
            r_out = R + dr + 0.3 * width
            return el("ring", "ring", color, strength, r_in=max(r_out - width, 0.5), r_out=r_out)

        cool = tuple(g + (am - g) * p for g, am in zip(GOLD, AMBER))  # cools toward amber as it spreads
        S.append(ring(0.0, wt, cool, 4.0 * k))
        S.append(ring(1.4, wt * 0.8, EMBER, 0.6 * k))
        S.append(ring(-2.5, wt * 2.4, AMBER, 0.12 * k))
        # a few delicate sparkle glints twinkling just behind the wavefront
        for ang, rf, ph, b in BURST_MOTES:
            tw = math.sin(math.pi * min(max((f - 3 - 6 * ph) / 6.0, 0.0), 1.0))
            if tw <= 0.02:
                continue
            a = math.radians(ang + turn)
            pos = (R * rf * math.cos(a), R * rf * math.sin(a))
            mk = disp(tw * b * (1 - p) ** 0.5)
            S.append(el("card", "gauss", GOLD, 14 * mk, pos=pos, sx=0.7 / 0.1, sy=0.7 / 0.1))
            for ra in (0.0, 90.0):
                S.append(el("card", "glint_ray", GOLD, 7 * mk, pos=pos, rot=ra + 20, sx=9.0 * tw, sy=0.4 / 0.1))
    return S


def render_burst():
    win = radial_window(256, 256, 11)
    for f in range(16):
        lin = render(burst_frame(f), 256, 256, 2, [fog(0.3, 0.65, threshold=1.5)], f"burst_{f:02d}")
        finish(lin, 2, win, f"fx_burst_{f:02d}", seed=f)


# ---------------------------------------------------------------- 2. glint twinkle
def render_glint():
    win = radial_window(128, 128, 8)
    for f in range(16):
        if f <= 5:
            s = math.sin(0.5 * math.pi * f / 5)
        else:
            s = math.cos(0.5 * math.pi * (f - 5) / 10) ** 1.3
        rot = 45.0 * f / 15
        S = []
        if s > 1e-4:
            k = s**1.2
            L = 52.0 * s
            for a, lf in ((rot, 1.0), (rot + 90, 0.86)):
                S.append(el("card", "glint_ray", GOLD, 28 * k, rot=a, sx=2 * L * lf, sy=(0.4 + 0.25 * s) / 0.1))
                S.append(el("card", "streak_glow", AMBER, 0.8 * k, rot=a, sx=1.4 * L * lf, sy=2.2 / 0.1))
            for a in (rot + 45, rot + 135):
                S.append(el("card", "glint_ray", GOLD, 16 * k, rot=a, sx=0.72 * L, sy=0.42 / 0.1))
            sc = 0.55 + 0.5 * s
            S.append(el("card", "gauss", GOLD, 70 * k, sx=sc / 0.1, sy=sc / 0.1))
            S.append(el("card", "gauss", GOLD, 1.6 * k, sx=(3.6 * s + 0.8) / 0.1, sy=(3.6 * s + 0.8) / 0.1))
            S.append(el("card", "glow", AMBER, 0.4 * k, sx=2 * 20 * s + 2, sy=2 * 20 * s + 2))
        glares = [
            fog(0.16, 0.5, threshold=1.5),
            {
                "Type": "Streaks",
                "Quality": "High",
                "Threshold": 4.0,
                "Smoothness": 0.5,
                "Strength": 0.18,
                "Streaks": 4,
                "Streaks Angle": math.radians(rot),
                "Iterations": 3,
                "Fade": 0.86,
                "Color Modulation": 0.12,
                "Saturation": 1.0,
                "Tint": (1.0, 0.9, 0.7, 1.0),
            },
        ]
        lin = render(S, 128, 128, 4, glares, f"glint_{f:02d}")
        finish(lin, 4, win, f"fx_glint_{f:02d}", seed=100 + f)


# ---------------------------------------------------------------- 3. spark streak
def render_spark():
    hx = 42.0  # head, px right of centre (cell is 128 x 32)
    S = [
        el("line", "spark_line", GOLD, 50, pos=(hx, 0), rot=180, sx=98, sy=0.4 / 0.1),
        el("line", "spark_line", GOLD, 1.3, pos=(hx, 0), rot=180, sx=84, sy=1.4 / 0.1),
        el("line", "spark_line", AMBER, 0.3, pos=(hx, 0), rot=180, sx=64, sy=2.6 / 0.1),
        el("card", "gauss", GOLD, 60, pos=(hx, 0), sx=1.05 / 0.1, sy=1.05 / 0.1),
        el("card", "gauss", GOLD, 3.0, pos=(hx, 0), sx=2.2 / 0.1, sy=2.2 / 0.1),
    ]
    lin = render(S, 128, 32, 4, [fog(0.1, 0.4, threshold=2.0)], "spark")
    finish(lin, 4, rect_window(128, 32, 6, 4), "fx_spark", seed=200)


# ---------------------------------------------------------------- 4. ember
def render_ember():
    S = [
        el("card", "gauss", GOLD, 40, sx=1.1 / 0.1, sy=1.1 / 0.1),
        el("card", "gauss", GOLD, 2.4, sx=3.4 / 0.1, sy=3.4 / 0.1),
        el("card", "gauss", AMBER, 0.28, sx=5.6 / 0.1, sy=5.6 / 0.1),
    ]
    lin = render(S, 64, 64, 4, [], "ember")
    finish(lin, 4, radial_window(64, 64, 6), "fx_ember", seed=300)


# ---------------------------------------------------------------- 5. god rays
def render_godrays():
    rnd = random.Random(21)
    n = 22
    S = []
    for i in range(n):
        a = i * 360.0 / n + rnd.uniform(-5.0, 5.0)
        kind = rnd.random()
        if kind < 0.3:  # slim, brighter
            half, b = rnd.uniform(1.4, 2.4), rnd.uniform(0.55, 0.9)
        elif kind < 0.75:  # medium
            half, b = rnd.uniform(3.0, 6.0), rnd.uniform(0.45, 1.0)
        else:  # broad, dim haze shaft
            half, b = rnd.uniform(7.0, 11.0), rnd.uniform(0.25, 0.5)
        length = rnd.uniform(175.0, 246.0)
        S.append(el("wedge", f"shaft{rnd.randrange(6)}", GOLD, 0.9 * b, rot=a, length=length, half=half))
    S.append(el("card", "glow", AMBER, 0.4, sx=2 * 240, sy=2 * 240))  # volumetric haze
    S.append(el("card", "gauss", GOLD, 0.5, sx=30 / 0.1, sy=30 / 0.1))  # faint warm centre glow
    S.append(el("card", "gauss", PALE, 0.4, sx=10 / 0.1, sy=10 / 0.1))
    lin = render(S, 512, 512, 2, [fog(0.1, 0.6, threshold=0.6)], "godrays")
    finish(lin, 2, radial_window(512, 512, 30), "fx_godrays", seed=400)


# ---------------------------------------------------------------- 6. loot beam (light pillar)
PILLAR_W, PILLAR_H = 96, 384
PILLAR_BASE = -150.0  # px from the cell centre (world +y is up): the claimed cell sits here
PILLAR_LEN = 320.0


def pillar_frame(f, core):
    """f 0-3: the beam shoots up; f 4-11: seamless loop (phase 0 -> 7/8)."""
    S = []
    if f <= 3:
        g = ease_out((f + 1) / 4.0, 2.5)
        amp = (1.3, 1.4, 1.18, 1.04)[f]
        ph = 0.0
    else:
        g, amp = 1.0, 1.0
        ph = (f - 4) / 8.0
    L = PILLAR_LEN * g
    k = amp * (1 + 0.06 * math.sin(2 * math.pi * ph))
    base = (0.0, PILLAR_BASE)
    if core:
        S.append(el("line", "beam_core", WHITE, 14 * k, pos=base, rot=90, sx=L, sy=1.0 / 0.1))
        S.append(el("card", "gauss", WHITE, 40 * k, pos=base, sx=2.6 / 0.1, sy=2.0 / 0.1))
        S.append(el("card", "gauss", WHITE, 1.4 * k, pos=base, sx=8.0 / 0.1, sy=2.6 / 0.1))
        return S
    # volumetric column: wide haze + tighter glow sheath
    S.append(el("line", "beam_haze", WHITE, 0.42 * k, pos=base, rot=90, sx=L * 1.04, sy=12.5 / 0.1))
    S.append(el("line", "beam_haze", WHITE, 1.7 * k, pos=base, rot=90, sx=L, sy=4.6 / 0.1))
    # light pool on the board (flattened: the board is a floor seen at an angle)
    S.append(el("card", "gauss", WHITE, 1.6 * k, pos=base, sx=11.0 / 0.1, sy=3.2 / 0.1))
    S.append(el("card", "glow", WHITE, 0.25 * k, pos=base, sx=78.0, sy=22.0))
    # three halo rings climbing the column, narrowing as they rise, fading in at the base and out at the top
    for i in range(3):
        u = (i + ph) / 3.0
        y = PILLAR_BASE + u * L * 0.86
        r = 22.0 - 9.0 * u
        a = math.sin(math.pi * min(max(u, 0.0), 1.0)) ** 1.2 * g
        if a < 0.02:
            continue
        S.append(el("ring", "ring", WHITE, 2.2 * k * a, pos=(0.0, y), sy=0.3, r_in=r - 4.0, r_out=r + 4.0))
    # motes riding the beam up
    for j in range(5):
        u = (j / 5.0 + ph) % 1.0
        y = PILLAR_BASE + u * L * 0.92
        x = 13.0 * math.sin(2 * math.pi * (u * 1.5 + j * 0.37))
        a = math.sin(math.pi * u) * g
        if a < 0.03:
            continue
        S.append(el("card", "gauss", WHITE, 14 * a, pos=(x, y), sx=1.0 / 0.1, sy=1.0 / 0.1))
    return S


def render_pillar():
    win = rect_window(PILLAR_W, PILLAR_H, 10, 14)
    for f in range(12):
        for core, name in ((False, "fx_pillar"), (True, "fx_pillarcore")):
            lin = render(pillar_frame(f, core), PILLAR_W, PILLAR_H, 2, [fog(0.1, 0.5, threshold=1.6)],
                         f"{name}_{f:02d}")
            finish(lin, 2, win, f"{name}_{f:02d}", seed=500 + f + (50 if core else 0))


# ---------------------------------------------------------------- main
t0 = time.time()
build_textures()
for key, fn in (
    ("burst", render_burst),
    ("glint", render_glint),
    ("spark", render_spark),
    ("ember", render_ember),
    ("godrays", render_godrays),
    ("pillar", render_pillar),
):
    if key in ONLY:
        t = time.time()
        fn()
        print(f"[vfx] {key}: {time.time() - t:.1f}s")
shutil.rmtree(TMP, ignore_errors=True)
for name, mx, cut in STATS:
    print(f"[vfx] {name}: max {mx}, safety-window cut {cut}/255")
print(f"[vfx] done in {time.time() - t0:.1f}s -> {OUT}")
