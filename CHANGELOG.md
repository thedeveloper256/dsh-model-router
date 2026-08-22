# Changelog

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
