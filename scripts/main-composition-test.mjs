#!/usr/bin/env node
// main-composition-test.mjs — prove how MPL `main { a; b; }` actually composes: time-offset or collision?
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

const wasmBytes = readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url))
await init(wasmBytes)
const compiler = new WasmMPLCompiler()

// segA: 左臂抬起 (0-1s);  segB: 左臂放下 (0-1s, 本意是接在 segA 之后)
const script = `@pose arm_up {
    arm_l bend backward 90;
}

@pose arm_down {
    arm_l reset;
}

@animation seg_a {
    0: arm_up;
    1: arm_up;
}

@animation seg_b {
    0: arm_down;
    1: arm_down;
}

main {
    seg_a;
    seg_b;
}
`

let vmd
try {
  vmd = compiler.compile(script)
} catch (e) {
  console.log("compile error:", e.message ?? e)
  process.exit(1)
}
console.log(`compiled OK: ${vmd.length} bytes`)

const reversed = compiler.reverse_compile("vmd", vmd)
console.log("--- reversed (what actually ended up in the VMD) ---")
console.log(reversed)
