import Link from 'next/link';
import { AuthForm } from '@/components/auth-form';

export default function LoginPage() {
  return (
    <main
      className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12"
      data-testid="login-page"
    >
      <h1 className="font-display text-3xl">Welcome back</h1>
      <p className="mt-2 text-sm text-muted-foreground">Sign in to your Agrovix AgOS account.</p>
      <AuthForm mode="login" />
      <p className="mt-6 text-sm text-muted-foreground">
        New to Agrovix?{' '}
        <Link
          href="/register"
          data-testid="login-to-register-link"
          className="text-primary hover:underline"
        >
          Create an account
        </Link>
      </p>
    </main>
  );
}
