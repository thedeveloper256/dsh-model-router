import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ModelRouter, buildSkillContent, resolveConfig } from "../src/index.js";

type Listener = (...args: unknown[]) => unknown;

interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
}

interface Selection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

interface PromptSection {
  name: string;
  order: number;
  text: string;
}

interface RegisteredSkill {
  name: string;
  description: string;
  whenToUse?: string;
  content: string;
  source: string;
}

let seq = 0;

/** Build a session event in the harness shape: `{ type, seq, time, data }`. */
function sessionEvent(type: string, data: Record<string, unknown> = {}): SessionEvent {
  seq += 1;
  return { type, seq, time: 1_700_000_000_000 + seq, data };
}

function textUserMessage(): SessionEvent {
  return sessionEvent("user/message", {
    role: "user",
    content: [{ type: "text", text: "hi" }],
  });
}

function imageUserMessage(): SessionEvent {
  return sessionEvent("user/message", {
    role: "user",
    content: [
      { type: "text", text: "look at this" },
      { type: "image", attachment: { bytes: "abc" } },
    ],
  });
}

function toolResult(turn: number, step: number, error?: unknown): SessionEvent {
  const data: Record<string, unknown> = { turn, step, message: {} };
  if (error !== undefined) data.error = error;
  return sessionEvent("tool/result", data);
}

function stepEnd(turn: number, step: number): SessionEvent {
  return sessionEvent("step/end", { turn, step });
}

function makeFakeCtx() {
  const listeners = new Map<string, Listener[]>();
  const captured: { prompt?: PromptSection; skill?: RegisteredSkill } = {};
  const settingsConfigure = vi.fn((_options: { auto?: boolean }, _owner?: unknown) => vi.fn());
  const effect = vi.fn((execute: () => () => void) => {
    execute();
  });
  const fakeCtx = {
    reflect: { provide: vi.fn() },
    fiber: { id: "test-fiber" },
    inject: vi.fn((_deps: string[], cb: (child: unknown) => void) => {
      cb({
        effect,
        settings: { configure: settingsConfigure },
      });
    }),
    systemPrompt: {
      section: vi.fn((section: PromptSection) => {
        captured.prompt = section;
        return vi.fn();
      }),
    },
    skills: {
      register: vi.fn((skill: RegisteredSkill) => {
        captured.skill = skill;
        return vi.fn();
      }),
    },
    on: vi.fn((event: string, listener: Listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return vi.fn();
    }),
  };
  return { fakeCtx, listeners, captured, settingsConfigure, effect };
}

function makeHarness(config: unknown = {}) {
  const ctx = makeFakeCtx();
  // eslint-disable-next-line no-new
  new ModelRouter(ctx.fakeCtx as never, config);
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of ctx.listeners.get(event) ?? []) listener(...args);
  };
  return { ...ctx, emit };
}

interface AgentInit {
  subagentDepth?: number;
  origin?: string;
  events?: SessionEvent[];
  maxTokens?: number;
  current?: Selection;
}

function makeAgent(init: AgentInit = {}) {
  const events = init.events ?? [];
  const select = vi.fn((_selection: Selection): void => {});
  const current = vi.fn((): Selection | undefined => init.current);
  const options: { subagentDepth?: number; maxTokens?: number } = {};
  if (init.subagentDepth !== undefined) options.subagentDepth = init.subagentDepth;
  if (init.maxTokens !== undefined) options.maxTokens = init.maxTokens;
  const header: { origin?: string } = {};
  if (init.origin !== undefined) header.origin = init.origin;
  const session = {
    header,
    events,
    snapshotEvents: (): readonly SessionEvent[] => events,
  };
  const agent = { options, session, model: { current, select } };
  return { agent, events, select, current, options, session };
}

function dispatch(
  harness: Pick<ReturnType<typeof makeHarness>, "emit">,
  fixture: ReturnType<typeof makeAgent>,
  event: SessionEvent,
): void {
  fixture.events.push(event);
  harness.emit("session/event", fixture.session, event);
}

const ROUTES = {
  planner: { provider: "p", model: "planner-m" },
  executor: { provider: "p", model: "executor-m" },
};

describe("router lifecycle", () => {
  it("registers one listener per host event and turns off the generated settings page", () => {
    const harness = makeHarness();

    expect(harness.listeners.get("agent/created")).toHaveLength(1);
    expect(harness.listeners.get("agent/disposed")).toHaveLength(1);
    expect(harness.listeners.get("session/event")).toHaveLength(1);
    expect(harness.fakeCtx.inject).toHaveBeenCalledWith(["settings"], expect.any(Function));
    expect(harness.effect).toHaveBeenCalledTimes(1);
    expect(harness.settingsConfigure).toHaveBeenCalledWith({ auto: false }, harness.fakeCtx.fiber);
  });
});

