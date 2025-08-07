// app.js

// ----------------------------------------
// Fantasy Football War Room
// ----------------------------------------

const DATA_URL = "./consensus.json";

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

let state = {
  settings: {
    teams: 12,
    rounds: 16,
    pickPos: 5,
    scoring: "PPR",
    qb: 1, rb: 2, wr: 2, te: 1,
    flex: 1, k: 1, def: 1, bench: 8,
    manualDraft: false,
    autoDraftOthers: true
  },
  players: [],
  available: [],
  draftPicks: [],
  currentOverall: 1,
  myTeamIndex: 4,            // pickPos − 1
  teamRosters: [],
  rosterSlots: [],
  dataFlags: { hasProj: false, hasADP: false },
  posRankCache: {},
  boardView: localStorage.getItem("boardView") || "overall",
  midTab: localStorage.getItem("midTab") || "recs",
  filters: {
    pos: localStorage.getItem("filterPos") || "",
    q: localStorage.getItem("searchName") || ""
  }
};

const el = id => document.getElementById(id);

// -----------------------------
// Initialization
// -----------------------------
document.addEventListener("DOMContentLoaded", () => {
  bindControls();
  loadConsensus();
  setInterval(loadConsensus, 30*60*1000);
});

function bindControls() {
  // League Settings
  ["teams","rounds","pickPos","scoring","qb","rb","wr","te","flex","k","def","bench"]
    .forEach(key => {
      const node = el(key);
      if (!node) return;
      node.addEventListener("input", () => {
        state.settings[key] = Number(node.value) || node.value;
        if (key === "pickPos") state.myTeamIndex = state.settings.pickPos - 1;
      });
    });

  // Manual / Auto toggles
  el("manualDraft")?.addEventListener("change", e => {
    state.settings.manualDraft = e.target.checked;
  });
  el("autoOthers")?.addEventListener("change", e => {
    state.settings.autoDraftOthers = e.target.checked;
  });

  // Draft Controls
  el("startDraft")?.addEventListener("click", startDraft);
  el("pick")?.addEventListener("click", () => {
    if (state.settings.manualDraft) manualPick();
    else autoPick();
  });
  el("undoPick")?.addEventListener("click", undoPick);
  el("exportBoard")?.addEventListener("click", exportBoardCSV);

  // Tabs
  el("tabOverall")?.addEventListener("click", () => {
    state.boardView = "overall"; localStorage.setItem("boardView","overall"); renderBoard();
  });
  el("tabByRound")?.addEventListener("click", () => {
    state.boardView = "round"; localStorage.setItem("boardView","round"); renderBoard();
  });
  el("subtabRecs")?.addEventListener("click", () => switchMidTab("recs"));
  el("subtabRanks")?.addEventListener("click", () => switchMidTab("ranks"));

  // Filters
  el("filterPos")?.addEventListener("change", e => {
    state.filters.pos = e.target.value; localStorage.setItem("filterPos", state.filters.pos);
    renderMidPanel();
  });
  el("searchName")?.addEventListener("input", e => {
    state.filters.q = e.target.value; localStorage.setItem("searchName", state.filters.q);
    renderMidPanel();
  });
}

function switchMidTab(tab) {
  state.midTab = tab;
  localStorage.setItem("midTab", tab);
  document.querySelectorAll(".subtab").forEach(btn => {
    btn.classList.toggle("active", btn.id === (tab==="recs" ? "subtabRecs" : "subtabRanks"));
  });
  renderMidPanel();
}

// -----------------------------
// Data Loading
// -----------------------------
async function loadConsensus() {
  try {
    const resp = await fetch(DATA_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data.players)) throw new Error("Invalid data");

    document.getElementById("lastUpdated").textContent =
      `Last updated: ${data.updated_at || "unknown"} • players: ${data.players.length}`;

    ingestPlayers(data.players);
    renderAll();
  } catch (err) {
    console.error(err);
    document.getElementById("lastUpdated").textContent =
      `Error loading data — ${err.message}`;
  }
}

