# dsh-model-router

A small plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that stops treating every model call the same. It splits your session into two roles:

- **The planner** — your main agent — defaults to `deepseek-flash` (V4.1 Flash, native multimodal). That's where the thinking happens: understanding what you want, designing the approach, reviewing results, writing the final answer.
- **The executors** — every subagent it delegates to — default to `deepseek-flash` as well.

Both roles share the same model until V4.1-Pro launches (V4.1 Flash already beats V4-Pro on performance, cost, and speed, so DeepSeek is retiring `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` — both now route to V4.1 Flash server-side — while `deepseek-v4-pro` continues after Sep 14, 2026 with unchanged billing, per the [official changelog](https://api-docs.deepseek.com/updates)). The role split stays in the config, so flipping the planner back to Pro later is a one-line change. V4-Pro has no vision. Set `vision.enabled: true` so image sessions go to `deepseek-flash`. You keep the careful plan/delegate/review rhythm without paying Pro prices for every tool call.

## Compatibility

v0.8.0 targets DeepSeek Harness **0.2.1 and later 0.2.x** (`engines.dsh`:
`>=0.2.1-rc.1 <0.3.0-0`). It does not load on 0.1.x — users on 0.1.x stay on
v0.7.2. On 0.2.x, v0.7.x failed to import (the harness removed the
`foldPlanMode` / `installSettingsSection` exports) and its `agent/request`
rewrite cannot change the model there, so v0.7.x did nothing on 0.2.x.

## Install

Add it to a profile (this installs into the `web` profile; change the name for another one):

```bash
dsh plugin --profile web add dsh-model-router
```

That pulls it from npm, which ships prebuilt — no build step needed.

Prefer the source? A git install works too, but pnpm clones and builds it on the spot and will ask you to approve the build script once (add the `allowBuilds` key it prints to the profile's `pnpm-workspace.yaml`, then re-run):

```bash
dsh plugin --profile web add git+https://github.com/thedeveloper256/dsh-model-router
```

Once it's in, restart the profile. You should see the row under `model-router` in `dsh web --dump-config`.

## What it actually does

Three small surfaces, one rule:

1. **Model selection** — when an agent is created — the root session and every delegated subagent — the router calls `agent.model.select({ provider, model, reasoningEffort })` to put it on its role route. Root agents get the planner route; delegation children (`subagent`, `subagent_fork`, workflow workers, ralph rounds) get the executor route. Both default to `deepseek-flash` (V4.1 Flash) until V4.1-Pro launches, so today the split is parked while the role config stays ready. After creation the router selects again only when the route decision changes: plan-mode toggles, image content appearing, or error escalation starting/wearing off. It never re-selects on an unchanged decision, so a model you pick mid-session stays until the next route change.
2. **A prompt section** — a short note that renders before the agent's persona, telling the planner: you're the thinker, delegate the implementation. Without this, the model tends to just do everything itself.
3. **A skill** — the `pro-flash-routing` skill shows up in the session's skill catalog and spells out the working rhythm: plan, delegate, review, report. Same convention, but loadable on demand when the agent wants details. Since v0.7.1 the skill text follows your configured routes instead of hardcoding model names.

## How the roles are decided

An agent is an *executor* if it carries either of the markers the harness stamps on delegation children:

- `options.subagentDepth >= 1`, or
- `session.header.origin === "subagent"`

Everything else is a planner. That logic lives in `src/policy.ts` as a plain function, so it's easy to reason about and test.

### What the router sets

The router sets `provider` + `model` through `agent.model.select()`. `reasoningEffort` is pinned only when a route configures it (or `escalateTo` while escalation is active); otherwise the agent's current effort is kept. `maxTokens` on a route sets the agent's output cap (`AgentOptions.maxTokens`). Selection happens once at agent creation, then only on a route change — choosing a different model in the UI mid-session is respected until the next plan-mode toggle, image, or escalation transition. Resumed sessions keep their recorded model until the next change. A route change takes effect from the next model step; plan-mode routing lags one step because the harness captures the step's model before that step's `plan/mode` events are appended. The harness adds its own model-switch notice to the conversation.

### What still differs while the models are unified

With both routes on `deepseek-flash`, the model choice is a pass-through — but the roles are not identical:

- **Effort and token pins are per role.** Planner `high` + executor `low`, for example, genuinely behaves and costs differently per role today.
- **The convention still steers behavior.** The prompt section and skill keep the root agent planning and delegating instead of doing everything itself, regardless of model.
- **Selection still sets the model.** Every new agent starts on `deepseek-flash`, and a route change puts it back there — even if the session or UI was on something else.
- **The split is parked, not removed.** When V4.1-Pro launches, pointing the planner route at it restores the two-model setup with a one-line change.

## Turning the router off

Routing is on by default. Two ways to switch it off:

- **GUI (Settings → Plugins → Model router):** the plugin registers a card in
  the harness's `plugins.item` slot. Flip `enabled` off; the card writes the
  plugin's profile entry config through the harness config forms, which
  remounts the plugin and applies from the next agent/route change. It also
  unregisters the prompt section and the skill. Flip it back on and everything
  returns. The same card hosts the Vision switch (v0.6.0+, see below).
- **Patch row:** set `enabled: false` in the profile's `cordis.patch.yml` row
  (takes effect on the next boot). `disabled: true` still skips the row entirely.

With the router off, the router makes no selections: new agents use the
session's selected model (your `agent-default-model` setting or the base
default).

## The GUI toggle (v0.5.0+)

Since v0.5.0 the package ships a browser half, and the harness serves it
automatically — no extra config. On 0.2.x the card registers in the
`plugins.item` slot, so **Settings → Plugins** shows a **Model router** card
with a live **Enabled** switch, an "Overridden" badge and **Reset to
default** button once you've changed it, a read-only view of the current
planner/executor routes and mode, and a Vision section (v0.6.0+) with its own
live **Vision** switch, **Reset vision to default** button, and read-only
vision-model line. A settings change remounts the plugin and applies from the
next agent/route change. Earlier versions kept the live toggle in
`settings.yaml`; the harness migrates that file into the profile itself, and
the card now edits the plugin's profile entry config through the harness
config forms. The Vision switch writes only `vision.enabled`.

One harness-wide caveat (it applies to **all** settings pages — Models,
Plugins, everything — not to this plugin specifically): the harness serves
settings pages only to **loopback** browsers (`localhost` / `127.x`). A remote
browser may not get the settings page at all; where the card does render it
shows a read-only note. The fallback that works everywhere:

- **Patch row** — set `enabled: false` in the profile's `cordis.patch.yml`
  (takes effect on the next boot); this is the same config the card edits.

## Vision routing (v0.6.0+)

Since v0.6.0 the router can also handle image-bearing sessions. **It is opt-in
and off by default** (`vision.enabled: false`). Two ways to turn it on:

- **GUI:** on the same **Model router** card, flip the **Vision** switch
  (writes only `vision.enabled`), or
- **Patch row / settings:** set `vision.enabled: true` on the plugin's config.

When enabled, the router selects the vision model **as soon as the session log
carries an image** — `deepseek-flash` from `deepseek-official` by default
(V4.1 Flash is natively multimodal, so this matches the role routes unless you
pin something else) — **from every role**: the root (planner) agent and all
delegated subagents. Everything else keeps the role routing untouched. The
vision branch is checked first, so an image-bearing session lands on the
vision model even when it comes from a subagent. With the default config the
vision model is the same `deepseek-flash` as the role routes, so the branch is
a no-op until you pin a different vision model. Optional
`vision.reasoningEffort` / `vision.maxTokens` pins work exactly like the
per-role ones. Image detection reads the session event log (`user/message`,
`assistant/message`, and `tool/result`, including images nested in
`tool-result` blocks): once an image appears anywhere in the log, the router
keeps the vision model selected for the rest of the session (sticky — the
image stays in request context until compaction or pruning drops it).
Detection shapes are verified against real session logs: `user/message`
carries the image at `data.content`, while `assistant/message` and
`tool/result` carry it at `data.message.content` (tool results nest it inside
a `tool-result` block). Possible follow-up: optional `vision.historyLimit` to
bound the scan to the trailing N events (unset keeps today's sticky entire-log
scan).

The plugin ships the support in its own `cordis.patch.yml`:

- a **catalog entry** for `deepseek-flash` on the `llm-deepseek` row (with
  `inputModalities: [text, image]`, `contextWindow: 1000000`, `maxTokens:
  384000`), plus `deepseek-v4-pro` (still served after Sep 14, 2026 with
  unchanged billing, per the [official changelog](https://api-docs.deepseek.com/updates);
  text-only — V4-Pro has no vision) and the retired `deepseek-v4-flash` /
  `deepseek-v4-flash-vision-exp` ids kept as compat aliases through the
  transition (since v0.7.2 the multimodal ids — `deepseek-flash`,
  `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` — declare image
  input; `deepseek-v4-pro` stays `[text]`), and
- **raised `attachment-local` image admission limits** so normal screenshots
  (~8K, 15MB) attach without being rejected (`maxImageDimension: 8192`,
  `maxImagePixels: 100000000`, `maxImageBytes: 15728640`).

Both are defaults you can override in your **profile**'s `cordis.patch.yml` —
the profile layer applies after the plugin layer, so an `- id: llm-deepseek`
(or `- id: attachment-local`) row in the profile wins. Note these are
id-targeted rows that **replace the whole row config** (not a deep merge):
installing the plugin resets `llm-deepseek` to exactly those 4 models and
`attachment-local` to exactly those 3 image keys — restate anything else you
need in the profile layer. One hard requirement remains: the vision model
**must be present in the catalog with image input
modality**, or the provider rejects the request at call time with
`UNSUPPORTED_CONTENT` — the shipped catalog row is what satisfies that.

## Tuning

All configuration lives on the plugin row. Override it in the profile's `cordis.patch.yml`:

```yaml
- id: model-router
  config:
    planner:            # root-agent route (deepseek-flash until V4.1-Pro lands)
      provider: deepseek-official
      model: deepseek-flash
      reasoningEffort: high   # off | low | high | max (omit to inherit)
      maxTokens: 8192         # output cap (omit to inherit)
    executor:           # subagent route
      provider: deepseek-official
      model: deepseek-flash
      reasoningEffort: high
      escalateOnError: true   # after a failed step…
      escalateTo: max         #   …bump effort at the next route decision
      recoverySteps: 2        #   …wearing off after N clean steps
    mode: strict        # strict | plan (see below)
    promptSection: true # register the always-on routing section
    skill: true         # register the pro-flash-routing skill
```

An `- id:` row **replaces the whole plugin config** (not a deep merge), so
restate every field you want — anything you leave out falls back to its
default.

`mode` controls how the root agent is treated: `strict` keeps it on the planner route always; `plan` sends the root to the executor route unless plan mode is active, reserving the planner route for real planning. A plan-mode toggle is a route change, so it applies from the next model step (the harness captures that step's model before the step's `plan/mode` events are appended). `maxTokens` on a route sets the agent's output cap (`AgentOptions.maxTokens`).

**Error-driven escalation** (`escalateOnError`): when a route's agent hits a failed tool step, the *next* route decision bumps to `escalateTo` and wears off after `recoverySteps` clean steps. It's deterministic and stateless — the router folds the session log when it decides, so only prior steps are considered (a failure can't escalate the step that caused it). It's a per-route knob: enable it on the executor to make flash think harder after a flubbed execution step, without touching the baseline.

The model defaults are exactly the two routes at the top of this page. To switch the router off for a session, disable the row (`disabled: true`) or remove the plugin — `dsh plugin --profile web remove dsh-model-router`. If even the convention surface is unwanted until V4.1-Pro lands, flip `enabled` off (see above) and leave the plugin installed — everything unregisters and you flip it back on later.

## Reduce token usage

With both roles on `deepseek-flash`, the bill is already far below the old
pro-based setup — most of the remaining savings come from shrinking spend:

- **Lower `reasoningEffort`.** The harness default runs at `max`, which produces a lot of reasoning tokens. `high` (or `low`) on a route keeps most of the quality at a fraction of the cost.
- **Cap output** with `maxTokens` on the planner route so a verbose turn can't balloon.
- **Reserve the planner route for planning** with `mode: plan` — trivial Q&A and execution-style turns stop hitting the planner route at all (matters again once V4.1-Pro lands and the routes split).
- **Keep the planner's context lean.** Input tokens dominate after reasoning. Delegate aggressively and trust the subagent's report; don't re-read big files or full transcripts on the planner. Use targeted reads and let auto-compaction (`/compact`) trim history.
- **Tune the host pruner.** The tool-result pruner truncates oversized results before they reach the model (default ~8 KB); lowering `tool-result-pruner` → `thresholdChars` trims more planner input. That's harness config, not this plugin's row.
- **Exploit DeepSeek's context cache.** Repeated prefixes are served from cache at a big discount, so keep the system prompt and conversation prefix stable between turns.

The first three are one-line changes on this plugin's row; the last three are discipline and host tuning.

## Does it work?

Verify against a real session log. Run a task that makes the agent plan and
delegate, then check which model each request used.

Session logs are zstd-compressed at
`~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd` (Node 23.8+ can
read them with `zlib.zstdDecompressSync`). Each model request writes a
`request/header` event; its `data.header.config.model` is the model used. The
session's `delegationDepth` tells planner from executor: `0` is the root,
`>=1` is a subagent.

The repo ships a ready-made script that does exactly this:

```bash
node spike/b1/check-models.mjs [sinceEpochMs]
```

It prints one line per session — delegation depth, agent preset, and a count
of request models — and a PASS/FAIL verdict. `sinceEpochMs` limits the scan to
sessions modified after that time (omit it to scan all).

Since v0.7.0 both roles use `deepseek-flash` (unified until V4.1-Pro lands and
the planner route points at it). For reference, the v4-era split re-verified
against production logs: a root session with delegations showed 170 pro / 182
flash responses, and every child session (`delegationDepth >= 1`) showed flash
only; with vision routing enabled, an image-heavy session logged 508
`deepseek-v4-flash-vision-exp` responses.

One operational note: the plugin loads at harness boot. After updating the
package (e.g. 0.7.2 → 0.8.0), restart the profile — a session that keeps
running across the update can keep behaving per the old code until the process
reloads.

## Development

It's a normal small TypeScript package — no framework magic:

```bash
npm install
npm run typecheck
npm test
npm run build
```

The `prepare` script builds `lib/` automatically, which is what makes the git install work without shipping build artifacts in the repo. The `dsh.bundle` field in `package.json` is what tells `dsh plugin` how to compose the plugin into a profile.

## Releasing

Pushing a tag alone does not make a release. Every version needs all four:

```bash
npm run typecheck && npm test && npm run build  # green first
git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes "<CHANGELOG entry>"
npm publish --access public  # needs login + 2FA (--otp) or a publish token
```

Keep `vX.Y.Z` flagged as Latest (`gh release edit vX.Y.Z --latest`) when backfilling older ones. Note: `scripts/publish.sh` is a one-shot bootstrap for a brand-new repo, not the per-release path.

## License

MIT
