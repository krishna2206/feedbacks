// Production bundle: a self-contained dist/ (all dependencies inlined), so the Docker image
// needs no node_modules. Native/optional modules stay external.
import { cpSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: { index: "src/index.ts", migrate: "src/migrate.ts", "reset-password": "scripts/reset-password.ts", seed: "scripts/seed.ts" },
  outdir: "dist",
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  minify: true,
  logLevel: "info",
  external: ["pg-native"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
cpSync("../../packages/schema/migrations", "dist/migrations", { recursive: true });
