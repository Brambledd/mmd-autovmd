#!/usr/bin/env node
// test-p0-fixes.mjs — P0 修复回归：face 条件化解除禁令 / 编译期自愈触发条件 / idle 眨眼通道
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { buildModelConditioning } from "../src/lib/model-conditioning.ts"
import { compileMPL2 } from "../src/lib/mpl2.ts"
import { buildIdleVmd } from "../src/lib/idle-motion.ts"
import { parseMorphFrames } from "../src/lib/vmd-morph.ts"

await init(readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url)))
const compiler = new WasmMPLCompiler()

let pass = 0
let fail = 0
const t = (name, fn) => {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (e) {
    fail++
    console.error(`FAIL  ${name}\n      ${e.message}`)
  }
}

// ---- 1) conditioning：face 解禁（禁令必须消失），语法模板 + 真实 morph 名在列
const pmx = parsePmxBones(readFileSync(new URL("../public/models/topaz/topaz.pmx", import.meta.url)))
const cond = buildModelConditioning(pmx)
t("conditioning: face 白名单语法说明存在", () => {
  assert(cond.text.includes("You MAY add expression lines"), "缺 face 语法说明")
  assert(cond.text.includes("face <morph_name> <weight 0-1>;"), "缺语法模板")
  assert(!cond.text.includes("do not emit face commands"), "face 禁令仍在")
})
t("conditioning: morph 名与 PMX 一致（にこり 在列）", () => {
  assert.ok(pmx.faceMorphs.includes("にこり"), "PMX 里没有 にこり")
  assert(cond.text.includes("にこり"), "conditioning 未列出 にこり")
})

// ---- 2) 编译期自愈触发条件（route.validateFragment 的机制）
const good = `@pose a {
    head turn right 30;
}

@animation seg {
    0: a;
    1: a;
}
`
const badDangling = `@pose a {
    head turn right 30;
}

@animation seg {
    0: a;
    1: missing_pose;
}
`
const badBone = `@pose a {
    no_such_bone turn right 30;
}

@animation seg {
    0: a;
}
`
t("自愈机制: 合法片段编译出 VMD", () => {
  const r = compileMPL2(compiler, good)
  assert(r.vmd.length > 0, `vmd=${r.vmd.length}`)
})
t("自愈机制: 悬空姿势引用 → 抛错或 0 字节（触发重试）", () => {
  let caught = false
  try {
    const r = compileMPL2(compiler, badDangling)
    caught = r.vmd.length === 0
  } catch {
    caught = true
  }
  assert(caught, "悬空姿势引用既没抛错也没返回 0 字节——重试回路不会触发")
})
t("自愈机制: 未知骨骼 → 抛错或 0 字节（触发重试）", () => {
  let caught = false
  try {
    const r = compileMPL2(compiler, badBone)
    caught = r.vmd.length === 0
  } catch {
    caught = true
  }
  assert(caught, "未知骨骼既没抛错也没返回 0 字节——重试回路对这类错误不触发（需 conditioning 兜底）")
})

// ---- 3) idle 眨眼通道：morph 帧存在、名字正确、可读回、可关闭
t("idle: 眨眼 morph 帧注入（默认开启）", () => {
  const { vmd, morphs } = buildIdleVmd()
  assert(morphs > 0, `morphs=${morphs}`)
  const keys = parseMorphFrames(vmd)
  assert(keys && keys.length === morphs, `readback=${keys?.length} != ${morphs}`)
  assert(keys.every((k) => k.name === "まばたき"), `morph 名异常: ${keys.map((k) => k.name).join(",")}`)
  assert(keys.some((k) => k.weight === 1) && keys.some((k) => k.weight === 0), "缺少闭合/睁开帧")
})
t("idle: blink=false 关闭通道", () => {
  const { morphs } = buildIdleVmd({ blink: false })
  assert.equal(morphs, 0)
})
t("idle: 眨眼帧全部落在循环内（无缝循环）", () => {
  const { vmd, seconds } = buildIdleVmd()
  const keys = parseMorphFrames(vmd)
  const maxFrame = Math.round(seconds * 30)
  assert(keys.every((k) => k.frame <= maxFrame), "眨眼帧越过循环末帧")
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
