---
name: popo-blender-mmd
description: >-
  Hybrid MMD/PMX motion pipeline combining PoPo MCP (fast semantic blocking, analytical IK,
  face morphs, per-frame kinematic gate with ground-contact bake) with Blender mmd_tools v4.2+
  (last-mile F-Curve polish, mesh collision check, viewport inspection) and live playback on
  the PoPo 3D stage.
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
4. **PoPo final pipeline = stage-ready without Blender (when the stick figure is enough)**
   - `make_motion` / `export_motion mode: "final"` / the stage's own play button all run **one pipeline**: compile → `vmd-enhancer` → **ground-contact bake**. The critic and every telemetry number are computed on **every rendered frame** with the stage's own interpolation (bezier + slerp), tolerance `0.05 u` (4 mm). Feet stay on the floor between keys, so the Blender foot-plant cleanup (3b) is only needed for the `mode: "blocking"` handoff.

---

## Stage 1 — PoPo Fast Blocking

**Fast path (no Blender): `make_motion`.** One call takes either `primitive` + `params` (any lexicon entry listed by `inspect_pmx` — e.g. `squat`: `depth` 0.5 half … 1.1 full, `cycles` 1–6, `tempo` 0.6–1.6, `hold`, `arm_swing`, `face`; out-of-range values are clamped, `targetDuration` adds cycles) or `mpl`, and returns the whole verdict at once:

- storyboard PNG (≥ 1.5 s, up to 6 tiles; a 3-view PNG for shorter clips) + `storyboard.tilesSec`
- `verdict`: `critic` (final motion), `criticRaw` only when the raw compile fails, with `fixedByFinalize`, `groundContact` (per-frame, tolerance `0.05 u`), `groundNotes`, `actionableWarnings`, `directiveErrors`
- `vmd`: `bytes`, `sha256`, `boneKeys` / `rawBoneKeys`, `path` (`base64` only with `includeVmdBase64`)
- `curves`: per-frame `footL` / `footR` (lowest sole point vs rest foot height, negative = below floor), `footLiftL/R`, `hipDrop`, plus `peaks` (`hipDropMax`, `footDeepest*`, `footHighest*`, `footLiftMax*`); `durationSec` is the final file span, `authoredSec` the last authored timeline entry (the enhancer appends a short tail)
- `keyframes`: one row per authored timeline entry (`pose`, `hipDrop`, `hipBackShift`, `footLiftL/R`, `squatDepthRatio`, `armExtL/R`); 3D `coords` at `sampleTimes` on request

`ok: false` comes back as an MCP error carrying the same report and the storyboard (`force: true` returns it normally; a failed gate is never pushed). `outBasePath` writes `.mpl` / `.vmd` / `.png` / `.json`; `pushToStage: true` sends the exact final bytes to the stage. Read `verdict.groundNotes` first: "authored key poses" / "authored pose(s)" means the pose itself sits off the floor (fix the MPL — `plant feet;`, bend the knees, raise the center); anything else is already fixed by the pipeline.

1. Call `popo-mmd.inspect_pmx` (`modelId`, default `"topaz"`) to read `mpl2AuthoringGuide`, geometry, safe face morphs, and anchors.
2. Author the `MPL2` script following `mpl2AuthoringGuide`:
   - Always emit `plant feet;` on bent-knee poses.
   - Always emit `center reset; leg_l reset; leg_r reset; knee_l reset; knee_r reset; ankle_l reset; ankle_r reset;` when returning to standing.
   - Copy morph names verbatim (e.g. `真面目`, not `まじめ`).
