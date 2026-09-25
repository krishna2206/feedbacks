/**
 * Query plans of the Zero queries against a running zero-cache (see docs/ARCHITECTURE.md):
 *   pnpm analyze-query --cookie="<session cookie>" --query-name=messages.byChannel --query-args='[{...}]'
 * Look for "TEMP B-TREE" or large "rows scanned" counts: they mean a missing Postgres index.
 */
import { schema } from "@feedbacks/schema/zero";
import { runAnalyzeCLI } from "@rocicorp/zero/analyze";

await runAnalyzeCLI({ schema });
