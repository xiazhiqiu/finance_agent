import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 4174,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
