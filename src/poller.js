import { decrypt } from './crypto.js';
import * as db from './db.js';
import * as torn from './torn.js';
import { post, edit, COLORS, requestStatusEmbed } from './discord.js';
import { categoryOfItem } from './categories.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-GB');
const money = (n) => '$' + fmt(n);

function parseItems(data) {
  if (Array.isArray(data.items)) return data.items.map(i => ({ id: Number(i.id), qty: Number(i.qty ?? i.quantity ?? 1) }));
  if (data.item) return [{ id: Number(data.item), qty: Number(data.qty ?? data.quantity ?? 1) }];
  return [];
}

function parseCash(data) {
  const v = data.money ?? data.amount ?? data.cash;
  return v === undefined ? null : Number(v);
}

async function playerName(env, key, tornId) {
  const cached = await env.DB.prepare('SELECT name FROM players WHERE torn_id = ?').bind(tornId).first();
  if (cached) return cached.name;
  try {
    const b = await torn.fetchBasic(key, tornId);
    await env.DB.prepare('INSERT OR REPLACE INTO players (torn_id, name, updated_at) VALUES (?, ?, ?)').bind(tornId, b.name, db.now()).run();
    return b.name;
  } catch {
    return String(tornId);
  }
}

async function refreshItems(env, key) {
  const latest = await env.DB.prepare('SELECT MAX(updated_at) AS t FROM items').first();
  if (latest?.t && db.now() - latest.t < 86400) return;
  const items = await torn.fetchItems(key);
  const stmt = env.DB.prepare('INSERT INTO items (item_id, name, market_value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET name = excluded.name, market_value = excluded.market_value, updated_at = excluded.updated_at');
  const t = db.now();
  for (let i = 0; i < items.length; i += 50) {
    await env.DB.batch(items.slice(i, i + 50).map(it => stmt.bind(it.item_id, it.name, it.market_value, t)));
  }
}

