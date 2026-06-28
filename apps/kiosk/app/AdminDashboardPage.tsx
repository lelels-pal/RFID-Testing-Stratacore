'use client';

import React, { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { RfidCard, WsMeterUpdatePayload, ChargerConnectionInfo, WsRfidAuthDeniedPayload, OcppTraceEntry, getApiBaseUrl } from '@packages/shared';
import { useAuth } from '../context/AuthContext';
import { useKioskData } from '../hooks/useKioskData';
import { useChargerQr } from '../hooks/useChargerQr';
import { QrPanel } from '../components/QrPanel';
import {
  registerRfid as apiRegisterRfid,
  updateRfid as apiUpdateRfid,
  deleteRfid as apiDeleteRfid,
  startRfidSession as apiStartRfidSession,
  kioskStopCharger,
} from '../lib/api-client';

const WsEvents = {
  SESSION_CLAIMED: 'session:claimed',
  PAYMENT_APPROVED: 'payment:approved',
  CHARGER_PREPARING: 'charger:preparing',
  CHARGER_STARTING: 'charger:starting',
  METER_UPDATE: 'charger:meter_update',
  SESSION_COMPLETED: 'session:completed',
  SESSION_ERROR: 'session:error',
  RFID_AUTH_DENIED: 'rfid:auth_denied',
  OCPP_TRACE: 'ocpp:trace',
  CHARGER_CONNECTION_CHANGED: 'charger:connection_changed',
  SUBSCRIBE_CHARGER: 'subscribe:charger',
};

type ViewTab = 'dashboard' | 'chargepoints' | 'topup';

interface ChargerDefinition {
  chargerId: string;
  connectorId: number;
  chargerIp: string;
}

interface LocalSessionState {
  status: 'IDLE' | 'CLAIMED' | 'PREPARING' | 'CHARGING' | 'COMPLETED' | 'ERROR';
  statusMessage: string;
  telemetry: WsMeterUpdatePayload | null;
  activeRfid: string | null;
}

function getBackendUrl() {
  return getApiBaseUrl({
    envUrl: process.env.NEXT_PUBLIC_BACKEND_URL,
    origin:
      typeof window !== 'undefined'
        ? { protocol: window.location.protocol, hostname: window.location.hostname }
        : undefined,
  });
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

function getSessionDotColor(status: LocalSessionState['status'], isOnline = true): string {
  if (!isOnline) return '#64748b';
  if (status === 'CHARGING') return '#3b82f6';
  if (status === 'PREPARING') return '#f59e0b';
  if (status === 'ERROR') return '#ef4444';
  return '#10b981';
}

function getBayDisplay(session: LocalSessionState, isOnline: boolean): {
  status: string;
  statusMessage: string;
} {
  if (!isOnline) {
    return { status: 'OFFLINE', statusMessage: 'Charger not connected' };
  }
  return { status: session.status, statusMessage: session.statusMessage };
}

function getBayLabel(charger: ChargerDefinition, index: number): string {
  if (charger.chargerId === 'DELTA123') return `DELTA123 (${charger.chargerIp})`;
  return `Bay A${index} (${charger.chargerId})`;
}

function formatOcppPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function getOcppTraceLabel(entry: OcppTraceEntry): string {
  if (entry.action) return entry.action;
  return entry.messageType;
}

function getOcppTraceSummary(entry: OcppTraceEntry): string {
  const payload = entry.payload as Record<string, unknown> | null;
  if (!payload) return entry.direction === 'incoming' ? 'from charger' : 'to charger';

  if (payload.meterStop != null && payload.meterStart != null) {
    const kwh = (Number(payload.meterStop) - Number(payload.meterStart)) / 1000;
    return `meterStop: ${payload.meterStop} Wh (${kwh.toFixed(4)} kWh)`;
  }
  if (payload.meterStop != null) return `meterStop: ${payload.meterStop} Wh`;
  if (payload.meterStart != null) return `meterStart: ${payload.meterStart} Wh`;

  const meterValues = payload.meterValue as Array<{ sampledValue?: Array<{ measurand?: string; value?: string; unit?: string }> }> | undefined;
  if (Array.isArray(meterValues)) {
    const samples = meterValues.flatMap((mv) => mv.sampledValue || []);
    const energy = samples.find((s) => s.measurand === 'Energy.Active.Import.Register');
    if (energy?.value != null) {
      const wh = Number(energy.value);
      const unit = energy.unit || 'Wh';
      const kwh = unit.toLowerCase() === 'kwh' ? wh : wh / 1000;
      return `Energy: ${energy.value} ${unit} (${kwh.toFixed(4)} kWh)`;
    }
  }

  if (payload.idTag) return `idTag: ${payload.idTag}`;
  const idTagInfo = payload.idTagInfo as { status?: string } | undefined;
  if (idTagInfo?.status) return `status: ${idTagInfo.status}`;
  if (payload.status) return `status: ${payload.status}`;
  if (payload.transactionId != null) return `transactionId: ${payload.transactionId}`;
  return entry.direction === 'incoming' ? 'from charger' : 'to charger';
}

export default function AdminDashboardPage() {
  const { isLoggedIn, authChecked, login, logout } = useAuth();
  // Authentication State
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [backendHealthy, setBackendHealthy] = useState(false);

  // Layout & Routing State
  const [currentTab, setCurrentTab] = useState<ViewTab>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Real-Time System Data State
  const [backendUrl, setBackendUrl] = useState(() => getBackendUrl());

  const {
    chargerConfigs: CHARGER_CONFIGS,
    stationName: STATION_NAME,
    stationLocation: STATION_LOCATION,
    rfidCards,
    chargerConnections,
    setChargerConnections,
    ocppTrace,
    setOcppTrace,
    loadSiteConfig,
    fetchRfids,
    fetchChargerConnections,
    fetchOcppTrace,
  } = useKioskData(backendUrl, isLoggedIn);

  const { qrSessions, refreshSession } = useChargerQr(
    backendUrl,
    CHARGER_CONFIGS,
    isLoggedIn,
    backendHealthy,
  );

  const [sessions, setSessions] = useState<Record<string, LocalSessionState>>({});

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
  const [rfidAlerts, setRfidAlerts] = useState<WsRfidAuthDeniedPayload[]>([]);
  const [rfidDeniedModal, setRfidDeniedModal] = useState<WsRfidAuthDeniedPayload | null>(null);
  const [showAllOcppPackets, setShowAllOcppPackets] = useState(true);
  const [expandedOcppKey, setExpandedOcppKey] = useState<string | null>(null);

  // Socket reference
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (CHARGER_CONFIGS.length === 0) return;
    setSessions((prev) => {
      const next = { ...prev };
      CHARGER_CONFIGS.forEach((c) => {
        if (!next[c.chargerId]) {
          next[c.chargerId] = {
            status: 'IDLE',
            statusMessage: 'Ready to Charge',
            telemetry: null,
            activeRfid: null,
          };
        }
      });
      return next;
    });
  }, [CHARGER_CONFIGS]);

  useEffect(() => {
    if (!isLoggedIn || !backendUrl) return;
    void loadSiteConfig();
  }, [isLoggedIn, backendUrl, loadSiteConfig]);

  useEffect(() => {
    if (!backendUrl) return;
    const poll = async () => {
      try {
        const res = await fetch(`${backendUrl}/api/health`);
        setBackendHealthy(res.ok);
      } catch {
        setBackendHealthy(false);
      }
    };
    void poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, [backendUrl]);

  // Resolve backend URL client-side
  useEffect(() => {
    setBackendUrl(getBackendUrl());
  }, []);

  useEffect(() => {
    const closeSidebar = () => setSidebarOpen(false);
    window.addEventListener('resize', closeSidebar);
    return () => window.removeEventListener('resize', closeSidebar);
  }, []);

  const navigateToTab = (tab: ViewTab) => {
    setCurrentTab(tab);
    setSidebarOpen(false);
  };

  // Triggered when backend is resolved or on interval. Polls frequently so a
  // card's monthly consumption visibly counts up while a session is charging.
  useEffect(() => {
    if (!backendUrl || !isLoggedIn) return;
    fetchRfids();
    const interval = setInterval(fetchRfids, 3000);
    return () => clearInterval(interval);
  }, [backendUrl, isLoggedIn, fetchRfids]);

  useEffect(() => {
    if (!backendUrl || !isLoggedIn) return;
    fetchChargerConnections();
    const interval = setInterval(fetchChargerConnections, 5000);
    return () => clearInterval(interval);
  }, [backendUrl, isLoggedIn, fetchChargerConnections]);

  useEffect(() => {
    if (!backendUrl || !isLoggedIn) return;
    fetchOcppTrace(showAllOcppPackets);
    const interval = setInterval(() => fetchOcppTrace(showAllOcppPackets), 5000);
    return () => clearInterval(interval);
  }, [backendUrl, isLoggedIn, showAllOcppPackets, fetchOcppTrace]);

  // Connect WebSockets
  useEffect(() => {
    if (!backendUrl || !isLoggedIn) return;

    const socket = io(backendUrl);
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[Socket] Connected to backend');
      CHARGER_CONFIGS.forEach((c) => {
        socket.emit(WsEvents.SUBSCRIBE_CHARGER, { chargerId: c.chargerId });
      });
    });

    socket.on(WsEvents.SESSION_CLAIMED, (data: { chargerId: string }) => {
      setSessions((prev) => ({
        ...prev,
        [data.chargerId]: {
          ...prev[data.chargerId],
          status: 'CLAIMED',
          statusMessage: 'QR claimed — guest completing checkout…',
        },
      }));
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

    socket.on(WsEvents.SESSION_COMPLETED, (data: { chargerId: string; message?: string }) => {
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
        refreshSession(data.chargerId);
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
        refreshSession(data.chargerId);
      }, 6000);
    });

    socket.on(WsEvents.RFID_AUTH_DENIED, (data: WsRfidAuthDeniedPayload) => {
      setRfidAlerts((prev) => [data, ...prev].slice(0, 20));
      setRfidDeniedModal(data);
    });

    socket.on(WsEvents.OCPP_TRACE, (entry: OcppTraceEntry) => {
      setOcppTrace((prev) => [entry, ...prev].slice(0, 100));
    });

    socket.on(WsEvents.CHARGER_CONNECTION_CHANGED, (info: ChargerConnectionInfo) => {
      setChargerConnections((prev) => ({ ...prev, [info.chargerId]: info }));
    });

    return () => {
      socket.disconnect();
    };
  }, [backendUrl, isLoggedIn, CHARGER_CONFIGS, fetchRfids, refreshSession, setChargerConnections, setOcppTrace]);

  // Sign In Handler
  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoggingIn(true);
    setLoginError('');
    try {
      await login(backendUrl, username.trim(), password);
    } catch (err) {
      setLoginError((err as Error).message || 'Invalid username or password.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleDismissRfidAlert = () => {
    setRfidDeniedModal(null);
  };

  const handleRegisterFromRfidAlert = () => {
    if (!rfidDeniedModal) return;
    setNewCardId(rfidDeniedModal.rfidCardId);
    setCurrentTab('topup');
    setRfidDeniedModal(null);
  };

  // Start Charging Handler
  const handleStartCharging = async () => {
    if (!selectedChargerId || !selectedRfid) return;
    if (!chargerConnections[selectedChargerId]?.connected) {
      setActivationError('Charger is offline. Connect OCPP before remote start.');
      return;
    }
    setActivationError('');

    try {
      const charger = CHARGER_CONFIGS.find((c) => c.chargerId === selectedChargerId);
      await apiStartRfidSession(backendUrl, {
        chargerId: selectedChargerId,
        connectorId: charger?.connectorId ?? 1,
        rfidCardId: selectedRfid,
      });

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
      await kioskStopCharger(backendUrl, chargerId);

      setSessions((prev) => ({
        ...prev,
        [chargerId]: {
          status: 'IDLE',
          statusMessage: 'Ready to Charge',
          telemetry: null,
          activeRfid: null,
        },
      }));
      setSelectedChargerId(null);
      setSelectedRfid('');
    } catch (err) {
      console.error('Error stopping charger:', err);
      setActivationError((err as Error).message);
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
      await apiRegisterRfid(backendUrl, {
        rfidCardId: newCardId.trim().toUpperCase(),
        cardholderName: newCardholder.trim(),
        monthlyKwhLimit: parseFloat(newCardLimit),
      });

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
      await apiDeleteRfid(backendUrl, cardId);
      fetchRfids();
    } catch (err) {
      console.error(err);
    }
  };

  // Toggle Card Status Handler
  const handleToggleCardStatus = async (card: RfidCard) => {
    try {
      await apiUpdateRfid(backendUrl, card.rfidCardId, { isActive: !card.isActive });
      fetchRfids();
    } catch (err) {
      console.error(err);
    }
  };

  // Reset Quota Manually Handler
  const handleResetQuota = async (cardId: string) => {
    try {
      await apiUpdateRfid(backendUrl, cardId, { currentMonthKwhConsumed: 0 });
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
      await apiUpdateRfid(backendUrl, editingCard.rfidCardId, {
        cardholderName: editName.trim(),
        monthlyKwhLimit: limitValue,
      });

      setEditingCard(null);
      fetchRfids();
    } catch (err) {
      setEditError((err as Error).message);
    }
  };

  // Helper Stats calculations
  const totalKwhConsumedThisMonth = rfidCards.reduce((acc, c) => acc + c.currentMonthKwhConsumed, 0);
  const activeSessionsCount = Object.values(sessions).filter((s) => s.status === 'CHARGING' || s.status === 'PREPARING').length;
  const onlineChargersCount = CHARGER_CONFIGS.filter((c) => chargerConnections[c.chargerId]?.connected).length;
  const criticalAlertsCount = Object.values(sessions).filter((s) => s.status === 'ERROR').length
    + CHARGER_CONFIGS.filter((c) => !chargerConnections[c.chargerId]?.connected).length
    + rfidAlerts.length;
  const liveSessionRows = CHARGER_CONFIGS.filter((c) => sessions[c.chargerId]?.status !== 'IDLE');
  const hasLiveSessions = liveSessionRows.length > 0;
  const hasLiveAlerts = Object.entries(sessions).some(([, s]) => s.status === 'ERROR')
    || CHARGER_CONFIGS.some((c) => !chargerConnections[c.chargerId]?.connected)
    || rfidAlerts.length > 0;
  const healthHealthy = CHARGER_CONFIGS.filter((c) => {
    const conn = chargerConnections[c.chargerId];
    return conn?.connected && conn.status !== 'Faulted' && sessions[c.chargerId]?.status !== 'ERROR';
  }).length;
  const healthCritical = CHARGER_CONFIGS.filter((c) => {
    const conn = chargerConnections[c.chargerId];
    return !conn?.connected || conn.status === 'Faulted' || sessions[c.chargerId]?.status === 'ERROR';
  }).length;
  const healthWarning = Math.max(0, CHARGER_CONFIGS.length - healthHealthy - healthCritical);
  const onlinePct = CHARGER_CONFIGS.length > 0
    ? Math.round((onlineChargersCount / CHARGER_CONFIGS.length) * 100)
    : 0;
  const visibleOcppTrace = showAllOcppPackets
    ? ocppTrace
    : ocppTrace.filter((entry) => entry.isRfidRelated);

  // ═══════════════════════════════════════════════════════════════
  // LOGIN VIEW RENDER
  // ═══════════════════════════════════════════════════════════════
  if (!authChecked) {
    return null;
  }

  if (!isLoggedIn) {
    return (
      <div className="sc-login-page" style={loginStyles.pageWrapper}>
        {/* Background Geometric Vectors */}
        <div className="sc-login-bg" style={loginStyles.bgLeftSVG}>
          <svg width="400" height="700" viewBox="0 0 400 700" fill="none">
            <path d="M-100 100 L250 450 L100 600" stroke="#a78bfa" strokeWidth="2" strokeOpacity="0.4"/>
            <path d="M-50 80 L300 430 L150 580" stroke="#7c3aed" strokeWidth="4" strokeOpacity="0.6"/>
            <circle cx="300" cy="430" r="5" fill="#7c3aed"/>
            <circle cx="250" cy="450" r="4" fill="#a78bfa"/>
          </svg>
        </div>
        <div className="sc-login-bg" style={loginStyles.bgRightSVG}>
          <svg width="400" height="700" viewBox="0 0 400 700" fill="none">
            <path d="M500 200 L150 400 L250 550" stroke="#a78bfa" strokeWidth="2" strokeOpacity="0.4"/>
            <path d="M550 180 L200 380 L300 530" stroke="#7c3aed" strokeWidth="4" strokeOpacity="0.6"/>
            <circle cx="200" cy="380" r="5" fill="#7c3aed"/>
            <circle cx="150" cy="400" r="4" fill="#a78bfa"/>
          </svg>
        </div>

        <div className="sc-login-card" style={loginStyles.cardContainer}>
          <div style={loginStyles.avatarWrapper}>
            <svg style={loginStyles.avatarIcon} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
          </div>
          
          <h1 className="sc-login-title" style={loginStyles.title}>
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

            <button type="submit" className="sc-submit-btn" style={loginStyles.submitBtn} disabled={isLoggingIn}>
              Sign In <span style={{ marginLeft: 8 }}>→</span>
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN DASHBOARD LAYOUT & VIEWS
  // ═══════════════════════════════════════════════════════════════
  return (
    <div className="sc-layout" style={dashStyles.layoutWrapper}>
      <div
        className={`sc-sidebar-backdrop${sidebarOpen ? ' sc-visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden={!sidebarOpen}
      />
      {/* ───────────────────────────────────────────────────────────
          LEFT SIDEBAR
          ─────────────────────────────────────────────────────────── */}
      <aside
        className={`sc-sidebar${sidebarOpen ? ' sc-sidebar-open' : ''}`}
        style={dashStyles.sidebar}
      >
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
            { id: 'topup', label: 'Top-Up', icon: 'M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z' },
          ].map((item) => {
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => navigateToTab(item.id as ViewTab)}
                className="sc-nav-item"
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
          <button onClick={() => { logout();  }} style={{ ...dashStyles.navItem, color: '#f87171' }}>
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
      <div className="sc-main" style={dashStyles.mainContainer}>
        {/* TOP BAR HEADER */}
        <header className="sc-header" style={dashStyles.header}>
          <div style={dashStyles.headerLeft}>
            <button
              type="button"
              className="sc-menu-button"
              style={dashStyles.menuButton}
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label="Open navigation menu"
            >
              <svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <h2 className="sc-header-title" style={dashStyles.headerTitle}>
              {currentTab === 'dashboard' && 'Dashboard'}
              {currentTab === 'chargepoints' && 'Charge Points'}
              {currentTab === 'topup' && 'RFID Top-Up Allocation'}
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
              <div style={dashStyles.avatarCircle}>{username.charAt(0).toUpperCase() || 'O'}</div>
              <div className="sc-header-profile-text" style={dashStyles.profileTextGroup}>
                <div style={dashStyles.profileName}>{username || 'Operator'}</div>
                <div style={dashStyles.profileRole}>Station Operator</div>
              </div>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ marginLeft: 6 }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        </header>

        {/* CONTENT VIEWPORT */}
        <main className="sc-content-viewport" style={dashStyles.contentViewport}>
          
          {/* ───────────────────────────────────────────────────────
              TAB 1: DASHBOARD VIEW
              ─────────────────────────────────────────────────────── */}
          {currentTab === 'dashboard' && (
            <div style={dashStyles.viewContainer}>
              {/* TOP METRICS SUMMARY */}
              <div className="sc-metrics-grid" style={dashStyles.metricsGrid}>
                
                {/* 1. ONLINE CHARGERS */}
                <div style={{ ...dashStyles.metricCard, borderLeft: '4px solid #10b981' }}>
                  <div style={dashStyles.metricCardHeader}>
                    <span style={dashStyles.metricLabel}>ONLINE CHARGERS</span>
                    <span style={{ ...dashStyles.metricIconWrapper, backgroundColor: '#d1fae5', color: '#10b981' }}>🔌</span>
                  </div>
                  <div className="sc-metric-value" style={dashStyles.metricValue}>
                    {onlineChargersCount} / {CHARGER_CONFIGS.length}
                  </div>
                  <div style={{ ...dashStyles.metricSubtext, color: onlinePct === 100 ? '#10b981' : '#f59e0b' }}>
                    {onlinePct}% online
                  </div>
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
                <div className="sc-dash-col-left" style={dashStyles.dashColLeft}>
                  {/* Energy Consumption chart card */}
                  <div className="sc-panel-card" style={dashStyles.panelCard}>
                    <div style={dashStyles.panelHeader}>
                      <h3 style={dashStyles.panelTitle}>ENERGY CONSUMPTION (KWH)</h3>
                    </div>
                    
                    <div style={dashStyles.graphContainer}>
                      <div style={{ padding: '48px 24px', textAlign: 'center', color: '#64748b' }}>
                        <div style={{ fontSize: 28, fontWeight: 700, color: '#7c3aed', marginBottom: 8 }}>
                          {totalKwhConsumedThisMonth.toFixed(2)} kWh
                        </div>
                        <div style={{ fontSize: 13 }}>Total RFID allocation consumed this month</div>
                        <div style={{ fontSize: 12, marginTop: 8, color: '#94a3b8' }}>
                          {rfidCards.length} registered card{rfidCards.length === 1 ? '' : 's'}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Active Sessions List */}
                  <div style={dashStyles.panelCard}>
                    <div style={dashStyles.panelHeader}>
                      <h3 style={dashStyles.panelTitle}>ACTIVE CHARGING SESSIONS</h3>
                      <button onClick={() => setCurrentTab('chargepoints')} style={dashStyles.panelViewAll}>View all</button>
                    </div>
                    
                    <div className="sc-table-wrap">
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

                          {!hasLiveSessions && (
                            <tr>
                              <td colSpan={6} style={{ ...dashStyles.tableBodyCell, textAlign: 'center', color: '#94a3b8', padding: 32 }}>
                                No active charging sessions
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* RIGHT COLUMN */}
                <div className="sc-dash-col-right" style={dashStyles.dashColRight}>
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

                      {rfidAlerts.map((alert, index) => (
                        <div
                          key={`${alert.chargerId}-${alert.rfidCardId}-${alert.timestamp}-${index}`}
                          style={{
                            ...dashStyles.alertItem,
                            borderLeft: `4px solid ${alert.reason === 'Invalid' ? '#f97316' : '#ef4444'}`,
                          }}
                        >
                          <div style={dashStyles.alertHeader}>
                            <span style={{
                              ...dashStyles.alertTitle,
                              color: alert.reason === 'Invalid' ? '#f97316' : '#ef4444',
                            }}>
                              {alert.reason === 'Invalid' ? 'Unregistered RFID' : 'RFID Denied'} · {alert.chargerId}
                            </span>
                            <span style={dashStyles.alertTime}>
                              {new Date(alert.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          <div style={dashStyles.alertBody}>
                            <strong>{alert.rfidCardId}</strong> — {alert.message}
                          </div>
                        </div>
                      ))}

                      {CHARGER_CONFIGS.filter((c) => !chargerConnections[c.chargerId]?.connected).map((charger) => (
                        <div key={charger.chargerId} style={{ ...dashStyles.alertItem, borderLeft: '4px solid #ef4444' }}>
                          <div style={dashStyles.alertHeader}>
                            <span style={{ ...dashStyles.alertTitle, color: '#ef4444' }}>{charger.chargerId} Offline</span>
                            <span style={dashStyles.alertTime}>Now</span>
                          </div>
                          <div style={dashStyles.alertBody}>Charger not connected to the OCPP central system.</div>
                        </div>
                      ))}

                      {!hasLiveAlerts && (
                        <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                          No alerts — all chargers connected
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Charger Health Status */}
                  <div style={dashStyles.panelCard}>
                    <h3 style={dashStyles.panelTitle}>CHARGER HEALTH STATUS</h3>
                    
                    <div style={dashStyles.healthLayout}>
                      <div style={dashStyles.donutWrapper}>
                        <div style={dashStyles.donutText}>
                          <div style={dashStyles.donutNumber}>{CHARGER_CONFIGS.length}</div>
                          <div style={dashStyles.donutLabel}>Total</div>
                        </div>
                      </div>

                      <div style={dashStyles.healthLegend}>
                        <div style={dashStyles.legendItem}>
                          <span style={{ ...dashStyles.legendDot, backgroundColor: '#10b981' }} />
                          <span style={dashStyles.legendLabel}>Healthy</span>
                          <span style={dashStyles.legendValue}>{healthHealthy}</span>
                        </div>
                        <div style={dashStyles.legendItem}>
                          <span style={{ ...dashStyles.legendDot, backgroundColor: '#f59e0b' }} />
                          <span style={dashStyles.legendLabel}>Warning</span>
                          <span style={dashStyles.legendValue}>{healthWarning}</span>
                        </div>
                        <div style={dashStyles.legendItem}>
                          <span style={{ ...dashStyles.legendDot, backgroundColor: '#ef4444' }} />
                          <span style={dashStyles.legendLabel}>Critical</span>
                          <span style={dashStyles.legendValue}>{healthCritical}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                </div>

              </div>

              {/* OCPP Packet Trace — full width for readable packet data */}
              <div style={dashStyles.panelCard}>
                <div style={dashStyles.ocppPanelHeader}>
                  <div>
                    <h3 style={dashStyles.panelTitle}>
                      OCPP PACKET TRACE
                      {visibleOcppTrace.length > 0 && (
                        <span style={dashStyles.ocppTraceCount}>{visibleOcppTrace.length}</span>
                      )}
                    </h3>
                    <p style={{ fontSize: 11, color: '#64748b', margin: '6px 0 0' }}>
                      Live OCPP WebSocket traffic between chargers and the central system — every message in and out.
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                    <div style={dashStyles.ocppFilterGroup}>
                      <button
                        type="button"
                        onClick={() => setShowAllOcppPackets(true)}
                        style={{
                          ...dashStyles.ocppFilterBtn,
                          ...(showAllOcppPackets ? dashStyles.ocppFilterBtnActive : {}),
                        }}
                      >
                        All packets
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowAllOcppPackets(false)}
                        style={{
                          ...dashStyles.ocppFilterBtn,
                          ...(!showAllOcppPackets ? dashStyles.ocppFilterBtnActive : {}),
                        }}
                      >
                        RFID only
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setOcppTrace([]);
                        setExpandedOcppKey(null);
                      }}
                      style={dashStyles.panelViewAll}
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div style={dashStyles.ocppTraceList}>
                  {visibleOcppTrace.map((entry, index) => {
                    const traceKey = `${entry.timestamp}-${entry.chargerId}-${entry.uniqueId || entry.messageType}-${index}`;
                    const isExpanded = expandedOcppKey === traceKey;
                    const directionColor = entry.direction === 'incoming' ? '#3b82f6' : '#8b5cf6';
                    const rfidHighlight = entry.isRfidRelated ? '#818cf8' : '#94a3b8';
                    const rawPacket = entry.raw || JSON.stringify([entry.messageType, entry.uniqueId, entry.action, entry.payload]);

                    return (
                      <div
                        key={traceKey}
                        style={{
                          ...dashStyles.ocppTraceItem,
                          borderLeft: `4px solid ${entry.isRfidRelated ? rfidHighlight : directionColor}`,
                        }}
                      >
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => setExpandedOcppKey(isExpanded ? null : traceKey)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setExpandedOcppKey(isExpanded ? null : traceKey);
                            }
                          }}
                          style={dashStyles.ocppTraceHeader}
                        >
                          <div style={dashStyles.ocppTraceHeaderTop}>
                            <span style={{ ...dashStyles.ocppTraceAction, color: entry.isRfidRelated ? '#4338ca' : '#0f172a' }}>
                              {getOcppTraceLabel(entry)}
                              {entry.isRfidRelated && (
                                <span style={dashStyles.ocppRfidBadge}>RFID</span>
                              )}
                            </span>
                            <span style={dashStyles.alertTime}>
                              {new Date(entry.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          <div style={dashStyles.ocppTraceMeta}>
                            <span style={{ color: directionColor, fontWeight: 700 }}>
                              {entry.direction === 'incoming' ? '← IN' : '→ OUT'}
                            </span>
                            <span>{entry.chargerId}</span>
                            <span>{entry.messageType}</span>
                            <span>{getOcppTraceSummary(entry)}</span>
                          </div>
                        </div>
                        <div style={dashStyles.ocppTraceRawPreview}>{rawPacket}</div>

                        {isExpanded && (
                          <div style={dashStyles.ocppTraceBody}>
                            <div style={dashStyles.ocppTraceSectionLabel}>Parsed payload</div>
                            <pre style={dashStyles.ocppTracePre}>{formatOcppPayload(entry.payload)}</pre>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {visibleOcppTrace.length === 0 && (
                    <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
                      {showAllOcppPackets
                        ? 'No OCPP packets yet — connect a charger or tap an RFID card to see traffic.'
                        : 'No RFID packets yet — tap a registered card on the charger reader.'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ───────────────────────────────────────────────────────
              TAB 2: CHARGEPOINTS VIEW (STATIONS AND BAYS)
              ─────────────────────────────────────────────────────── */}
          {currentTab === 'chargepoints' && (
            <div style={dashStyles.viewContainer}>
              <div style={{ ...cpStyles.searchHeader, justifyContent: 'flex-end' }}>
                <button onClick={() => setCurrentTab('topup')} style={cpStyles.addStationBtn}>
                  + Register RFID Card
                </button>
              </div>

              {/* STATIONS GRID */}
              <div className="sc-stations-grid" style={cpStyles.stationsGrid}>
                <div style={cpStyles.stationCard}>
                  <div style={cpStyles.stationHeader}>
                    <div>
                      <h4 style={cpStyles.stationName}>
                        {STATION_NAME}{' '}
                        <span style={onlineChargersCount === CHARGER_CONFIGS.length ? cpStyles.onlineBadge : cpStyles.offlineBadge}>
                          {onlineChargersCount === CHARGER_CONFIGS.length ? 'Online' : `${onlineChargersCount}/${CHARGER_CONFIGS.length} Online`}
                        </span>
                      </h4>
                      {STATION_LOCATION && <p style={cpStyles.stationLoc}>📍 {STATION_LOCATION}</p>}
                    </div>
                  </div>

                  <div style={cpStyles.stationMetaRow}>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>{activeSessionsCount}/{CHARGER_CONFIGS.length}</span>
                      <span style={cpStyles.metaBoxLbl}>Active</span>
                    </div>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>{totalKwhConsumedThisMonth.toFixed(1)} kWh</span>
                      <span style={cpStyles.metaBoxLbl}>Consumed</span>
                    </div>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>{onlinePct}%</span>
                      <span style={cpStyles.metaBoxLbl}>Online</span>
                    </div>
                    <div style={cpStyles.metaBox}>
                      <span style={cpStyles.metaBoxVal}>{CHARGER_CONFIGS.length}</span>
                      <span style={cpStyles.metaBoxLbl}>Chargers</span>
                    </div>
                  </div>

                  <div style={cpStyles.baysList}>
                    {CHARGER_CONFIGS.map((charger, index) => {
                      const session = sessions[charger.chargerId];
                      const connection = chargerConnections[charger.chargerId];
                      const isOnline = connection?.connected ?? false;
                      const bayDisplay = getBayDisplay(session, isOnline);

                      return (
                        <div
                          key={charger.chargerId}
                          className="sc-bay-item"
                          onClick={() => setSelectedChargerId(charger.chargerId)}
                          style={{
                            ...cpStyles.bayItem,
                            ...(session.status !== 'IDLE' && isOnline ? cpStyles.bayItemActive : {}),
                          }}
                        >
                          <div style={cpStyles.bayLeft}>
                            <div style={cpStyles.bayDot(getSessionDotColor(session.status, isOnline))} />
                            <div>
                              <div style={cpStyles.bayName}>
                                {getBayLabel(charger, index + 1)}{' '}
                                <span style={isOnline ? cpStyles.onlineBadge : cpStyles.offlineBadge}>
                                  {isOnline ? 'Online' : 'Offline'}
                                </span>
                              </div>
                              <div style={cpStyles.bayStatus}>
                                {bayDisplay.status} - {bayDisplay.statusMessage}
                                {connection?.status && isOnline ? ` (${connection.status})` : ''}
                              </div>
                            </div>
                          </div>
                          <div style={cpStyles.bayUsage}>
                            {session.telemetry
                              ? `${session.telemetry.energyDeliveredKwh.toFixed(2)} kWh`
                              : isOnline ? 'Tap to control' : 'Offline'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* CHARGER CONTROL PANEL MODAL/DRAWER (REAL-TIME POPUP ON CLICK BAYS) */}
              {selectedChargerId && (
                <div className="sc-modal-overlay" style={cpStyles.overlay}>
                  <div className="sc-modal-card" style={cpStyles.modalCard}>
                    <div style={cpStyles.modalHeader}>
                      <div>
                        <h3 style={cpStyles.modalTitle}>Charger Controller</h3>
                        <p style={cpStyles.modalSubtitle}>
                          Device: {selectedChargerId}
                          {CHARGER_CONFIGS.find((c) => c.chargerId === selectedChargerId)?.chargerIp &&
                            ` · ${CHARGER_CONFIGS.find((c) => c.chargerId === selectedChargerId)?.chargerIp}`}
                        </p>
                        <p style={{ margin: '6px 0 0', fontSize: 12 }}>
                          <span style={
                            chargerConnections[selectedChargerId]?.connected
                              ? cpStyles.onlineBadge
                              : cpStyles.offlineBadge
                          }>
                            OCPP {chargerConnections[selectedChargerId]?.connected ? 'Online' : 'Offline'}
                          </span>
                          {!chargerConnections[selectedChargerId]?.connected && (
                            <span style={{ color: '#64748b', marginLeft: 8 }}>
                              Configure charger: ws://&lt;PC-IP&gt;:9000/ocpp/{selectedChargerId}
                            </span>
                          )}
                        </p>
                      </div>
                      <button onClick={() => { setSelectedChargerId(null); setActivationError(''); }} style={cpStyles.closeModalBtn}>✕</button>
                    </div>

                    {/* INTERACTIVE CONTROLS */}
                    {sessions[selectedChargerId]?.status === 'IDLE' && (
                      <div style={cpStyles.modalBody}>
                        <QrPanel
                          qrUrl={qrSessions[selectedChargerId]?.qrUrl || ''}
                          statusMessage={qrSessions[selectedChargerId]?.statusMessage || 'Generating QR…'}
                        />
                        {!chargerConnections[selectedChargerId]?.connected ? (
                          <p style={{ color: '#64748b', fontSize: 14, marginBottom: 20 }}>
                            This charger is offline. Connect it to OCPP at{' '}
                            <code>wss://ocpp.stratacore.tech/ocpp/{selectedChargerId}</code> before starting a session.
                          </p>
                        ) : (
                        <p style={{ color: '#475569', fontSize: 14, marginBottom: 20 }}>
                          Register an RFID card in Top-Up, then tap it on the charger reader to start a session.
                          You can also select a card below to send a remote start command.
                        </p>
                        )}
                        
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
                                disabled={!selectedRfid || exhausted || !chargerConnections[selectedChargerId]?.connected}
                                style={{
                                  ...dashStyles.btnSubmit,
                                  marginTop: 20,
                                  opacity: (!selectedRfid || exhausted || !chargerConnections[selectedChargerId]?.connected) ? 0.6 : 1,
                                  cursor: (!selectedRfid || exhausted || !chargerConnections[selectedChargerId]?.connected) ? 'not-allowed' : 'pointer',
                                }}
                              >
                                {exhausted ? 'Quota Exhausted — Charging Blocked' : 'Simulate Tap & Start Charging'}
                              </button>
                            </>
                          );
                        })()}
                      </div>
                    )}

                    {sessions[selectedChargerId]?.status === 'PREPARING' && (
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
                          {sessions[selectedChargerId]?.statusMessage}
                        </p>
                        <button
                          onClick={() => handleStopCharging(selectedChargerId)}
                          style={{ ...cpStyles.stopBtn, marginTop: 24 }}
                        >
                          Cancel / Stop Transaction
                        </button>
                      </div>
                    )}

                    {sessions[selectedChargerId]?.status === 'CHARGING' && (
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

                    {(sessions[selectedChargerId]?.status === 'COMPLETED' || sessions[selectedChargerId]?.status === 'ERROR') && (
                      <div style={cpStyles.modalBody}>
                        <div style={{
                          textAlign: 'center',
                          padding: '30px 10px',
                          color: sessions[selectedChargerId]?.status === 'COMPLETED' ? '#10b981' : '#ef4444'
                        }}>
                          <span style={{ fontSize: 48 }}>
                            {sessions[selectedChargerId]?.status === 'COMPLETED' ? '✓' : '⚠'}
                          </span>
                          <h4 style={{ margin: '15px 0 10px' }}>
                            {sessions[selectedChargerId]?.status === 'COMPLETED' ? 'CHARGING COMPLETE' : 'SESSION TERMINATED'}
                          </h4>
                          <p style={{ color: '#64748b', fontSize: 13 }}>
                            {sessions[selectedChargerId]?.statusMessage}
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
              <div className="sc-topup-grid" style={dashStyles.dashGridTwoCol}>
                
                {/* LEFT COLUMN: MANUALLY ADD RFID */}
                <div style={{ flex: '1 1 350px' }}>
                  <div className="sc-panel-card" style={dashStyles.panelCard}>
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
                <div className="sc-modal-overlay" style={cpStyles.overlay}>
                  <div className="sc-modal-card" style={{ ...cpStyles.modalCard, maxWidth: 460 }}>
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


        </main>
      </div>

      {/* Global RFID denial alert — shown immediately when an unregistered/blocked card is tapped */}
      {rfidDeniedModal && (
        <div className="sc-modal-overlay" style={cpStyles.alertOverlay}>
          <div style={{
            ...cpStyles.modalCard,
            border: rfidDeniedModal.reason === 'Invalid' ? '2px solid #f97316' : '2px solid #ef4444',
            maxWidth: 520,
          }}>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <div style={{
                width: 72,
                height: 72,
                borderRadius: '50%',
                backgroundColor: rfidDeniedModal.reason === 'Invalid' ? '#ffedd5' : '#fee2e2',
                color: rfidDeniedModal.reason === 'Invalid' ? '#ea580c' : '#dc2626',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 36,
                margin: '0 auto 16px',
              }}>
                ⚠
              </div>
              <h3 style={{ ...cpStyles.modalTitle, fontSize: 22, marginBottom: 8 }}>
                {rfidDeniedModal.reason === 'Invalid' ? 'Unregistered RFID Detected' : 'RFID Access Denied'}
              </h3>
              <p style={{ color: '#64748b', fontSize: 14, margin: 0 }}>
                Charger <strong>{rfidDeniedModal.chargerId}</strong> — charging was <strong>not started</strong>.
              </p>
            </div>

            <div style={cpStyles.alertUidBox}>
              <div style={cpStyles.alertUidLabel}>RFID Card UID</div>
              <div style={cpStyles.alertUidValue}>{rfidDeniedModal.rfidCardId}</div>
            </div>

            <p style={{ color: '#475569', fontSize: 14, lineHeight: 1.5, margin: '16px 0 24px', textAlign: 'center' }}>
              {rfidDeniedModal.message}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rfidDeniedModal.reason === 'Invalid' && (
                <button onClick={handleRegisterFromRfidAlert} style={cpStyles.alertPrimaryBtn}>
                  Register This Card in Top-Up
                </button>
              )}
              <button onClick={handleDismissRfidAlert} style={cpStyles.alertDismissBtn}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
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
    fontSize: 16,
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
  ocppPanelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
    marginBottom: 16,
    flexWrap: 'wrap' as const,
  },
  ocppTraceList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    maxHeight: 640,
    overflowY: 'auto' as const,
    width: '100%',
  },
  ocppTraceCount: {
    marginLeft: 8,
    fontSize: 11,
    fontWeight: 700,
    color: '#64748b',
    backgroundColor: '#e2e8f0',
    padding: '2px 8px',
    borderRadius: 10,
    verticalAlign: 'middle' as const,
  },
  ocppFilterGroup: {
    display: 'flex',
    gap: 4,
    backgroundColor: '#f1f5f9',
    padding: 3,
    borderRadius: 8,
  },
  ocppFilterBtn: {
    border: 'none',
    background: 'transparent',
    color: '#64748b',
    fontSize: 11,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  ocppFilterBtnActive: {
    backgroundColor: '#ffffff',
    color: '#4338ca',
    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.08)',
  },
  ocppTraceItem: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    overflow: 'visible',
    border: '1px solid #e2e8f0',
  },
  ocppTraceHeader: {
    width: '100%',
    padding: '10px 12px 0',
    cursor: 'pointer',
    color: '#0f172a',
  },
  ocppTraceHeaderTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  ocppTraceAction: {
    fontSize: 12,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  ocppRfidBadge: {
    fontSize: 9,
    fontWeight: 800,
    color: '#4338ca',
    backgroundColor: '#e0e7ff',
    padding: '2px 6px',
    borderRadius: 6,
  },
  ocppTraceMeta: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 8,
    fontSize: 10,
    color: '#64748b',
  },
  ocppTraceRawPreview: {
    margin: '8px 12px 12px',
    padding: '10px 12px',
    backgroundColor: '#0f172a',
    color: '#e2e8f0',
    borderRadius: 6,
    fontSize: 11,
    lineHeight: 1.5,
    overflowX: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
    display: 'block',
    minHeight: 24,
  },
  ocppTraceBody: {
    padding: '0 12px 12px',
    borderTop: '1px solid #e2e8f0',
  },
  ocppTraceSectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: '#94a3b8',
    textTransform: 'uppercase' as const,
    marginTop: 10,
    marginBottom: 4,
  },
  ocppTracePre: {
    margin: 0,
    padding: 10,
    backgroundColor: '#0f172a',
    color: '#e2e8f0',
    borderRadius: 8,
    fontSize: 10,
    lineHeight: 1.45,
    overflowX: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
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
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
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
  offlineBadge: {
    fontSize: 10,
    fontWeight: 700,
    backgroundColor: '#fee2e2',
    color: '#991b1b',
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
  alertOverlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    backdropFilter: 'blur(6px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2000,
    padding: 20,
  },
  alertUidBox: {
    backgroundColor: '#fff7ed',
    border: '1px solid #fed7aa',
    borderRadius: 12,
    padding: '14px 16px',
    textAlign: 'center' as const,
  },
  alertUidLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: '#ea580c',
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
    marginBottom: 6,
  },
  alertUidValue: {
    fontSize: 20,
    fontWeight: 800,
    color: '#0f172a',
    fontFamily: 'monospace',
    letterSpacing: 1,
  },
  alertPrimaryBtn: {
    width: '100%',
    padding: '14px 20px',
    backgroundColor: '#7c3aed',
    color: '#ffffff',
    border: 'none',
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
  },
  alertDismissBtn: {
    width: '100%',
    padding: '12px 20px',
    backgroundColor: '#f1f5f9',
    color: '#475569',
    border: 'none',
    borderRadius: 12,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
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
