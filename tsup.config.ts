import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node24",
  platform: "node",
  outDir: "dist",
  outExtension: () => ({ js: ".js" }),
  clean: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  noExternal: [/.*/],
});
