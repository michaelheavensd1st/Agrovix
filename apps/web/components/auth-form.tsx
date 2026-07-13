'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';

type Mode = 'login' | 'register';

interface Props {
  mode: Mode;
}

export function AuthForm({ mode }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const data = new FormData(event.currentTarget);
    const payload: Record<string, string> = {
      email: String(data.get('email') ?? ''),
      password: String(data.get('password') ?? ''),
    };
    if (mode === 'register') {
      const fullName = String(data.get('full_name') ?? '');
      if (fullName) payload.full_name = fullName;
    }

    try {
      const path = mode === 'login' ? '/v1/auth/login' : '/v1/auth/register';
      await apiFetch(path, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (mode === 'register') {
        router.push('/verify');
      } else {
        router.push('/dashboard');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.payload.detail ?? 'Something went wrong.');
      } else {
        setError('Unable to reach the API. Is the backend running?');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mt-8 flex flex-col gap-4"
      data-testid={`${mode}-form`}
    >
      {mode === 'register' && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Full name</span>
          <input
            name="full_name"
            type="text"
            autoComplete="name"
            data-testid="auth-fullname-input"
            className="rounded-md border border-input bg-background px-3 py-2 outline-none ring-ring focus:ring-2"
          />
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Email</span>
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          data-testid="auth-email-input"
          className="rounded-md border border-input bg-background px-3 py-2 outline-none ring-ring focus:ring-2"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Password</span>
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          data-testid="auth-password-input"
          className="rounded-md border border-input bg-background px-3 py-2 outline-none ring-ring focus:ring-2"
        />
      </label>

      {error && (
        <p
          role="alert"
          data-testid="auth-error"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        data-testid={`${mode}-submit-button`}
        className="mt-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition disabled:opacity-60"
      >
        {submitting
          ? 'Please wait…'
          : mode === 'login'
            ? 'Sign in'
            : 'Create account'}
      </button>
    </form>
  );
}
