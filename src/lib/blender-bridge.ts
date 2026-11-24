/**
 * blender-bridge.ts — TCP JSON bridge to Blender's `blender_mcp.py` addon.
 *
 * Protocol (matching `blender_mcp.py`, ADDON_PROTOCOL_VERSION = 16):
 *   - Blender listens on TCP loopback (default 127.0.0.1:9876).
 *   - Client sends UTF-8 JSON: { "type": "<cmd>", "params": { ... } }.
 *   - Blender queues the command on its main thread and replies with a single
 *     UTF-8 JSON object: { "status": "success"|"error", "result"?: any, "message"?: string }
 *     without closing the socket, so we decode chunks until JSON.parse succeeds
 *     and then close the socket cleanly.
 */

import net from "node:net"

export interface BlenderBridgeConfig {
  host?: string
  port?: number
  timeoutMs?: number
}

export interface BlenderResponse<T = unknown> {
  status: "success" | "error"
  result?: T
  message?: string
}

export function resolveBlenderEndpoint(cfg?: BlenderBridgeConfig): { host: string; port: number } {
  const host = (cfg?.host?.trim() || process.env.BLENDER_HOST?.trim() || "127.0.0.1")
  const envPort = Number(process.env.BLENDER_PORT)
  const port = Number.isInteger(cfg?.port) && (cfg!.port as number) > 0
    ? (cfg!.port as number)
    : Number.isInteger(envPort) && envPort > 0
      ? envPort
      : 9876
  return { host, port }
}

/**
 * Send one command to the running `blender_mcp.py` socket server and parse its JSON response.
 */
export function sendBlenderCommand<T = unknown>(
  type: string,
  params: Record<string, unknown> = {},
  cfg?: BlenderBridgeConfig
): Promise<T> {
  const { host, port } = resolveBlenderEndpoint(cfg)
  const timeoutMs = cfg?.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 60_000

  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const chunks: Buffer[] = []
    let settled = false

    const finish = (err: Error | null, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      if (err) reject(err)
      else resolve(value as T)
    }

    const timer = setTimeout(() => {
      finish(
        new Error(
          `Blender command "${type}" timed out after ${timeoutMs}ms on ${host}:${port}`
        )
      )
    }, timeoutMs)

    socket.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EACCES") {
        finish(
          new Error(
            `Cannot connect to Blender MCP addon at ${host}:${port} (${code}). ` +
              `Open Blender → press N in 3D Viewport → "MCP for Blender" tab → click Connect / enable auto-start.`
          )
        )
        return
      }
      finish(err instanceof Error ? err : new Error(String(err)))
    })

    socket.on("connect", () => {
      const payload = JSON.stringify({ type, params })
      socket.write(payload, "utf8")
    })

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      const text = Buffer.concat(chunks).toString("utf8").trim()
      if (!text) return
      let parsed: BlenderResponse<T>
      try {
        parsed = JSON.parse(text) as BlenderResponse<T>
      } catch {
        // Incomplete multi-chunk UTF-8/JSON payload; wait for more data
        return
      }
      if (parsed.status === "error") {
        finish(new Error(parsed.message || `Blender returned error for "${type}"`))
        return
      }
      finish(null, parsed.result as T)
    })

    socket.on("close", () => {
      if (!settled) {
        const text = Buffer.concat(chunks).toString("utf8").trim()
        if (!text) {
          finish(new Error(`Blender closed connection on ${host}:${port} before replying to "${type}"`))
          return
        }
        try {
          const parsed = JSON.parse(text) as BlenderResponse<T>
          if (parsed.status === "error") {
            finish(new Error(parsed.message || `Blender returned error for "${type}"`))
          } else {
            finish(null, parsed.result as T)
          }
        } catch {
          finish(new Error(`Invalid JSON from Blender on "${type}": ${text.slice(0, 200)}`))
        }
      }
    })
  })
}
