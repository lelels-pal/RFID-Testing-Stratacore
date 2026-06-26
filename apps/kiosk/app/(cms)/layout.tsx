'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  LayoutDashboard,
  Grid3X3,
  WalletCards,
  BatteryCharging,
  CalendarDays,
  Users,
  CreditCard,
  Zap,
  ChevronLeft,
  ChevronRight,
  User,
  LogOut,
} from 'lucide-react';
import { AuthProvider, useAuth, canAccessTab } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const NAV = [
  { id: 'dashboard', label: 'DASHBOARD', href: '/dashboard', icon: LayoutDashboard },
  { id: 'chargepoints', label: 'CHARGEPOINTS', href: '/dashboard?tab=chargepoints', icon: Grid3X3 },
  { id: 'finance', label: 'FINANCE', href: '/dashboard?tab=finance', icon: WalletCards },
  { id: 'energy', label: 'ENERGY', href: '/dashboard?tab=energy', icon: BatteryCharging },
  { id: 'history', label: 'HISTORY', href: '/dashboard?tab=history', icon: CalendarDays },
  { id: 'operators', label: 'OPERATORS', href: '/dashboard?tab=operators', icon: Users },
  { id: 'topup', label: 'TOP-UP', href: '/dashboard?tab=topup', icon: CreditCard },
];

function CmsLayoutInner({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const { user, logout, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const activeTab = searchParams.get('tab') || 'dashboard';

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace('/login');
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center text-stone-400">Loading...</div>;
  }
  if (!isAuthenticated) return null;

  const visibleNav = NAV.filter((item) => canAccessTab(user?.role ?? null, item.id));

  return (
    <div className="cms-shell fixed inset-0 flex">
      <aside
        className={`cms-sidebar flex flex-col border-r transition-all ${collapsed ? 'w-16' : 'w-72'}`}
      >
        <div className="cms-sidebar-header p-4 border-b flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-orange-600 flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" fill="currentColor" />
            </div>
            {!collapsed && <span className="font-bold text-white tracking-wider">STRATACORE</span>}
          </Link>
          {!collapsed && (
            <button onClick={() => setCollapsed(true)} className="text-orange-400 border border-orange-500/50 rounded p-1">
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
        </div>
        {collapsed && (
          <button onClick={() => setCollapsed(false)} className="mx-auto mt-2 text-orange-400">
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
        <nav className="flex-1 py-4 px-3 space-y-1">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const isActive =
              (item.id === 'dashboard' && activeTab === 'dashboard') || item.id === activeTab;
            return (
              <Link
                key={item.id}
                href={item.href}
                className={`flex items-center gap-4 px-4 py-3 rounded-xl transition-colors ${
                  isActive ? 'bg-orange-600 text-white' : 'text-stone-400 cms-nav-item-inactive'
                } ${collapsed ? 'justify-center' : ''}`}
              >
                <Icon className="w-5 h-5" />
                {!collapsed && <span className="font-semibold tracking-wide">{item.label}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="cms-sidebar-footer p-4 border-t">
          <button
            onClick={() => logout()}
            className={`w-full flex items-center gap-3 text-stone-400 hover:text-white ${collapsed ? 'justify-center' : ''}`}
          >
            <User className="w-5 h-5" />
            {!collapsed && (
              <>
                <span className="text-sm flex-1 text-left">{user?.username}</span>
                <LogOut className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </aside>
      <main className="cms-main flex-1 overflow-y-auto p-6 ml-0">{children}</main>
    </div>
  );
}

export default function CmsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
        <CmsLayoutInner>{children}</CmsLayoutInner>
      </Suspense>
    </AuthProvider>
  );
}
