import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-12 text-center"
      data-testid="not-found-page"
    >
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        404
      </p>
      <h1 className="mt-2 font-display text-4xl">Field not found</h1>
      <p className="mt-4 text-sm text-muted-foreground">
        We couldn&apos;t locate the page you&apos;re looking for.
      </p>
      <Link
        href="/"
        data-testid="not-found-home-link"
        className="mt-8 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
      >
        Back to home
      </Link>
    </main>
  );
}