export async function poll(env) {
  const cfg = await db.getConfig(env.DB);
  const bankers = await db.getBankers(env.DB);
  if (!bankers.length) return;
  const bankerIds = new Set(bankers.map(b => b.torn_id));
  const keyword = new RegExp(`\\b${cfg.keyword}\\b`, 'i');

  const types = {
    itemSend: db.parseTypes(cfg.log_types_item_send),
    itemReceive: db.parseTypes(cfg.log_types_item_receive),
    cashSend: db.parseTypes(cfg.log_types_cash_send),
    cashReceive: db.parseTypes(cfg.log_types_cash_receive),
  };
  const all = [...types.itemSend, ...types.itemReceive, ...types.cashSend, ...types.cashReceive];
  if (!all.length) return;

  let itemsRefreshed = false;
  for (const banker of bankers) {
    let key;
    try { key = await decrypt(env.ENCRYPTION_KEY, banker.encrypted_key); } catch { continue; }
    if (!itemsRefreshed) { try { await refreshItems(env, key); itemsRefreshed = true; } catch {} }

    const from = banker.last_poll_ts ? banker.last_poll_ts - 120 : banker.added_at;
    let logs;
    try { logs = await torn.fetchLogs(key, all, from); } catch (e) { console.log(`poll ${banker.torn_id}: ${e.message}`); continue; }

    let maxTs = banker.last_poll_ts;
    for (const entry of logs.sort((a, b) => a.timestamp - b.timestamp)) {
      maxTs = Math.max(maxTs, entry.timestamp);
      const data = entry.data || {};
      const message = data.message || '';
      if (!keyword.test(message)) continue;
      const exists = await env.DB.prepare("SELECT 1 FROM transactions WHERE log_id = ? OR log_id LIKE ? || ':%'").bind(entry.id, entry.id).first();
      if (exists) continue;

      const logType = Number(entry.log);
      let direction, type;
      if (types.itemSend.includes(logType)) { direction = 'out'; type = 'item'; }
      else if (types.itemReceive.includes(logType)) { direction = 'in'; type = 'item'; }
      else if (types.cashSend.includes(logType)) { direction = 'out'; type = 'cash'; }
      else if (types.cashReceive.includes(logType)) { direction = 'in'; type = 'cash'; }
      else continue;

      const counterpartyId = Number(direction === 'out' ? data.receiver : data.sender);
      if (!counterpartyId) continue;
      const counterpartyName = await playerName(env, key, counterpartyId);
      const isTransfer = bankerIds.has(counterpartyId);
      const kind = isTransfer ? 'transfer' : (direction === 'in' ? 'donation' : 'send');

      const rows = [];
      if (type === 'cash') {
        const amount = parseCash(data);
        if (amount === null) continue;
        rows.push({ item_id: null, qty: amount, value: amount });
      } else {
        for (const it of parseItems(data)) {
          const item = await db.getItem(env.DB, it.id);
          rows.push({ item_id: it.id, qty: it.qty, value: (item?.market_value || 0) * it.qty, name: item?.name || `item ${it.id}` });
        }
      }

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const logId = rows.length > 1 ? `${entry.id}:${i}` : entry.id;
        let requestId = null;
        if (kind === 'send' && type === 'item') {
          const cat = categoryOfItem(r.item_id);
          const req = await env.DB.prepare(`SELECT id, discord_id, public_message_id, banker_message_id, torn_name FROM requests
            WHERE status = 'approved' AND torn_id = ? AND (banker_id = ? OR banker_id IS NULL)
              AND (item_id = ? OR (item_id IS NULL AND category = ?))
            ORDER BY created_at ASC LIMIT 1`).bind(counterpartyId, banker.torn_id, r.item_id, cat).first();
          if (req) {
            requestId = req.id;
            await env.DB.prepare(`UPDATE requests SET status = 'fulfilled', banker_id = ?, item_id = ?, handled_by = ?, updated_at = ? WHERE id = ?`).bind(banker.torn_id, r.item_id, banker.name, db.now(), req.id).run();
            const done = requestStatusEmbed(req.id, fmt(r.qty), r.name, req.torn_name, `Fulfilled, sent by ${banker.name}`, COLORS.fulfilled);
            try {
              if (req.public_message_id) await edit(env, cfg.requests_channel, req.public_message_id, { content: `<@${req.discord_id}>`, embeds: [done] });
              if (req.banker_message_id) await edit(env, cfg.bankers_channel, req.banker_message_id, { embeds: [done], components: [] });
            } catch (e) { console.log(e.message); }
          }
        }
        await env.DB.prepare(`INSERT OR IGNORE INTO transactions
          (log_id, banker_id, direction, type, item_id, qty, value_at_time, counterparty_id, counterparty_name, message, timestamp, kind, request_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(logId, banker.torn_id, direction, type, r.item_id, r.qty, r.value, counterpartyId, counterpartyName, message, entry.timestamp, kind, requestId).run();

        if (cfg.log_channel) {
          const what = type === 'cash' ? money(r.qty) : `${fmt(r.qty)} x ${r.name}`;
          let box;
          if (kind === 'donation') box = { title: 'Donation', color: COLORS.donation, description: `${what}\nfrom **${counterpartyName}** [${counterpartyId}] to ${banker.name}` };
          else if (kind === 'send') box = { title: 'Sent', color: COLORS.sent, description: `${what}\nfrom ${banker.name} to **${counterpartyName}** [${counterpartyId}]${requestId ? ` (request #${requestId})` : ''}` };
          else if (direction === 'out') box = { title: 'Transfer', color: COLORS.transfer, description: `${what}\nfrom ${banker.name} to **${counterpartyName}**` };
          if (box) { try { await post(env, cfg.log_channel, { embeds: [box] }); } catch (e) { console.log(e.message); } }
        }
      }
    }
    await env.DB.prepare('UPDATE bankers SET last_poll_ts = ? WHERE torn_id = ?').bind(Math.max(maxTs, db.now() - 60), banker.torn_id).run();
  }
}
