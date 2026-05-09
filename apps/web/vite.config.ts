import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  const apiPort = env.POPCORN_QUEUE_PORT || "3500";
  const webPort = Number(env.POPCORN_QUEUE_WEB_PORT || "5173");

  return {
    envDir: "../..",
    define: {
      "import.meta.env.VITE_POPCORN_QUEUE_API_PORT": JSON.stringify(apiPort)
    },
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: Number.isFinite(webPort) ? webPort : 5173
    }
  };
});
