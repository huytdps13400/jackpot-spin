"""
Renders the jackpot treasure-chest opening animation with Blender (Cycles), headless:

    /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/render_chest.py -- <out_dir>

Outputs (transparent PNG, 512 x 512, fixed perspective camera, front 3/4 view from slightly above):
  chest_open_XX.png  16 frames, lid closed (frame 00) -> open ~105 deg (frame 15), eased: fast start,
                     a small overshoot, gentle settle. Warm "treasure light" from the coin heap grows
                     with the opening and lights the ruby-velvet underside of the lid.

The camera is fitted once to the union of every frame's silhouette (closed body + fully swung lid),
so the chest stays centred and fills ~85% of the frame without the framing ever moving.
Pack with scripts/blender/pack_sprites.py -> assets/sprites/chest_open_sheet.png (4 x 4 cells of 256).

Look: "Royal Treasure" — dark polished mahogany planks, polished gold bands / corners / hinges,
a ruby lock plate, gold coins and gems inside, navy + warm-gold world reflections.
"""

import math
import os
import random
import sys

import bmesh
import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else "assets/sprites/raw_chest")
os.makedirs(OUT, exist_ok=True)
SIZE = 512
FRAMES = 16
OPEN_DEG = 105.0
FILL = 0.85  # fraction of the frame the union silhouette spans (larger side)
random.seed(7)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 64
scene.cycles.use_denoising = True
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = "GPU"
except Exception:  # noqa: BLE001 - CPU fallback is fine
    pass
scene.render.resolution_x = SIZE
scene.render.resolution_y = SIZE
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"


# ---------------------------------------------------------------- helpers
def node_tree_of(idblock):
    if idblock.node_tree is None:  # Blender < 5 needs use_nodes; 5.x always has a tree
        idblock.use_nodes = True
    return idblock.node_tree


def ramp_node(nt, stops):
    r = nt.nodes.new("ShaderNodeValToRGB")
    els = r.color_ramp.elements
    while len(els) < len(stops):
        els.new(0.5)
    for el, (pos, col) in zip(els, stops):
        el.position = pos
        el.color = (*col, 1)
    return r


def link_obj(name, me, parent=None):
    o = bpy.data.objects.new(name, me)
    scene.collection.objects.link(o)
    if parent is not None:
        o.parent = parent
    return o


def make_mesh(name, verts, faces, mat, smooth=False, sharp_deg=32.0):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = smooth
    if smooth:
        me.set_sharp_from_angle(angle=math.radians(sharp_deg))
    return me


