export async function getConfig(db) {
  const { results } = await db.prepare('SELECT key, value FROM config').all();
  const cfg = {};
  for (const r of results) cfg[r.key] = r.value;
  return cfg;
}

export async function setConfig(db, key, value) {
  await db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

export function parseTypes(s) {
  return (s || '').split(',').map(x => x.trim()).filter(Boolean).map(Number);
}

export async function getBankers(db, activeOnly = true) {
  const sql = activeOnly ? 'SELECT * FROM bankers WHERE active = 1' : 'SELECT * FROM bankers';
  return (await db.prepare(sql).all()).results;
}

export async function getItem(db, itemId) {
  return db.prepare('SELECT * FROM items WHERE item_id = ?').bind(itemId).first();
}

export async function findItemByName(db, name) {
  return db.prepare('SELECT * FROM items WHERE lower(name) = lower(?)').bind(name).first();
}

export async function searchItems(db, q, limit = 25) {
  return (await db.prepare('SELECT item_id, name FROM items WHERE name LIKE ? ORDER BY name LIMIT ?').bind(`%${q}%`, limit)).all().then(r => r.results);
}

export async function stock(db) {
  const sql = `
    SELECT i.item_id, i.name, i.market_value,
      COALESCE(SUM(CASE WHEN t.direction = 'in' THEN t.qty ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.qty ELSE 0 END), 0)
      + COALESCE((SELECT SUM(p.qty) FROM purchases p WHERE p.item_id = i.item_id), 0) AS qty
    FROM items i
    JOIN transactions t ON t.item_id = i.item_id AND t.type = 'item' AND t.kind IN ('donation', 'send')
    GROUP BY i.item_id
    HAVING qty <> 0
    ORDER BY i.name`;
  const base = (await db.prepare(sql).all()).results;
  const purchasedOnly = (await db.prepare(`
    SELECT i.item_id, i.name, i.market_value, SUM(p.qty) AS qty
    FROM purchases p JOIN items i ON i.item_id = p.item_id
    WHERE p.item_id NOT IN (SELECT DISTINCT item_id FROM transactions WHERE type = 'item' AND kind IN ('donation','send') AND item_id IS NOT NULL)
    GROUP BY i.item_id`).all()).results;
  return [...base, ...purchasedOnly].sort((a, b) => a.name.localeCompare(b.name));
}

export async function stockFor(db, itemId) {
  const row = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'in' THEN qty ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN direction = 'out' THEN qty ELSE 0 END), 0) AS qty
    FROM transactions WHERE item_id = ? AND type = 'item' AND kind IN ('donation', 'send')`).bind(itemId).first();
  const p = await db.prepare('SELECT COALESCE(SUM(qty), 0) AS qty FROM purchases WHERE item_id = ?').bind(itemId).first();
  return (row?.qty || 0) + (p?.qty || 0);
}

export async function funds(db) {
  const inRow = await db.prepare(`SELECT COALESCE(SUM(qty), 0) AS v FROM transactions WHERE type = 'cash' AND direction = 'in' AND kind = 'donation'`).first();
  const outRow = await db.prepare(`SELECT COALESCE(SUM(qty), 0) AS v FROM transactions WHERE type = 'cash' AND direction = 'out' AND kind = 'send'`).first();
  const spent = await db.prepare('SELECT COALESCE(SUM(cost), 0) AS v FROM purchases').first();
  return { cash_in: inRow.v, cash_out: outRow.v, spent: spent.v, balance: inRow.v - outRow.v - spent.v };
}

export async function donorTotals(db) {
  return (await db.prepare(`
    SELECT counterparty_id, counterparty_name,
      SUM(CASE WHEN type = 'cash' THEN qty ELSE value_at_time END) AS total_value,
      SUM(CASE WHEN type = 'item' THEN qty ELSE 0 END) AS item_qty,
      SUM(CASE WHEN type = 'cash' THEN qty ELSE 0 END) AS cash
    FROM transactions WHERE kind = 'donation' AND direction = 'in'
    GROUP BY counterparty_id ORDER BY total_value DESC`).all()).results;
}

export async function memberTotals(db) {
  return (await db.prepare(`
    SELECT t.counterparty_id, t.counterparty_name, i.name AS item, SUM(t.qty) AS qty, SUM(t.value_at_time) AS value
    FROM transactions t LEFT JOIN items i ON i.item_id = t.item_id
    WHERE t.kind = 'send' AND t.direction = 'out'
    GROUP BY t.counterparty_id, t.item_id ORDER BY t.counterparty_name, i.name`).all()).results;
}

export async function ledger(db, { bankerId, days, limit = 200 } = {}) {
  const where = [];
  const binds = [];
  if (bankerId) { where.push('t.banker_id = ?'); binds.push(bankerId); }
  if (days) { where.push('t.timestamp >= ?'); binds.push(Math.floor(Date.now() / 1000) - days * 86400); }
  const sql = `
    SELECT t.*, i.name AS item_name, b.name AS banker_name
    FROM transactions t
    LEFT JOIN items i ON i.item_id = t.item_id
    LEFT JOIN bankers b ON b.torn_id = t.banker_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.timestamp DESC LIMIT ?`;
  return (await db.prepare(sql).bind(...binds, limit).all()).results;
}

export async function listRequests(db, status) {
  const sql = `
    SELECT r.*, i.name AS item_name, b.name AS banker_name
    FROM requests r
    LEFT JOIN items i ON i.item_id = r.item_id
    LEFT JOIN bankers b ON b.torn_id = r.banker_id
    ${status ? 'WHERE r.status = ?' : ''}
    ORDER BY r.created_at DESC LIMIT 100`;
  const stmt = status ? db.prepare(sql).bind(status) : db.prepare(sql);
  return (await stmt.all()).results;
}

export async function getRequest(db, id) {
  return db.prepare(`
    SELECT r.*, i.name AS item_name, b.name AS banker_name
    FROM requests r LEFT JOIN items i ON i.item_id = r.item_id LEFT JOIN bankers b ON b.torn_id = r.banker_id
    WHERE r.id = ?`).bind(id).first();
}

export function now() {
  return Math.floor(Date.now() / 1000);
}
