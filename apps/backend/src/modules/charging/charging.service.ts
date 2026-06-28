import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { IChargerController, MeterUpdateEvent, SteveOcppAdapter, StopTransactionEvent } from '@packages/ocpp-adapter';
import { RedisService } from '../redis/redis.service';
import { ChargerGateway } from './charging.gateway';
import { RfidService } from './rfid.service';
import { ChargeStartWatchdogService } from '../watchdog/charge-start-watchdog.service';
import { StaleSessionWatchdogService, TrackedSession } from '../watchdog/stale-session-watchdog.service';
import { OcppTraceService } from './ocpp-trace.service';
import { WatchdogEventLogService } from '../watchdog/watchdog-event-log.service';
import { WebSocketEvents, OcppRemoteStartResult, OcppRemoteStopResult, ChargerStatus, ChargerConnectionInfo, OcppTraceEntry } from '@packages/shared';

@Injectable()
export class ChargingService implements OnModuleInit {
  private readonly logger = new Logger(ChargingService.name);

  // Mappings to track active RFID sessions: chargerId -> rfidCardId
  private readonly chargerToRfidMap = new Map<string, string>();
  // Tracks current session energy to compute incremental deltas: chargerId -> lastSessionEnergyKwh
  private readonly sessionEnergyMap = new Map<string, number>();

  // Session metadata for stale-session recovery.
  private readonly sessionStartedAt = new Map<string, string>();
  private readonly sessionConnectors = new Map<string, number>();

  constructor(
    @Inject('IChargerController')
    private readonly ocppAdapter: IChargerController,
    private readonly redis: RedisService,
    private readonly wsGateway: ChargerGateway,
    private readonly rfidService: RfidService,
    private readonly chargeStartWatchdog: ChargeStartWatchdogService,
    private readonly staleSessionWatchdog: StaleSessionWatchdogService,
    private readonly watchdogEvents: WatchdogEventLogService,
    private readonly ocppTrace: OcppTraceService,
  ) {}

  // Tracks chargers that currently have a live session, so idle status
  // reports (BootNotification / heartbeat "Available") from real hardware are
  // not misread as a completed session.
  private readonly activeSessions = new Set<string>();