function ingestPlayers(raw) {
  state.players = raw.map((p,i) => ({
    ...p,
    id: p.id ?? i+1,
    pos: normalizePos(p.pos || p.position),
    team: normalizeTeam(p.team),
    player: p.player || p.name,
    ecr: p.ecr ?? null,
    adp: p.adp ?? null,
    proj_ppr: p.proj_ppr ?? null,
    tier: p.tier ?? 6,
    bye: p.bye ?? null,
    drafted: false
  })).filter(p => ["QB","RB","WR","TE","K","DEF"].includes(p.pos));

  state.available = state.players.map((_,i)=>i);
  state.dataFlags.hasProj = state.players.some(p=>p.proj_ppr>0);
  state.dataFlags.hasADP  = state.players.some(p=>p.adp!=null);
  buildPosRankCache();
}

// -----------------------------
// Draft Engine
// -----------------------------
function startDraft() {
  // reset
  state.teamRosters = Array(state.settings.teams).fill().map(()=>[]);
  state.rosterSlots  = Array(state.settings.teams).fill().map(()=>({
    QB:0, RB:0, WR:0, TE:0, FLEX:0, K:0, DEF:0, BEN:0
  }));
  state.draftPicks = [];
  state.currentOverall = 1;
  state.players.forEach(p=>p.drafted=false);
  renderAll();
}

function autoPick() {
  const team = overallToTeam(state.currentOverall);
  if (team === state.myTeamIndex && !state.settings.autoDraftOthers) {
    // skip to user pick
    return;
  }
  const rec = computeRecommendations(team).list[0];
  if (rec) draftPlayer(rec.id, team);
  advancePick();
}

function manualPick() {
  // do nothing here; user must click "Draft" on a player card
}

function pickNext() {
  if (state.settings.manualDraft) manualPick();
  else autoPick();
}

function draftPlayer(id, teamIndex) {
  const idx = state.players.findIndex(p=>p.id===id);
  if (idx<0 || state.players[idx].drafted) return;
  state.players[idx].drafted = true;
  state.available = state.available.filter(i=>i!==idx);
  state.teamRosters[teamIndex].push(idx);
  bumpSlot(teamIndex, state.players[idx].pos);
  state.draftPicks.push({
    overall: state.currentOverall,
    team: teamIndex,
    playerIdx: idx,
    round: getRound(state.currentOverall),
    pickInRound: getPickInRound(state.currentOverall)
  });
  advancePick();
}

function advancePick() {
  state.currentOverall++;
  renderAll();
}

function undoPick() {
  const last = state.draftPicks.pop();
  if (!last) return;
  const { playerIdx, team, overall } = last;
  state.players[playerIdx].drafted = false;
  state.available.push(playerIdx);
  state.teamRosters[team] = state.teamRosters[team].filter(i=>i!==playerIdx);
  state.rosterSlots[team][ state.players[playerIdx].pos ] =
    Math.max(0, state.rosterSlots[team][ state.players[playerIdx].pos ] - 1);
  state.currentOverall = overall;
  renderAll();
}

function bumpSlot(teamIndex, pos) {
  if (state.rosterSlots[teamIndex][pos] != null)
    state.rosterSlots[teamIndex][pos]++;
  else
    state.rosterSlots[teamIndex].BEN++;
}

