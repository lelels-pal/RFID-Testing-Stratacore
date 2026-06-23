import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { OcppRemoteStartResult, OcppRemoteStopResult, ChargerStatus } from '@packages/shared';

export interface IChargerController {
  remoteStart(chargerId: string, connectorId: number, idTag: string): Promise<OcppRemoteStartResult>;
  remoteStop(chargerId: string, transactionId?: number): Promise<OcppRemoteStopResult>;
  cancelSession(chargerId: string, connectorId?: number): Promise<OcppRemoteStopResult>;
  getChargerStatus(chargerId: string, connectorId: number): Promise<ChargerStatus>;
}

export interface MeterUpdateEvent {
  chargerId: string;
  connectorId: number;
  sessionId: string;
  timestamp: string;
  powerKw: number;
  energyDeliveredKwh: number;
  durationSeconds: number;
  currentAmps: number;
  voltageVolts: number;
  estimatedCost: number;
}

interface PendingCall {
  action: string;
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface ChargerConnectionState {
  chargerId: string;
  status: ChargerStatus;
  socket?: WebSocket;
  connectorId: number;
  lastSeenAt?: string;
  activeTransactionId?: number;
  pendingCalls: Map<string, PendingCall>;
  meterStartWh?: number;
  latestEnergyWh?: number;
  latestPowerW?: number;
  latestCurrentA?: number;
  latestVoltageV?: number;
  latestTimestamp?: string;
  activeSessionId?: string;
  chargingStartAt?: number;
}

interface OcppActionResponseMap {
  RemoteStartTransaction: { status?: string };
  RemoteStopTransaction: { status?: string };
  Reset: { status?: string };
  ChangeAvailability: { status?: string };
}

export interface AdapterConfig {
  wsPort: number;
  wsPath?: string;
  pricePerKwh?: number;
  onAuthorize?: (idTag: string) => Promise<'Accepted' | 'Blocked' | 'Expired' | 'Invalid'>;
}

const CALL_MESSAGE = 2;
const CALL_RESULT_MESSAGE = 3;
const CALL_ERROR_MESSAGE = 4;

export class SteveOcppAdapter extends EventEmitter implements IChargerController {
  private readonly wss: WebSocketServer;
  private readonly chargers = new Map<string, ChargerConnectionState>();
  private readonly wsPort: number;
  private readonly wsPath: string;
  private readonly pricePerKwh: number;
  private readonly onAuthorize?: (idTag: string) => Promise<'Accepted' | 'Blocked' | 'Expired' | 'Invalid'>;

  constructor(config: AdapterConfig) {
    super();
    this.wsPort = config.wsPort;
    this.wsPath = config.wsPath || '/ocpp';
    this.pricePerKwh = config.pricePerKwh || 15;
    this.onAuthorize = config.onAuthorize;

    this.wss = new WebSocketServer({
      port: this.wsPort,
      // OCPP 1.6J charge points send `Sec-WebSocket-Protocol: ocpp1.6` and
      // require the central system to echo it back, otherwise they abort the
      // handshake. The `ws` lib only invokes this when the client requests a
      // subprotocol, so the simulator (which requests none) is unaffected.
      handleProtocols: (protocols) => {
        if (protocols.has('ocpp1.6')) return 'ocpp1.6';
        if (protocols.has('ocpp1.6j')) return 'ocpp1.6j';
        return protocols.values().next().value ?? false;
      },
    });
    this.wss.on('connection', (socket, request) => {
      this.handleConnection(socket, request.url || '/');
    });

    console.log(
      `[SteveOcppAdapter] OCPP 1.6J central system listening on ws://0.0.0.0:${this.wsPort}${this.wsPath}/<chargerId>`
    );
  }

