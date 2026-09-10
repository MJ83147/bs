import { ITEM_CATEGORIES, CATEGORY_LABELS, CATEGORY_MODE, CATEGORY_KEYS, categoryOfItem } from './categories.js';

// qty at/above = high, below = low (category page). Single editable threshold.
export const LOW_STOCK = 50;

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
    JOIN transactions t ON t.item_id = i.item_id AND t.type = 'item' AND t.kind IN ('donation', 'send', 'usage')
    GROUP BY i.item_id
    HAVING qty <> 0
    ORDER BY i.name`;
  const base = (await db.prepare(sql).all()).results;
  const purchasedOnly = (await db.prepare(`
    SELECT i.item_id, i.name, i.market_value, SUM(p.qty) AS qty
    FROM purchases p JOIN items i ON i.item_id = p.item_id
    WHERE p.item_id NOT IN (SELECT DISTINCT item_id FROM transactions WHERE type = 'item' AND kind IN ('donation','send','usage') AND item_id IS NOT NULL)
    GROUP BY i.item_id`).all()).results;
  return [...base, ...purchasedOnly].sort((a, b) => a.name.localeCompare(b.name));
}

export async function stockFor(db, itemId) {
  const row = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'in' THEN qty ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN direction = 'out' THEN qty ELSE 0 END), 0) AS qty
    FROM transactions WHERE item_id = ? AND type = 'item' AND kind IN ('donation', 'send', 'usage')`).bind(itemId).first();
  const p = await db.prepare('SELECT COALESCE(SUM(qty), 0) AS qty FROM purchases WHERE item_id = ?').bind(itemId).first();
  return (row?.qty || 0) + (p?.qty || 0);
}

