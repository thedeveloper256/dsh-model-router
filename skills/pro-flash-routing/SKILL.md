---
name: pro-flash-routing
description: Route planning and code execution across models: plan on the pro planner agent, delegate implementation to flash executor subagents.
whenToUse: Use when a task combines planning and implementation: before writing code, after a plan is approved, when delegating execution work, or when the user asks about the pro/flash routing convention.
---

# Pro planner / Flash executor routing

This session routes models by role (both default to deepseek-flash, V4.1 Flash with native multimodal; vision needs no separate model):

- **Planner (this agent)** — `deepseek-flash`. Planning, design decisions, reviewing delegated output, and user-facing synthesis happen here.
- **Executors (every subagent)** — `deepseek-flash`. Implementation work happens there: writing code, running commands, builds, and tests. The harness forces the model automatically; you do not select it.

## Working rhythm

1. **Plan here.** Explore, decide the approach, and (when plan mode is on) submit the plan with `exit_plan_mode`. The plan stays on this agent.
2. **Delegate the execution.** Once a plan is approved, hand each self-contained chunk of implementation to a subagent with a complete prompt: exact files to touch, the change to make, and how to verify. Subagents are automatically routed to `deepseek-flash`, so keep them execution-focused: give them the decision, not the decision to make.
3. **Review here.** Read the subagent's result on this agent, verify it yourself (tests, diffs, logs), and iterate with follow-up messages to the same subagent when available.
4. **Report here.** Summaries, plans, and answers to the user come from this agent.

## Keep this agent's context lean

Input tokens are the expensive part of the planner. Don't re-read large files or full transcripts on this agent — trust the subagent's final report. Prefer targeted reads (offset/limit) over whole files. When the context grows, compact rather than re-sending everything.

## Delegation guidelines

- Start independent delegations together in one assistant message and continue useful work while they run (background mode by default).
- Prefer `subagent` for self-contained work and `workflow` when many independent pieces need fan-out; their workers run on flash as well.
- Do not delegate design: subagents execute decisions already made.
- If a subagent's task grows into design work, pull it back to this agent and re-delegate the narrowed execution.

## Verification

- Both roles produce `deepseek-flash` output (unified since V4.1; split again when V4.1-Pro lands). If you need to confirm, check the session log's model metadata.
- If routing ever looks wrong, the `model-router` plugin row in the profile composition is the single place that owns it.
