# dsh-model-router: review and implementation plan

Review date 2026-11-08. HEAD `34b3d92` (v0.7.0) on `main`, with 4 untracked T14 files. The only file I wrote in the repo is this one. Tests, typecheck and build ran on a scratch copy at
`C:\Users\Shayan\AppData\Local\Temp\claude\ff8fdf913b3be5ba\a2290f5e-45b1-403f-b999-1fafee8f6050\scratchpad\repo`, and the doc snapshots I fetched are in the `...\scratchpad\docs` folder next to it.

## Doc sources used

| Topic | Source | How I got it |
|---|---|---|
| DeepSeek models, vision, limits | Context7 `/websites/api-docs_deepseek` (Anthropic API "image block" text), plus the official pages https://api-docs.deepseek.com/quick_start/pricing/ , https://api-docs.deepseek.com/updates , https://api-docs.deepseek.com/news/news260910 | Context7 had no pricing table, so I read the official pages for it |
| Harness events, `agent/request` deprecation, `agent.model` | Context7 `/deepseek-ai/deepseek-harness`, plus raw GitHub `docs/subsystems/core.md`, `packages/core/agent/README.md`, `docs/upgrade-guide/v0.2.1-alpha.4/session-model-selection/guide.md` | Context7 only had event summaries. The exact signatures and the deprecation are in the GitHub files |
| Harness bundle patch semantics | Context7 `/deepseek-ai/deepseek-harness` ("Override a shipped preset by Loader row id") | Context7 |
| Harness settings redesign | raw GitHub `packages/settings/settings/README.md` | official repo |
| Harness plugin compatibility (`engines.dsh`), model listing, subagent reasoning | raw GitHub `docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh`, `v0.2.1-alpha.1/deepseek-model-discovery`, `v0.2.1-rc.4/model-listing-refresh`, `v0.2.2-alpha.2/subagent-explicit-reasoning` | official repo |
| Installed types (what the project actually compiles against) | `node_modules/@deepseek-ai/dsh-agent@0.1.0-rc.8/lib/types/runtime-types.d.ts`, `dsh-settings@0.1.0-rc.8/lib/types/index.d.ts` | npm ci in the scratch copy |
| Vitest | Context7 `/vitest-dev/vitest` (`vi.mock(import(...), importOriginal)`); `npm view vitest` gives 5.1.0, which needs Node `^22.12 \|\| ^24 \|\| >=26` | Context7 + npm |
| tsup | Context7 `/egoist/tsup` (v8.5.1); `npm view tsup` gives 9.0.0 | Context7 + npm |
| Local harness | `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe` ProductVersion **0.2.1.0**, runtime Node 24.21.0 (`resources/runtime/versions.json`) | read-only local check. `~/.dsh/profiles/desktop` does **not** have this plugin installed |

The Schemastery behavior was tested directly with probes in the scratch copy, so I did not need its docs. OpenCode is not a project dependency. It only appears in the "worker" column of the plan.

---

# Part 1: Review

## 1. Project overview

dsh-model-router is a DeepSeek Harness (DSH) Cordis plugin. It sends different agent roles to different models:

- **Planner** is the root agent of a session.
- **Executor** is any delegated subagent (`options.subagentDepth >= 1` or `session.header.origin === "subagent"`).
- **Vision** is opt-in. It applies to any request from a session whose log contains an image.
- It can also pin a reasoning effort per role, cap `maxTokens`, and raise effort after a failed tool step ("escalation").
- It publishes a prompt section and the `pro-flash-routing` skill, plus a browser settings card with live `enabled` and `vision.enabled` switches.
- Since v0.7.0 every role defaults to `deepseek-official` / `deepseek-flash`.

### Architecture

| File | Role |
|---|---|
| `src/policy.ts` | Pure policy with no Cordis imports: `roleFor` (L95-105), `routeFor` (L115-126), `recentStepsHadError` (L141-164), `effortFor` (L178-186), `sessionHasImage` (L233-250), `shouldUseVision` (L264-270), deprecated `hasImageContent` (L201-209). |
| `src/index.ts` | Cordis `Service` `ModelRouter`. Schemastery `Config` (L33-73). On `agent/created` it registers a per-agent `agent/request` waterfall listener with `prepend: true` (L224-271) that calls `next()` and then overwrites `provider`/`model`/`maxTokens`/`reasoningEffort`. It wires the live settings source through `installSettingsSection` (L276-287). `render()` (L296-329) registers or unregisters the prompt section and the skill. `SKILL_CONTENT` is a hardcoded string (L112-140). |
| `src/client.tsx` | Browser half: the "Model router" card on the `settings.plugin.item` slot, bound to the `model-router` settings scope (L452-476). |
| `cordis.patch.yml` | Bundle layer. Inserts the `model-router` row, overrides the `llm-deepseek` row (model catalog with `inputModalities`) and the `attachment-local` row (image limits). |
| `skills/pro-flash-routing/SKILL.md` | Static copy of the skill text. Nothing loads it at runtime; the runtime registers `SKILL_CONTENT`. |
| `scripts/build-client.mjs` | Bundles the client with esbuild, wraps it in the `__ModuleLoader__` envelope, and guards that `apply` is exported. |
| `scripts/publish.sh` | One-time bootstrap: creates the GitHub repo, tags v0.1.0, publishes to npm. |
| `test/policy.test.ts`, `test/vision.test.ts` | Unit tests for the policy and the Config defaults. |
| `.github/workflows/ci.yml` | typecheck, test, build on Node 22. **Not tracked** (see F7). |

