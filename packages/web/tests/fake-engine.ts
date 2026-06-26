// packages/web/tests/fake-engine.ts
// Shared minimal FakeEngine for routes.test.ts and server-boot.test.ts.
import { vi } from "vitest";

export class FakeEngine {
  constructor(
    public deps: any,
    sendImpl: (deps: any) => Promise<void> = async () => {},
  ) {
    this.send = vi.fn(async () => sendImpl(this.deps));
  }
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  abort = vi.fn(async () => {});
  getAuthStatus = vi.fn(async () => ({ isAuthenticated: true, authType: "user", login: "me" }));
  send: ReturnType<typeof vi.fn>;
}
