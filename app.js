// --------------------------------------------------------------------------------
// Fantasy Football War Room — Full, Unabridged app.js (v1.0.0)
// --------------------------------------------------------------------------------
//
// Features:
//  • Load consensus.json or FantasyPros CSV
//  • League settings (teams, rounds, slots, manual vs. auto mode)
//  • Simplified draft controls: Start, Pick, Undo, Export
//  • Auto-draft others in regular mode
//  • Manual Draft Mode: pick each team manually, your roster populates only on your picks
//  • Recommendations engine: VOR, ADP, tiers, scarcity, stack synergy, bye overlap
//  • Unified player cards with ADP, projections, tier, bye dot, stack & upgrade badges
//  • Draft board (overall & by-round) and your roster view
//  • Responsive mobile layout
//
// --------------------------------------------------------------------------------

// (1) Constants & State ----------------------------------------------------------

const DATA_URL = "./consensus.json";

// Tunable weight parameters for the recommendations algorithm
const WEIGHTS = {
  vor: 1.0,
  tierBoost: 1.0,
  valueVsADP: 0.8,
  need: 0.9,
  scarcity: 0.7,
  stackSynergy: 1.0,
  byePenalty: -0.5,
  lateUpside: 0.6,
  lateRoundStartPct: 0.5,
  deepRoundStartPct: 0.75
};
const TEAM_WIDE_BYE_DUP_PENALTY = -1.5;
const UPGRADE_ECR_GAP = 5;

// Main application state
let state = {
  settings: {
    teams: 12,
    rounds: 16,
    pickPos: 5,
    scoring: "PPR",
    qb: 1,
    rb: 2,
    wr: 2,
    te: 1,
    flex: 1,
    k: 1,
    def: 1,
    bench: 8,
    manualMode: false       // <— Manual vs. Auto draft switch
  },
  players: [],
  available: [],
  draftPicks: [],
  currentOverall: 1,
  myTeamIndex: 0,
  teamRosters: [],
  rosterSlots: [],
  started: false,
  paused: false,
  dataFlags: { hasProj: false, hasADP: false },
  autoplay: { enabled: true, delayMs: 1000, loopId: null },
  boardView: localStorage.getItem("boardView") || "overall",
  midTab: localStorage.getItem("midTab") || "recs",
  filters: {
    pos: (localStorage.getItem("filterPos") || "").toUpperCase(),
    q: localStorage.getItem("searchName") || ""
  },
  posRankCache: {},
  dataSource: "consensus.json"
};

// DOM shorthand
const el = id => document.getElementById(id);

// --------------------------------------------------------------------------------
// Normalization & Ranking Helpers
// --------------------------------------------------------------------------------

function normalizeTeam(abbr) {
  if (!abbr) return "";
  const code = String(abbr).toUpperCase().trim();
  const map = { JAX:"JAC", LA:"LAR", WSH:"WAS", STL:"LAR", SD:"LAC" };
  return map[code] || code;
}
function normalizePos(pos) {
  const p = String(pos||"").toUpperCase().replace(/[^A-Z]/g,"");
  if (p.startsWith("QB")) return "QB";
  if (p.startsWith("RB")) return "RB";
  if (p.startsWith("WR")) return "WR";
  if (p.startsWith("TE")) return "TE";
  if (p === "K" || p.startsWith("PK")) return "K";
  if (p === "DST" || p === "DEF" || p === "DSTDEF") return "DEF";
  return p;
}
function teamLogoUrl(abbr) {
  const c = normalizeTeam(abbr);
  return c
    ? `https://static.www.nfl.com/league/api/clubs/logos/${c}.svg`
    : "";
}

// Build per-position ECR→rank cache
function buildPosRankCache() {
  state.posRankCache = {};
  ["QB","RB","WR","TE","K","DEF"].forEach(pos => {
    const arr = state.players.filter(p=>p.pos===pos && p.ecr!=null)
                             .sort((a,b)=>a.ecr - b.ecr);
    const map = new Map();
    arr.forEach((p,i)=> map.set(p.id ?? p.player, i+1));
    state.posRankCache[pos] = map;
  });
}
function getPosRank(p) {
  const m = state.posRankCache[p.pos];
  return m ? m.get(p.id ?? p.player) : undefined;
}
function posRankLabel(rank) {
  return rank ? String(rank) : "";
}

