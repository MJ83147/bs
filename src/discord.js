import { verifyDiscord, decrypt } from './crypto.js';
import * as db from './db.js';
import * as torn from './torn.js';
import { commands } from './commands.js';
import { CATEGORY_MODE, CATEGORY_LABELS, CATEGORY_KEYS, ENERGY_CATEGORIES, itemsInCategory, categoryOfItem } from './categories.js';

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
const replyEmbed = (embed, ephemeral = true) => json({ type: 4, data: { embeds: [embed], flags: ephemeral ? EPHEMERAL : 0 } });
const fmt = (n) => Number(n || 0).toLocaleString('en-GB');
const money = (n) => '$' + fmt(n);
const displayName = (i) => i.member?.nick || i.member?.user?.global_name || i.member?.user?.username || i.user?.username;
const reqLabel = (r) => r.item_name || CATEGORY_LABELS[r.category] || r.category || 'items';

// Preset quantities for the request flow's quantity dropdown (no free-text box,
// so the flow is all selects with no "Submit" button).
const QTY_PRESETS = [1, 2, 3, 4, 5, 10, 15, 20, 25, 50, 100];
// Edit the current ephemeral message in place (type 7) as the member advances
// through the category -> item -> quantity dropdowns.
const updateMsg = (content, components = []) => json({ type: 7, data: { content, components } });

// Shared embed colours so every "box" reads consistently across the bot.
export const COLORS = {
  open: 0xE0A82E,       // gold, awaiting a banker
  approved: 0x57F287,   // green, approved and pending send
  fulfilled: 0x3BA55D,  // green, sent
  declined: 0xED4245,   // red
  donation: 0x57F287,   // green, cash/items in
  sent: 0x5865F2,       // blurple, items out
  transfer: 0x99AAB5,   // grey, banker-to-banker
  info: 0x5865F2,       // blurple, neutral info
};

// Status line + colour for a request in whatever state it is in.
export function requestStatusEmbed(id, qty, shown, who, status, color) {
  return { title: `Request #${id}`, color, description: `**${qty} x ${shown}**\nfor ${who}`, fields: [{ name: 'Status', value: status, inline: false }] };
}

// Banker card buttons: Approve/Decline plus link buttons out to the member's
// Torn profile and the banker's item inventory (for sending).
function bankerButtons(id, tornId) {
  const buttons = [
    { type: 2, style: 3, label: 'Approve', custom_id: `approve:${id}` },
    { type: 2, style: 4, label: 'Decline', custom_id: `decline:${id}` },
  ];
  if (tornId) buttons.push({ type: 2, style: 5, label: 'Profile', url: `https://www.torn.com/profiles.php?XID=${tornId}` });
  buttons.push({ type: 2, style: 5, label: 'Inventory', url: 'https://www.torn.com/item.php' });
  return [{ type: 1, components: buttons }];
}

function hasRole(interaction, roleId) {
  if (!roleId) return false;
  return (interaction.member?.roles || []).includes(roleId);
}

async function bankerKey(env, cfg) {
  const bankers = await db.getBankers(env.DB);
  if (!bankers.length) return null;
  return decrypt(env.ENCRYPTION_KEY, bankers[0].encrypted_key);
}

// Register slash commands to the configured guild (guild commands update
// instantly) and clear them from every other guild the bot is in, plus clear
// the global set, so commands appear only in the treasury's own server and never
// linger elsewhere or in a client cache. Called by the worker's /register route,
// which uses the bot token already in env.
export async function registerCommands(env) {
  const app = env.DISCORD_APP_ID;
  const target = env.DISCORD_GUILD_ID;
  const guilds = await rest(env, 'GET', '/users/@me/guilds');
  const results = [];
  for (const guild of guilds) {
    const body = guild.id === target ? commands : [];
    const g = await rest(env, 'PUT', `/applications/${app}/guilds/${guild.id}/commands`, body);
    results.push(`${guild.name} (${guild.id}): ${g.length} commands${guild.id === target ? '  <-- registered' : '  (cleared)'}`);
  }
  const cleared = await rest(env, 'PUT', `/applications/${app}/commands`, []);
  return new Response(`OK. Target guild ${target}.\n${results.join('\n')}\nGlobal cleared (now ${cleared.length}). Reload Discord.`);
}

