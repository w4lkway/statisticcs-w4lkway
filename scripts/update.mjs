// Обновляет site/data/stats.json из открытых API.
// Запуск: node scripts/update.mjs  (Node 20+, без зависимостей)
// Ключи берутся из переменных окружения (в GitHub это Secrets), ID и ники из config.json.
// Источник без ключа или с ошибкой пропускается: его прежние значения остаются в файле.

import { readFile, writeFile } from 'node:fs/promises';

const STATS_PATH = new URL('../site/data/stats.json', import.meta.url);
const CONFIG_PATH = new URL('../config.json', import.meta.url);

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ruDate(ms) {
  const d = new Date(ms + 3 * 3600e3); // московское время
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function ruMonthYear(ms) {
  const d = new Date(ms + 3 * 3600e3);
  return `${MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const n = (x) => {
  if (x === undefined || x === null || x === '') return undefined;
  const v = parseFloat(String(x).replace(',', '.').replace('%', ''));
  return Number.isFinite(v) ? v : undefined;
};
const r = (x, d) => (x === undefined || x === null || !Number.isFinite(x) ? undefined : Math.round(x * 10 ** d) / 10 ** d);
const put = (obj, key, val) => {
  if (val !== undefined && val !== null && !(typeof val === 'number' && !Number.isFinite(val))) obj[key] = val;
};
const prettyMap = (m) => {
  const s = String(m || '').replace(/^(de|cs|ar)_/, '');
  return s ? s[0].toUpperCase() + s.slice(1) : '?';
};

async function getJson(url, { headers = {} } = {}) {
  const safe = url.split('?')[0]; // ключи в query не попадают в логи
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'w4lkway-stats-updater', Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 160);
        const err = new Error(`HTTP ${res.status} ${safe} ${body}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (e) {
      last = e;
      if (e.status && e.status < 500 && e.status !== 429) break;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

/* ---------------- Steam: время в игре, уровень, убийства по оружию ---------------- */
const WEAPONS = {
  ak47: 'AK-47', m4a1: 'M4A1', awp: 'AWP', deagle: 'Desert Eagle', hkp2000: 'P2000', glock: 'Glock-18', p250: 'P250',
  famas: 'FAMAS', galilar: 'Galil AR', ssg08: 'SSG 08', mp9: 'MP9', mac10: 'MAC-10', ump45: 'UMP-45', aug: 'AUG',
  sg556: 'SG 553', fiveseven: 'Five-SeveN', tec9: 'Tec-9', elite: 'Dual Berettas', nova: 'Nova', xm1014: 'XM1014',
  negev: 'Negev', m249: 'M249', bizon: 'PP-Bizon', mp7: 'MP7', mp5sd: 'MP5-SD', mag7: 'MAG-7', sawedoff: 'Sawed-Off',
  g3sg1: 'G3SG1', scar20: 'SCAR-20',
};

async function updateSteam(d, cfg) {
  const key = process.env.STEAM_API_KEY;
  if (!key) return { skipped: 'нет STEAM_API_KEY' };
  const id = cfg.steamId64;
  const B = 'https://api.steampowered.com';
  const st = ((d.cs2 ??= {}).steam ??= {});
  const errors = [];
  let got = 0;

  const tasks = [
    async () => {
      const j = await getJson(`${B}/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${id}`);
      const p = j.response?.players?.[0];
      if (!p) throw new Error('профиль не найден');
      put(st, 'steamId', id);
      put(st, 'name', p.personaname);
      if (p.timecreated) put(st, 'accountAgeYears', Math.floor((Date.now() / 1000 - p.timecreated) / 31557600));
    },
    async () => {
      const j = await getJson(`${B}/IPlayerService/GetSteamLevel/v1/?key=${key}&steamid=${id}`);
      put(st, 'level', j.response?.player_level);
    },
    async () => {
      const j = await getJson(`${B}/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${id}&include_played_free_games=1&appids_filter[0]=730`);
      const g = j.response?.games?.[0];
      if (!g) throw new Error('список игр скрыт: в Steam открой «Сведения об играх»');
      put(st, 'playtimeHours', Math.round(g.playtime_forever / 60));
    },
    async () => {
      const j = await getJson(`${B}/ISteamUserStats/GetUserStatsForGame/v2/?key=${key}&appid=730&steamid=${id}`);
      const stats = j.playerstats?.stats;
      if (!Array.isArray(stats)) throw new Error('статистика оружия недоступна');
      const byName = new Map(stats.map((s) => [s.name, s.value]));
      const list = Object.entries(WEAPONS)
        .map(([k, name]) => ({ name, kills: byName.get(`total_kills_${k}`) || 0 }))
        .filter((w) => w.kills > 0)
        .sort((a, b) => b.kills - a.kills)
        .slice(0, 5);
      if (list.length) d.cs2.weaponKills = list;
    },
  ];
  for (const t of tasks) {
    try { await t(); got++; } catch (e) { errors.push(e.message); }
  }
  if (!got) throw new Error(errors.join('; '));
  return { warn: errors };
}

/* ---------------- FACEIT ---------------- */
async function updateFaceit(d, cfg) {
  const key = process.env.FACEIT_API_KEY;
  if (!key) return { skipped: 'нет FACEIT_API_KEY' };
  const H = { Authorization: `Bearer ${key}` };
  const B = 'https://open.faceit.com/data/v4';
  const p = await getJson(`${B}/players?nickname=${encodeURIComponent(cfg.faceitNickname)}`, { headers: H });
  const f = ((d.cs2 ??= {}).faceit ??= {});
  const warn = [];
  put(f, 'nickname', p.nickname);
  put(f, 'country', p.country ? String(p.country).toUpperCase() : undefined);
  put(f, 'elo', p.games?.cs2?.faceit_elo);
  if (p.activated_at) put(f, 'joined', ruMonthYear(Date.parse(p.activated_at)));

  try {
    const s = await getJson(`${B}/players/${p.player_id}/stats/cs2`, { headers: H });
    const L = s.lifetime || {};
    const matches = n(L['Matches']);
    const wins = n(L['Wins']);
    put(f, 'matches', matches);
    put(f, 'winRate', r(wins !== undefined && matches ? (wins / matches) * 100 : n(L['Win Rate %']), 1));
    put(f, 'kd', r(n(L['Average K/D Ratio']), 2));
    put(f, 'hs', r(n(L['Average Headshots %']), 0));
    for (const k of ['ADR', 'Average ADR', 'Average Damage per Round']) {
      if (n(L[k]) !== undefined) { put(f, 'adr', r(n(L[k]), 1)); break; }
    }
    if (Array.isArray(L['Recent Results']) && L['Recent Results'].length) {
      f.recent = L['Recent Results'].slice(0, 5).map((x) => (String(x) === '1' ? 'W' : 'L'));
    }
  } catch (e) { warn.push('статистика: ' + e.message); }

  try {
    const h = await getJson(`${B}/players/${p.player_id}/history?game=cs2&offset=0&limit=1`, { headers: H });
    const t = h.items?.[0]?.finished_at;
    if (t) put(f, 'lastMatch', ruDate(t * 1000));
  } catch (e) { warn.push('история: ' + e.message); }
  return { warn };
}

/* ---------------- Leetify ---------------- */
async function updateLeetify(d, cfg) {
  const key = process.env.LEETIFY_API_KEY;
  if (!key) return { skipped: 'нет LEETIFY_API_KEY' };
  const j = await getJson(`https://api-public.cs-prod.leetify.com/v3/profile?steam64_id=${cfg.steamId64}`, {
    headers: { Authorization: `Bearer ${key}`, _leetify_key: key },
  });
  const cs = (d.cs2 ??= {});
  const lf = (cs.leetify ??= {});
  const rt = j.rating || {};
  put(lf, 'aim', r(rt.aim, 1));
  put(lf, 'utility', r(rt.utility, 1));
  put(lf, 'ct', r(rt.ct_leetify, 2));
  put(lf, 't', r(rt.t_leetify, 2));
  const overall = rt.leetify ?? (Number.isFinite(rt.ct_leetify) && Number.isFinite(rt.t_leetify) ? (rt.ct_leetify + rt.t_leetify) / 2 : undefined);
  put(lf, 'rating', r(overall, 2));

  if (j.ranks && typeof j.ranks === 'object') {
    const pr = (cs.premier ??= {});
    pr.rank = Number.isFinite(j.ranks.premier) ? String(j.ranks.premier).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : 'Unranked';
  }

  const rm = Array.isArray(j.recent_matches) ? j.recent_matches.slice() : [];
  rm.sort((a, b) => Date.parse(b.finished_at) - Date.parse(a.finished_at));
  const res = (o) => (o === 'win' ? 'W' : o === 'loss' ? 'L' : 'D');
  if (rm.length) {
    put(lf, 'matches', rm.length);
    cs.recentMatches = rm.slice(0, 5).map((m) => ({
      map: prettyMap(m.map_name),
      score: `${m.score?.[0] ?? '?'}–${m.score?.[1] ?? '?'}`,
      date: ruDate(Date.parse(m.finished_at)),
      result: res(m.outcome).toLowerCase(),
    }));
    const prem = rm.filter((m) => m.data_source === 'matchmaking' && (m.rank_type == null || m.rank_type === 11)).slice(0, 10);
    if (prem.length) (cs.premier ??= {}).recent = prem.map((m) => res(m.outcome));
  }
  return {};
}

/* ---------------- Dota 2 через OpenDota (те же матчи, что показывает Dotabuff) ---------------- */
const LANES = { 1: 'Лёгкая линия', 2: 'Средняя линия', 3: 'Сложная линия', 4: 'Лес' };

async function updateDota(d, cfg) {
  const id = cfg.dotaAccountId ?? String(BigInt(cfg.steamId64) - 76561197960265728n);
  const B = 'https://api.opendota.com/api';
  const q = process.env.OPENDOTA_API_KEY ? `&api_key=${process.env.OPENDOTA_API_KEY}` : '';
  const dt = (d.dota ??= {});
  const warn = [];

  const wl = await getJson(`${B}/players/${id}/wl?significant=0${q}`);
  const win = wl.win ?? 0;
  const lose = wl.lose ?? 0;
  const total = win + lose;
  if (!total) throw new Error(`нет матчей у аккаунта ${id}: проверь dotaAccountId и «Открытая история матчей» в Dota 2`);
  dt.wins = win;
  dt.losses = lose;
  dt.matches = total;
  dt.winRate = r((win / total) * 100, 2);

  const row = (name, games, w) => ({ name, matches: games, winRate: games ? r((w / games) * 100, 2) : 0 });

  try {
    const rk = await getJson(`${B}/players/${id}/wl?significant=0&lobby_type=7${q}`);
    const g = (rk.win ?? 0) + (rk.lose ?? 0);
    dt.ranked = { matches: g, winRate: g ? r((rk.win / g) * 100, 2) : 0 };
    dt.lobby = [row('Рейтинговые', g, rk.win ?? 0), row('Обычные', total - g, win - (rk.win ?? 0))];
  } catch (e) { warn.push('рейтинговые: ' + e.message); }

  try {
    const c = await getJson(`${B}/players/${id}/counts?significant=0${q}`);
    const get = (cat, key) => c?.[cat]?.[key] || { games: 0, win: 0 };
    const ap1 = get('game_mode', '1');
    const ap2 = get('game_mode', '22');
    const apGames = ap1.games + ap2.games;
    const apWin = ap1.win + ap2.win;
    dt.mode = [row('All Pick', apGames, apWin), row('Другие', total - apGames, win - apWin)];
    const rad = get('is_radiant', '1');
    const dire = get('is_radiant', '0');
    dt.side = [row('Свет', rad.games, rad.win), row('Тьма', dire.games, dire.win)];
  } catch (e) { warn.push('разбивка: ' + e.message); }

  try {
    const heroList = await getJson(`${B}/heroes`);
    const names = new Map(heroList.map((h) => [h.id, h.localized_name]));
    const heroStats = await getJson(`${B}/players/${id}/heroes?significant=0${q}`);
    const matches = await getJson(
      `${B}/players/${id}/matches?significant=0&project=hero_id&project=kills&project=deaths&project=assists&project=lane_role${q}`,
    );
    const agg = new Map();
    for (const m of matches) {
      const a = agg.get(m.hero_id) || { k: 0, d: 0, a: 0, lanes: {} };
      a.k += m.kills || 0; a.d += m.deaths || 0; a.a += m.assists || 0;
      if (m.lane_role) a.lanes[m.lane_role] = (a.lanes[m.lane_role] || 0) + 1;
      agg.set(m.hero_id, a);
    }
    const old = new Map((dt.heroes || []).map((h) => [h.name, h]));
    const top = heroStats.filter((h) => h.games > 0).sort((a, b) => b.games - a.games).slice(0, 10);
    const heroes = top.map((h) => {
      const name = names.get(h.hero_id) || `Hero ${h.hero_id}`;
      const a = agg.get(h.hero_id);
      const prev = old.get(name);
      const modal = a ? Object.entries(a.lanes).sort((x, y) => y[1] - x[1])[0]?.[0] : undefined;
      return {
        name,
        matches: h.games,
        winRate: r((h.win / h.games) * 100, 2),
        kda: a ? r((a.k + a.a) / Math.max(1, a.d), 2) : prev?.kda,
        role: prev?.role || 'core',
        lane: prev?.lane || LANES[modal] || 'Средняя линия',
      };
    });
    if (heroes.length) dt.heroes = heroes;
  } catch (e) { warn.push('герои: ' + e.message); }
  return { warn };
}

/* ---------------- Fortnite через fortnite-api.com ---------------- */
async function updateFortnite(d, cfg) {
  const key = process.env.FORTNITE_API_KEY;
  if (!key) return { skipped: 'нет FORTNITE_API_KEY' };
  const url = `https://fortnite-api.com/v2/stats/br/v2?name=${encodeURIComponent(cfg.epicName)}&accountType=${cfg.epicAccountType || 'epic'}&timeWindow=lifetime&image=none`;
  const j = await getJson(url, { headers: { Authorization: key } });
  const all = j.data?.stats?.all;
  if (!all?.overall) throw new Error('нет статистики: проверь epicName и открытую статистику профиля');
  const o = all.overall;
  const fn = (d.fortnite ??= {});
  const ov = (fn.overall ??= {});
  put(fn, 'minutesPlayed', o.minutesPlayed);
  put(ov, 'matches', o.matches);
  put(ov, 'wins', o.wins);
  put(ov, 'kills', o.kills);
  put(ov, 'winRate', r(o.winRate, 2));
  put(ov, 'kpm', r(o.killsPerMatch, 2));

  const spec = [
    ['solo', all.solo, 'top10', 'top25'],
    ['duos', all.duo, 'top5', 'top12'],
    ['trios', all.trio, 'top3', 'top6'],
    ['squads', all.squad, 'top3', 'top6'],
  ];
  const modes = (fn.modes ??= {});
  let a = 0;
  let b = 0;
  for (const [key2, m, ka, kb] of spec) {
    if (!m) continue;
    modes[key2] = {
      matches: m.matches ?? 0,
      top1: m.wins ?? 0,
      winRate: r(m.winRate, 2) ?? 0,
      kills: m.kills ?? 0,
      kpm: r(m.killsPerMatch, 2) ?? 0,
      topA: m[ka] ?? 0,
      topB: m[kb] ?? 0,
    };
    a += m[ka] ?? 0;
    b += m[kb] ?? 0;
  }
  ov.top3510 = a;
  ov.top61225 = b;
  return {};
}

/* ---------------- запуск ---------------- */
const SOURCES = [
  ['steam', updateSteam],
  ['faceit', updateFaceit],
  ['leetify', updateLeetify],
  ['opendota', updateDota],
  ['fortnite', updateFortnite],
];

const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
const data = JSON.parse(await readFile(STATS_PATH, 'utf8'));
data.sources ??= {};

let okCount = 0;
let failCount = 0;
for (const [name, fn] of SOURCES) {
  try {
    const res = (await fn(data, cfg)) || {};
    if (res.skipped) {
      console.log(`- ${name}: пропущен (${res.skipped})`);
      continue;
    }
    okCount++;
    data.sources[name] = { ok: true, updatedAt: new Date().toISOString() };
    console.log(`✓ ${name}: обновлено`);
    for (const w of res.warn || []) console.log(`::warning title=${name}::${w}`);
  } catch (e) {
    failCount++;
    data.sources[name] = { ...(data.sources[name] || {}), ok: false, error: String(e.message).slice(0, 200) };
    console.log(`::warning title=${name}::${e.message}`);
    console.log(`✗ ${name}: ${e.message}`);
  }
}

if (okCount > 0) {
  data.updatedAt = new Date().toISOString();
  await writeFile(STATS_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`Готово: обновлено источников ${okCount}, с ошибкой ${failCount}.`);
} else {
  console.log('Ни один источник не обновился. Проверь секреты и config.json (см. README).');
  process.exitCode = 1;
}
