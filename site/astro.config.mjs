import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";

export default defineConfig({
  integrations: [mdx(), react()],
  vite: {
    optimizeDeps: {
      exclude: ['@duckdb/duckdb-wasm', '@mediapipe/tasks-genai'],
      // apache-arrow is only reached via the dynamic import of ./duckdb, so
      // Vite's static scan misses it. Pre-bundle it explicitly so the dep URL
      // is stable when the agent's tool wrappers eventually fire.
      include: ['apache-arrow'],
    },
  },
});
