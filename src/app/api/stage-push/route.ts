/**
 * /api/stage-push — Lightweight live bridge for external tools (PoPo MCP Server,
 * Blender MMD polish workflow) to push either MPL2 scripts or compiled VMD bytes
 * straight to the active browser 3D stage on localhost:4000.
 */

export interface StagePushPayload {
  seq: number
  mpl: string
  vmdBase64?: string
  baseRotated?: boolean
  legsKeyed?: boolean
  title?: string
  pushedAt: string
}

const g = globalThis as unknown as { __popoStagePush?: StagePushPayload }

function getState(): StagePushPayload {
  if (!g.__popoStagePush) {
    g.__popoStagePush = { seq: 0, mpl: "", pushedAt: "" }
  }
  return g.__popoStagePush
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const sinceRaw = url.searchParams.get("since")
  const state = getState()
  if (sinceRaw != null) {
    const since = Number(sinceRaw)
    if (Number.isFinite(since) && since >= state.seq) {
      return new Response(null, { status: 204 })
    }
  }
  return Response.json(state)
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const mpl = typeof body?.mpl === "string" ? body.mpl.trim() : ""
    const vmdBase64 = typeof body?.vmdBase64 === "string" ? body.vmdBase64.trim() : ""
    if (!mpl && !vmdBase64) {
      return Response.json({ error: "mpl or vmdBase64 is required" }, { status: 400 })
    }
    const prev = getState()
    const next: StagePushPayload = {
      seq: prev.seq + 1,
      mpl,
      vmdBase64: vmdBase64 || undefined,
      baseRotated: typeof body?.baseRotated === "boolean" ? body.baseRotated : undefined,
      legsKeyed: typeof body?.legsKeyed === "boolean" ? body.legsKeyed : undefined,
      title: typeof body?.title === "string" ? body.title.trim() : undefined,
      pushedAt: new Date().toISOString(),
    }
    g.__popoStagePush = next
    return Response.json({ ok: true, seq: next.seq, pushedAt: next.pushedAt })
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 })
  }
}