  onModuleInit() {
    const realtimeAdapter = this.ocppAdapter as SteveOcppAdapter;

    this.staleSessionWatchdog.setOcppAdapter(realtimeAdapter);
    this.staleSessionWatchdog.registerRecoveryHandler({
      getActiveSessions: () => this.getActiveSessions(),
      recoverStaleSession: (chargerId, connectorId) => this.recoverStaleSession(chargerId, connectorId),
    });

    realtimeAdapter.on('chargerConnected', (event: { chargerId: string; status: ChargerStatus }) => {
      this.logger.log(`Charger connected via OCPP: ${event.chargerId}`);
      this.emitConnectionChanged(event.chargerId);
    });

    realtimeAdapter.on('status', (event: { chargerId: string; connectorId: number; status: ChargerStatus }) => {
      if (event.status === 'Preparing') {
        this.activeSessions.add(event.chargerId);
        this.wsGateway.emitChargerStatus(event.chargerId, WebSocketEvents.CHARGER_PREPARING, {
          chargerId: event.chargerId,
          connectorId: event.connectorId,
          message: 'Charger preparing. Waiting for cable and EV handshake.',
        });
      }

      if (event.status === 'Charging') {
        // A real charging transaction has begun, so the "no vehicle" watchdog
        // is no longer needed.
        this.chargeStartWatchdog.clear(event.chargerId);
        this.activeSessions.add(event.chargerId);
        this.wsGateway.emitChargerStatus(event.chargerId, WebSocketEvents.CHARGER_STARTING, {
          chargerId: event.chargerId,
          connectorId: event.connectorId,
          message: 'Charging Active',
        });
      }

      if (event.status === 'Finishing' || event.status === 'Available') {
        this.chargeStartWatchdog.clear(event.chargerId);
        this.clearSessionMetadata(event.chargerId);
        this.chargerToRfidMap.delete(event.chargerId);
        this.sessionEnergyMap.delete(event.chargerId);

        // Only a charger that was actively in a session can "complete" one.
        // Idle availability (boot/heartbeat) is ignored to avoid false resets.
        if (this.activeSessions.delete(event.chargerId)) {
          this.wsGateway.emitChargerStatus(event.chargerId, WebSocketEvents.SESSION_COMPLETED, {
            chargerId: event.chargerId,
            connectorId: event.connectorId,
            message: 'Charging session completed successfully.',
          });
        }
      }

      if (event.status === 'Faulted' || event.status === 'Unavailable') {
        this.chargeStartWatchdog.clear(event.chargerId);
        this.clearSessionMetadata(event.chargerId);
        this.chargerToRfidMap.delete(event.chargerId);
        this.sessionEnergyMap.delete(event.chargerId);

        // Only surface a fault to an in-progress session; ignore idle disconnects.
        if (this.activeSessions.delete(event.chargerId)) {
          this.wsGateway.emitChargerStatus(event.chargerId, WebSocketEvents.SESSION_ERROR, {
            chargerId: event.chargerId,
            connectorId: event.connectorId,
            message: `Charger status changed to ${event.status}.`,
          });
        }

        if (event.status === 'Unavailable') {
          this.emitConnectionChanged(event.chargerId);
        }
      }
    });

    realtimeAdapter.on('meterValues', async (telemetry: MeterUpdateEvent) => {
      this.wsGateway.emitMeterUpdate(telemetry.chargerId, telemetry);

      // Live session totals from MeterValues during charging.
      // Final kWh is reconciled from StopTransaction meterStop — skip duplicate RFID logging.
      if (telemetry.isFinal) {
        return;
      }

      await this.applyIncrementalRfidEnergy(telemetry);
    });

    realtimeAdapter.on(
      'authorize',
      (event: {
        chargerId: string;
        connectorId: number;
        idTag: string;
        status: 'Accepted' | 'Blocked' | 'Expired' | 'Invalid';
      }) => {
        if (event.status === 'Accepted') return;

        const messages: Record<'Invalid' | 'Blocked' | 'Expired', string> = {
          Invalid: `Unregistered RFID card ${event.idTag} tapped. Charging denied — register this card in Top-Up.`,
          Blocked: `RFID card ${event.idTag} is blocked or quota exhausted. Charging denied.`,
          Expired: `RFID card ${event.idTag} has expired. Charging denied.`,
        };

        const reason = event.status === 'Invalid' || event.status === 'Blocked' || event.status === 'Expired'
          ? event.status
          : 'Invalid';

        this.logger.warn(
          `RFID authorization denied on ${event.chargerId}: idTag=${event.idTag}, reason=${reason}`
        );

        this.wsGateway.emitChargerStatus(event.chargerId, WebSocketEvents.RFID_AUTH_DENIED, {
          chargerId: event.chargerId,
          connectorId: event.connectorId,
          rfidCardId: event.idTag,
          reason,
          message: messages[reason],
          timestamp: new Date().toISOString(),
        });
      }
    );

    realtimeAdapter.on('startTransaction', async (event: {
      chargerId: string;
      connectorId: number;
      transactionId?: number;
      idTag?: string;
      meterStartWh?: number;
    }) => {
      // Already linked by the kiosk/guest remote-start flow — nothing to do.
      if (this.chargerToRfidMap.has(event.chargerId)) {
        return;
      }
      if (!event.idTag) return;

      try {
        const card = await this.rfidService.getById(event.idTag);
        if (!card) return; // Not a registered RFID card (e.g. a guest payment session).

        this.chargerToRfidMap.set(event.chargerId, card.rfidCardId);
        this.sessionEnergyMap.set(event.chargerId, 0);
        this.activeSessions.add(event.chargerId);
        this.chargeStartWatchdog.clear(event.chargerId);

        this.logger.log(
          `Physical RFID tap on ${event.chargerId} linked to card ${card.rfidCardId}. ` +
          `Quota: ${card.currentMonthKwhConsumed.toFixed(2)} / ${card.monthlyKwhLimit} kWh. ` +
          `meterStart: ${event.meterStartWh ?? 'n/a'} Wh`
        );
      } catch (err) {
        this.logger.error(`Failed to link RFID card for startTransaction on ${event.chargerId}:`, err);
      }
    });

    realtimeAdapter.on('stopTransaction', async (event: StopTransactionEvent) => {
      // Authoritative session total from StopTransaction meterStop (not Heartbeat).
      await this.applyFinalRfidEnergy(event);

      this.chargeStartWatchdog.clear(event.chargerId);
      this.clearSessionMetadata(event.chargerId);
      this.chargerToRfidMap.delete(event.chargerId);
      this.sessionEnergyMap.delete(event.chargerId);

      this.activeSessions.delete(event.chargerId);
      this.wsGateway.emitChargerStatus(event.chargerId, WebSocketEvents.SESSION_COMPLETED, {
        chargerId: event.chargerId,
        connectorId: event.connectorId,
        message: `Charging session stopped. Delivered ${event.energyDeliveredKwh.toFixed(4)} kWh.`,
      });
    });

    realtimeAdapter.on('ocppTrace', (entry: OcppTraceEntry) => {
      this.ocppTrace.add(entry);
      this.wsGateway.emitOcppTrace(entry);
    });
  }

