import { ArrowUp, Eye, RotateCcw } from "lucide-react"
import { Button } from "./ui/button"
import { motion } from "framer-motion"
import { Card, CardDescription, CardHeader } from "./ui/card"

import { useState, useEffect, useCallback, useRef } from "react"
import { Textarea } from "./ui/textarea"
import { useMPLCompiler } from "@/hooks/useMPLCompiler"
import { computeIkSchedule, enhanceVmd } from "@/lib/vmd-enhancer"
import type { IkWindow } from "@/lib/vmd-enhancer"
import { compileMPL2 } from "@/lib/mpl2"
import { serializePmxBones } from "@/lib/pmx-bones"
import { auditVmd, formatAuditReport } from "@/lib/pose-audit"
import { buildModelConditioning } from "@/lib/model-conditioning"
import { getActiveModelBones, MODEL_URL } from "@/lib/model"
import { getIdleObjectUrl } from "@/lib/idle-motion"
import { parseSseBuffer } from "@/lib/long-motion"
import type { LongMotionStreamEvent } from "@/lib/long-motion"

const suggestedPoses: string[] = ["look down", "arms down", "look right", "tilting left"] as const

/** Shape of `/api/stage-push` responses (keep in sync with src/app/api/stage-push/route.ts). */
type StagePushPayload = {
  seq: number
  mpl: string
  vmdBase64?: string
  baseRotated?: boolean
  legsKeyed?: boolean
  title?: string
  pushedAt: string
}

/** A push older than this on mount is treated as stale: kept for manual replay, never auto-played. */
const FRESH_PUSH_MS = 2 * 60 * 1000

function stagePushLabel(title: string | undefined, replay: boolean) {
  const prefix = replay ? "重播 MCP 推送" : "已从 MCP 载入舞台动作"
  return title ? `${prefix}：${title}` : prefix
}

