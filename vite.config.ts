import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const rendererRoot = fileURLToPath(new URL("./src/renderer", import.meta.url));

export default defineConfig({
  root: rendererRoot,
  envDir: projectRoot,
  base: "./",
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
  resolve: { alias: { "@": rendererRoot } },
  plugins: [
    vue(),
    tailwindcss(),
    electron({
      main: { entry: "src/desktop/main.ts", vite: { root: projectRoot } },
      preload: { input: "src/desktop/preload.ts", vite: { root: projectRoot } },
    }),
  ],
});
