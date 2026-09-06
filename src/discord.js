import { verifyDiscord, decrypt } from './crypto.js';
import * as db from './db.js';
import * as torn from './torn.js';

const API = 'https://discord.com/api/v10';
const EPHEMERAL = 64;

export async function rest(env, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Discord ${method} ${path} ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

export const post = (env, channelId, body) => rest(env, 'POST', `/channels/${channelId}/messages`, typeof body === 'string' ? { content: body } : body);
export const edit = (env, channelId, messageId, body) => rest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, typeof body === 'string' ? { content: body } : body);
const followup = (env, token, body) => fetch(`${API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const json = (obj) => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
const reply = (content, ephemeral = true) => json({ type: 4, data: { content, flags: ephemeral ? EPHEMERAL : 0 } });
const fmt = (n) => Number(n || 0).toLocaleString('en-GB');
const money = (n) => '$' + fmt(n);
const displayName = (i) => i.member?.nick || i.member?.user?.global_name || i.member?.user?.username || i.user?.username;

function hasRole(interaction, roleId) {
  if (!roleId) return true;
  return (interaction.member?.roles || []).includes(roleId);
}

async function bankerKey(env, cfg) {
  const bankers = await db.getBankers(env.DB);
  if (!bankers.length) return null;
  return decrypt(env.ENCRYPTION_KEY, bankers[0].encrypted_key);
}

export async function handleInteraction(request, env, ctx) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  if (!signature || !timestamp || !(await verifyDiscord(env.DISCORD_PUBLIC_KEY, signature, timestamp, body))) {
    return new Response('bad signature', { status: 401 });
  }
  const interaction = JSON.parse(body);
  if (interaction.type === 1) return json({ type: 1 });
  const cfg = await db.getConfig(env.DB);
  try {
    if (interaction.type === 4) return autocomplete(interaction, env);
    if (interaction.type === 2) return command(interaction, env, cfg, ctx);
    if (interaction.type === 3) return component(interaction, env, cfg, ctx);
    if (interaction.type === 5) return modal(interaction, env, cfg, ctx);
  } catch (e) {
    return reply(`Error: ${e.message}`);
  }
  return reply('Unhandled interaction');
}

function opt(interaction, name) {
  return (interaction.data.options || []).find(o => o.name === name)?.value;
}

async function autocomplete(interaction, env) {
  const focused = (interaction.data.options || []).find(o => o.focused);
  const items = await db.searchItems(env.DB, focused?.value || '');
  return json({ type: 8, data: { choices: items.map(i => ({ name: i.name, value: String(i.item_id) })) } });
}

async function command(interaction, env, cfg, ctx) {
  const name = interaction.data.name;
  const council = hasRole(interaction, cfg.council_role) || hasRole(interaction, cfg.banker_role);
  switch (name) {
    case 'request': return cmdRequest(interaction, env, cfg, ctx);
    case 'mystats': return cmdMyStats(interaction, env);
    case 'stock': if (!council) return reply('Council or banker role required.'); return cmdStock(interaction, env);
    case 'funds': if (!council) return reply('Council or banker role required.'); return cmdFunds(env);
    case 'requests': if (!council) return reply('Council or banker role required.'); return cmdRequests(interaction, env);
    case 'donors': if (!council) return reply('Council or banker role required.'); return cmdDonors(env);
    case 'ledger': if (!council) return reply('Council or banker role required.'); return cmdLedger(interaction, env);
    case 'threshold': if (!council) return reply('Council or banker role required.'); return cmdThreshold(interaction, env);
    case 'decline': if (!council) return reply('Council or banker role required.'); return cmdDecline(interaction, env, cfg, ctx, opt(interaction, 'request_id'), opt(interaction, 'reason') || '');
  }
  return reply('Unknown command');
}

async function resolveItem(env, value) {
  if (/^\d+$/.test(value)) return db.getItem(env.DB, Number(value));
  return db.findItemByName(env.DB, value);
}

async function cmdRequest(interaction, env, cfg, ctx) {
  const itemVal = String(opt(interaction, 'item'));
  const qty = Number(opt(interaction, 'qty'));
  if (!qty || qty < 1) return reply('Quantity must be at least 1.');
  if (!cfg.requests_channel || !cfg.bankers_channel) return reply('Channels not configured.');
  const item = await resolveItem(env, itemVal);
  if (!item) return reply('Unknown item.');

  ctx.waitUntil((async () => {
    const key = await bankerKey(env, cfg);
    const discordId = interaction.member?.user?.id || interaction.user?.id;
    let tornId = null, tornName = displayName(interaction), attacks = null;
    if (key) {
      try { tornId = await torn.fetchTornIdFromDiscord(key, discordId); } catch {}
      if (!tornId) {
        const m = (interaction.member?.nick || '').match(/\[(\d+)\]/);
        if (m) tornId = Number(m[1]);
      }
      if (tornId) {
        try { const b = await torn.fetchBasic(key, tornId); tornName = b.name; } catch {}
        try { attacks = (await torn.fetchCompetition(key, tornId)).attacks ?? null; } catch {}
      }
    }
    const stockQty = await db.stockFor(env.DB, item.item_id);
    const threshold = await env.DB.prepare('SELECT min_attacks FROM item_thresholds WHERE item_id = ?').bind(item.item_id).first();
    const t = db.now();
    const ins = await env.DB.prepare(`INSERT INTO requests (discord_id, torn_id, torn_name, item_id, qty, attacks_at_request, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`).bind(discordId, tornId, tornName, item.item_id, qty, attacks, t, t).run();
    const id = ins.meta.last_row_id;

    const who = tornId ? `${tornName} [${tornId}]` : tornName;
    const lines = [
      `Request #${id}: ${qty} x ${item.name}`,
      `Member: ${who} (<@${discordId}>)`,
      `Stock: ${fmt(stockQty)}`,
      `Elimination attacks: ${attacks === null ? 'unknown' : fmt(attacks)}`,
    ];
    if (threshold && attacks !== null && attacks < threshold.min_attacks) {
      lines.push(`Warning: below threshold of ${fmt(threshold.min_attacks)} attacks for ${item.name}.`);
    }
    if (stockQty < qty) lines.push(`Warning: only ${fmt(stockQty)} in stock.`);
    if (tornId) {
      const prior = await env.DB.prepare(`SELECT COUNT(*) AS n FROM requests WHERE torn_id = ? AND status = 'fulfilled'`).bind(tornId).first();
      const minA = Number(cfg.leech_min_attacks || 0), minR = Number(cfg.leech_min_requests || 0);
      if (attacks !== null && attacks < minA && prior.n >= minR) {
        lines.push(`Flag: ${fmt(prior.n)} fulfilled requests with ${fmt(attacks)} attacks.`);
      }
    }

    const pub = await post(env, cfg.requests_channel, `Request #${id}: ${qty} x ${item.name} for ${who}\nStatus: open`);
    const bank = await post(env, cfg.bankers_channel, {
      content: lines.join('\n'),
      components: [{ type: 1, components: [
        { type: 2, style: 3, label: 'Approve', custom_id: `approve:${id}` },
        { type: 2, style: 4, label: 'Decline', custom_id: `decline:${id}` },
      ] }],
    });
    await env.DB.prepare('UPDATE requests SET public_message_id = ?, banker_message_id = ? WHERE id = ?').bind(pub.id, bank.id, id).run();
    await followup(env, interaction.token, { content: `Request #${id} submitted: ${qty} x ${item.name}.` });
  })().catch(async (e) => {
    console.log('request failed', e.message);
    await followup(env, interaction.token, { content: `Request failed: ${e.message}` });
  }));
  return json({ type: 5, data: { flags: EPHEMERAL } });
}

