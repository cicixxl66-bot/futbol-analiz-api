const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// .env dosyası varsa oku (ek paket gerekmez). Anahtarlar koda YAZILMAZ.
try {
    fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
        const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
} catch (e) {}

const API_KEY = process.env.API_KEY || '';
const BASE_URL = 'https://api.football-data.org/v4';
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === 'true';   // herkese açık sitede KAPALI kalmalı
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';                 // isteğe bağlı: gerçek piyasa oranı (The Odds API)
const ODDS_CACHE_MS = (parseFloat(process.env.ODDS_CACHE_HOURS) || 24) * 3600e3;   // ücretsiz plan ayda 500 kredi: lig sayısı arttığı için 24 saat
const VALUE_EDGE = 0.05;                                             // "değerli" için minimum avantaj (%5)
const PORT = process.env.PORT || 3000;
// football-data.org (ücretsiz planda olan ligler, sayısal kod)
const FD_CODES = ['2015', '2021', '2014', '2002', '2019', '2001', '2003', '2017', '2016', '2013'];
// ESPN (anahtarsız, resmi olmayan uç nokta; noktalı kod = ESPN lig kısaltması)
const ESPN_CODES = ['tur.1', 'uefa.nations', 'uefa.europa', 'uefa.europa.conf'];
const LEAGUE_CODES = [...FD_CODES, ...ESPN_CODES];
const isEspn = code => ESPN_CODES.includes(code);
if (!API_KEY) console.log('⚠️  API_KEY tanımlı değil. .env dosyası oluştur (.env.example dosyasına bak) ya da Render ortam değişkenlerine ekle.');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// ---------- Önbellek: herkese açık sitede football-data limitini (dk'da 10 istek) korur ----------
const cache = new Map();
function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.p;
    const p = fn().catch(err => {
        if (hit) { cache.set(key, { t: Date.now() - ttl + 30000, p: hit.p }); return hit.p; }   // hata olursa eski veriyi göster
        cache.delete(key); throw err;
    });
    cache.set(key, { t: Date.now(), p });
    return p;
}
// football-data ücretsiz planı dakikada 10 istek verir: 9'u geçmemek için sıraya sokar
const fdTimes = [];
async function fdSlot() {
    for (;;) {
        const now = Date.now();
        while (fdTimes.length && now - fdTimes[0] > 60e3) fdTimes.shift();
        if (fdTimes.length < 9) { fdTimes.push(now); return; }
        await new Promise(r => setTimeout(r, 60e3 - (now - fdTimes[0]) + 250));
    }
}
async function fd(pathname) {
    await fdSlot();
    const r = await fetch(`${BASE_URL}${pathname}`, { headers: { 'X-Auth-Token': API_KEY } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 429 ? 'Veri kaynağı istek sınırına ulaştı, bir dakika sonra tekrar dene.' : `Veri kaynağı hata verdi (${r.status}).`);
    return data;
}
const liveFlag = {};   // o ligde şu an canlı maç var mı? Varsa önbellek 1 dakikaya iner
const isLiveStatus = st => st === 'IN_PLAY' || st === 'PAUSED' || st === 'LIVE';
// ---------- ESPN adaptörü: ESPN verisini football-data biçimine çevirir (model, kupon, takip aynen çalışır) ----------
const ESPN_BASE = 'https://site.api.espn.com/apis';
async function espnGet(p) {
    const r = await fetch(ESPN_BASE + p);
    if (!r.ok) throw new Error(`Veri kaynağı (ESPN) hata verdi (${r.status}).`);
    return r.json();
}
function espnStatus(t) {
    const n = (t && t.name) || '';
    if (n === 'STATUS_POSTPONED') return 'POSTPONED';
    if (n === 'STATUS_CANCELED' || n === 'STATUS_ABANDONED') return 'CANCELLED';
    if (n === 'STATUS_SUSPENDED') return 'SUSPENDED';
    if (t && t.state === 'post') return t.completed ? 'FINISHED' : 'POSTPONED';
    if (t && t.state === 'in') return n === 'STATUS_HALFTIME' ? 'PAUSED' : 'IN_PLAY';
    return 'TIMED';
}
const espnTeam = c => ({ id: +c.team.id, name: c.team.displayName, shortName: c.team.shortDisplayName || c.team.displayName, tla: c.team.abbreviation, crest: c.team.logo || '' });
function espnEvent(e) {
    const c = e.competitions && e.competitions[0];
    const H = c && c.competitors.find(x => x.homeAway === 'home'), A = c && c.competitors.find(x => x.homeAway === 'away');
    if (!H || !A || !H.team || !A.team) return null;
    const status = espnStatus(e.status && e.status.type);
    const has = status === 'FINISHED' || isLiveStatus(status);
    const hs = has && H.score != null && H.score !== '' ? +H.score : null, as = has && A.score != null && A.score !== '' ? +A.score : null;
    return { id: +e.id, utcDate: new Date(e.date).toISOString(), status, matchday: 0, homeTeam: espnTeam(H), awayTeam: espnTeam(A),
        score: { winner: hs == null ? null : hs > as ? 'HOME_TEAM' : hs < as ? 'AWAY_TEAM' : 'DRAW', fullTime: { home: hs, away: as }, halfTime: { home: null, away: null } } };
}
async function espnMatches(code) {
    const head = await espnGet(`/site/v2/sports/soccer/${code}/scoreboard`);
    const L = (head.leagues && head.leagues[0]) || {}, se = L.season || {};
    const start = new Date(se.startDate || L.calendarStartDate || Date.now() - 300 * 864e5).getTime();
    const end = new Date(se.endDate || L.calendarEndDate || Date.now() + 60 * 864e5).getTime();
    const y0 = new Date(start).getUTCFullYear(), y1 = new Date(Math.min(end, Date.now() + 365 * 864e5)).getUTCFullYear();
    const byId = new Map();
    for (let y = y0; y <= y1; y++) {
        const d = await espnGet(`/site/v2/sports/soccer/${code}/scoreboard?dates=${y}&limit=1000`);
        (d.events || []).forEach(e => { const t = new Date(e.date).getTime(); if (t >= start && t <= end) { const m = espnEvent(e); if (m) byId.set(m.id, m); } });
    }
    const matches = [...byId.values()].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
    // ESPN hafta numarası vermiyor: maçları Salı başlangıçlı haftalara göre numaralandır (lig haftaları Cuma-Pazartesi oynanır)
    const wk = m => Math.floor((new Date(m.utcDate).getTime() / 864e5 + 2 + 0.125) / 7);
    const weeks = [...new Set(matches.map(wk))].sort((a, b) => a - b);
    matches.forEach(m => m.matchday = weeks.indexOf(wk(m)) + 1);
    return { competition: { id: code, code, name: L.name || code, emblem: (L.logos && L.logos[0] && L.logos[0].href) || '' },
        resultSet: { count: matches.length, played: matches.filter(m => m.status === 'FINISHED').length }, matches };
}
async function espnStandings(code) {
    const d = await espnGet(`/v2/sports/soccer/${code}/standings`);
    const groups = d.children && d.children.length ? d.children : [d];
    const standings = groups.filter(g => g.standings && g.standings.entries && g.standings.entries.length).map(g => {
        const table = g.standings.entries.map(e => {
            const st = n => { const s = (e.stats || []).find(x => x.name === n); return s ? +s.value || 0 : 0; };
            return { position: st('rank'), team: { id: +e.team.id, name: e.team.displayName, shortName: e.team.shortDisplayName || e.team.displayName,
                    crest: (e.team.logos && e.team.logos[0] && e.team.logos[0].href) || '' },
                playedGames: st('gamesPlayed'), won: st('wins'), draw: st('ties'), lost: st('losses'), points: st('points'),
                goalsFor: st('pointsFor'), goalsAgainst: st('pointsAgainst'), goalDifference: st('pointDifferential') };
        }).sort((a, b) => (a.position || 999) - (b.position || 999) || b.points - a.points || b.goalDifference - a.goalDifference);
        table.forEach((r, i) => { if (!r.position) r.position = i + 1; });
        return { stage: 'REGULAR_SEASON', type: 'TOTAL', group: groups.length > 1 ? g.name || null : null, table };
    });
    return { competition: { id: code, code, name: d.name || code }, standings };
}

const leagueMatches = code => cached('m' + code, liveFlag[code] ? 60e3 : 5 * 60e3, async () => {
    const d = isEspn(code) ? await espnMatches(code) : await fd(`/competitions/${code}/matches`);
    liveFlag[code] = (d.matches || []).some(m => isLiveStatus(m.status));
    return d;
});
function loadAdjustments() {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'duzeltmeler.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') console.log('duzeltmeler.json okunamadı:', e.message); return {}; }
}
const leagueStandings = code => cached('s' + code, 30 * 60e3, () => isEspn(code) ? espnStandings(code) : fd(`/competitions/${code}/standings`));
const okLeague = (req, res) => { if (!LEAGUE_CODES.includes(req.params.leagueId)) { res.status(400).json({ error: 'Geçersiz lig' }); return false; } return true; };

