'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';

interface Organization {
  id: string;
  name: string;
  slug: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await apiFetch<Organization[]>('/v1/organizations');
        setOrgs(list);
        if (list.length === 0) router.push('/onboarding');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
        } else {
          setError(
            err instanceof ApiError ? (err.payload.detail ?? 'Failed to load') : String(err),
          );
        }
      }
    })();
  }, [router]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-12" data-testid="dashboard-page">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Sprint 1</p>
          <h1 className="font-display text-3xl">Your organizations</h1>
        </div>
        <Link
          href="/onboarding"
          data-testid="dashboard-new-org-link"
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary"
        >
          + New organization
        </Link>
      </div>

      {error && (
        <p
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="dashboard-error"
        >
          {error}
        </p>
      )}

      {orgs && orgs.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2" data-testid="dashboard-org-list">
          {orgs.map((o) => (
            <li key={o.id}>
              <Link
                href={`/organizations/${o.id}`}
                data-testid={`dashboard-org-${o.slug}`}
                className="block rounded-2xl border border-border bg-card/60 p-6 transition hover:border-primary/40 hover:shadow-md"
              >
                <p className="text-sm text-muted-foreground">{o.slug}</p>
                <p className="mt-1 text-lg font-semibold">{o.name}</p>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div
          data-testid="dashboard-empty-state"
          className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center"
        >
          <p className="font-display text-xl">Redirecting to onboarding…</p>
        </div>
      )}
    </main>
  );
}