export async function stockForItems(db, itemIds) {
  if (!itemIds || !itemIds.length) return 0;
  const ph = itemIds.map(() => '?').join(',');
  const row = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN qty ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN direction = 'out' THEN qty ELSE 0 END), 0) AS qty
    FROM transactions WHERE item_id IN (${ph}) AND type = 'item' AND kind IN ('donation', 'send', 'usage')`).bind(...itemIds).first();
  const p = await db.prepare(`SELECT COALESCE(SUM(qty), 0) AS qty FROM purchases WHERE item_id IN (${ph})`).bind(...itemIds).first();
  return (row?.qty || 0) + (p?.qty || 0);
}

export async function funds(db) {
  const inRow = await db.prepare(`SELECT COALESCE(SUM(qty), 0) AS v FROM transactions WHERE type = 'cash' AND direction = 'in' AND kind = 'donation'`).first();
  const outRow = await db.prepare(`SELECT COALESCE(SUM(qty), 0) AS v FROM transactions WHERE type = 'cash' AND direction = 'out' AND kind = 'send'`).first();
  const spent = await db.prepare('SELECT COALESCE(SUM(cost), 0) AS v FROM purchases').first();
  return { cash_in: inRow.v, cash_out: outRow.v, spent: spent.v, balance: inRow.v - outRow.v - spent.v };
}

// Per-banker cash on hand and item stock. Unlike pool stock()/funds(), this counts ALL kinds
// (donation, send, transfer) because a transfer moves goods between bankers and must show where
// they physically sit. Includes inactive bankers so nothing they still hold is hidden.
export async function bankerHoldings(db) {
  const bankers = await getBankers(db, false);
  const cashRows = (await db.prepare(`
    SELECT banker_id,
      COALESCE(SUM(CASE WHEN direction = 'in' THEN qty ELSE 0 END), 0) AS cin,
      COALESCE(SUM(CASE WHEN direction = 'out' THEN qty ELSE 0 END), 0) AS cout
    FROM transactions WHERE type = 'cash' GROUP BY banker_id`).all()).results;
  const spendRows = (await db.prepare(`SELECT banker_id, COALESCE(SUM(cost), 0) AS cost FROM purchases GROUP BY banker_id`).all()).results;
  const itemRows = (await db.prepare(`
    SELECT t.banker_id, t.item_id, i.name, i.market_value,
      SUM(CASE WHEN t.direction = 'in' THEN t.qty ELSE -t.qty END) AS net
    FROM transactions t JOIN items i ON i.item_id = t.item_id
    WHERE t.type = 'item' GROUP BY t.banker_id, t.item_id`).all()).results;
  const buyRows = (await db.prepare(`
    SELECT p.banker_id, p.item_id, i.name, i.market_value, SUM(p.qty) AS qty
    FROM purchases p JOIN items i ON i.item_id = p.item_id
    GROUP BY p.banker_id, p.item_id`).all()).results;

  const cash = new Map(cashRows.map(r => [r.banker_id, r.cin - r.cout]));
  const spend = new Map(spendRows.map(r => [r.banker_id, r.cost]));
  const itemsByBanker = new Map();
  const addItem = (bankerId, itemId, name, mv, qty) => {
    let m = itemsByBanker.get(bankerId);
    if (!m) { m = new Map(); itemsByBanker.set(bankerId, m); }
    const cur = m.get(itemId) || { item_id: itemId, name, market_value: mv, qty: 0 };
    cur.qty += qty;
    m.set(itemId, cur);
  };
  for (const r of itemRows) addItem(r.banker_id, r.item_id, r.name, r.market_value, r.net);
  for (const r of buyRows) addItem(r.banker_id, r.item_id, r.name, r.market_value, r.qty);

  return bankers.map(b => {
    const items = [...(itemsByBanker.get(b.torn_id)?.values() || [])]
      .filter(it => it.qty !== 0)
      .map(it => ({ item_id: it.item_id, name: it.name, qty: it.qty, value: it.qty * it.market_value }))
      .sort((a, b) => b.value - a.value);
    const stock_value = items.reduce((s, it) => s + it.value, 0);
    const on_hand = (cash.get(b.torn_id) || 0) - (spend.get(b.torn_id) || 0);
    return { torn_id: b.torn_id, name: b.name, active: b.active, last_poll_ts: b.last_poll_ts, cash: on_hand, stock_value, items };
  }).sort((a, b) => (b.active - a.active) || (b.cash - a.cash));
}

// Pool stock grouped into the hardcoded item categories, with a low/high flag per category and per item.
export async function categoryStock(db) {
  const stockRows = await stock(db);
  const byId = new Map(stockRows.map(r => [r.item_id, r]));
  const allIds = [...new Set(CATEGORY_KEYS.flatMap(k => ITEM_CATEGORIES[k]))];
  const ph = allIds.map(() => '?').join(',');
  const info = new Map();
  if (allIds.length) {
    for (const r of (await db.prepare(`SELECT item_id, name, market_value FROM items WHERE item_id IN (${ph})`).bind(...allIds).all()).results) {
      info.set(r.item_id, r);
    }
  }
  return CATEGORY_KEYS.map(key => {
    const items = ITEM_CATEGORIES[key].map(id => {
      const s = byId.get(id);
      const meta = info.get(id) || {};
      const qty = s?.qty || 0;
      const mv = s?.market_value ?? meta.market_value ?? 0;
      return { item_id: id, name: s?.name || meta.name || `item ${id}`, qty, value: qty * mv, low: qty < LOW_STOCK };
    }).sort((a, b) => b.qty - a.qty);
    const total_qty = items.reduce((s, it) => s + it.qty, 0);
    const total_value = items.reduce((s, it) => s + it.value, 0);
    return { category: key, label: CATEGORY_LABELS[key] || key, mode: CATEGORY_MODE[key] || '', total_qty, total_value, low: total_qty < LOW_STOCK, items };
  });
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

// Total a single member has donated in (cash + item market value), for the banker
// card so a request from a generous member is not declined out of hand.
export async function donatedBy(db, tornId) {
  const row = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'cash' THEN qty ELSE value_at_time END), 0) AS total_value,
      COALESCE(SUM(CASE WHEN type = 'item' THEN qty ELSE 0 END), 0) AS item_qty,
      COALESCE(SUM(CASE WHEN type = 'cash' THEN qty ELSE 0 END), 0) AS cash
    FROM transactions WHERE kind = 'donation' AND direction = 'in' AND counterparty_id = ?`).bind(tornId).first();
  return row || { total_value: 0, item_qty: 0, cash: 0 };
}

export async function memberTotals(db) {
  return (await db.prepare(`
    SELECT t.counterparty_id, t.counterparty_name, i.name AS item, SUM(t.qty) AS qty, SUM(t.value_at_time) AS value
    FROM transactions t LEFT JOIN items i ON i.item_id = t.item_id
    WHERE t.kind = 'send' AND t.direction = 'out'
    GROUP BY t.counterparty_id, t.item_id ORDER BY t.counterparty_name, i.name`).all()).results;
}

