import './globals.css';
import React from 'react';

export const metadata = {
  title: 'Stratacore Admin',
  description: 'EV charging station admin',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
