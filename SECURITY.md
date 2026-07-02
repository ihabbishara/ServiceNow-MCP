# Security Policy

## Reporting a vulnerability

This is an internal SRE tool run locally per-engineer. To report a security
issue, contact the repository owner directly (do not open a public issue).

## Security posture

- Runs locally per-SRE; auth reuses the developer's `az login` + GitHub Copilot
  seat. Secrets live in a local `.env` (chmod 600), never committed.
- The web UI binds to `127.0.0.1` only and is single-user (see
  `packages/web/README.md`). It is not hardened for shared hosting; hardening
  is tracked in the enterprise-readiness roadmap (P2).
- Subprocess calls to `az`/`git` use `execFile` argument arrays (no shell).
