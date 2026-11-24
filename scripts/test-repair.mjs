#!/usr/bin/env node
// test-repair.mjs — FK 自愈回路验证：段落定位 / 骨架序列化往返 / 服务端编译器 / 端到端定位
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

import { parsePmxBones, serializePmxBones, deserializePmxBones } from "../src/lib/pmx-bones.ts"
import { measureModelGeometry } from "../src/lib/model-geometry.ts"
import { findOffendingSegments } from "../src/lib/long-motion.ts"
import { analyzeGroundContactKeys, readVmdBoneKeys } from "../src/lib/fk.ts"
import { compileMPL2 } from "../src/lib/mpl2.ts"
import { getServerCompiler } from "../src/lib/server-compile.ts"

const bones = parsePmxBones(new Uint8Array(readFileSync(new URL("../public/models/topaz/topaz.pmx", import.meta.url))))

let passed = 0
const test = async (name, fn) => {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`)
    process.exitCode = 1
  }
}

await test("骨架序列化往返（客户端 → 服务端）", () => {
  const round = deserializePmxBones(JSON.parse(JSON.stringify(serializePmxBones(bones))))
  assert.ok(round, "deserialize failed")
  const m1 = measureModelGeometry(bones)
  const m2 = measureModelGeometry(round)
  assert.deepEqual(m2, m1)
})
await test("畸形输入返回 null", () => {
  assert.equal(deserializePmxBones(null), null)
  assert.equal(deserializePmxBones({ bones: [] }), null)
  assert.equal(deserializePmxBones({ bones: [{ jp: "x" }] }), null) // 缺 pos
})
await test("穿地段落定位：两段穿地帧分别归位到正确段", () => {
  const timeline = [
    { index: 0, start: 0, end: 1.5 },
    { index: 1, start: 1.75, end: 3.0 },
    { index: 2, start: 3.25, end: 5.0 },
  ]
  const frames = [
    { frame: 15, centerY: null },  // t=0.5 段0（centerY null 应忽略）
    { frame: 30, centerY: -2.5 },  // t=1.0 段0
    { frame: 60, centerY: 1.2 },   // t=2.0 段1（不穿地）
    { frame: 120, centerY: -1.0 }, // t=4.0 段2
  ]
  const offending = findOffendingSegments(frames, timeline)
  assert.deepEqual(offending.map((o) => o.index), [0, 2])
  assert.equal(offending[0].lowestY, -2.5)
  assert.equal(offending[1].times[0], 4)
})
await test("阈值语义：centerY=0 不算穿地", () => {
  const frames = [{ frame: 0, centerY: 0 }]
  assert.equal(findOffendingSegments(frames, [{ index: 0, start: 0, end: 1 }]).length, 0)
})
await test("getServerCompiler 在 Node 可用并可编译", async () => {
  const c = await getServerCompiler()
  assert.ok(c, "server compiler unavailable")
  const bytes = c.compile("@pose a {\n    head reset;\n}\n@animation x {\n    0: a;\n}\nmain {\n    x;\n}\n")
  assert.ok(bytes.length > 0)
})
await test("服务端 compileMPL2 全管道（含 face 剥离 + morph 注入）", async () => {
  const c = await getServerCompiler()
  assert.ok(c)
  const seg = `@pose s {
    face にこり 0.5;
    head bend forward 10;
}

@animation a {
    1: s;
}

main {
    a;
}
`
  const { vmd, morphCount } = compileMPL2(c, seg)
  assert.ok(vmd.length > 0)
  assert.equal(morphCount, 1)
})
await test("端到端：旧蟹式（move down 6）穿地被定位为段 0 责任", async () => {
  const c = await getServerCompiler()
  assert.ok(c)
  const crabOld = `@pose crab_base {
    base bend backward 90;
    center move down 6, bend backward 10;
    neck bend forward 20;
    head bend forward 10;
    leg_l bend forward 70, sway left 25;
    leg_r bend forward 70, sway right 25;
    knee_l bend backward 130;
    knee_r bend backward 130;
}

@animation crab {
    0.8: crab_base;
    1.6: crab_base;
}

main {
    crab;
}
`
  const { vmd } = compileMPL2(c, crabOld)
  const keys = readVmdBoneKeys(vmd)
  assert.ok(keys && keys.length > 0)
  const report = analyzeGroundContactKeys(bones, keys)
  assert.ok(report && report.penetrationFrames > 0, "old crab must penetrate")
  const timeline = [{ index: 0, start: 0, end: 1.6 }]
  const offending = findOffendingSegments(report.frames, timeline)
  assert.equal(offending.length, 1)
  assert.equal(offending[0].index, 0)
  assert.ok(offending[0].lowestY < -3, `lowest waist ${offending[0].lowestY}`)
})

console.log(`\n${passed} tests passed${process.exitCode ? " (WITH FAILURES)" : ""}`)
