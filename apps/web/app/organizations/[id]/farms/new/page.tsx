'use client';

import { useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';

export default function FarmNewPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const orgId = params.id;

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/v1/organizations/${orgId}/farms`, {
        method: 'POST',
        body: JSON.stringify({ name, code }),
      });
      router.push(`/organizations/${orgId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.payload.detail ?? 'Failed to create farm' : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12"
      data-testid="farm-new-page"
    >
      <p className="text-xs uppercase tracking-widest text-muted-foreground">Step 2 of 2</p>
      <h1 className="mt-2 font-display text-3xl">Add your first farm</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        A farm is an operational unit inside your organization.
      </p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4" data-testid="farm-new-form">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Farm name</span>
          <input
            required
            minLength={2}
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="farm-new-name-input"
            className="rounded-md border border-input bg-background px-3 py-2 outline-none ring-ring focus:ring-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Farm code (short identifier)</span>
          <input
            required
            minLength={1}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            data-testid="farm-new-code-input"
            className="rounded-md border border-input bg-background px-3 py-2 outline-none ring-ring focus:ring-2"
          />
        </label>
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="farm-new-error">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          data-testid="farm-new-submit-button"
          className="mt-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition disabled:opacity-60"
        >
          {submitting ? 'Creating…' : 'Create farm'}
        </button>
      </form>
    </main>
  );
}
