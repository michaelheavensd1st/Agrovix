'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';

export default function OnboardingPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const org = await apiFetch<{ id: string }>('/v1/organizations', {
        method: 'POST',
        body: JSON.stringify({ name, slug: slug.toLowerCase() }),
      });
      router.push(`/organizations/${org.id}/farms/new`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.payload.detail ?? 'Failed to create organization')
          : String(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12"
      data-testid="onboarding-page"
    >
      <p className="text-xs uppercase tracking-widest text-muted-foreground">Step 1 of 2</p>
      <h1 className="mt-2 font-display text-3xl">Create your organization</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This is the top-level tenancy boundary for your farms and teams.
      </p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4" data-testid="onboarding-form">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Organization name</span>
          <input
            required
            minLength={2}
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="onboarding-name-input"
            className="rounded-md border border-input bg-background px-3 py-2 outline-none ring-ring focus:ring-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Slug (URL-safe)</span>
          <input
            required
            minLength={2}
            pattern="[a-z0-9][a-z0-9\-]*"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            data-testid="onboarding-slug-input"
            className="rounded-md border border-input bg-background px-3 py-2 outline-none ring-ring focus:ring-2"
          />
        </label>
        {error && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="onboarding-error"
          >
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          data-testid="onboarding-submit-button"
          className="mt-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition disabled:opacity-60"
        >
          {submitting ? 'Creating…' : 'Continue'}
        </button>
      </form>
    </main>
  );
}