// ---------- Sayfa, ads.txt, sağlık kontrolü ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/ads.txt', (req, res) => res.type('text/plain').send('google.com, pub-8868735664160445, DIRECT, f08c47fec0942fa0\n'));
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/standings/:leagueId', async (req, res) => {
    if (!okLeague(req, res)) return;
    try { res.json(await leagueStandings(req.params.leagueId)); }
    catch (error) { res.status(502).json({ error: error.message }); }
});

// ---------- Gerçek piyasa oranı (The Odds API, isteğe bağlı) -> "Değerli" etiketi ----------
const ODDS_SPORTS = { '2021': 'soccer_epl', '2014': 'soccer_spain_la_liga', '2019': 'soccer_italy_serie_a', '2002': 'soccer_germany_bundesliga', '2015': 'soccer_france_ligue_one', '2001': 'soccer_uefa_champs_league', '2003': 'soccer_netherlands_eredivisie', '2017': 'soccer_portugal_primeira_liga',
    '2016': 'soccer_efl_champ', '2013': 'soccer_brazil_campeonato', 'tur.1': 'soccer_turkey_super_league', 'uefa.europa': 'soccer_uefa_europa_league', 'uefa.europa.conf': 'soccer_uefa_europa_conference_league' };
const STOP = new Set(['fc', 'cf', 'afc', 'ac', 'sc', 'sv', 'ssc', 'as', 'us', 'rc', 'rcd', 'ud', 'cd', 'fk', 'vfl', 'vfb', 'tsg', 'fsv', 'bv', 'sl', 'club', 'de', 'the', 'calcio', '1']);
const toks = s => new Set((s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t && !STOP.has(t)));
const jac = (a, b) => { const i = [...a].filter(x => b.has(x)).length, u = new Set([...a, ...b]).size; return u ? i / u : 0; };
const nameScore = (team, oddsName) => Math.max(...[team.name, team.shortName].filter(Boolean).map(n => jac(toks(n), toks(oddsName))), 0);

async function fetchOdds(code) {
    const url = `https://api.the-odds-api.com/v4/sports/${ODDS_SPORTS[code]}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const events = await r.json();
    return events.map(ev => {
        const over = [], under = [], pOver = [], h2h = [];
        (ev.bookmakers || []).forEach(b => (b.markets || []).forEach(m => {
            if (m.key === 'totals') {
                const o = m.outcomes.find(x => x.name === 'Over' && x.point === 2.5), u = m.outcomes.find(x => x.name === 'Under' && x.point === 2.5);
                if (o && u) { over.push(o.price); under.push(u.price); pOver.push((1 / o.price) / (1 / o.price + 1 / u.price)); }   // marj (vig) çıkarılmış olasılık
            } else if (m.key === 'h2h') {
                const h = m.outcomes.find(x => x.name === ev.home_team), a = m.outcomes.find(x => x.name === ev.away_team), d = m.outcomes.find(x => x.name === 'Draw');
                if (h && a && d) { const t = 1 / h.price + 1 / d.price + 1 / a.price; h2h.push([1 / h.price / t, 1 / d.price / t, 1 / a.price / t]); }
            }
        }));
        const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
        const avgH = i => avg(h2h.map(x => x[i]));
        return { home: ev.home_team, away: ev.away_team, time: new Date(ev.commence_time).getTime(), books: over.length, over: over.length ? avg(over) : null, under: under.length ? avg(under) : null,
            pOver: pOver.length ? avg(pOver) : null, ms: h2h.length >= 3 ? [avgH(0), avgH(1), avgH(2)] : null };
    }).filter(e => e.books >= 3);
}

async function attachMarket(code, matches) {
    if (!ODDS_API_KEY || !ODDS_SPORTS[code]) return matches;
    let events;
    try { events = await cached('o' + code, ODDS_CACHE_MS, () => fetchOdds(code)); }
    catch (e) { console.log('Oran servisi hatası:', e.message); return matches; }
    return matches.map(m => {
        if (!m.prediction) return m;
        const t = new Date(m.utcDate).getTime();
        let best = null, bestScore = 0;
        events.forEach(ev => {
            if (Math.abs(ev.time - t) > 36 * 3600e3) return;
            const h = nameScore(m.homeTeam, ev.home), a = nameScore(m.awayTeam, ev.away);
            if (h >= 0.5 && a >= 0.5 && h + a > bestScore) { best = ev; bestScore = h + a; }
        });
        if (!best) return m;
        const p = m.prediction, value = [];
        [['over25', best.over], ['under25', best.under]].forEach(([k, odd]) => {
            const edge = p[k] / 100 * odd - 1;
            if (edge >= VALUE_EDGE && edge <= 0.30) value.push({ key: k, odd: +odd.toFixed(2), edge: Math.round(edge * 100) });   // %30 üstü genelde model/eşleşme hatasıdır
        });
        return { ...m, prediction: { ...p, market: { over25: +best.over.toFixed(2), under25: +best.under.toFixed(2), books: best.books,
            // Bahis şirketlerinin marjsız ortalama olasılığı (%), sitede "Piyasa %" olarak gösterilir
            po25: best.pOver != null ? Math.round(best.pOver * 100) : null, pu25: best.pOver != null ? 100 - Math.round(best.pOver * 100) : null,
            pms1: best.ms ? Math.round(best.ms[0] * 100) : null, pmsX: best.ms ? Math.round(best.ms[1] * 100) : null, pms2: best.ms ? Math.round(best.ms[2] * 100) : null }, value } };
    });
}

// ---------- Sakat / cezalı oyuncu bilgisi (API-Football, isteğe bağlı). Olasılıkları DEĞİŞTİRMEZ, sadece gösterir ----------
const APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY || '';
const AF_LEAGUES = { '2021': 39, '2014': 140, '2019': 135, '2002': 78, '2015': 61, '2001': 2, '2003': 88, '2017': 94,
    '2016': 40, '2013': 71, 'tur.1': 203, 'uefa.nations': 5, 'uefa.europa': 3, 'uefa.europa.conf': 848 };
const AF_SEASON = parseInt(process.env.AF_SEASON) || (new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1);
async function fetchInjuries(code) {
    const r = await fetch(`https://v3.football.api-sports.io/injuries?league=${AF_LEAGUES[code]}&season=${AF_SEASON}`, { headers: { 'x-apisports-key': APIFOOTBALL_KEY } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data.errors && Object.keys(data.errors).length) throw new Error(JSON.stringify(data.errors));   // api-sports hataları 200 ile döner
    const since = Date.now() - 36 * 3600e3;
    return (data.response || []).filter(x => x.fixture && new Date(x.fixture.date).getTime() >= since && x.team && x.player)
        .map(x => ({ team: x.team.name, ad: String(x.player.name || '').slice(0, 40), tur: x.player.type, neden: String(x.player.reason || '').slice(0, 40), t: new Date(x.fixture.date).getTime() }));
}
async function attachInjuries(code, matches) {
    if (!APIFOOTBALL_KEY || !AF_LEAGUES[code]) return matches;
    let list;
    try { list = await cached('i' + code, 12 * 3600e3, () => fetchInjuries(code)); }
    catch (e) { console.log('Sakatlık servisi hatası:', e.message); return matches; }
    return matches.map(m => {
        if (!m.prediction) return m;
        const t = new Date(m.utcDate).getTime();
        const pick = team => list.filter(x => Math.abs(x.t - t) <= 36 * 3600e3 && nameScore(team, x.team) >= 0.5).slice(0, 8).map(x => ({ ad: x.ad, tur: x.tur, neden: x.neden }));
        const home = pick(m.homeTeam), away = pick(m.awayTeam);
        return home.length || away.length ? { ...m, prediction: { ...m.prediction, injuries: { home, away } } } : m;
    });
}

