"use client"

import { useRef, useEffect, useCallback, useState } from "react"
import { RotateCcw, Users } from "lucide-react"

import MPLEditor from "./mpl-editor"
import ModelsPanel from "./models-panel"
import { Button } from "./ui/button"
import { Pose } from "@/lib/types"
import { Engine } from "reze-engine"
import { MODEL_URL } from "@/lib/model"
import { applyIkScheduleAtTime } from "@/lib/vmd-enhancer"
import type { IkWindow } from "@/lib/vmd-enhancer"

type LoadVmdOpts = { disableIK?: boolean; disablePhysics?: boolean; ikSchedule?: IkWindow[] }

export default function PlaygroundScene({ pose }: { pose: Pose | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine>(null)
  const ikScheduleRef = useRef<IkWindow[] | undefined>(undefined)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [modelLoaded, setModelLoaded] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>(MODEL_URL)
  const [modelsOpen, setModelsOpen] = useState(false)
  // 最近一次用户动作（重播按钮用；idle/空加载不记录）
  const lastAnimRef = useRef<{ url: string; opts?: LoadVmdOpts } | null>(null)
  const [hasUserAnim, setHasUserAnim] = useState(false)

  const loadVMD = useCallback(async (url: string, opts?: LoadVmdOpts) => {
    const engine = engineRef.current
    if (!engine) return
    if (!url) {
      ikScheduleRef.current = undefined
      engine.stopAnimation()
      setHasUserAnim(false)
      return
    }
    lastAnimRef.current = { url, opts }
    setHasUserAnim(true)
    ikScheduleRef.current = opts?.ikSchedule
    const initWin = ikScheduleRef.current?.[0]
    engine.disableIK = initWin ? initWin.disableIK : (opts?.disableIK ?? false)
    engine.disablePhysics = initWin ? initWin.disablePhysics : (opts?.disablePhysics ?? false)
    await engine.loadAnimation(url)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    engine.playAnimation()
  }, [])

  // 重播当前已加载的动作：seek 0 + play，IK/物理开关沿用上次 loadVMD 的设置，无需重新加载
  const replayLast = useCallback(() => {
    const engine = engineRef.current
    if (!engine || !lastAnimRef.current) return
    engine.seekAnimation(0)
    engine.playAnimation()
  }, [])

  const selectModel = useCallback(async (modelUrl: string) => {
    setSelectedModel(modelUrl)
    setModelsOpen(false)
    const engine = engineRef.current
    if (!engine) return
    try {
      setEngineError(null)
      setModelLoaded(false)
      await engine.loadModel(modelUrl)
      setModelLoaded(true)
    } catch (error) {
      setEngineError(error instanceof Error ? error.message : "Failed to load model")
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let readyTimer: ReturnType<typeof setTimeout> | null = null

    const initEngine = async () => {
      if (!canvasRef.current) return
      try {
        const engine = new Engine(canvasRef.current, {
          directionalLightIntensity: 0.18,
        })
        if (disposed) {
          engine.dispose()
          return
        }
        engineRef.current = engine
        await engine.init()
        if (disposed) {
          engine.dispose()
          engineRef.current = null
          return
        }
        await engine.loadModel(MODEL_URL)
        if (disposed) {
          engine.dispose()
          engineRef.current = null
          return
        }

        engine.runRenderLoop(() => {
          const sched = ikScheduleRef.current
          if (sched && sched.length > 0 && typeof engine.getAnimationProgress === "function") {
            const prog = engine.getAnimationProgress()
            if (prog && typeof prog.current === "number") applyIkScheduleAtTime(engine, sched, prog.current)
          }
        })
        readyTimer = setTimeout(() => {
          if (!disposed) setModelLoaded(true)
        }, 200)
      } catch (error) {
        if (!disposed) {
          setEngineError(error instanceof Error ? error.message : "Unknown error")
        }
      }
    }

    void initEngine()

    // Cleanup on unmount
    return () => {
      disposed = true
      if (readyTimer) clearTimeout(readyTimer)
      if (engineRef.current) {
        engineRef.current.dispose()
        engineRef.current = null
      }
    }
  }, [])

  return (
    <div className="w-full h-full flex flex-col md:flex-row">
      <div className="w-full h-[70%] md:w-1/2 md:h-full order-1 md:order-2 bg-[#0f172a] relative">
        {engineError && (
          <div className="text-red-500 z-10 absolute top-0 left-0 w-full h-full flex items-center justify-center text-lg font-medium">
            {engineError}
          </div>
        )}
        <div className="absolute top-12 md:top-14 right-4 z-210 flex items-center gap-2">
          {hasUserAnim && (
            <Button
              size="sm"
              variant="secondary"
              className="bg-white/15 hover:bg-white/25 text-white border border-white/20 backdrop-blur-xs cursor-pointer"
              onClick={replayLast}
            >
              <RotateCcw className="size-4" />
              <span className="text-xs">重播</span>
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            className="bg-white/15 hover:bg-white/25 text-white border border-white/20 backdrop-blur-xs cursor-pointer"
            onClick={() => setModelsOpen(true)}
          >
            <Users className="size-4" />
            <span className="text-xs">Models</span>
          </Button>
        </div>
        <canvas ref={canvasRef} className="w-full h-full z-1" />
      </div>
      <ModelsPanel open={modelsOpen} setOpen={setModelsOpen} selectedModel={selectedModel} selectModel={selectModel} />
      <div className="w-full h-[30%] md:w-1/2 md:h-full order-2 md:order-1 border-t">
        <MPLEditor modelLoaded={modelLoaded} loadVMD={loadVMD} pose={pose} modelUrl={selectedModel} />
      </div>
    </div>
  )
}
