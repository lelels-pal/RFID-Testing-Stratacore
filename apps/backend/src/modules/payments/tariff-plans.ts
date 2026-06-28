export interface TariffPlan {
  id: string;
  label: string;
  energyKwh: number;
  amount: number;
  currency: 'PHP';
}

const pricePerKwh = Number(process.env.PRICE_PER_KWH) || 15;

export const TARIFF_PLANS: Record<string, TariffPlan> = {
  PREPAID_15KWH: {
    id: 'PREPAID_15KWH',
    label: 'Quick Charge (15 kWh)',
    energyKwh: 15,
    amount: Number((15 * pricePerKwh).toFixed(2)),
    currency: 'PHP',
  },
  PREPAID_30KWH: {
    id: 'PREPAID_30KWH',
    label: 'Full Charge (30 kWh)',
    energyKwh: 30,
    amount: Number((30 * pricePerKwh).toFixed(2)),
    currency: 'PHP',
  },
};

export const SUPPORTED_TARIFF_PLAN_IDS = Object.keys(TARIFF_PLANS);

export function resolveTariffPlan(tariffPlanId: string): TariffPlan {
  const plan = TARIFF_PLANS[tariffPlanId];
  if (!plan) {
    throw new Error(`Unknown tariff plan: ${tariffPlanId}`);
  }
  return plan;
}

export function getTariffEnergyKwh(tariffPlanId: string): number | undefined {
  return TARIFF_PLANS[tariffPlanId]?.energyKwh;
}