export async function ledger(db, { bankerId, days, limit = 200 } = {}) {
  const where = ["NOT (t.kind = 'transfer' AND t.direction = 'in')"];
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

// Support-team availability. Each row is one person's weekly pattern in TCT:
// `slots` is a 168-char '0'/'1' string, day-major (day 0 = Sun), hour 0..23.
export async function getAvailability(db) {
  return (await db.prepare('SELECT id, name, timezone, slots, updated_at FROM availability ORDER BY name COLLATE NOCASE').all()).results;
}

export async function saveAvailability(db, { id, name, timezone, slots }) {
  if (id) {
    await db.prepare('UPDATE availability SET name = ?, timezone = ?, slots = ?, updated_at = ? WHERE id = ?')
      .bind(name, timezone, slots, now(), id).run();
    return id;
  }
  const r = await db.prepare('INSERT INTO availability (name, timezone, slots, updated_at) VALUES (?, ?, ?, ?)')
    .bind(name, timezone, slots, now()).run();
  return r.meta.last_row_id;
}

export async function deleteAvailability(db, id) {
  await db.prepare('DELETE FROM availability WHERE id = ?').bind(id).run();
}

// --- Elimination competition -------------------------------------------------
const ELIM_RETAIN = 7 * 86400; // keep a week of snapshots; enough for the charts

// Store one row per team for this tick, then prune snapshots older than a week.
export async function recordElimination(db, ts, teams) {
  if (!teams.length) return 0;
  const stmt = db.prepare(`INSERT OR REPLACE INTO elimination_snapshots
    (ts, team_id, name, position, score, lives, wins, losses, participants, eliminated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  await db.batch(teams.map(t => stmt.bind(
    ts, t.id, t.name, t.position, t.score, t.lives, t.wins, t.losses, t.participants, t.eliminated ? 1 : 0)));
  await db.prepare('DELETE FROM elimination_snapshots WHERE ts < ?').bind(ts - ELIM_RETAIN).run();
  return teams.length;
}

// Most recent stored row per team (the live standings).
export async function latestElimination(db) {
  const { results } = await db.prepare(`
    SELECT s.* FROM elimination_snapshots s
    JOIN (SELECT team_id, MAX(ts) AS mt FROM elimination_snapshots GROUP BY team_id) m
      ON m.team_id = s.team_id AND m.mt = s.ts
    ORDER BY s.score DESC`).all();
  return results;
}

// Score/lives history over a window, grouped per team, for the moving charts.
export async function eliminationHistory(db, sinceTs) {
  const { results } = await db.prepare(`
    SELECT ts, team_id, name, score, lives, wins, losses FROM elimination_snapshots
    WHERE ts >= ? ORDER BY ts ASC`).bind(sinceTs).all();
  const series = {};
  for (const r of results) {
    (series[r.team_id] ||= { id: r.team_id, name: r.name, points: [] })
      .points.push([r.ts, r.score, r.lives, r.wins, r.losses]);
    series[r.team_id].name = r.name;
  }
  return series;
}

export async function playerHistory(db, tornId) {
  const tx = (await db.prepare(`
    SELECT t.*, i.name AS item_name, b.name AS banker_name FROM transactions t
    LEFT JOIN items i ON i.item_id = t.item_id LEFT JOIN bankers b ON b.torn_id = t.banker_id
    WHERE t.counterparty_id = ? OR t.banker_id = ? ORDER BY t.timestamp DESC LIMIT 300`).bind(tornId, tornId).all()).results;
  const requests = (await db.prepare(`
    SELECT r.*, i.name AS item_name, b.name AS banker_name FROM requests r
    LEFT JOIN items i ON i.item_id = r.item_id LEFT JOIN bankers b ON b.torn_id = r.banker_id
    WHERE r.torn_id = ? ORDER BY r.created_at DESC LIMIT 100`).bind(tornId).all()).results;
  return { tx, requests };
}

// Recent requests for the banker card. For fulfilled requests, both the item and
// qty reflect what the member actually received (from the linked transaction), not
// what they asked for, since a banker may send a different item or quantity. Falls
// back to the requested item/qty when there is no linked send (e.g. a request
// fulfilled without a match, or a category request never matched to a send).
export async function recentRequestsFor(db, tornId, excludeId, limit = 5) {
  return (await db.prepare(`
    SELECT r.id, r.status, r.category,
      CASE WHEN r.status = 'fulfilled'
        THEN COALESCE((SELECT ti.name FROM transactions t LEFT JOIN items ti ON ti.item_id = t.item_id
          WHERE t.request_id = r.id AND ti.name IS NOT NULL ORDER BY t.qty DESC LIMIT 1), i.name)
        ELSE i.name END AS item_name,
      CASE WHEN r.status = 'fulfilled'
        THEN COALESCE((SELECT SUM(t.qty) FROM transactions t WHERE t.request_id = r.id), r.qty)
        ELSE r.qty END AS qty
    FROM requests r LEFT JOIN items i ON i.item_id = r.item_id
    WHERE r.torn_id = ? AND r.id != ? ORDER BY r.created_at DESC LIMIT ?`).bind(tornId, excludeId, limit).all()).results;
}

export async function itemHistory(db, itemId) {
  const tx = (await db.prepare(`
    SELECT t.*, i.name AS item_name, b.name AS banker_name FROM transactions t
    LEFT JOIN items i ON i.item_id = t.item_id LEFT JOIN bankers b ON b.torn_id = t.banker_id
    WHERE t.item_id = ? AND NOT (t.kind = 'transfer' AND t.direction = 'in') ORDER BY t.timestamp DESC LIMIT 300`).bind(itemId).all()).results;
  const purchases = (await db.prepare(`
    SELECT p.*, b.name AS banker_name FROM purchases p LEFT JOIN bankers b ON b.torn_id = p.banker_id
    WHERE p.item_id = ? ORDER BY p.timestamp DESC LIMIT 100`).bind(itemId).all()).results;
  const requests = (await db.prepare(`
    SELECT r.*, b.name AS banker_name FROM requests r LEFT JOIN bankers b ON b.torn_id = r.banker_id
    WHERE r.item_id = ? ORDER BY r.created_at DESC LIMIT 100`).bind(itemId).all()).results;
  return { tx, purchases, requests };
}

// Aggregations for the dashboard charts. All grouped in one place so the /insights
// endpoint is a single call. Times are bucketed in UTC, which is Torn City Time.
export async function insights(db, { days = 30 } = {}) {
  const since = now() - days * 86400;

  // Status breakdown across all requests.
  const statusRows = (await db.prepare(
    `SELECT status, COUNT(*) AS n FROM requests GROUP BY status`).all()).results;
  const status = {};
  for (const r of statusRows) status[r.status] = r.n;

  // Most requested, resolved to category. Old rows may lack `category` but have an
  // item_id, so fold those into their category here rather than dropping them.
  const catRows = (await db.prepare(
    `SELECT category, item_id, COUNT(*) AS n FROM requests GROUP BY category, item_id`).all()).results;
  const catCounts = {};
  for (const r of catRows) {
    const key = r.category || categoryOfItem(r.item_id);
    if (!key) continue;
    catCounts[key] = (catCounts[key] || 0) + r.n;
  }
  const most_requested = Object.entries(catCounts)
    .map(([category, n]) => ({ category, label: CATEGORY_LABELS[category] || category, n }))
    .sort((a, b) => b.n - a.n);

  // Busiest time: request count per weekday (0=Sun..6=Sat) x hour (0-23), UTC.
  const heatRows = (await db.prepare(
    `SELECT CAST(strftime('%w', created_at, 'unixepoch') AS INTEGER) AS dow,
            CAST(strftime('%H', created_at, 'unixepoch') AS INTEGER) AS hour,
            COUNT(*) AS n
     FROM requests GROUP BY dow, hour`).all()).results;
  const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of heatRows) if (r.dow != null && r.hour != null) heatmap[r.dow][r.hour] = r.n;

  // Request volume per day over the window, gaps filled with zero.
  const volRows = (await db.prepare(
    `SELECT CAST(strftime('%s', date(created_at, 'unixepoch')) AS INTEGER) AS day, COUNT(*) AS n
     FROM requests WHERE created_at >= ? GROUP BY day ORDER BY day`).bind(since).all()).results;
  const byDay = new Map(volRows.map(r => [r.day, r.n]));
  const startDay = Math.floor(since / 86400) * 86400;
  const todayDay = Math.floor(now() / 86400) * 86400;
  const volume = [];
  for (let d = startDay; d <= todayDay; d += 86400) volume.push({ day: d, n: byDay.get(d) || 0 });

  return { status, most_requested, heatmap, volume, days };
}

export async function requesterSummary(db) {
  return (await db.prepare(`
    SELECT r.torn_id, MAX(r.torn_name) AS torn_name, MAX(r.discord_id) AS discord_id,
      COUNT(*) AS requests,
      SUM(CASE WHEN r.status = 'fulfilled' THEN 1 ELSE 0 END) AS fulfilled,
      SUM(CASE WHEN r.status = 'declined' THEN 1 ELSE 0 END) AS declined,
      MAX(r.created_at) AS last_request,
      (SELECT COALESCE(SUM(t.value_at_time), 0) FROM transactions t WHERE t.counterparty_id = r.torn_id AND t.kind = 'send' AND t.direction = 'out') AS value_received,
      (SELECT COALESCE(SUM(t.value_at_time), 0) FROM transactions t WHERE t.counterparty_id = r.torn_id AND t.kind = 'donation' AND t.direction = 'in') AS value_donated
    FROM requests r WHERE r.torn_id IS NOT NULL GROUP BY r.torn_id`).all()).results;
}
