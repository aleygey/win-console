import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// Spotlight popup renderer — same shape as the console build, its own out dir.
export default defineConfig({
  root: "src/spotlight-ui",
  base: "./",
  plugins: [solid()],
  build: {
    outDir: "../../out/spotlight",
    emptyOutDir: true,
    target: "chrome120",
  },
  server: {
    port: 5274,
    strictPort: true,
    fs: { allow: ["../.."] },
  },
})
