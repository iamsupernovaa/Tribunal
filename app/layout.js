import './globals.css';
import Providers from './providers';

export const metadata = {
  title: 'Tribunal',
  description: 'Two AIs deliberate, one answer.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