Current state, measured on the scratch copy: `tsc --noEmit` passes. `vitest run` gives **42 passed, 3 failed**; all three failures are in the untracked `test/router.test.ts`. `npm run build` passes.

Git history runs from v0.1.0 to v0.7.0 over 2026-08 to 09-10. Each release follows the same pattern of a feature, a review-fix point release, and a laptop/desktop "sync" commit. The direction is a role split that is kept in config even though both roles currently use the same model, so the planner can be flipped back to a Pro model later.

## 2. Findings, ranked by severity

### Critical

**F1. On the harness you have installed (0.2.1), the routing mechanism probably does nothing.**
`src/index.ts:230-266` changes `provider`, `model` and `reasoningEffort` inside an `agent/request` waterfall. The harness docs say:

- `packages/core/agent/README.md`: "`agent/request` is deprecated … Do not add new listeners. Provider, model, and optional explicit reasoning effort are fixed at step preparation; listeners must preserve all three."
- Migration guide `v0.2.1-alpha.4/session-model-selection`: existing listeners "cannot change provider or model, or add, change, or clear reasoning effort". The replacement API is `agent.model.select({ provider, model, reasoningEffort? })`, and the output cap moves to `AgentOptions.maxTokens`.

Your installed desktop app is 0.2.1.0, which is later than 0.2.1-alpha.4. DeepSeek's 2026-10-17 changelog also tells users to run "DeepSeek Harness 0.2.1-rc.1 or later" with V4.1-Flash-1017.

If this holds, planner/executor routing, vision routing, effort pins and escalation are all silent no-ops on current harnesses. `maxTokens` may still apply, because "Existing listeners … can adjust other controls". The project only builds against `0.1.0-rc.8` types (`package.json:47-57`), so nothing in CI would catch this.

The README's production numbers (README:208-213) date from the v4-era split. While both roles use `deepseek-flash`, the problem is invisible, because the session's own model is already `deepseek-flash`.

This is unverified on a live 0.2.1 host; the docs make it very likely. See plan step B1.

**F2. The `agent/disposed` handler compares the wrong shape, so it never fires and leaks one host listener per agent.**
`src/index.ts:268-270`:
```ts
this.harness.on("agent/disposed", (disposed) => {
  if (disposed === agent) dispose();
});
```
The installed `dsh-agent@0.1.0-rc.8` types (`runtime-types.d.ts:157`) and harness master (`docs/subsystems/core.md:914`) both declare `'agent/disposed'(this: Scoped<Agent>, payload: { agent: Agent }): void`. The listener receives `{ agent }`, so `disposed === agent` is always false.

Effects:
- The explicit `agent/request` disposer never runs. Cleanup of the agent scope may still remove that listener, but nothing in this code makes sure of it.
- A new root-context `agent/disposed` listener is added for **every agent ever created** and never removed. Each one holds a closure over its `agent`, so the process grows linearly in listeners and in retained agent objects. Subagents, workflow workers and ralph rounds make this a lot of agents.
- `HarnessContext` (`src/index.ts:170`) types the listener as `(agent: unknown) => void`, which hides the problem.

The T14 test reproduces the wrong shape: `test/router.test.ts:77-83` calls `onDisposed(a.agent)` with a bare agent. It needs to be fixed together with the code.

### High

**F3. A partial route config drops `provider`/`model` and sends `undefined` into the request.**
`ModelRouteSchema` (`src/index.ts:33-41`) has no defaults for `provider` or `model`, and the object-level `.default({...})` (L60-67) only applies when the whole key is missing. Probes:
- `Config({ planner: { model: "deepseek-v4-pro" } }).planner` gives `{"model":"deepseek-v4-pro"}`.
- `Config({ planner: { reasoningEffort: "high" } }).planner` gives `{"reasoningEffort":"high"}`.

`routeFor` returns that object, and L256-260 writes `provider: undefined` (and `model: undefined`) over the resolved request. This is exactly the "one-line change" that README:8 and CHANGELOG-T14:10-11 recommend (point the planner at `deepseek-v4-pro`). The settings card can also persist partial objects. T14 mentions "partial-route omit-to-inherit regression guards", but no code or tests for them exist.

**F4. The T14 patch wrongly marks `deepseek-v4-pro` as image-capable.**
`cordis.patch-T14.yml:66-70` adds `inputModalities: [text, image]` to `deepseek-v4-pro`. The official Models & Pricing page lists V4-Pro (DeepSeek-V4-Pro-0813) with **Vision: Not supported**. The Anthropic API image-block docs (Context7) say "`deepseek-v4-pro` does not support image input". With that row, the harness would accept images for a V4-Pro route and the provider would reject them (`UNSUPPORTED_CONTENT`). The `deepseek-v4-flash` alias at L65 is correct, because it routes to V4.1 Flash. CHANGELOG-T14:14-16 and README-T14:136 repeat the wrong claim.