const analyzedLeague = code => cached('a' + code, liveFlag[code] ? 60e3 : 5 * 60e3, async () => {
    const data = await leagueMatches(code);
    let ms = analyzeMatches(data.matches, loadAdjustments());
    ms = await attachMarket(code, ms);
    ms = await attachInjuries(code, ms);
    return { competition: data.competition, resultSet: data.resultSet, matches: ms };
});

app.get('/api/matches/:leagueId', async (req, res) => {
    if (!okLeague(req, res)) return;
    try { res.json(await analyzedLeague(req.params.leagueId)); }
    catch (error) { res.status(502).json({ error: error.message }); }
});

// İdeal kuponlar: sunucu kendi önbelleğindeki analizlerden üretir (mode: dengeli | yuksek)
app.get('/api/ideal', async (req, res) => {
    const mode = req.query.mode === 'yuksek' ? 'yuksek' : 'dengeli';
    try {
        res.json(await cached('ideal' + mode, 5 * 60e3, async () => {
            const rs = await Promise.allSettled(LEAGUE_CODES.map(analyzedLeague));
            const leagues = LEAGUE_CODES.map((code, i) => ({ code, matches: rs[i].status === 'fulfilled' ? rs[i].value.matches : [] }));
            if (rs.every(r => r.status === 'rejected')) throw new Error(rs[0].reason && rs[0].reason.message || 'Veri alınamadı');
            return buildIdealCoupons(leagues, mode, Date.now());
        }));
    } catch (error) { res.status(502).json({ error: error.message }); }
});

// ========== POISSON TAHMİN MODELİ ==========
// Her takımın ev/deplasman gol gücünden beklenen golü bulur, sonra skor ihtimalleri
// tablosundan MS, çifte şans, alt/üst ve KG değerlerini TEK kaynaktan türetir.
const MAX_GOALS = 10;
const DC_RHO = -0.08;   // Dixon-Coles düşük skor düzeltmesi (0-0 ve 1-1 biraz artar)
const HALF_LIFE_DAYS = parseFloat(process.env.HALF_LIFE_DAYS) || 0;  // 0 = kapalı. >0 ise eski maçların ağırlığı bu kadar günde yarıya düşer
const SHRINK = 5;       // az maçı olan takımı lig ortalamasına doğru çeker
const FORM_WEIGHT = 0.05; // son 5 maç formunun beklenen gole etkisi (en fazla ±%5)

function poissonPmf(lambda) {
    const out = [Math.exp(-lambda)];
    for (let k = 1; k <= MAX_GOALS; k++) out.push(out[k - 1] * lambda / k);
    return out;
}

function scoreMatrix(lh, la) {
    const ph = poissonPmf(lh), pa = poissonPmf(la);
    const m = []; let sum = 0;
    for (let i = 0; i <= MAX_GOALS; i++) {
        m[i] = [];
        for (let j = 0; j <= MAX_GOALS; j++) {
            let tau = 1;
            if (i === 0 && j === 0) tau = 1 - lh * la * DC_RHO;
            else if (i === 0 && j === 1) tau = 1 + lh * DC_RHO;
            else if (i === 1 && j === 0) tau = 1 + la * DC_RHO;
            else if (i === 1 && j === 1) tau = 1 - DC_RHO;
            m[i][j] = ph[i] * pa[j] * tau;
            sum += m[i][j];
        }
    }
    for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) m[i][j] /= sum;
    return m;
}

