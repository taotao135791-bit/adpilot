import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  MessageBody,
  classifyTimelineUpdate,
  copyCodeText,
  isConversationNearLatest,
  isSafeMarkdownHref,
  parseInlineMarkdown,
  parseMessageBlocks,
  shouldFollowConversation
} from "../apps/desktop/src/components/ConversationFeed.js";

describe("conversation scroll policy", () => {
  it("recognizes the latest edge with a small layout tolerance", () => {
    expect(isConversationNearLatest({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 540 })).toBe(true);
    expect(isConversationNearLatest({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 400 })).toBe(false);
  });

  it("follows initial, replaced, and near-latest updates without stealing an upward reader", () => {
    expect(classifyTimelineUpdate([], ["m1"])).toBe("initial");
    expect(classifyTimelineUpdate(["m1"], ["m1", "m2"])).toBe("append");
    expect(classifyTimelineUpdate(["m1"], ["m2"])).toBe("replace");
    expect(classifyTimelineUpdate(["m1", "m3"], ["m1", "m2", "m3"])).toBe("mutate");
    expect(shouldFollowConversation("append", false, false)).toBe(false);
    expect(shouldFollowConversation("append", true, false)).toBe(true);
    expect(shouldFollowConversation("unchanged", false, true)).toBe(true);
  });
});

describe("safe message Markdown", () => {
  it("parses paragraphs, lists, headings, and fenced code with internal blank lines", () => {
    expect(parseMessageBlocks([
      "# Result",
      "",
      "- first",
      "- second",
      "",
      "```ts",
      "const first = 1;",
      "",
      "const second = 2;",
      "```"
    ].join("\n"))).toEqual([
      { kind: "heading", content: "Result" },
      { kind: "unordered-list", items: ["first", "second"] },
      { kind: "code", language: "ts", content: "const first = 1;\n\nconst second = 2;" }
    ]);
  });

  it("recognizes bold, inline code, and only explicit safe link schemes", () => {
    expect(parseInlineMarkdown("Use **care** with `rm` and [docs](https://example.com)."))
      .toEqual([
        { kind: "text", content: "Use " },
        { kind: "strong", content: "care" },
        { kind: "text", content: " with " },
        { kind: "code", content: "rm" },
        { kind: "text", content: " and " },
        { kind: "link", content: "docs", href: "https://example.com" },
        { kind: "text", content: "." }
      ]);
    expect(isSafeMarkdownHref("http://example.com")).toBe(true);
    expect(isSafeMarkdownHref("mailto:ops@example.com")).toBe(true);
    expect(isSafeMarkdownHref("javascript:alert(1)")).toBe(false);
    expect(isSafeMarkdownHref("/relative/path")).toBe(false);
  });

  it("renders escaped content and never turns an unsafe scheme into a link", () => {
    const content = [
      "**Safe** `inline` [Docs](https://example.com) [Bad](javascript:alert(1))",
      "",
      "```html",
      "<script>not executable</script>",
      "```"
    ].join("\n");
    const markup = renderToStaticMarkup(createElement(MessageBody, { locale: "en", content }));
    expect(markup).toContain("<strong>Safe</strong>");
    expect(markup).toContain("<code>inline</code>");
    expect(markup).toContain('href="https://example.com"');
    expect(markup).not.toContain('href="javascript:');
    expect(markup).toContain("[Bad](javascript:alert(1))");
    expect(markup).toContain("&lt;script&gt;not executable&lt;/script&gt;");
    expect(markup).toContain("Copy code");
  });

  it("copies code through the injected clipboard boundary", async () => {
    const writeText = vi.fn(async () => undefined);
    await expect(copyCodeText("const answer = 42;", { writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    await expect(copyCodeText("x", { writeText: async () => { throw new Error("denied"); } })).resolves.toBe(false);
  });
});
