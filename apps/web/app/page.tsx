import Link from 'next/link';
import { Leaf, Compass, ShieldCheck } from 'lucide-react';

export default function LandingPage() {
  return (
    <main className="relative isolate overflow-hidden" data-testid="landing-page">
      {/* Background field texture */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,hsl(var(--primary)/0.12),transparent_60%)]"
      />

      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2" data-testid="brand-logo">
          <Leaf className="h-6 w-6 text-primary" />
          <span className="text-lg font-semibold tracking-tight">
            Agrovix <span className="text-primary">AgOS</span>
          </span>
        </div>
        <nav className="flex items-center gap-3">
          <Link
            href="/login"
            data-testid="nav-login-link"
            className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            data-testid="nav-register-link"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90"
          >
            Get started
          </Link>
        </nav>
      </header>

      <section className="mx-auto max-w-6xl px-6 pb-24 pt-16 sm:pt-24">
        <p
          data-testid="landing-eyebrow"
          className="mb-4 inline-flex items-center rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs uppercase tracking-widest text-secondary-foreground"
        >
          Sprint 0 · Foundation
        </p>
        <h1
          data-testid="landing-headline"
          className="max-w-3xl font-display text-4xl leading-[1.05] sm:text-5xl lg:text-6xl"
        >
          The operating system for modern agriculture.
        </h1>
        <p
          data-testid="landing-subheadline"
          className="mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg"
        >
          Agrovix AgOS unifies farms, fields, teams, and telemetry behind one extensible platform.
          This is the foundation release — a production-ready architecture ready to grow feature by
          feature.
        </p>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            href="/register"
            data-testid="hero-cta-register"
            className="inline-flex items-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90"
          >
            Create an account
          </Link>
          <Link
            href="/login"
            data-testid="hero-cta-login"
            className="inline-flex items-center rounded-md border border-border bg-background px-5 py-2.5 text-sm font-medium transition hover:bg-secondary"
          >
            Sign in
          </Link>
        </div>

        <div className="mt-20 grid gap-6 sm:grid-cols-3">
          <FeatureCard
            icon={<Leaf className="h-5 w-5" />}
            title="Domain-driven"
            body="A clean, modular architecture built for the agricultural domain — designed to scale from a single farm to a fleet of operations."
            testid="feature-domain"
          />
          <FeatureCard
            icon={<Compass className="h-5 w-5" />}
            title="Multi-surface"
            body="One backend serving Next.js on the web and Expo on mobile, sharing types, validation, and utilities."
            testid="feature-multi-surface"
          />
          <FeatureCard
            icon={<ShieldCheck className="h-5 w-5" />}
            title="Enterprise-ready"
            body="JWT auth, RBAC, Postgres + Redis, Alembic migrations, CI, Docker — everything wired the right way from day one."
            testid="feature-enterprise"
          />
        </div>
      </section>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6 text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} Agrovix</span>
          <span data-testid="version-tag">v0.1.0 · Sprint 0</span>
        </div>
      </footer>
    </main>
  );
}

function FeatureCard({
  icon,
  title,
  body,
  testid,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  testid: string;
}) {
  return (
    <div
      data-testid={testid}
      className="rounded-2xl border border-border bg-card/60 p-6 shadow-sm backdrop-blur-sm transition hover:border-primary/40 hover:shadow-md"
    >
      <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
