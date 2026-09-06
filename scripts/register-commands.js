// Usage: DISCORD_TOKEN=... node scripts/register-commands.js
const APP_ID = '1343283117313757246';
const GUILD_ID = '1343284075540254730';
const token = process.env.DISCORD_TOKEN;
if (!token) { console.error('DISCORD_TOKEN not set'); process.exit(1); }

const item = { name: 'item', description: 'Item', type: 3, required: true, autocomplete: true };
const commands = [
  { name: 'request', description: 'Request items from the treasury', options: [item, { name: 'qty', description: 'Quantity', type: 4, required: true, min_value: 1 }] },
  { name: 'mystats', description: 'Your requests' },
  { name: 'stock', description: 'Treasury stock', options: [{ ...item, required: false }] },
  { name: 'funds', description: 'Treasury funds' },
  { name: 'requests', description: 'List requests', options: [{ name: 'status', description: 'Status', type: 3, required: false, choices: ['open', 'approved', 'fulfilled', 'declined', 'all'].map(s => ({ name: s, value: s })) }] },
  { name: 'donors', description: 'Donor totals' },
  { name: 'ledger', description: 'Recent transactions', options: [{ name: 'days', description: 'Days back', type: 4, required: false, min_value: 1 }] },
  { name: 'threshold', description: 'Set attack threshold for an item (0 removes)', options: [item, { name: 'min_attacks', description: 'Minimum attacks', type: 4, required: true, min_value: 0 }] },
  { name: 'decline', description: 'Decline a request', options: [{ name: 'request_id', description: 'Request number', type: 4, required: true }, { name: 'reason', description: 'Reason', type: 3, required: false }] },
];

const res = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands),
});
console.log(res.status, await res.text());