There is a related gap. With the documented "point the planner at v4-pro" change and the default `vision.enabled: false`, any image in a root session goes to a model that cannot read images. Nothing in the docs or code warns about this.

**F5. The README's tuning example uses a patch form the loader ignores.**
README:151-170 (and README-T14) shows `- patch:` / `- id: model-router`, and README:142 says "a `patch:` targeting `llm-deepseek`". The project's own v0.6.1 note (CHANGELOG:54-58) says "the `patch:` wrapper was ignored by the loader". The harness docs (Context7) only show `- insert:` entries and direct id-targeted rows, and say an id-targeted override "replaces the complete config". Users who copy the README get no effect, or with the correct form they replace the whole row, so every field they leave out falls back to its default.

**F6. The README's log-check regex drops every v4-era model id.**
README:197-206 uses `grep -o '"model":"deepseek-[a-z-]*"'` and says it keeps "legacy `deepseek-v4-flash-vision-exp` intact". `[a-z-]` does not match the digit `4`, and the pattern needs a closing `"`, so `deepseek-v4-pro`, `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` never match. Only `deepseek-flash` gets counted. This would have hidden the very split the section is meant to verify. The fix is `[a-z0-9.-]*`.

### Medium

**F7. CI never runs.** `.gitignore:6` ignores `.github/workflows/`, and `git check-ignore` confirms `ci.yml` is excluded. The workflow exists only on this disk.

**F8. Peer ranges exclude every 0.2.x harness.** `package.json:47-52` uses `^0.1.0-rc.8`. For a 0.x prerelease that means `<0.2.0`, but harness packages are now at `0.2.2-rc.1` (`next`) and you run 0.2.1. Since v0.2.1-alpha.3 the harness checks `engines.dsh` first and falls back to DSH peers (`plugin-engines-dsh` guide), so installs may be refused or get duplicate peer copies.

The npm dist-tags are also odd: `latest` points at old `0.0.1-rc.1` / `0.1.0-rc.6` builds, so a careless `npm i` pulls old versions.

**F9. The settings/GUI mechanism is outdated on harness master.** `packages/settings/settings/README.md` (master) says Settings now edits Config fields marked `.volatile()`, stores changes in the profile's Cordis patch, and imports any legacy `settings.yaml` **once** before renaming it `settings.yaml.imported`. The router depends on `installSettingsSection` / `settingsNamespace` (`src/index.ts:26,76,276`) and documents `settings.yaml` under `model-router:` (README:64,96-97). Whether 0.2.1 still exports `installSettingsSection` is unverified, but it is a likely break.

**F10. The skill and prompt text are hardcoded and disagree with the config.**
- `SKILL_CONTENT` (`src/index.ts:112-140`) always says `deepseek-flash`, even when the routes are reconfigured. T14 claims a `buildSkillContent` that doesn't exist, which is why `router.test.ts:86-95` fails.
- `SKILL_DESCRIPTION` (L107-108) and the client copy `modePlan` (`src/client.tsx:46`) still say "pro"/"flash".
- `skills/pro-flash-routing/SKILL.md:34` differs from `index.ts:139` ("produce `deepseek-flash` output" vs "produce `deepseek-flash`"), and nothing checks the two against each other.

**F11. The tests can't tell the roles apart.** `test/policy.test.ts:12-24` gives planner and executor the same provider and model, so every `routeFor` test (L71-118) would still pass if the roles were swapped. The index.ts wiring (stamping, vision-first, `enabled` false passthrough) has **no** tests.

**F12. The vision toggle freezes defaults into the user layer.** `src/client.tsx:202-209` writes `{ ...value.vision, enabled }`, which is the *effective* merged object. That copies `provider`/`model` defaults into the user layer, so a later change to the patch row's vision model is silently shadowed. The safer write is `enabled` alone, if the scope supports field paths.

**F13. The `llm-deepseek` override can wipe adapter config.** The id-targeted row "replaces the complete config" (harness docs), so installing the plugin drops any `reasoningEffort`, `maxTokens`, `apiKeyEnv`, image or file limits, or `modelsMaxAgeMs` that a profile or another layer set on `llm-deepseek`. T14 documents this (`cordis.patch-T14.yml:45-52`). Since v0.2.1-rc.4 the API-key route also lists models from the endpoint automatically (`model-listing-refresh`, `deepseek-model-discovery`), so a static `models` list may now be unnecessary or even work against discovery. That still needs a live check.

### Low

