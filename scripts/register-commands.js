// Usage: DISCORD_TOKEN=... node scripts/register-commands.js
//
// By default this registers the commands GLOBALLY, so they work in every server
// the bot is in. Global commands can take up to ~1 hour to appear.
//
// Options (env vars):
//   GUILD_ID=...        Register to a single server instead of globally.
//                       Appears instantly; only in that server. Good for testing.
//   CLEAR_GUILD_ID=...  Remove leftover guild-scoped commands from an old server
//                       so they don't show up twice alongside the global ones.
const APP_ID = '1343283117313757246';
const token = process.env.DISCORD_TOKEN;
if (!token) { console.error('DISCORD_TOKEN not set'); process.exit(1); }

const item = { name: 'item', description: 'Item', type: 3, required: true, autocomplete: true };
const commands = [
  { name: 'request', description: 'Request items from the treasury' },
  { name: 'mystats', description: 'Your requests' },
  { name: 'contribute', description: 'Add your own items or cash to the treasury', options: [
    { name: 'item', description: 'Item you are contributing', type: 3, required: false, autocomplete: true },
    { name: 'qty', description: 'Quantity of the item (default 1)', type: 4, required: false, min_value: 1 },
    { name: 'cash', description: 'Cash amount to contribute', type: 4, required: false, min_value: 1 },
  ] },
  { name: 'stock', description: 'Treasury stock', options: [{ ...item, required: false }] },
  { name: 'funds', description: 'Treasury funds' },
  { name: 'requests', description: 'List requests', options: [{ name: 'status', description: 'Status', type: 3, required: false, choices: ['open', 'approved', 'fulfilled', 'declined', 'all'].map(s => ({ name: s, value: s })) }] },
  { name: 'donors', description: 'Donor totals' },
  { name: 'ledger', description: 'Recent transactions', options: [{ name: 'days', description: 'Days back', type: 4, required: false, min_value: 1 }] },
  { name: 'threshold', description: 'Set attack threshold for an item (0 removes)', options: [item, { name: 'min_attacks', description: 'Minimum attacks', type: 4, required: true, min_value: 0 }] },
  { name: 'decline', description: 'Decline a request', options: [{ name: 'request_id', description: 'Request number', type: 4, required: true }, { name: 'reason', description: 'Reason', type: 3, required: false }] },
];

const put = (path, body) => fetch(`https://discord.com/api/v10${path}`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const clearGuild = process.env.CLEAR_GUILD_ID;
if (clearGuild) {
  const c = await put(`/applications/${APP_ID}/guilds/${clearGuild}/commands`, []);
  console.log(`cleared guild ${clearGuild}:`, c.status, await c.text());
}

// CLEAR_GLOBAL=1 removes the global commands, e.g. when keeping guild-scoped
// ones (which update instantly) as the single source and dropping the globals.
if (process.env.CLEAR_GLOBAL) {
  const c = await put(`/applications/${APP_ID}/commands`, []);
  console.log('cleared global:', c.status, await c.text());
}

const guildId = process.env.GUILD_ID;
const path = guildId
  ? `/applications/${APP_ID}/guilds/${guildId}/commands`
  : `/applications/${APP_ID}/commands`;
const res = await put(path, commands);
console.log(guildId ? `guild ${guildId}:` : 'global:', res.status, await res.text());
