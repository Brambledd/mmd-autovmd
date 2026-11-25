---
name: popo-blender-mmd
description: >-
  Semantic-Kinematic MMD/PMX motion pipeline powered by PoPo MCP's automatic model re-modeling
  (Rig Profile with multi-slice elliptical hulls, mesh-snapped surface anchors, 6-DOF palm basis,
  and open-eye morph channels) and continuous 30fps hybrid-dynamics solver (compile_motion_intent),
  paired with Blender mmd_tools v4.2+ for live viewport preview, polish, and final VMD export.
---

# PoPo + Blender MMD Motion Workflow (`compile_motion_intent`)

Use this skill whenever creating, refining, or previewing 3D character motions for `.pmx` models across **PoPo MCP (`popo-mmd`)** and **Blender (`mmd_tools`)**. `popo-mmd` directly provides `compile_motion_intent`, `list_models`, `inspect_vmd_file`, `push_vmd_to_stage`, `inspect_duo`, and the native Blender bridge (`get_blender_scene_info`, `execute_blender_code`, `get_blender_viewport` on `127.0.0.1:9876`).

---

## Core Architecture (Why `compile_motion_intent`)

Never hand-author raw per-bone FK Euler angles. Always author high-level beat-based **`MotionIntent` JSON** and compile via **`popo-mmd.compile_motion_intent`**:

1. **Automatic PMX Re-modeling (`<model>.rig-profile.json`, via `src/lib/rig-profile.ts`)**
   - **Neutral Pose Zero-Point**: Automatically converts A-pose / T-pose into a relaxed standing zero-point.
   - **4-Slice Elliptical Body Hulls**: Extracts non-circular `(y, cx, cz, rx, rz)` cross-sections for head, chest, abdomen, pelvis, and legs, automatically stripping hair/ribbons/skirts via PMX `mode = 1/2` physics rigid detection + material tags.
   - **Mesh-Snapped Surface Anchors & Morph Landmarks**: Extracts exact eye/mouth/cheek heights from PMX vertex morphs (`まばたき / あ / 照れ`) and snaps surface anchors (`cheek_l/r`, `chin`, `forehead`, `waist_side_l/r`, `chest_center`) directly to real PMX surface vertices.
   - **6-DOF Palm Basis & Joint ROM**: Auto-derives `restFingerDir` and `restPalmNormal` from wrist/index/pinky bones, with anatomical forearm twist (`±85°`), wrist swing (`58°`), and clavicle coupling limits.
   - **Layered Semantic Expressions**: Separates eyebrow, eye, and mouth channels so `smile` / `warm_smile` lift mouth corners (`口角上げ`) + soften brows (`にこり`) while keeping eyes **open**; `happy_squint` / `laugh` explicitly close eyes; auto-blinks skip frames where eyes are already closed.

2. **Continuous 30fps Hybrid-Dynamics Solver (`src/lib/rig-solver.ts`)**
   - **Zero-Pop Continuity**: All elbow pole vectors, 6-DOF palm orientations, collision margins, and rest↔reach blends interpolate continuously, followed by 2-pass zero-phase SLERP smoothing on upper-body/arm tracks (pelvis & legs untouched).
   - **Spherical Arcs + Pass-Through + Moving Hold**: Arm sweeps follow shoulder-centered spherical arcs; rapid/rhythmic beats (`passThrough: true` or span `≤ 0.65s`) flow continuously via Catmull-Rom splines; sustained holds retain subtle living breath/weight sway.
   - **Body-Part Lead & Follow**: Eyes (`+0.12s`) → Head (`+0.06s`) → Pelvis/Stance (`+0.04s`) → Spine (`0s`) → Arms (`-0.05s`) → Wrist/Fingers (`-0.09s`) eliminate robotic lockstep motion.
   - **Source-Level Leg Grounding**: Analytical 2-bone Leg IK runs every frame, keeping soles flush (`< 1 mm`) across weight shifts and squats without post-hoc foot-plant baking.
   - **Flush Surface Contact + Hard Collision Guardrail**: 1-step closed-loop finger-pad feedback + contact finger-spread adaptation + final real-FK 5-fingertip & forearm elliptical collision clamp.
   - **Inertial Wrist & Finger Drag**: Velocity-driven follow-through whip during free-air waves/raises, automatically masked to zero during face/waist contact.

---

## Stage 1 — Author `MotionIntent` & Compile (`compile_motion_intent`)

Call **`popo-mmd.compile_motion_intent`** with `{ modelId, intent, outVmdPath }` (set `rebuildProfile: true` if the PMX changed).

### `MotionIntent` JSON Schema

