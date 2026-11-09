import { describe, expect, it } from "vitest";
import { Config } from "../src/index.js";
import {
  effortFor,
  recentStepsHadError,
  roleFor,
  routeFor,
  type ModelRoute,
  type RouterConfig,
} from "../src/policy.js";

const CONFIG: RouterConfig = {
  planner: { provider: "deepseek-official", model: "planner-model" },
  executor: { provider: "deepseek-official", model: "executor-model" },
  mode: "strict",
  enabled: true,
  promptSection: true,
  skill: true,
  vision: {
    enabled: false,
    provider: "deepseek-official",
    model: "deepseek-flash",
  },
};

const PLANNER_ROUTE = { provider: "deepseek-official", model: "planner-model" };
const EXECUTOR_ROUTE = { provider: "deepseek-official", model: "executor-model" };

describe("Config", () => {
  it("defaults enabled to true", () => {
    expect(Config({}).enabled).toBe(true);
  });

  it("honors enabled: false", () => {
    expect(Config({ enabled: false }).enabled).toBe(false);
  });

  it("keeps existing defaults when enabled is absent", () => {
    const cfg = Config({});
    expect(cfg.mode).toBe("strict");
    expect(cfg.promptSection).toBe(true);
    expect(cfg.skill).toBe(true);
    expect(cfg.planner.model).toBe("deepseek-flash");
    expect(cfg.executor.model).toBe("deepseek-flash");
  });
});

describe("Config partial routes", () => {
  it("fills provider from the default when only planner.model is set", () => {
    const planner = Config({ planner: { model: "deepseek-v4-pro" } }).planner;
    expect(planner.provider).toBe("deepseek-official");
    expect(planner.model).toBe("deepseek-v4-pro");
  });

  it("fills model and provider from defaults when only executor.reasoningEffort is set", () => {
    const executor = Config({ executor: { reasoningEffort: "low" } }).executor;
    expect(executor.model).toBe("deepseek-flash");
    expect(executor.provider).toBe("deepseek-official");
    expect(executor.reasoningEffort).toBe("low");
  });
});

describe("roleFor", () => {
  it("classifies a root agent without delegation markers as planner", () => {
    expect(roleFor({ options: {}, session: { header: {} } })).toBe("planner");
    expect(roleFor({})).toBe("planner");
    expect(roleFor(undefined)).toBe("planner");
  });

  it("classifies an agent with subagentDepth >= 1 as executor", () => {
    expect(roleFor({ options: { subagentDepth: 1 } })).toBe("executor");
    expect(roleFor({ options: { subagentDepth: 3 } })).toBe("executor");
  });

  it("classifies an agent whose session header origin is subagent as executor", () => {
    expect(roleFor({ session: { header: { origin: "subagent" } } })).toBe("executor");
  });

  it("does not treat depth 0 or other origins as executors", () => {
    expect(roleFor({ options: { subagentDepth: 0 } })).toBe("planner");
    expect(roleFor({ session: { header: { origin: "session" } } })).toBe("planner");
  });

  it("prefers a numeric depth marker when both markers disagree", () => {
    expect(roleFor({ options: { subagentDepth: 2 }, session: { header: { origin: "session" } } })).toBe("executor");
  });
});