// Read-only: report which guilds the bot is in and what commands are registered
// where, so we can see the real state instead of guessing about client caches.
export async function debugCommands(env) {
  const app = env.DISCORD_APP_ID;
  const guilds = await rest(env, 'GET', '/users/@me/guilds');
  const global = await rest(env, 'GET', `/applications/${app}/commands`);
  const guildCmds = await rest(env, 'GET', `/applications/${app}/guilds/${env.DISCORD_GUILD_ID}/commands`);
  const fmtCmds = (cs) => cs.map(c => `${c.name}[opts:${c.options?.length || 0}]`).join(', ') || '(none)';
  const lines = [
    `APP_ID: ${app}`,
    `Configured GUILD_ID: ${env.DISCORD_GUILD_ID}`,
    ``,
    `Bot is in ${guilds.length} guild(s):`,
    ...guilds.map(g => `  ${g.id}  ${g.name}${g.id === env.DISCORD_GUILD_ID ? '   <-- configured guild' : ''}`),
    ``,
    `GLOBAL commands (${global.length}): ${fmtCmds(global)}`,
    ``,
    `GUILD ${env.DISCORD_GUILD_ID} commands (${guildCmds.length}): ${fmtCmds(guildCmds)}`,
  ];
  return new Response(lines.join('\n'));
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
  const opts = interaction.data.options || [];
  const focused = opts.find(o => o.focused);
  const q = (focused?.value || '').toLowerCase();
  if (interaction.data.name === 'request') {
    const category = opts.find(o => o.name === 'category')?.value;
    const ids = itemsInCategory(category);
    let items = [];
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      items = (await env.DB.prepare(`SELECT item_id, name FROM items WHERE item_id IN (${ph}) ORDER BY name`).bind(...ids).all()).results;
    }
    const choices = items.filter(i => !q || i.name.toLowerCase().includes(q)).slice(0, 25).map(i => ({ name: i.name, value: String(i.item_id) }));
    return json({ type: 8, data: { choices } });
  }
  const items = await db.searchItems(env.DB, focused?.value || '');
  return json({ type: 8, data: { choices: items.map(i => ({ name: i.name, value: String(i.item_id) })) } });
}