describe("creation routing", () => {
  it("selects the planner route for a root agent and the executor route for subagents", () => {
    const harness = makeHarness(ROUTES);

    const root = makeAgent();
    harness.emit("agent/created", { agent: root.agent, source: "startup" });
    expect(root.select).toHaveBeenCalledTimes(1);
    expect(root.select).toHaveBeenCalledWith({ provider: "p", model: "planner-m" });

    const depthSub = makeAgent({ subagentDepth: 1 });
    harness.emit("agent/created", { agent: depthSub.agent, source: "startup" });
    expect(depthSub.select).toHaveBeenCalledWith({ provider: "p", model: "executor-m" });

    const originSub = makeAgent({ origin: "subagent" });
    harness.emit("agent/created", { agent: originSub.agent, source: "startup" });
    expect(originSub.select).toHaveBeenCalledWith({ provider: "p", model: "executor-m" });
  });

  it("records the decision on resume without selecting", () => {
    const harness = makeHarness({ ...ROUTES, mode: "plan" });
    const root = makeAgent();
    harness.emit("agent/created", { agent: root.agent, source: "resume" });
    expect(root.select).not.toHaveBeenCalled();

    // The decision is recorded: a same-route event still does not select.
    dispatch(harness, root, textUserMessage());
    expect(root.select).not.toHaveBeenCalled();

    // A real route transition after resume does select.
    dispatch(harness, root, sessionEvent("plan/mode", { active: true }));
    expect(root.select).toHaveBeenCalledWith({ provider: "p", model: "planner-m" });
  });

  it("does not select when current() already equals the decision", () => {
    const harness = makeHarness(ROUTES);
    const root = makeAgent({
      current: { provider: "p", model: "planner-m", reasoningEffort: "low" },
    });
    harness.emit("agent/created", { agent: root.agent, source: "startup" });

    expect(root.current).toHaveBeenCalledTimes(1);
    expect(root.select).not.toHaveBeenCalled();
  });

  it("pins the route effort and otherwise inherits the current effort", () => {
    const pinnedHarness = makeHarness({
      planner: { provider: "p", model: "planner-m", reasoningEffort: "high" },
    });
    const pinned = makeAgent({
      current: { provider: "session-p", model: "session-m", reasoningEffort: "low" },
    });
    pinnedHarness.emit("agent/created", { agent: pinned.agent, source: "startup" });
    expect(pinned.select).toHaveBeenCalledWith({
      provider: "p",
      model: "planner-m",
      reasoningEffort: "high",
    });

    const inheritedHarness = makeHarness({ planner: { provider: "p", model: "planner-m" } });
    const inherited = makeAgent({
      current: { provider: "session-p", model: "session-m", reasoningEffort: "low" },
    });
    inheritedHarness.emit("agent/created", { agent: inherited.agent, source: "startup" });
    expect(inherited.select).toHaveBeenCalledWith({
      provider: "p",
      model: "planner-m",
      reasoningEffort: "low",
    });

    const absentHarness = makeHarness({ planner: { provider: "p", model: "planner-m" } });
    const absent = makeAgent();
    absentHarness.emit("agent/created", { agent: absent.agent, source: "startup" });
    const selection = absent.select.mock.calls[0]?.[0];
    expect(selection).toEqual({ provider: "p", model: "planner-m" });
    expect(Object.hasOwn(selection!, "reasoningEffort")).toBe(false);
  });

  it("assigns the route maxTokens to the agent options", () => {
    const harness = makeHarness({
      planner: { provider: "p", model: "planner-m", maxTokens: 4096 },
    });
    const root = makeAgent({ maxTokens: 999 });
    harness.emit("agent/created", { agent: root.agent, source: "startup" });

    expect(root.options.maxTokens).toBe(4096);
    expect(root.select).toHaveBeenCalledWith({ provider: "p", model: "planner-m" });
  });

  it("leaves maxTokens alone when the route does not set it", () => {
    const harness = makeHarness({ planner: { provider: "p", model: "planner-m" } });
    const root = makeAgent({ maxTokens: 999 });
    harness.emit("agent/created", { agent: root.agent, source: "startup" });

    expect(root.options.maxTokens).toBe(999);
  });

  it("fills the provider from the schema default when only the model is configured", () => {
    const harness = makeHarness({ planner: { model: "only-model" } });
    const root = makeAgent();
    harness.emit("agent/created", { agent: root.agent, source: "startup" });

    expect(root.select).toHaveBeenCalledWith({
      provider: "deepseek-official",
      model: "only-model",
    });
  });
});