3. Call `popo-mmd.compile_and_inspect_mpl2` and fix all `directiveErrors`, `critic` issues, and `actionableWarnings` until `ok: true`. The verdict is on the **final motion** (enhancer + ground bake, exactly what the stage plays); `criticRaw` appears only when the raw compile itself fails, to tell frame-between sinking (fixed by the bake) from authored-pose problems. `groundContact.offendingFrames` counts rendered frames beyond tolerance, `groundBake.residualAtEntries` those that are authored key poses, and `groundNotes` turns both into a sentence.
4. Call `popo-mmd.export_motion` with:
   - `mode: "blocking"` (automatically disables `vmd-enhancer` dense sub-keys and skips web push)
   - `outBasePath: ".tmp/handoff/<motion_name>"`
   - Record `blenderHandoff` (`pmxPath`, `vmdPath`, `frameStart`, `frameEnd`).
   - Alternative starting point: `mode: "final"` with `pushToStage: false` hands Blender the `vmd-enhancer` result (staggered tracks, morph keys) as a base. Expect its frame-0 **bind-pose** pre-roll and desynchronized tracks — both are handled below (*Opening pose hold*, *the gate reads every rendered frame*).

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
- **Smooth F-Curves** (required): `import_vmd` brings the keys in as `LINEAR` (verified: 6496 of 6831 keys). Iterate `arm.animation_data.action.fcurves` and set every keyframe's `interpolation = 'BEZIER'` and `handle_left_type = handle_right_type = 'AUTO_CLAMPED'` (then tune ease-in/out handles for weight/impact). `action.fcurves` is valid through Blender 4.3; on 4.4+ (layered Actions) iterate `action.layers[].strips[].channelbags[].fcurves` instead. Setting the handle types from Python does **not** move the handles: verified on Blender 4.3.2 — the curve stayed linear until `fc.update()` was called, so end the pass with `fc.update()` on every curve.
- **Face morphs**: Key `mesh.data.shape_keys.key_blocks[morph_name].value` (`keyframe_insert(data_path="value", frame=f)`).
- **Real-mesh check** (verified on `topaz`; snippet below): step the timeline to each peak pose frame, measure the lowest vertex of the *evaluated* mesh and render the real mesh from front / side / 3-4 (aim the active scene camera at the character). This is the only stage that catches skirt, hair, finger or shoe-floor problems — the stick-figure storyboard and `inspect_vmd_file` both pass while the real mesh is wrong. Peak poses alone are not enough: the feet leave the floor *between* keys — run the foot-plant cleanup in 3b over every frame after the last curve edit.

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

### 3b. Keep the Feet Planted Between Keys (required for every bent-knee motion)

`plant feet` only holds on the keyed poses. Between two keyed poses the hips travel on a straight line while the leg's vertical reach follows an arc, so the feet sink or float **between keys** (numbers under *Verified Notes*). PoPo's final pipeline fixes this itself — the ground-contact bake keeps both feet within 5 mm on every rendered frame — but a `mode: "blocking"` handoff is un-baked by design (its gate is judged on a bake *preview*, see *Verified Notes*), so in Blender the cleanup is still the last-mile step and `inspect_vmd_file` reports the raw between-key sinking until it is done. After the **last** curve edit, walk every frame on the evaluated mesh: level each foot (ankle pitch), shift `センター` vertically, and key the corrected values together with `腰` and the leg chain. The block is written for `topaz` (shoe material `鞋子`, character facing −Y, so its left is +X); adjust those for another model.

