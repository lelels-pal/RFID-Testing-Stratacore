import React from 'react';

export const metadata = {
  title: 'Stratacore EV Charger Kiosk',
  description: 'Physical EV charging interface screen',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <style>{`
          *, *::before, *::after { box-sizing: border-box; }
          body { margin: 0; padding: 0; background-color: #000000; }
          @keyframes spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
          @keyframes pulse {
            0%   { left: -40%; }
            100% { left: 110%; }
          }
        `}</style>
      </head>
      <body style={{ margin: 0, padding: 0, backgroundColor: '#000000' }}>{children}</body>
    </html>
  );
}
