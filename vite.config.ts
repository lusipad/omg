import devServer from "@hono/vite-dev-server"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { localServoPlugin } from "./dev/servo-local-plugin"

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    localServoPlugin(mode === "servo" || loadEnv(mode, __dirname, "TWIN_LOCAL_CODEX").TWIN_LOCAL_CODEX === "1"),
    {
      name: "kimi-preview-host",
      config(config) {
        const hosts = config.server?.allowedHosts;
        if (hosts === true || hosts?.includes("3000.proxy.internal")) return;
        return { server: { allowedHosts: ["3000.proxy.internal"] } };
      },
    },
    devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/).*$/] }),
    inspectAttr(), react()],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      "db": path.resolve(__dirname, "./db"),
    },
  },
  envDir: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
  },
}));
