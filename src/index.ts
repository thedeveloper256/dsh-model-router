/**
 * dsh-model-router: role-based model routing for the DeepSeek Harness.
 *
 * Both roles default to `deepseek-flash` (V4.1 Flash, native multimodal):
 * the planner (the session's root agent) and delegated executor subagents
 * share the same model until V4.1-Pro launches, at which point the planner
 * route can be flipped back with a one-line config change. Enforcement goes
 * through `agent.model.select()` (harness 0.2.1+): once when an agent is
 * created, then again only when the route decision changes (plan mode,
 * images, error escalation). It applies in every mode (web / headless / tui)
 * and every agent preset, including subagents the delegation tools create.
 *
 * Each role route may also pin `reasoningEffort` and `maxTokens`; when set,
 * they override the session's selection for that role. A `mode` switch lets a
 * deployment reserve the planner route for actual planning.
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
import { effortFor, hasImageContent, recentStepsHadError, roleFor, routeFor, sessionHasImage, shouldUseVision, type ModelRoute, type RouterConfig } from "./policy.js";

/** Plugin row id; the bundle patch inserts it under this id. */
const name = "model-router";

/** One provider/model pair, with defaults and optional effort/token caps. */
const ModelRouteSchema = z.object({
  provider: z.string().min(1).default("deepseek-official"),
  model: z.string().min(1).default("deepseek-flash"),
  reasoningEffort: z.union(["off", "low", "high", "max"]),
  maxTokens: z.number().min(1),
  escalateOnError: z.boolean(),
  escalateTo: z.union(["off", "low", "high", "max"]),
  recoverySteps: z.number().min(1),
});

/**
 * Opt-in vision route. Defaults to `deepseek-flash` (V4.1 Flash, native
 * multimodal) from `deepseek-official`; `reasoningEffort` and `maxTokens`
 * are optional pins. Native multimodal makes the vision branch a no-op when
 * the role routes already point at the same model — kept for explicitness
 * and for a future V4.1-Pro split.
 */
const VisionRouteSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().min(1).default("deepseek-official"),
  model: z.string().min(1).default("deepseek-flash"),
  reasoningEffort: z.union(["off", "low", "high", "max"]),
  maxTokens: z.number().min(1),
});

/** The plugin's public config, validated at row load. */
const Config = z.object({
  // Field-level defaults on ModelRouteSchema fill provider/model in when a
  // route is only partly set (e.g. `planner: { model: deepseek-v4-pro }`).
  planner: ModelRouteSchema.default({} as never),
  executor: ModelRouteSchema.default({} as never),
  mode: z.union(["strict", "plan"]).default("strict"),
  enabled: z.boolean().default(true),
  promptSection: z.boolean().default(true),
  skill: z.boolean().default(true),
  vision: VisionRouteSchema.default({} as never),
});

/** Settings form id: the plugin's profile entry id. */
const SETTINGS_NS = "model-router";

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
    mode: parsed.mode,
    enabled: parsed.enabled,
    promptSection: parsed.promptSection,
    skill: parsed.skill,
    vision: parsed.vision,
  };
}

/**
 * Always-on guidance section. Negative order renders before the persona, so
 * the convention is established before the agent's identity line.
 */
const SECTION_ORDER = -50;

const SECTION_TEXT = `Model routing is role-based. Planning runs on {PLANNER_MODEL}; implementation runs on {EXECUTOR_MODEL}. You are the root agent: plan, design, review subagent output, and write the final answer here. Delegate implementation — writing code, running commands, builds, tests — to subagents with complete, self-contained prompts, preferring background delegation for independent work. Keep plans and replies concise. Do not hand-write large amounts of code or run long executions here; delegate instead.{VISION_LINE}`;

const SKILL_NAME = "pro-flash-routing";

const SKILL_DESCRIPTION =
  "Route planning and code execution across models: plan on the planner agent, delegate implementation to executor subagents.";

const SKILL_WHEN_TO_USE = `Use when a task combines planning and implementation: before writing code, after a plan is approved, when delegating execution work, or when the user asks about the planner/executor routing convention.`;

/**
 * Build the `pro-flash-routing` skill body from the configured routes, so the
 * text always names the models the router actually stamps.
 * @param cfg - the planner, executor and vision routes.
 * @returns the skill's Markdown content.
 */