function buildTeamStats(matches, refDate) {
    const t = {}; let hg = 0, ag = 0, n = 0; const list = [];
    const ref = refDate ? new Date(refDate).getTime() : Date.now();
    const wOf = d => HALF_LIFE_DAYS > 0 ? Math.pow(0.5, Math.max(0, (ref - new Date(d).getTime()) / 864e5) / HALF_LIFE_DAYS) : 1;
    const get = name => t[name] || (t[name] = { form: [], games: [], hGF: 0, hGA: 0, hN: 0, aGF: 0, aGA: 0, aN: 0 });
    const finished = matches
        .filter(m => m.status === 'FINISHED' && m.score && m.score.fullTime && m.score.fullTime.home !== null && m.score.fullTime.away !== null)
        .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
    finished.forEach(match => {
        const H = get(match.homeTeam.shortName), A = get(match.awayTeam.shortName);
        const hs = match.score.fullTime.home, as = match.score.fullTime.away;
        const w = wOf(match.utcDate);
        H.hGF += hs * w; H.hGA += as * w; H.hN += w;
        A.aGF += as * w; A.aGA += hs * w; A.aN += w;
        H.form.push(hs > as ? 'G' : hs < as ? 'M' : 'B');
        A.form.push(as > hs ? 'G' : as < hs ? 'M' : 'B');
        const ht = match.score.halfTime && match.score.halfTime.home != null && match.score.halfTime.away != null ? match.score.halfTime.home + match.score.halfTime.away : null;
        H.games.push({ opp: match.awayTeam.shortName, gf: hs, ga: as, home: true, ht });
        A.games.push({ opp: match.homeTeam.shortName, gf: as, ga: hs, home: false, ht });
        list.push({ d: match.utcDate, h: match.homeTeam.shortName, a: match.awayTeam.shortName, hs, as });
        hg += hs * w; ag += as * w; n += w;
    });
    return { teams: t, avgHome: n ? hg / n : 1.5, avgAway: n ? ag / n : 1.2, finished: list };
}

const formScore = form => form.slice(-5).reduce((s, r) => s + (r === 'G' ? 3 : r === 'B' ? 1 : 0), 0);
const formFactor = fs => 1 + Math.max(-1, Math.min(1, (fs - 7) / 8)) * FORM_WEIGHT;
const clampP = x => Math.max(1, Math.min(98, x));
const pct = x => Math.round(x * 100);

function teamSummary(T) {
    const part = arr => ({
        n: arr.length,
        w: arr.filter(x => x.gf > x.ga).length, d: arr.filter(x => x.gf === x.ga).length, l: arr.filter(x => x.gf < x.ga).length,
        gf: arr.reduce((a, x) => a + x.gf, 0), ga: arr.reduce((a, x) => a + x.ga, 0),
        o25: arr.filter(x => x.gf + x.ga >= 3).length,
        o15: arr.filter(x => x.gf + x.ga >= 2).length,
        u35: arr.filter(x => x.gf + x.ga <= 3).length,
        htn: arr.filter(x => x.ht != null).length, ht05: arr.filter(x => x.ht != null && x.ht >= 1).length,
        btts: arr.filter(x => x.gf > 0 && x.ga > 0).length,
        cs: arr.filter(x => x.ga === 0).length
    });
    const g = T.games || [];
    return { all: part(g), home: part(g.filter(x => x.home)), away: part(g.filter(x => !x.home)), last5: g.slice(-5) };
}

function predictMatch(home, away, league, homeStats, awayStats, adj) {
    const { avgHome, avgAway } = league;
    const strength = (sum, cnt, avg) => (sum + SHRINK * avg) / (cnt + SHRINK) / avg;
    const empty = { form: [], games: [], hGF: 0, hGA: 0, hN: 0, aGF: 0, aGA: 0, aN: 0 };
    const H = homeStats || empty, A = awayStats || empty;
    const homeAtt = strength(H.hGF, H.hN, avgHome), homeDef = strength(H.hGA, H.hN, avgAway);
    const awayAtt = strength(A.aGF, A.aN, avgAway), awayDef = strength(A.aGA, A.aN, avgHome);
    let lh = avgHome * homeAtt * awayDef * formFactor(formScore(H.form));
    let la = avgAway * awayAtt * homeDef * formFactor(formScore(A.form));
    // Elle girilen düzeltmeler (duzeltmeler.json): sakat/cezalı, hava, saha durumu gibi. Backtest EDİLMEZ.
    const notes = [];
    const cl = x => Math.max(-0.3, Math.min(0.3, +x || 0));
    const live = x => x && typeof x === 'object' && (!x.bitis || new Date(x.bitis + 'T23:59:59') >= new Date());
    const clean = t => String(t).replace(/[<>"'`]/g, '').slice(0, 80);
    const tA = (adj && adj.takimlar) || {}, mA = (adj && adj.maclar) || {};
    if (live(tA[home])) { lh *= 1 + cl(tA[home].atak); la *= 1 + cl(tA[home].savunma); if (tA[home].not) notes.push(clean(home + ': ' + tA[home].not)); }
    if (live(tA[away])) { la *= 1 + cl(tA[away].atak); lh *= 1 + cl(tA[away].savunma); if (tA[away].not) notes.push(clean(away + ': ' + tA[away].not)); }
    const mk = mA[home + '-' + away];
    if (live(mk)) { lh *= 1 + cl(mk.gol); la *= 1 + cl(mk.gol); if (mk.not) notes.push(clean(mk.not)); }
    lh = Math.max(0.25, Math.min(4, lh)); la = Math.max(0.25, Math.min(4, la));

    const m = scoreMatrix(lh, la);
    let pH = 0, pD = 0, pA = 0, pBtts = 0;
    const totals = new Array(2 * MAX_GOALS + 1).fill(0);
    for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) {
        const p = m[i][j];
        if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
        if (i > 0 && j > 0) pBtts += p;
        totals[i + j] += p;
    }
    const over = line => { let s = 0; for (let k = Math.floor(line) + 1; k < totals.length; k++) s += totals[k]; return s; };

    const joint = fn => { let sum = 0; for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) if (fn(i, j)) sum += m[i][j]; return sum; };
    const combos = {
        ms1_o15: joint((i, j) => i > j && i + j >= 2), ms1_o25: joint((i, j) => i > j && i + j >= 3), ms1_u35: joint((i, j) => i > j && i + j <= 3),
        ms2_o15: joint((i, j) => j > i && i + j >= 2), ms2_o25: joint((i, j) => j > i && i + j >= 3), ms2_u35: joint((i, j) => j > i && i + j <= 3),
        dc1x_o15: joint((i, j) => i >= j && i + j >= 2), dcx2_o15: joint((i, j) => j >= i && i + j >= 2), dc12_o15: joint((i, j) => i !== j && i + j >= 2),
        ms1_kg: joint((i, j) => i > j && j > 0), ms1_kgyok: joint((i, j) => i > j && j === 0),
        ms2_kg: joint((i, j) => j > i && i > 0), ms2_kgyok: joint((i, j) => j > i && i === 0)
    };
    Object.keys(combos).forEach(k => combos[k] = clampP(pct(combos[k])));
    const h2h = (league.finished || []).filter(x => (x.h === home && x.a === away) || (x.h === away && x.a === home)).slice(-5);

    let ms1 = clampP(pct(pH)), msX = clampP(pct(pD)), ms2 = 100 - ms1 - msX;
    if (ms2 < 1) { ms2 = 1; ms1 = 100 - msX - 1; }
    // Kalibrasyon düzeltmesi (8.567 maçlık backtest'e göre): model uçlarda fazla iddialıydı, olasılıklar 50'ye doğru çekilir.
    const shr = (x, k) => clampP(Math.round(50 + k * (pct(x) - 50)));
    const over15 = shr(over(1.5), 0.9), over25 = shr(over(2.5), 0.9);
    const over35 = shr(over(3.5), 0.9), over45 = shr(over(4.5), 0.9);
    const kgVar = shr(pBtts, 0.45);

    let fav;
    if (ms1 > ms2 + 15) fav = `${home} (MS 1)`;
    else if (ms2 > ms1 + 15) fav = `${away} (MS 2)`;
    else if (msX > Math.max(ms1, ms2)) fav = 'Beraberlik (MS X)';
    else fav = 'Dengeli';

    return {
        ms1, msX, ms2, fav,
        doubleChance1X: ms1 + msX, doubleChance12: ms1 + ms2, doubleChanceX2: msX + ms2,
        over15, under15: 100 - over15, over25, under25: 100 - over25,
        over35, under35: 100 - over35, over45, under45: 100 - over45,
        kgVar, kgYok: 100 - kgVar,
        adjust: notes.length ? notes : undefined,
        combos, stats: { home: teamSummary(H), away: teamSummary(A), h2h },
        expectedHomeGoals: lh.toFixed(1), expectedAwayGoals: la.toFixed(1),
        homeForm: H.form.slice(-5).join('') || '----',
        awayForm: A.form.slice(-5).join('') || '----'
    };
}

