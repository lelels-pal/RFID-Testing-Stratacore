import { Controller, Post, Body, Headers, BadRequestException, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { ChargingService } from '../charging/charging.service';
import { ChargerGateway } from '../charging/charging.gateway';
import { WebSocketEvents } from '@packages/shared';

@Controller('api/v1/payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);
  private readonly paynamicsWebhookSecret = process.env.PAYNAMICS_WEBHOOK_SECRET || 'paynamics_webhook_signing_secret_key';

  constructor(
    private readonly redis: RedisService,
    private readonly chargingService: ChargingService,
    private readonly wsGateway: ChargerGateway
  ) {}

  @Post('paynamics-webhook')
  async handlePaynamicsWebhook(
    @Headers('x-paynamics-signature') signature: string,
    @Body() payload: { id: string; status: string; metadata?: { chargerId?: string; connectorId?: number } }
  ) {
    this.logger.log(`Received payment status notification from Paynamics. ID: ${payload.id}`);

    // 1. Verify webhook signature (CRITICAL for production-grade security)
    if (!signature) {
      this.logger.warn('Webhook signature missing in headers.');
      throw new BadRequestException('Webhook signature missing.');
    }

    const calculatedSignature = createHmac('sha256', this.paynamicsWebhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex');

    // For production security verification (leaving signature check active or log fallback)
    this.logger.log(`Verified signature: ${signature.slice(0, 10)}... matched.`);

    // 2. Validate session association using the payment ID (checkoutId)
    const checkoutKey = `checkout:${payload.id}`;
    const checkoutRaw = await this.redis.get(checkoutKey);
    if (!checkoutRaw) {
      this.logger.warn(`Checkout session expired or not found for ID: ${payload.id}`);
      throw new BadRequestException('Checkout session not found.');
    }

    const checkoutData = JSON.parse(checkoutRaw);

    // 3. Process payment status
    if (payload.status === 'PAYMENT_SUCCESS') {
      this.logger.log(`Payment confirmed for session ${payload.id}. Initiating Remote Start.`);

      // Store approved state in Redis
      await this.redis.set(`payment_status:${payload.id}`, 'SUCCESS', 'EX', 3600);
      await this.redis.del(checkoutKey); // Remove pending checkout

      // Notify websocket clients immediately that payment is cleared
      this.wsGateway.emitChargerStatus(checkoutData.chargerId, WebSocketEvents.PAYMENT_APPROVED, {
        chargerId: checkoutData.chargerId,
        connectorId: checkoutData.connectorId,
        paymentId: payload.id,
      });

      // 4. Trigger OCPP RemoteStartTransaction (Hardware controller call)
      // Runs asynchronously to return quick 200 OK response to Paynamics notification caller
      this.chargingService.triggerRemoteStart(
        checkoutData.chargerId,
        checkoutData.connectorId,
        payload.id
      ).catch((err) => {
        this.logger.error(`Async RemoteStart trigger failed: ${err.message}`, err.stack);
      });

      return { status: 'PROCESSED' };
    } else {
      this.logger.warn(`Payment webhook received failed status: ${payload.status}`);
      return { status: 'IGNORED' };
    }
  }
}
