// Single-file, dependency-free bundle (the API client is inlined): `node dist/feedbacks.js`, publishable on npm.
import { chmodSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/feedbacks.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  define: { __VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});
chmodSync("dist/feedbacks.js", 0o755);