```python
import math

import bpy
from mathutils import Quaternion, Vector

sc = bpy.context.scene
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh = next(c for c in arm.children if c.type == "MESH" and c.data.shape_keys)
act = arm.animation_data.action
pb_j = lambda n: next(pb for pb in arm.pose.bones if pb.mmd_bone.name_j == n)
center = pb_j("センター")
feet = [(pb_j("左足首"), 1), (pb_j("右足首"), -1)]       # (ankle, +1 = character's left = +X)
chain = [pb_j("腰"), pb_j("左足"), pb_j("右足"), pb_j("左ひざ"), pb_j("右ひざ")] + [pb for pb, _ in feet]
mats = [m.name if m else "" for m in mesh.data.materials]
shoe = set(i for i, m in enumerate(mats) if m == "鞋子")
VERT, VERT_SIGN = 1, -1.0      # center.location[VERT] += 0.1 lowers the body by 0.1 m (measured)
PITCH_TOL, HEIGHT_TOL, MAX_ITERS = math.radians(0.6), 0.0025, 4
pitch_axis = arm.matrix_world.inverted().to_3x3() @ Vector((1.0, 0.0, 0.0))   # world X in armature space


def soles():
    """per foot: min z of the toe half, min z of the heel half, mean y of each half"""
    ev = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
    me = ev.to_mesh()
    mw = ev.matrix_world
    idx = set(v for p in me.polygons if p.material_index in shoe for v in p.vertices)
    pts = [mw @ me.vertices[i].co for i in idx]
    ev.to_mesh_clear()
    out = []
    for pb, sign in feet:
        foot = [p for p in pts if p.x * sign > 0]
        cy = sum(p.y for p in foot) / len(foot)
        toe = [p for p in foot if p.y < cy - 0.04]
        heel = [p for p in foot if p.y > cy + 0.04]
        out.append((min(p.z for p in toe), min(p.z for p in heel),
                    sum(p.y for p in toe) / len(toe), sum(p.y for p in heel) / len(heel)))
    return out


def sole_min_z(s):
    return min(min(tz, hz) for tz, hz, _, _ in s)


def measure():
    bpy.context.view_layer.update()                  # commit pose edits before reading the mesh
    return soles()


def set_key(pb, prop, frame):
    pb.keyframe_insert(prop, frame=frame)
    pre = 'pose.bones["%s"].%s' % (pb.name, prop)     # Blender name (左足首 -> 足首.L), not the JP name
    for fc in act.fcurves:
        if fc.data_path == pre:
            k = min(fc.keyframe_points, key=lambda p: abs(p.co.x - frame))   # find() returns an int index in 4.3
            k.interpolation = "BEZIER"
            k.handle_left_type = k.handle_right_type = "AUTO_CLAMPED"


def sweep():
    out = []
    for f in range(sc.frame_start, sc.frame_end + 1):
        sc.frame_set(f)
        out.append(sole_min_z(soles()))
    return out


for fc in act.fcurves:
    fc.update()
before = sweep()                                    # raw error, before anything is corrected
keyed = []
for f in range(sc.frame_start, sc.frame_end + 1):
    sc.frame_set(f)
    touched = False
    for _ in range(MAX_ITERS):
        s = measure()
        changed = False
        for i, (pb, sign) in enumerate(feet):
            toe_z, heel_z, toe_y, heel_y = s[i]
            if abs(toe_z - heel_z) / max(heel_y - toe_y, 0.05) > PITCH_TOL:      # sole not level
                axis_local = (pb.matrix.to_3x3().inverted() @ pitch_axis).normalized()
                alpha = math.atan2(toe_z - heel_z, heel_y - toe_y)
                pb.rotation_quaternion = pb.rotation_quaternion @ Quaternion(axis_local, alpha)
                changed = touched = True
        z = sole_min_z(measure()) if changed else sole_min_z(s)
        if abs(z) > HEIGHT_TOL:                                                  # whole body off the floor
            loc = center.location.copy()
            loc[VERT] += VERT_SIGN * -z
            center.location = loc
            changed = touched = True
        if not changed:
            break
    if touched:
        # センター, 腰 and the whole leg chain are keyed together: key-by-key readers then see the real pose
        set_key(center, "location", f)
        for pb in chain:
            set_key(pb, "rotation_quaternion", f)
        keyed.append(f)
for fc in act.fcurves:
    fc.update()
after = sweep()
sc.frame_set(sc.frame_start)
print("foot-plant cleanup: raw error before min %+.4f m | after min %+.4f max %+.4f m | corrective keys on %d frames" % (
    min(before), min(after), max(after), len(keyed)))
```

Result on `topaz` (9 s squat, three reps): raw error −10.7 cm → soles −0.49 … +0.41 cm on all 278 frames, sole pitch ≤ 0.5°, corrective keys on ~120 frames, file 236 KB, and `inspect_vmd_file` `ok: true` with `footLift` within 0.04 u of PoPo's own FK.

