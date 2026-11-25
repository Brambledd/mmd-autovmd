import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const rootDir = process.cwd()
const pluginDst = path.join(os.homedir(), ".gemini", "config", "plugins", "popo-mmd")

const pairs = [
  [
    path.join(rootDir, ".agents", "skills", "popo-blender-mmd", "SKILL.md"),
    path.join(pluginDst, "skills", "popo-blender-mmd", "SKILL.md"),
  ],
  [
    path.join(rootDir, "antigravity-plugin", "popo-mmd", "plugin.json"),
    path.join(pluginDst, "plugin.json"),
  ],
]

for (const [src, dst] of pairs) {
  if (!fs.existsSync(src)) {
    console.warn(`Skipped missing source: ${src}`)
    continue
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  console.log(`Synced: ${path.relative(rootDir, src)} -> ${dst}`)
}
