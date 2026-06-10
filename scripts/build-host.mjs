// Bundle the Electron daemon (main + the two preloads) with esbuild into
// out/host. Everything is bundled to a single CJS file (incl. @opencode-ai/sdk,
// an ESM package) so Electron's CommonJS main can load it without interop pain.
// Only `electron` stays external — the runtime provides it.
import { build } from "esbuild"

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
}

// The SDK (MAIN process) references import.meta.url; give CJS a safe shim.
// MUST NOT be applied to the PRELOADS: they run in Electron's sandbox where
// __filename / require('url') don't exist, so this banner would crash them with
// "__filename is not defined" (preload fails → window.winhost never injected).
const mainOnly = {
  banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  define: { "import.meta.url": "importMetaUrl" },
}

await build({ ...common, ...mainOnly, entryPoints: ["src/host/index.ts"], outfile: "out/host/index.js" })
await build({ ...common, entryPoints: ["src/host/preload/console.ts"], outfile: "out/host/preload/console.js" })
await build({ ...common, entryPoints: ["src/host/preload/spotlight.ts"], outfile: "out/host/preload/spotlight.js" })

console.log("[build-host] daemon + preloads bundled -> out/host/")
