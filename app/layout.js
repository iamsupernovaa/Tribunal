import './globals.css';

export const metadata = {
  title: 'Tribunal',
  description: 'Two AIs debate, one verdict.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
