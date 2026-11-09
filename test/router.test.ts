import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@deepseek-ai/dsh-settings", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@deepseek-ai/dsh-settings")>();
  return {
    ...orig,
    installSettingsSection: vi.fn(),
  };
});

import { ModelRouter, buildSkillContent, resolveConfig } from "../src/index.js";

function makeFakeCtx() {
  const harnessListeners = new Map<string, ((...args: never[]) => unknown)[]>();
  const captured: { prompt?: { text: string }; skill?: { content: string } } = {};
  const fakeCtx = {
    reflect: { provide: vi.fn() },
    systemPrompt: {
      section: vi.fn((opts: { text: string }) => {
        captured.prompt = opts;
        return vi.fn();
      }),
    },
    skills: {
      register: vi.fn((skill: { content: string }) => {
        captured.skill = skill;
        return vi.fn();
      }),
    },
    on: vi.fn((event: string, listener: (...args: never[]) => unknown) => {
      const list = harnessListeners.get(event) ?? [];
      list.push(listener);
      harnessListeners.set(event, list);
      return vi.fn();
    }),
  };
  return { fakeCtx, harnessListeners, captured };
}

function makeFakeAgent() {
  const disposeRequest = vi.fn();
  return {
    agent: {
      ctx: { on: vi.fn(() => disposeRequest) },
      options: {},
      session: { header: {}, events: [] },
    },
    disposeRequest,
  };
}

/** Agent stub for request wiring: exposes the `agent/request` registration and its dispose. */
function makeAgent(options: { subagentDepth?: number } = {}, events: unknown[] = []) {
  const disposeRequest = vi.fn();
  const on = vi.fn((_event: string, _listener: unknown, _opts?: unknown) => disposeRequest);
  return { ctx: { on }, options, session: { header: {}, events }, disposeRequest };
}

type Next = () => Promise<Record<string, unknown>>;

const SESSION_RESOLVED = { provider: "session-p", model: "session-m", extra: 1 };

/** Runs the `agent/request` rewrite a router builds for `agent` over `resolved`. */
async function rewrite(
  config: unknown,
  agent: ReturnType<typeof makeAgent>,
  resolved: Record<string, unknown> = SESSION_RESOLVED,
): Promise<Record<string, unknown>> {
  const { fakeCtx } = makeFakeCtx();
  const router = new ModelRouter(fakeCtx as never, config);
  const next: Next = async () => resolved;
  return router.requestRewrite(agent as never)({}, next);
}

const SKILL_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "pro-flash-routing",
  "SKILL.md",
);

describe("router lifecycle (review fixes)", () => {
  it("registers exactly one global agent/disposed listener across many agents", () => {
    const { fakeCtx, harnessListeners } = makeFakeCtx();
    // eslint-disable-next-line no-new
    new ModelRouter(fakeCtx as never, {});
    const created = harnessListeners.get("agent/created");
    expect(created?.length).toBe(1);
    const onCreated = created![0]! as (payload: { agent: unknown }) => void;
    onCreated({ agent: makeFakeAgent().agent });
    onCreated({ agent: makeFakeAgent().agent });
    onCreated({ agent: makeFakeAgent().agent });
    expect(harnessListeners.get("agent/disposed")?.length).toBe(1);
  });

  it("disposes only the matching agent's request listener", () => {
    const { fakeCtx, harnessListeners } = makeFakeCtx();
    // eslint-disable-next-line no-new
    new ModelRouter(fakeCtx as never, {});
    const onCreated = harnessListeners.get("agent/created")![0]! as (payload: {
      agent: unknown;
    }) => void;
    const a = makeFakeAgent();
    const b = makeFakeAgent();
    onCreated({ agent: a.agent });
    onCreated({ agent: b.agent });
    const onDisposed = harnessListeners.get("agent/disposed")![0]! as (agent: unknown) => void;
    onDisposed({ agent: a.agent });
    expect(a.disposeRequest).toHaveBeenCalledTimes(1);
    expect(b.disposeRequest).not.toHaveBeenCalled();
    // Second dispose is a no-op (entry removed).
    onDisposed({ agent: a.agent });
    expect(a.disposeRequest).toHaveBeenCalledTimes(1);
  });

  it("templates the registered skill content from the configured routes", () => {
    const { fakeCtx, captured } = makeFakeCtx();
    // eslint-disable-next-line no-new
    new ModelRouter(fakeCtx as never, {
      planner: { provider: "p", model: "planner-model-x" },
      executor: { provider: "p", model: "executor-model-y" },
    });
    expect(captured.skill?.content).toContain("planner-model-x");
    expect(captured.skill?.content).toContain("executor-model-y");
  });
});