- **F14.** `package.json:4` is still `0.7.0`, but the T14 docs describe 0.7.1. The `src/client.tsx:2` header says "v0.6.0". `scripts/publish.sh:14` REPO_DESC still names v4-pro/v4-flash.
- **F15.** `scripts/build-client.mjs` imports `esbuild`, which is only a transitive dependency of tsup and is not declared in `devDependencies`.
- **F16.** `sessionHasImage` scans the whole log on every request, and vision stays on for the rest of the session (documented). The `historyLimit` follow-up (README:125-127) is not tracked anywhere.
- **F17.** `recentStepsHadError` only counts steps that produced a `tool/result`, so steps without tool calls never count toward wearing off escalation. The README (L174) says "clean steps".
- **F18.** Vitest is pinned at ^2.1.8 while 5.1.0 is current. Context7 now recommends `vi.mock(import('…'), …)` for typed mocks; `router.test.ts:3` uses the string form. Optional.
- **F19.** CI uses Node 22, while the harness runtime is Node 24.21.0 (the harness `node-24` upgrade guide moved to 24).
- **F20.** CHANGELOG-T14:5-11 is right, and confirmed: the official Change Log (2026-09-10) says V4 Pro continues "after September 14, 2026, with the billing method remaining unchanged". However, the news page `news260910` still says "all deepseek-v4-pro requests will route to V4.1-Flash", so DeepSeek's own docs contradict each other. Cite the changelog and pricing page (which lists V4-Pro-0813 at separate Pro prices), not the news post.

## 3. What the T14 files are for, and how complete they are

T14 is a **v0.7.1 patch release**: a docs correction, a listener-leak fix, a catalog fix, skill templating, and more tests.

| Claim (CHANGELOG-T14.md v0.7.1, L3-21) | What exists | Status |
|---|---|---|
| Correct the retirement note: V4-Pro keeps running after Sep 14 | README-T14 L8, L133-135; patch-T14 L40-43 | **Done in the docs.** Accurate per the official changelog (F20) |
| Fix the `agent/disposed` leak with one global listener and a disposer map | `test/router.test.ts:52-84` only; `src/index.ts` unchanged | **Not implemented.** The test also uses the wrong payload shape (F2) |
| Compat aliases `deepseek-v4-flash` / `deepseek-v4-pro` declare `[text, image]` | patch-T14 L65, L70 | **Half wrong.** v4-flash is fine; v4-pro must stay text-only (F4) |
| Patch notes explain that id-targeted rows replace the whole config | patch-T14 L45-52; README-T14 L143-147 | **Done** |
| Skill content templated from routes (`buildSkillContent`, exported) | test `router.test.ts:86-95` only | **Not implemented** |
| Tests use distinct planner/executor model names | — | **Not done** (`policy.test.ts` unchanged) |
| Partial-route omit-to-inherit regression guards | — | **Not done** (and the underlying bug F3 exists) |
| "47 passing" | Measured: 45 tests, 42 pass and 3 fail | 42 existing + 3 router + 2 partial-route = 47, so the count matches the plan, but it was never reached |
| README "Since v0.7.1 the skill text follows your configured routes" (README-T14 L34); restart note 0.7.0 → 0.7.1 (L221) | done in the docs | depends on the unimplemented code |

Not covered by T14 at all: F1 (`agent/request` deprecated), F5, F6, F7, F8, F9, and the V4-Pro vision gap.

The T14 files are copies of the canonical files with a suffix, so they need to be merged into `README.md`, `CHANGELOG.md` and `cordis.patch.yml` and then deleted. `test/router.test.ts` is new and stays.

---

# Part 2: Implementation plan

There are two tracks.
- **Track A** finishes T14 as v0.7.1 and fixes defects that don't depend on the harness version. It can ship against the current `0.1.0-rc.8` target.
- **Track B** makes the router actually work on harness 0.2.1 or later (F1, F8, F9). It needs one live spike first, and your decisions (Part 3).

**Worker key** (from your CLAUDE.md):
- **DS** = DeepSeek via OpenCode (`opencode run --agent build -m "opencode-go/deepseek-v4.1-flash#high" "<task>"`, run from the repo root).
- **S** = Claude sonnet subagent.
- **O** = opus at high effort.

Review every worker diff before relying on it. Send no secrets; this repo has no `.env`, but never pass `DEEPSEEK_API_KEY` or npm/GitHub tokens.

**Standard check (V):** `npm ci && npm run typecheck && npm test && npm run build`.

## Track A: finish T14 (v0.7.1)

### A1. Fix the per-agent dispose fan-out (F2)
- **Goal:** one host `agent/disposed` listener, a correct `{ agent }` payload, no retained agents.
- **Files:** `src/index.ts`, the constructor (L224-271) and `HarnessContext` (L164-183).
- **Change:**
  ```ts
  // HarnessContext
  on(event: "agent/disposed", listener: (payload: { agent: AgentLike } | AgentLike) => void): () => void;

  // module scope
  /** Documented payload is { agent } (dsh-agent runtime-types); accept a bare agent defensively. */
  function disposedAgentOf(payload: unknown): AgentLike | undefined {
    if (payload !== null && typeof payload === "object" && "agent" in payload) {
      return (payload as { agent: AgentLike }).agent;
    }
    return payload as AgentLike | undefined;
  }

  // constructor
  const requestDisposers = new WeakMap<object, () => void>();
  this.harness.on("agent/created", ({ agent }) => {
    const dispose = agent.ctx.on("agent/request", this.requestRewrite(agent), { prepend: true });
    requestDisposers.set(agent, dispose);
  });
  this.harness.on("agent/disposed", (payload) => {
    const agent = disposedAgentOf(payload);
    if (agent === undefined) return;
    const dispose = requestDisposers.get(agent);
    if (dispose === undefined) return;
    requestDisposers.delete(agent);
    dispose();
  });
  ```
  Also pull the listener body (L232-265) out into `private requestRewrite(agent: AgentLike)` so it can be tested (A3 and A4 use it).
