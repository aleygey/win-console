// Build the Obsidian plugin (Vite lib → out/obsidian/main.js + styles.css) and
// drop the manifest next to it. Copy out/obsidian/* into your vault's
// .obsidian/plugins/winhost-console/ to install.
import { build } from "vite"
import { copyFileSync, mkdirSync } from "node:fs"

await build({ configFile: "vite.obsidian.config.ts" })

mkdirSync("out/obsidian", { recursive: true })
copyFileSync("src/obsidian-plugin/manifest.json", "out/obsidian/manifest.json")

console.log("[build-obsidian] built -> out/obsidian/{main.js, styles.css, manifest.json}")
