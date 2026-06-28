'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { adminLogin, loadPersistedAdminToken, setAdminToken } from '../lib/api-client';

interface AuthContextValue {
  isLoggedIn: boolean;
  authChecked: boolean;
  login: (backendUrl: string, username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const token = loadPersistedAdminToken();
    setIsLoggedIn(Boolean(token));
    setAuthChecked(true);
  }, []);

  const login = useCallback(async (backendUrl: string, username: string, password: string) => {
    await adminLogin(backendUrl, username, password);
    setIsLoggedIn(true);
  }, []);

  const logout = useCallback(() => {
    setAdminToken(null);
    setIsLoggedIn(false);
  }, []);

  const value = useMemo(
    () => ({ isLoggedIn, authChecked, login, logout }),
    [isLoggedIn, authChecked, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
