'use client';

import React, { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { RfidCard, WsMeterUpdatePayload } from '@packages/shared';

const WsEvents = {
  SESSION_CLAIMED: 'session:claimed',
  PAYMENT_APPROVED: 'payment:approved',
  CHARGER_PREPARING: 'charger:preparing',
  CHARGER_STARTING: 'charger:starting',
  METER_UPDATE: 'charger:meter_update',
  SESSION_COMPLETED: 'session:completed',
  SESSION_ERROR: 'session:error',
  SUBSCRIBE_CHARGER: 'subscribe:charger',
};

type ViewTab = 'dashboard' | 'chargepoints' | 'energy' | 'finance' | 'operators' | 'history' | 'topup' | 'settings';

interface ChargerDefinition {
  chargerId: string;
  connectorId: number;
  chargerIp: string;
}

interface LocalSessionState {
  status: 'IDLE' | 'PREPARING' | 'CHARGING' | 'COMPLETED' | 'ERROR';
  statusMessage: string;
  telemetry: WsMeterUpdatePayload | null;
  activeRfid: string | null;
}

const CHARGER_CONFIGS: ChargerDefinition[] = [
  { chargerId: 'BENY-002', connectorId: 1, chargerIp: '192.168.254.85' },
  { chargerId: 'BENY-001', connectorId: 1, chargerIp: '192.168.254.62' },
];

function getBackendUrl() {
  if (process.env.NEXT_PUBLIC_BACKEND_URL) return process.env.NEXT_PUBLIC_BACKEND_URL;
  if (typeof window !== 'undefined') return `${window.location.protocol}//${window.location.hostname}:4001`;
  return 'http://localhost:4001';
}

// Quotas reset on the 1st of every calendar month. Returns the next reset date.
function getNextResetDate(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

function formatResetLabel(): string {
  const next = getNextResetDate();
  return next.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function isCardExhausted(card: RfidCard): boolean {
  return card.currentMonthKwhConsumed >= card.monthlyKwhLimit;
}

export default function AdminDashboardPage() {
  // Authentication State
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Layout & Routing State
  const [currentTab, setCurrentTab] = useState<ViewTab>('dashboard');

  // Real-Time System Data State
  const [backendUrl, setBackendUrl] = useState('http://localhost:4001');
  const [rfidCards, setRfidCards] = useState<RfidCard[]>([]);
  const [sessions, setSessions] = useState<Record<string, LocalSessionState>>(() =>
    Object.fromEntries(CHARGER_CONFIGS.map((c) => [c.chargerId, {
      status: 'IDLE',
      statusMessage: 'Ready to Charge',
      telemetry: null,
      activeRfid: null,
    }]))
  );

  // RFID Allocation/Form State
  const [newCardId, setNewCardId] = useState('');
  const [newCardholder, setNewCardholder] = useState('');
  const [newCardLimit, setNewCardLimit] = useState('200');
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');

  // Edit Allocation State
  const [editingCard, setEditingCard] = useState<RfidCard | null>(null);
  const [editName, setEditName] = useState('');
  const [editLimit, setEditLimit] = useState('');
  const [editError, setEditError] = useState('');

  // Charger Activation Modal/Panel State
  const [selectedChargerId, setSelectedChargerId] = useState<string | null>(null);
  const [selectedRfid, setSelectedRfid] = useState('');
  const [activationError, setActivationError] = useState('');

  // Socket reference
  const socketRef = useRef<Socket | null>(null);

  // Resolve backend URL client-side
  useEffect(() => {
    setBackendUrl(getBackendUrl());
  }, []);

  // Fetch RFIDs from Backend
  const fetchRfids = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/v1/charging/rfid`);
      if (!res.ok) throw new Error('Failed to fetch cards');
      const data = await res.json();
      setRfidCards(data);
    } catch (err) {
      console.error('Error fetching RFID cards:', err);
    }
  };

  // Triggered when backend is resolved or on interval. Polls frequently so a
  // card's monthly consumption visibly counts up while a session is charging.
  useEffect(() => {
    if (!backendUrl) return;
    fetchRfids();
    const interval = setInterval(fetchRfids, 3000);
    return () => clearInterval(interval);
  }, [backendUrl]);

  // Connect WebSockets
  useEffect(() => {
    if (!backendUrl) return;

    const socket = io(backendUrl);
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[Socket] Connected to backend');
      CHARGER_CONFIGS.forEach((c) => {
        socket.emit(WsEvents.SUBSCRIBE_CHARGER, { chargerId: c.chargerId });
      });
    });

    socket.on(WsEvents.CHARGER_PREPARING, (data: { chargerId: string; message: string }) => {
      setSessions((prev) => ({
        ...prev,
        [data.chargerId]: {
          ...prev[data.chargerId],
          status: 'PREPARING',
          statusMessage: data.message || 'Preparing: Plug in vehicle.',
        },
      }));
    });

    socket.on(WsEvents.CHARGER_STARTING, (data: { chargerId: string; message: string }) => {
      setSessions((prev) => ({
        ...prev,
        [data.chargerId]: {
          ...prev[data.chargerId],
          status: 'CHARGING',
          statusMessage: data.message || 'Charging Started',
        },
      }));
    });

    socket.on(WsEvents.METER_UPDATE, (data: WsMeterUpdatePayload) => {
      setSessions((prev) => ({
        ...prev,
        [data.chargerId]: {
          ...prev[data.chargerId],
          status: 'CHARGING',
          telemetry: data,
        },
      }));
    });

    socket.on(WsEvents.SESSION_COMPLETED, (data: { chargerId: string; message: string }) => {
      setSessions((prev) => ({
        ...prev,
        [data.chargerId]: {
          ...prev[data.chargerId],
          status: 'COMPLETED',
          statusMessage: data.message || 'Charging Finished',
        },
      }));
      // Reset after delay
      setTimeout(() => {
        setSessions((prev) => ({
          ...prev,
          [data.chargerId]: {
            status: 'IDLE',
            statusMessage: 'Ready to Charge',
            telemetry: null,
            activeRfid: null,
          },
        }));
        fetchRfids();
      }, 5000);
    });

    socket.on(WsEvents.SESSION_ERROR, (data: { chargerId: string; message: string }) => {
      setSessions((prev) => ({
        ...prev,
        [data.chargerId]: {
          ...prev[data.chargerId],
          status: 'ERROR',
          statusMessage: data.message || 'Error occurred during session',
          telemetry: null,
        },
      }));
      setTimeout(() => {
        setSessions((prev) => ({
          ...prev,
          [data.chargerId]: {
            status: 'IDLE',
            statusMessage: 'Ready to Charge',
            telemetry: null,
            activeRfid: null,
          },
        }));
        fetchRfids();
      }, 6000);
    });

    return () => {
      socket.disconnect();
    };
  }, [backendUrl]);

  // Sign In Handler
  const handleSignIn = (e: React.FormEvent) => {
    e.preventDefault();
    if (username.trim() === 'admin' && password === 'admin123') {
      setIsLoggedIn(true);
      setLoginError('');
    } else if (username.trim() === 'user' && password === 'user123') {
      setIsLoggedIn(true);
      setLoginError('');
    } else {
      setLoginError('Invalid username or password. Please try again.');
    }
  };

  // Start Charging Handler
  const handleStartCharging = async () => {
    if (!selectedChargerId || !selectedRfid) return;
    setActivationError('');

    try {
      const res = await fetch(`${backendUrl}/api/v1/charging/rfid/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chargerId: selectedChargerId,
          connectorId: 1,
          rfidCardId: selectedRfid,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'RemoteStart failed');
      }

      setSessions((prev) => ({
        ...prev,
        [selectedChargerId]: {
          ...prev[selectedChargerId],
          status: 'PREPARING',
          statusMessage: 'Remote start accepted. Preparing...',
          activeRfid: selectedRfid,
        },
      }));

      setSelectedChargerId(null);
      setSelectedRfid('');
    } catch (err) {
      setActivationError((err as Error).message);
    }
  };

  // Stop Charging Handler
  const handleStopCharging = async (chargerId: string) => {
    try {
      const res = await fetch(`${backendUrl}/api/v1/charging/kiosk/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chargerId }),
      });
      if (!res.ok) throw new Error('Stop command rejected');
    } catch (err) {
      console.error('Error stopping charger:', err);
    }
  };

  // Add RFID Card Handler
  const handleRegisterRfid = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setFormSuccess('');

    if (!newCardId.trim() || !newCardholder.trim() || !newCardLimit.trim()) {
      setFormError('All fields are required.');
      return;
    }

    try {
      const res = await fetch(`${backendUrl}/api/v1/charging/rfid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rfidCardId: newCardId.trim().toUpperCase(),
          cardholderName: newCardholder.trim(),
          monthlyKwhLimit: parseFloat(newCardLimit),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to register card');

      setFormSuccess(`Card ${newCardId.toUpperCase()} successfully registered!`);
      setNewCardId('');
      setNewCardholder('');
      setNewCardLimit('200');
      fetchRfids();
    } catch (err) {
      setFormError((err as Error).message);
    }
  };

  // Delete RFID Card Handler
  const handleDeleteRfid = async (cardId: string) => {
    if (!confirm(`Are you sure you want to delete card ${cardId}?`)) return;
    try {
      const res = await fetch(`${backendUrl}/api/v1/charging/rfid/${cardId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete card');
      fetchRfids();
    } catch (err) {
      console.error(err);
    }
  };

  // Toggle Card Status Handler
  const handleToggleCardStatus = async (card: RfidCard) => {
    try {
      const res = await fetch(`${backendUrl}/api/v1/charging/rfid/${card.rfidCardId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !card.isActive }),
      });
      if (!res.ok) throw new Error('Failed to update card status');
      fetchRfids();
    } catch (err) {
      console.error(err);
    }
  };

  // Reset Quota Manually Handler
  const handleResetQuota = async (cardId: string) => {
    try {
      const res = await fetch(`${backendUrl}/api/v1/charging/rfid/${cardId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentMonthKwhConsumed: 0 }),
      });
      if (!res.ok) throw new Error('Failed to reset quota');
      fetchRfids();
    } catch (err) {
      console.error(err);
    }
  };

  // Open the edit allocation modal for a card
  const handleOpenEdit = (card: RfidCard) => {
    setEditingCard(card);
    setEditName(card.cardholderName);
    setEditLimit(String(card.monthlyKwhLimit));
    setEditError('');
  };

  // Save edited allocation (cardholder name + monthly kWh limit)
  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCard) return;
    setEditError('');

    const limitValue = parseFloat(editLimit);
    if (!editName.trim()) {
      setEditError('Cardholder name is required.');
      return;
    }
    if (isNaN(limitValue) || limitValue < 0) {
      setEditError('Monthly kWh allocation must be a non-negative number.');
      return;
    }

    try {
      const res = await fetch(`${backendUrl}/api/v1/charging/rfid/${editingCard.rfidCardId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardholderName: editName.trim(),
          monthlyKwhLimit: limitValue,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to update allocation');

      setEditingCard(null);
      fetchRfids();
    } catch (err) {
      setEditError((err as Error).message);
    }
  };

  // Helper Stats calculations
  const totalKwhConsumedThisMonth = rfidCards.reduce((acc, c) => acc + c.currentMonthKwhConsumed, 0);
  const activeSessionsCount = Object.values(sessions).filter((s) => s.status === 'CHARGING' || s.status === 'PREPARING').length;
  const criticalAlertsCount = Object.values(sessions).filter((s) => s.status === 'ERROR').length + (rfidCards.filter(c => c.currentMonthKwhConsumed >= c.monthlyKwhLimit).length > 0 ? 1 : 0);

  // ═══════════════════════════════════════════════════════════════
  // LOGIN VIEW RENDER
  // ═══════════════════════════════════════════════════════════════
  if (!isLoggedIn) {
    return (
      <div style={loginStyles.pageWrapper}>
        {/* Background Geometric Vectors */}
        <div style={loginStyles.bgLeftSVG}>
          <svg width="400" height="700" viewBox="0 0 400 700" fill="none">
            <path d="M-100 100 L250 450 L100 600" stroke="#a78bfa" strokeWidth="2" strokeOpacity="0.4"/>
            <path d="M-50 80 L300 430 L150 580" stroke="#7c3aed" strokeWidth="4" strokeOpacity="0.6"/>
            <circle cx="300" cy="430" r="5" fill="#7c3aed"/>
            <circle cx="250" cy="450" r="4" fill="#a78bfa"/>
          </svg>
        </div>
        <div style={loginStyles.bgRightSVG}>
          <svg width="400" height="700" viewBox="0 0 400 700" fill="none">
            <path d="M500 200 L150 400 L250 550" stroke="#a78bfa" strokeWidth="2" strokeOpacity="0.4"/>
            <path d="M550 180 L200 380 L300 530" stroke="#7c3aed" strokeWidth="4" strokeOpacity="0.6"/>
            <circle cx="200" cy="380" r="5" fill="#7c3aed"/>
            <circle cx="150" cy="400" r="4" fill="#a78bfa"/>
          </svg>
        </div>

        <div style={loginStyles.cardContainer}>
          <div style={loginStyles.avatarWrapper}>
            <svg style={loginStyles.avatarIcon} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
          </div>
          
          <h1 style={loginStyles.title}>
            STRATA<span style={{ color: '#7c3aed' }}>CORE</span>
          </h1>
          
          <div style={loginStyles.dividerLine}>
            <span style={loginStyles.dividerDot} />
          </div>

          <p style={loginStyles.subtitle}>Enter your credentials to access the system</p>

          <form onSubmit={handleSignIn} style={loginStyles.form}>
            <div style={loginStyles.inputGroup}>
              <span style={loginStyles.inputIconWrapper}>
                <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
                </svg>
              </span>
              <input
                type="text"
                placeholder="Enter your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                style={loginStyles.input}
              />
            </div>

            <div style={loginStyles.inputGroup}>
              <span style={loginStyles.inputIconWrapper}>
                <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                </svg>
              </span>
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={loginStyles.input}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={loginStyles.eyeButton}
              >
                <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </button>
            </div>

            {loginError && <div style={loginStyles.errorMessage}>{loginError}</div>}

            <button type="submit" style={loginStyles.submitBtn}>
              Sign In <span style={{ marginLeft: 8 }}>→</span>
            </button>
          </form>

          {/* Demo Credentials Section */}
          <div style={loginStyles.demoBox}>
            <div style={loginStyles.demoHeader}>
              <span style={loginStyles.demoLine} />
              <span style={loginStyles.demoHeaderText}>Demo Credentials</span>
              <span style={loginStyles.demoLine} />
            </div>
            <div style={loginStyles.demoRow}>
              <strong>Admin:</strong> <span style={loginStyles.purpleText}>admin</span> / <span style={loginStyles.purpleText}>admin123</span>
            </div>
            <div style={loginStyles.demoRow}>
              <strong>Guest:</strong> <span style={loginStyles.purpleText}>user</span> / <span style={loginStyles.purpleText}>user123</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN DASHBOARD LAYOUT & VIEWS
  // ═══════════════════════════════════════════════════════════════
  return (
    <div style={dashStyles.layoutWrapper}>
      {/* ───────────────────────────────────────────────────────────
          LEFT SIDEBAR
          ─────────────────────────────────────────────────────────── */}
      <aside style={dashStyles.sidebar}>
        <div style={dashStyles.logoSection}>
          <div style={dashStyles.logoText}>
            STRATA<span style={{ color: '#818cf8' }}>CORE</span>
          </div>
          <div style={dashStyles.logoSubtext}>EV Charging Management</div>
        </div>

        <nav style={dashStyles.navMenu}>
          {[
            { id: 'dashboard', label: 'Dashboard', icon: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z' },
            { id: 'chargepoints', label: 'Chargepoints', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
            { id: 'energy', label: 'Energy', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
            { id: 'finance', label: 'Finance', icon: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z' },
            { id: 'operators', label: 'Operators', icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z' },
            { id: 'history', label: 'History', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
            { id: 'topup', label: 'Top-Up', icon: 'M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z' },
          ].map((item) => {
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setCurrentTab(item.id as ViewTab)}
                style={{
                  ...dashStyles.navItem,
                  ...(isActive ? dashStyles.navItemActive : {}),
                }}
              >
                <svg
                  style={{
                    ...dashStyles.navIcon,
                    color: isActive ? '#818cf8' : '#64748b',
                  }}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={item.icon} />
                </svg>
                {item.label}
              </button>
            );
          })}
        </nav>

        <div style={dashStyles.sidebarFooter}>
          <button onClick={() => setCurrentTab('settings')} style={{ ...dashStyles.navItem, color: '#94a3b8' }}>
            <svg style={dashStyles.navIcon} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Settings
          </button>
          <button onClick={() => setIsLoggedIn(false)} style={{ ...dashStyles.navItem, color: '#f87171', marginTop: 12 }}>
            <svg style={dashStyles.navIcon} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Logout
          </button>
        </div>
      </aside>

      {/* ───────────────────────────────────────────────────────────
          MAIN PANEL CONTAINER
          ─────────────────────────────────────────────────────────── */}
      <div style={dashStyles.mainContainer}>
        {/* TOP BAR HEADER */}
        <header style={dashStyles.header}>
          <div style={dashStyles.headerLeft}>
            <button style={dashStyles.menuButton}>
              <svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <h2 style={dashStyles.headerTitle}>
              {currentTab === 'dashboard' && 'Dashboard'}
              {currentTab === 'chargepoints' && 'Charge Points'}
              {currentTab === 'energy' && 'Energy Analytics'}
              {currentTab === 'finance' && 'Finance Reports'}
              {currentTab === 'operators' && 'Operators Management'}
              {currentTab === 'history' && 'Transaction History'}
              {currentTab === 'topup' && 'RFID Top-Up Allocation'}
              {currentTab === 'settings' && 'System Settings'}
            </h2>
          </div>

          <div style={dashStyles.headerRight}>
            <button style={dashStyles.notificationBtn}>
              <svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              {criticalAlertsCount > 0 && <span style={dashStyles.notifBadge}>{criticalAlertsCount}</span>}
            </button>

            <div style={dashStyles.profilePill}>
              <div style={dashStyles.avatarCircle}>A</div>
              <div style={dashStyles.profileTextGroup}>
                <div style={dashStyles.profileName}>Admin</div>
                <div style={dashStyles.profileRole}>Super Admin</div>
              </div>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ marginLeft: 6 }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        </header>

        {/* CONTENT VIEWPORT */}
        <main style={dashStyles.contentViewport}>
          
          {/* ───────────────────────────────────────────────────────
              TAB 1: DASHBOARD VIEW
              ─────────────────────────────────────────────────────── */}
          {currentTab === 'dashboard' && (
            <div style={dashStyles.viewContainer}>
              {/* TOP METRICS SUMMARY */}
              <div style={dashStyles.metricsGrid}>
                
                {/* 1. ONLINE CHARGERS */}
                <div style={{ ...dashStyles.metricCard, borderLeft: '4px solid #10b981' }}>
                  <div style={dashStyles.metricCardHeader}>
                    <span style={dashStyles.metricLabel}>ONLINE CHARGERS</span>
                    <span style={{ ...dashStyles.metricIconWrapper, backgroundColor: '#d1fae5', color: '#10b981' }}>🔌</span>
                  </div>
                  <div style={dashStyles.metricValue}>
                    {CHARGER_CONFIGS.length} / {CHARGER_CONFIGS.length}
                  </div>
                  <div style={{ ...dashStyles.metricSubtext, color: '#10b981' }}>100% online</div>
                </div>

                {/* 2. ACTIVE SESSIONS */}
                <div style={{ ...dashStyles.metricCard, borderLeft: '4px solid #3b82f6' }}>
                  <div style={dashStyles.metricCardHeader}>
                    <span style={dashStyles.metricLabel}>ACTIVE SESSIONS</span>
                    <span style={{ ...dashStyles.metricIconWrapper, backgroundColor: '#dbeafe', color: '#3b82f6' }}>⚡</span>
                  </div>
                  <div style={dashStyles.metricValue}>{activeSessionsCount}</div>
                  <div style={{ ...dashStyles.metricSubtext, color: '#3b82f6' }}>Charging now</div>
                </div>

                {/* 3. CRITICAL ALERTS */}
                <div style={{ ...dashStyles.metricCard, borderLeft: '4px solid #8b5cf6' }}>
                  <div style={dashStyles.metricCardHeader}>
                    <span style={dashStyles.metricLabel}>CRITICAL ALERTS</span>
                    <span style={{ ...dashStyles.metricIconWrapper, backgroundColor: '#ede9fe', color: '#8b5cf6' }}>🚨</span>
                  </div>
                  <div style={dashStyles.metricValue}>{criticalAlertsCount}</div>
                  <div style={{ ...dashStyles.metricSubtext, color: '#8b5cf6' }}>Requires attention</div>
                </div>

                {/* 4. TOTAL ENERGY CONSUMPTION */}
                <div style={{ ...dashStyles.metricCard, borderLeft: '4px solid #f97316' }}>
                  <div style={dashStyles.metricCardHeader}>
                    <span style={dashStyles.metricLabel}>ENERGY CONSUMPTION</span>
                    <span style={{ ...dashStyles.metricIconWrapper, backgroundColor: '#ffedd5', color: '#f97316' }}>🔋</span>
                  </div>
                  <div style={dashStyles.metricValue}>
                    {totalKwhConsumedThisMonth.toFixed(2)} <span style={{ fontSize: 16, fontWeight: 500 }}>kWh</span>
                  </div>
                  <div style={{ ...dashStyles.metricSubtext, color: '#f97316' }}>Cumulative this month</div>
                </div>

              </div>

              {/* GRAPHS AND TABLES ROW */}
              <div style={dashStyles.dashGridTwoCol}>
                
                {/* LEFT COLUMN */}
                <div style={dashStyles.dashColLeft}>
                  {/* Energy Consumption chart card */}
                  <div style={dashStyles.panelCard}>
                    <div style={dashStyles.panelHeader}>
                      <h3 style={dashStyles.panelTitle}>ENERGY CONSUMPTION (KWH)</h3>
                      <div style={dashStyles.tabButtonGroup}>
                        <button style={dashStyles.tabBtnActive}>Day</button>
                        <button style={dashStyles.tabBtn}>Week</button>
                        <button style={dashStyles.tabBtn}>Month</button>
                      </div>
                    </div>
                    
                    {/* SVG GRAPH RENDERING */}
                    <div style={dashStyles.graphContainer}>
                      <svg width="100%" height="220" viewBox="0 0 600 220" preserveAspectRatio="none">
                        <defs>
                          <linearGradient id="purpleGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.4"/>
                            <stop offset="100%" stopColor="#c084fc" stopOpacity="0.0"/>
                          </linearGradient>
                        </defs>
                        {/* Horizontal Grid lines */}
                        <line x1="0" y1="40" x2="600" y2="40" stroke="#f1f5f9" strokeWidth="1"/>
                        <line x1="0" y1="90" x2="600" y2="90" stroke="#f1f5f9" strokeWidth="1"/>
                        <line x1="0" y1="140" x2="600" y2="140" stroke="#f1f5f9" strokeWidth="1"/>
                        <line x1="0" y1="190" x2="600" y2="190" stroke="#cbd5e1" strokeWidth="1.5"/>

                        {/* Smooth Bezier Path for Graph Line */}
                        <path
                          d="M 0 160 Q 50 120 100 130 T 200 100 T 300 120 T 400 80 T 500 60 T 600 100 L 600 190 L 0 190 Z"
                          fill="url(#purpleGrad)"
                        />
                        <path
                          d="M 0 160 Q 50 120 100 130 T 200 100 T 300 120 T 400 80 T 500 60 T 600 100"
                          fill="none"
                          stroke="#7c3aed"
                          strokeWidth="3.5"
                        />

                        {/* Data point dots */}
                        <circle cx="400" cy="80" r="5" fill="#7c3aed" stroke="#ffffff" strokeWidth="1.5"/>
                        <circle cx="500" cy="60" r="5" fill="#7c3aed" stroke="#ffffff" strokeWidth="1.5"/>
                      </svg>
                      <div style={dashStyles.graphLabels}>
                        <span>00:00</span>
                        <span>04:00</span>
                        <span>08:00</span>
                        <span>12:00</span>
                        <span>16:00</span>
                        <span>20:00</span>
                        <span>24:00</span>
                      </div>
                    </div>
                  </div>

                  {/* Active Sessions List */}
                  <div style={dashStyles.panelCard}>
                    <div style={dashStyles.panelHeader}>
                      <h3 style={dashStyles.panelTitle}>ACTIVE CHARGING SESSIONS</h3>
                      <button onClick={() => setCurrentTab('chargepoints')} style={dashStyles.panelViewAll}>View all</button>
                    </div>
                    
                    <div style={{ overflowX: 'auto' }}>
                      <table style={dashStyles.table}>
                        <thead>
                          <tr style={dashStyles.tableHeaderRow}>
                            <th style={dashStyles.tableHeaderCell}>Operator</th>
                            <th style={dashStyles.tableHeaderCell}>Charger</th>
                            <th style={dashStyles.tableHeaderCell}>Duration</th>
                            <th style={dashStyles.tableHeaderCell}>Energy</th>
                            <th style={dashStyles.tableHeaderCell}>Power</th>
                            <th style={dashStyles.tableHeaderCell}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* Live Sessions Rendering */}
                          {CHARGER_CONFIGS.map((charger) => {
                            const session = sessions[charger.chargerId];
                            if (!session || session.status === 'IDLE') return null;

                            const rfidInfo = rfidCards.find((c) => c.rfidCardId === session.activeRfid);
                            const name = rfidInfo?.cardholderName || 'RFID Swiped';

                            return (
                              <tr key={charger.chargerId} style={dashStyles.tableBodyRowActive}>
                                <td style={dashStyles.tableBodyCell}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <div style={{ ...dashStyles.userAvatar, backgroundColor: '#818cf8' }}>
                                      {name.charAt(0)}
                                    </div>
                                    <div>
                                      <div style={dashStyles.userName}>{name}</div>
                                      <div style={dashStyles.userSub}>{session.activeRfid}</div>
                                    </div>
                                  </div>
                                </td>
                                <td style={dashStyles.tableBodyCell}><strong>{charger.chargerId}</strong></td>
                                <td style={dashStyles.tableBodyCell}>
                                  {session.telemetry
                                    ? `${Math.floor(session.telemetry.durationSeconds / 60)}m ${session.telemetry.durationSeconds % 60}s`
                                    : 'Preparing...'}
                                </td>
                                <td style={dashStyles.tableBodyCell}>
                                  {session.telemetry ? `${session.telemetry.energyDeliveredKwh.toFixed(3)} kWh` : '0.000 kWh'}
                                </td>
                                <td style={dashStyles.tableBodyCell}>
                                  {session.telemetry ? `${session.telemetry.powerKw} kW` : '0.0 kW'}
                                </td>
                                <td style={dashStyles.tableBodyCell}>
                                  <span style={{ 
                                    ...dashStyles.statusPill, 
                                    backgroundColor: session.status === 'CHARGING' ? '#d1fae5' : '#fef3c7',
                                    color: session.status === 'CHARGING' ? '#065f46' : '#92400e',
                                  }}>
                                    ● {session.status}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}

                          {/* Mock Sessions for display to match screenshot */}
                          <tr style={dashStyles.tableBodyRow}>
                            <td style={dashStyles.tableBodyCell}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <div style={{ ...dashStyles.userAvatar, backgroundColor: '#10b981' }}>JS</div>
                                <div>
                                  <div style={dashStyles.userName}>John Smith</div>
                                  <div style={dashStyles.userSub}>RFID-8812</div>
                                </div>
                              </div>
                            </td>
                            <td style={dashStyles.tableBodyCell}>EV-001</td>
                            <td style={dashStyles.tableBodyCell}>01:24:15</td>
                            <td style={dashStyles.tableBodyCell}>23.4 kWh</td>
                            <td style={dashStyles.tableBodyCell}>50 kW</td>
                            <td style={dashStyles.tableBodyCell}>
                              <span style={{ ...dashStyles.statusPill, backgroundColor: '#d1fae5', color: '#065f46' }}>
                                ● Charging
                              </span>
                            </td>
                          </tr>
                          <tr style={dashStyles.tableBodyRow}>
                            <td style={dashStyles.tableBodyCell}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <div style={{ ...dashStyles.userAvatar, backgroundColor: '#fbbf24' }}>SC</div>
                                <div>
                                  <div style={dashStyles.userName}>Sarah Cruz</div>
                                  <div style={dashStyles.userSub}>RFID-5412</div>
                                </div>
                              </div>
                            </td>
                            <td style={dashStyles.tableBodyCell}>EV-008</td>
                            <td style={dashStyles.tableBodyCell}>00:58:42</td>
                            <td style={dashStyles.tableBodyCell}>17.8 kWh</td>
                            <td style={dashStyles.tableBodyCell}>50 kW</td>
                            <td style={dashStyles.tableBodyCell}>
                              <span style={{ ...dashStyles.statusPill, backgroundColor: '#d1fae5', color: '#065f46' }}>
                                ● Charging
                              </span>
                            </td>
                          </tr>
                          <tr style={dashStyles.tableBodyRow}>
                            <td style={dashStyles.tableBodyCell}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <div style={{ ...dashStyles.userAvatar, backgroundColor: '#ec4899' }}>MD</div>
                                <div>
                                  <div style={dashStyles.userName}>Mike Davis</div>
                                  <div style={dashStyles.userSub}>RFID-3211</div>
                                </div>
                              </div>
                            </td>
                            <td style={dashStyles.tableBodyCell}>EV-003</td>
                            <td style={dashStyles.tableBodyCell}>02:11:06</td>
                            <td style={dashStyles.tableBodyCell}>46.5 kWh</td>
                            <td style={dashStyles.tableBodyCell}>100 kW</td>
                            <td style={dashStyles.tableBodyCell}>
                              <span style={{ ...dashStyles.statusPill, backgroundColor: '#d1fae5', color: '#065f46' }}>
                                ● Charging
                              </span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* RIGHT COLUMN */}
                <div style={dashStyles.dashColRight}>
                  {/* Recent Alerts */}
                  <div style={dashStyles.panelCard}>
                    <div style={dashStyles.panelHeader}>
                      <h3 style={dashStyles.panelTitle}>RECENT ALERTS</h3>
                      <button style={dashStyles.panelViewAll}>View all</button>
                    </div>

                    <div style={dashStyles.alertList}>
                      {/* Critical Alert if telemetry exceeded limit */}
                      {Object.entries(sessions).map(([id, session]) => {
                        if (session.status !== 'ERROR') return null;
                        return (
                          <div key={id} style={{ ...dashStyles.alertItem, borderLeft: '4px solid #ef4444' }}>
                            <div style={dashStyles.alertHeader}>
                              <span style={{ ...dashStyles.alertTitle, color: '#ef4444' }}>{id} Status Critical</span>
                              <span style={dashStyles.alertTime}>Just now</span>
                            </div>
                            <div style={dashStyles.alertBody}>{session.statusMessage}</div>
                          </div>
                        );
                      })}

                      <div style={dashStyles.alertItem}>
                        <div style={dashStyles.alertHeader}>
                          <span style={dashStyles.alertTitle}>EV-003 Offline</span>
                          <span style={dashStyles.alertTime}>2m ago</span>
                        </div>
                        <div style={dashStyles.alertBody}>Charger not responding to central system heartbeat.</div>
                      </div>

                      <div style={{ ...dashStyles.alertItem, borderLeft: '4px solid #f97316' }}>
                        <div style={dashStyles.alertHeader}>
                          <span style={{ ...dashStyles.alertTitle, color: '#f97316' }}>EV-011 High Temperature</span>
                          <span style={dashStyles.alertTime}>10m ago</span>
                        </div>
                        <div style={dashStyles.alertBody}>Internal thermometer registers 78°C. Temperature above threshold.</div>
                      </div>

                      <div style={dashStyles.alertItem}>
                        <div style={dashStyles.alertHeader}>
                          <span style={dashStyles.alertTitle}>Communication Timeout</span>
                          <span style={dashStyles.alertTime}>25m ago</span>
                        </div>
                        <div style={dashStyles.alertBody}>EV-015 connection lost during BootNotification handshake.</div>
                      </div>
                    </div>
                  </div>

                  {/* Charger Health Status */}
                  <div style={dashStyles.panelCard}>
                    <h3 style={dashStyles.panelTitle}>CHARGER HEALTH STATUS</h3>
                    
                    <div style={dashStyles.healthLayout}>
                      {/* SVG Donut Chart */}
                      <div style={dashStyles.donutWrapper}>
                        <svg width="120" height="120" viewBox="0 0 120 120">
                          {/* Total 30 circle segments */}
                          {/* Segment 1: Healthy (87% - Green) */}
                          <circle cx="60" cy="60" r="45" fill="transparent" stroke="#10b981" strokeWidth="15" strokeDasharray="282" strokeDashoffset="36" />
                          {/* Segment 2: Warning (10% - Orange) */}
                          <circle cx="60" cy="60" r="45" fill="transparent" stroke="#f59e0b" strokeWidth="15" strokeDasharray="282" strokeDashoffset="0" transform="rotate(-45 60 60)" />
                          {/* Segment 3: Critical (3% - Purple) */}
                          <circle cx="60" cy="60" r="45" fill="transparent" stroke="#8b5cf6" strokeWidth="15" strokeDasharray="282" strokeDashoffset="260" transform="rotate(220 60 60)" />
                        </svg>
                        <div style={dashStyles.donutText}>
                          <div style={dashStyles.donutNumber}>30</div>
                          <div style={dashStyles.donutLabel}>Total</div>
                        </div>
                      </div>

                      <div style={dashStyles.healthLegend}>
                        <div style={dashStyles.legendItem}>
                          <span style={{ ...dashStyles.legendDot, backgroundColor: '#10b981' }} />
                          <span style={dashStyles.legendLabel}>Healthy</span>
                          <span style={dashStyles.legendValue}>26 (87%)</span>
                        </div>
                        <div style={dashStyles.legendItem}>
                          <span style={{ ...dashStyles.legendDot, backgroundColor: '#f59e0b' }} />
                          <span style={dashStyles.legendLabel}>Warning</span>
                          <span style={dashStyles.legendValue}>3 (10%)</span>
                        </div>
                        <div style={dashStyles.legendItem}>
                          <span style={{ ...dashStyles.legendDot, backgroundColor: '#8b5cf6' }} />
                          <span style={dashStyles.legendLabel}>Critical</span>
                          <span style={dashStyles.legendValue}>1 (3%)</span>
                        </div>
                        <div style={dashStyles.viewDetailsLink}>
                          View details <span style={{ marginLeft: 4 }}>→</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* ───────────────────────────────────────────────────────
              TAB 2: CHARGEPOINTS VIEW (STATIONS AND BAYS)
              ─────────────────────────────────────────────────────── */}
          {currentTab === 'chargepoints' && (
            <div style={dashStyles.viewContainer}>
              <div style={cpStyles.searchHeader}>
                <div style={cpStyles.searchInputGroup}>
                  <svg style={cpStyles.searchIcon} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input type="text" placeholder="Search station or location..." style={cpStyles.searchInput} />
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <select style={cpStyles.selectFilter}>
                    <option>All statuses</option>
                    <option>Online</option>
                    <option>Maintenance</option>
                  </select>
                  <button onClick={() => setCurrentTab('topup')} style={cpStyles.addStationBtn}>
                    + Add Station
                  </button>
                </div>
              </div>

              {/* STATIONS GRID */}
              <div style={cpStyles.stationsGrid}>
                
                {/* 1. MINE SITE DEPOT (OUR ACTIVE CHARGERS) */}
                <div style={cpStyles.stationCard}>
                  <div style={cpStyles.stationHeader}>
                    <div>
                      <h4 style={cpStyles.stationName}>
                        Mine Site Depot <span style={cpStyles.onlineBadge}>Online</span>
                      </h4>
                      <p style={cpStyles.stationLoc}>📍 Semirara Island Operations</p>
                    </div>
                    <button style={cpStyles.stationConfigBtn}>⚙️</button>
                  </div>

                  <div style={cpStyles.stationMetaRow}>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>5/12</span>
                      <span style={cpStyles.metaBoxLbl}>Slots</span>
                    </div>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>1,840 kWh</span>
                      <span style={cpStyles.metaBoxLbl}>Consumed</span>
                    </div>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>68%</span>
                      <span style={cpStyles.metaBoxLbl}>Util.</span>
                    </div>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>6 units</span>
                      <span style={cpStyles.metaBoxLbl}>Chargers</span>
                    </div>
                  </div>

                  {/* BAYS LIST */}
                  <div style={cpStyles.baysList}>
                    {/* BAY A1 - Live (Mapped to BENY-002) */}
                    <div
                      onClick={() => setSelectedChargerId('BENY-002')}
                      style={{
                        ...cpStyles.bayItem,
                        ...(sessions['BENY-002'].status !== 'IDLE' ? cpStyles.bayItemActive : {}),
                      }}
                    >
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot(
                          sessions['BENY-002'].status === 'CHARGING' ? '#3b82f6' : 
                          sessions['BENY-002'].status === 'PREPARING' ? '#f59e0b' : 
                          sessions['BENY-002'].status === 'ERROR' ? '#ef4444' : '#10b981'
                        )} />
                        <div>
                          <div style={cpStyles.bayName}>Bay A1 (BENY-002)</div>
                          <div style={cpStyles.bayStatus}>
                            {sessions['BENY-002'].status} - {sessions['BENY-002'].statusMessage}
                          </div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>
                        {sessions['BENY-002'].telemetry 
                          ? `${sessions['BENY-002'].telemetry.energyDeliveredKwh.toFixed(2)} kWh today`
                          : 'Interactive'}
                      </div>
                    </div>

                    {/* BAY A2 - Live (Mapped to BENY-001) */}
                    <div
                      onClick={() => setSelectedChargerId('BENY-001')}
                      style={{
                        ...cpStyles.bayItem,
                        ...(sessions['BENY-001'].status !== 'IDLE' ? cpStyles.bayItemActive : {}),
                      }}
                    >
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot(
                          sessions['BENY-001'].status === 'CHARGING' ? '#3b82f6' : 
                          sessions['BENY-001'].status === 'PREPARING' ? '#f59e0b' : 
                          sessions['BENY-001'].status === 'ERROR' ? '#ef4444' : '#10b981'
                        )} />
                        <div>
                          <div style={cpStyles.bayName}>Bay A2 (BENY-001)</div>
                          <div style={cpStyles.bayStatus}>
                            {sessions['BENY-001'].status} - {sessions['BENY-001'].statusMessage}
                          </div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>
                        {sessions['BENY-001'].telemetry 
                          ? `${sessions['BENY-001'].telemetry.energyDeliveredKwh.toFixed(2)} kWh today`
                          : 'Interactive'}
                      </div>
                    </div>

                    {/* MOCK STATIC BAYS TO COMPLETE LOOK */}
                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#f59e0b')} />
                        <div>
                          <div style={cpStyles.bayName}>Bay A3</div>
                          <div style={cpStyles.bayStatus}>Preparing</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>18 kWh today</div>
                    </div>

                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#10b981')} />
                        <div>
                          <div style={cpStyles.bayName}>Bay A4</div>
                          <div style={cpStyles.bayStatus}>Available</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>41 kWh today</div>
                    </div>

                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#ef4444')} />
                        <div>
                          <div style={cpStyles.bayName}>Bay A5</div>
                          <div style={cpStyles.bayStatus}>Faulted</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>0 kWh today</div>
                    </div>

                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#3b82f6')} />
                        <div>
                          <div style={cpStyles.bayName}>Bay A6</div>
                          <div style={cpStyles.bayStatus}>Charging</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>57 kWh today</div>
                    </div>

                  </div>
                  <div style={cpStyles.stationFooter}>View all bays →</div>
                </div>

                {/* 2. POWER PLANT HUB */}
                <div style={cpStyles.stationCard}>
                  <div style={cpStyles.stationHeader}>
                    <div>
                      <h4 style={cpStyles.stationName}>
                        Power Plant Hub <span style={cpStyles.onlineBadge}>Online</span>
                      </h4>
                      <p style={cpStyles.stationLoc}>📍 Power Generation Complex</p>
                    </div>
                    <button style={cpStyles.stationConfigBtn}>⚙️</button>
                  </div>

                  <div style={cpStyles.stationMetaRow}>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>3/10</span>
                      <span style={cpStyles.metaBoxLbl}>Slots</span>
                    </div>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>1,495 kWh</span>
                      <span style={cpStyles.metaBoxLbl}>Consumed</span>
                    </div>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>74%</span>
                      <span style={cpStyles.metaBoxLbl}>Util.</span>
                    </div>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>5 units</span>
                      <span style={cpStyles.metaBoxLbl}>Chargers</span>
                    </div>
                  </div>

                  {/* BAYS LIST */}
                  <div style={cpStyles.baysList}>
                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#3b82f6')} />
                        <div>
                          <div style={cpStyles.bayName}>Bay B1</div>
                          <div style={cpStyles.bayStatus}>Charging</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>71 kWh today</div>
                    </div>

                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#3b82f6')} />
                        <div>
                          <div style={cpStyles.bayName}>Bay B2</div>
                          <div style={cpStyles.bayStatus}>Charging</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>66 kWh today</div>
                    </div>

                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#10b981')} />
                        <div>
                          <div style={cpStyles.bayName}>Bay B3</div>
                          <div style={cpStyles.bayStatus}>Available</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>29 kWh today</div>
                    </div>

                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#f59e0b')} />
                        <div>
                          <div style={cpStyles.bayName}>Bay B4</div>
                          <div style={cpStyles.bayStatus}>Maintenance</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>8 kWh today</div>
                    </div>

                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#10b981')} />
                        <div>
                          <div style={cpStyles.bayName}>Bay B5</div>
                          <div style={cpStyles.bayStatus}>Available</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>24 kWh today</div>
                    </div>
                  </div>
                  <div style={cpStyles.stationFooter}>View all bays →</div>
                </div>

                {/* 3. PORT TERMINAL */}
                <div style={cpStyles.stationCard}>
                  <div style={cpStyles.stationHeader}>
                    <div>
                      <h4 style={cpStyles.stationName}>
                        Port Terminal <span style={{ ...cpStyles.onlineBadge, backgroundColor: '#ffedd5', color: '#ea580c' }}>Maintenance</span>
                      </h4>
                      <p style={cpStyles.stationLoc}>📍 Coal Handling and Logistics</p>
                    </div>
                    <button style={cpStyles.stationConfigBtn}>⚙️</button>
                  </div>

                  <div style={cpStyles.stationMetaRow}>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>2/8</span>
                      <span style={cpStyles.metaBoxLbl}>Slots</span>
                    </div>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>920 kWh</span>
                      <span style={cpStyles.metaBoxLbl}>Consumed</span>
                    </div>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>56%</span>
                      <span style={cpStyles.metaBoxLbl}>Util.</span>
                    </div>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>4 units</span>
                      <span style={cpStyles.metaBoxLbl}>Chargers</span>
                    </div>
                  </div>

                  {/* BAYS LIST */}
                  <div style={cpStyles.baysList}>
                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#10b981')} />
                        <div>
                          <div style={cpStyles.bayName}>Dock 1</div>
                          <div style={cpStyles.bayStatus}>Available</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>19 kWh today</div>
                    </div>

                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#94a3b8')} />
                        <div>
                          <div style={cpStyles.bayName}>Dock 2</div>
                          <div style={cpStyles.bayStatus}>Offline</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>0 kWh today</div>
                    </div>

                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#f59e0b')} />
                        <div>
                          <div style={cpStyles.bayName}>Dock 3</div>
                          <div style={cpStyles.bayStatus}>Maintenance</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>7 kWh today</div>
                    </div>

                    <div style={cpStyles.bayItemStatic}>
                      <div style={cpStyles.bayLeft}>
                        <div style={cpStyles.bayDot('#3b82f6')} />
                        <div>
                          <div style={cpStyles.bayName}>Dock 4</div>
                          <div style={cpStyles.bayStatus}>Charging</div>
                        </div>
                      </div>
                      <div style={cpStyles.bayUsage}>44 kWh today</div>
                    </div>
                  </div>
                  <div style={cpStyles.stationFooter}>View all bays →</div>
                </div>

              </div>

              {/* CHARGER CONTROL PANEL MODAL/DRAWER (REAL-TIME POPUP ON CLICK BAYS) */}
              {selectedChargerId && (
                <div style={cpStyles.overlay}>
                  <div style={cpStyles.modalCard}>
                    <div style={cpStyles.modalHeader}>
                      <div>
                        <h3 style={cpStyles.modalTitle}>Charger Controller</h3>
                        <p style={cpStyles.modalSubtitle}>Device: {selectedChargerId}</p>
                      </div>
                      <button onClick={() => { setSelectedChargerId(null); setActivationError(''); }} style={cpStyles.closeModalBtn}>✕</button>
                    </div>

                    {/* INTERACTIVE CONTROLS */}
                    {sessions[selectedChargerId].status === 'IDLE' && (
                      <div style={cpStyles.modalBody}>
                        <p style={{ color: '#475569', fontSize: 14, marginBottom: 20 }}>
                          Select a registered RFID card to simulate tap and authorize the charging session on {selectedChargerId}.
                        </p>
                        
                        <div style={dashStyles.formGroup}>
                          <label style={dashStyles.label}>Select RFID Card</label>
                          <select
                            value={selectedRfid}
                            onChange={(e) => setSelectedRfid(e.target.value)}
                            style={dashStyles.input}
                          >
                            <option value="">-- Choose RFID Card --</option>
                            {rfidCards.filter(c => c.isActive).map((card) => (
                              <option key={card.rfidCardId} value={card.rfidCardId}>
                                {card.rfidCardId} - {card.cardholderName} ({card.currentMonthKwhConsumed.toFixed(1)}/{card.monthlyKwhLimit} kWh){isCardExhausted(card) ? ' — QUOTA EXHAUSTED' : ''}
                              </option>
                            ))}
                          </select>
                        </div>

                        {selectedRfid && (
                          <div style={cpStyles.cardPreview}>
                            <div style={cpStyles.cardPreviewHeader}>
                              <span>STRATACORE MEMBER</span>
                              <span>RFID CHIP</span>
                            </div>
                            <div style={cpStyles.cardPreviewId}>{selectedRfid}</div>
                            <div style={cpStyles.cardPreviewName}>
                              {rfidCards.find(c => c.rfidCardId === selectedRfid)?.cardholderName}
                            </div>
                            <div style={{ marginTop: 15 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#a78bfa' }}>
                                <span>Monthly Limit</span>
                                <span>{rfidCards.find(c => c.rfidCardId === selectedRfid)?.monthlyKwhLimit} kWh</span>
                              </div>
                              <div style={cpStyles.progressBarBg}>
                                <div style={{ 
                                  ...cpStyles.progressBarFill, 
                                  width: `${Math.min(
                                    ((rfidCards.find(c => c.rfidCardId === selectedRfid)?.currentMonthKwhConsumed || 0) / 
                                    (rfidCards.find(c => c.rfidCardId === selectedRfid)?.monthlyKwhLimit || 1)) * 100, 
                                    100
                                  )}%` 
                                }} />
                              </div>
                            </div>
                          </div>
                        )}

                        {(() => {
                          const card = rfidCards.find(c => c.rfidCardId === selectedRfid);
                          const exhausted = card ? isCardExhausted(card) : false;
                          return (
                            <>
                              {exhausted && (
                                <div style={{ ...loginStyles.errorMessage, marginTop: 10 }}>
                                  Monthly quota exhausted ({card!.currentMonthKwhConsumed.toFixed(2)}/{card!.monthlyKwhLimit} kWh).
                                  This card cannot charge until it resets on {formatResetLabel()}.
                                </div>
                              )}
                              {activationError && <div style={{ ...loginStyles.errorMessage, marginTop: 10 }}>{activationError}</div>}

                              <button
                                onClick={handleStartCharging}
                                disabled={!selectedRfid || exhausted}
                                style={{
                                  ...dashStyles.btnSubmit,
                                  marginTop: 20,
                                  opacity: (!selectedRfid || exhausted) ? 0.6 : 1,
                                  cursor: (!selectedRfid || exhausted) ? 'not-allowed' : 'pointer',
                                }}
                              >
                                {exhausted ? 'Quota Exhausted — Charging Blocked' : 'Simulate Tap & Start Charging'}
                              </button>
                            </>
                          );
                        })()}
                      </div>
                    )}

                    {sessions[selectedChargerId].status === 'PREPARING' && (
                      <div style={cpStyles.modalBody}>
                        <div style={cpStyles.connectionGraphic}>
                          <span style={{ fontSize: 32 }}>🔌</span>
                          <div style={cpStyles.connLine}>
                            <div style={cpStyles.connPulse} />
                          </div>
                          <span style={{ fontSize: 32 }}>🚗</span>
                        </div>
                        <h4 style={{ textAlign: 'center', color: '#f59e0b', margin: '20px 0 10px' }}>PREPARING CHARGER</h4>
                        <p style={{ textAlign: 'center', color: '#475569', fontSize: 13 }}>
                          {sessions[selectedChargerId].statusMessage}
                        </p>
                        <button
                          onClick={() => handleStopCharging(selectedChargerId)}
                          style={{ ...cpStyles.stopBtn, marginTop: 24 }}
                        >
                          Cancel / Stop Transaction
                        </button>
                      </div>
                    )}

                    {sessions[selectedChargerId].status === 'CHARGING' && (
                      <div style={cpStyles.modalBody}>
                        <div style={cpStyles.liveStatRow}>
                          <div style={cpStyles.liveGauge}>
                            <div style={cpStyles.liveGaugeVal}>
                              {sessions[selectedChargerId].telemetry
                                ? sessions[selectedChargerId].telemetry?.energyDeliveredKwh.toFixed(3)
                                : '0.000'}
                            </div>
                            <div style={cpStyles.liveGaugeLbl}>kWh DELIVERED</div>
                          </div>
                        </div>

                        {/* Live monthly quota for the tapped card */}
                        {(() => {
                          const activeRfid = sessions[selectedChargerId].activeRfid;
                          const card = activeRfid ? rfidCards.find(c => c.rfidCardId === activeRfid) : undefined;
                          if (!card) return null;
                          const pct = Math.min((card.currentMonthKwhConsumed / card.monthlyKwhLimit) * 100, 100);
                          const remaining = Math.max(0, card.monthlyKwhLimit - card.currentMonthKwhConsumed);
                          return (
                            <div style={{ marginTop: 16, padding: '12px 14px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                                <span style={{ color: '#475569', fontWeight: 600 }}>{card.rfidCardId} · {card.cardholderName}</span>
                                <span style={{ color: pct >= 100 ? '#ef4444' : '#475569' }}>
                                  {card.currentMonthKwhConsumed.toFixed(3)} / {card.monthlyKwhLimit} kWh
                                </span>
                              </div>
                              <div style={dashStyles.tableProgressBg}>
                                <div style={{ ...dashStyles.tableProgressFill, width: `${pct}%`, backgroundColor: pct >= 100 ? '#ef4444' : '#7c3aed' }} />
                              </div>
                              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
                                {remaining.toFixed(3)} kWh remaining this month
                              </div>
                            </div>
                          );
                        })()}

                        {sessions[selectedChargerId].telemetry && (
                          <div style={dashStyles.metricsGrid}>
                            <div style={cpStyles.telemetryMiniCard}>
                              <div style={cpStyles.telemetryLbl}>POWER FLOW</div>
                              <div style={cpStyles.telemetryVal}>{sessions[selectedChargerId].telemetry?.powerKw} kW</div>
                            </div>
                            <div style={cpStyles.telemetryMiniCard}>
                              <div style={cpStyles.telemetryLbl}>ESTIMATED COST</div>
                              <div style={cpStyles.telemetryVal}><span style={{ color: '#10b981' }}>PHP {sessions[selectedChargerId].telemetry?.estimatedCost.toFixed(2)}</span></div>
                            </div>
                            <div style={cpStyles.telemetryMiniCard}>
                              <div style={cpStyles.telemetryLbl}>VOLT / AMPS</div>
                              <div style={cpStyles.telemetryVal}>{sessions[selectedChargerId].telemetry?.voltageVolts}V · {sessions[selectedChargerId].telemetry?.currentAmps}A</div>
                            </div>
                            <div style={cpStyles.telemetryMiniCard}>
                              <div style={cpStyles.telemetryLbl}>DURATION</div>
                              <div style={cpStyles.telemetryVal}>
                                {Math.floor((sessions[selectedChargerId].telemetry?.durationSeconds || 0) / 60)}m {((sessions[selectedChargerId].telemetry?.durationSeconds || 0) % 60)}s
                              </div>
                            </div>
                          </div>
                        )}

                        <button
                          onClick={() => handleStopCharging(selectedChargerId)}
                          style={{ ...cpStyles.stopBtn, marginTop: 20 }}
                        >
                          Stop Charging session
                        </button>
                      </div>
                    )}

                    {(sessions[selectedChargerId].status === 'COMPLETED' || sessions[selectedChargerId].status === 'ERROR') && (
                      <div style={cpStyles.modalBody}>
                        <div style={{
                          textAlign: 'center',
                          padding: '30px 10px',
                          color: sessions[selectedChargerId].status === 'COMPLETED' ? '#10b981' : '#ef4444'
                        }}>
                          <span style={{ fontSize: 48 }}>
                            {sessions[selectedChargerId].status === 'COMPLETED' ? '✓' : '⚠'}
                          </span>
                          <h4 style={{ margin: '15px 0 10px' }}>
                            {sessions[selectedChargerId].status === 'COMPLETED' ? 'CHARGING COMPLETE' : 'SESSION TERMINATED'}
                          </h4>
                          <p style={{ color: '#64748b', fontSize: 13 }}>
                            {sessions[selectedChargerId].statusMessage}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ───────────────────────────────────────────────────────
              TAB 3: TOP-UP RFID REGISTRY VIEW (RFID MANAGEMENT)
              ─────────────────────────────────────────────────────── */}
          {currentTab === 'topup' && (
            <div style={dashStyles.viewContainer}>
              <div style={dashStyles.dashGridTwoCol}>
                
                {/* LEFT COLUMN: MANUALLY ADD RFID */}
                <div style={{ flex: '1 1 350px' }}>
                  <div style={dashStyles.panelCard}>
                    <h3 style={dashStyles.panelTitle}>ADD NEW RFID CARD</h3>
                    <p style={{ color: '#64748b', fontSize: 13, marginBottom: 20 }}>
                      Enter the RFID card details and allocate custom monthly kWh limit below.
                    </p>

                    <form onSubmit={handleRegisterRfid}>
                      <div style={dashStyles.formGroup}>
                        <label style={dashStyles.label}>RFID Card Number / ID</label>
                        <input
                          type="text"
                          placeholder="e.g. RFID-8812"
                          value={newCardId}
                          onChange={(e) => setNewCardId(e.target.value)}
                          style={dashStyles.input}
                        />
                      </div>

                      <div style={dashStyles.formGroup}>
                        <label style={dashStyles.label}>Cardholder Name</label>
                        <input
                          type="text"
                          placeholder="e.g. John Smith"
                          value={newCardholder}
                          onChange={(e) => setNewCardholder(e.target.value)}
                          style={dashStyles.input}
                        />
                      </div>

                      <div style={dashStyles.formGroup}>
                        <label style={dashStyles.label}>Allocate Monthly Quota (kWh)</label>
                        <input
                          type="number"
                          placeholder="e.g. 200"
                          value={newCardLimit}
                          onChange={(e) => setNewCardLimit(e.target.value)}
                          style={dashStyles.input}
                        />
                      </div>

                      {formError && <div style={{ ...loginStyles.errorMessage, marginBottom: 15 }}>{formError}</div>}
                      {formSuccess && <div style={{ ...dashStyles.successMessage, marginBottom: 15 }}>{formSuccess}</div>}

                      <button type="submit" style={dashStyles.btnSubmit}>
                        Register RFID Card
                      </button>
                    </form>
                  </div>
                </div>

                {/* RIGHT COLUMN: CARD REGISTRY TABLE */}
                <div style={{ flex: '2 1 600px' }}>
                  <div style={dashStyles.panelCard}>
                    <h3 style={dashStyles.panelTitle}>RFID CARD REGISTRY</h3>
                    <p style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>
                      Allocations reset automatically on the 1st of each month. Next reset: <strong style={{ color: '#7c3aed' }}>{formatResetLabel()}</strong>.
                    </p>
                    <div style={{ overflowX: 'auto', marginTop: 15 }}>
                      <table style={dashStyles.table}>
                        <thead>
                          <tr style={dashStyles.tableHeaderRow}>
                            <th style={dashStyles.tableHeaderCell}>RFID Card ID</th>
                            <th style={dashStyles.tableHeaderCell}>Cardholder</th>
                            <th style={dashStyles.tableHeaderCell}>Limit Quota</th>
                            <th style={dashStyles.tableHeaderCell}>Usage (Monthly)</th>
                            <th style={dashStyles.tableHeaderCell}>Status</th>
                            <th style={dashStyles.tableHeaderCell}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rfidCards.map((card) => {
                            const pct = Math.min((card.currentMonthKwhConsumed / card.monthlyKwhLimit) * 100, 100);
                            const isExhausted = card.currentMonthKwhConsumed >= card.monthlyKwhLimit;

                            return (
                              <tr key={card.rfidCardId} style={dashStyles.tableBodyRow}>
                                <td style={dashStyles.tableBodyCell}>
                                  <span style={dashStyles.rfidPill}>{card.rfidCardId}</span>
                                </td>
                                <td style={dashStyles.tableBodyCell}>
                                  <strong>{card.cardholderName}</strong>
                                </td>
                                <td style={dashStyles.tableBodyCell}>
                                  {card.monthlyKwhLimit} kWh
                                </td>
                                <td style={dashStyles.tableBodyCell}>
                                  <div style={{ display: 'flex', flexDirection: 'column', width: 130 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                                      <span style={{ color: isExhausted ? '#ef4444' : '#475569', fontWeight: isExhausted ? 700 : 500 }}>
                                        {card.currentMonthKwhConsumed.toFixed(2)} kWh
                                      </span>
                                      <span style={{ color: '#94a3b8' }}>{pct.toFixed(0)}%</span>
                                    </div>
                                    <div style={dashStyles.tableProgressBg}>
                                      <div style={{ 
                                        ...dashStyles.tableProgressFill, 
                                        width: `${pct}%`,
                                        backgroundColor: isExhausted ? '#ef4444' : '#818cf8',
                                      }} />
                                    </div>
                                  </div>
                                </td>
                                <td style={dashStyles.tableBodyCell}>
                                  <button
                                    onClick={() => handleToggleCardStatus(card)}
                                    style={{
                                      ...dashStyles.badgeButton,
                                      backgroundColor: card.isActive ? '#d1fae5' : '#fee2e2',
                                      color: card.isActive ? '#065f46' : '#991b1b',
                                    }}
                                  >
                                    {card.isActive ? 'Active' : 'Blocked'}
                                  </button>
                                </td>
                                <td style={dashStyles.tableBodyCell}>
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    <button
                                      onClick={() => handleOpenEdit(card)}
                                      style={dashStyles.editBtn}
                                      title="Edit cardholder name and monthly kWh allocation"
                                    >
                                      Edit
                                    </button>
                                    <button
                                      onClick={() => handleResetQuota(card.rfidCardId)}
                                      style={dashStyles.resetBtn}
                                      title="Reset current monthly consumption to 0"
                                    >
                                      Reset
                                    </button>
                                    <button
                                      onClick={() => handleDeleteRfid(card.rfidCardId)}
                                      style={dashStyles.deleteBtn}
                                      title="Delete Card"
                                    >
                                      🗑️
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                          {rfidCards.length === 0 && (
                            <tr>
                              <td colSpan={6} style={{ textAlign: 'center', padding: '30px 10px', color: '#94a3b8' }}>
                                No RFID Cards registered. Add one using the form.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

              </div>

              {/* EDIT ALLOCATION MODAL */}
              {editingCard && (
                <div style={cpStyles.overlay}>
                  <div style={{ ...cpStyles.modalCard, maxWidth: 460 }}>
                    <div style={cpStyles.modalHeader}>
                      <div>
                        <h3 style={cpStyles.modalTitle}>Edit Allocation</h3>
                        <p style={cpStyles.modalSubtitle}>Card: {editingCard.rfidCardId}</p>
                      </div>
                      <button onClick={() => setEditingCard(null)} style={cpStyles.closeModalBtn}>✕</button>
                    </div>

                    <div style={cpStyles.modalBody}>
                      <form onSubmit={handleSaveEdit}>
                        <div style={dashStyles.formGroup}>
                          <label style={dashStyles.label}>Cardholder Name</label>
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            style={dashStyles.input}
                          />
                        </div>

                        <div style={dashStyles.formGroup}>
                          <label style={dashStyles.label}>Monthly Quota (kWh)</label>
                          <input
                            type="number"
                            value={editLimit}
                            onChange={(e) => setEditLimit(e.target.value)}
                            style={dashStyles.input}
                          />
                          <p style={{ color: '#64748b', fontSize: 12, marginTop: 6 }}>
                            Consumed so far this month: <strong>{editingCard.currentMonthKwhConsumed.toFixed(2)} kWh</strong>.
                            Changing the limit keeps existing consumption. Quota resets on {formatResetLabel()}.
                          </p>
                        </div>

                        {editError && <div style={{ ...loginStyles.errorMessage, marginBottom: 15 }}>{editError}</div>}

                        <button type="submit" style={dashStyles.btnSubmit}>
                          Save Allocation
                        </button>
                      </form>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ───────────────────────────────────────────────────────
              OTHER MOCK VIEWS (ENERGY, FINANCE, OPERATORS, HISTORY, SETTINGS)
              ─────────────────────────────────────────────────────── */}
          {(currentTab === 'energy' || currentTab === 'finance' || currentTab === 'operators' || currentTab === 'history' || currentTab === 'settings') && (
            <div style={dashStyles.viewContainer}>
              <div style={dashStyles.panelCard}>
                <h3 style={dashStyles.panelTitle}>
                  {currentTab.toUpperCase()} PANEL
                </h3>
                <p style={{ color: '#64748b', fontSize: 14, marginTop: 10 }}>
                  This screen is currently in mock display mode. Real-time logging is fully functional under <strong>Dashboard</strong>, <strong>Chargepoints</strong>, and <strong>Top-Up</strong> tabs.
                </p>
                <div style={{ marginTop: 24, padding: 40, border: '2px dashed #cbd5e1', borderRadius: 12, textAlign: 'center', color: '#94a3b8' }}>
                  📊 Analytics and Report details will show up here.
                </div>
              </div>
            </div>
          )}

        </main>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// STYLES DEFINITION
// ═══════════════════════════════════════════════════════════════

const loginStyles = {
  pageWrapper: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
    position: 'relative' as const,
    overflow: 'hidden' as const,
    fontFamily: '"Inter", sans-serif',
  },
  bgLeftSVG: {
    position: 'absolute' as const,
    left: 0,
    top: 0,
    zIndex: 1,
  },
  bgRightSVG: {
    position: 'absolute' as const,
    right: 0,
    bottom: 0,
    zIndex: 1,
  },
  cardContainer: {
    backgroundColor: '#ffffff',
    padding: '40px 30px',
    borderRadius: 24,
    border: '1px solid #e2e8f0',
    boxShadow: '0 20px 40px -15px rgba(0, 0, 0, 0.05), 0 0 1px 1px rgba(0, 0, 0, 0.02)',
    width: '100%',
    maxWidth: 480,
    textAlign: 'center' as const,
    zIndex: 10,
  },
  avatarWrapper: {
    width: 60,
    height: 60,
    borderRadius: '50%',
    backgroundColor: '#fff7ed',
    border: '1px solid #ffedd5',
    color: '#ea580c',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 20px',
  },
  avatarIcon: {
    width: 28,
    height: 28,
  },
  title: {
    fontSize: 32,
    fontWeight: 900,
    color: '#0f172a',
    letterSpacing: 2,
    margin: 0,
  },
  dividerLine: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '12px 0 20px',
  },
  dividerDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    backgroundColor: '#10b981',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    margin: '0 0 30px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
  },
  inputGroup: {
    display: 'flex',
    alignItems: 'center',
    position: 'relative' as const,
    width: '100%',
  },
  inputIconWrapper: {
    position: 'absolute' as const,
    left: 14,
    color: '#8b5cf6',
  },
  input: {
    width: '100%',
    padding: '14px 14px 14px 44px',
    borderRadius: 14,
    border: '1px solid #d1d5db',
    fontSize: 14,
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  eyeButton: {
    position: 'absolute' as const,
    right: 14,
    background: 'none',
    border: 'none',
    color: '#94a3b8',
    cursor: 'pointer',
    padding: 0,
  },
  submitBtn: {
    background: 'linear-gradient(90deg, #7c3aed 0%, #ea580c 100%)',
    color: '#ffffff',
    padding: '14px 20px',
    borderRadius: 14,
    border: 'none',
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    boxShadow: '0 8px 16px -4px rgba(124, 58, 237, 0.3)',
  },
  errorMessage: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: 500,
    textAlign: 'left' as const,
    padding: '0 4px',
  },
  demoBox: {
    marginTop: 35,
    paddingTop: 20,
    borderTop: '1px solid #f1f5f9',
    textAlign: 'center' as const,
  },
  demoHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 12,
  },
  demoLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#e2e8f0',
  },
  demoHeaderText: {
    fontSize: 11,
    fontWeight: 700,
    color: '#6366f1',
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
  },
  demoRow: {
    fontSize: 13,
    color: '#334155',
    marginTop: 6,
  },
  purpleText: {
    color: '#6366f1',
    fontFamily: 'monospace',
    fontWeight: 700,
  },
};

const dashStyles = {
  layoutWrapper: {
    display: 'flex',
    minHeight: '100vh',
    backgroundColor: '#f1f5f9',
    fontFamily: '"Inter", sans-serif',
  },
  sidebar: {
    width: 260,
    background: 'linear-gradient(180deg, #0f0c29 0%, #151139 50%, #06041a 100%)',
    color: '#ffffff',
    display: 'flex',
    flexDirection: 'column' as const,
    padding: '24px 16px',
    flexShrink: 0,
  },
  logoSection: {
    padding: '0 12px 28px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    marginBottom: 24,
  },
  logoText: {
    fontSize: 22,
    fontWeight: 900,
    letterSpacing: 2,
  },
  logoSubtext: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 4,
    letterSpacing: 0.5,
  },
  navMenu: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    flex: 1,
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 16px',
    borderRadius: 12,
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: 600,
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    textAlign: 'left' as const,
    width: '100%',
    transition: 'all 0.2s',
  },
  navItemActive: {
    color: '#ffffff',
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    borderLeft: '4px solid #818cf8',
    borderRadius: '0 12px 12px 0',
    paddingLeft: 12,
  },
  navIcon: {
    width: 20,
    height: 20,
  },
  sidebarFooter: {
    paddingTop: 20,
    borderTop: '1px solid rgba(255,255,255,0.06)',
  },
  mainContainer: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden' as const,
  },
  header: {
    height: 70,
    backgroundColor: '#ffffff',
    borderBottom: '1px solid #e2e8f0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 24px',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  menuButton: {
    background: 'none',
    border: 'none',
    color: '#64748b',
    cursor: 'pointer',
    padding: 4,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 800,
    color: '#0f172a',
    margin: 0,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 20,
  },
  notificationBtn: {
    background: 'none',
    border: 'none',
    color: '#64748b',
    cursor: 'pointer',
    position: 'relative' as const,
    padding: 4,
  },
  notifBadge: {
    position: 'absolute' as const,
    top: -2,
    right: -2,
    backgroundColor: '#ef4444',
    color: '#ffffff',
    fontSize: 9,
    fontWeight: 700,
    borderRadius: '50%',
    width: 15,
    height: 15,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profilePill: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#f8fafc',
    border: '1px solid #e2e8f0',
    padding: '6px 12px 6px 6px',
    borderRadius: 30,
    cursor: 'pointer',
  },
  avatarCircle: {
    width: 30,
    height: 30,
    borderRadius: '50%',
    backgroundColor: '#818cf8',
    color: '#ffffff',
    fontWeight: 700,
    fontSize: 14,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileTextGroup: {
    textAlign: 'left' as const,
  },
  profileName: {
    fontSize: 13,
    fontWeight: 700,
    color: '#0f172a',
    lineHeight: 1.2,
  },
  profileRole: {
    fontSize: 10,
    color: '#64748b',
  },
  contentViewport: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: 24,
  },
  viewContainer: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 24,
  },
  metricsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 20,
  },
  metricCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    boxShadow: '0 4px 6px -1px rgba(0,0,0,0.02), 0 2px 4px -1px rgba(0,0,0,0.01)',
    border: '1px solid #e2e8f0',
  },
  metricCardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  metricLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: '#475569',
    letterSpacing: 0.5,
  },
  metricIconWrapper: {
    width: 28,
    height: 28,
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
  },
  metricValue: {
    fontSize: 28,
    fontWeight: 900,
    color: '#0f172a',
    lineHeight: 1.1,
  },
  metricSubtext: {
    fontSize: 11,
    fontWeight: 700,
    marginTop: 6,
  },
  dashGridTwoCol: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 24,
  },
  dashColLeft: {
    flex: '2 1 600px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 24,
  },
  dashColRight: {
    flex: '1 1 320px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 24,
  },
  panelCard: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 24,
    border: '1px solid #e2e8f0',
    boxShadow: '0 4px 6px -1px rgba(0,0,0,0.02)',
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  panelTitle: {
    fontSize: 14,
    fontWeight: 800,
    color: '#0f172a',
    letterSpacing: 0.5,
    margin: 0,
  },
  panelViewAll: {
    background: 'none',
    border: 'none',
    color: '#4f46e5',
    fontWeight: 700,
    fontSize: 12,
    cursor: 'pointer',
  },
  tabButtonGroup: {
    display: 'flex',
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    padding: 3,
    gap: 4,
  },
  tabBtn: {
    padding: '4px 12px',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    color: '#64748b',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
  },
  tabBtnActive: {
    padding: '4px 12px',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 700,
    color: '#0f172a',
    backgroundColor: '#ffffff',
    border: 'none',
    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    cursor: 'pointer',
  },
  graphContainer: {
    marginTop: 10,
  },
  graphLabels: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 10,
    padding: '0 8px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    textAlign: 'left' as const,
  },
  tableHeaderRow: {
    borderBottom: '2px solid #e2e8f0',
  },
  tableHeaderCell: {
    padding: '12px 8px',
    fontSize: 11,
    fontWeight: 700,
    color: '#475569',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  tableBodyRow: {
    borderBottom: '1px solid #f1f5f9',
  },
  tableBodyRowActive: {
    borderBottom: '1px solid #e2d9ff',
    backgroundColor: '#fcfbff',
  },
  tableBodyCell: {
    padding: '14px 8px',
    fontSize: 13,
    color: '#334155',
    verticalAlign: 'middle',
  },
  userAvatar: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    color: '#ffffff',
    fontWeight: 700,
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  userName: {
    fontWeight: 700,
    color: '#0f172a',
    fontSize: 13,
  },
  userSub: {
    fontSize: 11,
    color: '#64748b',
    fontFamily: 'monospace',
  },
  statusPill: {
    padding: '3px 10px',
    borderRadius: 12,
    fontSize: 10,
    fontWeight: 700,
    display: 'inline-block',
  },
  alertList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
    marginTop: 10,
  },
  alertItem: {
    padding: '12px 14px',
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderLeft: '4px solid #94a3b8',
  },
  alertHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  alertTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: '#0f172a',
  },
  alertTime: {
    fontSize: 10,
    color: '#94a3b8',
  },
  alertBody: {
    fontSize: 11,
    color: '#475569',
    lineHeight: 1.4,
  },
  healthLayout: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap' as const,
    gap: 30,
    padding: '15px 0',
  },
  donutWrapper: {
    position: 'relative' as const,
    width: 120,
    height: 120,
  },
  donutText: {
    position: 'absolute' as const,
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    textAlign: 'center' as const,
  },
  donutNumber: {
    fontSize: 24,
    fontWeight: 900,
    color: '#0f172a',
    lineHeight: 1,
  },
  donutLabel: {
    fontSize: 10,
    color: '#64748b',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
  },
  healthLegend: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    flex: 1,
    minWidth: 160,
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    fontSize: 12,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    marginRight: 8,
    display: 'inline-block',
  },
  legendLabel: {
    color: '#475569',
    flex: 1,
  },
  legendValue: {
    fontWeight: 700,
    color: '#0f172a',
  },
  viewDetailsLink: {
    marginTop: 10,
    fontSize: 12,
    fontWeight: 700,
    color: '#4f46e5',
    cursor: 'pointer',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    marginBottom: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: 700,
    color: '#334155',
  },
  input: {
    padding: '12px 14px',
    borderRadius: 10,
    border: '1px solid #cbd5e1',
    fontSize: 14,
    outline: 'none',
  },
  btnSubmit: {
    width: '100%',
    padding: '13px',
    borderRadius: 10,
    border: 'none',
    color: '#ffffff',
    background: 'linear-gradient(90deg, #7c3aed 0%, #ea580c 100%)',
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
    boxShadow: '0 4px 6px rgba(124,58,237,0.15)',
  },
  successMessage: {
    color: '#10b981',
    fontSize: 13,
    fontWeight: 500,
  },
  rfidPill: {
    backgroundColor: '#e0e7ff',
    color: '#3730a3',
    padding: '2px 8px',
    borderRadius: 6,
    fontFamily: 'monospace',
    fontWeight: 700,
    fontSize: 12,
  },
  tableProgressBg: {
    height: 6,
    backgroundColor: '#e2e8f0',
    borderRadius: 3,
    overflow: 'hidden',
  },
  tableProgressFill: {
    height: '100%',
    borderRadius: 3,
  },
  badgeButton: {
    padding: '3px 10px',
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 700,
    border: 'none',
    cursor: 'pointer',
  },
  editBtn: {
    padding: '3px 8px',
    borderRadius: 6,
    backgroundColor: '#ede9fe',
    color: '#6d28d9',
    border: '1px solid #c4b5fd',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
  },
  resetBtn: {
    padding: '3px 8px',
    borderRadius: 6,
    backgroundColor: '#f1f5f9',
    color: '#475569',
    border: '1px solid #cbd5e1',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
  },
  deleteBtn: {
    padding: '3px 6px',
    background: 'none',
    border: 'none',
    fontSize: 14,
    cursor: 'pointer',
  },
};

const cpStyles = {
  searchHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
    gap: 16,
    marginBottom: 10,
  },
  searchInputGroup: {
    display: 'flex',
    alignItems: 'center',
    position: 'relative' as const,
    flex: '1 1 300px',
    maxWidth: 400,
  },
  searchIcon: {
    position: 'absolute' as const,
    left: 14,
    color: '#94a3b8',
    width: 20,
    height: 20,
  },
  searchInput: {
    width: '100%',
    padding: '10px 14px 10px 42px',
    borderRadius: 10,
    border: '1px solid #cbd5e1',
    backgroundColor: '#ffffff',
    fontSize: 14,
    outline: 'none',
  },
  selectFilter: {
    padding: '10px 14px',
    borderRadius: 10,
    border: '1px solid #cbd5e1',
    backgroundColor: '#ffffff',
    fontSize: 14,
    color: '#475569',
    outline: 'none',
  },
  addStationBtn: {
    padding: '10px 18px',
    borderRadius: 10,
    border: 'none',
    color: '#ffffff',
    backgroundColor: '#4f46e5',
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
    boxShadow: '0 4px 6px rgba(79,70,229,0.15)',
  },
  stationsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
    gap: 24,
  },
  stationCard: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 20,
    border: '1px solid #e2e8f0',
    boxShadow: '0 4px 6px -1px rgba(0,0,0,0.02)',
  },
  stationHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  stationName: {
    fontSize: 16,
    fontWeight: 800,
    color: '#0f172a',
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  onlineBadge: {
    fontSize: 10,
    fontWeight: 700,
    backgroundColor: '#d1fae5',
    color: '#065f46',
    padding: '2px 8px',
    borderRadius: 12,
  },
  stationLoc: {
    fontSize: 11,
    color: '#64748b',
    margin: '4px 0 0',
  },
  stationConfigBtn: {
    background: 'none',
    border: 'none',
    fontSize: 16,
    cursor: 'pointer',
  },
  stationMetaRow: {
    display: 'flex',
    justifyContent: 'space-between',
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    padding: '8px 12px',
    marginBottom: 16,
    border: '1px solid #f1f5f9',
  },
  metaBox: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
  },
  metaBoxVal: {
    fontSize: 13,
    fontWeight: 700,
    color: '#0f172a',
  },
  metaBoxLbl: {
    fontSize: 9,
    color: '#94a3b8',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    marginTop: 2,
  },
  baysList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
  bayItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 14px',
    borderRadius: 12,
    border: '1px solid #e2e8f0',
    cursor: 'pointer',
    backgroundColor: '#ffffff',
    transition: 'all 0.2s',
    ':hover': {
      borderColor: '#818cf8',
    }
  },
  bayItemActive: {
    borderColor: '#818cf8',
    backgroundColor: '#fdfdff',
    boxShadow: '0 4px 12px rgba(99,102,241,0.05)',
  },
  bayItemStatic: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 14px',
    borderRadius: 12,
    border: '1px solid #f1f5f9',
    backgroundColor: '#fafbfc',
    color: '#94a3b8',
  },
  bayLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  bayDot: (color: string) => ({
    width: 10,
    height: 10,
    borderRadius: '50%',
    backgroundColor: color,
  }),
  bayName: {
    fontSize: 13,
    fontWeight: 700,
    color: '#334155',
  },
  bayStatus: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  bayUsage: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: 600,
  },
  stationFooter: {
    marginTop: 16,
    textAlign: 'center' as const,
    fontSize: 12,
    fontWeight: 700,
    color: '#4f46e5',
    cursor: 'pointer',
    borderTop: '1px solid #f1f5f9',
    paddingTop: 12,
  },
  overlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    backgroundColor: 'rgba(15, 23, 42, 0.4)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },
  modalCard: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    width: '100%',
    maxWidth: 460,
    padding: 24,
    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
    border: '1px solid #e2e8f0',
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    borderBottom: '1px solid #f1f5f9',
    paddingBottom: 16,
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 800,
    color: '#0f172a',
    margin: 0,
  },
  modalSubtitle: {
    fontSize: 12,
    color: '#64748b',
    margin: '4px 0 0',
  },
  closeModalBtn: {
    background: 'none',
    border: 'none',
    fontSize: 18,
    color: '#64748b',
    cursor: 'pointer',
  },
  modalBody: {
    display: 'flex',
    flexDirection: 'column' as const,
  },
  cardPreview: {
    backgroundColor: '#581c87',
    background: 'linear-gradient(135deg, #581c87 0%, #3b0764 100%)',
    borderRadius: 16,
    padding: 20,
    color: '#ffffff',
    boxShadow: '0 10px 20px -5px rgba(88, 28, 135, 0.3)',
    marginTop: 16,
  },
  cardPreviewHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1,
    color: '#c084fc',
  },
  cardPreviewId: {
    fontSize: 22,
    fontWeight: 800,
    letterSpacing: 2,
    fontFamily: 'monospace',
    margin: '20px 0 6px',
  },
  cardPreviewName: {
    fontSize: 13,
    color: '#f3e8ff',
  },
  progressBarBg: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 2,
    marginTop: 6,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 2,
  },
  connectionGraphic: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: '20px 0',
  },
  connLine: {
    width: 100,
    height: 6,
    backgroundColor: '#e2e8f0',
    borderRadius: 3,
    position: 'relative' as const,
    overflow: 'hidden' as const,
  },
  connPulse: {
    position: 'absolute' as const,
    top: 0,
    left: '-40%',
    width: '40%',
    height: '100%',
    backgroundColor: '#f59e0b',
    borderRadius: 3,
    animation: 'pulse 1.2s ease-in-out infinite',
  },
  stopBtn: {
    width: '100%',
    padding: '13px',
    borderRadius: 10,
    border: 'none',
    color: '#ffffff',
    backgroundColor: '#ef4444',
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
    boxShadow: '0 4px 6px rgba(239,68,68,0.15)',
  },
  liveStatRow: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: 24,
    borderBottom: '1px solid #f1f5f9',
    paddingBottom: 20,
  },
  liveGauge: {
    textAlign: 'center' as const,
  },
  liveGaugeVal: {
    fontSize: 44,
    fontWeight: 900,
    color: '#3b82f6',
    letterSpacing: -1,
  },
  liveGaugeLbl: {
    fontSize: 10,
    color: '#94a3b8',
    fontWeight: 700,
    letterSpacing: 1.5,
    marginTop: 4,
  },
  telemetryMiniCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    padding: 12,
    border: '1px solid #e2e8f0',
  },
  telemetryLbl: {
    fontSize: 9,
    fontWeight: 700,
    color: '#64748b',
    letterSpacing: 0.5,
  },
  telemetryVal: {
    fontSize: 14,
    fontWeight: 800,
    color: '#0f172a',
    marginTop: 4,
  },
};
