/**
 * IDDI → Google Sheet mirror (read-only). Paste into Extensions → Apps Script of the sheet.
 *
 * Setup (once):
 *   1. IDDI → Account → API access → "Create read-only key" (name it "Inventory sheet"). Copy it.
 *   2. Apps Script → Project Settings → Script Properties:
 *        IDDI_API_KEY  = the key (starts with iddi_)
 *        IDDI_API_BASE = https://vending-backend-nk0m.onrender.com/api
 *   3. Run `installHourlyTrigger` once and approve the permissions prompt.
 *
 * What it does: writes ONLY to two tabs it owns — "IDDI Ledger" (append-only, every stock
 * movement) and "IDDI Sell-through" (rebuilt each run). It never edits any other tab.
 * The key is read-only: this script cannot change anything in IDDI. Revoke the key in IDDI
 * and the sync stops.
 */

var LEDGER_TAB = 'IDDI Ledger';
var SELL_TAB = 'IDDI Sell-through';

function iddiGet_(path) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('IDDI_API_KEY');
  var base = props.getProperty('IDDI_API_BASE');
  if (!key || !base) throw new Error('Set IDDI_API_KEY and IDDI_API_BASE in Script Properties');
  var res = UrlFetchApp.fetch(base.replace(/\/$/, '') + '/v1' + path, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + key },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('IDDI ' + path + ' → HTTP ' + code + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText()).data;
}

function tab_(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(header);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Append ledger entries newer than the last synced id. */
function syncLedger() {
  var props = PropertiesService.getScriptProperties();
  var lastId = Number(props.getProperty('IDDI_LAST_LEDGER_ID') || 0);
  var since = props.getProperty('IDDI_LAST_LEDGER_AT'); // ISO; narrows the query
  var data = iddiGet_('/ledger?limit=1000' + (since ? '&since=' + encodeURIComponent(since) : ''));
  var fresh = data.entries.filter(function (e) { return e.id > lastId; }).reverse(); // oldest first
  if (!fresh.length) return 0;
  var sh = tab_(LEDGER_TAB, ['Ledger ID', 'When', 'Type', 'Qty', 'Before', 'After', 'SKU', 'Product', 'Machine', 'Notes']);
  var rows = fresh.map(function (e) {
    return [e.id, new Date(e.created_at), e.transaction_type, e.quantity, e.quantity_before, e.quantity_after,
      e.sku || '', e.product_name, e.machine_name || '', e.notes || ''];
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  var newest = fresh[fresh.length - 1];
  props.setProperty('IDDI_LAST_LEDGER_ID', String(newest.id));
  props.setProperty('IDDI_LAST_LEDGER_AT', newest.created_at);
  return rows.length;
}

/** Rebuild the sell-through tab from IDDI (same colours as the website). */
function syncSellThrough() {
  var data = iddiGet_('/sell-through');
  var sh = tab_(SELL_TAB, []);
  sh.clear();
  var header = ['SKU', 'Product', 'Wk -1', 'Wk -2', 'Wk -3', 'Wk -4', 'Wk -5', 'Sold (' + data.windowDays + 'd)',
    'Full capacity', 'Sell-through', 'Colour', 'In machines', 'In warehouse', 'Price', 'Unit cost', 'Margin each', 'Blacklisted'];
  var rows = data.rows.map(function (r) {
    return [r.sku || '', r.productName].concat(r.weekly).concat([r.sold, r.capacity == null ? '' : r.capacity,
      r.sellThrough == null ? '' : r.sellThrough, (r.color || 'no capacity').toUpperCase(), r.inMachines, r.inWarehouse,
      r.price == null ? '' : r.price, r.unitCost == null ? '' : r.unitCost, r.marginEach == null ? '' : r.marginEach,
      r.blacklisted ? 'YES' : '']);
  });
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  var colours = { GREEN: '#c8f2d4', YELLOW: '#fff2b3', RED: '#f8c9c9' };
  rows.forEach(function (row, i) {
    var c = colours[row[10]];
    if (c) sh.getRange(i + 2, 11).setBackground(c);
  });
  sh.getRange(1, header.length + 2).setValue('Last synced ' + new Date().toLocaleString());
  return rows.length;
}

function syncIddi() {
  var n = syncLedger();
  var m = syncSellThrough();
  Logger.log('IDDI sync: ' + n + ' new ledger rows, ' + m + ' products');
}

function installHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncIddi') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncIddi').timeBased().everyHours(1).create();
  syncIddi();
}
