import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// Console renderer. base:"./" is required — Electron loads index.html via
// file://, so assets must use relative paths. It imports ../panels (the shared
// SolidJS panels), so the dev server is allowed to read one dir up.
export default defineConfig({
  root: "src/console-ui",
  base: "./",
  plugins: [solid()],
  build: {
    outDir: "../../out/console",
    emptyOutDir: true,
    target: "chrome120",
  },
  server: {
    port: 5273,
    strictPort: true,
    fs: { allow: ["../.."] },
  },
})
