import { describe, expect, it, vi } from "vitest";

vi.mock("@deepseek-ai/dsh-settings", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@deepseek-ai/dsh-settings")>();
  return {
    ...orig,
    installSettingsSection: vi.fn(),
  };
});

import { ModelRouter } from "../src/index.js";

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
    onDisposed(a.agent);
    expect(a.disposeRequest).toHaveBeenCalledTimes(1);
    expect(b.disposeRequest).not.toHaveBeenCalled();
    // Second dispose is a no-op (entry removed).
    onDisposed(a.agent);
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
