"use client"

import { useRef, useEffect, useCallback, useState } from "react"
import { RotateCcw, Users } from "lucide-react"

import ChatInput from "./chat-input"
import ModelsPanel from "./models-panel"
import { Button } from "./ui/button"
import { Engine } from "reze-engine"
import { MODEL_URL } from "@/lib/model"
import { getIdleObjectUrl } from "@/lib/idle-motion"
import { applyIkScheduleAtTime } from "@/lib/vmd-enhancer"
import type { IkWindow } from "@/lib/vmd-enhancer"
import {
  DEFAULT_CAMERA_DISTANCE,
  STAGE_READY_MESSAGE,
  STAGE_STATE_MESSAGE,
  clampStageZoom,
  isStageReplayMessage,
  isStageZoomMessage,
  readStageParams,
  setStageCameraRadius,
} from "@/lib/stage-params"

type LoadVmdOpts = {
  disableIK?: boolean
  disablePhysics?: boolean
  isIdle?: boolean
  ikSchedule?: IkWindow[]
}

export default function MainScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const engineRef = useRef<Engine>(null)
  const onIdleRef = useRef(false)
  const ikScheduleRef = useRef<IkWindow[] | undefined>(undefined)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState<string>(MODEL_URL)
  const [modelsOpen, setModelsOpen] = useState(false)
  // 最近一次用户动作（重播按钮用；idle/空加载不记录）
  const lastAnimRef = useRef<{ url: string; opts?: LoadVmdOpts } | null>(null)
  const [hasUserAnim, setHasUserAnim] = useState(false)

  // Embedded stage (`?embed=1&zoom=…`, e.g. inside the DSH sidebar): chrome off, camera pulled back
  // so the character stays in frame. Read once per page load; later zoom changes arrive by message.
  const [stage] = useState(() => readStageParams())
  const zoomRef = useRef(stage.zoom)
  const cameraRadiusRef = useRef(DEFAULT_CAMERA_DISTANCE * stage.zoom)
  // Embedded stage's replay control. The last motion shown wins; before any, the latest MCP stage
  // push (known only to the chat box) is replayed — which also survives this page reloading.
  const replayStagePushRef = useRef<(() => boolean) | null>(null)
  const [hasStagePush, setHasStagePush] = useState(false)
  const canReplay = hasUserAnim || hasStagePush
  const canReplayRef = useRef(false)

  const applyZoom = useCallback((value: number) => {
    const zoom = clampStageZoom(value)
    zoomRef.current = zoom
    const radius = DEFAULT_CAMERA_DISTANCE * zoom
    setStageCameraRadius(engineRef.current, canvasRef.current, radius, cameraRadiusRef.current)
    cameraRadiusRef.current = radius
  }, [])

  const playIdle = useCallback(async (engine: Engine) => {
    try {
      onIdleRef.current = true
      ikScheduleRef.current = undefined
      engine.disableIK = false
      engine.disablePhysics = false
      await engine.loadAnimation(getIdleObjectUrl())
      engine.playAnimation()
    } catch {
      // idle is polish, never a blocker
    }
  }, [])

  const loadVMD = useCallback(async (url: string, opts?: LoadVmdOpts) => {
    const engine = engineRef.current
    if (!engine) return
    if (!url) {
      ikScheduleRef.current = undefined
      engine.stopAnimation()
      setHasUserAnim(false)
      return
    }
    onIdleRef.current = Boolean(opts?.isIdle)
    // idle 呼吸不记录进重播；用户动作才记录
    if (!opts?.isIdle) {
      lastAnimRef.current = { url, opts }
      setHasUserAnim(true)
    }
    // 存在分时段 ikSchedule 时按首窗口初始化，播放中在 render loop 内动态切换足 IK
    ikScheduleRef.current = opts?.isIdle ? undefined : opts?.ikSchedule
    const initWin = ikScheduleRef.current?.[0]
    engine.disableIK = initWin ? initWin.disableIK : (opts?.disableIK ?? false)
    engine.disablePhysics = initWin ? initWin.disablePhysics : (opts?.disablePhysics ?? false)
    await engine.loadAnimation(url)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    engine.playAnimation()
  }, [])

  // 重播：动作播完 1s 后会被自动切回呼吸 idle，此时已加载动画不再是用户的动作，
  // 所以必须用存储的 URL+opts 完整重新加载（而不是 seek）
  const replayLast = useCallback(() => {
    const last = lastAnimRef.current
    if (!last) return
    void loadVMD(last.url, {
      disableIK: last.opts?.disableIK,
      disablePhysics: last.opts?.disablePhysics,
      ikSchedule: last.opts?.ikSchedule,
    })
  }, [loadVMD])

  // Embedded stage toolbar: same as the 重播 button, falling back to the latest MCP stage push.
  const replay = useCallback((): boolean => {
    if (lastAnimRef.current) {
      replayLast()
      return true
    }
    return replayStagePushRef.current?.() ?? false
  }, [replayLast])

  useEffect(() => {
    canReplayRef.current = canReplay
  }, [canReplay])

  useEffect(() => {
    if (!stage.embed) return
    const onMessage = (event: MessageEvent) => {
      if (isStageZoomMessage(event.data)) applyZoom(event.data.zoom)
      else if (isStageReplayMessage(event.data)) replay()
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [stage.embed, applyZoom, replay])

  // Keep the embedding toolbar's replay button in step with what there is to replay.
  useEffect(() => {
    if (!stage.embed) return
    window.parent.postMessage({ type: STAGE_STATE_MESSAGE, canReplay }, "*")
  }, [stage.embed, canReplay])

  const selectModel = useCallback(
    async (modelUrl: string) => {
      setSelectedModel(modelUrl)
      setModelsOpen(false)
      const engine = engineRef.current
      if (!engine) return
      try {
        setEngineError(null)
        await engine.loadModel(modelUrl)
        await playIdle(engine)
      } catch (error) {
        setEngineError(error instanceof Error ? error.message : "Failed to load model")
      }
    },
    [playIdle]
  )

  useEffect(() => {
    let disposed = false

    const initEngine = async () => {
      if (!canvasRef.current) return
      try {
        const engine = new Engine(canvasRef.current, {
          directionalLightIntensity: 0.18,
          cameraDistance: DEFAULT_CAMERA_DISTANCE * zoomRef.current,
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
        if (stage.embed) {
          // Tell the embedding parent the stage can take live zoom and replay messages.
          window.parent.postMessage(
            { type: STAGE_READY_MESSAGE, zoom: zoomRef.current, canReplay: canReplayRef.current },
            "*"
          )
        }
        await engine.loadModel(MODEL_URL)
        if (disposed) {
          engine.dispose()
          engineRef.current = null
          return
        }

        // Phase 3 ⑧B: model opens breathing instead of a frozen rest pose
        await playIdle(engine)
        if (!disposed) {
          engine.runRenderLoop(() => {
            const sched = ikScheduleRef.current
            if (sched && sched.length > 0 && !onIdleRef.current && typeof engine.getAnimationProgress === "function") {
              const prog = engine.getAnimationProgress()
              if (prog && typeof prog.current === "number") applyIkScheduleAtTime(engine, sched, prog.current)
            }
          })
        }
      } catch (error) {
        if (!disposed) {
          setEngineError(error instanceof Error ? error.message : "Unknown error")
        }
      }
    }

    void initEngine()

    // Phase 3 ⑧B: 动作播完 → 回呼吸循环；呼吸循环播完 → 从头续播（reze-engine 到尾会自动 pause）
    const timer = setInterval(() => {
      const engine = engineRef.current
      if (!engine || typeof engine.getAnimationProgress !== "function") return
      try {
        const p = engine.getAnimationProgress()
        if (!p || typeof p.percentage !== "number") return
        if (p.percentage >= 100) {
          if (onIdleRef.current) {
            engine.seekAnimation(0)
            engine.playAnimation()
          } else {
            void playIdle(engine)
          }
        }
      } catch {
        // progress unavailable — skip this tick
      }
    }, 1000)

    // Cleanup on unmount
    return () => {
      disposed = true
      clearInterval(timer)
      if (engineRef.current) {
        engineRef.current.dispose()
        engineRef.current = null
      }
    }
  }, [playIdle, stage.embed])

  // Embedded stage: keep the chat box mounted (it polls /api/stage-push, the MCP bridge) but unseen.
  const chatAreaClass = stage.embed
    ? "hidden"
    : "flex flex-col gap-2 fixed left-1/2 -translate-x-1/2 bottom-0 max-w-2xl mx-auto flex p-4 w-full z-10"

  return (
    <div className="w-full h-full">
      <div className="w-full h-[70%] md:h-full order-1 md:order-2 bg-[#0f172a] relative">
        {engineError && (
          <div className="text-red-500 z-10 absolute top-0 left-0 w-full h-full flex items-center justify-center text-lg font-medium">
            {engineError}
          </div>
        )}
        {/* Embedded stage keeps replay in the embedding toolbar instead. */}
        {!stage.embed && hasUserAnim && (
          <Button
            size="sm"
            variant="secondary"
            className="fixed top-3 right-36 z-210 bg-white/15 hover:bg-white/25 text-white border border-white/20 backdrop-blur-xs cursor-pointer"
            onClick={replayLast}
          >
            <RotateCcw className="size-4" />
            <span className="text-xs">重播</span>
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          className="fixed top-3 right-4 z-210 bg-white/15 hover:bg-white/25 text-white border border-white/20 backdrop-blur-xs cursor-pointer"
          onClick={() => setModelsOpen(true)}
        >
          <Users className="size-4" />
          <span className="text-xs">Models</span>
        </Button>
        <canvas ref={canvasRef} className="w-full h-full z-1" />
      </div>

      <ModelsPanel open={modelsOpen} setOpen={setModelsOpen} selectedModel={selectedModel} selectModel={selectModel} />

      <div className={chatAreaClass}>
        <ChatInput
          loadVMD={loadVMD}
          modelUrl={selectedModel}
          replayRef={replayStagePushRef}
          onStagePushChange={setHasStagePush}
        />
      </div>
    </div>
  )
}
