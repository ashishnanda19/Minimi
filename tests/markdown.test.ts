import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../public/markdown.js";

const sources = [{ id: 1, title: "HubSpot Pricing", url: "https://www.hubspot.com/pricing" }];

describe("renderMarkdown", () => {
  it("renders the basics", () => {
    expect(renderMarkdown("**Yes.** It is `$20`/mo.")).toBe("<p><strong>Yes.</strong> It is <code>$20</code>/mo.</p>");
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("turns [n] into a source chip, and leaves unknown numbers as plain chips", () => {
    const html = renderMarkdown("Costs $20 [1][2].", sources);
    expect(html).toContain('<a class="cite" href="https://www.hubspot.com/pricing"');
    expect(html).toContain('<span class="cite">2</span>');
  });

  it("renders tables", () => {
    const html = renderMarkdown("| Tool | Change |\n|---|---|\n| A | None |");
    expect(html).toContain("<th>Tool</th>");
    expect(html).toContain("<td>None</td>");
  });

  it("cannot be used for XSS", () => {
    const evil = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[click](javascript:alert(1))',
      '[x](https://a.com" onmouseover="alert(1))',
      '`<b>code</b>`',
      '```\n<script>x</script>\n```',
    ];
    const allowedTag = /^<\/?(p|strong|em|code|pre|ul|ol|li|a|span|h\d|hr|br|table|thead|tbody|tr|th|td|div|blockquote)(\s(href|target|rel|class|title)="[^"<>]*")*\s*>$/;
    for (const e of evil) {
      const html = renderMarkdown(e, sources);
      for (const tag of html.match(/<[^>]*>/g) ?? []) expect(tag, `${e} -> ${html}`).toMatch(allowedTag);
      expect(html).not.toMatch(/href="javascript:/i);
    }
  });

  it("is safe on an unterminated code fence while streaming", () => {
    expect(renderMarkdown("```\nstill typing")).toBe("<pre><code>still typing</code></pre>");
  });
});
