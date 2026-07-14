import Link from 'next/link';
import { AuthForm } from '@/components/auth-form';

export default function RegisterPage() {
  return (
    <main
      className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12"
      data-testid="register-page"
    >
      <h1 className="font-display text-3xl">Create your account</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Get started with Agrovix AgOS in seconds.
      </p>
      <AuthForm mode="register" />
      <p className="mt-6 text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link
          href="/login"
          data-testid="register-to-login-link"
          className="text-primary hover:underline"
        >
          Sign in
        </Link>
      </p>
    </main>
  );
}