**Opening pose hold** (only when the input is a `mode: "final"` export): the enhancer anchors frame 0 to the bind pose, so an A-pose model snaps its arms down during the first 0.1 s. Copy the second key's value onto the first key wherever the first key sits on frame ≤ 4 and the next key is ≤ 6 frames away (117 arm / elbow / finger curves on `topaz`):

```python
import bpy

arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")   # every call starts with an empty namespace
act = arm.animation_data.action
for fc in act.fcurves:
    kp = fc.keyframe_points
    if len(kp) >= 2 and kp[0].co.x <= 4.0 and kp[1].co.x - kp[0].co.x <= 6 and abs(kp[1].co.y - kp[0].co.y) > 1e-4:
        kp[0].co.y = kp[1].co.y
        kp[0].handle_left_type = kp[0].handle_right_type = "AUTO_CLAMPED"
        fc.update()
```

**Polish that stayed safe for the feet** (soles re-measured after each step): follow-through lag — shift every key of `上半身` / `上半身2` by +1 frame and of `首` / `頭` by +2; VECTOR left handles ("arrival") on `腰` / `上半身` / `上半身2` rotation keys at the squat-bottom frames; blinks as `まばたき` keys `0 / 1 / 0` at frames `n−2 / n / n+4`, skipping times where `ウィンク` is active. Not safe: the same VECTOR handles on leg or `センター` curves (bent the hip path, soles floated up to +5 cm) and any lag on `腰`.

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

1. Call `popo-mmd.inspect_vmd_file` with `vmdPath: FINAL_VMD_PATH` (`renderViews: true` for a front / 3-4 storyboard). Confirm `ok: true`: `critic.passed: true` with empty `critic.issues`, `audit.violations`, and `groundContact.offendingFrames: 0` (every rendered frame, tolerance `0.05 u`, negative = below floor). For an un-baked blocking file `ok: false` is expected — it is judged as-is — and `groundBakePreview` shows what the standard bake would do (`insertedKeys`, `after.offendingFrames`); `groundNotes` says which case you are in.
2. Call `popo-mmd.push_vmd_to_stage` with `vmdPath: FINAL_VMD_PATH`, `modelId`, and `title`.
   - The running PoPo 3D web stage (`http://127.0.0.1:4000`, also embedded in the DSH PoPo stage sidebar) loads and plays the exact Blender-refined `.vmd`. The tool reports `legsKeyed` (FK leg tracks present → the stage disables leg IK) and `baseRotated` (rotated root → the stage also disables physics).
   - **The gate reads every rendered frame.** `critiquePoseVmd`, `extractKeyframeCoords` and the ground measurement all sample the pose with the stage's own interpolation (engine-accurate bezier + slerp, `src/lib/fk.ts`), so a pass covers the frames between keys and desynchronized tracks (stagger, lag, cleanup keys) no longer produce false errors. What it does flag is real: between-key sinking on un-baked files (`ground_penetration` — fixed by PoPo's ground bake or the Blender cleanup in 3b) and authored key poses that sit off the floor (`groundNotes`: "authored key poses"; the bake never rewrites a key pose, so fix the MPL). Still good practice: never lag `腰` (it parents the legs), and key `センター` + `腰` + `足` + `ひざ` + `足首` together whenever one of them gets a key (the foot-plant cleanup does) — with that in place PoPo's FK matched the Blender mesh within ±3 mm (`footLift` ≤ 0.04 u) at every sampled frame.

---

## Verified Notes (Blender 4.3.2 · mmd_tools 4.2.2 · `topaz`, end-to-end round trip)