describe("agent/request wiring", () => {
  it("stamps the planner model on the root agent and the executor model on subagents", async () => {
    const config = { planner: { model: "planner-m" }, executor: { model: "executor-m" } };
    const root = await rewrite(config, makeAgent({}));
    expect(root.model).toBe("planner-m");
    expect(root.provider).toBe("deepseek-official");
    const sub = await rewrite(config, makeAgent({ subagentDepth: 1 }));
    expect(sub.model).toBe("executor-m");
    expect(sub.provider).toBe("deepseek-official");
    expect(sub.extra).toBe(1);
  });

  it("registers the rewrite with prepend on agent/created and routes through it", async () => {
    const { fakeCtx, harnessListeners } = makeFakeCtx();
    // eslint-disable-next-line no-new
    new ModelRouter(fakeCtx as never, {
      planner: { model: "planner-m" },
      executor: { model: "executor-m" },
    });
    const onCreated = harnessListeners.get("agent/created")![0]! as (payload: { agent: unknown }) => void;
    const sub = makeAgent({ subagentDepth: 1 });
    onCreated({ agent: sub });
    expect(sub.ctx.on.mock.calls[0]?.[0]).toBe("agent/request");
    expect(sub.ctx.on.mock.calls[0]?.[2]).toEqual({ prepend: true });
    const listener = sub.ctx.on.mock.calls[0]![1] as (
      p: Record<string, unknown>,
      next: Next,
    ) => Promise<Record<string, unknown>>;
    const result = await listener({}, async () => ({ ...SESSION_RESOLVED }));
    expect(result.model).toBe("executor-m");
  });

  it("returns the resolved object unchanged when enabled is false", async () => {
    const resolved = { provider: "session-p", model: "session-m", extra: 1 };
    const result = await rewrite({ enabled: false, planner: { model: "planner-m" } }, makeAgent(), resolved);
    expect(result).toBe(resolved);
  });

  it("stamps the vision model on a subagent whose session carries an image", async () => {
    const imageEvents = [
      {
        type: "user/message",
        data: { role: "user", content: [{ type: "image", attachment: { bytes: "abc" } }] },
      },
    ];
    const textEvents = [
      { type: "user/message", data: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ];
    const config = { vision: { enabled: true, model: "vision-m" }, executor: { model: "executor-m" } };
    const withImage = await rewrite(config, makeAgent({ subagentDepth: 1 }, imageEvents));
    expect(withImage.model).toBe("vision-m");
    const textOnly = await rewrite(config, makeAgent({ subagentDepth: 1 }, textEvents));
    expect(textOnly.model).toBe("executor-m");
  });

  it("stamps maxTokens and reasoningEffort only when the route sets them", async () => {
    const resolved = { provider: "session-p", model: "session-m", maxTokens: 999, reasoningEffort: "low" };
    const pinned = await rewrite(
      { planner: { maxTokens: 4096, reasoningEffort: "high" } },
      makeAgent(),
      resolved,
    );
    expect(pinned.maxTokens).toBe(4096);
    expect(pinned.reasoningEffort).toBe("high");

    // Unset on the route: the session's values are inherited, not overwritten.
    const inherited = await rewrite({}, makeAgent(), resolved);
    expect(inherited.maxTokens).toBe(999);
    expect(inherited.reasoningEffort).toBe("low");

    // Unset on both sides: the keys stay absent.
    const bare = await rewrite({}, makeAgent(), { provider: "session-p", model: "session-m" });
    expect(bare).not.toHaveProperty("maxTokens");
    expect(bare).not.toHaveProperty("reasoningEffort");
  });

  it("never stamps an undefined provider when only the model is configured", async () => {
    const result = await rewrite({ planner: { model: "only-model" } }, makeAgent());
    expect(result.provider).toBe("deepseek-official");
    expect(result.model).toBe("only-model");
  });
});

describe("dispose robustness", () => {
  it("disposes a bare (unwrapped) agent's request listener", () => {
    const { fakeCtx, harnessListeners } = makeFakeCtx();
    // eslint-disable-next-line no-new
    new ModelRouter(fakeCtx as never, {});
    const onCreated = harnessListeners.get("agent/created")![0]! as (payload: { agent: unknown }) => void;
    const onDisposed = harnessListeners.get("agent/disposed")![0]! as (payload: unknown) => void;
    const agent = makeAgent();
    onCreated({ agent });
    onDisposed(agent);
    expect(agent.disposeRequest).toHaveBeenCalledTimes(1);
    onDisposed(agent);
    expect(agent.disposeRequest).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an agent that was never created, and for undefined or null payloads", () => {
    const { fakeCtx, harnessListeners } = makeFakeCtx();
    // eslint-disable-next-line no-new
    new ModelRouter(fakeCtx as never, {});
    const onDisposed = harnessListeners.get("agent/disposed")![0]! as (payload: unknown) => void;
    const stranger = makeAgent();
    expect(() => onDisposed({ agent: stranger })).not.toThrow();
    expect(() => onDisposed(stranger)).not.toThrow();
    expect(() => onDisposed(undefined)).not.toThrow();
    expect(() => onDisposed(null)).not.toThrow();
    expect(stranger.disposeRequest).not.toHaveBeenCalled();
  });
});

describe("skill text", () => {
  it("says both roles produce the same model when planner and executor match", () => {
    const { fakeCtx, captured } = makeFakeCtx();
    // eslint-disable-next-line no-new
    new ModelRouter(fakeCtx as never, {
      planner: { model: "same-m" },
      executor: { model: "same-m" },
    });
    expect(captured.skill?.content).toContain("Both roles produce `same-m`.");
  });
});

describe("pro-flash-routing SKILL.md drift guard", () => {
  it("keeps the skill body equal to buildSkillContent(resolveConfig({}))", () => {
    const raw = readFileSync(SKILL_PATH, "utf8").replace(/\r\n/g, "\n");
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    expect(body).toBe(buildSkillContent(resolveConfig({})).trim());
  });
});
