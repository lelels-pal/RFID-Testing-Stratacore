'use client';

import React, { Suspense } from 'react';
import { AuthProvider } from '../context/AuthContext';
import AdminDashboardPage from './AdminDashboardPage';

export default function KioskPage() {
  return (
    <AuthProvider>
      <Suspense fallback={<div style={{ color: '#fff', padding: 40 }}>Loading…</div>}>
        <AdminDashboardPage />
      </Suspense>
    </AuthProvider>
  );
}