function exportBoardCSV() {
  const header = ["#","Round","Pick","Team","Player","Pos","TeamAbbr","Bye","ECR","ADP","Proj","Tier"];
  const rows = state.draftPicks.map(p => {
    const pl = state.players[p.playerIdx];
    return [
      p.overall,
      p.round,
      p.pickInRound,
      p.team+1,
      pl.player,
      pl.pos,
      pl.team,
      pl.bye,
      pl.ecr,
      pl.adp,
      pl.proj_ppr,
      pl.tier
    ].join(",");
  });
  const csv = [header.join(","), ...rows].join("\n");
  const blob = new Blob([csv], {type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "draft_board.csv";
  a.click();
}

// -----------------------------
// Rendering
// -----------------------------
function renderAll() {
  renderBoard();
  renderMidPanel();
  renderMyRoster();
}

function renderBoard() {
  const root = el("board");
  root.innerHTML = "";
  const picks = [...state.draftPicks].sort((a,b)=>a.overall - b.overall);

  if (state.boardView === "overall") {
    picks.forEach(p => root.appendChild(boardPickElem(p)));
  } else {
    const byRound = new Map();
    picks.forEach(p => {
      (byRound.get(p.round) || byRound.set(p.round,[]).get(p.round)).push(p);
    });
    Array.from(byRound.keys()).sort((a,b)=>a-b).forEach(r => {
      const hdr = document.createElement("div");
      hdr.className = "round-header";
      hdr.textContent = `Round ${r}`;
      root.appendChild(hdr);
      byRound.get(r).forEach(p => root.appendChild(boardPickElem(p)));
    });
  }
}

function boardPickElem(p) {
  const pl = state.players[p.playerIdx];
  const div = document.createElement("div");
  div.className = "pick";
  div.innerHTML = `
    <div class="flex">
      <span class="badge">#${p.overall} R${p.round}.${p.pickInRound}</span>
      <span class="small">Team ${p.team+1}</span>
    </div>
    <div class="flex" style="justify-content:flex-start;gap:8px;">
      <img src="${teamLogoUrl(pl.team)}" class="team-logo" alt="${pl.team}">
      <div class="name">${pl.player}</div>
    </div>
    <div class="small">
      <span class="badge pos ${pl.pos}">${pl.pos}</span> • ${pl.team} • Bye ${pl.bye||"-"}
    </div>`;
  return div;
}

function renderMidPanel() {
  const root = el("midList");
  root.innerHTML = "";

  let candidates = state.available.map(i=>state.players[i]);
  candidates = applyFilters(candidates);

  if (state.midTab === "recs") {
    const team = overallToTeam(state.currentOverall);
    const list = computeRecommendations(team).list;
    candidates = list;
  } else {
    candidates.sort((a,b)=>(a.ecr||9999)-(b.ecr||9999));
  }

  candidates.slice(0, 100).forEach(p => {
    const card = document.createElement("div");
    card.className = "item";
    card.innerHTML = playerCardHTML(p);
    card.querySelector("button").addEventListener("click", () => {
      const team = state.settings.manualDraft
        ? overallToTeam(state.currentOverall)
        : state.myTeamIndex;
      draftPlayer(p.id, team);
    });
    root.appendChild(card);
  });
}

function renderMyRoster() {
  const root = el("myRoster");
  root.innerHTML = "";
  const mine = state.teamRosters[state.myTeamIndex].map(i=>state.players[i]);
  // build roster sections...
  ["QB","RB","WR","TE","FLEX (W/R)","K","DEF","Bench"].forEach(section=>{
    const secDiv = document.createElement("div");
    secDiv.className = "roster-section";
    secDiv.innerHTML = `<div class="roster-header small">${section}</div>`;
    root.appendChild(secDiv);
  });
}

// -----------------------------
// Recommendations & Scoring
// -----------------------------
function computeRecommendations(teamIndex) {
  const baseline  = replacementLevels();
  const needs     = rosterNeeds(teamIndex);
  const avail     = state.available.map(i=>state.players[i]);
  const pct       = (state.currentOverall-1)/(state.settings.teams*state.settings.rounds);

  const byesNow   = byeOverlapCounts(startersAllForTeam(state.myTeamIndex));

  const scored = avail.map(p => {
    const baseProj = p.proj_ppr||0;
    const rep      = baseline[p.pos]||0;
    const vor      = baseProj - rep;
    const tierBoost= 6 - Math.min(p.tier||6,6);
    const value    = state.dataFlags.hasADP
      ? Math.max(0, (p.adp||state.currentOverall) - state.currentOverall)/10
      : 0;
    const needW    = needs[p.pos]||1;
    const scarce   = computeScarcityBoost(p);
    const stack    = stackBonusForTeam(teamIndex, p);
    const byePen   = byeOverlapPenalty(teamIndex, p);
    const dup      = candidateSharesTeamBye(teamIndex,p)
      ? TEAM_WIDE_BYE_DUP_PENALTY : 0;
    const upside   = lateRoundUpsideBonus(p);

    let score = WEIGHTS.vor*vor
              + WEIGHTS.tierBoost*tierBoost
              + WEIGHTS.valueVsADP*value
              + WEIGHTS.need*needW
              + WEIGHTS.scarcity*scarce
              + WEIGHTS.stackSynergy*stack
              + WEIGHTS.byePenalty*Math.min(0,byePen)
              + dup
              + WEIGHTS.lateUpside*upside;

    return { ...p, score };
  });

  scored.sort((a,b)=>b.score-a.score);
  return { list: scored.slice(0,30), baseline, needs };
}

// -----------------------------
// Utility Functions
// -----------------------------
function normalizeTeam(abbr) {
  if (!abbr) return "";
  const m = { JAX:"JAC", LA:"LAR", WSH:"WAS", STL:"LAR", SD:"LAC" };
  const c = abbr.toUpperCase().trim();
  return m[c]||c;
}

function normalizePos(pos="") {
  const p = pos.toUpperCase().replace(/[^A-Z]/g,"");
  if (p.startsWith("QB")) return "QB";
  if (p.startsWith("RB")) return "RB";
  if (p.startsWith("WR")) return "WR";
  if (p.startsWith("TE")) return "TE";
  if (p==="K"||p.startsWith("PK")) return "K";
  if (p==="DST"||p==="DEF") return "DEF";
  return p;
}

function teamLogoUrl(abbr) {
  const c = normalizeTeam(abbr);
  return `https://static.www.nfl.com/league/api/clubs/logos/${c}.svg`;
}

function buildPosRankCache() {
  state.posRankCache = {};
  ["QB","RB","WR","TE","K","DEF"].forEach(pos=>{
    const arr = state.players.filter(p=>p.pos===pos&&p.ecr!=null)
      .sort((a,b)=>a.ecr-b.ecr);
    const map = new Map();
    arr.forEach((p,i)=>map.set(p.id, i+1));
    state.posRankCache[pos]=map;
  });
}

function getPosRank(p) {
  return state.posRankCache[p.pos]?.get(p.id) || null;
}

function replacementLevels() {
  if (!state.dataFlags.hasProj) return {};
  const slots = state.settings;
  const T = slots.teams;
  const counts = { QB:slots.qb, RB:slots.rb, WR:slots.wr, TE:slots.te, K:slots.k, DEF:slots.def };
  const baseline = {};
  ["QB","RB","WR","TE","K","DEF"].forEach(pos => {
    const pool = state.players
      .filter(p=>state.available.includes(state.players.indexOf(p)) && p.pos===pos)
      .sort((a,b)=>(b.proj_ppr||0)-(a.proj_ppr||0));
    const N = T*counts[pos] + ((pos==="RB"||pos==="WR")? Math.round(T*slots.flex*0.5) : 0);
    baseline[pos] = pool[Math.min(N-1, pool.length-1)]?.proj_ppr||0;
  });
  return baseline;
}

function rosterNeeds(teamIndex) {
  const s = state.settings;
  const have = state.rosterSlots[teamIndex];
  const target = { QB:s.qb, RB:s.rb, WR:s.wr, TE:s.te, K:s.k, DEF:s.def };
  const need = {};
  Object.keys(target).forEach(pos=>{
    need[pos] = 1 + Math.max(0, target[pos] - (have[pos]||0))*0.8;
  });
  return need;
}

function computeScarcityBoost(p) {
  const total = state.players.filter(x=>x.pos===p.pos).length;
  const remain= state.available.map(i=>state.players[i]).filter(x=>x.pos===p.pos).length;
  const pct = total>0 ? (1 - remain/total) : 0;
  const factor = (p.pos==="RB"||p.pos==="WR")?1.2:(p.pos==="TE"?1.0:0.6);
  return pct*factor*4;
}

function lateRoundUpsideBonus(p) {
  const pct = (state.currentOverall-1)/(state.settings.teams*state.settings.rounds);
  if (pct < WEIGHTS.lateRoundStartPct) return 0;
  const disc = state.dataFlags.hasADP ? Math.max(0,(p.adp||state.currentOverall)-state.currentOverall) : 0;
  if (disc<=0) return 0;
  const tierLean = Math.max(0,(p.tier||6)-2);
  const deep = pct>=WEIGHTS.deepRoundStartPct ? 1.25 : 1.0;
  return Math.log10(1+disc)*(0.75+0.25*tierLean)*deep;
}

function overallToTeam(overall) {
  const T = state.settings.teams;
  const round = Math.ceil(overall/T);
  const pos   = overall - (round-1)*T;
  return (round%2===1) ? pos-1 : T-pos;
}

function getRound(overall) {
  return Math.ceil(overall/state.settings.teams);
}

function getPickInRound(overall) {
  const r = getRound(overall);
  return overall - (r-1)*state.settings.teams;
}

function applyFilters(list) {
  let out = [...list];
  if (state.filters.pos) {
    out = out.filter(p=>p.pos===state.filters.pos);
  }
  if (state.filters.q) {
    const q = state.filters.q.toLowerCase();
    out = out.filter(p=>p.player.toLowerCase().includes(q));
  }
  return out;
}

function byeOverlapCounts(pls) {
  const m = new Map();
  pls.forEach(p=>{
    if (!p.bye) return;
    m.set(p.bye, (m.get(p.bye)||0)+1);
  });
  return m;
}

function startersAllForTeam(teamIndex) {
  const slots = state.rosterSlots[teamIndex];
  const roster = state.teamRosters[teamIndex].map(i=>state.players[i])
    .sort((a,b)=>(a.ecr||9999)-(b.ecr||9999));
  const starters = [], flex=[];
  roster.forEach(p=>{
    if (slots[p.pos]>0) {
      starters.push(p);
      slots[p.pos]--;
    } else if ((p.pos==="RB"||p.pos==="WR") && flex.length<state.settings.flex) {
      flex.push(p);
    }
  });
  return starters.concat(flex);
}

function byeOverlapPenalty(teamIndex,p) {
  const bye = p.bye;
  if (!bye) return 0;
  const starters = startersAllForTeam(teamIndex);
  const dup = starters.filter(x=>x.bye===bye).length;
  return dup>=1 ? (dup>=state.rosterSlots[teamIndex][p.pos]? -3 : -1.5) : 0;
}

function candidateSharesTeamBye(teamIndex,p) {
  const starters = startersAllForTeam(teamIndex);
  return starters.some(x=>x.bye===p.bye);
}

function stackBonusForTeam(teamIndex,p) {
  if (!state.settings.stack) return 0;
  const teamPlayers = state.teamRosters[teamIndex].map(i=>state.players[i]);
  let bonus=0;
  teamPlayers.forEach(pl=>{
    if (pl.team!==p.team) return;
    if ((pl.pos==="QB" && (p.pos==="WR"||p.pos==="TE")) ||
        (p.pos==="QB" && (pl.pos==="WR"||pl.pos==="TE"))) {
      bonus += 6;
    } else if (pl.pos===p.pos && (pl.pos==="WR"||pl.pos==="TE")) {
      bonus += 2;
    }
  });
  return bonus;
}

function playerCardHTML(p) {
  const pr = getPosRank(p) || "";
  const tier = p.tier||6;
  const ecrText = p.ecr!=null?`#${p.ecr}`:"#—";
  const adpText = state.dataFlags.hasADP? ` • ADP ${p.adp||"-"}` : "";
  const projText = state.dataFlags.hasProj
    ? ` • Proj ${ (p.proj_ppr||0).toFixed(1) }` : "";
  const stackBadge = p.hasStack
    ? `<span class="badge stack">🔗 STACK</span>` : "";
  return `
    <div class="flex">
      <div class="flex" style="gap:10px;">
        <img src="${teamLogoUrl(p.team)}" class="team-logo">
        <div>
          <div class="name">
            ${p.player} ${stackBadge}
            <span class="badge tier t${tier}">T${tier}</span>
            <span class="badge pos ${p.pos}">${p.pos}${pr}</span>
            <span class="badge">${ecrText}</span>
          </div>
          <div class="small">
            ${p.team} • Bye ${p.bye||"-"}${adpText}${projText}
          </div>
        </div>
      </div>
      <div><button>Draft</button></div>
    </div>`;
}
