/**
 * dsh-model-router: role-based model routing for the DeepSeek Harness.
 *
 * The planner (the session's root agent) runs on `deepseek-v4-pro`; delegated
 * executor subagents run on `deepseek-v4-flash`. Enforcement is a per-agent
 * `agent/request` rewrite registered when the agent is created, so it applies
 * in every mode (web / headless / tui) and every agent preset, including
 * subagents the delegation tools create.
 *
 * The plugin also publishes:
 *  - a system-prompt section stating the planner/executor convention, and
 *  - the `pro-flash-routing` skill teaching the agent to plan itself and
 *    delegate code execution to flash subagents.
 *
 * @module dsh-model-router
 */
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { roleFor, routeFor, type RouterConfig } from "./policy.js";

/** Plugin row id; the bundle patch inserts it under this id. */
const name = "model-router";

/** One provider/model pair, with defaults. */
const ModelRouteSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

/** The plugin's public config, validated at row load. */
const Config = z.object({
  planner: ModelRouteSchema.default({
    provider: "deepseek-official",
    model: "deepseek-v4-pro",
  }),
  executor: ModelRouteSchema.default({
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  }),
  promptSection: z.boolean().default(true),
  skill: z.boolean().default(true),
});

/**
 * Resolve raw row config into the internal shape, failing loud on garbage.
 * Schemastery schemas are callable: invoking validates and applies defaults.
 * @param raw - the row's config object.
 * @returns the validated RouterConfig.
 */
function resolveConfig(raw: unknown): RouterConfig {
  const parsed = Config(raw ?? {});
  return {
    planner: parsed.planner,
    executor: parsed.executor,
    promptSection: parsed.promptSection,
    skill: parsed.skill,
  };
}

/**
 * Always-on guidance section. Negative order renders before the persona, so
 * the convention is established before the agent's identity line.
 */
const SECTION_ORDER = -50;

const SECTION_TEXT = `Model routing is role-based in this session. You are the planner and run on {PLANNER_MODEL}. Do your own planning, design, review of delegated output, and user-facing synthesis on this agent. Code execution runs on {EXECUTOR_MODEL}: after a plan is approved, delegate implementation work — writing code, running commands, builds, and tests — to subagents, which are automatically routed to {EXECUTOR_MODEL}. Give each subagent a complete, self-contained prompt and prefer background delegation for independent work. Do not hand-write large amounts of code or run long executions on this planner agent; delegate instead.`;

const SKILL_NAME = "pro-flash-routing";

const SKILL_DESCRIPTION =
  "Route planning and code execution across models: plan on the pro planner agent, delegate implementation to flash executor subagents.";

const SKILL_WHEN_TO_USE = `Use when a task combines planning and implementation: before writing code, after a plan is approved, when delegating execution work, or when the user asks about the pro/flash routing convention.`;

const SKILL_CONTENT = `# Pro planner / Flash executor routing

This session routes models by role:

- **Planner (this agent)** — \`deepseek-v4-pro\`. Planning, design decisions, reviewing delegated output, and user-facing synthesis happen here.
- **Executors (every subagent)** — \`deepseek-v4-flash\`. Implementation work happens there: writing code, running commands, builds, and tests. The harness forces the model automatically; you do not select it.

## Working rhythm

1. **Plan here.** Explore, decide the approach, and (when plan mode is on) submit the plan with \`exit_plan_mode\`. The plan stays on this agent.
2. **Delegate the execution.** Once a plan is approved, hand each self-contained chunk of implementation to a subagent with a complete prompt: exact files to touch, the change to make, and how to verify. Subagents are automatically routed to \`deepseek-v4-flash\`, so keep them execution-focused: give them the decision, not the decision to make.
3. **Review here.** Read the subagent's result on this agent, verify it yourself (tests, diffs, logs), and iterate with follow-up messages to the same subagent when available.
4. **Report here.** Summaries, plans, and answers to the user come from this agent.

## Delegation guidelines

- Start independent delegations together in one assistant message and continue useful work while they run (background mode by default).
- Prefer \`subagent\` for self-contained work and \`workflow\` when many independent pieces need fan-out; their workers run on flash as well.
- Do not delegate design: subagents execute decisions already made.
- If a subagent's task grows into design work, pull it back to this agent and re-delegate the narrowed execution.

## Verification

- Executor output was produced by \`deepseek-v4-flash\`; planner output by \`deepseek-v4-pro\`. If you need to confirm, check the session log's model metadata.
- If routing ever looks wrong, the \`model-router\` plugin row in the profile composition is the single place that owns it.`;

/** The plugin row id the bundle patch must insert. */
const ROW_ID = "model-router";

/** Minimal structural view of the live agent object the router reads. */
interface AgentLike {
  ctx: AgentScopedContext;
  options?: { subagentDepth?: number };
  session?: { header?: { origin?: string } };
}

/** The agent-scoped context's waterfall surface the router uses. */
interface AgentScopedContext {
  on(
    event: "agent/request",
    listener: (
      payload: Record<string, unknown>,
      next: () => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>,
    options?: { prepend?: boolean },
  ): () => void;
}

/** Host-plane surface the router consumes (events, prompt registry, skills). */
interface HarnessContext {
  on(
    event: "agent/created",
    listener: (payload: { agent: AgentLike }) => void,
  ): () => void;
  on(event: "agent/disposed", listener: (agent: unknown) => void): () => void;
  systemPrompt: {
    section(section: { name: string; order: number; text: string }): unknown;
  };
  skills: {
    register(skill: {
      name: string;
      description: string;
      whenToUse?: string;
      content: string;
      source: string;
    }): unknown;
  };
}

/**
 * Cordis service: per-agent request routing plus the convention surface.
 */
class ModelRouter extends Service {
  static inject = ["skills", "systemPrompt"];

  config: RouterConfig;

  constructor(ctx: Context, rawConfig: unknown = {}) {
    super(ctx, "modelRouter");
    this.config = resolveConfig(rawConfig);
    const harness = ctx as unknown as HarnessContext;

    // Every agent that gets created — root sessions, delegation children,
    // workflow workers, ralph rounds — passes through here.
    harness.on("agent/created", ({ agent }) => {
      // `prepend` puts this listener OUTERMOST in the `agent/request`
      // waterfall: the harness's model-selection listener runs inside it, so
      // this rewrite is applied LAST and wins over the session's selected
      // model (which dsh-base defaults to deepseek-v4-flash and the user
      // settings or UI can change).
      const dispose = agent.ctx.on(
        "agent/request",
        async (payload, next) => {
          const resolved = await next();
          const route = routeFor(agent, this.config);
          if (route === undefined) return resolved;
          return { ...resolved, provider: route.provider, model: route.model };
        },
        { prepend: true },
      );
      harness.on("agent/disposed", (disposed) => {
        if (disposed === agent) dispose();
      });
    });

    if (this.config.promptSection) {
      harness.systemPrompt.section({
        name: ROW_ID,
        order: SECTION_ORDER,
        text: SECTION_TEXT.replaceAll("{PLANNER_MODEL}", this.config.planner.model).replaceAll(
          "{EXECUTOR_MODEL}",
          this.config.executor.model,
        ),
      });
    }

    if (this.config.skill) {
      harness.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        content: SKILL_CONTENT,
        source: "runtime",
      });
    }
  }
}

export {
  Config,
  ModelRouter,
  ModelRouter as default,
  name,
  ROW_ID,
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  SKILL_WHEN_TO_USE,
  roleFor,
  routeFor,
};
export type { AgentRole, ModelRoute, RouterConfig } from "./policy.js";
