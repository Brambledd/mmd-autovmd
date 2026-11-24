---
name: popo-blender-mmd
description: >-
  Hybrid MMD/PMX motion pipeline combining PoPo MCP (fast semantic blocking, analytical IK,
  face morphs, FK quality gate) with Blender mmd_tools v4.2+ (last-mile F-Curve polish,
  mesh collision check, viewport inspection) and live playback on the PoPo 3D stage.
---

# PoPo + Blender MMD Motion Workflow

Use this skill whenever creating or refining 3D character motions for `.pmx` models across **PoPo MCP (`popo-mmd`)** and **Blender (`blender` MCP server + `mmd_tools`)**. In DSH the tools are called `mcp__popo-mmd__<tool>` (e.g. `mcp__popo-mmd__export_motion`) and `mcp__blender__execute_blender_code`.

## Division of Responsibilities (Single Source of Truth)

1. **PoPo MCP = Blocking + Kinematic Gate (0 → 80%)**
   - Fast semantic choreography, lexicon/RAG reuse, `face` morph validation, analytical `reach` / `aim` / `plant`, and FK ground/self-collision checks.
   - Export **clean, un-enhanced sparse keyframes** (`mode: "blocking"`).
2. **Blender (`mmd_tools`) = Last-Mile Polish (80 → 98%)**
   - Graph Editor (`fcurves`) Bezier timing, weight/hip-hinge nuance, real mesh collision & finger/skirt visual checks, subtle blinks/holds, and final `.vmd` export.
   - **Rule**: Once a motion enters Blender, Blender's `.blend` / exported `.vmd` is the **single source of truth**. NEVER re-run `export_motion` from `.mpl` over Blender's edits.
3. **PoPo MCP = Final Gate & Stage Playback**
   - Validate Blender's exported `.vmd` with `inspect_vmd_file`, then push directly via `push_vmd_to_stage` (preserves Blender's curves without re-running `vmd-enhancer`).

---

## Stage 1 — PoPo Fast Blocking

1. Call `popo-mmd.inspect_pmx` (`modelId`, default `"topaz"`) to read `mpl2AuthoringGuide`, geometry, safe face morphs, and anchors.
2. Author the `MPL2` script following `mpl2AuthoringGuide`:
   - Always emit `plant feet;` on bent-knee poses.
   - Always emit `center reset; leg_l reset; leg_r reset; knee_l reset; knee_r reset; ankle_l reset; ankle_r reset;` when returning to standing.
   - Copy morph names verbatim (e.g. `真面目`, not `まじめ`).
3. Call `popo-mmd.compile_and_inspect_mpl2` and fix all `directiveErrors`, `critic` issues, and `actionableWarnings` until `ok: true`.
4. Call `popo-mmd.export_motion` with:
   - `mode: "blocking"` (automatically disables `vmd-enhancer` dense sub-keys and skips web push)
   - `outBasePath: ".tmp/handoff/<motion_name>"`
   - Record `blenderHandoff` (`pmxPath`, `vmdPath`, `frameStart`, `frameEnd`).

---

## Stage 2 — Blender `mmd_tools` Last-Mile Polish