def bevel(o, width, segments=2, angle=35.0):
    m = o.modifiers.new("Bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    m.angle_limit = math.radians(angle)
    return o


def box(name, x0, x1, y0, y1, z0, z1, mat, bev=0.01, parent=None):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    o = link_obj(name, make_mesh(name, v, f, mat, smooth=True), parent)
    if bev > 0:
        bevel(o, bev, 3)
    return o


def arc_shell(name, x0, x1, r0, r1, p0, p1, mat, n=None, cx=0.0, cz=0.0, bev=0.008, parent=None):
    """Annular sector extruded along X. Angle p: 0 = pointing -Y (front), 90 = up, 180 = +Y (back)."""
    n = n or max(2, int(abs(p1 - p0) / 6))
    verts, faces = [], []
    for k in range(n + 1):
        a = math.radians(p0 + (p1 - p0) * k / n)
        cy, sz = -math.cos(a), math.sin(a)
        for x in (x0, x1):
            for r in (r0, r1):
                verts.append((x, cx + r * cy, cz + r * sz))
    # per step 4 verts: (x0,r0),(x0,r1),(x1,r0),(x1,r1)
    for k in range(n):
        a, b = 4 * k, 4 * (k + 1)
        faces += [(a + 1, b + 1, b + 3, a + 3), (a + 0, a + 2, b + 2, b + 0), (a + 0, b + 0, b + 1, a + 1), (a + 2, a + 3, b + 3, b + 2)]
    e = 4 * n
    faces += [(0, 1, 3, 2), (e + 0, e + 2, e + 3, e + 1)]
    o = link_obj(name, make_mesh(name, verts, faces, mat, smooth=True), parent)
    if bev > 0:
        bevel(o, bev, 2)
    return o


def half_disc(name, x0, x1, r, mat, cz=0.0, n=36, parent=None):
    """Solid half-disc (lid end panel) in the YZ plane, extruded x0..x1."""
    verts = []
    for x in (x0, x1):
        verts.append((x, 0.0, cz))
        for k in range(n + 1):
            a = math.pi * k / n
            verts.append((x, -r * math.cos(a), cz + r * math.sin(a)))
    m = n + 2
    faces = [tuple(range(0, m)), tuple(range(m, 2 * m))]
    for k in range(1, n + 1):
        faces.append((k, k + 1, m + k + 1, m + k))
    faces.append((0, 1, m + 1, m))
    faces.append((n + 1, 0, m, m + n + 1))
    o = link_obj(name, make_mesh(name, verts, faces, mat, smooth=True), parent)
    bevel(o, 0.01, 2)
    return o


def cylinder_x(name, x0, x1, y, z, r, mat, n=24, parent=None):
    verts = []
    for x in (x0, x1):
        for k in range(n):
            a = 2 * math.pi * k / n
            verts.append((x, y + r * math.cos(a), z + r * math.sin(a)))
    faces = [tuple(range(n)), tuple(range(n, 2 * n))]
    for k in range(n):
        faces.append((k, (k + 1) % n, n + (k + 1) % n, n + k))
    o = link_obj(name, make_mesh(name, verts, faces, mat, smooth=True), parent)
    bevel(o, 0.008, 2)
    return o


# ---------------------------------------------------------------- materials
def principled(name):
    m = bpy.data.materials.new(name)
    t = node_tree_of(m)
    return m, t, t.nodes["Principled BSDF"]


def gold_mat(name, base=(1.0, 0.74, 0.24), rough=0.2):
    m, _, p = principled(name)
    p.inputs["Base Color"].default_value = (*base, 1)
    p.inputs["Metallic"].default_value = 1.0
    p.inputs["Roughness"].default_value = rough
    return m


def wood_mat(name, grain_axis):
    """Dark polished mahogany; grain_axis 'X' or 'Y' is the plank's long direction."""
    m, t, p = principled(name)
    tc = t.nodes.new("ShaderNodeTexCoord")
    mp = t.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1.2, 22.0, 22.0) if grain_axis == "X" else (22.0, 1.2, 22.0)
    t.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nz = t.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 1.6
    nz.inputs["Detail"].default_value = 8.0
    nz.inputs["Distortion"].default_value = 1.4
    t.links.new(mp.outputs["Vector"], nz.inputs["Vector"])
    r = ramp_node(t, [(0.30, (0.014, 0.0030, 0.0018)), (0.55, (0.045, 0.0095, 0.0042)), (0.75, (0.090, 0.021, 0.0075))])
    t.links.new(nz.outputs["Fac"], r.inputs["Fac"])
    t.links.new(r.outputs["Color"], p.inputs["Base Color"])
    bump = t.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.08
    bump.inputs["Distance"].default_value = 0.01
    t.links.new(nz.outputs["Fac"], bump.inputs["Height"])
    t.links.new(bump.outputs["Normal"], p.inputs["Normal"])
    p.inputs["Roughness"].default_value = 0.45
    p.inputs["Coat Weight"].default_value = 0.8
    p.inputs["Coat Roughness"].default_value = 0.1
    return m


def gem_mat(name, color, ior=1.77, glow=0.0):
    m, _, p = principled(name)
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Transmission Weight"].default_value = 1.0
    p.inputs["IOR"].default_value = ior
    p.inputs["Roughness"].default_value = 0.02
    p.inputs["Emission Color"].default_value = (*color, 1)
    p.inputs["Emission Strength"].default_value = glow
    return m


GOLD = gold_mat("Gold")
COIN = gold_mat("Coin", (1.0, 0.72, 0.25), 0.24)
WOOD_X = wood_mat("WoodX", "X")
WOOD_Y = wood_mat("WoodY", "Y")
RUBY = gem_mat("Ruby", (0.85, 0.02, 0.10), 1.77, 0.35)
SAPPHIRE = gem_mat("Sapphire", (0.06, 0.18, 0.95), 1.77, 0.25)
EMERALD = gem_mat("Emerald", (0.03, 0.75, 0.28), 1.58, 0.2)
DIAMOND = gem_mat("Diamond", (1.0, 1.0, 1.0), 2.42, 0.0)

