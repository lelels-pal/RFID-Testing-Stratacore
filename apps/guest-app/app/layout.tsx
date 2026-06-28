import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Stratacore EV Charging',
  description: 'Premium EV Charging with Complimentary WiFi',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Stratacore',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
  viewport: {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    viewportFit: 'cover',
  },
  themeColor: '#0a0a0a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body
        className="min-h-screen text-[#f8f1eb] antialiased"
        style={{
          background: 'linear-gradient(135deg, #120b08 0%, #1f1b18 48%, #050505 100%)',
        }}
      >
        {children}
      </body>
    </html>
  );
}
