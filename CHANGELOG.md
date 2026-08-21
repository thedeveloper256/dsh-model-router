# Changelog

## v0.1.0 (unreleased)

- Role-based model routing: the session's root agent (planner) is stamped
  `deepseek-v4-pro`; every delegation child (subagent, subagent_fork, workflow
  workers, ralph rounds) is stamped `deepseek-v4-flash`.
- The `agent/request` rewrite registers outermost in the waterfall, so it wins
  over dsh-base's built-in default (`deepseek-v4-flash`) and the UI's
  per-session model pick.
- Always-on prompt section stating the planner/executor convention (renders
  before the persona).
- `pro-flash-routing` skill registered in the session skill catalog.
- Configurable via the `model-router` row (`planner`, `executor`,
  `promptSection`, `skill`).
- Verified live against the harness: planner session requests logged as
  `deepseek-v4-pro`, executor subagent session requests as
  `deepseek-v4-flash` (headless profile, session-log model metadata).
