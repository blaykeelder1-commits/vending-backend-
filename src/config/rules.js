// Single source of truth for business rules.
// Frontend reads the `public` subset via GET /api/public/config.
// Sell-through bands and the blacklist hold were reverse-engineered from the Snak
// Group inventory sheet (2026-11-12): sold ÷ full capacity → GREEN ≥ 0.50, YELLOW ≥ 0.20, else RED.

const RULES = {
  // Performance colour = units sold in window ÷ full stock capacity
  sellThrough: {
    greenMin: 0.5,
    yellowMin: 0.2,
    windowDays: 35, // the sheet tracks 5 weekly columns
  },

  // Expiration windows (days until expiry)
  expiry: {
    urgentDays: 3,   // red badge, "expiring soon" dashboard card
    warningDays: 7,  // amber badge, spoilage alert email
    listDays: 14,    // default window for the expiring-products list
  },

  // Blacklist: minimum hold before a pulled product is eligible for re-intro
  blacklistHoldDays: 90,

  // Reorder suggestion: cover N days of sales, rounded up to a multiple of `roundTo`
  reorder: {
    coverDays: 14,
    salesWindowDays: 30,
    roundTo: 5,
    perfBoost: 1.2,   // ≥ half of stocked machines performing
    perfNeutral: 1.0, // some performing
    perfCut: 0.8,     // none performing
  },

  // Shopping list defaults
  shoppingList: {
    windowDays: 90,
    maxWindowDays: 730,
    minApprovalPct: 50,
  },

  // Discounts
  maxActiveDiscountsPerMachine: 3,

  // Sessions and tokens
  customerSessionDays: 30,
  accessTokenTtl: process.env.JWT_EXPIRES_IN || '1h',
};

// The subset the frontend needs (no secrets, no server-only knobs).
function publicRules() {
  const { sellThrough, expiry, blacklistHoldDays, shoppingList, maxActiveDiscountsPerMachine } = RULES;
  return { sellThrough, expiry, blacklistHoldDays, shoppingList, maxActiveDiscountsPerMachine };
}

function sellThroughColor(sold, capacity) {
  if (!capacity || capacity <= 0) return null; // "no capacity" — never #DIV/0!
  const ratio = sold / capacity;
  if (ratio >= RULES.sellThrough.greenMin) return 'green';
  if (ratio >= RULES.sellThrough.yellowMin) return 'yellow';
  return 'red';
}

// Reorder math: multiply first, then round, so the result stays a multiple of roundTo.
function suggestReorder({ soldInWindow, machinesStocked, machinesPerforming, fallback }) {
  const r = RULES.reorder;
  const daily = soldInWindow > 0 ? soldInWindow / r.salesWindowDays : 0;
  if (daily === 0) return fallback;
  const perfRatio = machinesStocked > 0 ? machinesPerforming / machinesStocked : 0;
  const mult = perfRatio >= 0.5 ? r.perfBoost : perfRatio > 0 ? r.perfNeutral : r.perfCut;
  return Math.ceil((daily * r.coverDays * mult) / r.roundTo) * r.roundTo;
}

module.exports = { RULES, publicRules, sellThroughColor, suggestReorder };