async function command(interaction, env, cfg, ctx) {
  const name = interaction.data.name;
  const council = hasRole(interaction, cfg.council_role) || hasRole(interaction, cfg.banker_role);
  switch (name) {
    case 'request': return cmdRequest(interaction, env, cfg, ctx);
    case 'request-item': return cmdRequest(interaction, env, cfg, ctx);
    case 'mystats': return cmdMyStats(interaction, env);
    case 'contribute': return cmdContribute(interaction, env, cfg, ctx);
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

// /request walks the member through dropdowns in one ephemeral message: category
// -> item (only when the category lets you pick one) -> quantity. Each step is a
// select menu that replaces the previous one, so there is no "Submit" button; the
// quantity pick creates the request. single/bucket categories skip the item step.
function cmdRequest(interaction, env, cfg) {
  if (!cfg.requests_channel || !cfg.bankers_channel) return reply('Requests are not set up yet.');
  return json({ type: 4, data: {
    flags: EPHEMERAL,
    content: 'What do you need?',
    components: [{ type: 1, components: [{ type: 3, custom_id: 'req_cat', placeholder: 'Pick a category',
      options: CATEGORY_KEYS.map(k => ({ label: CATEGORY_LABELS[k], value: k })) }] }],
  } });
}

// One or more item dropdowns for a category. A select menu holds at most 25
// options and some categories have more, so split across rows (up to 5) with a
// distinct custom_id per row (Discord requires unique ids within a message).
function itemSelectRows(category, items) {
  const rows = [];
  for (let i = 0; i < items.length && rows.length < 5; i += 25) {
    const chunk = items.slice(i, i + 25);
    rows.push({ type: 1, components: [{ type: 3, custom_id: `req_it:${category}:${rows.length}`,
      placeholder: rows.length === 0 ? 'Pick an item' : 'Pick an item (more)',
      options: chunk.map(it => ({ label: it.name.slice(0, 100), value: String(it.item_id) })) }] });
  }
  return rows;
}

// The quantity dropdown. Carries the chosen category and item id in its custom_id
// so no state is stored between interactions.
function qtyRow(category, itemId) {
  return [{ type: 1, components: [{ type: 3, custom_id: `req_qty:${category}:${itemId}`, placeholder: 'How many?',
    options: QTY_PRESETS.map(n => ({ label: String(n), value: String(n) })) }] }];
}

// Category chosen. specific -> item dropdown; single/bucket -> straight to quantity.
async function requestCategory(interaction, env, cfg) {
  const category = interaction.data.values?.[0];
  const mode = CATEGORY_MODE[category];
  if (!mode) return updateMsg('Unknown category.');
  if (mode !== 'specific') return updateMsg(`How many **${CATEGORY_LABELS[category]}**?`, qtyRow(category, ''));
  const ids = itemsInCategory(category);
  const ph = ids.map(() => '?').join(',');
  const items = (await env.DB.prepare(`SELECT item_id, name FROM items WHERE item_id IN (${ph}) ORDER BY name`).bind(...ids).all()).results;
  if (!items.length) return updateMsg(`No items configured for ${CATEGORY_LABELS[category]} yet.`);
  return updateMsg(`Pick a ${CATEGORY_LABELS[category]} item:`, itemSelectRows(category, items));
}

// Item chosen for a specific category -> quantity dropdown.
async function requestItem(interaction, env, cfg) {
  const category = interaction.data.custom_id.split(':')[1];
  const item = await db.getItem(env.DB, Number(interaction.data.values?.[0]));
  if (!item || categoryOfItem(item.item_id) !== category) return updateMsg(`That item is not in ${CATEGORY_LABELS[category] || 'this category'}.`);
  return updateMsg(`How many **${item.name}**?`, qtyRow(category, item.item_id));
}

// Quantity chosen -> create the request. Resolves the item from mode + custom_id.
async function requestQty(interaction, env, cfg, ctx) {
  const [, category, itemIdStr] = interaction.data.custom_id.split(':');
  const mode = CATEGORY_MODE[category];
  if (!mode) return updateMsg('Unknown category.');
  const qty = Math.max(1, Math.floor(Number(interaction.data.values?.[0]) || 1));
  let item = null;
  if (mode === 'specific') {
    item = await db.getItem(env.DB, Number(itemIdStr));
    if (!item || categoryOfItem(item.item_id) !== category) return updateMsg('That item is no longer valid, try again.');
  } else if (mode === 'single') {
    item = await db.getItem(env.DB, itemsInCategory(category)[0]);
  }
  return submitRequest(interaction, env, cfg, ctx, { category, item, qty });
}

// Core request creation, called from the quantity dropdown. Replaces the dropdown
// message with a working note, does the slow Torn lookups + banker card in the
// background, then edits that same message with the result.
function submitRequest(interaction, env, cfg, ctx, { category, item, qty }) {
  const label = CATEGORY_LABELS[category];

  ctx.waitUntil((async () => {
    const key = await bankerKey(env, cfg);
    const discordId = interaction.member?.user?.id || interaction.user?.id;
    let tornId = null, tornName = displayName(interaction), attacks = null, profile = null;
    if (key) {
      try { tornId = await torn.fetchTornIdFromDiscord(key, discordId); } catch {}
      if (!tornId) {
        const m = (interaction.member?.nick || '').match(/\[(\d+)\]/);
        if (m) tornId = Number(m[1]);
      }
      if (tornId) {
        try { const b = await torn.fetchBasic(key, tornId); tornName = b.name; } catch {}
        try { attacks = (await torn.fetchCompetition(key, tornId)).attacks ?? null; } catch {}
        // Banker keys are scoped and lack the networth selection, so use the owner's
        // full-access key for the profile/net-worth lookup when it is configured.
        try { profile = await torn.fetchProfile(env.OWNER_API_KEY || key, tornId); } catch {}
      }
    }

    // Energy double-dip: no longer auto-declined. Flag it as a card warning when
    // no attacks have been made since the member's last energy request.
    let doubleDip = false;
    if (ENERGY_CATEGORIES.includes(category) && tornId && attacks !== null) {
      const ph = ENERGY_CATEGORIES.map(() => '?').join(',');
      const prior = await env.DB.prepare(
        `SELECT attacks_at_request FROM requests WHERE torn_id = ? AND category IN (${ph}) AND status != 'declined' AND attacks_at_request IS NOT NULL ORDER BY created_at DESC LIMIT 1`
      ).bind(tornId, ...ENERGY_CATEGORIES).first();
      if (prior && attacks <= prior.attacks_at_request) doubleDip = true;
    }

    const itemLabel = item ? item.name : label;
    const stockQty = item ? await db.stockFor(env.DB, item.item_id) : await db.stockForItems(env.DB, itemsInCategory(category));
    const threshold = item ? await env.DB.prepare('SELECT min_attacks FROM item_thresholds WHERE item_id = ?').bind(item.item_id).first() : null;
    const t = db.now();
    const ins = await env.DB.prepare(`INSERT INTO requests (discord_id, torn_id, torn_name, item_id, category, qty, attacks_at_request, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).bind(discordId, tornId, tornName, item?.item_id ?? null, category, qty, attacks, t, t).run();
    const id = ins.meta.last_row_id;

    let totalReqs = 0, fulfilledReqs = 0, history = [];
    if (tornId) {
      const c = await env.DB.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'fulfilled' THEN 1 ELSE 0 END), 0) AS fulfilled FROM requests WHERE torn_id = ?`).bind(tornId).first();
      totalReqs = c?.total || 0; fulfilledReqs = c?.fulfilled || 0;
      history = await db.recentRequestsFor(env.DB, tornId, id);
    }
    const who = tornId ? `${tornName} [${tornId}]` : tornName;
    const shown = item ? item.name : `${label} (any)`;
    const fields = [
      { name: 'Member', value: `${who}\n<@${discordId}>`, inline: true },
      { name: 'Hits (elimination)', value: attacks === null ? 'unknown' : fmt(attacks), inline: true },
      { name: 'Stock', value: fmt(stockQty), inline: true },
    ];
    if (profile) {
      fields.push(
        { name: 'Level', value: profile.level == null ? 'unknown' : fmt(profile.level), inline: true },
        { name: 'Age', value: profile.age == null ? 'unknown' : `${fmt(profile.age)} days`, inline: true },
        { name: 'Net worth', value: profile.networth == null ? 'unknown' : money(profile.networth), inline: true },
      );
    }
    fields.push({ name: 'Requests', value: `${fmt(totalReqs)} total, ${fmt(fulfilledReqs)} fulfilled`, inline: false });
    if (history.length) fields.push({ name: 'Recent requests', value: history.map(h => `\`#${h.id}\` ${fmt(h.qty)} x ${reqLabel(h)} — ${h.status}`).join('\n').slice(0, 1024), inline: false });
    const warnings = [];
    if (threshold && attacks !== null && attacks < threshold.min_attacks) {
      warnings.push(`Below threshold of ${fmt(threshold.min_attacks)} attacks for ${item.name}.`);
    }
    if (stockQty < qty) warnings.push(`Only ${fmt(stockQty)} in stock.`);
    if (doubleDip) warnings.push(`No attacks made since their last energy request (possible double-dip).`);
    if (tornId) {
      const minA = Number(cfg.leech_min_attacks || 0), minR = Number(cfg.leech_min_requests || 0);
      if (attacks !== null && attacks < minA && fulfilledReqs >= minR) {
        warnings.push(`${fmt(fulfilledReqs)} fulfilled requests with only ${fmt(attacks)} attacks.`);
      }
    }
    if (warnings.length) fields.push({ name: '⚠️ Warnings', value: warnings.map(w => `• ${w}`).join('\n'), inline: false });

    const pub = await post(env, cfg.requests_channel, { embeds: [requestStatusEmbed(id, qty, shown, who, 'Open', COLORS.open)] });
    const bank = await post(env, cfg.bankers_channel, {
      content: cfg.banker_role ? `<@&${cfg.banker_role}>` : undefined,
      allowed_mentions: cfg.banker_role ? { roles: [cfg.banker_role] } : undefined,
      embeds: [{ title: `Request #${id}`, description: `**${qty} x ${shown}**`, color: warnings.length ? COLORS.declined : COLORS.open, fields }],
      components: bankerButtons(id, tornId),
    });
    await env.DB.prepare('UPDATE requests SET public_message_id = ?, banker_message_id = ? WHERE id = ?').bind(pub.id, bank.id, id).run();
    await followup(env, interaction.token, { content: `Request #${id} submitted: ${qty} x ${shown}.`, components: [] });
  })().catch(async (e) => {
    console.log('request failed', e.message);
    await followup(env, interaction.token, { content: `Request failed: ${e.message}`, components: [] });
  }));
  return json({ type: 7, data: { content: 'Creating your request…', components: [] } });
}

// Re-post an open request to the channels. Used by the site's "Resend" action when
// the original post never landed (e.g. the bot briefly lacked permission). Rebuilds
// the banker card from stored data plus current stock, refreshes the member's profile
// when a banker key is available, and records the new message ids.
export async function repostRequest(env, cfg, req) {
  if (!cfg.requests_channel || !cfg.bankers_channel) throw new Error('Channels not configured.');
  const shown = req.item_name || CATEGORY_LABELS[req.category] || req.category || 'items';
  const who = req.torn_id ? `${req.torn_name} [${req.torn_id}]` : req.torn_name;
  const stockQty = req.item_id ? await db.stockFor(env.DB, req.item_id) : await db.stockForItems(env.DB, itemsInCategory(req.category));
  const attacks = req.attacks_at_request;

  let totalReqs = 0, fulfilledReqs = 0, history = [];
  if (req.torn_id) {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'fulfilled' THEN 1 ELSE 0 END), 0) AS fulfilled FROM requests WHERE torn_id = ?`).bind(req.torn_id).first();
    totalReqs = c?.total || 0; fulfilledReqs = c?.fulfilled || 0;
    history = await db.recentRequestsFor(env.DB, req.torn_id, req.id);
  }

  let profile = null;
  if (req.torn_id) {
    const key = env.OWNER_API_KEY || await bankerKey(env, cfg);
    if (key) { try { profile = await torn.fetchProfile(key, req.torn_id); } catch {} }
  }

  const fields = [
    { name: 'Member', value: `${who}\n<@${req.discord_id}>`, inline: true },
    { name: 'Hits (elimination)', value: attacks == null ? 'unknown' : fmt(attacks), inline: true },
    { name: 'Stock', value: fmt(stockQty), inline: true },
  ];
  if (profile) {
    fields.push(
      { name: 'Level', value: profile.level == null ? 'unknown' : fmt(profile.level), inline: true },
      { name: 'Age', value: profile.age == null ? 'unknown' : `${fmt(profile.age)} days`, inline: true },
      { name: 'Net worth', value: profile.networth == null ? 'unknown' : money(profile.networth), inline: true },
    );
  }
  fields.push({ name: 'Requests', value: `${fmt(totalReqs)} total, ${fmt(fulfilledReqs)} fulfilled`, inline: false });
  if (history.length) fields.push({ name: 'Recent requests', value: history.map(h => `\`#${h.id}\` ${fmt(h.qty)} x ${reqLabel(h)} — ${h.status}`).join('\n').slice(0, 1024), inline: false });

  const warnings = [];
  if (req.item_id) {
    const threshold = await env.DB.prepare('SELECT min_attacks FROM item_thresholds WHERE item_id = ?').bind(req.item_id).first();
    if (threshold && attacks != null && attacks < threshold.min_attacks) warnings.push(`Below threshold of ${fmt(threshold.min_attacks)} attacks for ${shown}.`);
  }
  if (stockQty < req.qty) warnings.push(`Only ${fmt(stockQty)} in stock.`);
  if (req.torn_id) {
    const minA = Number(cfg.leech_min_attacks || 0), minR = Number(cfg.leech_min_requests || 0);
    if (attacks != null && attacks < minA && fulfilledReqs >= minR) warnings.push(`${fmt(fulfilledReqs)} fulfilled requests with only ${fmt(attacks)} attacks.`);
  }
  if (warnings.length) fields.push({ name: '⚠️ Warnings', value: warnings.map(w => `• ${w}`).join('\n'), inline: false });

  const pub = await post(env, cfg.requests_channel, { embeds: [requestStatusEmbed(req.id, req.qty, shown, who, 'Open', COLORS.open)] });
  const bank = await post(env, cfg.bankers_channel, {
    content: cfg.banker_role ? `<@&${cfg.banker_role}>` : undefined,
    allowed_mentions: cfg.banker_role ? { roles: [cfg.banker_role] } : undefined,
    embeds: [{ title: `Request #${req.id}`, description: `**${req.qty} x ${shown}**`, color: warnings.length ? COLORS.declined : COLORS.open, fields }],
    components: bankerButtons(req.id, req.torn_id),
  });
  await env.DB.prepare('UPDATE requests SET public_message_id = ?, banker_message_id = ? WHERE id = ?').bind(pub.id, bank.id, req.id).run();
}

