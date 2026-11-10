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
const ODDS_CACHE_MS = (parseFloat(process.env.ODDS_CACHE_HOURS) || 12) * 3600e3;
const VALUE_EDGE = 0.05;                                             // "değerli" için minimum avantaj (%5)
const PORT = process.env.PORT || 3000;
const LEAGUE_CODES = ['2015', '2021', '2014', '2002', '2019', '2001', '2003', '2017'];
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
async function fd(pathname) {
    const r = await fetch(`${BASE_URL}${pathname}`, { headers: { 'X-Auth-Token': API_KEY } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 429 ? 'Veri kaynağı istek sınırına ulaştı, bir dakika sonra tekrar dene.' : `Veri kaynağı hata verdi (${r.status}).`);
    return data;
}
const leagueMatches = code => cached('m' + code, 5 * 60e3, () => fd(`/competitions/${code}/matches`));
const leagueStandings = code => cached('s' + code, 30 * 60e3, () => fd(`/competitions/${code}/standings`));
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
const ODDS_SPORTS = { '2021': 'soccer_epl', '2014': 'soccer_spain_la_liga', '2019': 'soccer_italy_serie_a', '2002': 'soccer_germany_bundesliga', '2015': 'soccer_france_ligue_one', '2001': 'soccer_uefa_champs_league', '2003': 'soccer_netherlands_eredivisie', '2017': 'soccer_portugal_primeira_liga' };
const STOP = new Set(['fc', 'cf', 'afc', 'ac', 'sc', 'sv', 'ssc', 'as', 'us', 'rc', 'rcd', 'ud', 'cd', 'fk', 'vfl', 'vfb', 'tsg', 'fsv', 'bv', 'sl', 'club', 'de', 'the', 'calcio', '1']);
const toks = s => new Set((s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t && !STOP.has(t)));
const jac = (a, b) => { const i = [...a].filter(x => b.has(x)).length, u = new Set([...a, ...b]).size; return u ? i / u : 0; };
const nameScore = (team, oddsName) => Math.max(...[team.name, team.shortName].filter(Boolean).map(n => jac(toks(n), toks(oddsName))), 0);

async function fetchOdds(code) {
    const url = `https://api.the-odds-api.com/v4/sports/${ODDS_SPORTS[code]}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const events = await r.json();
    return events.map(ev => {
        const over = [], under = [];
        (ev.bookmakers || []).forEach(b => (b.markets || []).filter(m => m.key === 'totals').forEach(m => {
            const o = m.outcomes.find(x => x.name === 'Over' && x.point === 2.5), u = m.outcomes.find(x => x.name === 'Under' && x.point === 2.5);
            if (o && u) { over.push(o.price); under.push(u.price); }
        }));
        const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
        return { home: ev.home_team, away: ev.away_team, time: new Date(ev.commence_time).getTime(), books: over.length, over: over.length ? avg(over) : null, under: under.length ? avg(under) : null };
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
        return { ...m, prediction: { ...p, market: { over25: +best.over.toFixed(2), under25: +best.under.toFixed(2), books: best.books }, value } };
    });
}

app.get('/api/matches/:leagueId', async (req, res) => {
    if (!okLeague(req, res)) return;
    const code = req.params.leagueId;
    try {
        res.json(await cached('a' + code, 5 * 60e3, async () => {
            const data = await leagueMatches(code);
            return { competition: data.competition, resultSet: data.resultSet, matches: await attachMarket(code, analyzeMatches(data.matches)) };
        }));
    } catch (error) { res.status(502).json({ error: error.message }); }
});

// ========== POISSON TAHMİN MODELİ ==========
// Her takımın ev/deplasman gol gücünden beklenen golü bulur, sonra skor ihtimalleri
// tablosundan MS, çifte şans, alt/üst ve KG değerlerini TEK kaynaktan türetir.
const MAX_GOALS = 10;
const DC_RHO = -0.08;   // Dixon-Coles düşük skor düzeltmesi (0-0 ve 1-1 biraz artar)
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

function buildTeamStats(matches) {
    const t = {}; let hg = 0, ag = 0, n = 0; const list = [];
    const get = name => t[name] || (t[name] = { form: [], games: [], hGF: 0, hGA: 0, hN: 0, aGF: 0, aGA: 0, aN: 0 });
    const finished = matches
        .filter(m => m.status === 'FINISHED' && m.score && m.score.fullTime && m.score.fullTime.home !== null && m.score.fullTime.away !== null)
        .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
    finished.forEach(match => {
        const H = get(match.homeTeam.shortName), A = get(match.awayTeam.shortName);
        const hs = match.score.fullTime.home, as = match.score.fullTime.away;
        H.hGF += hs; H.hGA += as; H.hN++;
        A.aGF += as; A.aGA += hs; A.aN++;
        H.form.push(hs > as ? 'G' : hs < as ? 'M' : 'B');
        A.form.push(as > hs ? 'G' : as < hs ? 'M' : 'B');
        H.games.push({ opp: match.awayTeam.shortName, gf: hs, ga: as, home: true });
        A.games.push({ opp: match.homeTeam.shortName, gf: as, ga: hs, home: false });
        list.push({ d: match.utcDate, h: match.homeTeam.shortName, a: match.awayTeam.shortName, hs, as });
        hg += hs; ag += as; n++;
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
        btts: arr.filter(x => x.gf > 0 && x.ga > 0).length,
        cs: arr.filter(x => x.ga === 0).length
    });
    const g = T.games || [];
    return { all: part(g), home: part(g.filter(x => x.home)), away: part(g.filter(x => !x.home)), last5: g.slice(-5) };
}

function predictMatch(home, away, league, homeStats, awayStats) {
    const { avgHome, avgAway } = league;
    const strength = (sum, cnt, avg) => (sum + SHRINK * avg) / (cnt + SHRINK) / avg;
    const empty = { form: [], games: [], hGF: 0, hGA: 0, hN: 0, aGF: 0, aGA: 0, aN: 0 };
    const H = homeStats || empty, A = awayStats || empty;
    const homeAtt = strength(H.hGF, H.hN, avgHome), homeDef = strength(H.hGA, H.hN, avgAway);
    const awayAtt = strength(A.aGF, A.aN, avgAway), awayDef = strength(A.aGA, A.aN, avgHome);
    let lh = avgHome * homeAtt * awayDef * formFactor(formScore(H.form));
    let la = avgAway * awayAtt * homeDef * formFactor(formScore(A.form));
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
    const over15 = clampP(pct(over(1.5))), over25 = clampP(pct(over(2.5)));
    const over35 = clampP(pct(over(3.5))), over45 = clampP(pct(over(4.5)));
    const kgVar = clampP(pct(pBtts));

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
        combos, stats: { home: teamSummary(H), away: teamSummary(A), h2h },
        expectedHomeGoals: lh.toFixed(1), expectedAwayGoals: la.toFixed(1),
        homeForm: H.form.slice(-5).join('') || '----',
        awayForm: A.form.slice(-5).join('') || '----'
    };
}

function analyzeMatches(matches) {
    const league = buildTeamStats(matches);
    return matches.map(match => {
        const home = match.homeTeam.shortName;
        const away = match.awayTeam.shortName;
        if (match.status === 'FINISHED') return { ...match, prediction: null, result: `${match.score.fullTime.home} - ${match.score.fullTime.away}` };
        return { ...match, prediction: predictMatch(home, away, league, league.teams[home], league.teams[away]) };
    });
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

app.listen(PORT, () => {
    console.log(`✅ Sunucu çalışıyor: http://localhost:${PORT}`);
    if (!ODDS_API_KEY) console.log('ℹ️  ODDS_API_KEY yok: "💰 Değerli" etiketi kapalı (gerçek oran gerekir).');
});