describe("session event routing", () => {
  it("switches the root between executor and planner as plan mode toggles", () => {
    const harness = makeHarness({ ...ROUTES, mode: "plan" });
    const root = makeAgent();
    harness.emit("agent/created", { agent: root.agent, source: "startup" });
    expect(root.select).toHaveBeenCalledWith({ provider: "p", model: "executor-m" });

    dispatch(harness, root, sessionEvent("plan/mode", { active: true }));
    expect(root.select).toHaveBeenLastCalledWith({ provider: "p", model: "planner-m" });

    dispatch(harness, root, sessionEvent("plan/mode", { active: true }));
    dispatch(harness, root, sessionEvent("plan/mode", { active: false }));

    expect(root.select.mock.calls.map((call) => call[0].model)).toEqual([
      "executor-m",
      "planner-m",
      "executor-m",
    ]);
  });

  it("uses the planner route at creation when plan mode is already active", () => {
    const harness = makeHarness({ ...ROUTES, mode: "plan" });
    const root = makeAgent({ events: [sessionEvent("plan/mode", { active: true })] });
    harness.emit("agent/created", { agent: root.agent, source: "startup" });

    expect(root.select).toHaveBeenCalledWith({ provider: "p", model: "planner-m" });
  });

  it("does not re-select when repeated events leave the decision unchanged", () => {
    const harness = makeHarness(ROUTES);
    const root = makeAgent();
    harness.emit("agent/created", { agent: root.agent, source: "startup" });
    expect(root.select).toHaveBeenCalledTimes(1);

    const message = textUserMessage();
    dispatch(harness, root, message);
    dispatch(harness, root, message);
    dispatch(
      harness,
      root,
      sessionEvent("user/message", {
        role: "user",
        content: [{ type: "text", text: "again" }],
      }),
    );

    expect(root.select).toHaveBeenCalledTimes(1);
  });

  it("switches to the vision route when a user message carries an image", () => {
    const harness = makeHarness({
      ...ROUTES,
      vision: { enabled: true, provider: "vp", model: "vision-m" },
    });
    const root = makeAgent();
    harness.emit("agent/created", { agent: root.agent, source: "startup" });

    dispatch(harness, root, textUserMessage());
    expect(root.select).toHaveBeenCalledTimes(1);

    dispatch(harness, root, imageUserMessage());
    expect(root.select).toHaveBeenLastCalledWith({ provider: "vp", model: "vision-m" });
    expect(root.select.mock.calls.map((call) => call[0].model)).toEqual([
      "planner-m",
      "vision-m",
    ]);
  });

  it("stays on the role route when vision is disabled", () => {
    const harness = makeHarness({
      ...ROUTES,
      vision: { enabled: false, provider: "vp", model: "vision-m" },
    });
    const root = makeAgent();
    harness.emit("agent/created", { agent: root.agent, source: "startup" });

    dispatch(harness, root, imageUserMessage());

    expect(root.select).toHaveBeenCalledTimes(1);
    expect(root.select).toHaveBeenCalledWith({ provider: "p", model: "planner-m" });
  });

  it("escalates effort after an error and wears off after the recovery window", () => {
    const harness = makeHarness({
      planner: {
        provider: "p",
        model: "planner-m",
        reasoningEffort: "low",
        escalateOnError: true,
        escalateTo: "high",
        recoverySteps: 2,
      },
    });
    const root = makeAgent();
    harness.emit("agent/created", { agent: root.agent, source: "startup" });
    expect(root.select).toHaveBeenLastCalledWith({
      provider: "p",
      model: "planner-m",
      reasoningEffort: "low",
    });

    dispatch(harness, root, toolResult(1, 1, { name: "SandboxUnavailableError" }));
    expect(root.select).toHaveBeenLastCalledWith({
      provider: "p",
      model: "planner-m",
      reasoningEffort: "high",
    });

    // The first clean step is still inside the two-step recovery window.
    dispatch(harness, root, toolResult(1, 2));
    dispatch(harness, root, stepEnd(1, 2));
    expect(root.select).toHaveBeenLastCalledWith({
      provider: "p",
      model: "planner-m",
      reasoningEffort: "high",
    });

    // The second clean step pushes the failure out of the window.
    dispatch(harness, root, toolResult(1, 3));
    dispatch(harness, root, stepEnd(1, 3));
    expect(root.select).toHaveBeenLastCalledWith({
      provider: "p",
      model: "planner-m",
      reasoningEffort: "low",
    });

    expect(root.select.mock.calls.map((call) => call[0].reasoningEffort)).toEqual([
      "low",
      "high",
      "low",
    ]);
  });

  it("ignores event types that cannot change the route", () => {
    const harness = makeHarness({
      ...ROUTES,
      vision: { enabled: true, provider: "vp", model: "vision-m" },
    });
    const root = makeAgent();
    harness.emit("agent/created", { agent: root.agent, source: "startup" });

    dispatch(
      harness,
      root,
      sessionEvent("assistant/message", {
        message: {
          role: "assistant",
          content: [{ type: "image", attachment: { bytes: "abc" } }],
        },
      }),
    );
    dispatch(harness, root, sessionEvent("boundary", {}));
    dispatch(harness, root, sessionEvent("tool/call", {}));

    expect(root.select).toHaveBeenCalledTimes(1);
    expect(root.select).toHaveBeenCalledWith({ provider: "p", model: "planner-m" });
  });

  it("ignores events after the agent is disposed", () => {
    const harness = makeHarness({ ...ROUTES, mode: "plan" });
    const root = makeAgent();
    harness.emit("agent/created", { agent: root.agent, source: "startup" });
    expect(root.select).toHaveBeenCalledWith({ provider: "p", model: "executor-m" });

    harness.emit("agent/disposed", { agent: root.agent });
    dispatch(harness, root, sessionEvent("plan/mode", { active: true }));

    expect(root.select).toHaveBeenCalledTimes(1);
    expect(root.select).toHaveBeenCalledWith({ provider: "p", model: "executor-m" });
  });
});