async function cmdMyStats(interaction, env) {
  const discordId = interaction.member?.user?.id || interaction.user?.id;
  const rows = (await env.DB.prepare(`SELECT r.id, r.status, r.category, i.name AS item_name,
    CASE WHEN r.status = 'fulfilled'
      THEN COALESCE((SELECT SUM(t.qty) FROM transactions t WHERE t.request_id = r.id), r.qty)
      ELSE r.qty END AS qty
    FROM requests r LEFT JOIN items i ON i.item_id = r.item_id WHERE r.discord_id = ? ORDER BY r.created_at DESC LIMIT 20`).bind(discordId).all()).results;
  if (!rows.length) return reply('No requests.');
  return replyEmbed({ title: 'Your requests', color: COLORS.info, description: rows.map(r => `\`#${r.id}\` ${fmt(r.qty)} x ${reqLabel(r)} — **${r.status}**`).join('\n').slice(0, 4000) });
}

async function cmdContribute(interaction, env, cfg, ctx) {
  const itemOpt = opt(interaction, 'item');
  const qty = Number(opt(interaction, 'qty')) || 1;
  const cash = Number(opt(interaction, 'cash')) || 0;
  if (!itemOpt && !cash) return reply('Give an item (with qty) or a cash amount to contribute.');

  ctx.waitUntil((async () => {
    const key = await bankerKey(env, cfg);
    const discordId = interaction.member?.user?.id || interaction.user?.id;
    let tornId = null;
    if (key) { try { tornId = await torn.fetchTornIdFromDiscord(key, discordId); } catch {} }
    if (!tornId) { const m = (interaction.member?.nick || '').match(/\[(\d+)\]/); if (m) tornId = Number(m[1]); }
    if (!tornId) { await followup(env, interaction.token, { content: 'Could not identify your Torn ID.' }); return; }
    const banker = await env.DB.prepare('SELECT torn_id, name FROM bankers WHERE torn_id = ? AND active = 1').bind(tornId).first();
    if (!banker) { await followup(env, interaction.token, { content: 'Only active bankers can contribute.' }); return; }

    const t = db.now();
    const ins = env.DB.prepare(`INSERT INTO transactions (log_id, banker_id, direction, type, item_id, qty, value_at_time, counterparty_id, counterparty_name, message, timestamp, kind)
      VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, 'contribution', ?, 'donation')`);
    const recorded = [];
    if (itemOpt) {
      const item = await resolveItem(env, String(itemOpt));
      if (!item) { await followup(env, interaction.token, { content: 'Unknown item.' }); return; }
      const value = (item.market_value || 0) * qty;
      await ins.bind(`contrib:${crypto.randomUUID()}`, banker.torn_id, 'item', item.item_id, qty, value, banker.torn_id, banker.name, t).run();
      recorded.push(`${fmt(qty)} x ${item.name}`);
    }
    if (cash) {
      await ins.bind(`contrib:${crypto.randomUUID()}`, banker.torn_id, 'cash', null, cash, cash, banker.torn_id, banker.name, t).run();
      recorded.push(money(cash));
    }

    if (cfg.log_channel) { try { await post(env, cfg.log_channel, { embeds: [{ title: 'Contribution', color: COLORS.donation, description: `${recorded.join(' and ')}\nfrom **${banker.name}** [${banker.torn_id}]` }] }); } catch (e) { console.log(e.message); } }
    await followup(env, interaction.token, { content: `Recorded your contribution: ${recorded.join(' and ')}.` });
  })().catch(async (e) => {
    console.log('contribute failed', e.message);
    await followup(env, interaction.token, { content: `Contribute failed: ${e.message}` });
  }));
  return json({ type: 5, data: { flags: EPHEMERAL } });
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
  return replyEmbed({ title: 'Stock', color: COLORS.info, description: rows.map(r => `${r.name}: **${fmt(r.qty)}**`).join('\n').slice(0, 4000) });
}