  private async applyIncrementalRfidEnergy(telemetry: MeterUpdateEvent): Promise<void> {
    const rfidCardId = this.chargerToRfidMap.get(telemetry.chargerId);
    if (!rfidCardId) return;

    const lastEnergy = this.sessionEnergyMap.get(telemetry.chargerId) ?? 0;
    const currentEnergy = telemetry.energyDeliveredKwh;
    const delta = Math.max(0, currentEnergy - lastEnergy);
    if (delta <= 0) return;

    try {
      const card = await this.rfidService.logUsage(rfidCardId, delta);
      this.sessionEnergyMap.set(telemetry.chargerId, currentEnergy);

      this.logger.debug(
        `RFID ${rfidCardId} +${delta.toFixed(4)} kWh via MeterValues ` +
        `(register ${telemetry.energyRegisterWh ?? 'n/a'} Wh, start ${telemetry.meterStartWh ?? 'n/a'} Wh). ` +
        `Monthly: ${card.currentMonthKwhConsumed.toFixed(4)} / ${card.monthlyKwhLimit} kWh`
      );

      if (card.currentMonthKwhConsumed >= card.monthlyKwhLimit) {
        this.logger.warn(
          `RFID Card ${rfidCardId} exceeded monthly limit of ${card.monthlyKwhLimit} kWh. Auto-stopping charger ${telemetry.chargerId}.`
        );
        await this.triggerRemoteStop(telemetry.chargerId);
        this.wsGateway.emitChargerStatus(telemetry.chargerId, WebSocketEvents.SESSION_ERROR, {
          chargerId: telemetry.chargerId,
          connectorId: telemetry.connectorId,
          message: `Session stopped automatically: Monthly limit of ${card.monthlyKwhLimit} kWh has been reached.`,
        });
      }
    } catch (err) {
      this.logger.error(`Failed to update RFID usage for card ${rfidCardId}:`, err);
    }
  }

  private async applyFinalRfidEnergy(event: StopTransactionEvent): Promise<void> {
    const rfidCardId = this.chargerToRfidMap.get(event.chargerId);
    if (!rfidCardId) return;

    const lastEnergy = this.sessionEnergyMap.get(event.chargerId) ?? 0;
    const finalEnergy = event.energyDeliveredKwh;
    const delta = Math.max(0, finalEnergy - lastEnergy);
    if (delta <= 0) {
      this.logger.log(
        `StopTransaction on ${event.chargerId}: ${finalEnergy.toFixed(4)} kWh total ` +
        `(meterStart ${event.meterStartWh ?? 'n/a'} Wh, meterStop ${event.meterStopWh ?? 'n/a'} Wh). No remaining delta.`
      );
      return;
    }

    try {
      const card = await this.rfidService.logUsage(rfidCardId, delta);
      this.sessionEnergyMap.set(event.chargerId, finalEnergy);
      this.logger.log(
        `StopTransaction on ${event.chargerId}: +${delta.toFixed(4)} kWh final delta ` +
        `(${finalEnergy.toFixed(4)} kWh session total from meterStop). ` +
        `RFID ${rfidCardId} monthly: ${card.currentMonthKwhConsumed.toFixed(4)} / ${card.monthlyKwhLimit} kWh`
      );
    } catch (err) {
      this.logger.error(`Failed to finalize RFID usage for card ${rfidCardId}:`, err);
    }
  }