- **Grounding is a between-key problem.** Shoe soles on the evaluated mesh, every frame, right after import + smoothing (no cleanup):

  | motion | deepest sink | highest float |
  |---|---|---|
  | squat v3, 3 poses per rep (seq 3 on the stage; its blocking and enhanced exports measure the same) | −4.5 cm, frame 85 (mid-rise) | +3.1 cm, frame 32 (mid-descent) |
  | squat v4 "lively", faster reps with a direct bottom→top rise | −10.7 cm, frame 61 | +2.9 cm, frame 203 |
  | v4 after the foot-plant cleanup (shipped as seq 4; re-imported from the exported file) | −0.49 cm | +0.4 cm |

  The foot stays level while it sinks (toe and heel within 2 mm): a height error — the hips move linearly while the leg's vertical reach follows an arc. LINEAR keys and smoothed Bezier sink just as deep, only at different frames. The "within 2 mm" noted here earlier is true at the four keyed poses only.
- **The stage interpolates differently from Blender / MMD, and PoPo now measures it the way the stage plays it.** The stage engine takes the interpolation table from the *later* key of a pair and reads rotation easing from the X channel (bytes 0–3) of the 64-byte table; Blender / mmd_tools take the earlier key's table and the rotation channel. So the enhancer's SNAP / SETTLE curves (their easing lives in the rotation channel) only shape translation on the stage, and a file that measures −4.53 cm in Blender (squat v3) shows −6.25 cm on the stage. `src/lib/fk.ts` (`samplePoseTransforms`, bezier + slerp) reproduces the stage rule, so critic, telemetry and bake all agree with what is actually played.
- **PoPo's ground bake vs. the Blender cleanup.** The Blender-baked v4 (seq 4) was fitted against the mesh under Blender's interpolation and still shows about ±1.2 cm bone-level residual on the stage; PoPo's own bake is fitted against the stage rule and holds `|ankle − rest| ≤ 0.0588 u` (4.7 mm) on all 278 frames of the same squat (`examples/squat-lively.mpl`) by inserting +88…97 `センター` keys. Pipeline tolerance is `0.05 u` (4 mm), the regression threshold 5 mm (`0.0625 u`).
- **What the bake touches — and what it leaves alone.** Only frames between contact keys, only inserted `センター` / `足首` keys; authored keys are never rewritten (byte-for-byte preserved), so an authored offset is reported, not fixed (`groundBake.residualAtEntries`, `groundNotes`). Lying, seated, airborne and kicking feet are out of scope. When the authored error line is inside the tolerance band the bake judges by absolute offset, so a small float between keys is pressed back down as well.
- **Enhancer guardrail.** Leg ancestors (`グルーブ` / `腰` / `下半身`) no longer receive independent anticipation / overshoot keys: a lone 3° overshoot key on `腰` lifted both feet ~3 mm during the standing hold of a deep squat.
- **Blocking gate.** `mode: "blocking"` exports un-baked bytes (`groundBake: null`); its quality gate is judged on a ground-baked *preview* of those keys (`qualityGate.checked`), so blocking and final reach the same verdict and Blender still receives sparse keys.
- **Round-trip differences**: PoPo's export carries one extra track under an English name (`thumb_2_r`, alongside `右親指２`); mmd_tools drops it, harmless. Everything else — leg / `センター` keys, morph tracks and the show-IK frame — comes back 1:1.
- **Enhancer pre-roll**: `mode: "final"` shifts each chain by up to 4 frames and, when a track's first key is not on frame 0, inserts a frame-0 **bind-pose** key ("anchor frame 0 to the rest orientation"). On an A-pose model the arms snap down during the first 0.1 s — see *Opening pose hold*.
- **PoPo authoring pitfalls** (they surface as foot slide or pops only after export):
  - Put key times on 0.5 s multiples (15-frame grid at 30 fps) so the FK keys and the IK `センター` keys land on the same VMD frame.
  - `plant feet` only adjusts `センター` y/z; add `ankle_l bend backward N` / `ankle_r bend backward N` to flatten the feet.
  - Avoid `leg turn` in deep bends (it pulls the feet inward). `center move` leaves residue, hence the `center reset;` on the return to standing.
  - `arm_l reset;` / `arm_r reset;` return to the model's **bind pose**. `topaz` binds in an A-pose (upper arms ~53° off vertical), so the character stands with spread arms at every `arm reset` — invisible in the stick figures, obvious on the real mesh. Pose the arms explicitly in the MPL, or fix it in Blender: pre-multiply every existing `腕` key by a rotation about the world forward axis, weighted by hip height (1 standing → 0 crouched) so the authored `reach` poses stay intact.
  - For squat reps start from the `squat` lexicon primitive (`make_motion` with `primitive: "squat"`) or `examples/squat-lively.mpl`: anticipation lean-back, hip hinge, bottom bounce, overshoot settle; every bent pose carries `plant feet;` and the ankle angle is `knee − hip`, so the sole stays level and the default depth drops the hips 5.7 u (45.7 cm) with both feet within 5 mm on every frame.