async function cmdFunds(env) {
  const f = await db.funds(env.DB);
  return replyEmbed({ title: 'Treasury funds', color: COLORS.info, fields: [
    { name: 'Balance', value: money(f.balance), inline: true },
    { name: 'Cash in', value: money(f.cash_in), inline: true },
    { name: 'Cash out', value: money(f.cash_out), inline: true },
    { name: 'Spent on purchases', value: money(f.spent), inline: true },
  ] });
}

async function cmdRequests(interaction, env) {
  const status = opt(interaction, 'status') || 'open';
  const rows = await db.listRequests(env.DB, status === 'all' ? null : status);
  if (!rows.length) return reply(`No ${status} requests.`);
  return replyEmbed({ title: `${status[0].toUpperCase()}${status.slice(1)} requests`, color: COLORS.info, description: rows.map(r => { const by = r.banker_name || r.handled_by; return `\`#${r.id}\` ${fmt(r.qty)} x ${reqLabel(r)} for ${r.torn_name} — **${r.status}**${by ? ` (${by})` : ''}`; }).join('\n').slice(0, 4000) });
}

async function cmdDonors(env) {
  const rows = await db.donorTotals(env.DB);
  if (!rows.length) return reply('No donations yet.');
  return replyEmbed({ title: 'Donors', color: COLORS.donation, description: rows.map(r => `**${r.counterparty_name}** [${r.counterparty_id}] — ${money(r.total_value)}\n${fmt(r.item_qty)} items, ${money(r.cash)} cash`).join('\n\n').slice(0, 4000) });
}