- **Tests (`test/router.test.ts`):**
  - Change L82 and L87 to `onDisposed({ agent: a.agent })`.
  - Add one case that passes a bare agent (the defensive path).
  - Add one case that dispose before create, or for an unknown agent, does nothing.
- **Verify:** V. The first two router tests go green.
- **Depends on:** none. **Parallel:** yes with A5-A9. A2 and A3 edit other parts of `src/index.ts`, so run those in sequence, or in parallel only with a careful merge. **Worker:** S or DS, then review.

### A2. Build the skill text from config (F10)
- **Goal:** the registered skill names the configured models.
- **Files:** `src/index.ts` (L105-140, `render` L320-327, exports L332-351).
- **Change:** add `export function buildSkillContent(cfg: Pick<RouterConfig, "planner" | "executor" | "vision">): string`.
  - Header: "This session routes models by role:"
  - Planner bullet uses `cfg.planner.model`; executor bullet and rhythm step 2 use `cfg.executor.model`.
  - Verification line: if the two models are equal, "Both roles produce `X`"; otherwise "Planner requests log `P`; executor requests log `E`".
  - Add a vision sentence only when `cfg.vision.enabled`.
  - Keep `SKILL_CONTENT = buildSkillContent(defaultConfig)` for backward compatibility, where `defaultConfig = resolveConfig({})`.
  - `render()` passes `buildSkillContent(cfg)`.
  - Make `SKILL_DESCRIPTION` model-neutral ("plan on the planner agent, delegate implementation to executor subagents"). Keep `SKILL_NAME` unchanged.
- **Tests:** `router.test.ts:86-95` goes green. Add one case where equal models produce the "Both roles" line.
- **Verify:** V. **Depends on:** none (A8 depends on this). **Parallel:** see A1. **Worker:** DS.

### A3. Fill in missing route fields from defaults (F3)
- **Goal:** `planner: { model: deepseek-v4-pro }` keeps `provider: deepseek-official`.
- **Files:** `src/index.ts` L33-41, L59-67.
- **Change:**
  ```ts
  const ModelRouteSchema = z.object({
    provider: z.string().min(1).default("deepseek-official"),
    model: z.string().min(1).default("deepseek-flash"),
    ...rest unchanged
  });
  // Config
  planner: ModelRouteSchema.default({} as never),
  executor: ModelRouteSchema.default({} as never),
  ```
  Also add a guard in `requestRewrite`: only stamp `provider`/`model` when the value is a non-empty string.
- **Tests (add to `policy.test.ts`; these are the 2 "omit-to-inherit" guards T14 promised):**
  - `Config({ planner: { model: "deepseek-v4-pro" } }).planner` equals `{ provider: "deepseek-official", model: "deepseek-v4-pro" }`.
  - `Config({ executor: { reasoningEffort: "low" } }).executor.model === "deepseek-flash"`.
  - Add a router test: drive the registered `agent/request` listener with a fake `next` that resolves `{ provider: "x", model: "y" }`, and assert that `provider` is never `undefined`.
- **Verify:** V. **Depends on:** A1 for the router test only. **Worker:** DS.

### A4. Make the tests tell the roles apart, and cover the wiring (F11)
- **Files:** `test/policy.test.ts` L12-24 and the `routeFor` blocks; `test/router.test.ts`.
- **Change:**
  - Set `CONFIG.planner.model = "planner-model"` and `CONFIG.executor.model = "executor-model"`, and update the expectations at L73-117. The plan-mode tests must now show executor vs planner.
  - Keep the `Config({})` default tests on `deepseek-flash`.
  - Add router-level request tests through the `agent/request` listener captured in `makeFakeAgent().agent.ctx.on`:
    - (a) root gets the planner, subagent (`options.subagentDepth: 1`) gets the executor;
    - (b) `enabled: false` returns `resolved` unchanged;
    - (c) vision enabled plus an image event stamps the vision model, even for a subagent;
    - (d) `maxTokens` and effort are stamped only when set.
- **Verify:** V. The total should be 47 or more. **Depends on:** A1 (for `requestRewrite`). **Worker:** DS.

