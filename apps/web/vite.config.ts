import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves the site under /turing-pit/.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/turing-pit/",
  plugins: [react()],
  define: { global: "globalThis" },
  resolve: { alias: { buffer: "buffer/" } },
});