```json
{
  "title": "Descriptive motion title",
  "fps": 30,
  "breathing": true,
  "autoBlink": true,
  "beats": [
    {
      "at": 0.0,
      "effort": "soft",
      "passThrough": false,
      "stance": { "weightShift": 0.0, "squat": 0.02, "hipYawDeg": 0 },
      "spine": { "curl": 0.0, "twist": 0.0, "lean": 0.0 },
      "hand_l": { "mode": "rest", "grip": "relax" },
      "hand_r": { "mode": "rest", "grip": "relax" },
      "gaze": { "target": "camera", "headTiltDeg": 0, "headPitchDeg": 0 },
      "face": { "warm_smile": 0.35 }
    }
  ]
}
```

### Field Reference

- **`effort`**: `"soft"` (gentle smooth), `"snappy"` (crisp fast-out), `"bouncy"` (playful elastic), `"heavy"` (weighted anticipation).
- **`passThrough`**: `true` for continuous mid-motion beats (no dead-stop); beats `≤ 0.65s` apart auto-enable pass-through.
- **`stance`**:
  - `weightShift`: `-1` (right foot) … `0` (center) … `+1` (left foot).
  - `squat`: `0` (standing) … `1` (deep squat).
  - `hipYawDeg`: pelvis yaw in degrees (`+` left, `-` right).
- **`spine`**: `curl` (`+` forward bow / `-` arch back, `[-1, 1]`), `twist` (`+` left / `-` right, `[-1, 1]`), `lean` (`+` left / `-` right, `[-1, 1]`).
- **`hand_l` / `hand_r`**:
  - `mode`: `"rest"` (relaxed Neutral Pose at side) or `"reach"`.
  - `target`: Semantic anchor name or world `[x, y, z]`:
    - **Face**: `cheek_l`, `cheek_r`, `mouth`, `chin`, `forehead`, `head_top`
    - **Torso**: `chest_center`, `heart`, `chest_l`, `chest_r`, `waist_side_l`, `waist_side_r`, `hip_side_l`, `hip_side_r`, `waist_front`
    - **Air / Expressive**: `wave_l`, `wave_r`, `front_present_l`, `front_present_r`, `cheer_l`, `cheer_r`, `rest_hand_l`, `rest_hand_r`
  - `offsetCm`: Optional `[x, y, z]` offset in centimeters (`+X` model left, `+Y` up, `-Z` forward).
  - `arc`: `"natural"` | `"outward"` | `"inward"` | `"akimbo"` (auto-selected for `waist_side_*` / `hip_side_*`).
  - `endEffector`: `"wrist"` | `"palm"` | `"fingertip"` (auto-defaults to `"fingertip"` on face anchors, `"palm"` on waist anchors).
  - `palm`: `"surface"` (palm faces into anchor normal) | `"camera"` (palm toward `-Z`, auto on `wave_*`) | `"inward"` | `"down"` | `"natural"`.
  - `grip`: Basis name or weighted blend string (e.g. `"open:0.4,relax:0.6"`). Basis poses: `relax`, `open`, `fist`, `point`, `peace`, `cup`.
- **`gaze`**: `target` (`"camera" | "left" | "right" | "up" | "down"`), `headTiltDeg` (`+` left, `-` right), `headPitchDeg` (`+` nod down, `-` look up).
- **`face`** (weights `0..1`):
  - **Open-eye smiles**: `smile`, `warm_smile`
  - **Closed-eye smiles**: `happy_squint`, `laugh`
  - **Emotions / eyes / mouth**: `shy`, `serious`, `sharp`, `troubled`, `surprised`, `angry`, `smirk`, `blink`, `wink_l`, `wink_r`, `mouth_a`, `mouth_i`, `mouth_u`, `mouth_e`, `mouth_o`, `grin`.

### Gate Check
Confirm `compile_motion_intent` returns **`ok: true`**, `critic.passed: true`, and `groundContact.offendingFrames: 0`. If any issue is reported, adjust the offending beat's target/offset/effort and re-compile (`~50–150 ms`).

---

## Stage 2 — Blender `mmd_tools` Live Preview & Optional Polish

Connect to local Blender (`127.0.0.1:9876`, `N` → `MCP for Blender` → Connect) and check with `get_blender_scene_info`.

### 1. Import `.pmx` and Compiled `.vmd` (Reset Residual Shape Keys!)

