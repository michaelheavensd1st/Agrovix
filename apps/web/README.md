# Web (`apps/web`)

Next.js 14 (App Router) shell for Agrovix AgOS.

## Compose-managed local development

```bash
scripts/dev/start.sh
scripts/dev/status.sh
# → http://localhost:3000
```

Run these commands from the repository root. The browser calls `/api-proxy`, and the Next.js
server forwards requests to `http://api:8000/api` over the Compose network. This preserves
same-origin HTTP-only cookies and removes any normal browser dependency on port 8000.

For optional host-only Next.js development, use `pnpm dev:web`. The default proxy target is
`http://127.0.0.1:8000`; override it with `API_PROXY_TARGET` if the API is elsewhere. Do not add
`/api` to the target—the rewrite supplies that path.

Useful runtime commands:

```bash
scripts/dev/logs.sh web
scripts/dev/stop.sh       # preserves PostgreSQL and Redis data
scripts/dev/start.sh      # safe to repeat and recover
scripts/dev/start.sh --build  # required after dependency or Dockerfile changes
```

Compose mounts application and shared-package source for hot reload, keeps `.next` in a
container-only volume, and uses dependencies installed in the image. It does not run
`pnpm install` at startup.

## Routes

| Route        | File                     | Purpose                    |
| ------------ | ------------------------ | -------------------------- |
| `/`          | `app/page.tsx`           | Landing                    |
| `/login`     | `app/login/page.tsx`     | Login form                 |
| `/register`  | `app/register/page.tsx`  | Registration form          |
| `/dashboard` | `app/dashboard/page.tsx` | Placeholder dashboard      |
| `*`          | `app/not-found.tsx`      | 404                        |

## Scripts

```
pnpm dev          # local web server (from apps/web only)
pnpm build        # production build
pnpm start        # production server
pnpm lint         # eslint
pnpm type-check   # tsc --noEmit
pnpm test         # vitest
```
