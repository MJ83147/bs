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

// Level + age come from the profile selection; net worth from the dedicated
// networth selection, whose payload is a breakdown object with a `total`.
function parseNetworth(nw) {
  if (typeof nw === 'number') return nw;
  if (nw && typeof nw === 'object') return nw.total ?? nw.networth ?? null;
  return null;
}

export async function fetchProfile(key, tornId) {
  try {
    const data = await get(`${BASE}/user/${tornId}?selections=profile,networth&key=${key}`);
    return { level: data.level ?? null, age: data.age ?? null, networth: parseNetworth(data.networth) };
  } catch {
    // Combined call failed; fetch profile alone so level/age still render, then
    // try networth on its own so one failing selection never hides the others.
    const p = await get(`${BASE}/user/${tornId}?selections=profile&key=${key}`);
    let networth = null;
    try { networth = parseNetworth((await get(`${BASE}/user/${tornId}?selections=networth&key=${key}`)).networth); } catch {}
    return { level: p.level ?? null, age: p.age ?? null, networth };
  }
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