- **MPL details**: several `face` lines per pose are fine; each reference of a pose emits a key for every morph it names, and a morph interpolates only between its own keys — set it back to 0 explicitly. `reach` overwrites raw `arm` / `elbow` values in the same pose (warning only). On `topaz`, `arm_l bend forward 38` + `elbow_l bend forward 12` reads as relaxed arms at the sides.
- **Blender 4.3.2 API**: `fcurve.keyframe_points.find(frame)` returns an **int index**; mmd_tools renames limb bones on import (`左足` → `足.L`), so build F-curve data paths from the bone found by `mmd_bone.name_j`; `to_mesh()` per frame is fine (278 frames ≈ 5 s); an exception in an `execute_blender_code` block discards all earlier `print`s of that block.
- **Measure the raw error with a full sweep before the per-frame correction loop.** A "before" value read inside the loop hides nearly all of it (showed −0.9 cm for a real −10.7 cm) because the earlier frames are already corrected by then.
- **Frames**: Blender frame = VMD frame + 1 (a squat bottom at 2.0 s is VMD 60 = Blender 61).

---

## Duo / Two-Person Interactive Workflow (`inspect_duo` + Dual-Rig Blender)

Use this when two characters (e.g. `topaz` + `caelus`, or any `.pmx` via `pmxPath`) must share a scene (handshake, hug, high-five, duet). **PoPo's 3D web stage is single-model (`reze-engine`)**, so PoPo checks & renders duo alignment in a shared world via `inspect_duo`, and **Blender `mmd_tools` is the final duo viewport, contact polish, and dual-`.vmd` export environment**.

### Stage 1 — Author Each Actor & Align via `popo-mmd.inspect_duo`

1. Author Actor A (`mplA`) and Actor B (`mplB`) in their own local spaces (`0 = -Z` forward), or start from blocking motions exported with `export_motion(mode="blocking")` / `make_motion`.
2. Choose shared world placements `{ offset: [x, y, z], yawDeg }`:
   - Face-to-face handshake / high-five: A at `offset: [-5, 0, 0], yawDeg: +90` (faces `+X`), B at `offset: [+5, 0, 0], yawDeg: -90` (faces `-X`).
   - Units: `1 u = 8 cm` (`10 u = 80 cm` center-to-center; Blender meter scale `0.08`). `yawDeg` matches Blender `root.rotation_euler.z` (`+90` = facing `+X`).
3. Call `popo-mmd.inspect_duo` with `actorA`, `actorB`, `sampleTimes`, and `renderViews: true`:
   - Read `frames[].distancesUnits.minWristPair` (`distUnits`, `distCm`) and `landmarksWorld` (world-space positions of `センター`, `頭`, `左手首`, `右手首`, `左足首`, `右足首`).
   - Check `issues` for `torso_clipping`, `head_clipping`, or `hand_inside_partner`.
   - To aim Actor A's hand at Actor B's world hand landmark (or midpoint), pass `convertWorldPointFor: { actor: "A", worldPoint: [...] }` to `inspect_duo` (which applies `worldToActorLocal`) and paste the returned `[x, y, z]` directly into `reach hand_r to [x, y, z];` in Actor A's MPL!
4. Export both blocking `.vmd` files (`actor_a_blocking.vmd`, `actor_b_blocking.vmd`) via `export_motion(..., mode="blocking", outBasePath=...)` — or keep both finalized `.vmd`s if only minor contact touch-up is needed.