When interacting with Blender via `mcp__blender__execute_blender_code` (argument `code`: Python executed inside Blender's `bpy`; Blender must be running as a normal GUI process), **strictly follow these `mmd_tools` v4.2+ conventions**:

### 1. Import `.pmx` and Blocking `.vmd` (No 5-frame Margin!)

```python
import bpy

# 1) Find or import the MMD ROOT object
root = next((o for o in bpy.data.objects if getattr(o, "mmd_type", "") == "ROOT"), None)
if root is None:
    bpy.ops.mmd_tools.import_model(filepath=PMX_PATH, scale=0.08)
    root = next(o for o in bpy.data.objects if getattr(o, "mmd_type", "") == "ROOT")

# 2) Activate ROOT so ImportVmd assigns both armature bones AND morph shape keys
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
bpy.context.view_layer.objects.active = root

# 3) CRITICAL: margin=0 (default margin=5 shifts the whole animation 5 frames later!)
import os
bpy.ops.mmd_tools.import_vmd(
    directory=os.path.dirname(BLOCKING_VMD_PATH),
    files=[{"name": os.path.basename(BLOCKING_VMD_PATH)}],
    scale=0.08,
    margin=0,
    bone_mapper="PMX",
    update_scene_settings=True,
)
```

With `margin=0`, VMD frame `N` lands on Blender frame `N + 1` (VMD 0 → Blender 1); `update_scene_settings=True` sets the scene frame range and 30 fps from the file. The imported bone keys are `LINEAR` (only the first key of each curve is Bézier) — run the smoothing pass in step 3.

### 2. Map Bones by `mmd_bone.name_j` & Handle Leg IK

PoPo's VMD drives FK leg bones (`左足`, `左ひざ`, `左足首`) without `左足ＩＫ` / `右足ＩＫ` tracks. Leaving Blender's Leg IK active pulls the legs back to the origin!

```python
import bpy

# Every execute_blender_code call starts with an empty namespace: re-find ROOT each time
root = next(o for o in bpy.data.objects if getattr(o, "mmd_type", "") == "ROOT")
arm = next(c for c in root.children if c.type == "ARMATURE")
# mmd_tools parents the visible mesh (and its shape keys) to the ARMATURE, not to ROOT
mesh = next((c for c in arm.children if c.type == "MESH" and c.data.shape_keys), None)

# Always look up by mmd_bone.name_j and skip mmd_tools shadow/dummy bones
jp_bones = {
    pb.mmd_bone.name_j: pb
    for pb in arm.pose.bones
    if not getattr(pb, "is_mmd_shadow_bone", False) and pb.mmd_bone.name_j
}

# Disable Leg IK toggles so PoPo's FK leg rotations take effect cleanly.
# The blocking VMD already carries one show-IK frame that switches all six leg IK off, and
# import_vmd turns it into an `mmd_ik_toggle` F-Curve (value 0) that owns the property. The
# assignment below is only a safety net; to change IK timing, edit that F-Curve instead.
for ik_name in ("左足ＩＫ", "右足ＩＫ", "左つま先ＩＫ", "右つま先ＩＫ"):
    pb = jp_bones.get(ik_name)
    if pb and hasattr(pb, "mmd_ik_toggle"):
        pb.mmd_ik_toggle = False
```

### 3. Polish Poses & F-Curves Safely

- **Quaternion only**: `mmd_tools` bones default to `rotation_mode = 'QUATERNION'`. Modify `pb.rotation_quaternion` (e.g. `delta_q @ pb.rotation_quaternion`) and insert keyframes with `pb.keyframe_insert(data_path="rotation_quaternion", frame=f)` (and `data_path="location"` on `センター`).
- **Smooth F-Curves** (required): `import_vmd` brings the keys in as `LINEAR` (verified: 6496 of 6831 keys). Iterate `arm.animation_data.action.fcurves` and set every keyframe's `interpolation = 'BEZIER'` and `handle_left_type = handle_right_type = 'AUTO_CLAMPED'` (then tune ease-in/out handles for weight/impact). `action.fcurves` is valid through Blender 4.3; on 4.4+ (layered Actions) iterate `action.layers[].strips[].channelbags[].fcurves` instead.
- **Face morphs**: Key `mesh.data.shape_keys.key_blocks[morph_name].value` (`keyframe_insert(data_path="value", frame=f)`).
- **Real-mesh check** (verified on `topaz`; snippet below): step the timeline to each peak pose frame, measure the lowest vertex of the *evaluated* mesh and render the real mesh from front / side / 3-4 (aim the active scene camera at the character). This is the only stage that catches skirt, hair, finger or shoe-floor problems — the stick-figure storyboard and `inspect_vmd_file` both pass while the real mesh is wrong.

```python
import bpy
import os

sc = bpy.context.scene
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh = next(c for c in arm.children if c.type == "MESH" and c.data.shape_keys)
target = 61                                   # Blender frame of the peak pose (VMD frame + 1)
for f in range(sc.frame_start, target + 1):   # step, don't jump: rigid-body caches fill in order
    sc.frame_set(f)
ev = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
me = ev.to_mesh()
lowest = min((ev.matrix_world @ v.co).z for v in me.vertices)   # ~0 = soles on the floor, < -0.01 = sinking
ev.to_mesh_clear()
sc.render.filepath = os.path.join(bpy.app.tempdir, "check-%04d.png" % target)
bpy.ops.render.render(write_still=True)       # EEVEE still from the active scene camera
print("lowest vertex z at frame", target, "=", round(lowest, 4))
```

Look shader nodes up by **type** (`n.type == "BSDF_PRINCIPLED"`, `"BACKGROUND"`), never by name: node names are localised in a non-English Blender UI and `nodes.get("Principled BSDF")` returns `None`.

### 4. Export Final `.vmd` with `ROOT` Active

```python
import bpy
import os

root = next(o for o in bpy.data.objects if getattr(o, "mmd_type", "") == "ROOT")
# CRITICAL: ExportVmd ONLY exports shape-key facial morphs when ROOT is active!
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
bpy.context.view_layer.objects.active = root

bpy.context.scene.frame_start = FRAME_START
bpy.context.scene.frame_end = FRAME_END
bpy.ops.mmd_tools.export_vmd(
    filepath=FINAL_VMD_PATH,
    scale=12.5,
    use_frame_range=True,
)
```

`ExportVmd` swallows export errors and still returns `FINISHED`, so always assert `os.path.exists(FINAL_VMD_PATH)` and a non-zero file size afterwards. Blender frame `N` is written back as VMD frame `N - 1`, and the show-IK frame (all leg IK off) from the blocking file is preserved.

---

## Stage 3 — PoPo Final Verification & Live Stage Push

1. Call `popo-mmd.inspect_vmd_file` with `vmdPath: FINAL_VMD_PATH` (`renderViews: true` for a front / 3-4 storyboard). Confirm `ok: true` — i.e. `critic.passed: true` with empty `critic.issues`, `audit.violations` and `telemetryWarnings` (foot lift / grounding).
2. Call `popo-mmd.push_vmd_to_stage` with `vmdPath: FINAL_VMD_PATH`, `modelId`, and `title`.
   - The running PoPo 3D web stage (`http://127.0.0.1:4000`, also embedded in the DSH PoPo stage sidebar) loads and plays the exact Blender-refined `.vmd`. The tool reports `legsKeyed` (FK leg tracks present → the stage disables leg IK) and `baseRotated` (rotated root → the stage also disables physics).

---

## Verified Notes (Blender 4.3.2 · mmd_tools 4.2.2 · `topaz`, end-to-end round trip)

- **Round-trip differences**: tracks for bones the model does not have are dropped by Blender (seen: `thumb_2_r`, which `topaz.pmx` lacks). Everything else — leg / `センター` keys, the `真面目` morph track and the show-IK frame — came back 1:1, and `inspect_vmd_file` passed with `footLift` 0.
- **PoPo authoring pitfalls** (they surface as foot slide or pops only after export):
  - Put key times on 0.5 s multiples (15-frame grid at 30 fps) so the FK keys and the IK `センター` keys land on the same VMD frame.
  - `plant feet` only adjusts `センター` y/z; add `ankle_l bend backward N` / `ankle_r bend backward N` to flatten the feet.
  - Avoid `leg turn` in deep bends (it pulls the feet inward). `center move` leaves residue, hence the `center reset;` on the return to standing.
  - `arm_l reset;` / `arm_r reset;` return to the model's **bind pose**. `topaz` binds in an A-pose (upper arms ~53° off vertical), so the character stands with spread arms at every `arm reset` — invisible in the stick figures, obvious on the real mesh. Pose the arms explicitly in the MPL, or fix it in Blender: pre-multiply every existing `腕` key by a rotation about the world forward axis, weighted by hip height (1 standing → 0 crouched) so the authored `reach` poses stay intact.
- **Real-mesh numbers** (`topaz`, squat): lowest vertex stayed within 2 mm of the floor at the standing / hinge / bottom / return poses; hips 0.98 m standing → 0.52 m at the bottom. Hair and cloth rigid bodies need the timeline to be stepped frame by frame before a still render.
- **Frames**: Blender frame = VMD frame + 1 (a squat bottom at 2.0 s is VMD 60 = Blender 61).
