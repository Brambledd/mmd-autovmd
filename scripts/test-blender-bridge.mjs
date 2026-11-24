import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")

// Tiny valid 1x1 PNG bytes for viewport capture mock
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
)

let okCount = 0
const pass = (label) => {
  okCount++
  console.log(`  ok  ${label}`)
}

// Start a local mock TCP server speaking the blender_mcp.py socket protocol
// (not touching any real running Blender instance).
const receivedCmds = []
const mockBlender = net.createServer((socket) => {
  let buf = ""
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8")
    let cmd
    try {
      cmd = JSON.parse(buf)
      buf = ""
    } catch {
      return
    }
    receivedCmds.push(cmd)

    let reply
    if (cmd.type === "get_addon_info") {
      reply = {
        status: "success",
        result: { name: "MCP for Blender", protocol_version: 16, blender_version: "4.3.2" },
      }
    } else if (cmd.type === "get_scene_info") {
      reply = {
        status: "success",
        result: { name: "Scene", object_count: 2, objects: [{ name: "ROOT_A", type: "EMPTY", location: [-0.4, 0, 0] }] },
      }
    } else if (cmd.type === "execute_code") {
      if (String(cmd.params?.code).includes("RAISE_ERR")) {
        reply = { status: "error", message: '{"exception_type":"RuntimeError","message":"mock failure"}' }
      } else {
        reply = { status: "success", result: { executed: true, result: "hello from blender mock\n" } }
      }
    } else if (cmd.type === "get_viewport_screenshot") {
      fs.mkdirSync(path.dirname(cmd.params.filepath), { recursive: true })
      fs.writeFileSync(cmd.params.filepath, TINY_PNG)
      reply = {
        status: "success",
        result: { success: true, method: "offscreen", width: 800, height: 600 },
      }
    } else {
      reply = { status: "error", message: `Unknown cmd: ${cmd.type}` }
    }

    // Intentionally split response into two TCP chunks without closing socket,
    // matching blender_mcp.py's client.sendall() behavior.
    const json = JSON.stringify(reply)
    const mid = Math.floor(json.length / 2)
    socket.write(json.slice(0, mid))
    setTimeout(() => socket.write(json.slice(mid)), 15)
  })
})

await new Promise((resolve) => mockBlender.listen(0, "127.0.0.1", resolve))
const mockPort = mockBlender.address().port

const child = spawn(process.execPath, [path.join(root, "src/mcp/popo-mcp-server.ts")], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
})

let stdoutBuf = ""
const pending = new Map()
let nextId = 1

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8")
  let idx
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim()
    stdoutBuf = stdoutBuf.slice(idx + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    const resolver = pending.get(msg.id)
    if (resolver) {
      pending.delete(msg.id)
      resolver(msg)
    }
  }
})

function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`RPC timeout for ${method}`))
    }, 10000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.error) reject(new Error(`${method} error: ${JSON.stringify(msg.error)}`))
      else resolve(msg.result)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  })
}

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} })

  // 1. get_blender_scene_info (chunked response without EOF)
  const sceneRes = await rpc("tools/call", {
    name: "get_blender_scene_info",
    arguments: { host: "127.0.0.1", port: mockPort },
  })
  const sceneJson = JSON.parse(sceneRes.content[0].text)
  assert.equal(sceneJson.ok, true)
  assert.equal(sceneJson.addonInfo.protocol_version, 16)
  assert.equal(sceneJson.sceneInfo.object_count, 2)
  pass("get_blender_scene_info (chunked no-EOF JSON response)")

  // 2. execute_blender_code success
  const execRes = await rpc("tools/call", {
    name: "execute_blender_code",
    arguments: { code: "print('hello')", host: "127.0.0.1", port: mockPort },
  })
  const execJson = JSON.parse(execRes.content[0].text)
  assert.equal(execJson.ok, true)
  assert.equal(execJson.executed, true)
  assert.match(execJson.result, /hello from blender mock/)
  pass("execute_blender_code (bpy stdout capture)")

  // 3. execute_blender_code error propagation
  const errRes = await rpc("tools/call", {
    name: "execute_blender_code",
    arguments: { code: "RAISE_ERR", host: "127.0.0.1", port: mockPort },
  })
  assert.equal(errRes.isError, true)
  assert.match(errRes.content[0].text, /mock failure/)
  pass("execute_blender_code error propagation")

  // 4. get_blender_viewport returns inline PNG + metadata + cleans up ephemeral file
  const vpRes = await rpc("tools/call", {
    name: "get_blender_viewport",
    arguments: { maxSize: 800, host: "127.0.0.1", port: mockPort },
  })
  const img = vpRes.content.find((c) => c.type === "image")
  assert(img && img.mimeType === "image/png")
  assert.equal(Buffer.from(img.data, "base64").subarray(0, 4).toString("hex"), "89504e47")
  const vpJson = JSON.parse(vpRes.content.find((c) => c.type === "text").text)
  assert.equal(vpJson.ok, true)
  assert.equal(vpJson.filepath, "(ephemeral)")
  const vpCmd = receivedCmds.find((c) => c.type === "get_viewport_screenshot")
  assert.equal(fs.existsSync(vpCmd.params.filepath), false, "ephemeral screenshot should be deleted after reading")
  pass("get_blender_viewport (PNG image block + temp cleanup)")

  // 5. Connection refused on unused port gives clear diagnostic hint
  const deadServer = net.createServer()
  await new Promise((r) => deadServer.listen(0, "127.0.0.1", r))
  const deadPort = deadServer.address().port
  await new Promise((r) => deadServer.close(r))
  const refusedRes = await rpc("tools/call", {
    name: "get_blender_scene_info",
    arguments: { host: "127.0.0.1", port: deadPort },
  })
  assert.equal(refusedRes.isError, true)
  assert.match(refusedRes.content[0].text, /MCP for Blender/)
  pass("helpful error when Blender MCP socket is unreachable")

  console.log(`\nALL ${okCount} BLENDER BRIDGE CHECKS PASSED`)
} finally {
  child.kill()
  mockBlender.close()
}
