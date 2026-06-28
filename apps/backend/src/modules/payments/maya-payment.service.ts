import { BadRequestException, Injectable, Logger } from '@nestjs/common';

export interface MayaCheckoutResult {
  checkoutId: string;
  redirectUrl: string;
}

export interface MayaPaymentRecord {
  id: string;
  status?: string;
  paymentStatus?: string;
  isPaid?: boolean;
  requestReferenceNumber?: string;
  totalAmount?: { value: number | string; currency: string };
  amount?: string | number | { value: number | string; currency: string };
  currency?: string;
}

@Injectable()
export class MayaPaymentService {
  private readonly logger = new Logger(MayaPaymentService.name);
  private readonly publicKey = process.env.MAYA_PUBLIC_KEY || '';
  private readonly secretKey = process.env.MAYA_SECRET_KEY || '';
  private readonly apiBaseUrl =
    process.env.MAYA_API_BASE_URL ||
    (process.env.MAYA_ENV === 'production'
      ? 'https://pg.paymaya.com'
      : 'https://pg-sandbox.paymaya.com');

  private assertConfigured(): void {
    if (!this.publicKey || !this.secretKey) {
      throw new Error(
        'Maya API keys are not configured. Set MAYA_PUBLIC_KEY and MAYA_SECRET_KEY in apps/backend/.env',
      );
    }
  }

  private basicAuth(apiKey: string): string {
    return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  }

  async createCheckout(params: {
    amount: number;
    currency: string;
    requestReferenceNumber: string;
    itemName: string;
    redirectUrls: { success: string; failure: string; cancel: string };
    buyerEmail?: string;
  }): Promise<MayaCheckoutResult> {
    this.assertConfigured();

    const buyer = this.buildKountBuyer(params.buyerEmail);

    const response = await fetch(`${this.apiBaseUrl}/checkout/v1/checkouts`, {
      method: 'POST',
      headers: {
        Authorization: this.basicAuth(this.publicKey),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        totalAmount: { value: params.amount, currency: params.currency },
        requestReferenceNumber: params.requestReferenceNumber,
        redirectUrl: params.redirectUrls,
        buyer,
        items: [
          {
            name: params.itemName,
            quantity: 1,
            amount: { value: params.amount, currency: params.currency },
            totalAmount: { value: params.amount, currency: params.currency },
          },
        ],
      }),
    });

    const body = (await response.json().catch(() => ({}))) as Partial<MayaCheckoutResult> & {
      message?: string;
    };

    if (!response.ok || !body.checkoutId || !body.redirectUrl) {
      this.logger.error(`Maya create checkout failed (${response.status}): ${JSON.stringify(body)}`);
      throw new BadRequestException(body.message || 'Maya checkout creation failed.');
    }

    return { checkoutId: body.checkoutId, redirectUrl: body.redirectUrl };
  }

  private buildKountBuyer(buyerEmail?: string) {
    return {
      firstName: 'Guest',
      lastName: 'Customer',
      contact: {
        email: buyerEmail || 'guest@stratacore.tech',
      },
      billingAddress: { countryCode: 'PH' },
      shippingAddress: { countryCode: 'PH' },
    };
  }

  async retrievePayment(paymentId: string): Promise<MayaPaymentRecord> {
    this.assertConfigured();

    const response = await fetch(`${this.apiBaseUrl}/payments/v1/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        Authorization: this.basicAuth(this.secretKey),
        Accept: 'application/json',
      },
    });

    const body = (await response.json().catch(() => ({}))) as Partial<MayaPaymentRecord> & {
      message?: string;
    };

    if (!response.ok || !body.id) {
      this.logger.error(`Maya retrieve payment failed (${response.status}): ${JSON.stringify(body)}`);
      throw new Error(body.message || 'Unable to retrieve payment from Maya.');
    }

    return body as MayaPaymentRecord;
  }
}