// --------------------------------------------------------------------------------
// Draft Math
// --------------------------------------------------------------------------------

function overallToTeam(overall) {
  const T = state.settings.teams;
  const round = Math.ceil(overall / T);
  const posInRound = overall - (round - 1) * T;
  // serpentine order
  return (round % 2 === 1)
    ? posInRound - 1
    : (T - posInRound);
}
function getRound(overall) {
  return Math.ceil(overall / state.settings.teams);
}
function pickInRound(overall) {
  const rnd = getRound(overall);
  const start = (rnd - 1) * state.settings.teams + 1;
  return overall - start + 1;
}
function draftProgressPct() {
  const total = state.settings.teams * state.settings.rounds;
  return Math.min(1, (state.currentOverall - 1) / Math.max(1, total));
}

// --------------------------------------------------------------------------------
// Stacking, Bye Overlap, Scarcity & Needs
// --------------------------------------------------------------------------------

function hasPrimaryStackForMyTeam(candidate) {
  const roster = state.teamRosters[state.myTeamIndex] || [];
  const candTeam = normalizeTeam(candidate.team);
  if (!candTeam || !roster.length) return false;
  for (let idx of roster) {
    const pl = state.players[idx];
    if (!pl || normalizeTeam(pl.team) !== candTeam) continue;
    // QB-WR/TE stacking
    if ((candidate.pos==="QB" && (pl.pos==="WR"||pl.pos==="TE")) ||
        ((candidate.pos==="WR"||candidate.pos==="TE") && pl.pos==="QB")) {
      return true;
    }
  }
  return false;
}
function stackBonusForTeam(teamIndex, candidate) {
  if (!state.features.stack) return 0;
  let bonus = 0;
  const roster = (state.teamRosters[teamIndex]||[]).map(i=>state.players[i]);
  const candTeam = normalizeTeam(candidate.team);
  roster.forEach(pl=>{
    if (!pl || normalizeTeam(pl.team)!==candTeam) return;
    if ((pl.pos==="QB" && (candidate.pos==="WR"||candidate.pos==="TE")) ||
        (candidate.pos==="QB" && (pl.pos==="WR"||pl.pos==="TE"))) {
      bonus += 6;
    } else if (pl.pos===candidate.pos && (pl.pos==="WR"||pl.pos==="TE")) {
      bonus += 2;
    }
  });
  return bonus;
}

// Same-position bye overlap penalty
function byeOverlapPenalty(teamIndex, candidate) {
  const s = state.settings;
  const targets = { QB:s.qb, RB:s.rb, WR:s.wr, TE:s.te, K:s.k, DEF:s.def };
  const roster = (state.teamRosters[teamIndex]||[]).map(i=>state.players[i]);
  const starterList = roster.filter(p=>{
    let count=0;
    for (let q of roster) if (q.pos===p.pos) count++;
    return count <= (targets[p.pos]||0);
  });
  const overlap = starterList.filter(p=>p.bye === candidate.bye).length >= 1;
  return overlap
    ? (starterList.length >= (targets[candidate.pos]||0) ? -3 : -1.5)
    : 0;
}
function candidateSharesTeamBye(teamIndex, candidate) {
  if (!candidate.bye) return false;
  return (state.teamRosters[teamIndex]||[])
    .map(i=>state.players[i])
    .some(p=>p.bye === candidate.bye);
}

function byeOverlapCounts(players) {
  const map = new Map();
  players.forEach(p=>{
    if (!p.bye) return;
    map.set(p.bye, (map.get(p.bye)||0) + 1);
  });
  return map;
}
function byeDotColor(count) {
  if (count>=4) return "#ef4444";
  if (count===3) return "#f97316";
  if (count===2) return "#f59e0b";
  return null;
}
function byeDotSpan(color) {
  return `<span style="
    display:inline-block;
    width:8px;height:8px;
    border-radius:50%;
    background:${color};
    margin-left:6px;
    vertical-align:middle;
  "></span>`;
}

// Scarcity boost: how many of this position remain vs. total
function computeScarcityBoost(p) {
  const total = state.players.filter(x=>x.pos===p.pos).length;
  const remain = state.available.map(i=>state.players[i]).filter(x=>x.pos===p.pos).length;
  if (!total) return 0;
  const pct = 1 - (remain/total);
  const factor = (p.pos==="RB"||p.pos==="WR") ? 1.2
               : (p.pos==="TE"             ) ? 1.0 : 0.6;
  return pct * factor * 4;
}

