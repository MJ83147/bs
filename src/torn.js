const BASE = 'https://api.torn.com';

async function get(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`Torn API ${data.error.code}: ${data.error.error}`);
  return data;
}

export async function fetchLogs(key, logTypes, from) {
  const params = new URLSearchParams({ selections: 'log', key, log: logTypes.join(',') });
  if (from) params.set('from', String(from));
  const data = await get(`${BASE}/user/?${params}`);
  const logs = data.log || {};
  return Object.entries(logs).map(([id, entry]) => ({ id, ...entry }));
}

export async function fetchCompetition(key, tornId) {
  const data = await get(`${BASE}/v2/user/${tornId}/competition?key=${key}`);
  const c = data.competition || data;
  return { name: c.name, team: c.team, score: c.score, attacks: c.attacks };
}

export async function fetchTornIdFromDiscord(key, discordId) {
  const data = await get(`${BASE}/user/${discordId}?selections=discord&key=${key}`);
  return data.discord ? Number(data.discord.userID) : null;
}

export async function fetchBasic(key, tornId) {
  const data = await get(`${BASE}/user/${tornId}?selections=basic&key=${key}`);
  return { id: data.player_id, name: data.name };
}

export async function fetchItems(key) {
  const data = await get(`${BASE}/torn/?selections=items&key=${key}`);
  return Object.entries(data.items).map(([id, it]) => ({
    item_id: Number(id),
    name: it.name,
    market_value: Number(it.market_value || 0),
  }));
}

export async function validateKey(key) {
  const data = await get(`${BASE}/user/?selections=basic&key=${key}`);
  return { id: data.player_id, name: data.name };
}