  async remoteStart(chargerId: string, connectorId: number, idTag: string): Promise<OcppRemoteStartResult> {
    const charger = this.ensureChargerState(chargerId, connectorId);
    if (!charger.socket || charger.socket.readyState !== WebSocket.OPEN) {
      return {
        success: false,
        status: 'Unknown',
        errorMessage: `Charger ${chargerId} is offline or not connected to the OCPP central system.`,
      };
    }

    const response = (await this.sendCall<OcppActionResponseMap['RemoteStartTransaction']>(
      charger,
      'RemoteStartTransaction',
      {
        connectorId,
        idTag,
      }
    )) as OcppActionResponseMap['RemoteStartTransaction'];

    const accepted = response?.status === 'Accepted';
    if (accepted) {
      charger.status = 'Preparing';
      charger.activeSessionId = idTag;
    }

    return {
      success: accepted,
      status: accepted ? 'Accepted' : 'Rejected',
      transactionId: charger.activeTransactionId ? String(charger.activeTransactionId) : undefined,
      errorMessage: accepted ? undefined : `RemoteStartTransaction returned ${response?.status || 'Unknown'}.`,
    };
  }

  async remoteStop(chargerId: string, transactionId?: number): Promise<OcppRemoteStopResult> {
    const charger = this.ensureChargerState(chargerId, 1);
    if (!charger.socket || charger.socket.readyState !== WebSocket.OPEN) {
      return {
        success: false,
        status: 'Unknown',
        errorMessage: `Charger ${chargerId} is offline or not connected to the OCPP central system.`,
      };
    }

    // Fall back to the active transaction the central system is tracking when
    // the caller (kiosk/guest) does not supply an explicit transaction id.
    const resolvedTransactionId = transactionId ?? charger.activeTransactionId;
    if (resolvedTransactionId == null) {
      return {
        success: false,
        status: 'Unknown',
        errorMessage: `No active charging transaction found for charger ${chargerId}.`,
      };
    }

    const response = (await this.sendCall<OcppActionResponseMap['RemoteStopTransaction']>(
      charger,
      'RemoteStopTransaction',
      {
        transactionId: resolvedTransactionId,
      }
    )) as OcppActionResponseMap['RemoteStopTransaction'];

    const accepted = response?.status === 'Accepted';
    if (accepted) {
      charger.status = 'Finishing';
    }

    return {
      success: accepted,
      status: accepted ? 'Accepted' : 'Rejected',
      errorMessage: accepted ? undefined : `RemoteStopTransaction returned ${response?.status || 'Unknown'}.`,
    };
  }

  /**
   * Stops an active transaction, or cancels a Preparing session that has not
   * yet reported StartTransaction (common after RemoteStart / RFID authorize).
   */
  async cancelSession(chargerId: string, connectorId = 1): Promise<OcppRemoteStopResult> {
    const charger = this.ensureChargerState(chargerId, connectorId);
    if (!charger.socket || charger.socket.readyState !== WebSocket.OPEN) {
      return {
        success: false,
        status: 'Unknown',
        errorMessage: `Charger ${chargerId} is offline or not connected to the OCPP central system.`,
      };
    }

    if (charger.activeTransactionId != null) {
      return this.remoteStop(chargerId, charger.activeTransactionId);
    }

    const abortPreparing = async (): Promise<OcppRemoteStopResult> => {
      try {
        const resetResponse = (await this.sendCall<OcppActionResponseMap['Reset']>(
          charger,
          'Reset',
          { type: 'Soft' }
        )) as OcppActionResponseMap['Reset'];

        if (resetResponse?.status === 'Accepted') {
          this.clearPendingSession(charger);
          return { success: true, status: 'Accepted' };
        }
      } catch (error) {
        console.warn(`[SteveOcppAdapter] Reset failed for ${chargerId}:`, error);
      }

      try {
        const inopResponse = (await this.sendCall<OcppActionResponseMap['ChangeAvailability']>(
          charger,
          'ChangeAvailability',
          { connectorId, type: 'Inoperative' }
        )) as OcppActionResponseMap['ChangeAvailability'];

        const operativeResponse = (await this.sendCall<OcppActionResponseMap['ChangeAvailability']>(
          charger,
          'ChangeAvailability',
          { connectorId, type: 'Operative' }
        )) as OcppActionResponseMap['ChangeAvailability'];

        if (inopResponse?.status === 'Accepted' && operativeResponse?.status === 'Accepted') {
          this.clearPendingSession(charger);
          return { success: true, status: 'Accepted' };
        }
      } catch (error) {
        console.warn(`[SteveOcppAdapter] ChangeAvailability cancel failed for ${chargerId}:`, error);
      }

      return {
        success: false,
        status: 'Rejected',
        errorMessage: `Could not cancel preparing session on charger ${chargerId}.`,
      };
    };

    if (charger.status === 'Preparing' || charger.activeSessionId) {
      return abortPreparing();
    }

    return {
      success: false,
      status: 'Unknown',
      errorMessage: `No active or preparing session found for charger ${chargerId}.`,
    };
  }

