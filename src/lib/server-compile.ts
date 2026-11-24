/**
 * server-compile.ts — 服务端 wasm 编译器单例（FK 自愈回路用）。
 *
 * 为什么服务端要编译：pose-generate-long 的自愈回路需要在返回前对拼接结果
 * 做 compileMPL2 → analyzeGroundContact，检查穿地并定向重生成。
 *
 * wasm 加载策略（按顺序尝试，全部失败返回 null → 调用方优雅跳过检查）：
 *  1. import.meta.url 同目录（next.config serverExternalPackages 保持
 *     mmd-mpl 为真实 node_modules 文件时成立）
 *  2. process.cwd()/node_modules/mmd-mpl/mmd_mpl_bg.wasm
 *
 * Node fetch 不支持 file:// URL，所以必须读字节显式传给 init()。
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import type { WasmMPLCompiler } from "mmd-mpl"

let compilerPromise: Promise<WasmMPLCompiler | null> | null = null

async function loadCompiler(): Promise<WasmMPLCompiler | null> {
  const candidates: string[] = []
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    candidates.push(join(here, "mmd_mpl_bg.wasm"))
    candidates.push(join(here, "..", "..", "node_modules", "mmd-mpl", "mmd_mpl_bg.wasm"))
  } catch { /* import.meta.url 不可用 */ }
  if (process.env.POPO_ROOT?.trim()) {
    candidates.push(join(process.env.POPO_ROOT.trim(), "node_modules", "mmd-mpl", "mmd_mpl_bg.wasm"))
  }
  try {
    candidates.push(join(process.cwd(), "node_modules", "mmd-mpl", "mmd_mpl_bg.wasm"))
  } catch { /* cwd 不可用 */ }

  for (const path of candidates) {
    try {
      const bytes = readFileSync(path)
      const mod = await import("mmd-mpl")
      await mod.default(bytes)
      return new mod.WasmMPLCompiler()
    } catch {
      // 下一个候选
    }
  }
  return null
}

/** 惰性获取服务端编译器；环境不支持时 resolve null（调用方跳过 FK 检查）。 */
export function getServerCompiler(): Promise<WasmMPLCompiler | null> {
  if (!compilerPromise) compilerPromise = loadCompiler()
  return compilerPromise
}
