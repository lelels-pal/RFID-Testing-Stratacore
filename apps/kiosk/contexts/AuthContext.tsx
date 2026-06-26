'use client';

import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AdminRole, AdminUser } from '@packages/shared';
import { apiFetch } from '@/lib/api-client';

interface AuthContextType {
  user: AdminUser | null;
  role: AdminRole | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  const checkAuth = async () => {
    try {
      const res = await apiFetch('/api/v1/auth/admin/me');
      if (!res.ok) {
        setUser(null);
        return false;
      }
      const data = await res.json();
      setUser(data.user);
      return true;
    } catch {
      setUser(null);
      return false;
    }
  };

  useEffect(() => {
    (async () => {
      await checkAuth();
      setIsLoading(false);
    })();
  }, []);

  const login = async (username: string, password: string) => {
    try {
      const res = await apiFetch('/api/v1/auth/admin/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.message || 'Login failed' };
      }
      const data = await res.json();
      localStorage.setItem('admin_token', data.token);
      setUser(data.user);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error' };
    }
  };

  const logout = async () => {
    await apiFetch('/api/v1/auth/admin/logout', { method: 'POST' }).catch(() => undefined);
    localStorage.removeItem('admin_token');
    setUser(null);
    router.push('/login');
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        role: user?.role ?? null,
        isAuthenticated: !!user,
        isLoading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function canAccessTab(role: AdminRole | null, tab: string): boolean {
  if (!role) return false;
  if (role === 'master' || role === 'admin') return true;
  if (role === 'staff') {
    return ['dashboard', 'chargepoints', 'operators', 'energy'].includes(tab);
  }
  return false;
}
