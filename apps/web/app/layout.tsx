import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from '@/components/ui-polish';

export const metadata: Metadata = {
  title: 'Agrovix AgOS',
  description: 'The enterprise Agricultural Operating System.',
  applicationName: 'Agrovix AgOS',
  authors: [{ name: 'Agrovix' }],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
