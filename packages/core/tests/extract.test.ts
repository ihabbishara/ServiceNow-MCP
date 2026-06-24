import { describe, it, expect } from "vitest";
import { extractPage } from "../src/clients/crawler/extract.js";

const html = `<!doctype html><html><head><title>Runbook: Restart</title></head>
<body>
  <nav><a href="/login">Login</a></nav>
  <article><h1>Restart Service</h1><p>Step one. Step two with enough words to be real content here.</p>
  <a href="/runbooks/db">DB runbook</a><a href="https://other.io/x">external</a></article>
</body></html>`;

describe("extractPage", () => {
  it("extracts title, main text and resolves absolute links", () => {
    const doc = extractPage(html, "https://wiki.acme.io/runbooks/restart");
    expect(doc.title).toContain("Restart");
    expect(doc.mainText).toContain("Step one");
    expect(doc.links).toContain("https://wiki.acme.io/runbooks/db");
    expect(doc.links).toContain("https://wiki.acme.io/login");
    expect(doc.links).toContain("https://other.io/x");
  });

  it("dedupes links and drops non-http(s) schemes", () => {
    const doc = extractPage(
      `<a href="mailto:x@y.z">m</a><a href="/a">a</a><a href="/a">a2</a>`,
      "https://h/p"
    );
    expect(doc.links.filter((l) => l === "https://h/a")).toHaveLength(1);
    expect(doc.links.some((l) => l.startsWith("mailto"))).toBe(false);
  });
});
