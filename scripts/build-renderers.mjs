// Build the two Electron-side renderers (console + spotlight) with Vite so
// SolidJS gets its proper compiler transform. Outputs out/console and
// out/spotlight, each a relative-path bundle Electron loads over file://.
import { build } from "vite"

await build({ configFile: "vite.console.config.ts" })
await build({ configFile: "vite.spotlight.config.ts" })

console.log("[build-renderers] console + spotlight built -> out/")