describe("disabled config", () => {
  it("never selects and registers no prompt section or skill", () => {
    const harness = makeHarness({
      enabled: false,
      planner: { provider: "p", model: "planner-m", maxTokens: 4096 },
      executor: { provider: "p", model: "executor-m" },
      vision: { enabled: true, provider: "vp", model: "vision-m" },
    });

    expect(harness.captured.prompt).toBeUndefined();
    expect(harness.captured.skill).toBeUndefined();
    expect(harness.fakeCtx.systemPrompt.section).not.toHaveBeenCalled();
    expect(harness.fakeCtx.skills.register).not.toHaveBeenCalled();

    const root = makeAgent();
    harness.emit("agent/created", { agent: root.agent, source: "startup" });
    dispatch(harness, root, imageUserMessage());

    expect(root.select).not.toHaveBeenCalled();
    expect(root.options.maxTokens).toBeUndefined();
  });
});

describe("prompt and skill rendering", () => {
  it("renders the prompt section with the configured models", () => {
    const harness = makeHarness({
      planner: { model: "planner-model-x" },
      executor: { model: "executor-model-y" },
    });

    expect(harness.captured.prompt).toBeDefined();
    expect(harness.captured.prompt?.name).toBe("model-router");
    expect(harness.captured.prompt?.order).toBe(-50);
    expect(harness.captured.prompt?.text).toContain("planner-model-x");
    expect(harness.captured.prompt?.text).toContain("executor-model-y");
    expect(harness.captured.prompt?.text).not.toContain("Image-bearing");
  });

  it("adds the vision line to the prompt when vision is enabled", () => {
    const harness = makeHarness({ vision: { enabled: true, model: "vision-model-z" } });

    expect(harness.captured.prompt?.text).toContain(
      "Image-bearing requests route to vision-model-z.",
    );
  });

  it("templates the registered skill content from the configured routes", () => {
    const harness = makeHarness({
      planner: { model: "planner-model-x" },
      executor: { model: "executor-model-y" },
    });

    expect(harness.captured.skill?.content).toContain("planner-model-x");
    expect(harness.captured.skill?.content).toContain("executor-model-y");
  });

  it("says both roles produce the same model when planner and executor match", () => {
    const harness = makeHarness({
      planner: { model: "same-m" },
      executor: { model: "same-m" },
    });

    expect(harness.captured.skill?.content).toContain("Both roles produce `same-m`.");
  });
});

const SKILL_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "pro-flash-routing",
  "SKILL.md",
);

describe("pro-flash-routing SKILL.md drift guard", () => {
  it("keeps the skill body equal to buildSkillContent(resolveConfig({}))", () => {
    const raw = readFileSync(SKILL_PATH, "utf8").replace(/\r\n/g, "\n");
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    expect(body).toBe(buildSkillContent(resolveConfig({})).trim());
  });
});
