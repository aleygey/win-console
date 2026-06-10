import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { resolve } from "node:path"

// Obsidian plugin build. Uses Vite (not bare esbuild) because the panels are
// SolidJS — they need Solid's compiler transform, which vite-plugin-solid does.
// Output is a single CommonJS main.js with `obsidian`/`electron` external, the
// shape Obsidian loads. CSS imported across the graph is emitted as one asset;
// the build script renames it to styles.css next to main.js.
export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: "out/obsidian",
    emptyOutDir: true,
    target: "chrome120",
    lib: {
      entry: resolve(__dirname, "src/obsidian-plugin/main.ts"),
      formats: ["cjs"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      external: ["obsidian", "electron"],
      output: {
        exports: "default",
        assetFileNames: "styles.css",
      },
    },
  },
})