  /**
   * Triggers RemoteStartTransaction on the charger via CSMS adapter using an RFID card.
   */
  async startRfidSession(chargerId: string, connectorId: number, rfidCardId: string): Promise<OcppRemoteStartResult> {
    this.logger.log(`Triggering RFID RemoteStart for Charger ${chargerId}, RFID ${rfidCardId}`);

    let result: OcppRemoteStartResult;
    try {
      result = await this.ocppAdapter.remoteStart(chargerId, connectorId, rfidCardId);
    } catch (err) {
      this.logger.warn(`RemoteStart did not get a response from ${chargerId}: ${(err as Error).message}`);
      this.chargeStartWatchdog.clear(chargerId);
      this.clearSessionMetadata(chargerId);
      this.activeSessions.delete(chargerId);
      this.chargerToRfidMap.delete(chargerId);
      this.sessionEnergyMap.delete(chargerId);
      
      this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.SESSION_ERROR, {
        chargerId,
        connectorId,
        message: 'Charger did not respond. Please try again.',
      });
      return { success: false, status: 'Unknown', errorMessage: (err as Error).message };
    }

    if (!result.success || result.status !== 'Accepted') {
      this.logger.warn(`OCPP CSMS rejected remote start: ${result.errorMessage || result.status}`);
      this.chargeStartWatchdog.clear(chargerId);
      this.clearSessionMetadata(chargerId);
      this.chargerToRfidMap.delete(chargerId);
      this.sessionEnergyMap.delete(chargerId);
      
      this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.SESSION_ERROR, {
        chargerId,
        connectorId,
        message: result.errorMessage || 'Charger remote start rejected.',
      });
      return result;
    }

    // Map active session to charger
    this.chargerToRfidMap.set(chargerId, rfidCardId);
    this.sessionEnergyMap.set(chargerId, 0.0);
    this.trackSessionStart(chargerId, connectorId);

    this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.CHARGER_PREPARING, {
      chargerId,
      connectorId,
      message: 'Remote start accepted. Please plug the cable into your vehicle.',
    });

    this.armChargeStartWatchdog(chargerId, connectorId);

    return result;
  }

  /**
   * Triggers RemoteStartTransaction on the charger via CSMS adapter.
   * Runs only after server-side payment has been verified.
   */
  async triggerRemoteStart(chargerId: string, connectorId: number, paymentId: string): Promise<OcppRemoteStartResult> {
    this.logger.log(`Triggering RemoteStart for Charger ${chargerId}, Connector ${connectorId}`);

    // Generate RFID tag
    const idTag = `GUEST-${paymentId.slice(-8).toUpperCase()}`;

    let result: OcppRemoteStartResult;
    try {
      // Invoke external CSMS (Steve-like API adapter)
      result = await this.ocppAdapter.remoteStart(chargerId, connectorId, idTag);
    } catch (err) {
      // The charger never answered the RemoteStartTransaction (offline/unresponsive).
      this.logger.warn(`RemoteStart did not get a response from ${chargerId}: ${(err as Error).message}`);
      this.chargeStartWatchdog.clear(chargerId);
      this.clearSessionMetadata(chargerId);
      this.activeSessions.delete(chargerId);
      this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.SESSION_ERROR, {
        chargerId,
        connectorId,
        message: 'Charger did not respond. Please try again or contact the Admin office.',
      });
      return { success: false, status: 'Unknown', errorMessage: (err as Error).message };
    }

    if (!result.success || result.status !== 'Accepted') {
      this.logger.warn(`OCPP CSMS rejected remote start: ${result.errorMessage || result.status}`);
      this.chargeStartWatchdog.clear(chargerId);
      this.clearSessionMetadata(chargerId);
      this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.SESSION_ERROR, {
        chargerId,
        connectorId,
        message: result.errorMessage || 'Charger remote start rejected.',
      });
      return result;
    }

    // RemoteStart accepted. The charger moves to "Preparing" (driver needs to plug in cable)
    this.trackSessionStart(chargerId, connectorId);
    this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.CHARGER_PREPARING, {
      chargerId,
      connectorId,
      message: 'Remote start accepted. Please plug the cable into your vehicle.',
    });

    this.armChargeStartWatchdog(chargerId, connectorId);

    return result;
  }

  private trackSessionStart(chargerId: string, connectorId: number): void {
    this.activeSessions.add(chargerId);
    this.sessionConnectors.set(chargerId, connectorId);
    this.sessionStartedAt.set(chargerId, new Date().toISOString());
  }

  private clearSessionMetadata(chargerId: string): void {
    this.sessionConnectors.delete(chargerId);
    this.sessionStartedAt.delete(chargerId);
  }

  getActiveSessions(): TrackedSession[] {
    return Array.from(this.activeSessions).map((chargerId) => ({
      chargerId,
      connectorId: this.sessionConnectors.get(chargerId) ?? 1,
      startedAt: this.sessionStartedAt.get(chargerId) ?? new Date().toISOString(),
    }));
  }

  async recoverStaleSession(chargerId: string, connectorId: number): Promise<void> {
    this.chargeStartWatchdog.clear(chargerId);
    this.chargerToRfidMap.delete(chargerId);
    this.sessionEnergyMap.delete(chargerId);
    this.clearSessionMetadata(chargerId);
    this.activeSessions.delete(chargerId);

    void Promise.resolve(this.ocppAdapter.cancelSession(chargerId)).catch(() => undefined);

    this.watchdogEvents.add(
      'stale_session',
      chargerId,
      'Recovered orphaned session after charger disconnect without StopTransaction',
    );

    this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.SESSION_ERROR, {
      chargerId,
      connectorId,
      message: 'Session ended automatically because the charger disconnected unexpectedly.',
    });
  }

  private armChargeStartWatchdog(chargerId: string, connectorId: number): void {
    this.chargeStartWatchdog.arm({ chargerId, connectorId }, () => {
      this.chargerToRfidMap.delete(chargerId);
      this.sessionEnergyMap.delete(chargerId);

      if (!this.activeSessions.delete(chargerId)) return;

      this.clearSessionMetadata(chargerId);
      this.watchdogEvents.add(
        'charge_start_timeout',
        chargerId,
        `No vehicle detected within ${this.chargeStartWatchdog.getTimeoutSeconds()} seconds`,
      );

      void Promise.resolve(this.ocppAdapter.cancelSession(chargerId)).catch(() => undefined);

      this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.SESSION_ERROR, {
        chargerId,
        connectorId,
        message: `No vehicle detected within ${this.chargeStartWatchdog.getTimeoutSeconds()} seconds. Session cancelled. Please plug in your vehicle and try again.`,
      });
    });
  }

  /**
   * Triggers RemoteStopTransaction on the charger.
   */
  async triggerRemoteStop(chargerId: string, transactionId?: number): Promise<OcppRemoteStopResult> {
    this.logger.log(`Stopping charger session: Charger: ${chargerId}, Tx: ${transactionId ?? 'active'}`);

    this.chargeStartWatchdog.clear(chargerId);

    const result = transactionId != null
      ? await this.ocppAdapter.remoteStop(chargerId, transactionId)
      : await this.ocppAdapter.cancelSession(chargerId);

    this.chargerToRfidMap.delete(chargerId);
    this.sessionEnergyMap.delete(chargerId);
    this.clearSessionMetadata(chargerId);
    this.activeSessions.delete(chargerId);

    if (result.success) {
      this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.SESSION_COMPLETED, {
        chargerId,
        transactionId,
        message: 'Charging session stopped successfully.',
      });
    } else {
      this.logger.warn(`Remote stop failed for ${chargerId}: ${result.errorMessage || result.status}`);
      // Still reset the kiosk UI when the operator cancels — the charger may
      // already be idle even if OCPP did not acknowledge the abort command.
      this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.SESSION_COMPLETED, {
        chargerId,
        transactionId,
        message: result.errorMessage || 'Session cancelled from kiosk.',
      });
    }

    return result;
  }

  getChargersStatus(chargerIds: string[]): ChargerConnectionInfo[] {
    const adapter = this.ocppAdapter as SteveOcppAdapter;
    return adapter.listChargerConnections(chargerIds);
  }

  getOcppTrace(limit = 50, rfidOnly = false) {
    return this.ocppTrace.list(limit, rfidOnly);
  }

  private emitConnectionChanged(chargerId: string) {
    const adapter = this.ocppAdapter as SteveOcppAdapter;
    const info = adapter.getChargerConnectionInfo(chargerId);
    this.wsGateway.emitChargerConnectionChanged(info);
  }
}