VELVET, _, p = principled("RubyVelvet")  # lid lining
p.inputs["Base Color"].default_value = (0.13, 0.003, 0.018, 1)
p.inputs["Roughness"].default_value = 0.8
p.inputs["Specular IOR Level"].default_value = 0.12
p.inputs["Sheen Weight"].default_value = 0.2
p.inputs["Sheen Tint"].default_value = (0.9, 0.06, 0.16, 1)

# coin heap under the loose coins: gold, coin-scale bumps, glows from inside (strength animated)
HEAP, t, p = principled("Heap")
p.inputs["Base Color"].default_value = (1.0, 0.66, 0.20, 1)
p.inputs["Metallic"].default_value = 1.0
p.inputs["Roughness"].default_value = 0.3
p.inputs["Emission Color"].default_value = (1.0, 0.58, 0.14, 1)
vor = t.nodes.new("ShaderNodeTexVoronoi")
vor.inputs["Scale"].default_value = 11.0
hb = t.nodes.new("ShaderNodeBump")
hb.inputs["Strength"].default_value = 0.6
t.links.new(vor.outputs["Distance"], hb.inputs["Height"])
t.links.new(hb.outputs["Normal"], p.inputs["Normal"])
HEAP_GLOW = p.inputs["Emission Strength"]
COIN_P = COIN.node_tree.nodes["Principled BSDF"]
COIN_P.inputs["Emission Color"].default_value = (1.0, 0.62, 0.18, 1)
COIN_GLOW = COIN_P.inputs["Emission Strength"]


# ---------------------------------------------------------------- world: navy room, warm gold glow
world = bpy.data.worlds.new("RoyalVault")
scene.world = world
nt = node_tree_of(world)
for n in list(nt.nodes):
    nt.nodes.remove(n)
