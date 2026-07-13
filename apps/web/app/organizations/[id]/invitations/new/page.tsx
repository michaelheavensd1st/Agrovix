'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';

const ROLES = [
  'organization_owner',
  'farm_director',
  'farm_manager',
  'supervisor',
  'storekeeper',
  'veterinarian',
  'accountant',
  'worker',
  'viewer',
];

export default function InvitationNewPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const orgId = params.id;

  const [email, setEmail] = useState('');
  const [role, setRole] = useState('farm_manager');
  const [farmId, setFarmId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setOk(false);
    try {
      const payload: Record<string, unknown> = { email, role_name: role };
      if (farmId) payload.farm_id = farmId;
      await apiFetch(`/v1/organizations/${orgId}/invitations`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setOk(true);
      setTimeout(() => router.push(`/organizations/${orgId}`), 900);
    } catch (err) {
      setError(err instanceof ApiError ? err.payload.detail ?? 'Failed to invite' : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12"
      data-testid="invitation-new-page"
    >
      <h1 className="font-display text-3xl">Invite a teammate</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        They will receive an email with a one-time acceptance link.
      </p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4" data-testid="invitation-form">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Email</span>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="invitation-email-input"
            className="rounded-md border border-input bg-background px-3 py-2 outline-none ring-ring focus:ring-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            data-testid="invitation-role-select"
            className="rounded-md border border-input bg-background px-3 py-2"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Farm ID (required for farm-scoped roles)</span>
          <input
            value={farmId}
            onChange={(e) => setFarmId(e.target.value)}
            data-testid="invitation-farm-id-input"
            placeholder="uuid or leave blank for org-scoped roles"
            className="rounded-md border border-input bg-background px-3 py-2"
          />
        </label>
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="invitation-error">
            {error}
          </p>
        )}
        {ok && (
          <p className="rounded-md bg-primary/10 px-3 py-2 text-sm text-primary" data-testid="invitation-success">
            Invitation sent.
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          data-testid="invitation-submit-button"
          className="mt-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition disabled:opacity-60"
        >
          {submitting ? 'Sending…' : 'Send invitation'}
        </button>
      </form>
    </main>
  );
}
