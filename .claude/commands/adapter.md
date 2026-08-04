---
description: Implement a new platform publish adapter
---

Implement a `PublishAdapter` for: $ARGUMENTS

Requirements:
1. Read `lib/adapters/types.ts` first and match the existing interface exactly.
2. Use the platform's **official documented API only**. If you are unsure of the
   current endpoint shape, say so rather than guessing — a wrong endpoint fails
   silently in production.
3. Read the OAuth token via `tokenSecretName` from Supabase Vault. Never accept
   a raw token as a parameter and never log it.
4. Handle the platform's rate limits and return clear, actionable error messages
   — the scheduler stores them in `post_targets.error_message`.
5. Implement `fetchMetrics` too if the platform exposes analytics.
6. Register the adapter in `lib/adapters/index.ts`.
7. Do NOT modify `app/api/cron/publish/route.ts`. If you think you need to, the
   abstraction is wrong — stop and explain why.
8. Run `npm run typecheck`, then open a PR.
