import { useCallback, useState, useEffect, useRef } from "react"
import { Button } from "./ui/button"
import { Download, Upload } from "lucide-react"
import { useMPLCompiler } from "@/hooks/useMPLCompiler"
import { computeIkSchedule, enhanceVmd } from "@/lib/vmd-enhancer"
import type { IkWindow } from "@/lib/vmd-enhancer"
import { auditVmd } from "@/lib/pose-audit"
import { compileMPL2 } from "@/lib/mpl2"
import { getActiveModelBones, MODEL_URL } from "@/lib/model"
import CodeEditor from "./code-editor"
import Link from "next/link"
import { Pose } from "@/lib/types"
import { FilesetResolver, HolisticLandmarker } from "@mediapipe/tasks-vision"
import { Solver } from "@/lib/mediapipe_solver"

export default function MPLEditor({
  modelLoaded,
  loadVMD,
  pose,
  modelUrl = MODEL_URL,
}: {
  loadVMD: (url: string, opts?: { disableIK?: boolean; disablePhysics?: boolean; ikSchedule?: IkWindow[] }) => Promise<void> | void
  modelLoaded: boolean
  pose: Pose | null
  modelUrl?: string
}) {
  const mplCompiler = useMPLCompiler()
  const [vmdUrl, setVmdUrl] = useState<string | null>(null)
  const [compileError, setCompileError] = useState<string | null>(null)

  // Auto-load the 5s greeting demo on first open (skipped once the user edits,
  // uploads a file, or opens a saved pose).
  const userEditedRef = useRef(false)
  useEffect(() => {
    if (pose) return
    let cancelled = false
    fetch("/demo/greeting-5s.mpl")
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => {
        if (!cancelled && t.trim() && !userEditedRef.current) setStatement(t)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pose])

  const [statement, setStatement] = useState(
    pose?.mpl ||
      `@pose stand {
    center move up 0, sway left 5, turn right 5, bend forward 5;
    upper_body sway right 5, bend backward 5;
    lower_body turn left 5;
    neck turn left 10, bend forward 10, sway right 5;
    head turn left 20, bend forward 20;
    shoulder_l turn right 5, sway left 10, bend backward 20;
    shoulder_r turn right 5, bend backward 10, sway left 10;
    arm_l bend forward 60;
    arm_r bend forward 45;
    elbow_l bend forward 15;
    elbow_r bend forward 15;
    wrist_l sway left 15;
    wrist_r turn left 5, bend backward 10, sway right 15;
    leg_l turn left 10;
    leg_r turn right 5, bend forward 20, sway left 10;
    knee_l bend backward 5;
    knee_r bend backward 5;
    ankle_l bend backward 15, sway left 5;
    ankle_r bend forward 5, turn left 10, sway right 5;
    toe_l bend forward 5;
    toe_r bend forward 5;
}

@pose hand_relax {
    thumb_l bend forward 10;
    index_l bend forward 45;
    middle_l sway right 5, bend forward 55;
    ring_l sway right 5, bend forward 55;
    pinky_l bend forward 60, sway right 5;
    thumb_r bend forward 10, sway left 5;
    index_r sway right 5, bend forward 35;
    middle_r sway right 5, bend forward 50;
    ring_r sway left 5, bend forward 60;
    pinky_r sway left 10, bend forward 55;
}

@pose kick {
    leg_l bend forward 120;
    knee_l bend backward 10;
}

@pose look {
    head reset;
    neck reset;
}

@animation hello {
    0: stand & hand_relax;
    1: kick;
    1.2: look;
}

main {
    hello;
}
`
  )
  const holisticLandmarkerRef = useRef<HolisticLandmarker | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)

  const detectLandmarks = useCallback(async (): Promise<Blob | null> => {
    if (!holisticLandmarkerRef.current) {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      )
      holisticLandmarkerRef.current = await HolisticLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "IMAGE",
      })
    }

    await holisticLandmarkerRef.current?.setOptions({ runningMode: "IMAGE" })

    if (
      imageRef.current &&
      imageRef.current.src.length > 0 &&
      imageRef.current.complete &&
      imageRef.current.naturalWidth > 0
    ) {
      let vpdBlob: Blob | null = null
      holisticLandmarkerRef.current!.detect(imageRef.current, (result) => {
        if (result.poseWorldLandmarks.length > 0) {
          const solver = new Solver()
          solver.solve(result)
          vpdBlob = solver.exportToVpdBlob("pose_from_image")
        }
      })
      return vpdBlob
    }
    return null
  }, [])

  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) return

      userEditedRef.current = true
      if (file.name.endsWith(".vpd")) {
        if (mplCompiler) {
          try {
            const statements = mplCompiler.reverse_compile("vpd", new Uint8Array(await file.arrayBuffer()))
            setStatement(statements)
          } catch (error) {
            console.error(error)
          }
        }
      } else if (file.name.endsWith(".vmd")) {
        if (mplCompiler) {
          try {
            const statements = mplCompiler.reverse_compile("vmd", new Uint8Array(await file.arrayBuffer()))
            setStatement(statements)
          } catch (error) {
            console.error(error)
          }
        }
      } else if (
        file.name.endsWith(".png") ||
        file.name.endsWith(".jpg") ||
        file.name.endsWith(".jpeg") ||
        file.name.endsWith(".webp")
      ) {
        const objectUrl = URL.createObjectURL(file)
        const image = new window.Image()
        image.onload = async () => {
          try {
            imageRef.current = image
            const vpdBlob = await detectLandmarks()
            if (vpdBlob && mplCompiler) {
              const statements = mplCompiler.reverse_compile("vpd", new Uint8Array(await vpdBlob.arrayBuffer()))
              setStatement(statements)
            }
          } catch (error) {
            console.error(error)
          } finally {
            URL.revokeObjectURL(objectUrl)
          }
        }
        image.onerror = () => {
          URL.revokeObjectURL(objectUrl)
        }
        image.src = objectUrl
      }
      event.target.value = ""
    },
    [setStatement, mplCompiler, detectLandmarks]
  )

  useEffect(() => {
    if (!(modelLoaded && mplCompiler)) return
    let cancelled = false
    const run = async () => {
      try {
        const bones = await getActiveModelBones(modelUrl)
        if (cancelled) return
        // Phase 2 语言层全管道：宏/main 组合/face/MPL2 空间 IK → wasm → morph+IK 注入
        const mpl2 = compileMPL2(mplCompiler, statement, bones)
        const compiled = mpl2.vmd
        // Phase 2 几何层：FK 胶囊碰撞预检 + 违例链自动回退（骨骼缺失则跳过）
        const audited = bones ? auditVmd(compiled, bones).vmd : compiled
        // Polish the compiled motion: easing curves, anticipation/overshoot/
        // settle keys, chain stagger, planted feet (see src/lib/vmd-enhancer.ts).
        const vmdBytes = enhanceVmd(audited, { autoBlink: true })
        if (cancelled) return
        setCompileError(null)
        if (vmdBytes.length === 0) {
          await loadVMD("")
          setVmdUrl(null)
          return
        }
        // Create a blob from the raw VMD bytes
        const vmdBlob = new Blob([new Uint8Array(vmdBytes)], { type: "application/octet-stream" })
        const nextUrl = URL.createObjectURL(vmdBlob)
        // base 旋转或显式腿部弯曲 = 需要关足 IK，否则足 IK 把腿拉直；仅 base 旋转时才关裙摆/头发物理
        const ikSchedule = computeIkSchedule(vmdBytes)
        await loadVMD(nextUrl, {
          disableIK: mpl2.baseRotated || mpl2.legsKeyed,
          disablePhysics: mpl2.baseRotated,
          ikSchedule: ikSchedule.length > 0 ? ikSchedule : undefined,
        })
        if (cancelled) {
          URL.revokeObjectURL(nextUrl)
          return
        }
        setVmdUrl(nextUrl)

        // Clean up the URL when a newer run replaces it
        return () => {
          URL.revokeObjectURL(nextUrl)
        }
      } catch (error) {
        if (!cancelled) setCompileError(error instanceof Error ? error.message : String(error))
      }
    }
    const cleanup = run()
    return () => {
      cancelled = true
      void cleanup.then((fn) => fn?.())
    }
  }, [statement, modelLoaded, mplCompiler, loadVMD, modelUrl])

  return (
    <div className="flex flex-col gap-1 w-full h-full pt-10">
      <div className="flex flex-row gap-2 px-6 pt-2 z-100 items-center justify-between">
        <Link href="https://github.com/AmyangXYZ/MMD-MPL" target="_blank">
          <h3 className="scroll-m-20 text-lg font-semibold tracking-tight text-white hidden md:block">MPL Editor</h3>
        </Link>
        <h3 className="scroll-m-20 text-lg font-semibold tracking-tight text-white md:hidden">MPL Editor</h3>
        <div className="flex flex-row gap-2">
          <div className="relative hidden md:block">
            <input
              type="file"
              accept=".vpd,.vmd,.png,.jpg,.jpeg,.webp"
              onChange={handleFileUpload}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              id="pose-upload"
            />
            <Button className="flex" size="sm">
              <Upload className="size-4" />
              <span className="text-xs">Upload Image/VPD/VMD</span>
            </Button>
          </div>

          <Button
            onClick={() => {
              if (vmdUrl) {
                const a = document.createElement("a")
                a.href = vmdUrl
                a.download = "animation.vmd"
                a.click()
              }
            }}
            disabled={!vmdUrl}
            className="flex cursor-pointer"
            size="sm"
          >
            <Download className="size-4" />
            <span className="text-xs">Download VMD</span>
          </Button>
        </div>
      </div>

      <div className="flex-1 py-2 px-6">
        <CodeEditor
          value={statement}
          onChange={(v) => {
            userEditedRef.current = true
            setStatement(v)
          }}
        />
        {compileError && <div className="text-red-700 text-sm font-mono mt-2 font-medium">{compileError}</div>}
      </div>
    </div>
  )
}