  private clearPendingSession(charger: ChargerConnectionState) {
    charger.status = 'Available';
    charger.activeSessionId = undefined;
    charger.activeTransactionId = undefined;
    charger.meterStartWh = undefined;
    charger.chargingStartAt = undefined;
    this.emit('status', {
      chargerId: charger.chargerId,
      connectorId: charger.connectorId,
      status: charger.status,
    });
  }

  async getChargerStatus(chargerId: string, connectorId: number): Promise<ChargerStatus> {
    return this.ensureChargerState(chargerId, connectorId).status;
  }

  isChargerConnected(chargerId: string): boolean {
    const charger = this.chargers.get(chargerId);
    return charger?.socket?.readyState === WebSocket.OPEN;
  }

  getChargerConnectionInfo(chargerId: string): {
    chargerId: string;
    connected: boolean;
    status: ChargerStatus;
    lastSeenAt?: string;
  } {
    const charger = this.chargers.get(chargerId);
    return {
      chargerId,
      connected: charger?.socket?.readyState === WebSocket.OPEN,
      status: charger?.status ?? 'Unavailable',
      lastSeenAt: charger?.lastSeenAt,
    };
  }

  listChargerConnections(chargerIds?: string[]): Array<{
    chargerId: string;
    connected: boolean;
    status: ChargerStatus;
    lastSeenAt?: string;
  }> {
    const ids = chargerIds?.length
      ? chargerIds
      : Array.from(this.chargers.keys());
    return ids.map((chargerId) => this.getChargerConnectionInfo(chargerId));
  }

  getEndpointForCharger(chargerId: string): string {
    return `ws://<YOUR_MAC_IP>:${this.wsPort}${this.wsPath}/${chargerId}`;
  }

  private handleConnection(socket: WebSocket, rawUrl: string) {
    const chargerId = this.extractChargerId(rawUrl);
    const charger = this.ensureChargerState(chargerId, 1);
    charger.socket = socket;
    charger.lastSeenAt = new Date().toISOString();

    console.log(`[SteveOcppAdapter] Charger connected: ${chargerId}`);
    this.emit('chargerConnected', { chargerId, status: charger.status });

    socket.on('message', (message) => {
      this.handleMessage(charger, message.toString());
    });

    socket.on('close', () => {
      console.log(`[SteveOcppAdapter] Charger disconnected: ${chargerId}`);
      charger.socket = undefined;
      charger.status = 'Unavailable';
      this.emit('status', { chargerId, connectorId: charger.connectorId, status: charger.status });
    });

    socket.on('error', (error) => {
      console.error(`[SteveOcppAdapter] Socket error for ${chargerId}:`, error);
    });
  }

  private handleMessage(charger: ChargerConnectionState, rawMessage: string) {
    let message: unknown;
    try {
      message = JSON.parse(rawMessage);
    } catch (error) {
      console.error(`[SteveOcppAdapter] Invalid OCPP JSON from ${charger.chargerId}:`, error);
      return;
    }

    if (!Array.isArray(message)) return;

    const messageType = message[0];
    if (messageType === CALL_MESSAGE) {
      const [, uniqueId, action, payload] = message;
      void this.handleIncomingCall(charger, uniqueId, action, payload);
      return;
    }

    if (messageType === CALL_RESULT_MESSAGE) {
      const [, uniqueId, payload] = message;
      this.resolvePendingCall(charger, uniqueId, payload);
      return;
    }

    if (messageType === CALL_ERROR_MESSAGE) {
      const [, uniqueId, errorCode, errorDescription] = message;
      this.rejectPendingCall(charger, uniqueId, `${errorCode}: ${errorDescription}`);
    }
  }

