import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { IChargerController, MeterUpdateEvent, SteveOcppAdapter } from '@packages/ocpp-adapter';
import { RedisService } from '../redis/redis.service';
import { ChargerGateway } from './charging.gateway';
import { RfidService } from './rfid.service';
import { WebSocketEvents, OcppRemoteStartResult, OcppRemoteStopResult, ChargerStatus } from '@packages/shared';

@Injectable()
export class ChargingService implements OnModuleInit {
  private readonly logger = new Logger(ChargingService.name);

  // Mappings to track active RFID sessions: chargerId -> rfidCardId
  private readonly chargerToRfidMap = new Map<string, string>();
  // Tracks current session energy to compute incremental deltas: chargerId -> lastSessionEnergyKwh
  private readonly sessionEnergyMap = new Map<string, number>();

  constructor(
    @Inject('IChargerController')
    private readonly ocppAdapter: IChargerController,
    private readonly redis: RedisService,
    private readonly wsGateway: ChargerGateway,
    private readonly rfidService: RfidService,
  ) {}

  // Tracks chargers that currently have a live session, so idle status
  // reports (BootNotification / heartbeat "Available") from real hardware are
  // not misread as a completed session.
  private readonly activeSessions = new Set<string>();

  // How long to wait for an actual charging transaction to begin after a
  // RemoteStart before giving up (e.g. the driver never plugs in a vehicle).
  private readonly startTimeoutMs = Number(process.env.CHARGE_START_TIMEOUT_MS) || 60_000;

  // Per-charger "no vehicle" watchdog timers, keyed by chargerId.
  private readonly startWatchdogs = new Map<string, NodeJS.Timeout>();

  onModuleInit() {
    const realtimeAdapter = this.ocppAdapter as SteveOcppAdapter;

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
        this.clearStartWatchdog(event.chargerId);
        this.activeSessions.add(event.chargerId);
        this.wsGateway.emitChargerStatus(event.chargerId, WebSocketEvents.CHARGER_STARTING, {
          chargerId: event.chargerId,
          connectorId: event.connectorId,
          message: 'Charging Active',
        });
      }