### A5. Fix the catalog rows (F4)
- **Files:** `cordis.patch-T14.yml` (which then becomes `cordis.patch.yml`).
- **Change:** `deepseek-v4-pro` gets `inputModalities: [text]`, or omit the field ("absence means unknown"; I recommend an explicit `[text]`). Keep `[text, image]` on `deepseek-flash`, `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`. Update the comment at L40-44: "V4-Pro is still served (unchanged billing) but has no vision; see api-docs.deepseek.com/quick_start/pricing".
- **Verify:** YAML parses (`node -e "require('yaml')"` is not available, so check by eye or with a live `dsh web --dump-config`, then look for `llm-deepseek` models). **Parallel:** yes. **Worker:** DS.

### A6. Merge the T14 docs and fix the README (F5, F6, F20, F4 docs)
- **Files:** `README.md` (take README-T14 as the base), `CHANGELOG.md` (take CHANGELOG-T14), then delete the three `*-T14.*` files.
- **Changes:**
  - Tuning (README:151-170): replace the `- patch:` wrapper with a direct `- id: model-router` / `config:` row, and add a callout that the id-targeted row replaces the whole plugin config. Fix L142 the same way.
  - Log check (README:197-199): `grep -o '"model":"deepseek-[a-z0-9.-]*"'`, and correct the explanation at L202-206.
  - In the "flip planner to V4-Pro" text (README L8, Tuning, CHANGELOG-T14 L10-11), add: "V4-Pro has no vision. Enable `vision.enabled: true` so image sessions go to `deepseek-flash`."
  - CHANGELOG v0.7.1: correct the alias bullet (v4-flash only), add bullets for the A3, A6 and A7 fixes, and use the real test count.
  - Cite the official changelog for the V4-Pro continuation (F20).
- **Verify:** read it through; `git diff --stat` touches only docs. **Depends on:** A5 (wording), final test count from A4. **Parallel:** yes. **Worker:** DS.

### A7. Turn CI back on, and small build fixes (F7, F15, F19)
- **Files:** `.gitignore` (delete L6), `.github/workflows/ci.yml` (`node-version: 24`, or a matrix of [22, 24]), `package.json` devDependencies (add an explicit `"esbuild"` matching the version tsup resolves; check with `npm ls esbuild`).
- **Verify:** `git status` shows `ci.yml` as untracked and committable; V. After pushing, the Actions run is green. **Parallel:** yes. **Worker:** DS.

### A8. Stop the static SKILL.md from drifting (F10)
- **Files:** `skills/pro-flash-routing/SKILL.md`, a new test in `test/router.test.ts`.
- **Change:** regenerate the SKILL.md body from `buildSkillContent(resolveConfig({}))`, keeping the frontmatter with `SKILL_DESCRIPTION`/`SKILL_WHEN_TO_USE`. Add a test that reads the file, strips the frontmatter, and asserts equality. That way, any change to the text fails CI until the file is regenerated.
- **Depends on:** A2. **Worker:** DS.

### A9. Version and copy cleanup (F14, F10 client copy)
- **Files:** `package.json:4` set to `0.7.1`; `src/client.tsx:2` header; `src/client.tsx:46,73` `modePlan` wording to "uses the planner route only while plan mode is active"; `scripts/publish.sh:14` REPO_DESC.
- **Verify:** V (`build:client` guard passes). **Parallel:** yes. **Worker:** DS.

### A10. Release v0.7.1 (after A1-A9; only with your go-ahead)
Run V, commit, then follow the README "Releasing" steps (tag, `gh release`, `npm publish`). Restart the profile and do a live check with the fixed regex. Note that on a 0.2.1 host the model counts may not reflect the router at all; that is F1, handled in Track B. **Worker:** you, or me with explicit permission. Publishing needs your npm 2FA.

**Track A order:** A1, then A3, then A2, then A4 and A8 (all sequential in `src/index.ts` and the tests). A5, A6, A7 and A9 can run alongside. A6 should be finished last, so it uses the final test count.

## Track B: harness 0.2.1+ compatibility

### B0. Decide the target harness range (your decision, Q1)

### B1. Spike: does the `agent/request` rewrite still work on 0.2.1? (F1)
- **Goal:** settle F1 with real evidence before rewriting anything.
- **Steps:**
  1. Install the plugin from a local checkout into a throwaway profile: `dsh plugin --profile router-spike add <abs path>`. Note the `--profile` placement rule from the `plugin-option-placement` guide.
  2. In that profile's `cordis.patch.yml`, set `- id: model-router` / `config: { planner: { model: deepseek-v4-pro } }`. This needs A3 first, or give the provider explicitly.
  3. Run a session that delegates once.
  4. Run `zstd -d -c "$DSH_HOME"/sessions/<ws>/<id>/session.jsonl.zstd | grep '"type":"assistant/message"' | grep -o '"model":"deepseek-[a-z0-9.-]*"' | sort | uniq -c`, and also check the `request/header` events.
- **Pass/fail:** if the root shows `deepseek-v4-pro`, the old path still works (F1 drops to low priority). If the root shows `deepseek-flash`, F1 is confirmed.
- **Worker:** you (it needs a live harness and an API key); I can prepare the profile files.

