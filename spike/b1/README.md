# B1 spike: does the router still change the model on harness 0.2.x?

Plan step B1 in `REVIEW-AND-PLAN.md`. The router changes the model inside the
`agent/request` hook. Harness 0.2.1+ docs say that hook can no longer change
provider/model. This spike checks it on a live harness.

## What it does

- Creates a throwaway profile, `router-spike`, from the shipped `headless`
  template under `~/.dsh/profiles/` (your `desktop` profile is not touched).
- Installs this checkout's build into it.
- Points the planner at `deepseek-v4-pro`, while the session default stays
  `deepseek-flash`.
- Runs one small headless task that plans and delegates once.
- Counts the model on every `request/header` event, root vs. subagent.

## Run it (PowerShell, from the repo root)

1. Setup, no API calls:

   ```powershell
   powershell -ExecutionPolicy Bypass -File spike\b1\setup.ps1 -AcceptRisk
   ```

   `-AcceptRisk` is needed on dsh 0.2.x: the harness refuses the plugin
   because its peer ranges are `^0.1.0-rc.8` (finding F8). The flag grants an
   exact-version exemption for this plugin version, in the `router-spike`
   profile only.

2. Run, a few small DeepSeek API requests using the harness's configured
   credentials:

   ```powershell
   powershell -ExecutionPolicy Bypass -File spike\b1\run.ps1
   ```

## Reading the result

`check-models.mjs` prints the models per session and a verdict:

- **Root used `deepseek-v4-pro`:** the old hook still works on this harness.
  F1 drops to low priority.
- **Root used `deepseek-flash`:** the rewrite is ignored. F1 is confirmed, so
  do B2 (move to `agent.model.select()`).

To re-check any later window: `node spike\b1\check-models.mjs <sinceEpochMs>`.

## Clean up

Delete `~/.dsh/profiles/router-spike` when you're done.

## Notes found while preparing this

- The installed harness reports `dsh --version` = `0.2.2-rc.1`.
- 0.2.x session logs are `session.v4.jsonl.zstd` and have no
  `assistant/message` events, so the README's log-check recipe (which greps
  `assistant/message` in `session.jsonl.zstd`) finds nothing there. This
  script counts `request/header` events instead.