function buildSkillContent(cfg: Pick<RouterConfig, "planner" | "executor" | "vision">): string {
  const planner = cfg.planner.model;
  const executor = cfg.executor.model;
  const visionLine = cfg.vision.enabled
    ? `\n- **Vision** — requests whose session carries image content route to \`${cfg.vision.model}\`, whatever the role.`
    : "";
  const verification =
    planner === executor
      ? `Both roles produce \`${planner}\`.`
      : `Planner requests log \`${planner}\`; executor requests log \`${executor}\`.`;
  return `# Pro planner / Flash executor routing

This session routes models by role:

- **Planner (this agent)** — \`${planner}\`. Planning, design decisions, reviewing delegated output, and user-facing synthesis happen here.
- **Executors (every subagent)** — \`${executor}\`. Implementation work happens there: writing code, running commands, builds, and tests. The harness forces the model automatically; you do not select it.${visionLine}

## Working rhythm

1. **Plan here.** Explore, decide the approach, and (when plan mode is on) submit the plan with \`exit_plan_mode\`. The plan stays on this agent.
2. **Delegate the execution.** Once a plan is approved, hand each self-contained chunk of implementation to a subagent with a complete prompt: exact files to touch, the change to make, and how to verify. Subagents are automatically routed to \`${executor}\`, so keep them execution-focused: give them the decision, not the decision to make.
3. **Review here.** Read the subagent's result on this agent, verify it yourself (tests, diffs, logs), and iterate with follow-up messages to the same subagent when available.
4. **Report here.** Summaries, plans, and answers to the user come from this agent.

## Keep this agent's context lean

Input tokens are the expensive part of the planner. Don't re-read large files or full transcripts on this agent — trust the subagent's final report. Prefer targeted reads (offset/limit) over whole files. When the context grows, compact rather than re-sending everything.

## Delegation guidelines

- Start independent delegations together in one assistant message and continue useful work while they run (background mode by default).
- Prefer \`subagent\` for self-contained work and \`workflow\` when many independent pieces need fan-out; their workers run on the executor route as well.
- Do not delegate design: subagents execute decisions already made.
- If a subagent's task grows into design work, pull it back to this agent and re-delegate the narrowed execution.

## Verification

- ${verification} If you need to confirm, check the session log's model metadata.
- If routing ever looks wrong, the \`model-router\` plugin row in the profile composition is the single place that owns it.`;
}

/** Skill body for the default config (kept for backward compatibility). */
const SKILL_CONTENT = buildSkillContent(resolveConfig({}));

/** The plugin row id the bundle patch must insert. */
const ROW_ID = "model-router";

/** One complete model choice, as `agent.model.select()` takes it. */
interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** Minimal structural view of a live 0.2.x session the router reads. */
interface SessionLike {
  header?: { origin?: string };
  snapshotEvents?: () => readonly unknown[];
  /** Pre-0.2 sessions exposed the log directly; read defensively. */
  events?: unknown[];
}

/** Minimal structural view of the live agent object the router reads. */
interface AgentLike {
  options?: { subagentDepth?: number; maxTokens?: number };
  session?: SessionLike;
  model?: {
    current(): Readonly<ModelSelection> | undefined;
    select(selection: Readonly<ModelSelection>): void;
  };
}

/** Why an agent was announced (dsh-agent `SessionStartSource`). */
type StartSource = "startup" | "resume" | "clear" | "compact";

/** Host-plane surface the router consumes (events, prompt registry, skills). */
interface HarnessContext {
  on(
    event: "agent/created",
    listener: (payload: { agent: AgentLike; source?: StartSource }) => void,
  ): () => void;
  on(
    event: "agent/disposed",
    listener: (payload: { agent: AgentLike } | AgentLike) => void,
  ): () => void;
  on(
    event: "session/event",
    listener: (session: SessionLike, event: { type?: string }) => void,
  ): () => void;
  systemPrompt: {
    section(section: { name: string; order: number; text: string }): () => void;
  };
  skills: {
    register(skill: {
      name: string;
      description: string;
      whenToUse?: string;
      content: string;
      source: string;
    }): () => void;
  };
}

/**
 * Session event types that can change the route decision: plan mode toggles,
 * new user input (images), tool results (errors, images) and completed steps
 * (the escalation window). Anything else cannot change it.
 */
const ROUTE_EVENTS = new Set(["plan/mode", "user/message", "tool/result", "step/end"]);

