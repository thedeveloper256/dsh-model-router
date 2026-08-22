#!/usr/bin/env node
/**
 * Build the browser half: bundle src/client.tsx into lib/client.js wrapped in
 * the harness client-module loader envelope.
 *
 * The bundle is CommonJS so the loader's factory `require` can satisfy the
 * externalized specifiers (`react`, `@deepseek-ai/dsh-client-ui-slots`); the
 * wrapper supplies `module`/`exports`, so esbuild's `exports.`/`module.exports`
 * assignments land on the module object the loader reads back.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const result = await build({
  entryPoints: [join(root, "src/client.tsx")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  // Resolved at runtime by the harness client module system, not bundled.
  external: ["@deepseek-ai/dsh-client-ui-slots", "react", "react/jsx-runtime"],
  write: false,
  sourcemap: false,
  logLevel: "info",
});

const output = result.outputFiles[0]?.text;
if (output === undefined) {
  throw new Error("build-client: esbuild produced no output");
}

const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-model-router",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${output}
		return module.exports;
	}
});
`;

// esbuild emits named exports either directly (`exports.apply = apply;`) or
// through its `__export(exports, { apply: () => apply, ... })` helper; accept
// both forms so the guard fails only when `apply` is genuinely not exported.
const exportsApply =
  wrapped.includes("exports.apply = apply") ||
  /apply:\s*\(\)\s*=>\s*apply/.test(wrapped);
if (!exportsApply) {
  throw new Error("build-client: bundle missing exports.apply; refusing to write lib/client.js");
}

mkdirSync(join(root, "lib"), { recursive: true });
writeFileSync(join(root, "lib/client.js"), wrapped);
console.log("client bundle written: lib/client.js");
