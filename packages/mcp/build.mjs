// stdio server bundle: `node dist/stdio.js` (npx feedbacks-mcp). The API client is inlined;
// the MCP SDK and zod stay regular dependencies.
import { chmodSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
await build({
  entryPoints: ["src/stdio.ts"],
  outfile: "dist/stdio.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  alias: { "@feedbacks/client": "../client/src/index.ts" },
  banner: { js: "#!/usr/bin/env node" },
  define: { __VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});
chmodSync("dist/stdio.js", 0o755);
