import { describe, expect, it } from "vitest";
import { Config, sessionHasImage as sessionHasImageFromIndex } from "../src/index.js";
import { hasImageContent, sessionHasImage, shouldUseVision } from "../src/policy.js";

describe("hasImageContent", () => {
  it("returns false for non-arrays, empty arrays, and text-only messages", () => {
    expect(hasImageContent(undefined)).toBe(false);
    expect(hasImageContent(null)).toBe(false);
    expect(hasImageContent({})).toBe(false);
    expect(hasImageContent([])).toBe(false);
    expect(hasImageContent([{ content: "just some text" }])).toBe(false);
  });

  it("detects an image block in user content", () => {
    const messages = [
      { role: "user", content: "what is in this picture?" },
      {
        role: "user",
        content: [
          { type: "text", text: "see below" },
          { type: "image", image: "data:image/png;base64,AAAA" },
        ],
      },
    ];
    expect(hasImageContent(messages)).toBe(true);
  });

  it("detects an image nested inside a tool-result block", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "screenshot:" },
          {
            type: "tool-result",
            content: [{ type: "image", image: "data:image/png;base64,BBBB" }],
          },
        ],
      },
    ];
    expect(hasImageContent(messages)).toBe(true);
  });

  it("ignores string content and reasoning blocks", () => {
    const messages = [
      { role: "assistant", content: "a plain string, no blocks" },
      {
        role: "assistant",
        content: [{ type: "reasoning", content: "thinking hard" }],
      },
    ];
    expect(hasImageContent(messages)).toBe(false);
  });
});

describe("sessionHasImage", () => {
  const userMessage = (content: unknown) => ({
    type: "user/message",
    data: { role: "user", content },
  });
  const assistantMessage = (content: unknown) => ({
    type: "assistant/message",
    data: { message: { role: "assistant", content } },
  });

  it("returns false for undefined, non-arrays, and empty logs", () => {
    expect(sessionHasImage(undefined)).toBe(false);
    expect(sessionHasImage(null as never)).toBe(false);
    expect(sessionHasImage({} as never)).toBe(false);
    expect(sessionHasImage([])).toBe(false);
  });

  it("ignores text-only user/message events", () => {
    const events = [userMessage([{ type: "text", text: "hi" }])];
    expect(sessionHasImage(events)).toBe(false);
  });

  it("detects an image block in a user/message event", () => {
    const events = [
      userMessage([
        { type: "text", text: "see below" },
        { type: "image", attachment: { bytes: "abc" } },
      ]),
    ];
    expect(sessionHasImage(events)).toBe(true);
  });

  it("detects an image nested in a tool-result block of an assistant/message event", () => {
    const events = [
      assistantMessage([
        { type: "text", text: "screenshot:" },
        {
          type: "tool-result",
          content: [{ type: "image", attachment: { bytes: "abc" } }],
        },
      ]),
    ];
    expect(sessionHasImage(events)).toBe(true);
  });

  it("ignores unrelated event types", () => {
    const events = [
      { type: "chunk", data: { content: [{ type: "image", attachment: { bytes: "abc" } }] } },
      { type: "assistant/chunk", data: { chunk: { type: "block-end", index: 0, block: { type: "image", attachment: { bytes: "abc" } } } } },
      { type: "tool/call", data: { message: { content: [{ type: "image", attachment: { bytes: "abc" } }] } } },
      { type: "boundary", data: {} },
      { type: "turn/start", data: { turn: 1 } },
    ];
    expect(sessionHasImage(events)).toBe(false);
  });

  it("detects one image anywhere in a longer log", () => {
    const events = [
      { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "let me look" }] } } },
      { type: "tool/result", data: { message: {} } },
      { type: "user/message", data: { role: "user", content: [{ type: "text", text: "here" }, { type: "image", attachment: { bytes: "abc" } }] } },
    ];
    expect(sessionHasImage(events)).toBe(true);
  });
});

describe("sessionHasImage harness fidelity (review Issue 1)", () => {
  it("detects an image in a tool/result event (ToolResultMessage shape)", () => {
    const events = [
      {
        type: "tool/result",
        seq: 3,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "msg-1",
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                content: [
                  { type: "text", text: "screenshot:" },
                  { type: "image", attachment: { bytes: "abc" } },
                ],
              },
            ],
            source: { kind: "tool", callId: "call-1" },
          },
        },
      },
    ];
    expect(sessionHasImage(events)).toBe(true);
  });

  it("detects an image in a harness-faithful user/message event", () => {
    const events = [
      {
        type: "user/message",
        seq: 1,
        time: Date.now(),
        data: {
          id: "msg-u1",
          role: "user",
          content: [
            { type: "text", text: "see this" },
            { type: "image", attachment: { bytes: "abc" } },
          ],
          source: { kind: "user" },
        },
      },
    ];
    expect(sessionHasImage(events)).toBe(true);
  });

  it("detects an image in a harness-faithful assistant/message event", () => {
    const events = [
      {
        type: "assistant/message",
        seq: 2,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "msg-a1",
            role: "assistant",
            content: [
              { type: "text", text: "here" },
              { type: "image", attachment: { bytes: "abc" } },
            ],
            source: { provider: "deepseek-official", model: "deepseek-v4-pro", kind: "model" },
          },
        },
      },
    ];
    expect(sessionHasImage(events)).toBe(true);
  });

  it("returns false for a text-only tool/result event", () => {
    const events = [
      {
        type: "tool/result",
        seq: 3,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "msg-1",
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                content: [{ type: "text", text: "ok" }],
              },
            ],
            source: { kind: "tool", callId: "call-1" },
          },
        },
      },
    ];
    expect(sessionHasImage(events)).toBe(false);
  });
});

describe("shouldUseVision wiring helper (review Issue 2)", () => {
  const imageEvents = [
    { type: "user/message", data: { role: "user", content: [{ type: "image", attachment: {} }] } },
  ];
  const textEvents = [
    { type: "user/message", data: { role: "user", content: [{ type: "text", text: "hi" }] } },
  ];

  it("returns true only when vision is enabled and the log has an image", () => {
    expect(shouldUseVision(imageEvents, { enabled: true } as never)).toBe(true);
    expect(shouldUseVision(textEvents, { enabled: true } as never)).toBe(false);
    expect(shouldUseVision(imageEvents, { enabled: false } as never)).toBe(false);
    expect(shouldUseVision(undefined, { enabled: true } as never)).toBe(false);
  });

  it("is re-exported from the public entry alongside sessionHasImage", () => {
    expect(typeof sessionHasImageFromIndex).toBe("function");
    expect(sessionHasImageFromIndex(imageEvents)).toBe(true);
  });
});

describe("Config vision defaults", () => {
  it("defaults vision.enabled to false (opt-in)", () => {
    expect(Config({}).vision.enabled).toBe(false);
  });

  it("defaults vision.model to the vision model", () => {
    expect(Config({}).vision.model).toBe("deepseek-v4-flash-vision-exp");
  });
});
