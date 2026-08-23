## v0.6.1

- Fix the vision-support bundle patch: the `llm-deepseek` catalog row and the
  `attachment-local` limits now use direct id-targeted entries (the `patch:`
  wrapper was ignored by the loader), so installing the plugin actually adds
  `deepseek-v4-flash-vision-exp` to the catalog and raises image admission
  limits.

# Changelog

## v0.6.0

- **Vision routing** (opt-in, default off): when `vision.enabled` is on, any
  request whose messages carry image content is stamped with the vision model
  (`deepseek-v4-flash-vision-exp` on `deepseek-official`), from **every role** —
  root agent and subagents alike. Everything else keeps the pro/flash role
  routing untouched. Optional `vision.reasoningEffort` / `vision.maxTokens`
  pins behave like the per-role ones.
- **Bundle patch**: the plugin's `cordis.patch.yml` now also ships (a) a
  catalog entry for the vision model with `inputModalities: [text, image]` on
  `llm-deepseek` (plus restated pro/flash rows) and (b) raised
  `attachment-local` image admission limits (`maxImageDimension: 8192`,
  `maxImagePixels: 100000000`, `maxImageBytes: 15728640`) so normal screenshots
  attach. Override both in the profile layer, which applies after the plugin
  layer.
- **GUI**: the "Model router" card gains a Vision section — its own live
  switch, a reset affordance, and a read-only route line — alongside the
  unchanged main `enabled` switch.
- The prompt section gains a conditional line naming the vision model when
  vision routing is enabled.

## v0.5.0

- **Browser half**: the package now ships a client bundle the harness serves
  automatically. Settings → Plugins renders a "Model router" card with a live
  `enabled` switch (plus overridden badge, reset button, and read-only route
  lines). Changes apply live and persist in `settings.yaml` under
  `model-router:` — no restart, no extra config.
- The card is served only to loopback browsers (a harness-wide rule covering
  all settings pages); elsewhere the patch row or `settings.yaml` remain the
  fallbacks.

## v0.4.0

- **GUI on/off toggle**: new `enabled` config (default `true`), surfaced as a
  live settings section — Settings → Plugins → dsh-model-router. Turning it
  off stops all request rewrites and unregisters the prompt section and skill;
  turning it back on restores them. Applies immediately, no restart; persists
  in `settings.yaml` under `model-router:`.

## v0.3.0

- **Error-driven effort escalation**: `escalateOnError` / `escalateTo` /
  `recoverySteps` on a route — a failed execution step bumps the next
  request's reasoning effort (e.g. flash `high` → `max`), wearing off after
  `recoverySteps` clean steps. Deterministic and stateless: the session log is
  folded per request, so only prior steps are considered.
- `reasoningEffort` and `maxTokens` per role (0.2.0-era feature, now released
  together with the above).

## v0.2.0

- Per-role `reasoningEffort` and `maxTokens` config.
- `mode: plan` — root agent is pro only while plan mode is active.
- Context-lean prompt section and skill updates.

## v0.1.1

- Prefer the npm install in the README now that the package is published.
- Add `dsh-plugin` and related keywords for npm discoverability.

## v0.1.0

- Initial release: role-based model routing — planner (root agent) on `deepseek-v4-pro`, delegated executor subagents on `deepseek-v4-flash`.
- Ships an always-on prompt section and the `pro-flash-routing` skill.
- Live-verified against the harness via session-log model metadata.
