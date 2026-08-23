import { describe, expect, it } from "vitest";
import { Config } from "../src/index.js";
import { hasImageContent } from "../src/policy.js";

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

describe("Config vision defaults", () => {
  it("defaults vision.enabled to false (opt-in)", () => {
    expect(Config({}).vision.enabled).toBe(false);
  });

  it("defaults vision.model to the vision model", () => {
    expect(Config({}).vision.model).toBe("deepseek-v4-flash-vision-exp");
  });
});
