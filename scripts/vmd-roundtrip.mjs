#!/usr/bin/env node
// vmd-roundtrip.mjs — prove the reverse path: MPL → VMD → MPL (what an LLM would "see")
// Usage: node scripts/vmd-roundtrip.mjs
import { readFileSync, writeFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

// 1. The exact MPL the system prompt teaches the LLM to emit (route.ts "wave hand" example)
const mplInput = `@pose wave_start {
    shoulder_r bend backward 30, sway left 20;
    arm_r bend backward 60;
    elbow_r bend forward 90;
    wrist_r sway left 20;
    index_r bend forward 10;
    middle_r bend forward 15;
    ring_r bend forward 20;
    pinky_r bend forward 25;
}

@pose wave_left {
    shoulder_r bend backward 30, sway left 20;
    arm_r bend backward 60;
    elbow_r bend forward 90;
    wrist_r sway left 30;
}

@pose wave_right {
    shoulder_r bend backward 30, sway left 20;
    arm_r bend backward 60;
    elbow_r bend forward 90;
    wrist_r sway right 10;
}

@animation wave {
    0: wave_start;
    0.3: wave_left;
    0.6: wave_right;
    0.9: wave_left;
    1.2: wave_right;
    1.5: wave_left;
    1.8: wave_start;
}

main {
    wave;
}
`

// 2. Init wasm (Node: pass the .wasm bytes explicitly)
const wasmBytes = readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url))
await init(wasmBytes)
const compiler = new WasmMPLCompiler()

// 3. Forward: MPL -> VMD
const vmd = compiler.compile(mplInput)
writeFileSync(new URL("../.tmp-wave.vmd", import.meta.url), vmd)
console.log(`[forward] MPL ${mplInput.length} chars  ->  VMD ${vmd.length} bytes`)
console.log(`[forward] VMD magic: ${JSON.stringify(Buffer.from(vmd.slice(0, 25)).toString("latin1"))}`)

// 4. Reverse: VMD -> MPL  (the representation an LLM could actually read)
const reversed = compiler.reverse_compile("vmd", vmd)
console.log(`[reverse] VMD ${vmd.length} bytes  ->  MPL ${reversed.length} chars\n`)
console.log("=== reverse_compile output (what the LLM would read) ===")
console.log(reversed)
