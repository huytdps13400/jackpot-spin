"""
Renders the board tile sprites with Blender (Cycles), headless:

    /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/render_tiles.py -- <out_dir>

Outputs (transparent PNG, orthographic top-down, the tile fills the frame):
  tile_idle.png      unclaimed "vault lid": midnight-sapphire lacquer slab inside a thin polished gold rim
  tile_gold.png      claimed "open jewel setting": polished gold bezel around a dark, recessed bronze bed
  tile_flip_XX.png   24 frames, the two-sided tile (lid front / setting back) flipping 0 -> 180 deg
                     around the screen's horizontal axis — the "claim" (and, reversed, the reset).
                     Frame 00 is pixel-identical to tile_idle, frame 23 to tile_gold.

Numbers and treasure icons are NOT baked: the Skia tile engine draws them at runtime, so these
renders serve all 100 cells and every per-tile animation (wave, press, lift) stays on the UI thread.
That is why both faces keep a dark, plain centre.

Look: "Royal Treasure" — midnight navy + polished gold + ruby. The world is navy with a warm gold
glow; the gold parts additionally see a light-linked warm reflection card (invisible to the camera
and to the sapphire), so flat gold reads bright yellow while the lacquer stays deep blue.
"""

import math
import os
import shutil
import sys

import bmesh
import bpy

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else "assets/sprites/raw_tiles")
os.makedirs(OUT, exist_ok=True)
SIZE = 256

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 128
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


# ---------------------------------------------------------------- node helpers
def node_tree_of(idblock):
    if idblock.node_tree is None:  # Blender < 5 needs use_nodes; 5.x always has a tree
        idblock.use_nodes = True
    return idblock.node_tree


def ramp_node(nt, stops):
    """ColorRamp with the given [(pos, (r, g, b)), ...] stops (linear colours)."""
    r = nt.nodes.new("ShaderNodeValToRGB")
    els = r.color_ramp.elements
    while len(els) < len(stops):
        els.new(0.5)
    for el, (pos, col) in zip(els, stops):
        el.position = pos
        el.color = (*col, 1)
    return r


# ---------------------------------------------------------------- world: royal-treasure room
# navy everywhere, a warm candle-gold glow from the top-left and a faint gold band at the horizon
world = bpy.data.worlds.new("RoyalVault")
scene.world = world
nt = node_tree_of(world)
for n in list(nt.nodes):
    nt.nodes.remove(n)
tc = nt.nodes.new("ShaderNodeTexCoord")
sep = nt.nodes.new("ShaderNodeSeparateXYZ")
nt.links.new(tc.outputs["Generated"], sep.inputs[0])
zmap = nt.nodes.new("ShaderNodeMapRange")  # z in [-1, 1] -> [0, 1]
zmap.inputs["From Min"].default_value = -1.0
nt.links.new(sep.outputs["Z"], zmap.inputs["Value"])
sky = ramp_node(
    nt,
    [
        (0.00, (0.002, 0.002, 0.006)),
        (0.48, (0.010, 0.012, 0.040)),
        (0.55, (0.090, 0.050, 0.016)),  # faint gold horizon band
        (0.66, (0.016, 0.020, 0.070)),
        (1.00, (0.006, 0.008, 0.028)),  # dark navy zenith: the flat lacquer reflects this
    ],
)
nt.links.new(zmap.outputs["Result"], sky.inputs["Fac"])
lobe_dir = nt.nodes.new("ShaderNodeVectorMath")
lobe_dir.operation = "DOT_PRODUCT"
nt.links.new(tc.outputs["Generated"], lobe_dir.inputs[0])
lobe_dir.inputs[1].default_value = (-0.55, 0.55, 0.63)  # top-left, ~40 deg up
lobe = ramp_node(nt, [(0.80, (0.0, 0.0, 0.0)), (1.0, (1.1, 0.70, 0.30))])
nt.links.new(lobe_dir.outputs["Value"], lobe.inputs["Fac"])
add = nt.nodes.new("ShaderNodeMix")
add.data_type = "RGBA"
add.blend_type = "ADD"
add.inputs["Factor"].default_value = 1.0
nt.links.new(sky.outputs["Color"], add.inputs["A"])
nt.links.new(lobe.outputs["Color"], add.inputs["B"])
bg = nt.nodes.new("ShaderNodeBackground")
bg.inputs["Strength"].default_value = 1.0
nt.links.new(add.outputs["Result"], bg.inputs["Color"])
wout = nt.nodes.new("ShaderNodeOutputWorld")
nt.links.new(bg.outputs[0], wout.inputs[0])