function analyzeMatches(matches, adj) {
    const league = buildTeamStats(matches);
    return matches.map(match => {
        const home = match.homeTeam.shortName;
        const away = match.awayTeam.shortName;
        if (match.status === 'FINISHED') return { ...match, prediction: null, result: `${match.score.fullTime.home} - ${match.score.fullTime.away}` };
        return { ...match, prediction: predictMatch(home, away, league, league.teams[home], league.teams[away], adj) };
    });
}


// ========== İDEAL KUPON MOTORU ==========
// Her maç için "model + bahis şirketleri + takımın bu sezonki istatistiği" birlikte destekleyen en iyi bahsi seçer,
// sonra bunlardan lig, gün ve hafta kuponları kurar. Kazanç garantisi vermez; olasılıklar tahmindir.
// Oran hesabı index.html'deki calculateBookmakerOdd ile AYNI olmalı (kesinti değerlerini ikisinde birlikte değiştir).
const ODD_MARGIN = { x12: 0.091, two: 0.076, other: 0.091 };
const IDEAL_MIN_ODD = 1.10, IDEAL_MIN_ODD_FAV = 1.03;
function idealOdd(probPct, kind, fav) {
    const p = Math.min(99, Math.max(1, probPct)) / 100;
    return +Math.max(fav ? IDEAL_MIN_ODD_FAV : IDEAL_MIN_ODD, 1 / (p * (1 + ODD_MARGIN[kind]))).toFixed(2);
}
const IDEAL_MODES = {
    dengeli: { minConf: 60, minOdd: 1.25, tol: 4, maxDis: 10, legsLeague: 4, legsDay: 4, legsWeek: 6, byOdd: false },
    yuksek:  { minConf: 48, minOdd: 1.50, tol: 10, maxDis: 12, legsLeague: 4, legsDay: 4, legsWeek: 6, byOdd: true }
};
const IDEAL_LEAGUES = { '2015': ['Ligue 1', '🇫🇷'], '2021': ['Premier League', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'], '2014': ['La Liga', '🇪🇸'], '2002': ['Bundesliga', '🇩🇪'], '2019': ['Serie A', '🇮🇹'], '2001': ['Şampiyonlar Ligi', '🇪🇺'], '2003': ['Eredivisie', '🇳🇱'], '2017': ['Primeira Liga', '🇵🇹'],
    '2016': ['Championship', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'], '2013': ['Brasileirão', '🇧🇷'], 'tur.1': ['Süper Lig', '🇹🇷'], 'uefa.nations': ['Uluslar Ligi', '🇪🇺'], 'uefa.europa': ['Avrupa Ligi', '🇪🇺'], 'uefa.europa.conf': ['Konferans Ligi', '🇪🇺'] };

// Tekli bahisler: k = sitedeki bahis anahtarı, pk = tahmin alanı, hit = sonuç kontrolü
const IDEAL_SINGLES = {
    MS1:     { label: 'MS 1',     kind: 'x12',   fav: true,  get: p => p.ms1,            mkt: m => m.pms1,                hit: (h, a) => h > a },
    MS2:     { label: 'MS 2',     kind: 'x12',   fav: true,  get: p => p.ms2,            mkt: m => m.pms2,                hit: (h, a) => a > h },
    DC1X:    { label: '1X',       kind: 'other', fav: true,  get: p => p.doubleChance1X, mkt: m => m.pms1 != null ? m.pms1 + m.pmsX : null, hit: (h, a) => h >= a },
    DCX2:    { label: 'X2',       kind: 'other', fav: true,  get: p => p.doubleChanceX2, mkt: m => m.pms2 != null ? m.pms2 + m.pmsX : null, hit: (h, a) => a >= h },
    OVER15:  { label: '1.5 Üst',  kind: 'two',   fav: false, get: p => p.over15,         mkt: null,                       hit: (h, a) => h + a > 1.5 },
    OVER25:  { label: '2.5 Üst',  kind: 'two',   fav: false, get: p => p.over25,         mkt: m => m.po25,                hit: (h, a) => h + a > 2.5 },
    UNDER25: { label: '2.5 Alt',  kind: 'two',   fav: false, get: p => p.under25,        mkt: m => m.pu25,                hit: (h, a) => h + a < 2.5 },
    UNDER35: { label: '3.5 Alt',  kind: 'two',   fav: false, get: p => p.under35,        mkt: null,                       hit: (h, a) => h + a < 3.5 },
    KG:      { label: 'KG Var',   kind: 'two',   fav: false, get: p => p.kgVar,          mkt: null,                       hit: (h, a) => h > 0 && a > 0 },
    KG_YOK:  { label: 'KG Yok',   kind: 'two',   fav: false, get: p => p.kgYok,          mkt: null,                       hit: (h, a) => h === 0 || a === 0 }
};
// Kombolar (tahmindeki combos alanından): bileşenleri tekli bahislerdir
const IDEAL_COMBOS = {
    MS1_O15: ['MS1', 'OVER15'], MS1_O25: ['MS1', 'OVER25'], MS1_KG: ['MS1', 'KG'], MS1_U35: ['MS1', 'UNDER35'],
    MS2_O15: ['MS2', 'OVER15'], MS2_O25: ['MS2', 'OVER25'], MS2_KG: ['MS2', 'KG'], MS2_U35: ['MS2', 'UNDER35'],
    DC1X_O15: ['DC1X', 'OVER15'], DCX2_O15: ['DCX2', 'OVER15']
};
const idealHit = (k, h, a) => IDEAL_SINGLES[k] ? IDEAL_SINGLES[k].hit(h, a) : IDEAL_COMBOS[k].every(c => IDEAL_SINGLES[c].hit(h, a));
const idealLabel = k => IDEAL_SINGLES[k] ? IDEAL_SINGLES[k].label : IDEAL_COMBOS[k].map(c => IDEAL_SINGLES[c].label).join(' & ');

// Takımın bu sezonki istatistiğinden bir bahsi destekleyen oranlar (ev sahibi evde, deplasman deplasmanda). n < 4 ise kanıt yok.
function idealEvidence(k, ctx) {
    const { h, a, H, A } = ctx;
    if (!H || !A || H.n < 4 || A.n < 4) return null;
    const rt = (x, n) => x / n, P = x => Math.round(x * 100) + '%';
    const one = {
        MS1:  () => [rt(H.w, H.n), rt(A.l, A.n), `${h} evde ${H.n} maçın ${H.w}'ini kazandı (${H.w}-${H.d}-${H.l}), ${a} deplasmanda ${A.n} maçın ${A.l}'ini kaybetti`],
        MS2:  () => [rt(A.w, A.n), rt(H.l, H.n), `${a} deplasmanda ${A.n} maçın ${A.w}'ini kazandı, ${h} evde ${H.n} maçın ${H.l}'ini kaybetti`],
        DC1X: () => [rt(H.w + H.d, H.n), rt(A.l + A.d, A.n), `${h} evde ${H.n} maçta yenilmedi oranı ${P(rt(H.w + H.d, H.n))}, ${a} deplasmanda kazanamama oranı ${P(rt(A.l + A.d, A.n))}`],
        DCX2: () => [rt(A.w + A.d, A.n), rt(H.l + H.d, H.n), `${a} deplasmanda yenilmedi oranı ${P(rt(A.w + A.d, A.n))}, ${h} evde kazanamama oranı ${P(rt(H.l + H.d, H.n))}`],
        OVER15: () => [rt(H.o15, H.n), rt(A.o15, A.n), `1.5 Üst: ${h} evde %${Math.round(rt(H.o15, H.n) * 100)}, ${a} deplasmanda %${Math.round(rt(A.o15, A.n) * 100)}`],
        OVER25: () => [rt(H.o25, H.n), rt(A.o25, A.n), `2.5 Üst: ${h} evde ${P(rt(H.o25, H.n))}, ${a} deplasmanda ${P(rt(A.o25, A.n))} (ort. gol ${(H.gf / H.n).toFixed(1)}+${(H.ga / H.n).toFixed(1)} ve ${(A.gf / A.n).toFixed(1)}+${(A.ga / A.n).toFixed(1)})`],
        UNDER25: () => [1 - rt(H.o25, H.n), 1 - rt(A.o25, A.n), `2.5 Alt: ${h} evde ${P(1 - rt(H.o25, H.n))}, ${a} deplasmanda ${P(1 - rt(A.o25, A.n))}`],
        UNDER35: () => [rt(H.u35, H.n), rt(A.u35, A.n), `3.5 Alt: ${h} evde ${P(rt(H.u35, H.n))}, ${a} deplasmanda ${P(rt(A.u35, A.n))}`],
        KG:   () => [rt(H.btts, H.n), rt(A.btts, A.n), `KG Var: ${h} evde ${P(rt(H.btts, H.n))}, ${a} deplasmanda ${P(rt(A.btts, A.n))}`],
        KG_YOK: () => [1 - rt(H.btts, H.n), 1 - rt(A.btts, A.n), `KG Yok: ${h} evde ${P(1 - rt(H.btts, H.n))}, ${a} deplasmanda ${P(1 - rt(A.btts, A.n))}`]
    };
    const parts = IDEAL_COMBOS[k] || [k];
    const rows = parts.map(c => one[c]());
    const f = Math.min(...rows.map(r => (r[0] + r[1]) / 2));   // kombo: en zayıf bileşen belirler
    return { f, texts: rows.map(r => r[2]) };
}

function idealCandidates(p, h, a, M) {
    const ctx = p.stats ? { h, a, H: p.stats.home && p.stats.home.home, A: p.stats.away && p.stats.away.away } : { h, a };
    const mk = p.market || null;
    const defs = [...Object.keys(IDEAL_SINGLES).map(k => ({ k, ...IDEAL_SINGLES[k], prob: IDEAL_SINGLES[k].get(p),
            mp: mk && IDEAL_SINGLES[k].mkt ? IDEAL_SINGLES[k].mkt(mk) : null })),
        ...Object.keys(IDEAL_COMBOS).filter(k => p.combos && p.combos[k.toLowerCase()] !== undefined).map(k => {
            const first = IDEAL_SINGLES[IDEAL_COMBOS[k][0]];
            return { k, label: idealLabel(k), kind: 'other', fav: false, prob: p.combos[k.toLowerCase()], mp: null };
        })];
    const out = [];
    defs.forEach(d => {
        if (d.prob == null || isNaN(d.prob)) return;
        const ev = idealEvidence(d.k, ctx);
        const evPct = ev ? ev.f * 100 : null;
        if (d.mp != null && Math.abs(d.prob - d.mp) > M.maxDis) return;          // model ile bahis şirketleri ayrışıyorsa alma
        if (evPct != null && evPct < d.prob - 15) return;                          // takımın sezon istatistiği tahminin çok altındaysa alma
        let conf;
        if (d.mp != null) conf = 0.5 * d.mp + 0.3 * d.prob + 0.2 * (evPct != null ? evPct : d.prob);
        else if (evPct != null) conf = 0.7 * d.prob + 0.3 * evPct;
        else conf = d.prob - 4;                                                    // kanıt yoksa küçük ceza
        const odd = idealOdd(d.prob, d.kind, d.fav);
        if (conf < M.minConf || odd < M.minOdd) return;
        out.push({ k: d.k, label: d.label, prob: d.prob, conf: +conf.toFixed(1), odd, market: d.mp, evidence: ev });
    });
    return out;
}

// Bir maç için tek seçim: güveni en yüksek bahse yakın olanlar arasında oranı en yüksek olan
function idealPick(p, h, a, M) {
    const c = idealCandidates(p, h, a, M);
    if (!c.length) return null;
    const best = Math.max(...c.map(x => x.conf));
    const pool = c.filter(x => x.conf >= best - M.tol).sort((x, y) => y.odd - x.odd || y.conf - x.conf);
    return pool[0];
}

function idealReasons(pick, p, h, a) {
    const r = [];
    if (pick.evidence) pick.evidence.texts.forEach(t => r.push(t));
    else r.push('Bu iki takımın bu sezon yeterli ev/deplasman maçı yok, sadece model tahmini kullanıldı.');
    r.push(`Model: ${pick.label} %${pick.prob}` + (pick.market != null ? `, bahis şirketleri ortalaması %${pick.market}` : '') + `. Beklenen gol ${p.expectedHomeGoals} - ${p.expectedAwayGoals}.`);
    r.push(`Son 5 maç: ${h} ${p.homeForm}, ${a} ${p.awayForm}.`);
    const H = p.stats && p.stats.home.home, A = p.stats && p.stats.away.away;
    if (H && A && H.htn >= 4 && A.htn >= 4) r.push(`İlk yarıda gol görülme oranı (bilgi): ${h} evde %${Math.round(H.ht05 / H.htn * 100)}, ${a} deplasmanda %${Math.round(A.ht05 / A.htn * 100)}.`);
    const inj = p.injuries;
    if (inj) { const n1 = inj.home.filter(x => x.tur !== 'Questionable').length, n2 = inj.away.filter(x => x.tur !== 'Questionable').length; if (n1 || n2) r.push(`⚠️ Eksik oyuncu bilgisi var (${h}: ${n1}, ${a}: ${n2}), kupondan önce kadroyu kontrol et.`); }
    return r;
}

const trDay = iso => new Date(new Date(iso).getTime() + 3 * 3600e3).toISOString().slice(0, 10);   // Türkiye saati (UTC+3)

function idealAssemble(picks, maxLegs, minLegs, M, meta) {
    if (picks.length < minLegs) return null;
    const score = x => M.byOdd ? x.conf / 100 * x.odd : x.conf;
    const legs = picks.slice().sort((x, y) => score(y) - score(x)).slice(0, maxLegs).sort((x, y) => x.t - y.t);
    const totalOdd = +legs.reduce((s, x) => s * x.odd, 1).toFixed(2);
    const jointModel = +(legs.reduce((s, x) => s * x.prob / 100, 1) * 100).toFixed(1);
    const jointConf = +(legs.reduce((s, x) => s * x.conf / 100, 1) * 100).toFixed(1);
    return { ...meta, legs, totalOdd, jointModel, jointConf };
}

function buildIdealCoupons(leagues, mode, nowMs) {
    const M = IDEAL_MODES[mode] || IDEAL_MODES.dengeli;
    const horizon = nowMs + 7 * 864e5;
    const picks = [];
    leagues.forEach(L => (L.matches || []).forEach(m => {
        if (!m.prediction || (m.status !== 'TIMED' && m.status !== 'SCHEDULED')) return;
        const t = new Date(m.utcDate).getTime(); if (t < nowMs || t > horizon) return;
        const h = m.homeTeam.shortName, a = m.awayTeam.shortName;
        const pk = idealPick(m.prediction, h, a, M); if (!pk) return;
        const [ln, lf] = IDEAL_LEAGUES[L.code] || [L.name || '', ''];
        picks.push({ matchId: m.id, matchName: `${h} - ${a}`, leagueCode: L.code, leagueName: ln, leagueFlag: lf, utcDate: m.utcDate, t, day: trDay(m.utcDate),
            betType: pk.k, betLabel: pk.label, pickName: pk.k === 'MS1' ? h : pk.k === 'MS2' ? a : pk.k.startsWith('OVER') ? 'Üst' : pk.k.startsWith('UNDER') ? 'Alt' : pk.label,
            prob: pk.prob, conf: pk.conf, odd: pk.odd, market: pk.market, reasons: idealReasons(pk, m.prediction, h, a) });
    }));
    const coupons = [];
    const week = idealAssemble(picks, M.legsWeek, 3, M, { id: 'karma-hafta', scope: 'week', title: 'Karma Hafta Kuponu', sub: 'Tüm liglerden, önümüzdeki 7 günün en güçlü seçimleri' });
    if (week) coupons.push(week);
    [...new Set(picks.map(x => x.day))].sort().slice(0, 4).forEach(day => {
        const c = idealAssemble(picks.filter(x => x.day === day), M.legsDay, 3, M, { id: 'gun-' + day, scope: 'day', day, title: 'Günün Kuponu', sub: 'Aynı günün maçlarından' });
        if (c) coupons.push(c);
    });
    const empty = [];
    leagues.forEach(L => {
        const c = idealAssemble(picks.filter(x => x.leagueCode === L.code), M.legsLeague, 2, M, { id: 'lig-' + L.code, scope: 'league', leagueCode: L.code, leagueName: (IDEAL_LEAGUES[L.code] || [L.name])[0], leagueFlag: (IDEAL_LEAGUES[L.code] || ['', ''])[1], title: (IDEAL_LEAGUES[L.code] || [L.name])[0], sub: 'Önümüzdeki 7 gün' });
        if (c) coupons.push(c); else empty.push({ leagueCode: L.code, leagueName: (IDEAL_LEAGUES[L.code] || [L.name])[0], leagueFlag: (IDEAL_LEAGUES[L.code] || ['', ''])[1] });
    });
    return { mode, generated: new Date(nowMs).toISOString(), pickCount: picks.length, coupons, empty };
}


// ---------- Telegram (yalnızca TELEGRAM_ENABLED=true ise; herkese açık sitede kapalı kalır) ----------
const tgOff = res => res.status(403).json({ success: false, ok: false, disabled: true, error: 'Telegram bu sunucuda kapalı.' });

app.post('/api/telegram/send', async (req, res) => {
    if (!TELEGRAM_ENABLED || !TELEGRAM_BOT_TOKEN) return tgOff(res);
    const message = typeof req.body.message === 'string' ? req.body.message.slice(0, 4000) : '';
    if (!message) return res.status(400).json({ success: false, error: 'Mesaj boş' });
    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true })
        });
        const data = await response.json();
        if (data.ok) res.json({ success: true }); else res.status(500).json({ success: false, error: data.description });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/telegram/test', async (req, res) => {
    if (!TELEGRAM_ENABLED || !TELEGRAM_BOT_TOKEN) return tgOff(res);
    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
        const data = await response.json();
        res.json({ ok: !!data.ok });   // bot bilgilerini dışarı vermiyoruz
    } catch (error) { res.status(500).json({ ok: false }); }
});