async function cmdLedger(interaction, env) {
  const days = Number(opt(interaction, 'days') || 7);
  const rows = await db.ledger(env.DB, { days, limit: 40 });
  if (!rows.length) return reply('No transactions.');
  return replyEmbed({ title: `Ledger (last ${fmt(days)} days)`, color: COLORS.info, description: rows.map(r => {
    const what = r.type === 'cash' ? money(r.qty) : `${fmt(r.qty)} x ${r.item_name}`;
    const arrow = r.direction === 'in' ? 'from' : 'to';
    return `\`${new Date(r.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')}\` ${r.kind} ${what} ${arrow} ${r.counterparty_name} via ${r.banker_name}`;
  }).join('\n').slice(0, 4000) });
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
  // Member request flow: category -> item -> quantity dropdowns. Open to everyone.
  if (action === 'req_cat') return requestCategory(interaction, env, cfg);
  if (action === 'req_it') return requestItem(interaction, env, cfg);
  if (action === 'req_qty') return requestQty(interaction, env, cfg, ctx);
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
    await env.DB.prepare(`UPDATE requests SET status = 'approved', banker_id = ?, handled_by = ?, updated_at = ? WHERE id = ? AND status = 'open'`).bind(banker?.torn_id || null, bankerName, db.now(), id).run();
    ctx.waitUntil((async () => {
      await edit(env, cfg.requests_channel, req.public_message_id, { content: `<@${req.discord_id}>`, embeds: [requestStatusEmbed(id, req.qty, reqLabel(req), req.torn_name, `Pending send, approved by ${bankerName}`, COLORS.approved)] });
    })());
    const orig = interaction.message.embeds?.[0] || {};
    const updated = { ...orig, color: COLORS.approved, fields: [
      ...(orig.fields || []),
      { name: 'Approved by', value: bankerName, inline: false },
      { name: 'Action', value: `[Send](https://www.torn.com/item.php) ${req.qty} x ${reqLabel(req)} to ${req.torn_name}${req.torn_id ? ` [${req.torn_id}]` : ''} with "${cfg.keyword}" in the message.`, inline: false },
    ] };
    return json({ type: 7, data: { embeds: [updated], components: [] } });
  }
  return reply('Unknown action.');
}

