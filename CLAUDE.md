# Yard Sale Gold

Fork of `wesbos/yard-sale`. A PWA that sends camera frames to an OpenAI agent (`gpt-5.6-luna` via `@openai/agents`) to identify and price yard-sale items. React + Vite on the client, a Cloudflare Worker (`yard-sale-gold`) with D1 and R2 on the server.

## Deployment facts

- Worker `yard-sale-gold`, custom domain `sales.tacodriven.dev`, behind Cloudflare Access (team `jeffro`). Unauthenticated requests get a 302 to the Access login page.
- Secrets: `OPENAI_API_KEY` (required). `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` are optional (the eBay tool is disabled without them).
- Every analysis, including failures, writes a row to D1 `frame_runs` (`status`, `error`). It is the first place to look when scans break:
  `npx wrangler d1 execute yard-sale-gold-db --remote --command "SELECT status, error, captured_at FROM frame_runs ORDER BY captured_at DESC LIMIT 10"`
- Agents: never deploy, run remote migrations, or change secrets or Access settings. Jeff does those.

## Commands

- `npm run dev`: Vite with the Cloudflare plugin (port 5173 by default; use another port if new-day-planner is running).
- `npm test`: vitest. Note: it loads `vite.config.ts` and the Cloudflare plugin, which tries to open a remote preview session and fails without account access. See STATUS / NEXT.
- `npm run deploy`: build + `wrangler deploy` (Jeff only).

## STATUS / NEXT

- **Status (2026-11-21):** Scans broke after 2026-10-07: no requests reached the Worker after that date. Cause: the Cloudflare Access session expires, and the installed PWA serves its cached shell, so the browser never gets the login redirect and every `/api` call fails. PR `agent/utilities-lead/access-reauth` detects the Access redirect and sends the browser through `/api/auth/refresh` to sign in again. It needs Jeff to deploy it.
- **Next:** Jeff deploys the reauth PR and does one scan from the installed PWA (checklist in the PR).
- **Then:** Make `npm test` run without the Cloudflare plugin (a separate `vitest.config.ts`). Open issues #1 and #2 (pricing accuracy).