async function cmdMyStats(interaction, env) {
  const discordId = interaction.member?.user?.id || interaction.user?.id;
  const rows = (await env.DB.prepare(`SELECT r.id, r.qty, r.status, i.name FROM requests r LEFT JOIN items i ON i.item_id = r.item_id WHERE r.discord_id = ? ORDER BY r.created_at DESC LIMIT 20`).bind(discordId).all()).results;
  if (!rows.length) return reply('No requests.');
  return reply(rows.map(r => `#${r.id} ${r.qty} x ${r.name}: ${r.status}`).join('\n'));
}

async function cmdStock(interaction, env) {
  const itemVal = opt(interaction, 'item');
  if (itemVal) {
    const item = await resolveItem(env, String(itemVal));
    if (!item) return reply('Unknown item.');
    return reply(`${item.name}: ${fmt(await db.stockFor(env.DB, item.item_id))}`);
  }
  const rows = await db.stock(env.DB);
  if (!rows.length) return reply('Stock is empty.');
  return reply(rows.map(r => `${r.name}: ${fmt(r.qty)}`).join('\n').slice(0, 1900));
}

async function cmdFunds(env) {
  const f = await db.funds(env.DB);
  return reply(`Cash in: ${money(f.cash_in)}\nCash out: ${money(f.cash_out)}\nSpent on purchases: ${money(f.spent)}\nBalance: ${money(f.balance)}`);
}

async function cmdRequests(interaction, env) {
  const status = opt(interaction, 'status') || 'open';
  const rows = await db.listRequests(env.DB, status === 'all' ? null : status);
  if (!rows.length) return reply(`No ${status} requests.`);
  return reply(rows.map(r => `#${r.id} ${r.qty} x ${r.item_name} for ${r.torn_name}: ${r.status}${r.banker_name ? ` (${r.banker_name})` : ''}`).join('\n').slice(0, 1900));
}

async function cmdDonors(env) {
  const rows = await db.donorTotals(env.DB);
  if (!rows.length) return reply('No donations yet.');
  return reply(rows.map(r => `${r.counterparty_name} [${r.counterparty_id}]: ${money(r.total_value)} (${fmt(r.item_qty)} items, ${money(r.cash)} cash)`).join('\n').slice(0, 1900));
}

