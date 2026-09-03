import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MajstorKlik — Lead mašina',
  description: 'Kvalifikovani leadovi za gipsare, vodoinstalatere i molere u premium zonama Beograda.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sr">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔨</text></svg>"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
