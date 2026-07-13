/**
 * =====================================================================
 *  ⚠️  PREVIEW SHIM — NOT CANONICAL, NOT DEPLOYED.
 *
 *  The canonical Next.js web app lives in ``apps/web/`` and uses the
 *  App Router, TypeScript, and Tailwind. This CRA file exists only so
 *  the Emergent pod URL renders the AgOS pages during Sprint reviews.
 *
 *  * Do NOT copy business logic from this file into ``apps/web``.
 *  * Do NOT deploy this. It is not part of the shipped monorepo.
 *  * Sprint 1 changes (cookie auth, onboarding, org/farm flows) live
 *    in ``apps/web/app/*``.
 *  * See ``/app/PREVIEW_SHIM.md``.
 * =====================================================================
 */
import { BrowserRouter, Routes, Route, Link, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import axios from "axios";
import { Leaf, Compass, ShieldCheck } from "lucide-react";
import "@/App.css";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

/* -------------------------------------------------------------------------- */
/*  Landing                                                                   */
/* -------------------------------------------------------------------------- */
const Landing = () => {
  useEffect(() => {
    // Warm-up ping to /health so the pod shim reports as reachable.
    axios.get(`${BACKEND_URL}/health`).catch(() => {});
  }, []);

  return (
    <main className="relative isolate overflow-hidden min-h-screen" data-testid="landing-page">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,hsl(var(--primary)/0.12),transparent_60%)]"
      />

      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Link to="/" className="flex items-center gap-2" data-testid="brand-logo">
          <Leaf className="h-6 w-6 text-primary" />
          <span className="text-lg font-semibold tracking-tight">
            Agrovix <span className="text-primary">AgOS</span>
          </span>
        </Link>
        <nav className="flex items-center gap-3">
          <Link
            to="/login"
            data-testid="nav-login-link"
            className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Sign in
          </Link>
          <Link
            to="/register"
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
          className="max-w-3xl font-serif text-4xl leading-[1.05] sm:text-5xl lg:text-6xl"
        >
          The operating system for modern agriculture.
        </h1>
        <p
          data-testid="landing-subheadline"
          className="mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg"
        >
          Agrovix AgOS unifies farms, fields, teams, and telemetry behind one
          extensible platform. This is the foundation release &mdash; a
          production-ready architecture ready to grow feature by feature.
        </p>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            to="/register"
            data-testid="hero-cta-register"
            className="inline-flex items-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90"
          >
            Create an account
          </Link>
          <Link
            to="/login"
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
};

const FeatureCard = ({ icon, title, body, testid }) => (
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

/* -------------------------------------------------------------------------- */
/*  Auth form (shared)                                                        */
/* -------------------------------------------------------------------------- */
const AuthForm = ({ mode }) => {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const onSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData(e.currentTarget);
      const payload = {
        email: form.get("email") || "",
        password: form.get("password") || "",
      };
      if (mode === "register") {
        const fullName = form.get("full_name");
        if (fullName) payload.full_name = fullName;
      }
      const path = mode === "login" ? "/v1/auth/login" : "/v1/auth/register";
      await axios.post(`${API}${path}`, payload);
      navigate("/dashboard");
    } catch (err) {
      const detail = err?.response?.data?.detail ?? "Unable to reach the API.";
      setError(detail);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="mt-8 flex flex-col gap-4"
      data-testid={`${mode}-form`}
    >
      {mode === "register" && (
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
          autoComplete={mode === "login" ? "current-password" : "new-password"}
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
        {submitting ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
      </button>
    </form>
  );
};

/* -------------------------------------------------------------------------- */
/*  Auth pages                                                                */
/* -------------------------------------------------------------------------- */
const Login = () => (
  <main
    className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12"
    data-testid="login-page"
  >
    <Link to="/" className="mb-6 text-xs uppercase tracking-widest text-muted-foreground" data-testid="login-brand-link">
      ← Agrovix AgOS
    </Link>
    <h1 className="font-serif text-3xl">Welcome back</h1>
    <p className="mt-2 text-sm text-muted-foreground">Sign in to your Agrovix AgOS account.</p>
    <AuthForm mode="login" />
    <p className="mt-6 text-sm text-muted-foreground">
      New to Agrovix?{" "}
      <Link to="/register" data-testid="login-to-register-link" className="text-primary hover:underline">
        Create an account
      </Link>
    </p>
  </main>
);

const Register = () => (
  <main
    className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12"
    data-testid="register-page"
  >
    <Link to="/" className="mb-6 text-xs uppercase tracking-widest text-muted-foreground" data-testid="register-brand-link">
      ← Agrovix AgOS
    </Link>
    <h1 className="font-serif text-3xl">Create your account</h1>
    <p className="mt-2 text-sm text-muted-foreground">Get started with Agrovix AgOS in seconds.</p>
    <AuthForm mode="register" />
    <p className="mt-6 text-sm text-muted-foreground">
      Already have an account?{" "}
      <Link to="/login" data-testid="register-to-login-link" className="text-primary hover:underline">
        Sign in
      </Link>
    </p>
  </main>
);

/* -------------------------------------------------------------------------- */
/*  Dashboard placeholder                                                     */
/* -------------------------------------------------------------------------- */
const Dashboard = () => (
  <main className="mx-auto max-w-6xl px-6 py-12" data-testid="dashboard-page">
    <div className="mb-8 flex items-center justify-between">
      <div>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Placeholder</p>
        <h1 className="font-serif text-3xl">Dashboard</h1>
      </div>
      <Link to="/" data-testid="dashboard-home-link" className="text-sm text-muted-foreground hover:text-foreground">
        ← Home
      </Link>
    </div>
    <div
      data-testid="dashboard-empty-state"
      className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center"
    >
      <p className="font-serif text-xl">Nothing here yet.</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Sprint 0 ships only the foundation. Farm dashboards, telemetry, and field
        operations will land in the next milestone.
      </p>
    </div>
  </main>
);

/* -------------------------------------------------------------------------- */
/*  404                                                                       */
/* -------------------------------------------------------------------------- */
const NotFound = () => (
  <main
    className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-12 text-center"
    data-testid="not-found-page"
  >
    <p className="text-xs uppercase tracking-widest text-muted-foreground">404</p>
    <h1 className="mt-2 font-serif text-4xl">Field not found</h1>
    <p className="mt-4 text-sm text-muted-foreground">
      We couldn't locate the page you're looking for.
    </p>
    <Link
      to="/"
      data-testid="not-found-home-link"
      className="mt-8 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
    >
      Back to home
    </Link>
  </main>
);

/* -------------------------------------------------------------------------- */
/*  Root                                                                      */
/* -------------------------------------------------------------------------- */
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