  private async handleIncomingCall(
    charger: ChargerConnectionState,
    uniqueId: string,
    action: string,
    payload: any
  ) {
    try {
      switch (action) {
        case 'BootNotification':
          charger.status = 'Available';
          charger.lastSeenAt = new Date().toISOString();
          this.emit('status', { chargerId: charger.chargerId, connectorId: charger.connectorId, status: charger.status });
          this.sendCallResult(charger, uniqueId, {
            status: 'Accepted',
            currentTime: new Date().toISOString(),
            interval: 30,
          });
          return;

        case 'Heartbeat':
          charger.lastSeenAt = new Date().toISOString();
          this.sendCallResult(charger, uniqueId, {
            currentTime: new Date().toISOString(),
          });
          return;

        case 'Authorize': {
          let authStatus: 'Accepted' | 'Blocked' | 'Expired' | 'Invalid' = 'Accepted';
          if (this.onAuthorize && payload?.idTag) {
            try {
              authStatus = await this.onAuthorize(payload.idTag);
            } catch (error) {
              console.error(`[SteveOcppAdapter] Authorization callback failed for ${payload.idTag}:`, error);
              authStatus = 'Invalid';
            }
          }
          this.sendCallResult(charger, uniqueId, {
            idTagInfo: {
              status: authStatus,
            },
          });
          this.emit('authorize', {
            chargerId: charger.chargerId,
            connectorId: charger.connectorId,
            idTag: payload?.idTag || '',
            status: authStatus,
          });
          return;
        }

        case 'StatusNotification':
          charger.connectorId = payload.connectorId || charger.connectorId;
          charger.status = this.mapStatus(payload.status);
          charger.lastSeenAt = new Date().toISOString();
          this.emit('status', {
            chargerId: charger.chargerId,
            connectorId: charger.connectorId,
            status: charger.status,
            errorCode: payload.errorCode,
          });
          this.sendCallResult(charger, uniqueId, {});
          return;

        case 'StartTransaction': {
          const transactionId = Math.floor(Math.random() * 1_000_000);
          charger.activeTransactionId = transactionId;
          charger.activeSessionId = payload.idTag || charger.activeSessionId || `TX-${transactionId}`;
          charger.connectorId = payload.connectorId || charger.connectorId;
          charger.meterStartWh = payload.meterStart;
          charger.latestEnergyWh = payload.meterStart;
          charger.chargingStartAt = Date.now();
          charger.latestTimestamp = payload.timestamp || new Date().toISOString();
          charger.status = 'Charging';

          this.emit('startTransaction', {
            chargerId: charger.chargerId,
            connectorId: charger.connectorId,
            transactionId,
            idTag: payload.idTag,
          });
          this.emit('status', {
            chargerId: charger.chargerId,
            connectorId: charger.connectorId,
            status: charger.status,
          });

          this.sendCallResult(charger, uniqueId, {
            transactionId,
            idTagInfo: {
              status: 'Accepted',
            },
          });
          return;
        }

        case 'StopTransaction':
          this.emit('stopTransaction', {
            chargerId: charger.chargerId,
            connectorId: charger.connectorId,
            transactionId: payload.transactionId,
            meterStop: payload.meterStop,
          });
          charger.activeTransactionId = undefined;
          charger.activeSessionId = undefined;
          charger.chargingStartAt = undefined;
          charger.meterStartWh = undefined;
          charger.status = 'Available';
          this.emit('status', {
            chargerId: charger.chargerId,
            connectorId: charger.connectorId,
            status: charger.status,
          });
          this.sendCallResult(charger, uniqueId, {
            idTagInfo: {
              status: 'Accepted',
            },
          });
          return;

        case 'MeterValues':
          this.handleMeterValues(charger, payload);
          this.sendCallResult(charger, uniqueId, {});
          return;

        default:
          this.sendCallResult(charger, uniqueId, {});
      }
    } catch (error) {
      console.error(`[SteveOcppAdapter] Failed handling ${action} from ${charger.chargerId}:`, error);
      this.sendCallError(charger, uniqueId, 'InternalError', 'Central system handler failed');
    }
  }

