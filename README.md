# dsh-model-router

A small plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that stops treating every model call the same. It splits your session into two roles:

- **The planner** — your main agent — always runs on `deepseek-v4-pro`. That's where the thinking happens: understanding what you want, designing the approach, reviewing results, writing the final answer.
- **The executors** — every subagent it delegates to — always run on `deepseek-v4-flash`. That's where the work happens: writing code, running commands, iterating on builds.

The idea is simple: pro is the better thinker, flash is fast and cheap at grinding through implementation. You get the careful planning of the big model without paying pro prices for every single tool call.

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

1. **Request routing** — every model request gets stamped with a role. Root agents get `deepseek-v4-pro`; delegation children (`subagent`, `subagent_fork`, workflow workers, ralph rounds) get `deepseek-v4-flash`. The rewrite sits at the outermost layer of the request pipeline, so it wins — even over the harness's own default model (which is `deepseek-v4-flash` out of the box) and over whatever model you pick in the UI for the session. That's intentional: it's the "enforce" knob.
2. **A prompt section** — a short note that renders before the agent's persona, telling the planner: you're the thinker, delegate the implementation. Without this, the model tends to just do everything itself.
3. **A skill** — the `pro-flash-routing` skill shows up in the session's skill catalog and spells out the working rhythm: plan, delegate, review, report. Same convention, but loadable on demand when the agent wants details.

## How the roles are decided

An agent is an *executor* if it carries either of the markers the harness stamps on delegation children:

- `options.subagentDepth >= 1`, or
- `session.header.origin === "subagent"`

Everything else is a planner. That logic lives in `src/policy.ts` as a plain function, so it's easy to reason about and test.

### What the router does and doesn't override

The router always stamps `provider` + `model`. `reasoningEffort` and `maxTokens` are *optional per role*: set them in the config and they're enforced for that role; leave them out and those fields inherit from your session's selection. So picking "max effort" in the UI but not pinning `reasoningEffort` in the config still gives you max-effort thinking — it just happens on the routed model.

## Turning the router off

Routing is on by default. Two ways to switch it off:

- **GUI (Settings → Plugins → dsh-model-router):** the plugin registers a live
  settings section; flip `enabled` off. It applies immediately (no restart),
  persists in `settings.yaml` under `model-router:`, and unregisters the prompt
  section and the skill too. Flip it back on and everything returns. The same
  card also hosts the Vision switch (v0.6.0+, see below).
- **Patch row:** set `enabled: false` in the profile's `cordis.patch.yml` row
  (takes effect on the next boot). `disabled: true` still skips the row entirely.

With the router off, requests use the session's selected model (your
`agent-default-model` setting or the base default) — the router is simply not
rewriting them.

## The GUI toggle (v0.5.0+)

Since v0.5.0 the package ships a browser half, and the harness serves it
automatically — no extra config. After installing (or updating to) v0.5.0+
and restarting the profile, **Settings → Plugins** shows a **Model router**
card with a live **Enabled** switch, an "Overridden" badge and **Reset to
default** button once you've changed it, and a read-only view of the current
planner/executor routes and mode. Flipping the switch applies immediately (no
restart) and persists in `settings.yaml` under `model-router:` — the same
mechanism the GUI toggle described above uses.

One harness-wide caveat (it applies to **all** settings pages — Models,
Plugins, everything — not to this plugin specifically): the harness serves
settings pages only to **loopback** browsers (`localhost` / `127.x`). A remote
browser sees "settings are unavailable" instead of the card. Fallbacks that
work everywhere:

- **Patch row** — set `enabled: false` in the profile's `cordis.patch.yml`
  (takes effect on the next boot), or
- **`settings.yaml`** — add `model-router: { enabled: false }` under the
  settings file the profile uses; this applies live, same as the GUI.

## Vision routing (v0.6.0+)

Since v0.6.0 the router can also handle image-bearing requests. **It is opt-in
and off by default** (`vision.enabled: false`). Two ways to turn it on:

- **GUI:** on the same **Model router** card, flip the **Vision** switch (live,
  no restart, persists in `settings.yaml`), or
- **Patch row / settings:** set `vision.enabled: true` on the plugin's config.

When enabled, **any request whose messages carry an image is stamped with the
vision model** — `deepseek-v4-flash-vision-exp` from `deepseek-official` by
default — **from every role**: the root (planner) agent and all delegated
subagents. Everything else keeps the pro/flash role routing untouched. The
vision branch is checked first, so a subagent reading an image still lands on
the vision model, not on flash. Optional `vision.reasoningEffort` /
`vision.maxTokens` pins work exactly like the per-role ones.