```python
import bpy, os, math
from mathutils import Euler, Vector

PMX_PATH = r"E:\PoPo\public\models\topaz\topaz.pmx"
VMD_PATH = r"E:\PoPo\.tmp\intent-motion.vmd"

# Remove default Cube if present
cube = bpy.data.objects.get("Cube")
if cube and cube.type == "MESH":
    bpy.data.objects.remove(cube, do_unlink=True)

# 1) Find or import MMD ROOT
root = next((o for o in bpy.data.objects if getattr(o, "mmd_type", "") == "ROOT"), None)
if root is None:
    bpy.ops.mmd_tools.import_model(filepath=PMX_PATH, scale=0.08)
    root = next(o for o in bpy.data.objects if getattr(o, "mmd_type", "") == "ROOT")

arm = next(c for c in root.children if c.type == "ARMATURE")
mesh = next((c for c in arm.children if c.type == "MESH" and c.data.shape_keys), None)

# 2) Clear old actions AND reset all residual shape key values to 0.0
# CRITICAL: clearing action alone leaves unkeyed morphs from previous VMDs stuck!
if arm.animation_data and arm.animation_data.action:
    arm.animation_data.action = None
if mesh and mesh.data.shape_keys:
    if mesh.data.shape_keys.animation_data:
        mesh.data.shape_keys.animation_data.action = None
    for kb in mesh.data.shape_keys.key_blocks:
        if kb.name != "Basis":
            kb.value = 0.0

# 3) Activate ROOT and import VMD with margin=0
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
bpy.context.view_layer.objects.active = root

bpy.ops.mmd_tools.import_vmd(
    directory=os.path.dirname(VMD_PATH),
    files=[{"name": os.path.basename(VMD_PATH)}],
    scale=0.08,
    margin=0,
    bone_mapper="PMX",
    update_scene_settings=True,
)

# 4) Ensure Leg IK toggles stay off (FK leg chain is already <1mm grounded)
jp_bones = {
    pb.mmd_bone.name_j: pb
    for pb in arm.pose.bones
    if not getattr(pb, "is_mmd_shadow_bone", False) and pb.mmd_bone.name_j
}
for ik_name in ("左足ＩＫ", "右足ＩＫ", "左つま先ＩＫ", "右つま先ＩＫ"):
    pb = jp_bones.get(ik_name)
    if pb and hasattr(pb, "mmd_ik_toggle"):
        pb.mmd_ik_toggle = False

# 5) Smooth F-Curves (BEZIER + AUTO_CLAMPED + fc.update())
if arm.animation_data and arm.animation_data.action:
    for fc in arm.animation_data.action.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = "BEZIER"
            kp.handle_left_type = kp.handle_right_type = "AUTO_CLAMPED"
        fc.update()

# 6) Frame viewport nicely in Material Preview at frame 1
sc = bpy.context.scene
sc.frame_set(1)
for window in bpy.context.window_manager.windows:
    for area in window.screen.areas:
        if area.type == "VIEW_3D":
            space = area.spaces.active
            space.shading.type = "MATERIAL"
            space.overlay.show_bones = False
            rv3d = space.region_3d
            rv3d.view_perspective = "PERSP"
            rv3d.view_location = Vector((0.0, 0.0, 0.95))
            rv3d.view_distance = 2.35
            rv3d.view_rotation = Euler((math.radians(84), 0.0, math.radians(-16)), "XYZ").to_quaternion()
            rv3d.update()
            area.tag_redraw()
```

### 2. Inspect & Export Final `.vmd` (if edited in Blender)

- Use `get_blender_viewport` to visually inspect key poses (hands, face contact, skirt/hair).
- Always look up pose bones by `pb.mmd_bone.name_j`, edit `pb.rotation_quaternion` (not Euler), and end curve edits with `fc.update()`.
- Export with **`ROOT` active** so facial shape keys are included:

```python
import bpy, os

root = next(o for o in bpy.data.objects if getattr(o, "mmd_type", "") == "ROOT")
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
bpy.context.view_layer.objects.active = root

bpy.ops.mmd_tools.export_vmd(filepath=FINAL_VMD_PATH, scale=12.5, use_frame_range=True)
assert os.path.exists(FINAL_VMD_PATH) and os.path.getsize(FINAL_VMD_PATH) > 0
```

---

## Stage 3 — Final Verification, Stage Playback & Duo

- **Verify external/exported `.vmd`**: Call `popo-mmd.inspect_vmd_file` (`vmdPath`, `modelId`, optional `renderViews: true`) to confirm `ok: true`, `critic.passed: true`, and `groundContact.offendingFrames: 0`.
- **PoPo 3D Web Stage (optional)**: If `http://127.0.0.1:4000` is running (`npm run dev`), call `popo-mmd.push_vmd_to_stage` with `vmdPath`, `modelId`, and `title`.
- **Two-Person Duo Scenes**: Compile Actor A and Actor B independently with `compile_motion_intent`, verify world spacing/contact with `popo-mmd.inspect_duo`, and import both rigs into Blender using explicit object references (`ROOT_A` / `ROOT_B`, `ARM_A` / `ARM_B` — never `next(o for o in bpy.data.objects ...)` in a duo scene).