  private handleMeterValues(charger: ChargerConnectionState, payload: any) {
    const sampledValues = payload?.meterValue?.flatMap((entry: any) => entry.sampledValue || []) || [];
    const parseValue = (measurand: string) => {
      const sample = sampledValues.find((item: any) => item.measurand === measurand);
      return sample ? Number(sample.value) : undefined;
    };

    const energyWh = parseValue('Energy.Active.Import.Register') ?? charger.latestEnergyWh ?? 0;
    const powerW = parseValue('Power.Active.Import') ?? charger.latestPowerW ?? 0;
    const currentA = parseValue('Current.Import') ?? charger.latestCurrentA ?? 0;
    const voltageV = parseValue('Voltage') ?? charger.latestVoltageV ?? 0;

    charger.latestEnergyWh = energyWh;
    charger.latestPowerW = powerW;
    charger.latestCurrentA = currentA;
    charger.latestVoltageV = voltageV;
    charger.latestTimestamp = payload?.meterValue?.[0]?.timestamp || new Date().toISOString();

    const deliveredWh = Math.max(0, energyWh - (charger.meterStartWh ?? energyWh));
    const energyDeliveredKwh = deliveredWh / 1000;
    const durationSeconds = charger.chargingStartAt
      ? Math.max(0, Math.floor((Date.now() - charger.chargingStartAt) / 1000))
      : 0;

    const update: MeterUpdateEvent = {
      chargerId: charger.chargerId,
      connectorId: charger.connectorId,
      sessionId: charger.activeSessionId || String(charger.activeTransactionId || 'unknown'),
      timestamp: charger.latestTimestamp || new Date().toISOString(),
      powerKw: Number((powerW / 1000).toFixed(3)),
      energyDeliveredKwh: Number(energyDeliveredKwh.toFixed(4)),
      durationSeconds,
      currentAmps: Number(currentA.toFixed(2)),
      voltageVolts: Number(voltageV.toFixed(2)),
      estimatedCost: Number((energyDeliveredKwh * this.pricePerKwh).toFixed(2)),
    };

    this.emit('meterValues', update);
  }

  private mapStatus(status: string): ChargerStatus {
    switch (status) {
      case 'Available':
      case 'Preparing':
      case 'Charging':
      case 'SuspendedEVSE':
      case 'SuspendedEV':
      case 'Finishing':
      case 'Faulted':
      case 'Unavailable':
        return status;
      default:
        return 'Unavailable';
    }
  }

  private extractChargerId(rawUrl: string): string {
    const parsed = new URL(rawUrl, 'ws://localhost');
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'UNKNOWN-CHARGER';
  }

  private ensureChargerState(chargerId: string, connectorId: number): ChargerConnectionState {
    const existing = this.chargers.get(chargerId);
    if (existing) return existing;

    const created: ChargerConnectionState = {
      chargerId,
      connectorId,
      status: 'Unavailable',
      pendingCalls: new Map(),
    };
    this.chargers.set(chargerId, created);
    return created;
  }

  private sendCallResult(charger: ChargerConnectionState, uniqueId: string, payload: unknown) {
    charger.socket?.send(JSON.stringify([CALL_RESULT_MESSAGE, uniqueId, payload]));
  }

  private sendCallError(charger: ChargerConnectionState, uniqueId: string, code: string, description: string) {
    charger.socket?.send(JSON.stringify([CALL_ERROR_MESSAGE, uniqueId, code, description, {}]));
  }

  private async sendCall<T>(charger: ChargerConnectionState, action: string, payload: unknown): Promise<T> {
    const socket = charger.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Charger ${charger.chargerId} is not connected.`);
    }

    const uniqueId = randomUUID();
    const message = JSON.stringify([CALL_MESSAGE, uniqueId, action, payload]);

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        charger.pendingCalls.delete(uniqueId);
        reject(new Error(`${action} timed out for ${charger.chargerId}`));
      }, 15000);

      charger.pendingCalls.set(uniqueId, {
        action,
        resolve,
        reject,
        timeout,
      });

      socket.send(message);
    });
  }

  private resolvePendingCall(charger: ChargerConnectionState, uniqueId: string, payload: unknown) {
    const pending = charger.pendingCalls.get(uniqueId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    charger.pendingCalls.delete(uniqueId);
    pending.resolve(payload);
  }

  private rejectPendingCall(charger: ChargerConnectionState, uniqueId: string, reason: unknown) {
    const pending = charger.pendingCalls.get(uniqueId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    charger.pendingCalls.delete(uniqueId);
    pending.reject(reason);
  }
}
