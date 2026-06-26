// --- Handshake & Authentication State ---

export interface EphemeralSessionPayload {
  chargerId: string;
  connectorId: number;
  createdAt: number;
}

export interface VerifySessionRequest {
  qrToken: string;
  fingerprint: string;
}

export interface VerifySessionResponse {
  accessToken: string;
  chargerId: string;
  connectorId: number;
  status: ChargerStatus;
}

// --- Charging Session States ---

export type ChargerStatus = 'Available' | 'Preparing' | 'Charging' | 'SuspendedEVSE' | 'SuspendedEV' | 'Finishing' | 'Faulted' | 'Unavailable';

export interface ChargingSessionInfo {
  sessionId: string;
  chargerId: string;
  connectorId: number;
  status: 'INITIATED' | 'CLAIMED' | 'PAID' | 'ACTIVE' | 'COMPLETED' | 'FAILED';
  startTime?: string;
  endTime?: string;
  energyDeliveredKwh: number;
  totalCost: number;
}

// --- WebSocket Event Types and Payloads ---

export enum WebSocketEvents {
  // From Server to Client (Kiosk Screen / Guest Mobile App)
  SESSION_CLAIMED = 'session:claimed',       // QR has been scanned by phone
  PAYMENT_PENDING = 'payment:pending',       // Payment checkout URL generated, user redirected
  PAYMENT_APPROVED = 'payment:approved',     // Payment succeeded via Paynamics notification
  CHARGER_PREPARING = 'charger:preparing',   // RemoteStartAccepted, waiting for plug-in
  CHARGER_STARTING = 'charger:starting',     // Charging process has commenced
  METER_UPDATE = 'charger:meter_update',     // Periodic telemetry stream
  SESSION_COMPLETED = 'session:completed',   // Charging stopped/finished
  SESSION_ERROR = 'session:error',           // Failure event (e.g. timeout, fault)
  RFID_AUTH_DENIED = 'rfid:auth_denied',     // Unregistered/blocked RFID tap rejected
  OCPP_TRACE = 'ocpp:trace',               // Raw OCPP packet trace for debugging (kiosk admin)
  CHARGER_CONNECTION_CHANGED = 'charger:connection_changed', // OCPP connect/disconnect (kiosk admin)

  // From Client to Server
  SUBSCRIBE_CHARGER = 'subscribe:charger',   // Client registers for updates to a specific chargerId
}

export type OcppMessageType = 'CALL' | 'CALLRESULT' | 'CALLERROR';
export type OcppTraceDirection = 'incoming' | 'outgoing';

export interface OcppTraceEntry {
  timestamp: string;
  chargerId: string;
  direction: OcppTraceDirection;
  messageType: OcppMessageType;
  action?: string;
  uniqueId?: string;
  payload: unknown;
  raw: string;
  isRfidRelated: boolean;
  /** True when the packet carries meterStart, meterStop, or MeterValues energy data. */
  hasEnergyData?: boolean;
}

export interface WsSessionClaimedPayload {
  chargerId: string;
  connectorId: number;
  claimedAt: string;
}

export interface WsRfidAuthDeniedPayload {
  chargerId: string;
  connectorId: number;
  rfidCardId: string;
  reason: 'Invalid' | 'Blocked' | 'Expired';
  message: string;
  timestamp: string;
}

export interface WsMeterUpdatePayload {
  chargerId: string;
  connectorId: number;
  sessionId: string;
  timestamp: string;
  powerKw: number;          // Current power drawing (e.g. 7.4 kW)
  energyDeliveredKwh: number; // Cumulative energy (e.g. 12.45 kWh)
  durationSeconds: number;  // Time elapsed
  currentAmps: number;      // Current in Amperes
  voltageVolts: number;    // Voltage in Volts
  estimatedCost: number;    // Running cost calculations
  /** OCPP source for energyDeliveredKwh — MeterValues or StopTransaction meterStop, never Heartbeat. */
  energySource?: 'meterValues' | 'stopTransaction';
  isFinal?: boolean;
  meterStartWh?: number;
  meterStopWh?: number;
  energyRegisterWh?: number;
}

