# dsh-model-router

A small plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that stops treating every model call the same. It splits your session into two roles:

- **The planner** — your main agent — always runs on `deepseek-v4-pro`. That's where the thinking happens: understanding what you want, designing the approach, reviewing results, writing the final answer.
- **The executors** — every subagent it delegates to — always run on `deepseek-v4-flash`. That's where the work happens: writing code, running commands, iterating on builds.

The idea is simple: pro is the better thinker, flash is fast and cheap at grinding through implementation. You get the careful planning of the big model without paying pro prices for every single tool call.

## Install

Add it to a profile (this installs into the `web` profile; change the name for another one):

```bash
dsh plugin --profile web add git+https://github.com/thedeveloper256/dsh-model-router
```

That's a git install, so pnpm clones the repo and builds it on the spot. pnpm guards build scripts by default, though — it'll print an `allowBuilds` key you need to add to the profile's `pnpm-workspace.yaml`, then re-run the same `dsh plugin` command. It's a one-time thing:

```yaml
allowBuilds:
  dsh-model-router@git+https://github.com/thedeveloper256/dsh-model-router#<commit>: true
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

### A behavior worth knowing

The router only overrides the model (`provider` + `model`), not the rest of the request. So reasoning effort and the other sampling settings still come from your session's selection — pick "max effort" and you get pro/flash doing max effort, just not a different model. It's "which model runs" that's enforced, not "how hard it thinks".

## Tuning

All configuration lives on the plugin row. If you want different models, or you'd rather the prompt section or skill not be registered, patch the row in the profile's `cordis.patch.yml`:

```yaml
- patch:
    - id: model-router
      config:
        planner:            # root-agent route
          provider: deepseek-official
          model: deepseek-v4-pro
        executor:           # subagent route
          provider: deepseek-official
          model: deepseek-v4-flash
        promptSection: true # register the always-on routing section
        skill: true         # register the pro-flash-routing skill
```

The defaults are exactly the table at the top of this page. To switch the router off for a session, disable the row (`disabled: true`) or remove the plugin — `dsh plugin --profile web remove dsh-model-router`.

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
