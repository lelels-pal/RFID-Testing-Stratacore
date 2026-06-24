import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { WebSocketEvents, OcppTraceEntry, ChargerConnectionInfo } from '@packages/shared';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class ChargerGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChargerGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Allows clients (Kiosk screen and Guest app) to subscribe to a specific charger room.
   */
  @SubscribeMessage(WebSocketEvents.SUBSCRIBE_CHARGER)
  handleSubscribeCharger(
    @MessageBody() data: { chargerId: string },
    @ConnectedSocket() client: Socket
  ) {
    const roomName = `charger_room:${data.chargerId}`;
    client.join(roomName);
    this.logger.log(`Client ${client.id} joined room ${roomName}`);
    return { status: 'subscribed', room: roomName };
  }

  /**
   * Triggered server-side when a user scans the QR code.
   */
  notifyKioskSessionClaimed(chargerId: string, connectorId: number) {
    const roomName = `charger_room:${chargerId}`;
    this.logger.log(`Broadcasting: QR Claimed for room: ${roomName}`);
    this.server.to(roomName).emit(WebSocketEvents.SESSION_CLAIMED, {
      chargerId,
      connectorId,
      claimedAt: new Date().toISOString(),
    });
  }

  /**
   * Broadcasts a telemetry frame to both the Kiosk screen and Guest mobile view.
   */
  emitMeterUpdate(chargerId: string, payload: any) {
    const roomName = `charger_room:${chargerId}`;
    this.server.to(roomName).emit(WebSocketEvents.METER_UPDATE, payload);
  }

  /**
   * Broadcasts status changes (e.g. Preparing, Charging, Faulted)
   */
  emitChargerStatus(chargerId: string, event: WebSocketEvents, payload: any) {
    const roomName = `charger_room:${chargerId}`;
    this.server.to(roomName).emit(event, payload);
  }

  /**
   * Broadcasts raw OCPP packet traces to all connected admin clients (kiosk).
   */
  emitOcppTrace(entry: OcppTraceEntry) {
    this.server.emit(WebSocketEvents.OCPP_TRACE, entry);
  }

  /**
   * Broadcasts OCPP connection up/down to all kiosk admin clients.
   */
  emitChargerConnectionChanged(payload: ChargerConnectionInfo) {
    this.server.emit(WebSocketEvents.CHARGER_CONNECTION_CHANGED, payload);
  }
}