# ---------------------------------------------------------------- lights
def area_light(name, loc, energy, color, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.color = color
    data.size = size
    obj = bpy.data.objects.new(name, data)
    obj.location = loc
    scene.collection.objects.link(obj)
    obj.rotation_euler = (-obj.location.normalized()).to_track_quat("-Z", "Y").to_euler()
    return obj


area_light("Key", (-2.5, 2.8, 4.0), 380, (1.0, 0.92, 0.80), 2.2)  # top-left key (UI convention)
area_light("Rim", (3.0, -2.6, 1.6), 140, (1.0, 0.62, 0.25), 1.5)  # warm gold kicker, bottom-right
area_light("Fill", (0.0, -3.0, 3.5), 30, (0.25, 0.42, 1.0), 1.6)  # royal-blue fill from the front

cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = 2.12
cam = bpy.data.objects.new("Cam", cam_data)
cam.location = (0, 0, 6)
scene.collection.objects.link(cam)
scene.camera = cam


# ---------------------------------------------------------------- materials
def principled(name):
    m = bpy.data.materials.new(name)
    t = node_tree_of(m)
    return m, t, t.nodes["Principled BSDF"]


def object_gradient(t, axis_vec, stops):
    """Base-colour ramp along an object-space direction (tile spans -1..1)."""
    tcn = t.nodes.new("ShaderNodeTexCoord")
    dot = t.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    t.links.new(tcn.outputs["Object"], dot.inputs[0])
    dot.inputs[1].default_value = axis_vec
    to01 = t.nodes.new("ShaderNodeMapRange")
    to01.inputs["From Min"].default_value = -1.0
    t.links.new(dot.outputs["Value"], to01.inputs["Value"])
    r = ramp_node(t, stops)
    t.links.new(to01.outputs["Result"], r.inputs["Fac"])
    return r


# polished yellow gold (light-linked card + key light give the crisp highlights)
GOLD, _, p = principled("Gold")
p.inputs["Base Color"].default_value = (1.0, 0.70, 0.22, 1)
p.inputs["Metallic"].default_value = 1.0
p.inputs["Roughness"].default_value = 0.17

# midnight-sapphire lacquer: deep navy body, royal-blue sheen toward the top-left, mirror clear-coat
SAPPHIRE, t, p = principled("Sapphire")
sheen = object_gradient(
    t,
    (-0.62, 0.62, 0.0),  # +1 at the top-left corner of the face (front side)
    [(0.0, (0.0030, 0.0036, 0.022)), (0.55, (0.0050, 0.0062, 0.036)), (1.0, (0.014, 0.024, 0.115))],
)
t.links.new(sheen.outputs["Color"], p.inputs["Base Color"])
p.inputs["Roughness"].default_value = 0.2
p.inputs["Specular IOR Level"].default_value = 0.25
p.inputs["Coat Weight"].default_value = 1.0
p.inputs["Coat Roughness"].default_value = 0.03
p.inputs["Sheen Weight"].default_value = 0.2
p.inputs["Sheen Tint"].default_value = (0.25, 0.42, 1.0, 1)

# open setting bed: dark bronze velvet, a touch lighter in the middle so the dish reads concave
BED, t, p = principled("Bed")
tcn = t.nodes.new("ShaderNodeTexCoord")
length = t.nodes.new("ShaderNodeVectorMath")
length.operation = "LENGTH"
sxy = t.nodes.new("ShaderNodeVectorMath")
sxy.operation = "MULTIPLY"
sxy.inputs[1].default_value = (1.0, 1.0, 0.0)
t.links.new(tcn.outputs["Object"], sxy.inputs[0])
t.links.new(sxy.outputs[0], length.inputs[0])
radial = ramp_node(t, [(0.10, (0.026, 0.0090, 0.0016)), (0.80, (0.0075, 0.0030, 0.0008))])
t.links.new(length.outputs["Value"], radial.inputs["Fac"])
t.links.new(radial.outputs["Color"], p.inputs["Base Color"])
p.inputs["Roughness"].default_value = 0.7
p.inputs["Specular IOR Level"].default_value = 0.08
p.inputs["Sheen Weight"].default_value = 0.3
p.inputs["Sheen Tint"].default_value = (0.9, 0.42, 0.10, 1)

MATS = [GOLD, SAPPHIRE, BED]
G, S, B = 0, 1, 2


# ---------------------------------------------------------------- geometry: swept tile profile
HALF = 0.98  # outer half-size: 1.96 wide, same footprint as before -> same on-screen size
CORNER = 0.12  # plan corner radius of the outer edge


def arc(cx, ch, r, a0, a1, n, mat, ry=None):
    """Profile arc in (d, h) space: d = inward offset from the outer edge, h = height."""
    ry = r if ry is None else ry
    pts = []
    for k in range(1, n + 1):
        a = math.radians(a0 + (a1 - a0) * k / n)
        pts.append((cx + r * math.cos(a), ch + ry * math.sin(a), mat))
    return pts


# Profiles run from the outer edge (d=0) inward; each point is (d, h, material of the segment that
# arrives at it). The flat interior of each face is a separate "dish": rings whose height is
# h0 + amp * P(x, y), P = (1 - (x/A)^2)(1 - (y/A)^2) — smooth, and constant on the dish border, so
# the converging square rings never print a diagonal crease.

# idle "vault lid": thin rounded gold rim, fine groove, raised sapphire slab with a soft bevel
IDLE = [(0.0, 0.0, G), (0.0, 0.07, G)]
IDLE += arc(0.06, 0.07, 0.06, 180, 90, 6, G)  # rounded outer top edge -> (0.06, 0.13)
IDLE += [(0.080, 0.132, G)]
IDLE += arc(0.080, 0.112, 0.02, 90, 0, 3, G)  # rim rolls down into the groove -> (0.10, 0.112)
IDLE += [(0.104, 0.104, G), (0.108, 0.104, S), (0.108, 0.150, S)]
IDLE += arc(0.160, 0.150, 0.052, 180, 90, 6, S)  # lacquer bevel -> (0.16, 0.202)
IDLE_DISH = (S, +0.008)  # very slight pillow (glossy lacquer), material, centre rise

# claimed "jewel setting": rounded gold shoulder, raised half-round bezel crest, bright inner
# chamfer, fine lip, then a recessed, slightly concave dark bed (bezel ~13% of the tile width)
GOLDEN = [(0.0, 0.0, G), (0.0, 0.06, G)]
GOLDEN += arc(0.05, 0.06, 0.05, 180, 90, 5, G)  # -> (0.05, 0.11)
GOLDEN += [(0.072, 0.122, G)]
GOLDEN += arc(0.140, 0.128, 0.066, 180, 0, 12, G, ry=0.072)  # crest, apex h=0.20 -> (0.206, 0.128)
GOLDEN += [(0.240, 0.088, G)]  # inner chamfer facet
GOLDEN += arc(0.240, 0.078, 0.010, 90, 0, 2, G)  # lip -> (0.25, 0.078)
GOLDEN += [(0.254, 0.064, G), (0.258, 0.058, B)]
GOLDEN_DISH = (B, -0.026)  # concave bed


def ring(d, n_arc=8, n_side=12):
    """Points of the rounded square inset by d (fixed topology for every d)."""
    a = HALF - d
    r = min(max(CORNER - d, 0.035), 0.5 * a)
    c = a - r
    quads = ((1, 1), (-1, 1), (-1, -1), (1, -1))
    pts = []
    for q, (sx, sy) in enumerate(quads):
        cx, cy = sx * c, sy * c
        for k in range(n_arc + 1):
            th = math.radians(90 * q + 90 * k / n_arc)
            pts.append((cx + r * math.cos(th), cy + r * math.sin(th)))
        th1 = math.radians(90 * q + 90)
        nsx, nsy = quads[(q + 1) % 4]
        p0 = (cx + r * math.cos(th1), cy + r * math.sin(th1))
        p1 = (nsx * c + r * math.cos(th1), nsy * c + r * math.sin(th1))
        for j in range(1, n_side):
            f = j / n_side
            pts.append((p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f))
    return pts


def with_dish(profile, dish, n=9):
    """Append the dish rings: (d, h0, mat, amp, A) entries; edge points get amp 0."""
    mat, amp = dish
    d0, h0 = profile[-1][0], profile[-1][1]
    A = HALF - d0
    out = [(d, h, m, 0.0, A) for (d, h, m) in profile]
    for k in range(1, n + 1):
        d = d0 + (HALF - 0.06 - d0) * (k / n) ** 0.8
        out.append((d, h0, mat, amp, A))
    return out, (h0 + amp, mat)


def build_tile(front, front_dish, back, back_dish):
    """Two-sided tile, 1.96 x 1.96, ~0.42 thick. Front (idle) faces +Z, back (claimed) faces -Z.

    One closed swept mesh (so normals are reliable), split into one object per material so the
    gold parts can be light-linked to their reflection card.
    """
    front, (front_centre, _) = with_dish(front, front_dish)
    back, (back_centre, _) = with_dish(back, back_dish)
    # full profile from the back centre, out to the edge, and in to the front centre (back = -h)
    prof = [(d, -h, m, -amp, A) for (d, h, m, amp, A) in reversed(back)] + front[1:]
    # segment material = material of the segment's inner point (the profiles store it there)
    nb = len(back)
    seg_mats = [prof[i][2] if i < nb - 1 else prof[i + 1][2] for i in range(len(prof) - 1)]
    verts, faces, fmats = [], [], []
    rings = []
    for d, h, _, amp, A in prof:
        rings.append(len(verts))
        for x, y in ring(d):
            verts.append((x, y, h + amp * (1 - (x / A) ** 2) * (1 - (y / A) ** 2)))
    n = len(ring(0.0))
    for i in range(len(prof) - 1):
        a, b = rings[i], rings[i + 1]
        for j in range(n):
            j2 = (j + 1) % n
            faces.append((a + j, a + j2, b + j2, b + j))
            fmats.append(seg_mats[i])
    for centre_h, rbase, mat in ((-back_centre, rings[0], seg_mats[0]), (front_centre, rings[-1], seg_mats[-1])):
        ci = len(verts)
        verts.append((0.0, 0.0, centre_h))
        for j in range(n):
            faces.append((rbase + j, rbase + (j + 1) % n, ci))
            fmats.append(mat)

    me = bpy.data.meshes.new("Tile")
    me.from_pydata(verts, [], faces)
    for m in MATS:
        me.materials.append(m)
    for poly, mi in zip(me.polygons, fmats):
        poly.material_index = mi
        poly.use_smooth = True
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.set_sharp_from_angle(angle=math.radians(38))

    root = bpy.data.objects.new("TileRoot", None)
    scene.collection.objects.link(root)
    parts = {}
    for mi, mat in enumerate(MATS):
        sub = me.copy()
        bm = bmesh.new()
        bm.from_mesh(sub)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index != mi], context="FACES")
        bm.to_mesh(sub)
        bm.free()
        if not sub.polygons:
            continue
        o = bpy.data.objects.new(f"Tile_{mat.name}", sub)
        scene.collection.objects.link(o)
        o.parent = root
        parts[mat.name] = o
    return root, parts