      if (event.status === 'Finishing' || event.status === 'Available') {
        this.clearStartWatchdog(event.chargerId);
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
        this.clearStartWatchdog(event.chargerId);
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
      }
    });

    realtimeAdapter.on('meterValues', async (telemetry: MeterUpdateEvent) => {
      // 1. Forward the telemetry to WS clients
      this.wsGateway.emitMeterUpdate(telemetry.chargerId, telemetry);

      // 2. Accumulate energy usage to the RFID card in real-time
      const rfidCardId = this.chargerToRfidMap.get(telemetry.chargerId);
      if (rfidCardId) {
        const lastEnergy = this.sessionEnergyMap.get(telemetry.chargerId) || 0.0;
        const currentEnergy = telemetry.energyDeliveredKwh;
        const delta = Math.max(0, currentEnergy - lastEnergy);

        if (delta > 0) {
          try {
            const card = await this.rfidService.logUsage(rfidCardId, delta);
            this.sessionEnergyMap.set(telemetry.chargerId, currentEnergy);

            this.logger.debug(
              `RFID ${rfidCardId} consumed incremental +${delta.toFixed(4)} kWh. Total this month: ${card.currentMonthKwhConsumed.toFixed(4)} / ${card.monthlyKwhLimit} kWh`
            );

            // 3. Stop charger immediately if limit is exceeded mid-session
            if (card.currentMonthKwhConsumed >= card.monthlyKwhLimit) {
              this.logger.warn(
                `RFID Card ${rfidCardId} exceeded monthly limit of ${card.monthlyKwhLimit} kWh. Auto-stopping charger ${telemetry.chargerId}.`
              );
              
              // Force stop the charger
              await this.triggerRemoteStop(telemetry.chargerId);

              // Notify the frontend of quota exhaustion shutdown
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
      }
    });

    realtimeAdapter.on('stopTransaction', (event: { chargerId: string; connectorId: number }) => {
      this.clearStartWatchdog(event.chargerId);
      this.chargerToRfidMap.delete(event.chargerId);
      this.sessionEnergyMap.delete(event.chargerId);

      this.activeSessions.delete(event.chargerId);
      this.wsGateway.emitChargerStatus(event.chargerId, WebSocketEvents.SESSION_COMPLETED, {
        chargerId: event.chargerId,
        connectorId: event.connectorId,
        message: 'Charging session stopped successfully.',
      });
    });
  }

  /**
   * Initiates payment checkout process by contacting the Paynamics gateway (mock).
   */
  async initiateCheckout(chargerId: string, connectorId: number, tariffPlanId: string): Promise<{ checkoutId: string; redirectUrl: string }> {
    this.logger.log(`Initiating checkout. Charger: ${chargerId}, Plan: ${tariffPlanId}`);

    const checkoutId = `pnx_tx_${Math.floor(Math.random() * 1000000)}`;
    const redirectUrl = `https://www.paynamics.net/webpaymentservice/checkout/${checkoutId}/simulate-gateway`;

    // Save metadata in Redis for webhook validation
    const checkoutSession = { chargerId, connectorId, tariffPlanId, status: 'PENDING' };
    await this.redis.set(`checkout:${checkoutId}`, JSON.stringify(checkoutSession), 'EX', 600); // 10 min TTL

    return { checkoutId, redirectUrl };
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
      this.clearStartWatchdog(chargerId);
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
      this.clearStartWatchdog(chargerId);
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
    this.activeSessions.add(chargerId);

    this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.CHARGER_PREPARING, {
      chargerId,
      connectorId,
      message: 'Remote start accepted. Please plug the cable into your vehicle.',
    });

    this.armStartWatchdog(chargerId, connectorId);

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
      this.clearStartWatchdog(chargerId);
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
      this.clearStartWatchdog(chargerId);
      this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.SESSION_ERROR, {
        chargerId,
        connectorId,
        message: result.errorMessage || 'Charger remote start rejected.',
      });
      return result;
    }

    // RemoteStart accepted. The charger moves to "Preparing" (driver needs to plug in cable)
    this.activeSessions.add(chargerId);
    this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.CHARGER_PREPARING, {
      chargerId,
      connectorId,
      message: 'Remote start accepted. Please plug the cable into your vehicle.',
    });

    // Arm the "no vehicle" watchdog: if charging never actually begins (no EV
    // plugged in), auto-cancel the session so the guest is not left waiting.
    this.armStartWatchdog(chargerId, connectorId);

    return result;
  }

  /**
   * Starts a one-shot timer that fails the session if the charger does not
   * report an active charging transaction within `startTimeoutMs`.
   */
  private armStartWatchdog(chargerId: string, connectorId: number): void {
    this.clearStartWatchdog(chargerId);

    const timer = setTimeout(() => {
      this.startWatchdogs.delete(chargerId);
      this.chargerToRfidMap.delete(chargerId);
      this.sessionEnergyMap.delete(chargerId);

      // If charging actually started, the watchdog would have been cleared.
      // Reaching here means no vehicle ever began drawing power.
      if (!this.activeSessions.delete(chargerId)) return;

      this.logger.warn(
        `No charging transaction started for ${chargerId} within ${this.startTimeoutMs / 1000}s. Timing out the session.`
      );

      // Best-effort cancel of the pending remote start on the charger.
      void Promise.resolve(this.ocppAdapter.remoteStop(chargerId)).catch(() => undefined);

      this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.SESSION_ERROR, {
        chargerId,
        connectorId,
        message: `No vehicle detected within ${Math.round(
          this.startTimeoutMs / 1000
        )} seconds. Session cancelled. Please plug in your vehicle and try again.`,
      });
    }, this.startTimeoutMs);

    this.startWatchdogs.set(chargerId, timer);
  }

  private clearStartWatchdog(chargerId: string): void {
    const timer = this.startWatchdogs.get(chargerId);
    if (timer) {
      clearTimeout(timer);
      this.startWatchdogs.delete(chargerId);
    }
  }

  /**
   * Triggers RemoteStopTransaction on the charger.
   */
  async triggerRemoteStop(chargerId: string, transactionId?: number): Promise<OcppRemoteStopResult> {
    this.logger.log(`Stopping charger session: Charger: ${chargerId}, Tx: ${transactionId ?? 'active'}`);

    const result = await this.ocppAdapter.remoteStop(chargerId, transactionId);

    if (result.success) {
      this.chargerToRfidMap.delete(chargerId);
      this.sessionEnergyMap.delete(chargerId);

      this.wsGateway.emitChargerStatus(chargerId, WebSocketEvents.SESSION_COMPLETED, {
        chargerId,
        transactionId,
        message: 'Charging session stopped successfully.',
      });
    } else {
      this.logger.warn(`Remote stop failed for ${chargerId}: ${result.errorMessage || result.status}`);
    }

    return result;
  }
}
