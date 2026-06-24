import { describe, it, expect } from "vitest";
import { isAllowed } from "../src/clients/crawler/robots.js";

const robots = `User-agent: *
Disallow: /private
Disallow: /admin
`;

describe("isAllowed", () => {
  it("allows paths not disallowed", () => {
    expect(isAllowed(robots, "/runbooks/db")).toBe(true);
  });
  it("blocks disallowed prefixes", () => {
    expect(isAllowed(robots, "/private/x")).toBe(false);
    expect(isAllowed(robots, "/admin")).toBe(false);
  });
  it("allows everything when robots is empty", () => {
    expect(isAllowed("", "/anything")).toBe(true);
  });
});