app.post('/api/check-results', async (req, res) => {
    const ids = Array.isArray(req.body.matchIds) ? req.body.matchIds.filter(Number.isInteger).slice(0, 100) : null;
    if (!ids) return res.status(400).json({ error: 'matchIds gerekli' });
    const results = {};
    const all = await Promise.allSettled(LEAGUE_CODES.map(leagueMatches));   // önbellekten okunur, API'yi yormaz
    if (all.every(x => x.status === 'rejected')) return res.status(502).json({ error: 'Veri kaynağına ulaşılamadı.' });
    all.forEach(x => {
        if (x.status !== 'fulfilled' || !x.value.matches) return;
        x.value.matches.forEach(m => {
            if (ids.includes(m.id)) results[m.id] = { status: m.status, homeScore: m.score.fullTime.home, awayScore: m.score.fullTime.away, winner: m.score.winner };
        });
    });
    res.json({ results });
});

// ---------- Sunucu tarafı kupon takibi (sayfa kapalıyken de Telegram'a haber verir) ----------
// Sayfa, kupondaki bahisleri /api/watch ile buraya bildirir. Sunucu maçları dakikada bir kontrol eder,
// bahis tutunca ya da yatınca Telegram'a yazar. Yalnızca TELEGRAM_ENABLED=true olan sunucuda çalışır.
const WATCH_FILE = path.join(__dirname, 'izlenen.json');
const escH = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
let watchState = { legs: {}, done: {} };   // legs: anahtar -> bahis, done: anahtar -> 'won' | 'lost' (bildirildi)
try { const j = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8')); if (j && j.legs && j.done) watchState = j; } catch (e) {}
const saveWatch = () => { try { fs.writeFileSync(WATCH_FILE, JSON.stringify(watchState)); } catch (e) {} };

async function sendTelegram(text) {
    if (!TELEGRAM_ENABLED || !TELEGRAM_BOT_TOKEN) return false;
    try {
        const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: String(text).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true })
        });
        return !!(await r.json()).ok;
    } catch (e) { console.log('Telegram gönderilemedi:', e.message); return false; }
}

