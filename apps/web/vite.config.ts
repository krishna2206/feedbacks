import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.API_PORT ?? "5302";
const zeroPort = process.env.ZERO_PORT ?? "4848";

// Dev: same-origin setup identical to production — /api → API, /sync → zero-cache.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5301),
    strictPort: true,
    proxy: {
      "/api": { target: `http://localhost:${apiPort}`, changeOrigin: false },
      "/sync": { target: `http://localhost:${zeroPort}`, ws: true, changeOrigin: false },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
