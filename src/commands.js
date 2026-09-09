// Slash command definitions, shared by the worker's /register route and the
// standalone scripts/register-commands.js. /request takes no options: it opens
// a modal form, so its command must be optionless or Discord prompts old fields.
const item = { name: 'item', description: 'Item', type: 3, required: true, autocomplete: true };

export const commands = [
  { name: 'request', description: 'Request items from the treasury' },
  // Same modal flow as /request, under a fresh name so it is never masked by the
  // old cached /request (which had options and can linger in clients for ~1hr).
  { name: 'request-item', description: 'Request items from the treasury' },
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
