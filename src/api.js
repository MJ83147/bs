import { hmac, encrypt, decrypt } from './crypto.js';
import * as db from './db.js';
import * as torn from './torn.js';
import { post, repostRequest, declineRequest } from './discord.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const fmt = (n) => Number(n || 0).toLocaleString('en-GB');
const money = (n) => '$' + fmt(n);

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

// The coverage page uses its own shared code and cookie, separate from the banker
// site login. The cookie is HMAC-signed like bs_session but namespaced so the two
// gates never overlap.
async function makeCoverageSession(env) {
  const exp = db.now() + 30 * 86400;
  return `${exp}.${await hmac(env.SESSION_SECRET, 'coverage:' + exp)}`;
}

async function coverageAuthed(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)bs_coverage=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < db.now()) return false;
  return sig === await hmac(env.SESSION_SECRET, 'coverage:' + exp);
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

  // --- Support-team coverage page. Public URL, gated by its own shared code
  // (COVERAGE_CODE), NOT the banker site login. Handled before the isAuthed gate.
  if (path === '/coverage/login' && method === 'POST') {
    const { code } = await request.json().catch(() => ({}));
    if (!env.COVERAGE_CODE || code !== env.COVERAGE_CODE) return json({ ok: false }, 401);
    const token = await makeCoverageSession(env);
    return new Response(JSON.stringify({ ok: true }), { headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `bs_coverage=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 86400}`,
    } });
  }
  if (path.startsWith('/coverage/')) {
    if (!(await coverageAuthed(request, env))) return json({ error: 'unauthorised' }, 401);
    if (path === '/coverage/data' && method === 'GET') {
      return json(await db.getAvailability(env.DB));
    }
    if (path === '/coverage/save' && method === 'POST') {
      const { id, name, timezone = '', slots } = await request.json().catch(() => ({}));
      if (!name || !String(name).trim()) return json({ error: 'name required' }, 400);
      if (typeof slots !== 'string' || !/^[01]{168}$/.test(slots)) return json({ error: 'slots must be 168 chars of 0/1' }, 400);
      const savedId = await db.saveAvailability(env.DB, { id: id ? Number(id) : null, name: String(name).trim().slice(0, 60), timezone: String(timezone).slice(0, 60), slots });
      return json({ ok: true, id: savedId });
    }
    const covDel = path.match(/^\/coverage\/(\d+)$/);
    if (covDel && method === 'DELETE') {
      await db.deleteAvailability(env.DB, Number(covDel[1]));
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
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
  if (path === '/holdings') {
    return json(await db.bankerHoldings(env.DB));
  }
  if (path === '/categories') {
    return json({ low_stock: db.LOW_STOCK, categories: await db.categoryStock(env.DB) });
  }
  if (path === '/ledger') {
    return json(await db.ledger(env.DB, { bankerId: url.searchParams.get('banker') ? Number(url.searchParams.get('banker')) : null, days: url.searchParams.get('days') ? Number(url.searchParams.get('days')) : null, limit: 500 }));
  }
  if (path === '/requests' && method === 'GET') {
    return json(await db.listRequests(env.DB, url.searchParams.get('status') || null));
  }
  const resendMatch = path.match(/^\/requests\/(\d+)\/resend$/);
  if (resendMatch && method === 'POST') {
    const id = Number(resendMatch[1]);
    const req = await db.getRequest(env.DB, id);
    if (!req) return json({ error: 'not found' }, 404);
    if (req.status !== 'open') return json({ error: `request is ${req.status}` }, 400);
    try { await repostRequest(env, cfg, req); }
    catch (e) { return json({ error: e.message }, 400); }
    return json({ ok: true });
  }
  const reqAction = path.match(/^\/requests\/(\d+)\/(decline|cancel)$/);
  if (reqAction && method === 'POST') {
    const id = Number(reqAction[1]);
    const { reason = '' } = await request.json().catch(() => ({}));
    const { error } = await declineRequest(env, cfg, ctx, id, reason, 'Council site');
    if (error) return json({ error }, 400);
    return json({ ok: true });
  }
  if (path === '/insights') {
    const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
    return json(await db.insights(env.DB, { days }));
  }
  if (path === '/funds') return json(await db.funds(env.DB));
  if (path === '/totals') {
    return json({ donors: await db.donorTotals(env.DB), members: await db.memberTotals(env.DB) });
  }
  if (path === '/team-status') {
    // The roster snapshot is shipped as a static asset but kept behind this login
    // gate: we read it through the ASSETS binding here rather than serving it
    // publicly, and slim each row to only the fields the table needs.
    const res = await env.ASSETS.fetch(new URL('/team-status.jsonl', request.url).toString());
    if (!res.ok) return json({ error: 'roster unavailable' }, 404);
    const text = await res.text();
    const rows = [];
    let fetched_at = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const i9 = d.icon9 || '';
      let faction = '';
      if (i9.startsWith('Faction - ')) {
        const rest = i9.slice('Faction - '.length);
        const i = rest.indexOf(' of ');
        faction = i >= 0 ? rest.slice(i + 4) : rest;
      }
      if (d.fetched_at > fetched_at) fetched_at = d.fetched_at;
      rows.push({
        id: d.player_id, name: d.name, level: d.level, faction,
        attacks: d.competition_attacks, score: d.competition_score,
        status: d.status_state, color: d.status_color,
        act: d.last_action_status, rel: d.last_action_relative,
        act_ts: d.last_action_timestamp, networth: d.networth,
      });
    }
    return json({ rows, fetched_at });
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

  if (path === '/contribute' && method === 'POST') {
    const { banker_id, item_id, qty, cash } = await request.json();
    const banker = await env.DB.prepare('SELECT torn_id, name FROM bankers WHERE torn_id = ?').bind(Number(banker_id)).first();
    if (!banker) return json({ error: 'banker not found' }, 400);
    const t = db.now();
    const ins = env.DB.prepare(`INSERT INTO transactions (log_id, banker_id, direction, type, item_id, qty, value_at_time, counterparty_id, counterparty_name, message, timestamp, kind)
      VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, 'contribution', ?, 'donation')`);
    const recorded = [];
    if (item_id && Number(qty) > 0) {
      const item = await db.getItem(env.DB, Number(item_id));
      if (!item) return json({ error: 'item not found' }, 400);
      const value = (item.market_value || 0) * Number(qty);
      await ins.bind(`contrib:${crypto.randomUUID()}`, banker.torn_id, 'item', item.item_id, Number(qty), value, banker.torn_id, banker.name, t).run();
      recorded.push(`${fmt(Number(qty))} x ${item.name}`);
    }
    if (Number(cash) > 0) {
      await ins.bind(`contrib:${crypto.randomUUID()}`, banker.torn_id, 'cash', null, Number(cash), Number(cash), banker.torn_id, banker.name, t).run();
      recorded.push(money(Number(cash)));
    }
    if (!recorded.length) return json({ error: 'give an item and qty, or a cash amount' }, 400);
    ctx.waitUntil((async () => {
      if (cfg.log_channel) { try { await post(env, cfg.log_channel, `Contribution: ${recorded.join(' and ')} from ${banker.name} [${banker.torn_id}]`); } catch (e) { console.log(e.message); } }
    })());
    return json({ ok: true, balance: (await db.funds(env.DB)).balance });
  }

  if (path === '/usage' && method === 'POST') {
    const { banker_id, item_id, qty } = await request.json();
    const banker = await env.DB.prepare('SELECT torn_id, name FROM bankers WHERE torn_id = ?').bind(Number(banker_id)).first();
    if (!banker) return json({ error: 'banker not found' }, 400);
    if (!item_id || Number(qty) < 1) return json({ error: 'pick an item and quantity' }, 400);
    const item = await db.getItem(env.DB, Number(item_id));
    if (!item) return json({ error: 'item not found' }, 400);
    const value = (item.market_value || 0) * Number(qty);
    await env.DB.prepare(`INSERT INTO transactions (log_id, banker_id, direction, type, item_id, qty, value_at_time, counterparty_id, counterparty_name, message, timestamp, kind)
      VALUES (?, ?, 'out', 'item', ?, ?, ?, ?, ?, 'usage', ?, 'usage')`)
      .bind(`usage:${crypto.randomUUID()}`, banker.torn_id, item.item_id, Number(qty), value, banker.torn_id, banker.name, db.now()).run();
    ctx.waitUntil((async () => {
      if (cfg.log_channel) { try { await post(env, cfg.log_channel, `Usage: ${fmt(Number(qty))} x ${item.name} used by ${banker.name} [${banker.torn_id}]`); } catch (e) { console.log(e.message); } }
    })());
    return json({ ok: true, stock: await db.stockFor(env.DB, item.item_id) });
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

  if (path === '/suggest') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return json([]);
    const like = `%${q}%`;
    const [players, bankers, items] = await Promise.all([
      env.DB.prepare(`SELECT torn_id AS id, name, 'player' AS kind FROM players WHERE name LIKE ? ORDER BY name LIMIT 8`).bind(like).all(),
      env.DB.prepare(`SELECT torn_id AS id, name, 'banker' AS kind FROM bankers WHERE active = 1 AND name LIKE ? ORDER BY name LIMIT 5`).bind(like).all(),
      env.DB.prepare(`SELECT item_id AS id, name, 'item' AS kind FROM items WHERE name LIKE ? ORDER BY name LIMIT 8`).bind(like).all(),
    ]);
    const seen = new Set();
    const out = [];
    for (const r of [...players.results, ...bankers.results, ...items.results]) {
      const dedupe = `${r.kind}:${r.name.toLowerCase()}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(r);
    }
    return json(out);
  }

  if (path === '/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return json({ error: 'empty' }, 400);
    if (/^\d+$/.test(q)) {
      const tornId = Number(q);
      const name = (await env.DB.prepare('SELECT name FROM players WHERE torn_id = ?').bind(tornId).first())?.name
        || (await env.DB.prepare('SELECT name FROM bankers WHERE torn_id = ?').bind(tornId).first())?.name
        || null;
      return json({ type: 'player', torn_id: tornId, name, ...(await db.playerHistory(env.DB, tornId)) });
    }
    const item = await db.findItemByName(env.DB, q) || (await db.searchItems(env.DB, q, 1))[0];
    if (item) {
      const full = await db.getItem(env.DB, item.item_id);
      return json({ type: 'item', item: full, ...(await db.itemHistory(env.DB, item.item_id)) });
    }
    const like = `%${q}%`;
    const player = await env.DB.prepare('SELECT torn_id, name FROM players WHERE lower(name) = lower(?)').bind(q).first()
      || await env.DB.prepare('SELECT torn_id, name FROM bankers WHERE lower(name) = lower(?)').bind(q).first()
      || await env.DB.prepare('SELECT torn_id, name FROM players WHERE name LIKE ? ORDER BY name LIMIT 1').bind(like).first()
      || await env.DB.prepare('SELECT torn_id, name FROM bankers WHERE active = 1 AND name LIKE ? ORDER BY name LIMIT 1').bind(like).first();
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
      const reasons = [];
      if (attacks === null) reasons.push('Attack count could not be read');
      else reasons.push(`Only ${fmt(attacks)} attacks (min ${fmt(minAttacks)})`);
      if (r.fulfilled >= minRequests && minRequests > 0) reasons.push(`${fmt(r.fulfilled)} requests fulfilled`);
      if (r.value_received > 0 && r.value_donated === 0) reasons.push('Received but never donated');
      else if (r.value_donated > 0 && r.value_received > r.value_donated * 3) reasons.push(`Received ${money(r.value_received)} vs ${money(r.value_donated)} donated`);
      out.push({ ...r, attacks, score, reasons, value_per_attack: attacks ? Math.round(r.value_received / attacks) : null });
    }
    out.sort((a, b) => (b.value_received - a.value_received));
    return json({ min_attacks: minAttacks, min_requests: minRequests, flagged: out });
  }

  return json({ error: 'not found' }, 404);
}
