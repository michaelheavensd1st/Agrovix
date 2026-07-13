import Link from 'next/link';

export default function DashboardPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-12" data-testid="dashboard-page">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            Placeholder
          </p>
          <h1 className="font-display text-3xl">Dashboard</h1>
        </div>
        <Link
          href="/"
          data-testid="dashboard-home-link"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Home
        </Link>
      </div>

      <div
        data-testid="dashboard-empty-state"
        className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center"
      >
        <p className="font-display text-xl">Nothing here yet.</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Sprint 0 ships only the foundation. Farm dashboards, telemetry, and
          field operations will land in the next milestone.
        </p>
      </div>
    </main>
  );
}
