import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { WebSocketEvents } from '@packages/shared';
import { RedisService } from '../redis/redis.service';
import { ChargingService } from '../charging/charging.service';
import { ChargerGateway } from '../charging/charging.gateway';
import { MayaPaymentService, MayaPaymentRecord } from './maya-payment.service';
import { resolveTariffPlan } from './tariff-plans';
import {
  amountsMatch,
  isMayaPaymentSuccessful,
  parseMayaPaymentAmount,
  resolveMayaPaymentStatus,
} from './payments.utils';

export interface CheckoutSession {
  chargerId: string;
  connectorId: number;
  tariffPlanId: string;
  amount: number;
  currency: string;
  requestReferenceNumber: string;
  status: 'PENDING' | 'PAID' | 'FAILED';
}

const CHECKOUT_TTL_SECONDS = 3600;
const PROCESSED_TTL_SECONDS = 86400;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly guestAppUrl = (process.env.GUEST_APP_URL || 'http://localhost:3002').replace(/\/$/, '');

  constructor(
    private readonly maya: MayaPaymentService,
    private readonly redis: RedisService,
    private readonly chargingService: ChargingService,
    private readonly wsGateway: ChargerGateway,
  ) {}

  async createCheckout(
    chargerId: string,
    connectorId: number,
    tariffPlanId: string,
    guestAppOrigin?: string,
  ): Promise<{ checkoutId: string; redirectUrl: string; requestReferenceNumber: string }> {
    let plan;
    try {
      plan = resolveTariffPlan(tariffPlanId);
    } catch {
      throw new BadRequestException(`Unsupported tariff plan: ${tariffPlanId}`);
    }

    const requestReferenceNumber = `SC-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const guestBase = (guestAppOrigin || this.guestAppUrl).replace(/\/$/, '');
    const returnBase = `${guestBase}/payment/return?ref=${encodeURIComponent(requestReferenceNumber)}`;

    const mayaCheckout = await this.maya.createCheckout({
      amount: plan.amount,
      currency: plan.currency,
      requestReferenceNumber,
      itemName: plan.label,
      redirectUrls: {
        success: `${returnBase}&outcome=success`,
        failure: `${returnBase}&outcome=failure`,
        cancel: `${returnBase}&outcome=cancel`,
      },
      buyerEmail: `guest+${requestReferenceNumber}@stratacore.tech`,
    });

    const session: CheckoutSession = {
      chargerId,
      connectorId,
      tariffPlanId: plan.id,
      amount: plan.amount,
      currency: plan.currency,
      requestReferenceNumber,
      status: 'PENDING',
    };

    await this.redis.set(`checkout:${mayaCheckout.checkoutId}`, JSON.stringify(session), 'EX', CHECKOUT_TTL_SECONDS);
    await this.redis.set(`checkout_rrn:${requestReferenceNumber}`, mayaCheckout.checkoutId, 'EX', CHECKOUT_TTL_SECONDS);

    this.logger.log(
      `Maya checkout ${mayaCheckout.checkoutId} created for ${chargerId} (${plan.id}, ${plan.currency} ${plan.amount})`,
    );

    return {
      checkoutId: mayaCheckout.checkoutId,
      redirectUrl: mayaCheckout.redirectUrl,
      requestReferenceNumber,
    };
  }

  async verifyAndFulfill(params: {
    checkoutId?: string;
    requestReferenceNumber?: string;
    expectedChargerId: string;
    expectedConnectorId: number;
  }): Promise<{ status: 'PROCESSED' | 'ALREADY_PROCESSED' | 'PENDING' | 'FAILED'; message?: string }> {
    const checkoutId = await this.resolveCheckoutId(params.checkoutId, params.requestReferenceNumber);
    if (!checkoutId) {
      throw new BadRequestException('Checkout session not found or expired.');
    }

    const session = await this.loadCheckoutSession(checkoutId);
    this.assertSessionBinding(session, params.expectedChargerId, params.expectedConnectorId);

    const processed = await this.redis.get(`payment_processed:${checkoutId}`);
    if (processed === 'SUCCESS') {
      return { status: 'ALREADY_PROCESSED' };
    }

    const payment = await this.maya.retrievePayment(checkoutId);
    return this.fulfillFromMayaRecord(checkoutId, session, payment);
  }

  async handleMayaWebhook(payload: MayaPaymentRecord): Promise<{ status: string }> {
    if (!payload?.id) {
      throw new BadRequestException('Invalid Maya webhook payload.');
    }

    const checkoutId = payload.id;
    const sessionRaw = await this.redis.get(`checkout:${checkoutId}`);
    if (!sessionRaw) {
      this.logger.warn(`Maya webhook for unknown checkout: ${checkoutId}`);
      throw new BadRequestException('Checkout session not found.');
    }

    const session = JSON.parse(sessionRaw) as CheckoutSession;
    const payment = await this.maya.retrievePayment(checkoutId);
    const result = await this.fulfillFromMayaRecord(checkoutId, session, payment);
    return { status: result.status };
  }

  private async resolveCheckoutId(checkoutId?: string, requestReferenceNumber?: string): Promise<string | null> {
    if (checkoutId) return checkoutId;
    if (!requestReferenceNumber) return null;
    return this.redis.get(`checkout_rrn:${requestReferenceNumber}`);
  }

  private async loadCheckoutSession(checkoutId: string): Promise<CheckoutSession> {
    const raw = await this.redis.get(`checkout:${checkoutId}`);
    if (!raw) {
      throw new BadRequestException('Checkout session not found or expired.');
    }
    return JSON.parse(raw) as CheckoutSession;
  }

  private assertSessionBinding(
    session: CheckoutSession,
    chargerId: string,
    connectorId: number,
  ): void {
    if (session.chargerId !== chargerId || session.connectorId !== connectorId) {
      throw new BadRequestException('Checkout does not belong to this guest session.');
    }
  }

  private assertPaidAmount(
    checkoutId: string,
    session: CheckoutSession,
    payment: MayaPaymentRecord,
  ): void {
    const paidAmount = parseMayaPaymentAmount(payment);
    const expectedCurrency = session.currency.toUpperCase();
    if (
      !paidAmount ||
      paidAmount.currency !== expectedCurrency ||
      !amountsMatch(session.amount, paidAmount.value)
    ) {
      this.logger.warn(
        `Amount mismatch for ${checkoutId}: expected ${expectedCurrency} ${session.amount}, got ${paidAmount?.currency ?? 'unknown'} ${paidAmount?.value ?? 'unknown'}`,
      );
      throw new BadRequestException('Payment amount verification failed.');
    }
  }

  private async fulfillFromMayaRecord(
    checkoutId: string,
    session: CheckoutSession,
    payment: MayaPaymentRecord,
  ): Promise<{ status: 'PROCESSED' | 'ALREADY_PROCESSED' | 'PENDING' | 'FAILED'; message?: string }> {
    if (payment.requestReferenceNumber && payment.requestReferenceNumber !== session.requestReferenceNumber) {
      this.logger.warn(`RRN mismatch for ${checkoutId}`);
      throw new BadRequestException('Payment reference mismatch.');
    }

    const paymentStatus = resolveMayaPaymentStatus(payment);

    if (paymentStatus === 'PAYMENT_FAILED' || paymentStatus === 'PAYMENT_EXPIRED') {
      session.status = 'FAILED';
      await this.redis.set(`checkout:${checkoutId}`, JSON.stringify(session), 'EX', CHECKOUT_TTL_SECONDS);
      return { status: 'FAILED', message: paymentStatus };
    }

    if (!isMayaPaymentSuccessful(payment)) {
      return { status: 'PENDING', message: paymentStatus || 'PROCESSING' };
    }

    this.assertPaidAmount(checkoutId, session, payment);

    const processed = await this.redis.get(`payment_processed:${checkoutId}`);
    if (processed === 'SUCCESS') {
      return { status: 'ALREADY_PROCESSED' };
    }

    await this.redis.set(`payment_processed:${checkoutId}`, 'SUCCESS', 'EX', PROCESSED_TTL_SECONDS);
    await this.redis.set(`payment_status:${checkoutId}`, 'SUCCESS', 'EX', PROCESSED_TTL_SECONDS);
    session.status = 'PAID';
    await this.redis.set(`checkout:${checkoutId}`, JSON.stringify(session), 'EX', CHECKOUT_TTL_SECONDS);

    this.wsGateway.emitChargerStatus(session.chargerId, WebSocketEvents.PAYMENT_APPROVED, {
      chargerId: session.chargerId,
      connectorId: session.connectorId,
      paymentId: checkoutId,
    });

    this.chargingService
      .triggerRemoteStart(session.chargerId, session.connectorId, checkoutId)
      .catch((err) => {
        this.logger.error(`RemoteStart failed after payment ${checkoutId}: ${err.message}`, err.stack);
      });

    return { status: 'PROCESSED' };
  }
}
