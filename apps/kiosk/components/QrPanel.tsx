'use client';

import React from 'react';
import { QRCodeSVG } from 'qrcode.react';

interface QrPanelProps {
  qrUrl: string;
  statusMessage: string;
  size?: number;
  hint?: string;
}

export function QrPanel({ qrUrl, statusMessage, size = 180, hint }: QrPanelProps) {
  if (!qrUrl) {
    return (
      <div style={styles.placeholder}>
        <p style={styles.message}>{statusMessage}</p>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      <div style={styles.qrWrap}>
        <QRCodeSVG value={qrUrl} size={size} bgColor="#ffffff" fgColor="#000000" level="M" />
      </div>
      <p style={styles.message}>{statusMessage}</p>
      <p style={styles.hint}>{hint || 'Employees scan to open the customer app and sign in with RFID + PIN'}</p>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
    padding: 16,
    borderRadius: 12,
    border: '1px solid #334155',
    backgroundColor: '#0f172a',
  },
  qrWrap: {
    padding: 12,
    backgroundColor: '#fff',
    borderRadius: 8,
  },
  placeholder: {
    marginBottom: 20,
    padding: 20,
    textAlign: 'center',
    borderRadius: 12,
    border: '1px dashed #475569',
  },
  message: {
    margin: 0,
    color: '#e2e8f0',
    fontSize: 14,
    textAlign: 'center',
  },
  hint: {
    margin: 0,
    color: '#94a3b8',
    fontSize: 12,
    textAlign: 'center',
  },
};
