/**
 * Embedded-stage contract — the parameters and messages the DSH sidebar plugin
 * (`dsh-stage/`) uses to show only the 3D stage and keep the character in frame.
 *
 *   http://localhost:4000/?embed=1&zoom=1.3
 *
 * - `embed=1` hides the site chrome (header, chat box); the MCP stage-push bridge
 *   inside the chat box keeps running, so motions pushed by the PoPo MCP server
 *   still play.
 * - `zoom` (1..3) moves the camera back by that factor, so the whole body fits a
 *   narrow pane. It can change live: the parent posts
 *   `{ type: "popo:stage-zoom", zoom }` and this page answers
 *   `{ type: "popo:stage-ready" }` once the engine exists.
 * - `{ type: "popo:stage-replay" }` replays the last motion shown, or, before any,
 *   the latest MCP stage push. This page reports `{ type: "popo:stage-state",
 *   canReplay }` whenever that changes, so the parent's button can follow.
 */

export const STAGE_ZOOM_MIN = 1
export const STAGE_ZOOM_MAX = 3
/** reze-engine `DEFAULT_ENGINE_OPTIONS.cameraDistance`; the zoom multiplies it. */
export const DEFAULT_CAMERA_DISTANCE = 26.6
/** reze-engine camera `wheelPrecision`, used only when the camera is not reachable directly. */
const CAMERA_WHEEL_PRECISION = 0.01

export const STAGE_ZOOM_MESSAGE = "popo:stage-zoom"
export const STAGE_READY_MESSAGE = "popo:stage-ready"
/** Parent → stage: replay the last motion shown, or else the latest MCP stage push. */
export const STAGE_REPLAY_MESSAGE = "popo:stage-replay"
/** Stage → parent: `{ canReplay }`, so the parent's replay control can follow the stage. */
export const STAGE_STATE_MESSAGE = "popo:stage-state"

export type StageParams = {
  embed: boolean
  zoom: number
}

export function clampStageZoom(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.min(STAGE_ZOOM_MAX, Math.max(STAGE_ZOOM_MIN, Math.round(value * 100) / 100))
}

export function readStageParams(search: string = typeof window === "undefined" ? "" : window.location.search): StageParams {
  const params = new URLSearchParams(search)
  return {
    embed: params.get("embed") === "1",
    zoom: clampStageZoom(Number(params.get("zoom"))),
  }
}

/** Is this message a zoom request from the embedding parent? */
export function isStageZoomMessage(data: unknown): data is { type: typeof STAGE_ZOOM_MESSAGE; zoom: number } {
  if (!data || typeof data !== "object") return false
  const record = data as { type?: unknown; zoom?: unknown }
  return record.type === STAGE_ZOOM_MESSAGE && typeof record.zoom === "number" && Number.isFinite(record.zoom)
}

/** Is this message a replay request from the embedding parent? */
export function isStageReplayMessage(data: unknown): data is { type: typeof STAGE_REPLAY_MESSAGE } {
  if (!data || typeof data !== "object") return false
  return (data as { type?: unknown }).type === STAGE_REPLAY_MESSAGE
}

/**
 * `canReplay` as a `popo:stage-ready` or `popo:stage-state` message from the stage carries it.
 * @returns the flag, or `null` for any other message.
 */
export function readCanReplay(data: unknown): boolean | null {
  if (!data || typeof data !== "object") return null
  const record = data as { type?: unknown; canReplay?: unknown }
  if (record.type !== STAGE_READY_MESSAGE && record.type !== STAGE_STATE_MESSAGE) return null
  return typeof record.canReplay === "boolean" ? record.canReplay : null
}

/**
 * Move the camera to an absolute distance from its target.
 *
 * The engine exposes no zoom API, so this sets the camera's radius directly and,
 * should the engine's internals change, falls back to driving the engine's own
 * wheel handler (`radius += deltaY * wheelPrecision`).
 *
 * @param engine - the reze-engine `Engine` instance.
 * @param canvas - the engine's canvas, for the wheel fallback.
 * @param radius - the requested camera distance.
 * @param previousRadius - the distance the fallback should assume the camera is at now.
 */
export function setStageCameraRadius(
  engine: unknown,
  canvas: HTMLCanvasElement | null,
  radius: number,
  previousRadius: number
): void {
  const camera = (engine as { camera?: { radius?: unknown } } | null | undefined)?.camera
  if (camera && typeof camera.radius === "number") {
    camera.radius = Math.max(0.1, radius)
    return
  }
  if (!canvas) return
  const deltaY = (radius - previousRadius) / CAMERA_WHEEL_PRECISION
  if (deltaY === 0) return
  canvas.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }))
}
