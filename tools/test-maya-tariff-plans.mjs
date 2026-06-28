/**
 * Quick sanity check for both prepaid tariff amounts against Maya sandbox parsing rules.
 * Run: node tools/test-maya-tariff-plans.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '../apps/backend/.env');
const env = fs.readFileSync(envPath, 'utf8');
const pk = env.match(/MAYA_PUBLIC_KEY=(.+)/)?.[1]?.trim();
const sk = env.match(/MAYA_SECRET_KEY=(.+)/)?.[1]?.trim();

if (!pk || !sk) {
  console.error('Missing Maya keys in apps/backend/.env');
  process.exit(1);
}

const auth = (k) => `Basic ${Buffer.from(`${k}:`).toString('base64')}`;
const apiBase = env.match(/MAYA_API_BASE_URL=(.+)/)?.[1]?.trim() || 'https://pg-sandbox.paymaya.com';

const plans = [
  { id: 'PREPAID_15KWH', amount: 225, label: 'Quick Charge (15 kWh)' },
  { id: 'PREPAID_30KWH', amount: 450, label: 'Full Charge (30 kWh)' },
];

function parseMayaPaymentAmount(record) {
  const nested = record.totalAmount || (typeof record.amount === 'object' ? record.amount : null);
  if (nested?.value != null && nested.currency) {
    const value = Number(nested.value);
    if (!Number.isNaN(value)) return { value, currency: nested.currency.toUpperCase() };
  }
  if (record.amount != null && record.currency) {
    const value = Number(record.amount);
    if (!Number.isNaN(value)) return { value, currency: record.currency.toUpperCase() };
  }
  return null;
}

let failed = 0;

for (const plan of plans) {
  const rrn = `SC-TEST-${plan.id}-${Date.now()}`;
  const createRes = await fetch(`${apiBase}/checkout/v1/checkouts`, {
    method: 'POST',
    headers: { Authorization: auth(pk), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      totalAmount: { value: plan.amount, currency: 'PHP' },
      requestReferenceNumber: rrn,
      redirectUrl: { success: 'http://localhost/s', failure: 'http://localhost/f', cancel: 'http://localhost/c' },
      buyer: {
        firstName: 'Guest',
        lastName: 'Customer',
        contact: { email: 'test@stratacore.tech' },
        billingAddress: { countryCode: 'PH' },
        shippingAddress: { countryCode: 'PH' },
      },
      items: [
        {
          name: plan.label,
          quantity: 1,
          amount: { value: plan.amount, currency: 'PHP' },
          totalAmount: { value: plan.amount, currency: 'PHP' },
        },
      ],
    }),
  });

  const checkout = await createRes.json();
  if (!createRes.ok || !checkout.checkoutId) {
    console.error(`FAIL ${plan.id}: checkout create`, checkout);
    failed += 1;
    continue;
  }

  const getRes = await fetch(`${apiBase}/payments/v1/payments/${checkout.checkoutId}`, {
    headers: { Authorization: auth(sk), Accept: 'application/json' },
  });
  const payment = await getRes.json();
  const parsed = parseMayaPaymentAmount(payment);

  if (!parsed || parsed.value !== plan.amount || parsed.currency !== 'PHP') {
    console.error(`FAIL ${plan.id}: amount parse`, { expected: plan.amount, parsed, payment });
    failed += 1;
    continue;
  }

  console.log(`OK ${plan.id}: checkout ${checkout.checkoutId}, amount PHP ${parsed.value}`);
}

if (failed > 0) process.exit(1);
