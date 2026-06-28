import {
  Controller,
  Post,
  Body,
  Headers,
  Query,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { AuthService } from '../auth/auth.service';
import { MayaPaymentRecord } from './maya-payment.service';

@Controller('api/v1/payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);
  private readonly webhookToken = process.env.MAYA_WEBHOOK_TOKEN || '';

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly authService: AuthService,
  ) {}

  @Post('verify')
  async verifyPayment(
    @Headers('authorization') authHeader: string,
    @Headers('x-device-fingerprint') fingerprint: string,
    @Body() body: { checkoutId?: string; requestReferenceNumber?: string },
  ) {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication token missing.');
    }
    if (!fingerprint) {
      throw new BadRequestException('Security headers (x-device-fingerprint) missing.');
    }
    if (!body.checkoutId && !body.requestReferenceNumber) {
      throw new BadRequestException('checkoutId or requestReferenceNumber is required.');
    }

    const token = authHeader.split(' ')[1];
    const session = this.authService.validateGuestToken(token, fingerprint);

    return this.paymentsService.verifyAndFulfill({
      checkoutId: body.checkoutId,
      requestReferenceNumber: body.requestReferenceNumber,
      expectedChargerId: session.chargerId,
      expectedConnectorId: session.connectorId,
    });
  }

  @Post('maya-webhook')
  async handleMayaWebhook(
    @Query('token') token: string,
    @Body() payload: MayaPaymentRecord,
  ) {
    if (!this.webhookToken) {
      throw new ForbiddenException('Maya webhooks are disabled. Set MAYA_WEBHOOK_TOKEN to enable.');
    }
    if (!token || token !== this.webhookToken) {
      this.logger.warn('Maya webhook rejected: invalid or missing URL token.');
      throw new ForbiddenException('Invalid webhook token.');
    }

    this.logger.log(
      `Maya webhook received for payment ${payload?.id} (${payload?.status || payload?.paymentStatus})`,
    );
    return this.paymentsService.handleMayaWebhook(payload);
  }
}
