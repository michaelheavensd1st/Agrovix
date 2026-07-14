'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';

function AcceptInviteInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'ok' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const token = params.get('token') ?? '';

  async function confirm() {
    if (!token) {
      setState('error');
      setError('Missing token');
      return;
    }
    try {
      await apiFetch('/v1/invitations/accept', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      setState('ok');
      setTimeout(() => router.push('/dashboard'), 900);
    } catch (err) {
      setState('error');
      setError(err instanceof ApiError ? (err.payload.detail ?? 'Failed to accept') : String(err));
    }
  }

  return (
    <main
      className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12"
      data-testid="accept-invite-page"
    >
      <h1 className="font-display text-3xl">Accept invitation</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Sign in first (if you have not already), then confirm below.
      </p>
      {state === 'ok' && (
        <p
          className="mt-6 rounded-md bg-primary/10 px-3 py-2 text-sm text-primary"
          data-testid="accept-invite-success"
        >
          Invitation accepted. Redirecting…
        </p>
      )}
      {state === 'error' && (
        <p
          className="mt-6 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="accept-invite-error"
        >
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={confirm}
        disabled={state === 'ok'}
        data-testid="accept-invite-button"
        className="mt-6 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition disabled:opacity-60"
      >
        Confirm invitation
      </button>
    </main>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={null}>
      <AcceptInviteInner />
    </Suspense>
  );
}
