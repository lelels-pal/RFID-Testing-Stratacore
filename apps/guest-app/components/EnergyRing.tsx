'use client';

import { ReactNode } from 'react';

export function EnergyRing({
  value,
  max,
  children,
}: {
  value: number;
  max: number;
  children?: ReactNode;
}) {
  const size = 228;
  const stroke = 5;
  const radius = (size - stroke * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const progress = circumference * pct;

  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <div
        className="absolute inset-[14px] rounded-full bg-black/15 border-2 border-white/25 shadow-[inset_0_2px_20px_rgba(0,0,0,0.15)]"
        aria-hidden
      />
      <svg
        className="absolute inset-0 -rotate-90 drop-shadow-[0_0_18px_rgba(255,255,255,0.45)]"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(0,0,0,0.35)"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.45)"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="url(#energyRingGradient)"
          strokeWidth={stroke}
          strokeDasharray={`${progress} ${circumference}`}
          strokeLinecap="round"
          style={{ filter: 'drop-shadow(0 0 6px rgba(255,255,255,0.6))' }}
        />
        <defs>
          <linearGradient id="energyRingGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#fff" />
            <stop offset="100%" stopColor="#ffedd5" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex items-center justify-center px-4">{children}</div>
    </div>
  );
}