async function matchBanker(env, interaction) {
  const nick = interaction.member?.nick || '';
  const m = nick.match(/\[(\d+)\]/);
  if (!m) return null;
  return env.DB.prepare('SELECT torn_id, name FROM bankers WHERE torn_id = ?').bind(Number(m[1])).first();
}

// Walk a modal-submit component tree and pull the value for a given input.
// Discord may return text inputs bare, inside an action row, or wrapped in a
// Label component, so search recursively rather than at a fixed depth.
function modalValue(components, customId) {
  for (const c of components || []) {
    if (c.custom_id === customId) {
      if (c.value !== undefined) return c.value;           // text input
      if (Array.isArray(c.values)) return c.values[0];     // string select
    }
    const nested = c.components || (c.component ? [c.component] : null);
    if (nested) { const v = modalValue(nested, customId); if (v !== undefined) return v; }
  }
  return undefined;
}

async function modal(interaction, env, cfg, ctx) {
  const [action, idStr] = interaction.data.custom_id.split(':');
  if (action !== 'decline_modal') return reply('Unknown modal.');
  const reason = modalValue(interaction.data.components, 'reason') || '';
  return cmdDecline(interaction, env, cfg, ctx, Number(idStr), reason, true);
}

// Mark a request declined and update its Discord messages: set the public message
// to a declined status and rewrite the banker card as declined with its buttons
// removed. Shared by the /decline command, the decline modal, and the council
// website, so a decline from anywhere clears the card from the bankers channel.
// Returns { error } if the request cannot be declined, else { req }.
export async function declineRequest(env, cfg, ctx, id, reason, who) {
  const req = await db.getRequest(env.DB, id);
  if (!req) return { error: 'Request not found.' };
  if (['fulfilled', 'declined'].includes(req.status)) return { error: `Request #${id} is already ${req.status}.` };
  await env.DB.prepare(`UPDATE requests SET status = 'declined', decline_reason = ?, handled_by = ?, updated_at = ? WHERE id = ?`).bind(reason, who, db.now(), id).run();
  const suffix = reason ? ` Reason: ${reason}` : '';
  const declinedStatus = `Declined by ${who}.${suffix}`;
  ctx.waitUntil((async () => {
    if (req.public_message_id) await edit(env, cfg.requests_channel, req.public_message_id, { content: `<@${req.discord_id}>`, embeds: [requestStatusEmbed(id, req.qty, reqLabel(req), req.torn_name, declinedStatus, COLORS.declined)] });
    if (req.banker_message_id) await edit(env, cfg.bankers_channel, req.banker_message_id, { embeds: [requestStatusEmbed(id, req.qty, reqLabel(req), req.torn_name, declinedStatus, COLORS.declined)], components: [] });
  })());
  return { req };
}

async function cmdDecline(interaction, env, cfg, ctx, id, reason, fromModal = false) {
  const { error } = await declineRequest(env, cfg, ctx, id, reason, displayName(interaction));
  if (error) return reply(error);
  if (fromModal) return json({ type: 4, data: { content: `Request #${id} declined.`, flags: EPHEMERAL } });
  return reply(`Request #${id} declined.`);
}
