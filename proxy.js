const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = '34f5d9bc97ec481ca31f10bdc8b79230'; 
const BASE_URL = 'https://api.football-data.org/v4';

const TELEGRAM_BOT_TOKEN = '9212893872:AAHK2bs0wn4vTEDtpF9Y2pN95-3VdjE80Y0';
const TELEGRAM_CHAT_ID = '6772692162';

app.get('/api/standings/:leagueId', async (req, res) => {
    try {
        const response = await fetch(`${BASE_URL}/competitions/${req.params.leagueId}/standings`, {
            headers: { 'X-Auth-Token': API_KEY }
        });
        const data = await response.json();
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/matches/:leagueId', async (req, res) => {
    try {
        const response = await fetch(`${BASE_URL}/competitions/${req.params.leagueId}/matches`, {
            headers: { 'X-Auth-Token': API_KEY }
        });
        const data = await response.json();
        const analyzedMatches = analyzeMatches(data.matches);
        res.json({ competition: data.competition, resultSet: data.resultSet, matches: analyzedMatches });
    } catch (error) { res.status(500).json({ error: error.message }); }
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

app.post('/api/telegram/send', async (req, res) => {
    const { message } = req.body;
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
    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
        const data = await response.json();
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/check-results', async (req, res) => {
    const { matchIds } = req.body;
    if (!matchIds || !Array.isArray(matchIds)) return res.status(400).json({ error: 'matchIds gerekli' });
    try {
        const results = {};
        const leagueCodes = ['2015', '2021', '2014', '2002', '2019', '2001', '2003', '2017'];
        for (const code of leagueCodes) {
            try {
                const response = await fetch(`${BASE_URL}/competitions/${code}/matches`, { headers: { 'X-Auth-Token': API_KEY } });
                const data = await response.json();
                if (data.matches) {
                    data.matches.forEach(m => {
                        if (matchIds.includes(m.id)) {
                            results[m.id] = { status: m.status, homeScore: m.score.fullTime.home, awayScore: m.score.fullTime.away, winner: m.score.winner };
                        }
                    });
                }
            } catch (e) {}
        }
        res.json({ results });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.listen(3000, () => {
    console.log('✅ Proxy + Tahmin + Telegram + Sonuç Kontrolü çalışıyor!');
});