The plugin ships the support in its own `cordis.patch.yml`:

- a **catalog entry** for the vision model on the `llm-deepseek` row (with
  `inputModalities: [text, image]`, plus raised `contextWindow`/`maxTokens`
  restated for the pro/flash rows), and
- **raised `attachment-local` image admission limits** so normal screenshots
  (~8K, 15MB) attach without being rejected (`maxImageDimension: 8192`,
  `maxImagePixels: 100000000`, `maxImageBytes: 15728640`).

Both are defaults you can override in your **profile**'s `cordis.patch.yml` —
the profile layer applies after the plugin layer, so a `patch:` targeting
`llm-deepseek` or `attachment-local` in the profile wins. One hard requirement
remains: the vision model **must be present in the catalog with image input
modality**, or the provider rejects the request at call time with
`UNSUPPORTED_CONTENT` — the shipped catalog row is what satisfies that.

## Tuning

All configuration lives on the plugin row. Patch it in the profile's `cordis.patch.yml`:

```yaml
- patch:
    - id: model-router
      config:
        planner:            # root-agent route
          provider: deepseek-official
          model: deepseek-v4-pro
          reasoningEffort: high   # off | low | high | max (omit to inherit)
          maxTokens: 8192         # output cap (omit to inherit)
        executor:           # subagent route
          provider: deepseek-official
          model: deepseek-v4-flash
          reasoningEffort: high
          escalateOnError: true   # after a failed step…
          escalateTo: max         #   …bump effort for the next request
          recoverySteps: 2        #   …wearing off after N clean steps
        mode: strict        # strict | plan (see below)
        promptSection: true # register the always-on routing section
        skill: true         # register the pro-flash-routing skill
```

`mode` controls how the root agent is treated: `strict` keeps it on the planner route always; `plan` sends the root to the executor route unless plan mode is active, reserving pro for real planning.

**Error-driven escalation** (`escalateOnError`): when a route's agent hits a failed tool step, the *next* request bumps to `escalateTo` and wears off after `recoverySteps` clean steps. It's deterministic and stateless — the router folds the session log per request, so only prior steps are considered (a failure can't escalate the very request that caused it). It's a per-route knob: enable it on the executor to make flash think harder after a flubbed execution step, without touching the baseline.

The defaults are exactly the table at the top of this page. To switch the router off for a session, disable the row (`disabled: true`) or remove the plugin — `dsh plugin --profile web remove dsh-model-router`.

## Reduce pro token usage

The planner is the expensive model, so most of the savings come from shrinking its spend:

- **Lower `reasoningEffort`.** The harness default runs pro at `max`, which produces a lot of reasoning tokens. `high` (or `low`) on the planner route keeps most of the quality at a fraction of the cost.
- **Cap output** with `maxTokens` on the planner route so a verbose turn can't balloon.
- **Reserve pro for planning** with `mode: plan` — trivial Q&A and execution-style turns stop hitting pro at all.
- **Keep the planner's context lean.** Input tokens dominate after reasoning. Delegate aggressively and trust the subagent's report; don't re-read big files or full transcripts on the planner. Use targeted reads and let auto-compaction (`/compact`) trim history.
- **Tune the host pruner.** The tool-result pruner truncates oversized results before they reach the model (default ~8 KB); lowering `tool-result-pruner` → `thresholdChars` trims more planner input. That's harness config, not this plugin's row.
- **Exploit DeepSeek's context cache.** Repeated prefixes are served from cache at a big discount, so keep the system prompt and conversation prefix stable between turns.

The first three are one-line changes on this plugin's row; the last three are discipline and host tuning.

## Does it work?

I verified it against a real session log. Run a task that makes the agent plan and delegate, then check which models actually made the requests:

```bash
zstd -d -c "$DSH_HOME"/sessions/<workspace>/<session>/session.jsonl.zstd \
  | grep -o '"model":"deepseek-v4-[a-z]*"' | sort | uniq -c
```

Planner messages come back as `deepseek-v4-pro`; subagent messages as `deepseek-v4-flash`. In my test: 9 pro requests in the planner's session, 6 flash in the subagent's.

## Development

It's a normal small TypeScript package — no framework magic:

```bash
npm install
npm run typecheck
npm test
npm run build
```

The `prepare` script builds `lib/` automatically, which is what makes the git install work without shipping build artifacts in the repo. The `dsh.bundle` field in `package.json` is what tells `dsh plugin` how to compose the plugin into a profile.

## License

MIT