// index.html'deki betWon ile AYNI olmalı
function betWonSrv(type, hs, as) {
    const t = hs + as;
    switch (type) {
        case 'MS1': return hs > as; case 'MSX': return hs === as; case 'MS2': return as > hs;
        case 'DC1X': return hs >= as; case 'DC12': return hs !== as; case 'DCX2': return as >= hs;
        case 'OVER15': return t > 1.5; case 'UNDER15': return t < 1.5;
        case 'OVER25': return t > 2.5; case 'UNDER25': return t < 2.5;
        case 'OVER35': return t > 3.5; case 'UNDER35': return t < 3.5;
        case 'OVER45': return t > 4.5; case 'UNDER45': return t < 4.5;
        case 'KG': return hs > 0 && as > 0; case 'KG_YOK': return hs === 0 || as === 0;
    }
    const m = /^(MS1|MS2|DC1X|DCX2|DC12)_(O15|O25|U35|KG|KGYOK)$/.exec(type);
    if (!m) return false;
    const r = { MS1: hs > as, MS2: as > hs, DC1X: hs >= as, DCX2: as >= hs, DC12: hs !== as }[m[1]];
    const c = { O15: t > 1.5, O25: t > 2.5, U35: t < 3.5, KG: hs > 0 && as > 0, KGYOK: hs === 0 || as === 0 }[m[2]];
    return r && c;
}
// Maç bitmeden kesin tutmuş sayılan bahisler (gol sayısı çizgiyi geçti, iki takım da attı)
const instantWinSrv = (type, hs, as) => ['OVER15', 'OVER25', 'OVER35', 'OVER45'].includes(type) ? betWonSrv(type, hs, as) : type === 'KG' ? hs > 0 && as > 0 : false;

