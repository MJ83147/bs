import { hmac, encrypt, decrypt } from './crypto.js';
import * as db from './db.js';
import * as torn from './torn.js';
import { post } from './discord.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const fmt = (n) => Number(n || 0).toLocaleString('en-GB');

async function makeSession(env) {
  const exp = db.now() + 7 * 86400;
  return `${exp}.${await hmac(env.SESSION_SECRET, String(exp))}`;
}

export async function isAuthed(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)bs_session=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < db.now()) return false;
  return sig === await hmac(env.SESSION_SECRET, exp);
}

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;

  if (path === '/login' && method === 'POST') {
    const { password } = await request.json();
    if (password !== env.SITE_PASSWORD) return json({ ok: false }, 401);
    const token = await makeSession(env);
    return new Response(JSON.stringify({ ok: true }), { headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `bs_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${7 * 86400}`,
    } });
  }
  if (path === '/logout') {
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'bs_session=; Path=/; Max-Age=0' } });
  }
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorised' }, 401);

  const cfg = await db.getConfig(env.DB);

  if (path === '/dashboard') {
    const [stock, funds, open, approved] = await Promise.all([
      db.stock(env.DB), db.funds(env.DB),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM requests WHERE status = 'open'`).first(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM requests WHERE status = 'approved'`).first(),
    ]);
    return json({ stock, funds, open: open.n, approved: approved.n });
  }
  if (path === '/ledger') {
    return json(await db.ledger(env.DB, { bankerId: url.searchParams.get('banker') ? Number(url.searchParams.get('banker')) : null, days: url.searchParams.get('days') ? Number(url.searchParams.get('days')) : null, limit: 500 }));
  }
  if (path === '/requests' && method === 'GET') {
    return json(await db.listRequests(env.DB, url.searchParams.get('status') || null));
  }
  const reqAction = path.match(/^\/requests\/(\d+)\/(decline|cancel)$/);
  if (reqAction && method === 'POST') {
    const id = Number(reqAction[1]);
    const { reason = '' } = await request.json().catch(() => ({}));
    const req = await db.getRequest(env.DB, id);
    if (!req) return json({ error: 'not found' }, 404);
    if (['fulfilled', 'declined'].includes(req.status)) return json({ error: `already ${req.status}` }, 400);
    await env.DB.prepare(`UPDATE requests SET status = 'declined', decline_reason = ?, updated_at = ? WHERE id = ?`).bind(reason, db.now(), id).run();
    ctx.waitUntil((async () => {
      const suffix = reason ? ` Reason: ${reason}` : '';
      if (cfg.requests_channel) await post(env, cfg.requests_channel, `<@${req.discord_id}> request #${id} declined via council site.${suffix}`);
    })());
    return json({ ok: true });
  }
  if (path === '/funds') return json(await db.funds(env.DB));
  if (path === '/totals') {
    return json({ donors: await db.donorTotals(env.DB), members: await db.memberTotals(env.DB) });
  }

  if (path === '/bankers' && method === 'GET') {
    const rows = await db.getBankers(env.DB, false);
    return json(rows.map(b => ({ torn_id: b.torn_id, name: b.name, active: b.active, added_at: b.added_at, last_poll_ts: b.last_poll_ts })));
  }
  if (path === '/bankers' && method === 'POST') {
    const { key } = await request.json();
    if (!key) return json({ error: 'key required' }, 400);
    let who;
    try { who = await torn.validateKey(key); } catch (e) { return json({ error: e.message }, 400); }
    const enc = await encrypt(env.ENCRYPTION_KEY, key);
    await env.DB.prepare(`INSERT INTO bankers (torn_id, name, encrypted_key, added_at, active, last_poll_ts) VALUES (?, ?, ?, ?, 1, 0)
      ON CONFLICT(torn_id) DO UPDATE SET name = excluded.name, encrypted_key = excluded.encrypted_key, active = 1`).bind(who.id, who.name, enc, db.now()).run();
    return json({ ok: true, torn_id: who.id, name: who.name });
  }
  const bankerDel = path.match(/^\/bankers\/(\d+)$/);
  if (bankerDel && method === 'DELETE') {
    await env.DB.prepare('UPDATE bankers SET active = 0 WHERE torn_id = ?').bind(Number(bankerDel[1])).run();
    return json({ ok: true });
  }

  if (path === '/thresholds' && method === 'GET') {
    return json((await env.DB.prepare('SELECT t.item_id, t.min_attacks, i.name FROM item_thresholds t LEFT JOIN items i ON i.item_id = t.item_id ORDER BY i.name').all()).results);
  }
  if (path === '/thresholds' && method === 'POST') {
    const { item_id, min_attacks } = await request.json();
    if (!item_id) return json({ error: 'item_id required' }, 400);
    if (!min_attacks || min_attacks <= 0) await env.DB.prepare('DELETE FROM item_thresholds WHERE item_id = ?').bind(item_id).run();
    else await env.DB.prepare('INSERT INTO item_thresholds (item_id, min_attacks) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET min_attacks = excluded.min_attacks').bind(item_id, min_attacks).run();
    return json({ ok: true });
  }
  if (path === '/items') {
    return json(await db.searchItems(env.DB, url.searchParams.get('q') || '', 50));
  }

  if (path === '/settings' && method === 'GET') return json(cfg);
  if (path === '/settings' && method === 'POST') {
    const body = await request.json();
    for (const [k, v] of Object.entries(body)) {
      if (k in cfg) await db.setConfig(env.DB, k, String(v ?? ''));
    }
    return json({ ok: true });
  }

  if (path === '/purchases' && method === 'GET') {
    return json((await env.DB.prepare('SELECT p.*, i.name, b.name AS banker_name FROM purchases p LEFT JOIN items i ON i.item_id = p.item_id LEFT JOIN bankers b ON b.torn_id = p.banker_id ORDER BY p.timestamp DESC LIMIT 200').all()).results);
  }
  if (path === '/purchases/load' && method === 'GET') {
    const bankerId = Number(url.searchParams.get('banker'));
    const banker = await env.DB.prepare('SELECT * FROM bankers WHERE torn_id = ? AND active = 1').bind(bankerId).first();
    if (!banker) return json({ error: 'banker not found' }, 404);
    const market = db.parseTypes(cfg.log_types_market_buy);
    const bazaar = db.parseTypes(cfg.log_types_bazaar_buy);
    if (!market.length && !bazaar.length) return json({ error: 'purchase log types not configured' }, 400);
    const key = await decrypt(env.ENCRYPTION_KEY, banker.encrypted_key);
    const days = Number(url.searchParams.get('days') || 7);
    let logs;
    try { logs = await torn.fetchLogs(key, [...market, ...bazaar], db.now() - days * 86400); } catch (e) { return json({ error: e.message }, 400); }
    const marked = new Set((await env.DB.prepare('SELECT log_id FROM purchases WHERE banker_id = ?').bind(bankerId).all()).results.map(r => r.log_id));
    const out = [];
    for (const entry of logs) {
      if (marked.has(entry.id)) continue;
      const d = entry.data || {};
      const itemId = Number(d.item ?? d.item_id ?? (Array.isArray(d.items) ? d.items[0]?.id : 0));
      const qty = Number(d.quantity ?? d.qty ?? (Array.isArray(d.items) ? d.items[0]?.qty : 1) ?? 1);
      const cost = Number(d.cost_total ?? d.total_cost ?? d.cost ?? d.money ?? ((d.cost_each ?? d.price ?? 0) * qty));
      const item = itemId ? await db.getItem(env.DB, itemId) : null;
      out.push({ log_id: entry.id, timestamp: entry.timestamp, item_id: itemId, name: item?.name || `item ${itemId}`, qty, cost, source: market.includes(Number(entry.log)) ? 'market' : 'bazaar', raw: d });
    }
    return json(out.sort((a, b) => b.timestamp - a.timestamp));
  }
  if (path === '/purchases/mark' && method === 'POST') {
    const { banker_id, purchases } = await request.json();
    const banker = await env.DB.prepare('SELECT name FROM bankers WHERE torn_id = ?').bind(Number(banker_id)).first();
    if (!banker || !Array.isArray(purchases) || !purchases.length) return json({ error: 'bad request' }, 400);
    const t = db.now();
    const stmt = env.DB.prepare('INSERT OR IGNORE INTO purchases (log_id, banker_id, item_id, qty, cost, source, timestamp, marked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    await env.DB.batch(purchases.map(p => stmt.bind(p.log_id, Number(banker_id), p.item_id, p.qty, p.cost, p.source, p.timestamp, t)));
    ctx.waitUntil((async () => {
      if (!cfg.log_channel) return;
      const lines = purchases.map(p => `Purchase: ${fmt(p.qty)} x ${p.name} for $${fmt(p.cost)} (${p.source}) by ${banker.name}`);
      await post(env, cfg.log_channel, lines.join('\n').slice(0, 1900));
    })());
    const f = await db.funds(env.DB);
    return json({ ok: true, balance: f.balance });
  }

  if (path === '/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return json({ error: 'empty' }, 400);
    if (/^\d+$/.test(q)) {
      const tornId = Number(q);
      const name = (await env.DB.prepare('SELECT name FROM players WHERE torn_id = ?').bind(tornId).first())?.name || null;
      return json({ type: 'player', torn_id: tornId, name, ...(await db.playerHistory(env.DB, tornId)) });
    }
    const item = await db.findItemByName(env.DB, q) || (await db.searchItems(env.DB, q, 1))[0];
    if (item) {
      const full = await db.getItem(env.DB, item.item_id);
      return json({ type: 'item', item: full, ...(await db.itemHistory(env.DB, item.item_id)) });
    }
    const player = await env.DB.prepare('SELECT torn_id, name FROM players WHERE lower(name) = lower(?)').bind(q).first();
    if (player) return json({ type: 'player', torn_id: player.torn_id, name: player.name, ...(await db.playerHistory(env.DB, player.torn_id)) });
    return json({ type: 'none' });
  }

  if (path === '/risk') {
    const minAttacks = Number(cfg.leech_min_attacks || 0);
    const minRequests = Number(cfg.leech_min_requests || 0);
    const rows = await db.requesterSummary(env.DB);
    const candidates = rows.filter(r => r.fulfilled >= minRequests);
    const bankers = await db.getBankers(env.DB);
    const key = bankers.length ? await decrypt(env.ENCRYPTION_KEY, bankers[0].encrypted_key) : null;
    const out = [];
    for (const r of candidates.slice(0, 60)) {
      let attacks = null, score = null;
      if (key) { try { const c = await torn.fetchCompetition(key, r.torn_id); attacks = c.attacks ?? null; score = c.score ?? null; } catch {} }
      if (attacks !== null && attacks >= minAttacks) continue;
      out.push({ ...r, attacks, score, value_per_attack: attacks ? Math.round(r.value_received / attacks) : null });
    }
    out.sort((a, b) => (b.value_received - a.value_received));
    return json({ min_attacks: minAttacks, min_requests: minRequests, flagged: out });
  }

  return json({ error: 'not found' }, 404);
}