/**
 * The documented `agent/disposed` payload is `{ agent }` (dsh-agent
 * runtime-types); a bare agent is accepted defensively.
 */
function disposedAgentOf(payload: unknown): AgentLike | undefined {
  if (payload !== null && typeof payload === "object" && "agent" in payload) {
    return (payload as { agent: AgentLike }).agent;
  }
  if (payload === null || typeof payload !== "object") return undefined;
  return payload as AgentLike;
}

/**
 * Read an agent's session log. 0.2.x sessions expose `snapshotEvents()`; a
 * bare `events` array is accepted defensively.
 * @param agent - the live agent.
 * @returns the event log, or `undefined` when none is readable.
 */
function eventsOf(agent: AgentLike): readonly unknown[] | undefined {
  const session = agent.session;
  if (session === undefined) return undefined;
  if (typeof session.snapshotEvents === "function") {
    try {
      return session.snapshotEvents();
    } catch {
      return undefined;
    }
  }
  return Array.isArray(session.events) ? session.events : undefined;
}

/**
 * Fold plan-mode state from a session log: the last `plan/mode` event wins.
 * @param events - the session event log.
 * @returns whether plan mode is active.
 */
function planModeActive(events: readonly unknown[] | undefined): boolean {
  if (!Array.isArray(events)) return false;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as { type?: string; data?: { active?: unknown } } | undefined;
    if (event?.type === "plan/mode") return event.data?.active === true;
  }
  return false;
}

/** Compare two selections field by field; an absent effort equals absent. */
function sameSelection(
  a: Readonly<ModelSelection> | undefined,
  b: Readonly<ModelSelection>,
): boolean {
  return (
    a !== undefined &&
    a.provider === b.provider &&
    a.model === b.model &&
    (a.reasoningEffort ?? undefined) === (b.reasoningEffort ?? undefined)
  );
}

/** One route decision: the route plus the effort it pins (if any). */
interface RouteDecision {
  route: ModelRoute;
  /** Pinned or escalated effort; `undefined` keeps the agent's own effort. */
  effort: string | undefined;
  /** Stable key; the router calls `select()` only when it changes. */
  key: string;
}

/**
 * Cordis service: routes each agent's model through `agent.model.select()`
 * when the route decision changes, plus the convention surface.
 */
class ModelRouter extends Service {
  static inject = ["skills", "systemPrompt"];

  config: RouterConfig;

  /** Host-plane surface the router consumes (events, prompt registry, skills). */
  harness: HarnessContext;

  /** Disposer of the currently registered prompt section, if any. */
  promptDispose?: () => void;

  /** Disposer of the currently registered skill, if any. */
  skillDispose?: () => void;

  /** Last decision key applied per agent. */
  private readonly lastKey = new WeakMap<object, string>();

  /** Live agent per session object, for `session/event` dispatch. */
  private readonly agentBySession = new WeakMap<object, AgentLike>();

  constructor(ctx: Context, rawConfig: unknown = {}) {
    super(ctx, "modelRouter");
    this.config = resolveConfig(rawConfig);
    this.harness = ctx as unknown as HarnessContext;

    // Every agent that gets created (root sessions, delegation children,
    // workflow workers, ralph rounds) passes through here. `agent/created` is
    // awaited before the first step, so the selection lands in time.
    this.harness.on("agent/created", ({ agent, source }) => {
      if (agent.session !== undefined) this.agentBySession.set(agent.session, agent);
      // A resumed session keeps whatever model it recorded (possibly the
      // user's own choice); the router only takes over on the next change.
      this.apply(agent, source === "resume");
    });
    this.harness.on("agent/disposed", (payload) => {
      const agent = disposedAgentOf(payload);
      if (agent === undefined) return;
      this.lastKey.delete(agent);
      if (agent.session !== undefined) this.agentBySession.delete(agent.session);
    });
    // Post-commit append feed: re-decide on events that can change the route.
    // A selection made here applies from the next step on.
    this.harness.on("session/event", (session, event) => {
      if (session === null || typeof session !== "object") return;
      if (!ROUTE_EVENTS.has(event?.type ?? "")) return;
      const agent = this.agentBySession.get(session);
      if (agent !== undefined) this.apply(agent, false);
    });

    // Settings edits rewrite the profile patch; a changed field remounts this
    // plugin, so the constructor re-renders with the new config. The plugin
    // ships its own settings card, so turn off the generated page.
    const fiber = (ctx as unknown as { fiber?: unknown }).fiber;
    (ctx as unknown as {
      inject(deps: string[], cb: (child: Context) => void): unknown;
    }).inject(["settings"], (child) => {
      const scoped = child as unknown as {
        effect(execute: () => () => void): unknown;
        settings: { configure(p: { auto?: boolean }, owner?: unknown): () => void };
      };
      scoped.effect(() => scoped.settings.configure({ auto: false }, fiber));
    });

    this.render(this.config);
  }

