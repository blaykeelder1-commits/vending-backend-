#!/usr/bin/env node
/* eslint-disable no-console */
// One-time import of the Snak inventory Google Sheet into one IDDI vendor account.
//
//   node scripts/import-sheet.js --vendor 2 --sales sales.csv --costs costs.csv --stock stock.csv [--apply]
//
// Without --apply everything runs inside a transaction that is ROLLED BACK (dry run).
// Imports per product: SKU + full capacity (sales tab), unit cost + supplier (costs tab),
// and the blacklist (both tabs, deduped, earliest date wins).
// Never guessed: only an EXACT normalized-name match applies automatically. Word-subset
// matches are written to a suggestions CSV (--suggest out.csv); a human deletes wrong lines
// and passes the file back with --map. Everything else is listed in the report.
// Weekly sales history is NOT imported (the sheet's weeks are undated).
require('dotenv').config();
const fs = require('fs');
const { Client } = require('pg');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));

// --- tiny CSV parser (quotes, commas, newlines in quotes) ---
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const STOP = new Set(['oz', 'fl', 'ct', 'pk', 'pack', 'the', 'and', 'of', 'can', 'cans', 'bottle', 'variety']);
const norm = (s) => String(s || '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
  .split(/\s+/).filter(Boolean)
  .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
  .join(' ').trim();
const tokens = (s) => norm(s).split(' ').filter((w) => w && !STOP.has(w) && !/^\d+(\.\d+)?$/.test(w));
const money = (s) => { const n = parseFloat(String(s || '').replace(/[$,]/g, '')); return Number.isFinite(n) ? n : null; };
const int = (s) => { const n = parseInt(String(s || '').trim(), 10); return Number.isFinite(n) ? n : null; };
const date = (s) => { const d = new Date(String(s || '').trim()); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };

function matcher(products, map) {
  const byNorm = new Map(products.map((p) => [norm(p.product_name), p]));
  const byId = new Map(products.map((p) => [p.id, p]));
  return (sheetName) => {
    const mapped = map.get(norm(sheetName));
    if (mapped && byId.has(mapped)) return { product: byId.get(mapped), how: 'mapped' };
    const exact = byNorm.get(norm(sheetName));
    if (exact) return { product: exact, how: 'exact' };
    const st = new Set(tokens(sheetName));
    if (st.size === 0) return { product: null, how: 'none', candidates: [] };
    // IDDI name's tokens all appear in the sheet name, or vice versa
    const hits = products.filter((p) => {
      const pt = tokens(p.product_name);
      if (pt.length === 0) return false;
      const sub = pt.every((w) => st.has(w));
      const sup = [...st].every((w) => pt.includes(w));
      return sub || sup;
    });
    if (hits.length === 1) return { product: null, how: 'suggested', suggestion: hits[0] };
    return { product: null, how: hits.length ? 'ambiguous' : 'none', candidates: hits.map((h) => h.product_name) };
  };
}

function readSales(rows) {
  const out = []; const blacklist = [];
  let section = 'sales';
  for (const r of rows.slice(1)) {
    if (/BLACKLIST/i.test(r[1] || '') || /BLACKLIST/i.test(r[0] || '')) { section = 'bl-head'; continue; }
    if (section === 'bl-head') { section = 'bl'; continue; } // column header row
    if (section === 'bl') {
      if (r[0] && r[0].trim()) blacklist.push({ name: r[0].trim(), date: date(r[1]), reason: (r[2] || '').trim() || null });
      continue;
    }
    const name = (r[1] || '').trim();
    if (!name) continue;
    out.push({ sku: (r[0] || '').trim() || null, name, capacity: int(r[8]) });
  }
  return { rows: out, blacklist };
}

function readCosts(rows) {
  return rows.slice(1).filter((r) => (r[1] || '').trim()).map((r) => ({
    sku: (r[0] || '').trim() || null, name: r[1].trim(), unitCost: money(r[3]), supplier: (r[5] || '').trim() || null,
    retail: money(r[7]),
  }));
}

function readStockBlacklist(rows) {
  const out = []; let inBl = false; let skipHeader = false;
  for (const r of rows) {
    if (/BLACKLIST/i.test(r[0] || '')) { inBl = true; skipHeader = true; continue; }
    if (!inBl) continue;
    if (skipHeader) { skipHeader = false; continue; }
    if (r[0] && r[0].trim()) out.push({ name: r[0].trim(), date: date(r[3]), soldInWindow: int(r[1]), reason: 'Pulled (stock tab)' });
  }
  return out;
}

(async () => {
  const vendorId = parseInt(args.vendor, 10);
  if (!vendorId || !args.sales || !args.costs || !args.stock) {
    console.error('usage: --vendor <id> --sales <csv> --costs <csv> --stock <csv> [--apply] [--report out.md]');
    process.exit(2);
  }
  const apply = args.apply === true;
  const sales = readSales(parseCsv(fs.readFileSync(args.sales, 'utf8')));
  const costs = readCosts(parseCsv(fs.readFileSync(args.costs, 'utf8')));
  const stockBl = readStockBlacklist(parseCsv(fs.readFileSync(args.stock, 'utf8')));
  // --map: CSV of "sheet name,iddi product id" lines a human has confirmed
  const map = new Map();
  if (typeof args.map === 'string') {
    for (const r of parseCsv(fs.readFileSync(args.map, 'utf8')).slice(1)) {
      const id = parseInt(r[1], 10);
      if (r[0] && id) map.set(norm(r[0]), id);
    }
  }

  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('BEGIN');
  const report = { matched: [], unmatched: [], ambiguous: [], suggested: [], priceDiffs: [], blacklist: 0, blacklistSkipped: 0 };
  const suggestions = new Map(); // sheet name -> product
  try {
    const { rows: products } = await c.query(
      'SELECT id, product_name, price FROM products WHERE vendor_id = $1 AND is_deleted IS NOT TRUE', [vendorId]);
    const match = matcher(products, map);
    const updates = new Map(); // product id -> fields

    const note = (src, sheetName, m) => {
      if (m.product) report.matched.push(`${src}: "${sheetName}" → "${m.product.product_name}" (${m.how})`);
      else if (m.how === 'suggested') {
        report.suggested.push(`${src}: "${sheetName}" → "${m.suggestion.product_name}"?`);
        suggestions.set(sheetName, m.suggestion);
      }
      else if (m.how === 'ambiguous') report.ambiguous.push(`${src}: "${sheetName}" → ${m.candidates.join(' | ')}`);
      else report.unmatched.push(`${src}: "${sheetName}"`);
    };

    // Collision guard: one IDDI product fed by two different rows of the same tab → apply neither.
    const sources = new Map(); // `${tab}:${productId}` -> Set(sheet names)
    const claim = (tab, name, m) => {
      const k = `${tab}:${m.product.id}`;
      sources.set(k, (sources.get(k) || new Set()).add(norm(name)));
    };
    const clean = (tab, m) => sources.get(`${tab}:${m.product.id}`).size === 1;
    const salesMatches = sales.rows.map((s) => ({ s, m: match(s.name) }));
    const costMatches = costs.map((k) => ({ k, m: match(k.name) }));
    salesMatches.forEach(({ s, m }) => m.product && claim('sales', s.name, m));
    costMatches.forEach(({ k, m }) => m.product && claim('costs', k.name, m));
    for (const [key, names] of sources) {
      if (names.size > 1) report.ambiguous.push(`${key.split(':')[0]}: several rows → one IDDI product (#${key.split(':')[1]}): ${[...names].join(' | ')}`);
    }

    for (const { s, m } of salesMatches) {
      note('sales', s.name, m);
      if (!m.product || !clean('sales', m)) continue;
      const u = updates.get(m.product.id) || {};
      if (s.sku) u.sku = s.sku;
      if (s.capacity != null) u.full_capacity = s.capacity;
      updates.set(m.product.id, u);
    }
    for (const { k, m } of costMatches) {
      note('costs', k.name, m);
      if (!m.product || !clean('costs', m)) continue;
      const u = updates.get(m.product.id) || {};
      if (k.unitCost != null) u.unit_cost = k.unitCost;
      if (k.supplier) u.supplier = k.supplier;
      updates.set(m.product.id, u);
      if (k.retail != null && Math.abs(Number(m.product.price) - k.retail) > 0.009) {
        report.priceDiffs.push(`"${m.product.product_name}": IDDI $${Number(m.product.price).toFixed(2)} vs sheet retail $${k.retail.toFixed(2)} (not changed)`);
      }
    }

    const COLS = ['sku', 'full_capacity', 'unit_cost', 'supplier'];
    for (const [id, u] of updates) {
      const cols = COLS.filter((col) => u[col] !== undefined);
      if (!cols.length) continue;
      await c.query(
        `UPDATE products SET ${cols.map((col, i) => `${col} = $${i + 3}`).join(', ')} WHERE id = $1 AND vendor_id = $2`,
        [id, vendorId, ...cols.map((col) => u[col])]
      );
    }

    // Blacklist: union of both tabs, deduped by normalized name, earliest date wins
    const bl = new Map();
    for (const b of [...sales.blacklist, ...stockBl]) {
      const key = norm(b.name);
      const prev = bl.get(key);
      if (!prev || (b.date && (!prev.date || b.date < prev.date))) bl.set(key, { ...prev, ...b, soldInWindow: b.soldInWindow ?? prev?.soldInWindow ?? null });
    }
    for (const b of bl.values()) {
      const m = match(b.name);
      const r = await c.query(
        `INSERT INTO product_blacklist (vendor_id, product_id, product_name, reason, sold_in_window, blacklisted_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE))
         ON CONFLICT (vendor_id, lower(product_name)) WHERE reintroduced_at IS NULL DO NOTHING`,
        [vendorId, m.product ? m.product.id : null, b.name, b.reason, b.soldInWindow, b.date]
      );
      if (r.rowCount) report.blacklist++; else report.blacklistSkipped++;
    }

    // One IDDI product must not receive values from two different sheet rows
    report.productsUpdated = [...updates.values()].filter((u) => Object.keys(u).length).length;
    report.iddiProducts = products.length;
  } finally {
    await c.query(apply ? 'COMMIT' : 'ROLLBACK');
    await c.end();
  }

  const md = [
    `# Sheet import ${apply ? 'APPLIED' : 'DRY RUN (rolled back)'} — vendor ${vendorId}`,
    '',
    `- IDDI products: ${report.iddiProducts}; products updated: ${report.productsUpdated}`,
    `- Blacklist entries added: ${report.blacklist} (already present: ${report.blacklistSkipped})`,
    `- Applied rows: ${report.matched.length}; suggested (not applied): ${report.suggested.length}; ambiguous: ${report.ambiguous.length}; unmatched: ${report.unmatched.length}`,
    '', '## Suggested (NOT applied — confirm via the --suggest CSV, then --map)', ...report.suggested.map((x) => `- ${x}`),
    '', '## Ambiguous (resolve by hand)', ...report.ambiguous.map((x) => `- ${x}`),
    '', '## Unmatched (no IDDI product with this name)', ...report.unmatched.map((x) => `- ${x}`),
    '', '## Retail price differences (IDDI price left unchanged)', ...report.priceDiffs.map((x) => `- ${x}`),
    '', '## Matches', ...report.matched.map((x) => `- ${x}`),
  ].join('\n');
  if (args.report) fs.writeFileSync(args.report, md);
  if (typeof args.suggest === 'string') {
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = ['sheet_name,iddi_product_id,iddi_product_name'];
    for (const [name, p] of suggestions) lines.push([esc(name), p.id, esc(p.product_name)].join(','));
    fs.writeFileSync(args.suggest, `${lines.join('\n')}\n`);
  }
  console.log(md.split('\n').slice(0, 6).join('\n'));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