async function cmdLedger(interaction, env) {
  const days = Number(opt(interaction, 'days') || 7);
  const rows = await db.ledger(env.DB, { days, limit: 40 });
  if (!rows.length) return reply('No transactions.');
  return reply(rows.map(r => {
    const what = r.type === 'cash' ? money(r.qty) : `${fmt(r.qty)} x ${r.item_name}`;
    const arrow = r.direction === 'in' ? 'from' : 'to';
    return `${new Date(r.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')} ${r.kind} ${what} ${arrow} ${r.counterparty_name} via ${r.banker_name}`;
  }).join('\n').slice(0, 1900));
}

async function cmdThreshold(interaction, env) {
  const item = await resolveItem(env, String(opt(interaction, 'item')));
  if (!item) return reply('Unknown item.');
  const min = Number(opt(interaction, 'min_attacks'));
  if (min <= 0) {
    await env.DB.prepare('DELETE FROM item_thresholds WHERE item_id = ?').bind(item.item_id).run();
    return reply(`Threshold removed for ${item.name}.`);
  }
  await env.DB.prepare('INSERT INTO item_thresholds (item_id, min_attacks) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET min_attacks = excluded.min_attacks').bind(item.item_id, min).run();
  return reply(`${item.name}: ${fmt(min)} attacks required.`);
}

async function component(interaction, env, cfg, ctx) {
  const [action, idStr] = interaction.data.custom_id.split(':');
  const id = Number(idStr);
  if (!hasRole(interaction, cfg.banker_role) && !hasRole(interaction, cfg.council_role)) return reply('Banker role required.');
  const req = await db.getRequest(env.DB, id);
  if (!req) return reply('Request not found.');
  if (req.status !== 'open') return reply(`Request #${id} is already ${req.status}.`);

  if (action === 'decline') {
    return json({ type: 9, data: {
      custom_id: `decline_modal:${id}`,
      title: `Decline request #${id}`,
      components: [{ type: 1, components: [{ type: 4, custom_id: 'reason', label: 'Reason', style: 2, required: false, max_length: 200 }] }],
    } });
  }

  if (action === 'approve') {
    const bankerName = displayName(interaction);
    const banker = await matchBanker(env, interaction);
    await env.DB.prepare(`UPDATE requests SET status = 'approved', banker_id = ?, updated_at = ? WHERE id = ? AND status = 'open'`).bind(banker?.torn_id || null, db.now(), id).run();
    ctx.waitUntil((async () => {
      await edit(env, cfg.requests_channel, req.public_message_id, `Request #${id}: ${req.qty} x ${req.item_name} for ${req.torn_name}\nStatus: pending, approved by ${bankerName}`);
      await post(env, cfg.requests_channel, `<@${req.discord_id}> request #${id} approved by ${bankerName}, pending send.`);
    })());
    return json({ type: 7, data: { content: `${interaction.message.content}\n\nApproved by ${bankerName}. Send ${req.qty} x ${req.item_name} to ${req.torn_name}${req.torn_id ? ` [${req.torn_id}]` : ''} with "${cfg.keyword}" in the message.`, components: [] } });
  }
  return reply('Unknown action.');
}

async function matchBanker(env, interaction) {
  const nick = interaction.member?.nick || '';
  const m = nick.match(/\[(\d+)\]/);
  if (!m) return null;
  return env.DB.prepare('SELECT torn_id, name FROM bankers WHERE torn_id = ?').bind(Number(m[1])).first();
}

async function modal(interaction, env, cfg, ctx) {
  const [action, idStr] = interaction.data.custom_id.split(':');
  if (action !== 'decline_modal') return reply('Unknown modal.');
  const reason = interaction.data.components?.[0]?.components?.[0]?.value || '';
  return cmdDecline(interaction, env, cfg, ctx, Number(idStr), reason, true);
}

async function cmdDecline(interaction, env, cfg, ctx, id, reason, fromModal = false) {
  const req = await db.getRequest(env.DB, id);
  if (!req) return reply('Request not found.');
  if (['fulfilled', 'declined'].includes(req.status)) return reply(`Request #${id} is already ${req.status}.`);
  const who = displayName(interaction);
  await env.DB.prepare(`UPDATE requests SET status = 'declined', decline_reason = ?, updated_at = ? WHERE id = ?`).bind(reason, db.now(), id).run();
  const suffix = reason ? ` Reason: ${reason}` : '';
  ctx.waitUntil((async () => {
    if (req.public_message_id) await edit(env, cfg.requests_channel, req.public_message_id, `Request #${id}: ${req.qty} x ${req.item_name} for ${req.torn_name}\nStatus: declined by ${who}.${suffix}`);
    await post(env, cfg.requests_channel, `<@${req.discord_id}> request #${id} declined by ${who}.${suffix}`);
    if (req.banker_message_id) await edit(env, cfg.bankers_channel, req.banker_message_id, { content: `Request #${id}: ${req.qty} x ${req.item_name} for ${req.torn_name}\nDeclined by ${who}.${suffix}`, components: [] });
  })());
  if (fromModal) return json({ type: 4, data: { content: `Request #${id} declined.`, flags: EPHEMERAL } });
  return reply(`Request #${id} declined.`);
}
