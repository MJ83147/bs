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

export async function fetchElimination(key) {
  const data = await get(`${BASE}/v2/torn/elimination?key=${key}`);
  const list = data.elimination || [];
  return list.map(t => ({
    id: t.id,
    name: t.name,
    participants: t.participants ?? null,
    position: t.position ?? null,
    score: t.score ?? 0,
    lives: t.lives ?? null,
    wins: t.wins ?? 0,
    losses: t.losses ?? 0,
    eliminated: !!t.eliminated,
  }));
}

export async function fetchTornIdFromDiscord(key, discordId) {
  const data = await get(`${BASE}/user/${discordId}?selections=discord&key=${key}`);
  return data.discord ? Number(data.discord.userID) : null;
}

export async function fetchBasic(key, tornId) {
  const data = await get(`${BASE}/user/${tornId}?selections=basic&key=${key}`);
  return { id: data.player_id, name: data.name };
}

// Level + age come from the profile selection. Net worth comes from the
// personalstats "networth" category, which returns another player's net worth
// when queried with a Full Access key (the owner key). The dedicated `networth`
// selection is NOT used: it is a private, self-only selection that errors
// (code 7) for anyone but the key owner, so it showed "unknown" for everyone.
// Net worth shape is parsed defensively (plain number or breakdown object).
function parseNetworth(ps) {
  const nw = (ps || {}).networth;
  if (typeof nw === 'number') return nw;
  if (nw && typeof nw === 'object') return nw.total ?? nw.networth ?? null;
  if (typeof (ps || {}).networthtotal === 'number') return ps.networthtotal;
  return null;
}

export async function fetchProfile(key, tornId) {
  try {
    const data = await get(`${BASE}/user/${tornId}?selections=profile,personalstats&cat=networth&key=${key}`);
    return { level: data.level ?? null, age: data.age ?? null, networth: parseNetworth(data.personalstats) };
  } catch {
    // Combined call failed; fetch profile alone so level/age still render, then
    // try net worth on its own so one failing selection never hides the others.
    const p = await get(`${BASE}/user/${tornId}?selections=profile&key=${key}`);
    let networth = null;
    try { networth = parseNetworth((await get(`${BASE}/user/${tornId}?selections=personalstats&cat=networth&key=${key}`)).personalstats); } catch {}
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