root, parts = build_tile(IDLE, IDLE_DISH, GOLDEN, GOLDEN_DISH)


# ---------------------------------------------------------------- light-linked reflection cards
# Flat surfaces under an orthographic top-down camera mirror whatever is straight above them.
# Two transparent emissive cards hang over the tile (invisible to the camera, no shadows):
#   GoldCard   warm light, linked to the gold only  -> flat rim / bezel read bright yellow gold
#   SheenCard  royal-blue glow over the face's top-left, linked to the lacquer only -> glossy sheen
# Being transparent, neither card blocks the other or the world for non-linked surfaces.
def card(name, z, half, strength, color, receivers, falloff):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(-half, -half, z), (half, -half, z), (half, half, z), (-half, half, z)], [], [(3, 2, 1, 0)])
    mat = bpy.data.materials.new(name)
    t = node_tree_of(mat)
    for n_ in list(t.nodes):
        t.nodes.remove(n_)
    tcn = t.nodes.new("ShaderNodeTexCoord")
    strength_socket = falloff(t, tcn.outputs["Object"], strength)
    em = t.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*color, 1)
    t.links.new(strength_socket, em.inputs["Strength"])
    tr = t.nodes.new("ShaderNodeBsdfTransparent")
    add_ = t.nodes.new("ShaderNodeAddShader")
    t.links.new(em.outputs[0], add_.inputs[0])
    t.links.new(tr.outputs[0], add_.inputs[1])
    mo = t.nodes.new("ShaderNodeOutputMaterial")
    t.links.new(add_.outputs[0], mo.inputs["Surface"])
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    scene.collection.objects.link(o)
    o.visible_camera = False
    o.visible_shadow = False
    o.visible_diffuse = False
    coll = bpy.data.collections.new(name + "Receivers")
    for r in receivers:
        coll.objects.link(r)
    o.light_linking.receiver_collection = coll
    return o


