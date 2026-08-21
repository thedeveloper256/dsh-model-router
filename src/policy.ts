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
  /**
   * Error-driven escalation (v1): when true, a failed execution step bumps the
   * next request's effort to `escalateTo`, wearing off after `recoverySteps`
   * clean steps. Deterministic, stateless — the session log is folded per
   * request, so only *prior* steps are ever considered.
   */
  escalateOnError?: boolean;
  /** Effort used for the request after a failed step. */
  escalateTo?: ReasoningEffort;
  /** Clean steps before escalation wears off. Defaults to 2. */
  recoverySteps?: number;
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

/** Default recovery window: an error escalates for the next two completed steps. */
export const DEFAULT_RECOVERY_STEPS = 2;

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

/**
 * Whether any of the last `recoverySteps` completed steps carried a failed
 * tool result. A failure is a `tool/result` event whose data carries an
 * `error` field (the harness records tool failures there).
 *
 * Steps are deduplicated by `turn:step`, and only *completed* steps count —
 * events are scanned from the tail, so the current in-flight request is never
 * considered.
 *
 * @param events - the agent's session event log (or `undefined`).
 * @param recoverySteps - how many completed steps back to scan.
 * @returns true when a failed step is within the window.
 */
export function recentStepsHadError(
  events: readonly unknown[] | undefined,
  recoverySteps: number = DEFAULT_RECOVERY_STEPS,
): boolean {
  if (!Array.isArray(events) || recoverySteps <= 0) return false;
  const seen = new Set<string>();
  let steps = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as
      | { type?: string; data?: { turn?: number; step?: number; error?: unknown } }
      | undefined;
    if (event?.type !== "tool/result" || event.data === undefined) continue;
    const key = `${event.data.turn}:${event.data.step}`;
    if (!seen.has(key)) {
      // A new step beyond the recovery window ends the scan; events for steps
      // already inside the window are still checked below.
      if (steps >= recoverySteps) break;
      seen.add(key);
      steps += 1;
    }
    if (event.data.error !== undefined && event.data.error !== null) return true;
  }
  return false;
}

/**
 * Resolve the reasoning effort to stamp for one request.
 *
 * Baseline is the route's `reasoningEffort`; when `escalateOnError` is enabled
 * and a recent step failed, the effort bumps to `escalateTo` (falling back to
 * the baseline when `escalateTo` is unset). Returns `undefined` to leave the
 * request's effort alone (inherit the session selection).
 *
 * @param route - the resolved route for the agent.
 * @param events - the agent's session event log.
 * @returns the effort to stamp, or `undefined` to inherit.
 */
export function effortFor(
  route: ModelRoute,
  events: readonly unknown[] | undefined,
): ReasoningEffort | undefined {
  if (route.escalateOnError === true && recentStepsHadError(events, route.recoverySteps)) {
    return route.escalateTo ?? route.reasoningEffort;
  }
  return route.reasoningEffort;
}
