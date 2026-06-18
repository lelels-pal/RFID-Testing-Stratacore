import React from 'react';

export const metadata = {
  title: 'Stratacore Guest Web App',
  description: 'EV charging guest payment checkout',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, backgroundColor: '#000000' }}>{children}</body>
    </html>
  );
}