def diagonal(t, co, strength):
    """Strength ramps from 0.55x (bottom-right) to 1.35x (top-left)."""
    dot = t.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    t.links.new(co, dot.inputs[0])
    dot.inputs[1].default_value = (-0.45, 0.45, 0.0)
    m = t.nodes.new("ShaderNodeMapRange")
    m.inputs["From Min"].default_value = -1.0
    m.inputs["To Min"].default_value = strength * 0.55
    m.inputs["To Max"].default_value = strength * 1.35
    t.links.new(dot.outputs["Value"], m.inputs["Value"])
    return m.outputs["Result"]


def corner_glow(t, co, strength):
    """Soft blob centred over the face's top-left quarter, fading to 0 well before the centre."""
    off = t.nodes.new("ShaderNodeVectorMath")
    off.operation = "SUBTRACT"
    t.links.new(co, off.inputs[0])
    off.inputs[1].default_value = (-0.62, 0.62, 0.0)
    ln = t.nodes.new("ShaderNodeVectorMath")
    ln.operation = "LENGTH"
    t.links.new(off.outputs[0], ln.inputs[0])
    m = t.nodes.new("ShaderNodeMapRange")
    m.interpolation_type = "SMOOTHSTEP"
    m.inputs["From Min"].default_value = 0.0
    m.inputs["From Max"].default_value = 0.75
    m.inputs["To Min"].default_value = strength
    m.inputs["To Max"].default_value = 0.0
    t.links.new(ln.outputs["Value"], m.inputs["Value"])
    return m.outputs["Result"]


card("GoldCard", 1.4, 1.35, 1.05, (1.0, 0.90, 0.72), [parts["Gold"]], diagonal)
card("SheenCard", 1.0, 1.2, 1.6, (0.22, 0.42, 1.0), [parts["Sapphire"]], corner_glow)


# ---------------------------------------------------------------- renders
def render(path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


FLIP = 24
for i in range(FLIP):
    root.rotation_euler = (math.pi * i / (FLIP - 1), 0, 0)
    render(os.path.join(OUT, f"tile_flip_{i:02d}.png"))
# the static faces are the flip's end frames, so idle -> flip -> claimed never pops
shutil.copyfile(os.path.join(OUT, "tile_flip_00.png"), os.path.join(OUT, "tile_idle.png"))
shutil.copyfile(os.path.join(OUT, f"tile_flip_{FLIP - 1:02d}.png"), os.path.join(OUT, "tile_gold.png"))

print("RENDERED", OUT)