// Roster needs: weight positions you're underfilled on
function rosterNeeds(teamIndex) {
  const s = state.settings;
  const slots = state.rosterSlots[teamIndex] || {QB:0,RB:0,WR:0,TE:0,K:0,DEF:0,FLEX:0};
  const need = {};
  ["QB","RB","WR","TE","K","DEF"].forEach(pos=>{
    const target = s[pos.toLowerCase()];
    const have = slots[pos]||0;
    need[pos] = 1 + Math.max(0, target - have) * 0.8;
  });
  return need;
}

// Late-round upside: if ADP >> current pick, small log boost
function lateRoundUpsideBonus(p) {
  const pct = draftProgressPct();
  if (pct < WEIGHTS.lateRoundStartPct) return 0;
  const discount = state.dataFlags.hasADP
    ? Math.max(0, (p.adp||state.currentOverall) - state.currentOverall)
    : 0;
  if (!discount) return 0;
  const tierLean = Math.max(0, ((p.tier||6) - 2));
  const deep = (pct >= WEIGHTS.deepRoundStartPct) ? 1.25 : 1.0;
  return Math.log10(1 + discount) * (0.75 + 0.25*tierLean) * deep;
}

// --------------------------------------------------------------------------------
// Data Loading & CSV Upload
// --------------------------------------------------------------------------------