// --- Payment & Checkout Schemas ---

export interface CreateCheckoutRequest {
  chargerId: string;
  connectorId: number;
  tariffPlanId: string; // e.g. "PREPAID_15KWH", "PREPAID_30KWH"
}

export interface CreateCheckoutResponse {
  checkoutId: string;
  redirectUrl: string;
}

// --- OCPP Remote Operations Payload ---

export interface OcppRemoteStartResult {
  success: boolean;
  status: 'Accepted' | 'Rejected' | 'Blocked' | 'Unknown';
  transactionId?: string;
  errorMessage?: string;
}

export interface OcppRemoteStopResult {
  success: boolean;
  status: 'Accepted' | 'Rejected' | 'Unknown';
  errorMessage?: string;
}

// --- Auth & Roles ---

export type AdminRole = 'master' | 'admin' | 'staff';
export type OperatorRole = 'operator' | 'staff';

export interface AdminUser {
  username: string;
  role: AdminRole;
}

export interface AdminLoginRequest {
  username: string;
  password: string;
}

export interface AdminLoginResponse {
  user: AdminUser;
  token: string;
}

export interface OperatorLoginRequest {
  identifier: string;
  pin: string;
}

export interface OperatorProfile {
  rfid_tag: string;
  cardholderName: string;
  username?: string;
  role?: OperatorRole;
  balance: number;
  base_balance_kwh: number;
  currentMonthKwhConsumed: number;
  isActive: boolean;
}

export interface OperatorLoginResponse {
  token: string;
  user: OperatorProfile;
}

export interface ChangeOperatorPinRequest {
  currentPin: string;
  newPin: string;
}

// --- Session History ---

export type SessionType = 'rfid' | 'guest';

export interface SessionLogEntry {
  id: string;
  sessionType: SessionType;
  chargerId: string;
  connectorId: number;
  rfidCardId?: string;
  cardholderName?: string;
  energyKwh: number;
  costEstimate: number;
  startedAt: string;
  endedAt: string;
  stopReason?: string;
}

// --- Energy Requests ---

export type EnergyRequestStatus = 'pending' | 'accepted' | 'declined';

export interface EnergyRequest {
  id: string;
  rfidCardId: string;
  cardholderName: string;
  kwhAmount: number;
  status: EnergyRequestStatus;
  adminNote?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface CreateEnergyRequestBody {
  kwhAmount: number;
}

export interface ReviewEnergyRequestBody {
  adminNote?: string;
}

// --- App Settings ---

export interface AppSettings {
  defaultMonthlyKwhLimit: number;
  costPerKwh: number;
}

// --- RFID Card Management Schemas ---

export interface RfidCard {
  rfidCardId: string;
  cardholderName: string;
  monthlyKwhLimit: number;
  currentMonthKwhConsumed: number;
  lastResetDate: string;
  isActive: boolean;
  username?: string;
  role?: OperatorRole;
}

export interface CreateRfidRequest {
  rfidCardId: string;
  cardholderName: string;
  monthlyKwhLimit: number;
  username?: string;
  role?: OperatorRole;
  pin?: string;
}

export interface UpdateRfidRequest {
  cardholderName?: string;
  monthlyKwhLimit?: number;
  isActive?: boolean;
  currentMonthKwhConsumed?: number;
  username?: string;
  role?: OperatorRole;
  pin?: string;
}

export interface RfidStartRequest {
  chargerId: string;
  connectorId: number;
  rfidCardId: string;
}

export interface ChargerConnectionInfo {
  chargerId: string;
  connected: boolean;
  status: ChargerStatus;
  lastSeenAt?: string;
}

export {
  STRATACORE_DOMAIN,
  getApiBaseUrl,
  getGuestAppBaseUrl,
  buildGuestClaimUrl,
} from './urls';
export type { UrlOrigin } from './urls';