describe("routeFor", () => {
  it("routes the root (planner) agent to the planner route in strict mode", () => {
    expect(routeFor({}, CONFIG)).toEqual(PLANNER_ROUTE);
  });

  it("routes subagents to the executor route, distinct from the planner route", () => {
    expect(routeFor({ options: { subagentDepth: 1 } }, CONFIG)).toEqual(EXECUTOR_ROUTE);
    expect(routeFor({}, CONFIG)?.model).not.toBe(routeFor({ options: { subagentDepth: 1 } }, CONFIG)?.model);
  });

  it("passes through reasoningEffort and maxTokens when configured", () => {
    const config: RouterConfig = {
      ...CONFIG,
      planner: { provider: "deepseek-official", model: "planner-model", reasoningEffort: "high", maxTokens: 8192 },
    };
    expect(routeFor({}, config)).toEqual({
      provider: "deepseek-official",
      model: "planner-model",
      reasoningEffort: "high",
      maxTokens: 8192,
    });
  });

  it("in plan mode, routes the root to the executor route when not planning", () => {
    const config: RouterConfig = { ...CONFIG, mode: "plan" };
    expect(routeFor({}, config, false)).toEqual(EXECUTOR_ROUTE);
  });

  it("in plan mode, keeps the root on the planner route while planning", () => {
    const config: RouterConfig = { ...CONFIG, mode: "plan" };
    expect(routeFor({}, config, true)).toEqual(PLANNER_ROUTE);
  });

  it("in plan mode, executors stay on the executor route regardless of planning", () => {
    const config: RouterConfig = { ...CONFIG, mode: "plan" };
    expect(routeFor({ options: { subagentDepth: 1 } }, config, true)).toEqual(EXECUTOR_ROUTE);
    expect(routeFor({ options: { subagentDepth: 1 } }, config, false)).toEqual(EXECUTOR_ROUTE);
  });

  it("returns undefined for unknown roles (defensive)", () => {
    const config = { ...CONFIG } as Partial<RouterConfig>;
    delete (config as { planner?: RouterConfig["planner"] }).planner;
    expect(routeFor({}, config as RouterConfig)).toBeUndefined();
  });
});

describe("recentStepsHadError", () => {
  const toolResult = (turn: number, step: number, error?: unknown) =>
    error === undefined
      ? { type: "tool/result", data: { turn, step, message: {} } }
      : { type: "tool/result", data: { turn, step, message: {}, error } };

  it("returns false for no events or non-arrays", () => {
    expect(recentStepsHadError(undefined)).toBe(false);
    expect(recentStepsHadError([])).toBe(false);
    expect(recentStepsHadError(undefined as never, 1)).toBe(false);
  });

  it("detects an error in the most recent step", () => {
    const events = [
      toolResult(1, 1),
      toolResult(1, 2, { name: "SandboxUnavailableError" }),
    ];
    expect(recentStepsHadError(events)).toBe(true);
  });

  it("respects the recovery window", () => {
    const events = [
      toolResult(1, 1, { name: "Oops" }),
      toolResult(1, 2),
      toolResult(1, 3),
    ];
    // Window of 2: the error at step 1 is out of range; the last two steps are clean.
    expect(recentStepsHadError(events, 2)).toBe(false);
    // Window of 3: the error at step 1 is in range.
    expect(recentStepsHadError(events, 3)).toBe(true);
  });

  it("deduplicates repeated tool results for the same step", () => {
    const events = [
      toolResult(1, 2, { name: "Oops" }),
      toolResult(1, 2),
    ];
    // Both events describe step (1,2); the error must still be found even
    // though the step counts only once toward the window.
    expect(recentStepsHadError(events, 1)).toBe(true);
  });

  it("ignores non-tool events", () => {
    const events = [
      { type: "assistant/message", data: {} },
      { type: "tool/result", data: { turn: 1, step: 1, message: {} } },
    ];
    expect(recentStepsHadError(events)).toBe(false);
  });
});

describe("effortFor", () => {
  const route: ModelRoute = {
    provider: "deepseek-official",
    model: "deepseek-flash",
    reasoningEffort: "high",
  };

  it("uses the baseline when escalation is off", () => {
    expect(effortFor(route, [{ type: "tool/result", data: { turn: 1, step: 1, error: {} } }])).toBe("high");
  });

  it("escalates to escalateTo after a recent error", () => {
    const escalating: ModelRoute = { ...route, escalateOnError: true, escalateTo: "max" };
    const events = [{ type: "tool/result", data: { turn: 1, step: 1, error: {} } }];
    expect(effortFor(escalating, events)).toBe("max");
  });

  it("falls back to the baseline when escalateTo is unset", () => {
    const escalating: ModelRoute = { ...route, escalateOnError: true };
    const events = [{ type: "tool/result", data: { turn: 1, step: 1, error: {} } }];
    expect(effortFor(escalating, events)).toBe("high");
  });

  it("stays at baseline when the recent window is clean", () => {
    const escalating: ModelRoute = { ...route, escalateOnError: true, escalateTo: "max" };
    const events = [{ type: "tool/result", data: { turn: 1, step: 1, message: {} } }];
    expect(effortFor(escalating, events)).toBe("high");
  });
});