**B1 result (2026-11-08, dsh 0.2.2-rc.1, spike in `spike/b1`):** the question in F1 can't be answered yet, because **the plugin doesn't load at all**:
- `dsh plugin add` refuses it (peer ranges `^0.1.0-rc.8`, F8) unless an exact-version risk exemption is granted.
- With the exemption, the harness reports `model-router (dsh-model-router): failed to import: SyntaxError: The requested module '@deepseek-ai/dsh-plan-mode' does not provide an export named 'foldPlanMode'`, and "1 entry did not activate". The session has no router prompt section or skill.
- Bundled 0.2.2-rc.1 exports: `dsh-plan-mode` → `EXIT_PLAN_MODE, PlanModeController, planProjectionDefinition, resolveConfig` (plan state is now a session projection); `dsh-settings` → `SettingsConflictError, SettingsForms, redactSecrets` (`installSettingsSection`/`settingsNamespace` are gone, confirming F9).
- Also: 0.2.x session logs are `session.v4.jsonl.zstd` with no `assistant/message` events, so the README's log check counts nothing; count `request/header` (`data.header.config.model`) instead.

So the published plugin is a no-op on 0.2.x for a more basic reason than F1. B2–B4 now start with making it import: read plan state via the plan projection, move the settings toggle to `SettingsForms` / `.volatile()` Config (B3), and bump peers/devDeps to 0.2.x types (B4). Re-run the spike after that to settle F1 itself.

### B2. Move routing to `agent.model.select` (if B1 confirms F1)
- **Goal:** route through the supported API, and keep the legacy path for rc.8 hosts.
- **Files:** `src/index.ts` (new `applySelection(agent)`), `src/policy.ts` (a pure `decideRoute(agent, cfg, events, planActive): { selection, maxTokens? }` that combines the vision-first logic, `routeFor` and `effortFor`).
- **Design (from the harness docs):**
  - `agent/created` runs after factory setup, and AgentLoop holds queued input until creation listeners finish. In it:
    `const d = decideRoute(...); if (typeof agent.model?.select === "function") { if (!sameSelection(agent.model.current(), d.selection)) agent.model.select(d.selection); if (d.maxTokens) agent.options.maxTokens = d.maxTokens; } else { register the legacy agent/request listener (A1) }`.
    `select()` "assigns the complete choice for the next step whose preparation has not begun" and does not inherit effort. So when the route doesn't pin an effort, pass the current explicit effort only if the route is unchanged (migration step 4).
  - Dynamic re-evaluation (vision on first image, escalation after an error, plan-mode enter/exit): `agent/pre-step` already carries the captured `modelSelection`, so a `select()` there only affects the **next** step. Options: (a) call `select()` in `agent/pre-step` and accept a one-step lag; (b) watch the session events (`tool/result`, `user/message`, plan-mode events) and call `select()` as each fact lands. This is design work for O. Also, image admission "checks the route selected when admission begins", so the role model itself must accept images for the first image. That is fine with `deepseek-flash`, and is a reason to enable vision when the planner is V4-Pro.
  - User UI selections also call `select()`. Enforcing the route means re-selecting on every pre-step, which logs `model/selection` churn and overrides what the user picked. This needs your decision (Q2).
  - Keep the `agent/request` listener only for rc.8 hosts (feature detection), and on new hosts never change provider, model or effort there.
- **Tests:** fake `agent.model` with `current`/`select` spies. Assert one `select` per agent at creation with the right role route, no `select` when the current selection is equal, the legacy listener only when `agent.model` is missing, and `options.maxTokens` set.
- **Verify:** V, then B1's live procedure with the expected per-role counts, plus an image session with `vision.enabled`.
- **Depends on:** B1, Q1, Q2, and A1+A3 (shared code). **Worker:** O for design, S to implement.

### B3. Settings/GUI on the new settings model (F9)
- **Spike first:** in a 0.2.1 profile, check whether `@deepseek-ai/dsh-settings` still exports `installSettingsSection`/`settingsNamespace` (`node -p "Object.keys(require('<profile>/node_modules/@deepseek-ai/dsh-settings'))"`, or read its `lib/types/index.d.ts`), and whether `settingsScope.bind` still exists on the client.
- **If it changed:** mark `enabled` and `vision.enabled` as `.volatile()` in `Config`, read live values through the Config reference, drop `installSettingsSection`, and either rebind the card to the new form API or register `configure({ auto: false })` per the settings README. Update README:58-97, which still describes `settings.yaml`. Fix F12 at the same time.
- **Depends on:** Q1. **Worker:** S after the spike.

### B4. Dependency and compatibility metadata (F8)
- **Files:** `package.json`.
- **Change:** add `"engines": { "dsh": "<range from Q1>" }`, which is checked before DSH peers. Widen or retarget `peerDependencies`. Set devDependencies to explicit 0.2.x versions (not dist-tags, since `latest` points at old builds) so typecheck sees `agent.model`. Optionally upgrade vitest to 5.x; it needs Node ≥22.12, and CI already meets that.
- **Verify:** `npm ci`, V, and `dsh plugin --profile <p> add <path>` installs without a compatibility refusal.
- **Depends on:** Q1. **Worker:** DS for the edit, then review the lockfile.

