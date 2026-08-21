import { describe, expect, it } from "vitest";
import { roleFor, routeFor, type RouterConfig } from "../src/policy.js";

const CONFIG: RouterConfig = {
  planner: { provider: "deepseek-official", model: "deepseek-v4-pro" },
  executor: { provider: "deepseek-official", model: "deepseek-v4-flash" },
  mode: "strict",
  promptSection: true,
  skill: true,
};

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
  it("routes planners to pro in strict mode", () => {
    expect(routeFor({}, CONFIG)).toEqual({ provider: "deepseek-official", model: "deepseek-v4-pro" });
  });

  it("routes executors to flash", () => {
    expect(routeFor({ options: { subagentDepth: 1 } }, CONFIG)).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
  });

  it("passes through reasoningEffort and maxTokens when configured", () => {
    const config: RouterConfig = {
      ...CONFIG,
      planner: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high", maxTokens: 8192 },
    };
    expect(routeFor({}, config)).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      reasoningEffort: "high",
      maxTokens: 8192,
    });
  });

  it("in plan mode, routes the root to executor when not planning", () => {
    const config: RouterConfig = { ...CONFIG, mode: "plan" };
    expect(routeFor({}, config, false)).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
  });

  it("in plan mode, keeps the root on the planner route while planning", () => {
    const config: RouterConfig = { ...CONFIG, mode: "plan" };
    expect(routeFor({}, config, true)).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
  });

  it("in plan mode, executors stay on the executor route regardless", () => {
    const config: RouterConfig = { ...CONFIG, mode: "plan" };
    expect(routeFor({ options: { subagentDepth: 1 } }, config, true)).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
  });

  it("returns undefined for unknown roles (defensive)", () => {
    const config = { ...CONFIG } as Partial<RouterConfig>;
    delete (config as { planner?: RouterConfig["planner"] }).planner;
    expect(routeFor({}, config as RouterConfig)).toBeUndefined();
  });
});
