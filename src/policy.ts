/**
 * Pure routing policy for dsh-model-router: which model each agent role gets.
 * Kept free of Cordis imports so the policy is trivially unit-testable.
 * @module dsh-model-router/policy
 */

/** Reasoning-effort levels a route may pin (mirrors the harness vocabulary). */
export type ReasoningEffort = "off" | "low" | "high" | "max";

/**
 * How the router treats the root agent.
 * - `strict`: the root agent is always the planner (pro).
 * - `plan`: the root agent is pro only while plan mode is active; otherwise it
 *   falls back to the executor route, reserving pro for real planning.
 */
export type RoutingMode = "strict" | "plan";

/** One route: a provider/model pair stamped onto an agent request. */
export interface ModelRoute {
  provider: string;
  model: string;
  /**
   * Optional reasoning-effort override. When omitted, the request inherits the
   * session's own selection; when set, the router pins it for that role.
   */
  reasoningEffort?: ReasoningEffort;
  /** Optional output-token cap for the role; omitted means inherit. */
  maxTokens?: number;
}

/** The two roles the router distinguishes. */
export type AgentRole = "planner" | "executor";

/** Resolved router configuration: one route per role plus routing mode. */
export interface RouterConfig {
  planner: ModelRoute;
  executor: ModelRoute;
  mode: RoutingMode;
  promptSection: boolean;
  skill: boolean;
}

/**
 * Classify an agent as planner or executor.
 *
 * The main (root) agent of a session is the planner. Every agent created as a
 * delegation child — `subagent`, `subagent_fork`, workflow workers, ralph
 * rounds — is an executor. The harness stamps two durable facts on children:
 * `options.subagentDepth` (>= 1) and the session header `origin: "subagent"`.
 *
 * @param agent - the live agent (any subset of the runtime shape).
 * @returns the role the agent should be routed as.
 */
export function roleFor(agent: unknown): AgentRole {
  const options = (agent as { options?: unknown })?.options;
  const depth = (options as { subagentDepth?: unknown })?.subagentDepth;
  if (typeof depth === "number" && depth >= 1) return "executor";
  const session = (agent as { session?: unknown })?.session;
  const origin = (session as { header?: unknown })?.header
    ? ((session as { header: { origin?: unknown } }).header.origin)
    : undefined;
  if (origin === "subagent") return "executor";
  return "planner";
}

/**
 * Resolve the route for one agent.
 * @param agent - the live agent.
 * @param config - the resolved router configuration.
 * @param planModeActive - whether plan mode is currently folded active for the
 *   agent's session; consulted only in `plan` routing mode.
 * @returns the model route to stamp, or `undefined` to leave the request alone.
 */
export function routeFor(
  agent: unknown,
  config: RouterConfig,
  planModeActive = false,
): ModelRoute | undefined {
  const role = roleFor(agent);
  if (role === "executor") return config.executor;
  // Root agent. In `plan` mode, reserve the planner route for actual planning;
  // otherwise the root falls back to the executor route.
  if (config.mode === "plan" && !planModeActive) return config.executor;
  return config.planner;
}