export default function ChatInput({
  loadVMD,
  modelUrl = MODEL_URL,
  replayRef,
  onStagePushChange,
}: {
  loadVMD: (
    vmdUrl: string,
    opts?: { disableIK?: boolean; disablePhysics?: boolean; isIdle?: boolean; ikSchedule?: IkWindow[] }
  ) => Promise<void> | void
  modelUrl?: string
  /**
   * Parent-side replay control (the embedded stage's toolbar): always holds the function that
   * replays the latest MCP stage push; it returns false when there is none to replay.
   */
  replayRef?: { current: (() => boolean) | null }
  /** Reports whether a stage push is known, so a parent can enable its own replay control. */
  onStagePushChange?: (available: boolean) => void
}) {
  const mplCompiler = useMPLCompiler()
  const vmdUrlRef = useRef<string | null>(null)
  const lastStageSeqRef = useRef<number | null>(null)
  /** Latest MCP stage push seen by this page (baseline or live), so it can be replayed on demand. */
  const lastStagePushRef = useRef<Pick<
    StagePushPayload,
    "mpl" | "vmdBase64" | "baseRotated" | "legsKeyed" | "title" | "pushedAt"
  > | null>(null)

  const [waitingPoseResult, setWaitingPoseResult] = useState(false)
  const [progressLabel, setProgressLabel] = useState<string | null>(null)
  const [progressPct, setProgressPct] = useState<number>(0)
  const [displayedPoses, setDisplayedPoses] = useState<string[]>([])
  const [resultMpl, setResultMpl] = useState<string | null>(null)
  const [resultError, setResultError] = useState<string | null>(null)
  const [resultNotice, setResultNotice] = useState<string | null>(null)
  const [visualCriticEnabled, setVisualCriticEnabled] = useState(false)
  const [hasStagePush, setHasStagePush] = useState(false)

  // Function to get 4 random poses
  const getRandomPoses = () => {
    const shuffled = [...suggestedPoses].sort(() => 0.5 - Math.random())
    return shuffled.slice(0, 4)
  }

  // Initialize with random poses on component mount & revoke any active blob URL on unmount
  useEffect(() => {
    setDisplayedPoses(getRandomPoses())
    return () => {
      if (vmdUrlRef.current) {
        URL.revokeObjectURL(vmdUrlRef.current)
        vmdUrlRef.current = null
      }
    }
  }, [])

  const [description, setDescription] = useState("")

  const playVmdOnStage = useCallback(
    async (
      vmdBytes: Uint8Array,
      opts?: { baseRotated?: boolean; legsKeyed?: boolean; notices?: string[]; mplLabel?: string | null }
    ) => {
      if (vmdBytes.length === 0) {
        await loadVMD(getIdleObjectUrl(), { isIdle: true })
        return
      }
      const notices = opts?.notices ?? []
      setResultNotice(notices.length > 0 ? notices.join("\n") : null)
      const vmdBlob = new Blob([new Uint8Array(vmdBytes)], { type: "application/octet-stream" })
      const nextUrl = URL.createObjectURL(vmdBlob)
      const prevUrl = vmdUrlRef.current
      vmdUrlRef.current = nextUrl
      const ikSchedule = computeIkSchedule(vmdBytes)
      await loadVMD(nextUrl, {
        disableIK: Boolean(opts?.baseRotated || opts?.legsKeyed),
        disablePhysics: Boolean(opts?.baseRotated),
        ikSchedule: ikSchedule.length > 0 ? ikSchedule : undefined,
      })
      if (prevUrl) URL.revokeObjectURL(prevUrl)
      if (opts?.mplLabel !== undefined) setResultMpl(opts.mplLabel)
    },
    [loadVMD]
  )

  const playMplOnStage = useCallback(
    async (
      mplScript: string,
      bonesArg?: Awaited<ReturnType<typeof getActiveModelBones>>,
      extraNotices: string[] = []
    ) => {
      if (!mplCompiler) return
      const bones = bonesArg ?? (await getActiveModelBones(modelUrl))
      const mpl2 = compileMPL2(mplCompiler, mplScript, bones)
      const notices = [...extraNotices]
      if (mpl2.collisions.length > 0) {
        console.warn("[mpl2] 同时刻同骨骼关键帧碰撞:", mpl2.collisions)
        notices.push(`同一时刻同一骨骼出现 ${mpl2.collisions.length} 处关键帧碰撞——该瞬间动作可能抖动`)
      }
      console.info(`[mpl2] morph keys: ${mpl2.morphCount}, composed: ${mpl2.composed}`)
      let audited = mpl2.vmd
      if (bones) {
        const audit = auditVmd(mpl2.vmd, bones)
        if (audit.violations.length > 0) {
          console.info(
            `[pose-audit] ${audit.violations.length} clip(s) detected, ${audit.fixed.length} auto-relaxed\n${formatAuditReport(audit)}`
          )
        }
        audited = audit.vmd
      }
      const vmdBytes = enhanceVmd(audited, { autoBlink: true })
      await playVmdOnStage(vmdBytes, {
        baseRotated: mpl2.baseRotated,
        legsKeyed: mpl2.legsKeyed,
        notices,
        mplLabel: mplScript,
      })
    },
    [mplCompiler, modelUrl, playVmdOnStage]
  )

  const playStagePush = useCallback(
    async (
      push: Pick<StagePushPayload, "mpl" | "vmdBase64" | "baseRotated" | "legsKeyed" | "title">,
      replay: boolean
    ) => {
      const notice = stagePushLabel(push.title, replay)
      if (push.vmdBase64) {
        const bin = atob(push.vmdBase64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        await playVmdOnStage(bytes, {
          baseRotated: push.baseRotated,
          legsKeyed: push.legsKeyed,
          notices: [notice],
          mplLabel: push.mpl || null,
        })
        return
      }
      if (push.mpl) {
        await playMplOnStage(push.mpl, undefined, [notice])
      }
    },
    [playMplOnStage, playVmdOnStage]
  )

  // Listen for live stage pushes from the PoPo MCP Server (supports both MPL2 and Blender-polished VMD).
  // On mount we record the server's current seq as the baseline. A baseline push that is
  // still fresh is played once (so "push first, open the page later" still shows the motion);
  // anything older is only kept for the replay button. Every later push plays live.
  useEffect(() => {
    if (!mplCompiler) return
    let cancelled = false
    const timer = setInterval(async () => {
      if (cancelled || waitingPoseResult) return
      try {
        const isFirstPoll = lastStageSeqRef.current === null
        const res = await fetch(isFirstPoll ? "/api/stage-push" : `/api/stage-push?since=${lastStageSeqRef.current}`)
        if (res.status === 204 || !res.ok) return
        const data = (await res.json()) as Partial<StagePushPayload>
        const seq = Number(data?.seq ?? 0)
        const mpl = typeof data?.mpl === "string" ? data.mpl.trim() : ""
        const vmdBase64 = typeof data?.vmdBase64 === "string" ? data.vmdBase64.trim() : ""
        const hasPayload = Boolean(mpl || vmdBase64)
        if (isFirstPoll) {
          lastStageSeqRef.current = seq
          if (!hasPayload) return
          lastStagePushRef.current = {
            mpl,
            vmdBase64: vmdBase64 || undefined,
            baseRotated: data.baseRotated,
            legsKeyed: data.legsKeyed,
            title: data.title,
            pushedAt: data.pushedAt ?? "",
          }
          setHasStagePush(true)
          const ageMs = Date.now() - Date.parse(data.pushedAt ?? "")
          const isFresh = Number.isFinite(ageMs) ? ageMs < FRESH_PUSH_MS : false
          if (!isFresh) return
        } else {
          if (!(seq > (lastStageSeqRef.current ?? 0)) || !hasPayload) return
          lastStageSeqRef.current = seq
          lastStagePushRef.current = {
            mpl,
            vmdBase64: vmdBase64 || undefined,
            baseRotated: data.baseRotated,
            legsKeyed: data.legsKeyed,
            title: data.title,
            pushedAt: data.pushedAt ?? "",
          }
          setHasStagePush(true)
        }
        setResultError(null)
        await playStagePush(lastStagePushRef.current, false)
      } catch {
        // Ignore transient network errors when dev server restarts
      }
    }, 1200)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [mplCompiler, waitingPoseResult, playStagePush])

  // Replay the latest MCP stage push — from this box's own button, or from a parent toolbar through
  // `replayRef`. Works for a push that was never played here (older than FRESH_PUSH_MS on load).
  const replayStagePush = useCallback((): boolean => {
    const push = lastStagePushRef.current
    if (!push || waitingPoseResult || !mplCompiler) return false
    setResultError(null)
    void playStagePush(push, true)
    return true
  }, [waitingPoseResult, mplCompiler, playStagePush])

  // Runs after every render so the parent's ref always holds the latest closure.
  useEffect(() => {
    if (replayRef) replayRef.current = replayStagePush
  })
  useEffect(() => {
    onStagePushChange?.(hasStagePush)
  }, [hasStagePush, onStagePushChange])

  const generatePose = useCallback(
    async (promptText: string) => {
      const trimmed = promptText.trim()
      if (!trimmed || waitingPoseResult) return
      if (!mplCompiler) {
        setResultError("MPL compiler is still initializing, please try again.")
        return
      }

      setWaitingPoseResult(true)
      setProgressLabel("正在准备模型骨架与剧本...")
      setProgressPct(8)
      setResultError(null)

      const applyStreamEvent = (ev: LongMotionStreamEvent) => {
        switch (ev.type) {
          case "stage":
            setProgressLabel(ev.message)
            if (ev.stage === "planning") setProgressPct(15)
            else if (ev.stage === "generating") setProgressPct(30)
            else if (ev.stage === "stitching") setProgressPct(78)
            else if (ev.stage === "visual_critic") setProgressPct(90)
            break
          case "plan_done":
            setProgressLabel(
              `已规划 ${ev.segmentCount} 段动作（预计 ${ev.totalDuration}s${ev.customCount > 0 ? `，含 ${ev.customCount} 段定制` : ""}）`
            )
            setProgressPct(28)
            break
          case "segment_done": {
            const pct =
              ev.customTotal > 0
                ? 30 + Math.round((ev.customCompleted / ev.customTotal) * 45)
                : 70
            setProgressPct(Math.max(30, Math.min(76, pct)))
            if (ev.source === "llm" && ev.customTotal > 0) {
              setProgressLabel(`生成定制动作 ${ev.customCompleted}/${ev.customTotal}：${ev.action}`)
            }
            break
          }
          case "fk_check":
            setProgressLabel(ev.passed ? "运动学检查通过" : `运动学自愈复检（第 ${ev.attempt} 轮）...`)
            setProgressPct(84)
            break
          case "fk_repair":
            setProgressLabel(`运动学自动修复段落 [${ev.fixed.join(", ")}]...`)
            setProgressPct(86)
            break
          case "visual_critic_start":
            setProgressLabel(
              ev.mode === "storyboard"
                ? `正在进行 ${ev.tileCount} 帧分镜视觉质检...`
                : "正在进行三视图视觉质检..."
            )
            setProgressPct(92)
            break
          case "visual_critic_done":
            setProgressLabel(
              ev.refined
                ? `视觉质检已微调段落${ev.targetSegmentIndex != null ? ` #${ev.targetSegmentIndex}` : ""}`
                : "视觉质检完成，正在载入动作..."
            )
            setProgressPct(97)
            break
        }
      }

      try {
        // Phase 1 编排端点：Plan → Generate → Stitch，返回标准 MPL（兼容旧字段 {mpl}）
        // Phase 2 条件化：当前模型的骨骼覆盖/IK/裙摆检测 → 注入 planner/segment prompt
        // Layer 2 自愈回路：骨架同时上传，服务端做 FK 地面接触检查与定向修复
        // Phase L3：开启 SSE 流式进度推送 + 多帧分镜视觉质检
        const bones = await getActiveModelBones(modelUrl)
        const conditioning = bones ? buildModelConditioning(bones).text : undefined
        const poseRes = await fetch("/api/pose-generate-long", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            description: trimmed,
            conditioning,
            modelBones: bones ? serializePmxBones(bones) : undefined,
            visualCritic: visualCriticEnabled,
            stream: true,
          }),
        })

        if (!poseRes.ok) {
          const errJson = await poseRes.json().catch(() => null)
          throw new Error(errJson?.error || `Request failed (${poseRes.status})`)
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let resp: any = null
        const ctype = poseRes.headers.get("content-type") ?? ""
        if (ctype.includes("text/event-stream") && poseRes.body) {
          const reader = poseRes.body.getReader()
          const decoder = new TextDecoder()
          let sseBuf = ""
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            sseBuf += decoder.decode(value, { stream: true })
            const { events, rest } = parseSseBuffer(sseBuf)
            sseBuf = rest
            for (const ev of events) {
              if (ev.type === "complete") resp = ev.payload
              else if (ev.type === "error") throw new Error(ev.error || "Long motion generation failed")
              else applyStreamEvent(ev)
            }
          }
          if (sseBuf.trim()) {
            const { events } = parseSseBuffer(`${sseBuf}\n\n`)
            for (const ev of events) {
              if (ev.type === "complete") resp = ev.payload
              else if (ev.type === "error") throw new Error(ev.error || "Long motion generation failed")
              else applyStreamEvent(ev)
            }
          }
        } else {
          resp = await poseRes.json().catch(() => null)
        }

        if (!resp?.mpl) {
          throw new Error(resp?.error || "Empty MPL returned from server")
        }

        console.log(resp.mpl)
        const notices: string[] = []
        if (Array.isArray(resp.plan?.warnings) && resp.plan.warnings.length > 0) {
          notices.push(...resp.plan.warnings.map(String))
        }
        if (resp.fk?.repairs?.length > 0) {
          notices.push(`运动学自愈：${resp.fk.repairs.length} 轮修复 (${resp.fk.summary ?? ""})`)
        }
        if (resp.visualCritic) {
          const vc = resp.visualCritic
          const modeTag = vc.mode === "storyboard" ? `（${vc.tileCount ?? "?"} 帧分镜）` : ""
          if (vc.status === "passed") {
            notices.push(`视觉质检${modeTag}：${vc.score ?? "-"}/10 通过`)
          } else if (vc.status === "needs_fix" && vc.refined) {
            notices.push(`视觉质检${modeTag}：初评 ${vc.score ?? "-"}/10 → 已自动微调 1 轮`)
          } else if (vc.status === "needs_fix") {
            notices.push(`视觉质检${modeTag}：${vc.score ?? "-"}/10（${(vc.issues ?? []).join("；") || "保留原版本"}）`)
          } else if (vc.status === "skipped") {
            notices.push(`视觉质检已跳过（${vc.reason ?? "模型不支持图像输入"}）`)
          }
        }
        await playMplOnStage(resp.mpl, bones, notices)
        setDescription("")
      } catch (error) {
        console.error(error)
        setResultError(error instanceof Error ? error.message : String(error))
        setResultNotice(null)
      } finally {
        setWaitingPoseResult(false)
        setProgressLabel(null)
        setProgressPct(0)
      }
    },
    [mplCompiler, playMplOnStage, modelUrl, waitingPoseResult, visualCriticEnabled]
  )

  return (
    <>
      <div className="relative w-full flex flex-col gap-3">
        {resultMpl && (
          <div className="text-sm text-white bg-black/30 p-2 rounded-md mb-2 overflow-x-auto overflow-y-scroll max-h-24">
            <span className="font-medium">Generated MPL script:</span>
            <pre className="p-2 select-all">{resultMpl}</pre>
          </div>
        )}
        {resultNotice && (
          <div className="text-xs text-amber-300 bg-black/40 rounded-md mb-2 overflow-x-auto overflow-y-scroll max-h-20">
            <pre className="p-2 whitespace-pre-wrap select-all">{resultNotice}</pre>
          </div>
        )}
        {resultError && (
          <div className="text-sm text-red-500 bg-black/70 rounded-md mb-2 overflow-x-auto">
            <pre className="p-2">Error: {resultError}</pre>
          </div>
        )}
        {!resultMpl && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {displayedPoses.map((pose, i) => (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                transition={{ delay: 0.05 * i }}
                key={`suggested-pose-${pose}-${i}`}
                className={i > 1 ? "hidden sm:block" : "block"}
              >
                <Card
                  key={i}
                  className={`bg-white/50 hover:bg-pink-100/70 py-0 gap-0 h-full w-full cursor-pointer backdrop-blur-[3px] shadow-lg ${
                    i >= 2 ? "hidden md:block" : ""
                  }`}
                  onClick={() => {
                    if (!waitingPoseResult) generatePose(pose)
                  }}
                >
                  <CardHeader className="py-2 gap-0">
                    <CardDescription className="py-1 text-zinc-800 ">{pose}</CardDescription>
                  </CardHeader>
                </Card>
              </motion.div>
            ))}
          </div>
        )}

        <div className="relative w-full">
          <Textarea
            className="max-h-[calc(75dvh)] md:text-base overflow-hidden resize-none bg-white/50 text-zinc-800 backdrop-blur-[3px] shadow-lg px-4"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && description.trim().length > 0 && !waitingPoseResult) {
                e.preventDefault()
                generatePose(description)
              }
            }}
            disabled={waitingPoseResult}
            placeholder={"Pose me as you would like to see me ..."}
          />
          {waitingPoseResult && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/45 backdrop-blur-[2px] rounded-lg z-10 px-4">
              <div className="flex items-center gap-2 text-xs text-zinc-100">
                <div className="h-4 w-4 border-2 border-zinc-200 border-t-transparent rounded-full animate-spin shrink-0"></div>
                <span className="truncate max-w-[260px]">{progressLabel ?? "生成中..."}</span>
              </div>
              <div className="w-48 h-1 bg-white/20 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-400 transition-all duration-300"
                  style={{ width: `${Math.max(5, Math.min(100, progressPct))}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="absolute bottom-2.5 right-2.5 w-fit flex flex-row items-center gap-1.5 justify-end">
          {hasStagePush && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              title="重播最近一次 MCP 推送到舞台的动作（不依赖页面打开时机）"
              className="rounded-full h-7 px-2.5 text-xs cursor-pointer bg-white/70 hover:bg-white/90 text-zinc-700"
              disabled={waitingPoseResult || !mplCompiler}
              onClick={() => void replayStagePush()}
            >
              <RotateCcw className="size-3.5 mr-1" />
              <span>重播推送</span>
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={visualCriticEnabled ? "default" : "secondary"}
            title="开启后将渲染三视图/多帧分镜包络图并由 VLM 视觉评审（可自动微调 1 轮）"
            className={`rounded-full h-7 px-2.5 text-xs cursor-pointer ${
              visualCriticEnabled
                ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                : "bg-white/70 hover:bg-white/90 text-zinc-700"
            }`}
            disabled={waitingPoseResult}
            onClick={() => setVisualCriticEnabled((v) => !v)}
          >
            <Eye className="size-3.5 mr-1" />
            <span>视觉质检</span>
          </Button>
          <Button
            size="icon"
            className="rounded-full h-fit w-fit p-1"
            disabled={waitingPoseResult || description.trim().length === 0}
            onClick={() => generatePose(description)}
          >
            <ArrowUp className="size-5" />
          </Button>
        </div>
      </div>
    </>
  )
}
