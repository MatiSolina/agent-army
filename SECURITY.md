# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via [GitHub Security Advisories](https://github.com/MatiSolina/agent-army/security/advisories/new), or email matias@lookingfortrouble.ai.

We'll acknowledge within a few business days and keep you posted on the fix.

## Scope

This is a control-plane that deploys agents to Vercel and manages secrets. Of particular interest:

- Secret handling (Vercel project env is the source of truth; never logged or committed).
- The Supabase Auth access gate (`FLEET_OPERATOR_EMAIL`) and `proxy.ts` route enforcement.
- Code generators in `lib/eve/*` — interpolated values must be escaped to prevent injection into generated agent code.