async function loadConsensus() {
  const lu = el("lastUpdated");
  try {
    const resp = await fetch(DATA_URL, { cache:"no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data.players)) throw new Error("Malformed JSON");
    state.dataSource = "consensus.json";
    lu.textContent = `Last updated: ${data.updated_at||"?"} • players: ${data.players.length}`;
    ingestPlayers(data.players);
    render();
  } catch (e) {
    lu.innerHTML = `<span style="color:#f59e0b;font-weight:bold;">Error loading data — ${e.message}</span>`;
  }
}

function ingestPlayers(raw) {
  const allowed = new Set(["QB","RB","WR","TE","K","DEF"]);
  state.players = raw.map((p,i)=>{
    const pos = normalizePos(p.pos||p.position||"");
    return {
      ...p,
      id: p.id ?? i+1,
      player: p.player||p.name||"",
      team: normalizeTeam(p.team||""),
      pos,
      ecr: p.ecr??p.rank??null,
      adp: p.adp??null,
      proj_ppr: p.proj_ppr??p.proj??0,
      tier: p.tier??6,
      bye: p.bye??null,
      drafted: false
    };
  }).filter(p=>allowed.has(p.pos));

  state.available = state.players.map((_,i)=>i);
  state.dataFlags.hasProj = state.players.some(p=>p.proj_ppr>0);
  state.dataFlags.hasADP  = state.players.some(p=>p.adp!=null);
  buildPosRankCache();
}

function initCsvUpload() {
  const inp = el("csvInput");
  inp.addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      const { headers, rows } = csvToRows(text);
      const players = rows.map(r=>mapFantasyProsRow(headers,r)).filter(Boolean);
      ingestPlayers(players);
      render();
    };
    reader.readAsText(file);
  });
  el("downloadConsensus").addEventListener("click", () => {
    if (!state.players.length) return alert("No data to download");
    const out = {
      source: state.dataSource, updated_at: new Date().toISOString(),
      players: state.players
    };
    const blob = new Blob([JSON.stringify(out,null,2)],{type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "consensus.json";
    a.click();
  });
}

function csvToRows(text) {
  const rows = [], hdr = [], out = { headers: [], rows: [] };
  let cur="", inQ=false, row=[], i=0;
  const pushCell=()=>{ row.push(cur); cur=""; };
  const pushRow=()=>{ rows.push(row); row=[]; };
  while(i<text.length){
    const c=text[i];
    if(inQ){
      if (c==='\"' && text[i+1]==='\"') { cur+='"'; i+=2; continue; }
      if (c==='\"') { inQ=false; i++; continue; }
      cur+=c; i++; continue;
    } else {
      if (c==='\"') { inQ=true; i++; continue; }
      if (c===',') { pushCell(); i++; continue; }
      if (c==='\n') { pushCell(); pushRow(); i++; continue; }
      cur+=c; i++;
    }
  }
  if (cur||row.length) { pushCell(); pushRow(); }
  out.headers = rows.shift().map(h=>h.trim());
  out.rows = rows;
  return out;
}

function mapFantasyProsRow(headers,row) {
  const get=(aliases)=>{
    for(let a of aliases){
      const idx=headers.findIndex(h=>h.toLowerCase()===a.toLowerCase());
      if(idx>=0) return row[idx];
    }
  };
  return {
    player: get(["Player","Name"]),
    team: normalizeTeam(get(["Team"])||""),
    pos: normalizePos(get(["Pos","Position"])||""),
    bye: parseInt(get(["Bye"])||"")||null,
    ecr: Number(get(["ECR","Rank"])||NaN)||null,
    adp: Number(get(["ADP","Avg. Draft Pos."])||NaN)||null,
    tier: Number(get(["Tier"])||NaN)||6,
    proj_ppr: Number(get(["Proj PPR","FPTS"])||NaN)||0
  };
}

// --------------------------------------------------------------------------------
// Initialization & Event Wiring
// --------------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", init);
function init() {
  loadConsensus();
  setInterval(loadConsensus, 30*60*1000);
  initCsvUpload();

  // League settings inputs
  ["teams","rounds","pickPos","scoring",
   "qbSlots","rbSlots","wrSlots","teSlots","flexSlots","kSlots","defSlots","benchSlots"]
    .forEach(id=> el(id).addEventListener("input", syncSettings));

  // Manual draft mode toggle
  el("manualMode").addEventListener("change", e => {
    state.settings.manualMode = e.target.checked;
    el("autoOthers").parentElement.style.display = state.settings.manualMode ? "none" : "inline-flex";
    if (!state.settings.manualMode && el("autoOthers").checked) startAutoLoop();
    else stopAutoLoop();
  });

  // Draft controls
  el("startMock").addEventListener("click",    startMock);
  el("nextPick").addEventListener("click",     manualOrNext);
  el("undoPick").addEventListener("click",     undoPick);
  el("exportBoard").addEventListener("click",  exportBoard);
  el("autoOthers").addEventListener("change", e=>{
    state.autoplay.enabled = e.target.checked;
    state.autoplay.enabled ? startAutoLoop() : stopAutoLoop();
  });

  // Tabs
  el("tabOverall").addEventListener("click", ()=>{ state.boardView="overall"; updateBoardTabs(); renderBoard(); });
  el("tabByRound").addEventListener("click", ()=>{ state.boardView="round";   updateBoardTabs(); renderBoard(); });
  updateBoardTabs();

  // Subtabs
  document.querySelector(".subtabs").addEventListener("click", e=>{
    if (e.target.id==="subtabRecs"||e.target.id==="subtabRanks") {
      state.midTab = (e.target.id==="subtabRecs" ? "recs" : "ranks");
      localStorage.setItem("midTab", state.midTab);
      updateMidTabs();
      renderMidPanel();
    }
  });
  updateMidTabs();

  // Filters
  el("filterPos").addEventListener("change", e=>{
    state.filters.pos = e.target.value.toUpperCase();
    localStorage.setItem("filterPos", state.filters.pos);
    renderMidPanel();
  });
  el("searchName").addEventListener("input", e=>{
    state.filters.q = e.target.value;
    localStorage.setItem("searchName", state.filters.q);
    renderMidPanel();
  });

  // Initial render
  render();
}

// Sync settings from inputs into state.settings
function syncSettings() {
  const s = state.settings;
  s.teams   = +el("teams").value   || 12;
  s.rounds  = +el("rounds").value  || 16;
  s.pickPos = +el("pickPos").value || 1;
  s.scoring = el("scoring").value;
  s.qb      = +el("qbSlots").value || 1;
  s.rb      = +el("rbSlots").value || 2;
  s.wr      = +el("wrSlots").value || 2;
  s.te      = +el("teSlots").value || 1;
  s.flex    = +el("flexSlots").value|| 1;
  s.k       = +el("kSlots").value  || 1;
  s.def     = +el("defSlots").value|| 1;
  s.bench   = +el("benchSlots").value||8;
}

// --------------------------------------------------------------------------------
// Manual or Auto Pick Handler
// --------------------------------------------------------------------------------

function manualOrNext() {
  if (state.settings.manualMode) {
    // In manual mode, user picks from the recommendation list
    // so we do nothing here: they should click Draft on the card.
    return;
  }
  // Regular mode -> auto or next pick
  nextPick();
}

// --------------------------------------------------------------------------------
// Auto-draft Engine
// --------------------------------------------------------------------------------

function startAutoLoop() {
  stopAutoLoop();
  if (!state.autoplay.enabled) return;
  state.autoplay.loopId = setInterval(() => {
    if (!state.started || state.paused) return;
    if (state.currentOverall > state.settings.teams * state.settings.rounds) {
      stopAutoLoop();
      return;
    }
    const team = overallToTeam(state.currentOverall);
    if (team === state.myTeamIndex) return; // pause on your pick
    aiPick(team);
    advanceAfterPick();
  }, state.autoplay.delayMs);
}
function stopAutoLoop() {
  clearInterval(state.autoplay.loopId);
  state.autoplay.loopId = null;
}
function aiPick(teamIndex) {
  const { list } = computeRecommendations(teamIndex);
  if (!list.length) return;
  // simple weighted randomness among top 3–6
  const k = draftProgressPct() < 0.2 ? Math.min(6,list.length) : Math.min(3,list.length);
  let weights = Array.from({length:k}, (_,i)=>k-i);
  const sum = weights.reduce((a,b)=>a+b,0);
  let r = Math.random()*sum, pick = list[0];
  for (let i=0; i<k; i++) {
    r -= weights[i];
    if (r <= 0) { pick = list[i]; break; }
  }
  draftPlayerById(pick.id, teamIndex);
}

// Move to next pick in sequence
function advanceAfterPick() {
  state.currentOverall++;
  render();
}

// --------------------------------------------------------------------------------
// Next‐Pick / Undo / Export Board
// --------------------------------------------------------------------------------

function nextPick() {
  if (!state.started) return alert("Start the draft first.");
  const total = state.settings.teams * state.settings.rounds;
  if (state.currentOverall > total) return stopAutoLoop();
  const team = overallToTeam(state.currentOverall);
  if (team === state.myTeamIndex) {
    // your pick in regular mode
    const { list } = computeRecommendations(team);
    if (!list.length) return alert("No candidates available.");
    draftPlayerById(list[0].id, team);
    advanceAfterPick();
  } else {
    aiPick(team);
    advanceAfterPick();
  }
}

function undoPick() {
  if (!state.draftPicks.length) return;
  const last = state.draftPicks.pop();
  const { playerIdx, team, overall } = last;
  state.players[playerIdx].drafted = false;
  if (!state.available.includes(playerIdx)) state.available.push(playerIdx);
  state.teamRosters[team] = state.teamRosters[team].filter(i=>i!==playerIdx);
  state.rosterSlots[team][state.players[playerIdx].pos] =
    Math.max(0, state.rosterSlots[team][state.players[playerIdx].pos]-1);
  state.currentOverall = overall;
  render();
}

function exportBoard() {
  const rows = [["overall","round","pickInRound","team","player","pos","teamAbbr","bye","ecr","adp","proj_ppr","tier"]];
  state.draftPicks
    .sort((a,b)=>a.overall - b.overall)
    .forEach(p=>{
      const pl = state.players[p.playerIdx];
      rows.push([p.overall,p.round,p.pickInRound,p.team+1,pl.player,pl.pos,pl.team,pl.bye,pl.ecr,pl.adp,pl.proj_ppr,pl.tier]);
    });
  const csv = rows.map(r=>r.join(",")).join("\n");
  const blob = new Blob([csv],{type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "draft_board.csv";
  a.click();
}

// --------------------------------------------------------------------------------
// Recommendations Algorithm (VOR + modifiers)
// --------------------------------------------------------------------------------

function replacementLevels() {
  if (!state.dataFlags.hasProj) return { QB:0, RB:0, WR:0, TE:0, K:0, DEF:0 };
  const s = state.settings, T = s.teams;
  const baseline = {};
  ["QB","RB","WR","TE","K","DEF"].forEach(pos=>{
    let N = T * s[pos.toLowerCase()];
    if (pos==="RB"||pos==="WR") N += Math.round(T * 0.5 * s.flex);
    const pool = state.available.map(i=>state.players[i]).filter(p=>p.pos===pos)
                   .sort((a,b)=> (b.proj_ppr||0) - (a.proj_ppr||0));
    baseline[pos] = pool[Math.min(N-1, pool.length-1)]?.proj_ppr||0;
  });
  return baseline;
}

function applyFilters(list) {
  let out = list.slice();
  if (state.filters.pos) {
    out = out.filter(p => p.pos === state.filters.pos);
  }
  if (state.filters.q) {
    out = out.filter(p => p.player.toLowerCase().includes(state.filters.q.toLowerCase()));
  }
  return out;
}

function worstStarterEcrByPos(idx) {
  const { starters } = startersByPosForTeam(idx);
  const worst = {};
  Object.entries(starters).forEach(([pos,list])=>{
    worst[pos] = list.length ? Math.max(...list.map(p=>p.ecr||9999)) : null;
  });
  return worst;
}

function computeRecommendations(teamIndex) {
  const base = replacementLevels();
  const needs = rosterNeeds(teamIndex);
  let candidates = state.available.map(i=>state.players[i]);
  candidates = applyFilters(candidates);
  const pct = draftProgressPct();
  const worstEcr = worstStarterEcrByPos(state.myTeamIndex);
  const myStarters = startersAllForTeam(state.myTeamIndex);
  const byeCounts = byeOverlapCounts(myStarters);

  const scored = candidates.map(p=>{
    const baseProj   = state.dataFlags.hasProj ? p.proj_ppr : 0;
    const repLevel   = state.dataFlags.hasProj ? base[p.pos] : 0;
    const vor        = baseProj - repLevel;
    const tierBoost  = 6 - Math.min(p.tier||6,6);
    const valueBoost = state.dataFlags.hasADP
                     ? Math.max(0, (p.adp||state.currentOverall)-state.currentOverall)/10
                     : 0;
    const needW      = needs[p.pos]||1;
    const scarcity   = computeScarcityBoost(p);
    const stackSy    = stackBonusForTeam(teamIndex, p);
    const byePen     = byeOverlapPenalty(teamIndex, p);
    const teamByeDup = candidateSharesTeamBye(teamIndex,p)
                     ? TEAM_WIDE_BYE_DUP_PENALTY : 0;
    const upside     = lateRoundUpsideBonus(p);

    let score = WEIGHTS.vor*vor
              + WEIGHTS.tierBoost*tierBoost
              + WEIGHTS.valueVsADP*valueBoost
              + WEIGHTS.need*needW
              + WEIGHTS.scarcity*scarcity
              + WEIGHTS.stackSynergy*stackSy
              + WEIGHTS.byePenalty*byePen
              + teamByeDup
              + WEIGHTS.lateUpside*upside;

    if ((p.pos==="K"||p.pos==="DEF") && pct<0.6) {
      score -= 3*(0.6 - pct);
    }

    const upgradeForPos = worstEcr[p.pos]!=null && p.ecr!=null
                        && p.ecr + UPGRADE_ECR_GAP < worstEcr[p.pos];

    const resulting = byeCounts.get(p.bye)||0;
    const byeWarnColor = byeDotColor(resulting+1);

    return { ...p, vor, score, upgradeForPos, byeWarnColor, hasMyStack: hasPrimaryStackForMyTeam(p) };
  });

  scored.sort((a,b)=>b.score - a.score);
  return { list: scored.slice(0,30), baseline: base, needs };
}

// --------------------------------------------------------------------------------
// Unified Player Card Renderer
// --------------------------------------------------------------------------------

function playerCardHTML(p) {
  const logo = teamLogoUrl(p.team);
  const pr   = getPosRank(p);
  const tier = p.tier||6;
  const ecr  = p.ecr!=null ? `#${p.ecr}` : "#—";
  const adpBit  = state.dataFlags.hasADP ? ` • ADP ${p.adp||"-"}` : "";
  const projBit = state.dataFlags.hasProj
                ? ` • Proj ${ (p.proj_ppr||0).toFixed(1) }`
                  + (p.rep!=null ? ` (rep ${(p.rep||0).toFixed(1)})` : "")
                : "";
  const stackBadge   = p.hasMyStack
                     ? `<span class="badge stack" title="Stacks with your roster">🔗 STACK</span>`
                     : "";
  const upgradeBadge = p.upgradeForPos
                     ? `<span class="badge" style="
                          background:#22c55e1a;
                          border:1px solid #22c55e;
                          color:#22c55e;
                        ">Upgrade Available</span>`
                     : "";
  const byeDot = p.byeWarnColor ? byeDotSpan(p.byeWarnColor) : "";

  return `
    <div class="flex">
      <div class="flex" style="gap:10px;">
        ${logo ? `<img src="${logo}" class="team-logo">` : ""}
        <div>
          <div class="name">
            ${p.player}
            ${stackBadge}
            ${upgradeBadge}
            <span class="badge tier t${tier}">T${tier}</span>
            <span class="badge pos ${p.pos}">${p.pos}${pr?posRankLabel(pr):""}</span>
            <span class="badge">${ecr}</span>
          </div>
          <div class="small">
            ${p.team||""} • Bye ${p.bye||"-"} ${byeDot}${adpBit}${projBit}
          </div>
        </div>
      </div>
      <div><button data-pid="${p.id}">Draft</button></div>
    </div>`;
}

// --------------------------------------------------------------------------------
// Rendering: Board, Mid-Panel & Roster
// --------------------------------------------------------------------------------

function render() {
  renderBoard();
  renderMidPanel();
  renderMyRoster();
}

function renderBoard() {
  const root = el("board");
  root.innerHTML = "";
  const picks = state.draftPicks.slice().sort((a,b)=>a.overall - b.overall);
  if (state.boardView === "overall") {
    picks.forEach(p=> root.appendChild(boardPickElem(p)));
  } else {
    const byRnd = {};
    picks.forEach(p=> (byRnd[p.round]||(byRnd[p.round]=[])).push(p));
    Object.keys(byRnd).sort((a,b)=>a-b).forEach(r=>{
      const hdr = document.createElement("div");
      hdr.className = "round-header";
      hdr.textContent = `Round ${r}`;
      root.appendChild(hdr);
      byRnd[r].forEach(p=> root.appendChild(boardPickElem(p)));
    });
  }
}

function boardPickElem(p) {
  const pl = state.players[p.playerIdx];
  const logo = teamLogoUrl(pl.team);
  const pr = getPosRank(pl);
  const div = document.createElement("div");
  div.className = "pick";
  div.innerHTML = `
    <div class="flex">
      <span class="badge">#${p.overall}</span>
      <span class="small">T${p.team+1}</span>
    </div>
    <div class="flex" style="gap:8px;align-items:center;">
      ${logo?`<img src="${logo}" class="team-logo">`:``}
      <div class="name">${pl.player}</div>
    </div>
    <div class="small">
      <span class="badge pos ${pl.pos}">${pl.pos}${pr?posRankLabel(pr):""}</span>
      • ${pl.team||""} • Bye ${pl.bye||"-"}
    </div>`;
  return div;
}

function renderMidPanel() {
  const root = el("midList");
  root.innerHTML = "";
  if (state.midTab === "recs") {
    const team = state.started
      ? overallToTeam(state.currentOverall)
      : state.myTeamIndex;
    const { list } = computeRecommendations(team);
    list.forEach(p => {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = playerCardHTML(p);
      item.querySelector("button").addEventListener("click", () => {
        draftPlayerById(p.id, state.myTeamIndex);
        advanceAfterPick();
      });
      root.appendChild(item);
    });
  } else {  // Full rankings
    let list = state.available.map(i=>state.players[i]);
    list = applyFilters(list).sort((a,b)=>(a.ecr||1e6)-(b.ecr||1e6));
    const counts = byeOverlapCounts(startersAllForTeam(state.myTeamIndex));
    list.forEach(p=>{
      p.byeWarnColor = byeDotColor((counts.get(p.bye)||0)+1);
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = playerCardHTML(p);
      item.querySelector("button").addEventListener("click", ()=>{
        draftPlayerById(p.id, state.myTeamIndex);
        advanceAfterPick();
      });
      root.appendChild(item);
    });
  }
}

function renderMyRoster() {
  const root = el("myRoster");
  root.innerHTML = "";
  const mineIdxs = state.teamRosters[state.myTeamIndex] || [];
  const mine = mineIdxs.map(i=>state.players[i])
                       .sort((a,b)=>(a.ecr||1e6)-(b.ecr||1e6));
  const s = state.settings;
  const slots = { QB:s.qb, RB:s.rb, WR:s.wr, TE:s.te, FLEX:s.flex, K:s.k, DEF:s.def };

  // Organize starters & bench
  const starters = { QB:[], RB:[], WR:[], TE:[], K:[], DEF:[], FLEX:[] };
  const bench = [];
  mine.forEach(p=>{
    if (starters[p.pos].length < slots[p.pos]) {
      starters[p.pos].push(p);
    } else if ((p.pos==="RB"||p.pos==="WR") && starters.FLEX.length < slots.FLEX) {
      starters.FLEX.push(p);
    } else {
      bench.push(p);
    }
  });

  // Bye overlap dots for roster display
  const allStarters = [].concat(
    starters.QB, starters.RB, starters.WR,
    starters.TE, starters.K, starters.DEF,
    starters.FLEX
  );
  const byeCounts = byeOverlapCounts(allStarters);

  function section(label, list, max, isBench=false) {
    const wrap = document.createElement("div");
    wrap.className = "roster-section";
    // coverage badge
    const fill = list.length;
    const cov = isBench
      ? ""
      : `<span style="
          border:1px solid ${ fill<max ? '#f59e0b' : '#22c55e' };
          color:${ fill<max ? '#f59e0b' : '#22c55e' };
          padding:2px 6px;border-radius:6px;
          margin-left:6px;font-size:12px;
        ">${fill}/${max}</span>`;

    wrap.innerHTML = `<div class="roster-header small">${label}${cov}</div>`;
    list.forEach(pl=>{
      const logo = teamLogoUrl(pl.team);
      const pr = getPosRank(pl);
      const ecr = pl.ecr!=null?`#${pl.ecr}`:"#—";
      const dot = byeDotColor((byeCounts.get(pl.bye)||0)) ? byeDotSpan(byeCounts.get(pl.bye)) : "";
      const row = document.createElement("div");
      row.className = "roster-item";
      row.innerHTML = `
        ${logo?`<img src="${logo}" class="team-logo team-logo-sm">`:``}
        <div>
          <div class="roster-name">${pl.player}</div>
          <div class="roster-meta">
            <span class="badge pos ${pl.pos}">${pl.pos}${pr?posRankLabel(pr):""}</span>
            • ${pl.team||""} • Bye ${pl.bye||"-"} ${dot} • ECR ${ecr}
          </div>
        </div>`;
      wrap.appendChild(row);
    });
    // fill empty slots
    const emptyCount = isBench
      ? state.settings.bench - bench.length
      : max - list.length;
    for (let i=0; i<emptyCount; i++) {
      const empty = document.createElement("div");
      empty.className = "roster-item slot-empty";
      empty.innerHTML = `
        <div class="slot-dot"></div>
        <div><div class="roster-name muted">Empty ${label} Slot</div>
        <div class="roster-meta muted">—</div></div>`;
      wrap.appendChild(empty);
    }
    root.appendChild(wrap);
  }

  section("QB", starters.QB, slots.QB);
  section("RB", starters.RB, slots.RB);
  section("WR", starters.WR, slots.WR);
  section("TE", starters.TE, slots.TE);
  section("FLEX (W/R)", starters.FLEX, slots.FLEX);
  section("K", starters.K, slots.K);
  section("DEF", starters.DEF, slots.DEF);
  section("Bench", bench, state.settings.bench, true);
}

// --------------------------------------------------------------------------------
// Helper: Start a new mock draft
// --------------------------------------------------------------------------------

function startMock() {
  if (!state.players.length) return alert("Load players first.");
  syncSettings();
  state.myTeamIndex = state.settings.pickPos - 1;
  state.teamRosters = Array(state.settings.teams).fill(null).map(()=>[]);
  state.rosterSlots  = Array(state.settings.teams).fill(null).map(()=>({
    QB:0, RB:0, WR:0, TE:0, FLEX:0, K:0, DEF:0
  }));
  state.draftPicks = [];
  state.currentOverall = 1;
  state.started = true;
  state.paused = false;
  if (!state.settings.manualMode && state.autoplay.enabled) {
    startAutoLoop();
  }
  render();
}

// --------------------------------------------------------------------------------
// UI Tab Updates
// --------------------------------------------------------------------------------

function updateBoardTabs() {
  el("tabOverall").classList.toggle("active", state.boardView==="overall");
  el("tabByRound").classList.toggle("active", state.boardView==="round");
}
function updateMidTabs() {
  el("subtabRecs").classList.toggle("active", state.midTab==="recs");
  el("subtabRanks").classList.toggle("active", state.midTab==="ranks");
}