tc = nt.nodes.new("ShaderNodeTexCoord")
sep = nt.nodes.new("ShaderNodeSeparateXYZ")
nt.links.new(tc.outputs["Generated"], sep.inputs[0])
zmap = nt.nodes.new("ShaderNodeMapRange")
zmap.inputs["From Min"].default_value = -1.0
nt.links.new(sep.outputs["Z"], zmap.inputs["Value"])
sky = ramp_node(
    nt,
    [
        (0.00, (0.004, 0.004, 0.012)),
        (0.48, (0.012, 0.014, 0.045)),
        (0.54, (0.20, 0.11, 0.035)),  # warm gold horizon band (gold edges catch it)
        (0.66, (0.020, 0.026, 0.085)),
        (1.00, (0.05, 0.045, 0.06)),
    ],
)
nt.links.new(zmap.outputs["Result"], sky.inputs["Fac"])
acc = sky.outputs["Color"]
# (direction, ramp start, colour): a warm softbox front-left above (key reflections on the lid),
# and warm glows low front-left / low back-right — exactly where the camera-facing front and side
# gold faces mirror to (r = reflect(view, n)), so flat straps / plate / bands read gold, not black.
for vec, start, col in (
    ((-0.5, -0.55, 0.67), 0.75, (1.4, 1.15, 0.8)),
    ((-0.47, -0.81, -0.36), 0.45, (1.0, 0.84, 0.55)),
    ((0.47, 0.81, -0.36), 0.55, (0.75, 0.60, 0.38)),
):
    dotn = nt.nodes.new("ShaderNodeVectorMath")
    dotn.operation = "DOT_PRODUCT"
    nt.links.new(tc.outputs["Generated"], dotn.inputs[0])
    dotn.inputs[1].default_value = Vector(vec).normalized()
    lobe = ramp_node(nt, [(start, (0.0, 0.0, 0.0)), (1.0, col)])
    nt.links.new(dotn.outputs["Value"], lobe.inputs["Fac"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "ADD"
    mix.inputs["Factor"].default_value = 1.0
    nt.links.new(acc, mix.inputs["A"])
    nt.links.new(lobe.outputs["Color"], mix.inputs["B"])
    acc = mix.outputs["Result"]
bg = nt.nodes.new("ShaderNodeBackground")
bg.inputs["Strength"].default_value = 1.0
nt.links.new(acc, bg.inputs["Color"])
wo = nt.nodes.new("ShaderNodeOutputWorld")
nt.links.new(bg.outputs[0], wo.inputs[0])


# ---------------------------------------------------------------- chest geometry
# X right, -Y = front (toward camera), Z up. Body 2.0 x 1.3 x 1.0, barrel lid of radius 0.65.
W, D, H, T = 1.0, 0.65, 1.0, 0.08  # half-width, half-depth, height, wall thickness
R = 0.65  # lid outer radius (axis along X at y=0, z=H)
GAP = 0.006  # plank seam

# body planks (3 per wall) + floor
for i in range(3):
    z0, z1 = i * H / 3 + GAP, (i + 1) * H / 3 - GAP
    box(f"PlankF{i}", -W, W, -D, -D + T, z0, z1, WOOD_X, 0.012)
    box(f"PlankB{i}", -W, W, D - T, D, z0, z1, WOOD_X, 0.012)
    box(f"PlankL{i}", -W, -W + T, -D + T, D - T, z0, z1, WOOD_Y, 0.012)
    box(f"PlankR{i}", W - T, W, -D + T, D - T, z0, z1, WOOD_Y, 0.012)
box("Floor", -W + T, W - T, -D + T, D - T, 0.0, 0.08, WOOD_X, 0.0)

# gold: top + bottom bands, vertical straps, corner protectors, hinges
O = 0.022  # how far the gold stands proud of the wood
for name, z0, z1 in (("BandBottom", 0.0, 0.10), ("BandTop", H - 0.10, H)):
    box(name + "F", -W - O, W + O, -D - O, -D + 0.02, z0, z1, GOLD)
    box(name + "B", -W - O, W + O, D - 0.02, D + O, z0, z1, GOLD)
    box(name + "L", -W - O, -W + 0.02, -D - O, D + O, z0, z1, GOLD)
    box(name + "R", W - 0.02, W + O, -D - O, D + O, z0, z1, GOLD)
STRAP_X = 0.56
STRAP_W = 0.085
SP = 0.012  # straps stand proud of the bands (coplanar faces leave a dark bevel crevice)
for sx in (-1, 1):
    x = sx * STRAP_X
    box(f"StrapF{sx}", x - STRAP_W, x + STRAP_W, -D - O - SP, -D + 0.02, 0.0, H, GOLD)
    box(f"StrapB{sx}", x - STRAP_W, x + STRAP_W, D - 0.02, D + O + SP, 0.0, H, GOLD)
CW = 0.15  # corner protector leg length
for sx in (-1, 1):
    for sy in (-1, 1):
        xo, yo = sx * (W + O + 0.004), sy * (D + O + 0.004)
        box(f"CornerA{sx}{sy}", min(xo, xo - sx * CW), max(xo, xo - sx * CW), min(yo, yo - sy * 0.03), max(yo, yo - sy * 0.03), 0.0, H, GOLD, 0.008)
        box(f"CornerB{sx}{sy}", min(xo, xo - sx * 0.03), max(xo, xo - sx * 0.03), min(yo, yo - sy * CW), max(yo, yo - sy * CW), 0.0, H, GOLD, 0.008)
# rivets on the straps
for sx in (-1, 1):
    for z in (0.22, 0.5, 0.78):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.028, segments=16, ring_count=8, location=(sx * STRAP_X, -D - O - SP - 0.004, z))
        rv = bpy.context.object
        rv.scale = (1, 0.55, 1)
        bpy.ops.object.shade_smooth()
        rv.data.materials.append(GOLD)
for sx in (-1, 1):
    cylinder_x(f"Hinge{sx}", sx * STRAP_X - 0.12, sx * STRAP_X + 0.12, D + 0.02, H, 0.05, GOLD)

# lock plate + ruby
LOCK_Z = 0.62
box("LockPlate", -0.2, 0.2, -D - O - 0.035, -D - O + 0.005, 0.40, 0.86, GOLD, 0.02)
bpy.ops.mesh.primitive_torus_add(major_radius=0.1, minor_radius=0.02, major_segments=48, minor_segments=12,
                                 location=(0, -D - O - 0.04, LOCK_Z), rotation=(math.pi / 2, 0, 0))
bpy.ops.object.shade_smooth()
bpy.context.object.data.materials.append(GOLD)


def gem(name, mat, loc, size, rot=(0, 0, 0), n=8, parent=None):
    """Round brilliant-ish cut: table, crown, girdle, pavilion. Table faces local +Z."""
    table, crown, pav = 0.56, 0.30, 0.72
    verts = [(0, 0, crown)]
    for k in range(n):
        a = 2 * math.pi * k / n
        verts.append((table * math.cos(a), table * math.sin(a), crown))
    for k in range(n):
        a = 2 * math.pi * (k + 0.5) / n
        verts.append((math.cos(a), math.sin(a), 0.0))
    verts.append((0, 0, -pav))
    faces = []
    for k in range(n):
        t0, t1 = 1 + k, 1 + (k + 1) % n
        g0, gm1 = 1 + n + k, 1 + n + (k - 1) % n
        faces.append((0, t0, t1))
        faces.append((t0, gm1, g0))
        faces.append((t0, g0, t1))
        faces.append((g0, gm1, 2 * n + 1))
    me = make_mesh(name, verts, faces, mat, smooth=False)
    o = link_obj(name, me, parent)
    o.location = loc
    o.rotation_euler = rot
    o.scale = (size, size, size)
    return o


gem("LockRuby", RUBY, (0, -D - O - 0.045, LOCK_Z), 0.085, rot=(math.pi / 2, 0, 0))

# ---------------------------------------------------------------- lid (parented to the hinge pivot)
pivot = bpy.data.objects.new("LidPivot", None)
scene.collection.objects.link(pivot)
pivot.location = (0, D, H)


def lid_part(o):
    """Re-parent a part built in chest space to the hinge pivot without moving it."""
    o.parent = pivot
    o.matrix_parent_inverse = Matrix.Translation((0, -D, -H))
    return o


LT = 0.07  # lid thickness
STAVES = 7
for k in range(STAVES):
    p0 = 180 * k / STAVES + 0.6
    p1 = 180 * (k + 1) / STAVES - 0.6
    lid_part(arc_shell(f"Stave{k}", -W + T, W - T, R - LT, R, p0, p1, WOOD_X, n=5, cz=H, bev=0.01))
for sx in (-1, 1):
    x0, x1 = (W - T, W) if sx > 0 else (-W, -W + T)
    lid_part(half_disc(f"LidEnd{sx}", x0, x1, R, WOOD_Y, cz=H))
# ruby-velvet lining on the underside (what the treasure light falls on)
lid_part(arc_shell("Lining", -W + T, W - T, R - LT - 0.012, R - LT - 0.002, 0.5, 179.5, VELVET, n=40, cz=H, bev=0.0))
# gold on the lid: straps over the barrel, end bands, front lip, hasp
for sx in (-1, 1):
    x = sx * STRAP_X
    lid_part(arc_shell(f"LidStrap{sx}", x - STRAP_W, x + STRAP_W, R - 0.01, R + O + SP, 0, 180, GOLD, n=40, cz=H))
    x0, x1 = (W - 0.10, W + O) if sx > 0 else (-W - O, -W + 0.10)
    lid_part(arc_shell(f"LidEndBand{sx}", x0, x1, R - 0.02, R + O, 0, 180, GOLD, n=40, cz=H))
lid_part(arc_shell("LidLipFront", -W - O, W + O, R - LT - 0.01, R + O, 0, 9, GOLD, n=3, cz=H))
lid_part(arc_shell("LidLipBack", -W - O, W + O, R - LT - 0.01, R + O, 171, 180, GOLD, n=3, cz=H))
lid_part(box("Hasp", -0.085, 0.085, -D - O - 0.075, -D - O - 0.035, 0.80, H + 0.12, GOLD, 0.015))
for sx in (-1, 1):  # inner hinge knuckle rides with the lid
    x0, x1 = sorted((sx * (STRAP_X - 0.20), sx * (STRAP_X - 0.12)))
    lid_part(cylinder_x(f"LidHinge{sx}", x0, x1, D + 0.02, H, 0.05, GOLD))


# ---------------------------------------------------------------- treasure inside
IX, IY = W - T - 0.02, D - T - 0.02  # interior half-extents


def heap_z(x, y):
    u = max(0.0, 1 - (x / (IX + 0.05)) ** 2)
    v = max(0.0, 1 - (y / (IY + 0.05)) ** 2)
    return 0.86 + 0.27 * (u**0.7) * (v**0.8) + 0.015 * math.sin(7 * x + 2) * math.cos(9 * y)


NX, NY = 40, 26
hv, hf = [], []
for j in range(NY + 1):
    for i in range(NX + 1):
        x = -IX + 2 * IX * i / NX
        y = -IY + 2 * IY * j / NY
        hv.append((x, y, heap_z(x, y)))
for j in range(NY):
    for i in range(NX):
        a = j * (NX + 1) + i
        hf.append((a, a + 1, a + NX + 2, a + NX + 1))
heap_me = bpy.data.meshes.new("Heap")
heap_me.from_pydata(hv, [], hf)
heap_me.materials.append(HEAP)
for p_ in heap_me.polygons:
    p_.use_smooth = True
link_obj("Heap", heap_me)

# loose coins: one shared mesh, many instances lying on the heap with random tilt
bpy.ops.mesh.primitive_cylinder_add(vertices=28, radius=0.085, depth=0.022)
coin_src = bpy.context.object
coin_src.data.materials.append(COIN)
bpy.ops.object.shade_smooth()
coin_src.data.set_sharp_from_angle(angle=math.radians(40))
bevel(coin_src, 0.006, 2, 40)
bpy.ops.object.modifier_apply(modifier="Bevel")
coin_mesh = coin_src.data
bpy.data.objects.remove(coin_src, do_unlink=True)


def heap_normal(x, y, e=0.01):
    dx = (heap_z(x + e, y) - heap_z(x - e, y)) / (2 * e)
    dy = (heap_z(x, y + e) - heap_z(x, y - e)) / (2 * e)
    return Vector((-dx, -dy, 1)).normalized()


coins = []
for k in range(190):
    x = random.uniform(-IX + 0.06, IX - 0.06)
    y = random.uniform(-IY + 0.05, IY - 0.05)
    nrm = heap_normal(x, y)
    tilt = Vector((random.uniform(-1, 1), random.uniform(-1, 1), 0)) * random.uniform(0.0, 0.55)
    up = (nrm + tilt).normalized()
    o = link_obj(f"Coin{k}", coin_mesh)
    q = Vector((0, 0, 1)).rotation_difference(up)
    o.rotation_euler = (q @ Matrix.Rotation(random.uniform(0, 6.28), 3, "Z").to_quaternion()).to_euler()
    o.location = (x, y, heap_z(x, y) + random.uniform(0.0, 0.03))
    coins.append(o)
# gems resting on the heap
for name, mat, x, y, s in (
    ("GemR1", RUBY, -0.35, -0.12, 0.085),
    ("GemR2", RUBY, 0.42, 0.05, 0.075),
    ("GemS1", SAPPHIRE, 0.05, -0.22, 0.08),
    ("GemS2", SAPPHIRE, -0.62, 0.18, 0.065),
    ("GemE1", EMERALD, 0.66, -0.25, 0.07),
    ("GemD1", DIAMOND, -0.1, 0.18, 0.075),
    ("GemR3", RUBY, 0.22, 0.30, 0.06),
):
    nrm = heap_normal(x, y)
    q = Vector((0, 0, 1)).rotation_difference((nrm + Vector((random.uniform(-0.4, 0.4), -0.35, 0))).normalized())
    gem(name, mat, (x, y, heap_z(x, y) + s * 0.55), s, rot=q.to_euler())

# ---------------------------------------------------------------- lights
def area_light(name, loc, energy, color, size, target=(0, 0, 0.9), size_y=None):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.color = color
    if size_y is None:
        data.size = size
    else:
        data.shape = "RECTANGLE"
        data.size, data.size_y = size, size_y
    obj = bpy.data.objects.new(name, data)
    obj.location = loc
    scene.collection.objects.link(obj)
    obj.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return obj


area_light("Key", (-3.2, -3.6, 4.6), 1500, (1.0, 0.92, 0.80), 3.0)  # front-left, above
area_light("Rim", (3.4, 3.2, 3.4), 1300, (1.0, 0.68, 0.32), 2.0)  # warm gold back-right rim
area_light("Fill", (3.8, -3.2, 1.2), 260, (0.35, 0.5, 1.0), 3.0)  # royal-blue fill, front-right low

# treasure light: grows with the opening (energies set per frame)
glow_pt = bpy.data.lights.new("TreasureGlow", "POINT")
glow_pt.color = (1.0, 0.66, 0.26)
glow_pt.shadow_soft_size = 0.45
glow_obj = bpy.data.objects.new("TreasureGlow", glow_pt)
glow_obj.location = (0, -0.05, 1.52)
scene.collection.objects.link(glow_obj)
up = area_light("TreasureUp", (0, 0, 1.22), 0, (1.0, 0.62, 0.22), 1.5, target=(0, 0, 3), size_y=0.9)
for o in scene.objects:
    if o.type == "LIGHT":
        o.visible_camera = False
GLOW_PT_MAX, GLOW_UP_MAX, HEAP_MAX, COIN_MAX = 80.0, 25.0, 1.25, 0.25

# ---------------------------------------------------------------- animation curve
def ease_out_back(t, c1=1.0):
    u = t - 1
    return 1 + (c1 + 1) * u**3 + c1 * u**2


def lid_deg(i):
    return OPEN_DEG * ease_out_back(i / (FRAMES - 1))


def set_frame(i):
    a = lid_deg(i)
    pivot.rotation_euler = (-math.radians(a), 0, 0)
    s = min(1.0, max(0.0, a / OPEN_DEG))
    g = s**1.4
    glow_pt.energy = GLOW_PT_MAX * g
    up.data.energy = GLOW_UP_MAX * g
    HEAP_GLOW.default_value = 0.15 + HEAP_MAX * g
    COIN_GLOW.default_value = COIN_MAX * g


# ---------------------------------------------------------------- camera, fitted to all frames
cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 50
cam_data.sensor_fit = "HORIZONTAL"
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
AZ, EL, DIST = math.radians(30), math.radians(21), 9.0  # front 3/4 from the right, slightly above
target = Vector((0, 0, 1.0))
cam.location = target + DIST * Vector((math.sin(AZ) * math.cos(EL), -math.cos(AZ) * math.cos(EL), math.sin(EL)))
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()


def silhouette_bounds():
    us, vs = [], []
    bounds_only = set(coins)
    for i in range(FRAMES):
        set_frame(i)
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        for o in scene.objects:
            if o.type != "MESH" or (i > 0 and o.parent is not pivot):
                continue
            if o in bounds_only:
                pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
            else:
                ev = o.evaluated_get(dg)
                me = ev.to_mesh()
                pts = [ev.matrix_world @ v.co for v in me.vertices]
                ev.to_mesh_clear()
            for p_ in pts:
                c = world_to_camera_view(scene, cam, p_)
                us.append(c.x)
                vs.append(c.y)
    return min(us), max(us), min(vs), max(vs)


for _ in range(2):  # shift/lens are linear in projected space; a second pass removes residue
    u0, u1, v0, v1 = silhouette_bounds()
    k = FILL / max(u1 - u0, v1 - v0)
    cu, cv = (u0 + u1) / 2 - 0.5, (v0 + v1) / 2 - 0.5
    cam_data.shift_x = (cam_data.shift_x + cu) * k
    cam_data.shift_y = (cam_data.shift_y + cv) * k
    cam_data.lens *= k
u0, u1, v0, v1 = silhouette_bounds()
print(f"FRAMING u {u0:.3f}..{u1:.3f} v {v0:.3f}..{v1:.3f} lens {cam_data.lens:.1f}")

# ---------------------------------------------------------------- render
for i in range(FRAMES):
    set_frame(i)
    print(f"FRAME {i:02d} lid {lid_deg(i):6.1f} deg")
    scene.render.filepath = os.path.join(OUT, f"chest_open_{i:02d}.png")
    bpy.ops.render.render(write_still=True)

print("RENDERED", OUT)
