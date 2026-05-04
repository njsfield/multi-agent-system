/// <reference types="vite/client" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src/ui") },
  },
  build: {
    outDir: "dist/ui",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/chat": "http://localhost:3000",
      "/history": "http://localhost:3000",
      "/mindmap": "http://localhost:3000",
      "/flashcard": "http://localhost:3000",
    },
  },
});