  /**
   * Decide the route for one agent from its role, plan mode, images and
   * recent errors.
   * @param agent - the live agent.
   * @returns the decision, or `undefined` to leave the agent alone.
   */
  decide(agent: AgentLike): RouteDecision | undefined {
    const cfg = this.config;
    if (!cfg.enabled) return undefined;
    const events = eventsOf(agent);
    // Vision first: image content anywhere in the session wins over the role.
    const route = shouldUseVision(events, cfg.vision)
      ? cfg.vision
      : routeFor(agent, cfg, planModeActive(events));
    if (route === undefined) return undefined;
    const effort = effortFor(route, events);
    return {
      route,
      effort,
      key: `${route.provider}\u0000${route.model}\u0000${effort ?? ""}\u0000${route.maxTokens ?? ""}`,
    };
  }

  /**
   * Apply the current decision to one agent if it changed since the last
   * one. The router never re-selects on an unchanged decision, so a model the
   * user picks mid-session stays until the next route transition.
   * @param agent - the live agent.
   * @param seedOnly - record the decision without selecting (resume).
   */
  apply(agent: AgentLike, seedOnly: boolean): void {
    const decision = this.decide(agent);
    if (decision === undefined) {
      this.lastKey.delete(agent);
      return;
    }
    if (this.lastKey.get(agent) === decision.key) return;
    this.lastKey.set(agent, decision.key);
    if (seedOnly) return;
    const { route, effort } = decision;
    if (route.maxTokens !== undefined && agent.options !== undefined) {
      agent.options.maxTokens = route.maxTokens;
    }
    const model = agent.model;
    if (model === undefined) return;
    let current: Readonly<ModelSelection> | undefined;
    try {
      current = model.current();
    } catch {
      current = undefined;
    }
    const reasoningEffort = effort ?? current?.reasoningEffort;
    const selection: ModelSelection = {
      provider: route.provider,
      model: route.model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
    if (sameSelection(current, selection)) return;
    model.select(selection);
  }

  /**
   * Register the convention surface (prompt section + skill) for `cfg`,
   * replacing whatever is currently registered. While `enabled` is false,
   * nothing stays registered.
   */
  private render(cfg: RouterConfig): void {
    if (this.promptDispose) {
      this.promptDispose();
      this.promptDispose = undefined;
    }
    if (this.skillDispose) {
      this.skillDispose();
      this.skillDispose = undefined;
    }
    if (!cfg.enabled) return;
    if (cfg.promptSection) {
      this.promptDispose = this.harness.systemPrompt.section({
        name: ROW_ID,
        order: SECTION_ORDER,
        text: SECTION_TEXT.replaceAll("{PLANNER_MODEL}", cfg.planner.model)
          .replaceAll("{EXECUTOR_MODEL}", cfg.executor.model)
          .replace(
            "{VISION_LINE}",
            cfg.vision.enabled
              ? ` Image-bearing requests route to ${cfg.vision.model}.`
              : "",
          ),
      });
    }
    if (cfg.skill) {
      this.skillDispose = this.harness.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        content: buildSkillContent(cfg),
        source: "runtime",
      });
    }
  }
}

export {
  Config,
  ModelRouter,
  ModelRouter as default,
  SETTINGS_NS,
  VisionRouteSchema,
  name,
  ROW_ID,
  SKILL_CONTENT,
  buildSkillContent,
  resolveConfig,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  SKILL_WHEN_TO_USE,
  effortFor,
  hasImageContent,
  recentStepsHadError,
  roleFor,
  routeFor,
  sessionHasImage,
  shouldUseVision,
};
export type {
  AgentRole,
  ModelRoute,
  ReasoningEffort,
  RoutingMode,
  RouterConfig,
  VisionRoute,
} from "./policy.js";