### Stage 2 — Import & Polish Both Rigs in Blender (`mmd_tools`)

> [!CAUTION]
> **NEVER** use `next(o for o in bpy.data.objects if o.type == "ARMATURE")` or `... if o.mmd_type == "ROOT"` in a duo scene — you will overwrite or export the wrong character! Always capture explicit object references immediately on import and record their names (`"root_A"`, `"root_B"`).

1. **Import both models and place their `ROOT` objects using `report.actorA.blenderRoot` / `actorB.blenderRoot` from `inspect_duo`**:

```python
import bpy, math

def import_rig(pmx_path, location, rot_z_deg, tag):
    before = set(bpy.data.objects.keys())
    bpy.ops.mmd_tools.import_model(filepath=pmx_path, scale=0.08)
    new_objs = [bpy.data.objects[k] for k in bpy.data.objects.keys() if k not in before]
    root = next(o for o in new_objs if getattr(o, "mmd_type", "") == "ROOT")
    arm = next(o for o in new_objs if o.type == "ARMATURE")
    root.name = f"ROOT_{tag}"
    arm.name = f"ARM_{tag}"
    root.location = tuple(location)
    root.rotation_euler = (0.0, 0.0, math.radians(rot_z_deg))
    return root, arm

# Coordinates come directly from inspect_duo's blenderRoot:
root_a, arm_a = import_rig(PMX_A, BLA_LOC, BLA_YAW_DEG, "A")
root_b, arm_b = import_rig(PMX_B, BLB_LOC, BLB_YAW_DEG, "B")
```

2. **Import each `.vmd` onto its own `arm` & build separate `jp_bones` maps** (activating `arm_a` before importing `actor_a_blocking.vmd`, and `arm_b` before `actor_b_blocking.vmd`, with `margin=0`):

```python
for arm, vmd_path in [(arm_a, VMD_A), (arm_b, VMD_B)]:
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.mmd_tools.import_vmd(filepath=vmd_path, scale=0.08, margin=0)
    # Disable Leg IK when FK legs are keyed (required per rig):
    for pb in arm.pose.bones:
        if "IK" in pb.mmd_bone.name_j and ("足" in pb.name or "つま先" in pb.name):
            pb.mmd_ik_toggle = False

jp_a = {pb.mmd_bone.name_j: pb.name for pb in arm_a.pose.bones if not pb.mmd_bone.is_mmd_shadow_bone}
jp_b = {pb.mmd_bone.name_j: pb.name for pb in arm_b.pose.bones if not pb.mmd_bone.is_mmd_shadow_bone}
```

3. **Polish in world space**:
   - Inspect hand-to-hand / hand-to-shoulder contact by computing world wrist positions via `arm.matrix_world @ pb.head` (or evaluated mesh hand vertices) across the interaction frames, and refine `肩` / `腕` / `ひじ` / finger bones (`右親指*`, `右人指*`, ...) so palms/fingers wrap cleanly without intersecting.
   - Smooth F-Curves (`AUTO_CLAMPED` on `QUATERNION` rotation/location) and run the shoe-sole ground-contact cleanup per rig (`arm_a`, then `arm_b`) before final export.
4. **Export two separate `.vmd` files** by selecting/activating **`root_a`** first, then **`root_b`**:

```python
for root, out_path in [(root_a, FINAL_VMD_A), (root_b, FINAL_VMD_B)]:
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.mmd_tools.export_vmd(filepath=out_path, scale=12.5, use_frame_range=True)
    assert os.path.exists(out_path) and os.path.getsize(out_path) > 0
```

### Stage 3 — Final Duo Verification

- Re-run `popo-mmd.inspect_duo` on `FINAL_VMD_A` and `FINAL_VMD_B` with the same `offset`/`yawDeg` and `renderViews: true` to confirm zero cross-actor clipping and expected contact distances, and run `popo-mmd.inspect_vmd_file` on each actor individually to confirm single-rig grounding (`offendingFrames: 0`).