app.post('/api/watch', (req, res) => {
    if (!TELEGRAM_ENABLED || !TELEGRAM_BOT_TOKEN) return tgOff(res);
    const arr = Array.isArray(req.body.legs) ? req.body.legs.slice(0, 60) : null;
    if (!arr) return res.status(400).json({ success: false, error: 'legs gerekli' });
    const legs = {};
    arr.forEach(l => {
        if (!Number.isInteger(l.matchId) || typeof l.betType !== 'string') return;
        const key = l.matchId + ':' + l.betType;
        legs[key] = { matchId: l.matchId, betType: l.betType.slice(0, 20), matchName: String(l.matchName || '').slice(0, 80), betLabel: String(l.betLabel || '').slice(0, 40),
            pickName: String(l.pickName || '').slice(0, 40), odd: Number(l.odd) || 0, g: String(l.g || '').slice(0, 40), gOdd: Number(l.gOdd) || 0 };
        // Sayfa sonucu zaten biliyorsa tekrar bildirme
        if (l.rs === 'won' || l.rs === 'lost') watchState.done[key] = l.rs;
    });
    watchState.legs = legs;
    saveWatch();
    res.json({ success: true, count: Object.keys(legs).length });
});

let watching = false;
async function watchTick() {
    if (watching || !TELEGRAM_ENABLED || !TELEGRAM_BOT_TOKEN) return;
    const keys = Object.keys(watchState.legs);
    if (!keys.length) return;
    watching = true;
    try {
        const ids = new Set(keys.map(k => watchState.legs[k].matchId)), found = {};
        const all = await Promise.allSettled(LEAGUE_CODES.map(leagueMatches));
        all.forEach(x => { if (x.status === 'fulfilled' && x.value.matches) x.value.matches.forEach(m => { if (ids.has(m.id)) found[m.id] = m; }); });
        const now = Date.now(), wins = [], losses = [], pendingTotal = [];
        keys.forEach(k => {
            const l = watchState.legs[k], m = found[l.matchId];
            if (!m || watchState.done[k]) return;
            const ft = m.score && m.score.fullTime; if (!ft || ft.home == null || ft.away == null) return;
            const hs = ft.home, as = ft.away; let res = null, final = false;
            if (m.status === 'FINISHED') { res = betWonSrv(l.betType, hs, as) ? 'won' : 'lost'; final = true; }
            else if (isLiveStatus(m.status) && instantWinSrv(l.betType, hs, as)) res = 'won';
            if (!res) return;
            watchState.done[k] = res;
            if (now - new Date(m.utcDate).getTime() > 8 * 3600e3) return;   // eski maç için gürültü yapma
            (res === 'won' ? wins : losses).push({ l, hs, as, final });
        });
        // Bir kuponun tüm bahisleri tuttuysa büyük mesaj
        const groups = {};
        keys.forEach(k => { const l = watchState.legs[k]; if (l.g) (groups[l.g] = groups[l.g] || []).push(k); });
        const bigGroups = [];
        Object.keys(groups).forEach(g => {
            const gk = 'kupon:' + g;
            if (watchState.done[gk] || groups[g].length < 2) return;
            if (groups[g].every(k => watchState.done[k] === 'won')) { watchState.done[gk] = 'won'; if (wins.some(w => w.l.g === g)) bigGroups.push({ n: groups[g].length, odd: watchState.legs[groups[g][0]].gOdd }); }
        });
        saveWatch();
        for (const w of wins) await sendTelegram(`✅ <b>TUTTU!</b>\n${escH(w.l.matchName)}\n${escH(w.l.betLabel)} → ${escH(w.l.pickName)} (@${w.l.odd})\nSkor: ${w.hs}-${w.as} (${w.final ? 'maç sonu' : 'canlı'})`);
        for (const b of bigGroups) await sendTelegram(`🏆 <b>KUPON TUTTU!</b>\n${b.n} maçın hepsi tuttu${b.odd ? ' · Toplam oran ' + b.odd.toFixed(2) : ''}`);
        for (const x of losses) await sendTelegram(`❌ <b>Yattı</b>\n${escH(x.l.matchName)}\n${escH(x.l.betLabel)} → ${escH(x.l.pickName)} (@${x.l.odd})\nSkor: ${x.hs}-${x.as} (maç sonu)`);
        // Şişmeyi önle
        const dk = Object.keys(watchState.done); if (dk.length > 1000) { dk.slice(0, dk.length - 1000).forEach(k => delete watchState.done[k]); saveWatch(); }
    } catch (e) { console.log('Kupon takibi hatası:', e.message); }
    finally { watching = false; }
}
if (TELEGRAM_ENABLED && TELEGRAM_BOT_TOKEN) { setInterval(watchTick, 60e3); setTimeout(watchTick, 15e3); }

app.listen(PORT, () => {
    console.log(`✅ Sunucu çalışıyor: http://localhost:${PORT}`);
    if (!APIFOOTBALL_KEY) console.log('ℹ️  APIFOOTBALL_KEY yok: sakat/cezalı listesi kapalı.');
    if (!ODDS_API_KEY) console.log('ℹ️  ODDS_API_KEY yok: "💰 Değerli" etiketi kapalı (gerçek oran gerekir).');
});
