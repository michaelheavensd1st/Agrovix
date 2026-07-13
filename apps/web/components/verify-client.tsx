'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';

export function VerifyClient({ token }: { token: string }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'ok' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    try {
      await apiFetch('/v1/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      setState('ok');
      setTimeout(() => router.push('/login'), 1200);
    } catch (err) {
      setState('error');
      setError(err instanceof ApiError ? err.payload.detail ?? 'Verification failed' : 'Verification failed');
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-3">
      {state === 'ok' && (
        <p className="rounded-md bg-primary/10 px-3 py-2 text-sm text-primary" data-testid="verify-success">
          Email verified. Redirecting…
        </p>
      )}
      {state === 'error' && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="verify-error">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={confirm}
        disabled={state === 'ok'}
        data-testid="verify-confirm-button"
        className="rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition disabled:opacity-60"
      >
        Confirm verification
      </button>
    </div>
  );
}
