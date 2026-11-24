"""
Renders the Treasure Vault coin sprites with Blender (Cycles), headless:

    /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/render_coins.py -- <out_dir>

Outputs (transparent PNG, top-down orthographic, coin fills the frame):
  coin_gold.png     claimed cell: polished gold coin, raised rim + bead ring, plain field for the number
  coin_socket.png   unclaimed cell: same coin in dark aged bronze
  coin_flip_XX.png  24 frames, a two-sided coin (bronze front / gold back) flipping 0 -> 180 deg
  coin_spin_XX.png  16 frames, a gold coin spinning a full turn (coin-shower particles)

The numbers are NOT baked in: Skia draws them on top, so 3 renders serve all 100 cells.
"""

import math
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else "assets/sprites/raw")
os.makedirs(OUT, exist_ok=True)
SIZE = 256

# ---------------------------------------------------------------- scene
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 96
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

# world: warm torch light from above, deep navy below -> metal reflections read as "vault"
world = bpy.data.worlds.new("Vault")
scene.world = world
world.use_nodes = True
wn = world.node_tree.nodes
wl = world.node_tree.links
for n in list(wn):
    wn.remove(n)
tex = wn.new("ShaderNodeTexCoord")
sep = wn.new("ShaderNodeSeparateXYZ")
ramp = wn.new("ShaderNodeValToRGB")
bg = wn.new("ShaderNodeBackground")
out = wn.new("ShaderNodeOutputWorld")
wl.new(tex.outputs["Generated"], sep.inputs[0])
wl.new(sep.outputs["Z"], ramp.inputs["Fac"])
ramp.color_ramp.elements[0].position = 0.35
ramp.color_ramp.elements[0].color = (0.004, 0.006, 0.02, 1)
ramp.color_ramp.elements[1].position = 0.75
ramp.color_ramp.elements[1].color = (1.0, 0.78, 0.45, 1)
wl.new(ramp.outputs["Color"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 1.4
wl.new(bg.outputs[0], out.inputs[0])


def area_light(name, loc, energy, color, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.color = color
    data.size = size
    obj = bpy.data.objects.new(name, data)
    obj.location = loc
    scene.collection.objects.link(obj)
    direction = -obj.location.normalized()
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


area_light("Key", (-2.6, 2.6, 4.0), 650, (1.0, 0.86, 0.62), 2.5)  # top-left key (UI convention)
area_light("Rim", (3.0, -2.0, 1.2), 300, (1.0, 0.6, 0.3), 1.5)
area_light("Fill", (0.0, -3.0, 3.0), 120, (0.55, 0.6, 1.0), 3.0)

cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = 2.16
cam = bpy.data.objects.new("Cam", cam_data)
cam.location = (0, 0, 6)
scene.collection.objects.link(cam)
scene.camera = cam


# ---------------------------------------------------------------- materials
def metal(name, base, rough, aniso=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*base, 1)
    p.inputs["Metallic"].default_value = 1.0
    p.inputs["Roughness"].default_value = rough
    if "Anisotropic" in p.inputs:
        p.inputs["Anisotropic"].default_value = aniso
    return m


GOLD = metal("Gold", (1.0, 0.60, 0.18), 0.24, 0.3)
GOLD_FIELD = metal("GoldField", (0.80, 0.46, 0.12), 0.42)
# unclaimed sockets must stay dark so the board reads "empty vault" and muted numbers keep contrast
BRONZE = metal("Bronze", (0.10, 0.068, 0.045), 0.36)
BRONZE_FIELD = metal("BronzeField", (0.02, 0.025, 0.04), 0.62)


# ---------------------------------------------------------------- geometry
def add_to(collection_obj, obj):
    obj.parent = collection_obj


def build_coin(front, front_field, back, back_field):
    """Coin of radius 1 lying in XY, thickness 0.16. Front faces +Z, back faces -Z."""
    root = bpy.data.objects.new("Coin", None)
    scene.collection.objects.link(root)

    # body
    bpy.ops.mesh.primitive_cylinder_add(vertices=128, radius=1.0, depth=0.16)
    body = bpy.context.object
    bev = body.modifiers.new("Bevel", "BEVEL")
    bev.width = 0.035
    bev.segments = 4
    bpy.ops.object.shade_smooth()
    body.data.materials.append(front)
    add_to(root, body)

    for side, mat, field in ((1, front, front_field), (-1, back, back_field)):
        # recessed field (slightly below the rim)
        bpy.ops.mesh.primitive_cylinder_add(vertices=128, radius=0.8, depth=0.02, location=(0, 0, side * 0.075))
        f = bpy.context.object
        f.data.materials.append(field)
        add_to(root, f)
        # raised outer rim
        bpy.ops.mesh.primitive_torus_add(
            major_radius=0.9, minor_radius=0.075, major_segments=128, minor_segments=24, location=(0, 0, side * 0.08)
        )
        rim = bpy.context.object
        rim.scale = (1, 1, 0.55)
        bpy.ops.object.shade_smooth()
        rim.data.materials.append(mat)
        add_to(root, rim)
        # bead ring
        for k in range(28):
            a = 2 * math.pi * k / 28
            bpy.ops.mesh.primitive_uv_sphere_add(
                radius=0.032, segments=12, ring_count=8, location=(0.74 * math.cos(a), 0.74 * math.sin(a), side * 0.088)
            )
            b = bpy.context.object
            b.scale = (1, 1, 0.6)
            bpy.ops.object.shade_smooth()
            b.data.materials.append(mat)
            add_to(root, b)
    # edge reeding colour = front metal; back body faces get the back material via a second shell
    bpy.ops.mesh.primitive_cylinder_add(vertices=128, radius=0.985, depth=0.002, location=(0, 0, -0.081))
    backcap = bpy.context.object
    backcap.data.materials.append(back)
    add_to(root, backcap)
    return root


def render(path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def clear():
    for o in list(scene.objects):
        if o.type in {"MESH", "EMPTY"}:
            bpy.data.objects.remove(o, do_unlink=True)


# static faces
coin = build_coin(GOLD, GOLD_FIELD, GOLD, GOLD_FIELD)
render(os.path.join(OUT, "coin_gold.png"))
clear()
coin = build_coin(BRONZE, BRONZE_FIELD, BRONZE, BRONZE_FIELD)
render(os.path.join(OUT, "coin_socket.png"))
clear()

# flip: bronze front -> gold back, rotating about the screen's horizontal axis (X) 0..180
coin = build_coin(BRONZE, BRONZE_FIELD, GOLD, GOLD_FIELD)
FLIP = 24
for i in range(FLIP):
    t = i / (FLIP - 1)
    coin.rotation_euler = (math.pi * t, 0, 0)
    render(os.path.join(OUT, f"coin_flip_{i:02d}.png"))
clear()

# spin: full turn of a gold coin about Y (for flying coins in the board-complete shower)
coin = build_coin(GOLD, GOLD_FIELD, GOLD, GOLD_FIELD)
SPIN = 16
for i in range(SPIN):
    coin.rotation_euler = (0.35, 2 * math.pi * i / SPIN, 0)
    render(os.path.join(OUT, f"coin_spin_{i:02d}.png"))

print("RENDERED", OUT)
