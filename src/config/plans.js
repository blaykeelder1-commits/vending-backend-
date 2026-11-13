// Single source of truth for subscription tiers.
// Frontend reads this via GET /api/public/config — never hard-code tier values elsewhere.
// NOTE: the amount actually charged and the trial actually enforced live on the Square
// plan variations (SQUARE_*_PLAN_ID). Keep these numbers in sync with the Square Dashboard.

const TRIAL_DAYS = 7;

const PLANS = {
  free: { name: 'Free', machineLimit: 1, priceCents: 0, trialDays: 0 },
  growth: { name: 'Growth', machineLimit: 10, priceCents: 1900, trialDays: TRIAL_DAYS, planVariationId: process.env.SQUARE_GROWTH_PLAN_ID },
  pro: { name: 'Pro', machineLimit: 30, priceCents: 4900, trialDays: TRIAL_DAYS, planVariationId: process.env.SQUARE_PRO_PLAN_ID },
  business: { name: 'Business', machineLimit: 100, priceCents: 9900, trialDays: TRIAL_DAYS, planVariationId: process.env.SQUARE_BUSINESS_PLAN_ID },
};

const DEFAULT_TIER = 'free';
const PAID_TIERS = Object.keys(PLANS).filter(t => PLANS[t].priceCents > 0);

function machineLimitFor(tier) {
  return (PLANS[tier] || PLANS[DEFAULT_TIER]).machineLimit;
}

// Public shape: no Square IDs.
function publicPlans() {
  return Object.fromEntries(
    Object.entries(PLANS).map(([key, p]) => [key, {
      name: p.name, machineLimit: p.machineLimit, priceCents: p.priceCents, trialDays: p.trialDays,
    }])
  );
}

module.exports = { PLANS, TRIAL_DAYS, DEFAULT_TIER, PAID_TIERS, machineLimitFor, publicPlans };