### B5. Decide whether the plugin should override the `llm-deepseek` catalog at all (F13)
On 0.2.1+, compare `dsh web --dump-config` and the model selector with and without the plugin's `llm-deepseek` row. If discovery already lists `deepseek-flash` with image input, remove the row and the side effect that wipes adapter config. **Depends on:** Q1. **Worker:** you (live), then DS for the edit.

### Track B order
B1 (live) runs in parallel with all of Track A. B2, B3 and B4 come after Q1/Q2. B3 and B4 can run in parallel; B2 after B4, since it needs the new types. B5 is independent.

## Parallel and worker summary

| Step | Parallel with | Worker |
|---|---|---|
| A1 | A5, A6, A7, A9, B1 | S / DS |
| A2 | after A1 (same file) | DS |
| A3 | after A1 | DS |
| A4 | after A1 | DS |
| A5 | everything | DS |
| A6 | everything (finish last) | DS |
| A7 | everything | DS |
| A8 | after A2 | DS |
| A9 | everything | DS |
| A10 | after all of Track A | you |
| B1 | Track A | you (live) |
| B2 | after B1, B4 | O, then S |
| B3 | B4 | S |
| B4 | B3 | DS |
| B5 | anything | you, then DS |

---

# Part 3: Open questions for you

1. **Target harness:** your desktop app is 0.2.1.0. Should the router support only 0.2.1+, or keep supporting 0.1.0-rc.8 hosts too (dual path with feature detection, B2)? Which harness version does the laptop that produced the README's production numbers run?
2. **Enforce vs. respect:** on 0.2.1+, a user's model pick in the UI and the router both use `agent.model.select()`. Should the router re-assert its route every step (strict enforcement, `model/selection` churn in logs), set it only at agent creation (the user can override later), or do it only for subagents?
3. **Ship v0.7.1 before Track B?** Track A is safe and fixes real bugs (the leak, partial routes, docs), but on a 0.2.1 host the routing claims may still not hold until B2. Should Track A ship as-is, or should the release wait for B1's result?
4. **V4-Pro planner and images:** if someone points the planner at `deepseek-v4-pro`, should the router turn vision on automatically for image sessions (safe, but changes the opt-in default), or should the docs just tell them to enable `vision.enabled`?
5. **`llm-deepseek` override:** if B5 shows endpoint discovery lists the models correctly, can the plugin stop overriding `llm-deepseek` (and maybe `attachment-local`)?
6. **Static `skills/pro-flash-routing/SKILL.md`:** keep it as a generated, test-guarded copy (A8), or delete it, since the runtime registers the skill?
7. **CI node version:** 24 only (matches the harness runtime) or a [22, 24] matrix? And should vitest move from 2.x to 5.x now or later?
8. **Delegation workers:** your coordinator suggested haiku workers, but your CLAUDE.md says DeepSeek via OpenCode by default and no haiku. I used no subagents for this review. Should the plan's worker column stay DS/S/O as written?

## Decisions (2026-11-08)

1. **Target harness: 0.2.1+ only.** No legacy `agent/request` model-rewrite path for 0.1.0-rc.8 hosts. B2 drops the dual path and feature detection; B4 sets `engines.dsh` and the peer/dev ranges to 0.2.1+.
2. **Enforce vs. respect: switch only on route transitions.** Subagents get the executor selection once, at `agent/created`. The root agent gets the planner selection at creation, then the router calls `agent.model.select()` again only when its own decision changes: plan mode on/off (in `plan` mode), the first image in a session (vision enabled), or escalation starting or wearing off. A model the user picks by hand mid-session stays until one of those triggers fires. No per-step re-assertion, so no `model/selection` churn.
3. **Ship before Track B:** done; v0.7.2 ships Track A, and its notes say routing on 0.2.1+ is unverified until B1/B2.
4. **V4-Pro planner and images: docs, not magic, for now.** Keep `vision.enabled` opt-in; the README and CHANGELOG tell V4-Pro users to enable it. Revisit in B2: once the router reads the model catalog, it can warn (log once) when a role model lacks image input and vision is off.
5. **`llm-deepseek` override: drop it if B5 confirms discovery.** If endpoint discovery on 0.2.1+ lists `deepseek-flash` with image input, remove the plugin's `llm-deepseek` row. Keep the `attachment-local` limits unless B5 shows the host defaults already admit normal screenshots.
6. **Static `SKILL.md`: keep it** as the generated, test-guarded copy (A8). It documents the skill for repo readers and for tools that read skills from disk, and the drift test keeps it honest.
7. **CI: Node 24 only** (matches the harness runtime). Vitest 2.x → 5.x moves with B4, alongside the 0.2.x dependency bump.
8. **Workers:** DeepSeek via OpenCode for mechanical edits, Haiku 5.5 (medium) allowed for test writing and sweeps, Sonnet for sensitive code, Opus (high) for the B2 design.

**Next:** B1 is the live check only you can run (it needs a 0.2.1 harness and an API key). B2's design depends on its result.
