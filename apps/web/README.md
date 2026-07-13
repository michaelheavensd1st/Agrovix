# Web (`apps/web`)

Next.js 14 (App Router) shell for Agrovix AgOS.

## Local dev

```bash
pnpm install
pnpm --filter @agrovix/web dev
# → http://localhost:3000
```

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
pnpm dev          # local dev server
pnpm build        # production build
pnpm start        # production server
pnpm lint         # eslint
pnpm type-check   # tsc --noEmit
pnpm test         # vitest
```
