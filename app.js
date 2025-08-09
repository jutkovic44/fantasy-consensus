/* Fantasy Football War Room — FULL app.js (unabridged)
   Key features:
   - Manual vs Regular draft modes
   - Rankings shown pre-draft (default "Full Rankings")
   - Rec engine: VOR + need + scarcity + ADP + tier + SoS + Health + conditional stacking + upside
   - Bye overlap dots
   - Draft board newest-first
   - View any team's roster via dropdown
   - Draft ends when all teams reach total roster size; show results modal with grades
*/

const DATA_URL = "./consensus.json";

/* ====== WEIGHTS & CONSTANTS ====== */
const WEIGHTS = {
  // core value
  vor: 1.0,           // projection - replacement baseline
  tierBoost: 1.0,
  valueVsADP: 0.7,

  // roster/draft dynamics
  need: 1.0,
  scarcity: 0.6,
  stackSynergy: 0.45, // softened; also gated by proximity (STACK_PROXIMITY_THRESHOLD)
  byePenalty: -0.5,
  lateUpside: 0.6,

  // NEW signals
  sos: 0.6,           // strength of schedule (easier = better)
  health: -0.8,       // injury/availability risk penalty
  ecrAssist: 0.35,    // nudge if ECR agrees when VOR ties

  lateRoundStartPct: 0.5,
  deepRoundStartPct: 0.75
};

// Stacking only if candidate is near best non-stack option
const STACK_PROXIMITY_THRESHOLD = 0.08; // within 8% of best base score

const TEAM_WIDE_BYE_DUP_PENALTY = -1.5; // small nudge away from team-wide overlaps
const UPGRADE_ECR_GAP = 5;

/* ====== GLOBAL STATE ====== */
let state = {
  settings: {
    teams: 12,
    rounds: 16,
    pickPos: 5,
    scoring: "PPR",
    qb: 1, rb: 2, wr: 2, te: 1, flex: 1, k: 1, def: 1, bench: 8,
    mode: "regular" // "regular" | "manual"
  },

  players: [],
  available: [],            // pool indexes into players
  draftPicks: [],           // { overall, round, pickInRound, team, playerIdx }
  currentOverall: 1,

  myTeamIndex: 0,
  teamRosters: [],          // array of arrays of pool indexes
  rosterSlots: [],          // counts filled per team {QB,RB,WR,TE,FLEX,K,DEF,BEN}
  started: false,
  paused: false,            // unused for now (kept for compatibility)

  features: { stack:true },

  dataFlags: { hasProj:false, hasADP:false },
  autoplay: { enabled:true, delayMs:650, loopId:null }, // Regular mode uses burst loops, no checkbox

  boardView: localStorage.getItem("boardView") || "overall",
  midTab: localStorage.getItem("midTab") || "ranks",   // default Full Rankings pre-draft

  filters: {
    pos: (localStorage.getItem("filterPos") || "").toUpperCase(),
    q: localStorage.getItem("searchName") || ""
  },

  posRankCache: {},
  dataSource: "consensus.json",

  // roster viewing
  viewTeamIndex: 0
};

/* ====== HELPERS ====== */
const el = id => document.getElementById(id);

function normalizeTeam(abbr){
  if(!abbr) return "";
  const code = String(abbr).toUpperCase().trim();
  const map = { JAX:"JAC", LA:"LAR", WSH:"WAS", STL:"LAR", SD:"LAC" };
  return map[code] || code;
}
function normalizePos(pos){
  const p = String(pos||"").toUpperCase().replace(/[^A-Z]/g,"");
  if (p.startsWith("QB")) return "QB";
  if (p.startsWith("RB")) return "RB";
  if (p.startsWith("WR")) return "WR";
  if (p.startsWith("TE")) return "TE";
  if (p === "K" || p.startsWith("PK")) return "K";
  if (p === "DST" || p === "DEF" || p === "DSTDEF") return "DEF";
  return p;
}
function teamLogoUrl(abbr){
  const c=normalizeTeam(abbr);
  return c ? `https://static.www.nfl.com/league/api/clubs/logos/${c}.svg` : "";
}

function buildPosRankCache(){
  state.posRankCache = {};
  ["QB","RB","WR","TE","K","DEF"].forEach(pos=>{
    const arr = state.players
      .filter(p=>p.pos===pos && p.ecr!=null)
      .sort((a,b)=>(a.ecr)-(b.ecr));
    const map = new Map();
    arr.forEach((p,idx)=> map.set(p.id ?? p.player, idx+1));
    state.posRankCache[pos] = map;
  });
}
function getPosRank(p){ const m = state.posRankCache[p.pos]; return m ? m.get(p.id ?? p.player) : undefined; }
function posRankLabel(rank) { return rank ? String(rank) : ""; }

/* ====== DRAFT MATH ====== */
function overallToTeam(overall){
  const T=state.settings.teams; const r=Math.ceil(overall/T); const pos=overall-(r-1)*T;
  return (r%2===1) ? (pos-1) : (T - pos);
}
function getRound(overall){ return Math.ceil(overall/state.settings.teams); }
function pickInRound(overall){ const r=getRound(overall), start=(r-1)*state.settings.teams+1; return overall-start+1; }
function draftProgressPct(){
  const total = state.settings.teams * totalRosterSize();
  // progress by picks relative to total player slots (more intuitive than rounds)
  return Math.min(1, (state.draftPicks.length) / Math.max(1,total));
}

/* ====== STACKS / BYE / NEEDS ====== */
function hasPrimaryStackForMyTeam(candidate){
  const rosterIdxs = state.teamRosters[state.myTeamIndex] || [];
  const candTeam = normalizeTeam(candidate.team);
  if(!candTeam || !rosterIdxs.length) return false;
  for(const idx of rosterIdxs){
    const pl = state.players[idx];
    if(!pl || normalizeTeam(pl.team)!==candTeam) continue;
    if( (candidate.pos==="QB" && (pl.pos==="WR" || pl.pos==="TE")) ||
        ((candidate.pos==="WR" || candidate.pos==="TE") && pl.pos==="QB") ){
      return true;
    }
  }
  return false;
}
function stackBonusForTeam(teamIndex, candidate){
  if(!state.features.stack) return 0;
  const roster = (state.teamRosters[teamIndex]||[]).map(i=>state.players[i]);
  let bonus = 0;
  const candTeam = normalizeTeam(candidate.team);
  for(const pl of roster){
    if(!pl || normalizeTeam(pl.team)!==candTeam) continue;
    if( (pl.pos==="QB" && (candidate.pos==="WR" || pl.pos==="TE")) ||
        (candidate.pos==="QB" && (pl.pos==="WR" || pl.pos==="TE")) ){ bonus += 6; }
    else if (pl.pos===candidate.pos && (pl.pos==="WR" || pl.pos==="TE")) { bonus += 2; }
  }
  return bonus;
}

/* same-position bye overlap (minor) */
function byeOverlapPenalty(teamIndex, candidate){
  const s = state.settings;
  const startersTarget = { QB:s.qb, RB:s.rb, WR:s.wr, TE:s.te, K:s.k, DEF:s.def };
  const rosterIdxs = state.teamRosters[teamIndex] || [];
  const bye = candidate.bye || null;
  if(!bye) return 0;

  const roster = rosterIdxs.map(i=>state.players[i]).sort((a,b)=>(a.ecr??9999)-(b.ecr??9999));
  const starters = { QB:[], RB:[], WR:[], TE:[], K:[], DEF:[] };
  for(const p of roster){
    if(startersTarget[p.pos] && starters[p.pos].length < startersTarget[p.pos]) starters[p.pos].push(p);
  }

  const list = starters[candidate.pos] || [];
  const overlap = list.some(p => (p.bye||-1) === bye);
  if(!overlap) return 0;

  const fillingLastStarter = list.length+1 >= (startersTarget[candidate.pos]||0);
  return fillingLastStarter ? -3 : -1.5;
}

/* starters helpers */
function startersByPosForTeam(teamIndex){
  const s = state.settings;
  const targets = { QB:s.qb, RB:s.rb, WR:s.wr, TE:s.te, K:s.k, DEF:s.def };
  const idxs = (state.teamRosters[teamIndex]||[]);
  const roster = idxs.map(i=>state.players[i]).sort((a,b)=>(a.ecr??9999)-(b.ecr??9999));
  const starters = { QB:[], RB:[], WR:[], TE:[], K:[], DEF:[] };
  const flex = [];
  for(const p of roster){
    if (targets[p.pos] && starters[p.pos].length < targets[p.pos]) { starters[p.pos].push(p); continue; }
    if ((p.pos==="RB" || p.pos==="WR") && flex.length < s.flex) { flex.push(p); continue; }
  }
  return { starters, flex };
}
function startersAllForTeam(teamIndex){
  const { starters, flex } = startersByPosForTeam(teamIndex);
  return [...starters.QB, ...starters.RB, ...starters.WR, ...starters.TE, ...starters.K, ...starters.DEF, ...flex];
}
function byeOverlapCounts(players){
  const map = new Map();
  for(const p of players){
    if (p?.bye == null) continue;
    map.set(p.bye, (map.get(p.bye)||0) + 1);
  }
  return map; // byeWeek -> count
}
function byeDotColor(count){
  if (count >= 4) return "#ef4444";   // red
  if (count === 3) return "#f97316";  // orange
  if (count === 2) return "#f59e0b";  // yellow
  return null;
}
function byeDotSpan(color){
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${color};margin-left:6px;vertical-align:middle"></span>`;
}
function wouldCreateOverlapColor(teamIndex, candidate){
  if (candidate?.bye == null) return null;
  const starters = startersAllForTeam(teamIndex);
  const counts = byeOverlapCounts(starters);
  const current = counts.get(candidate.bye) || 0;
  const resulting = current + 1;
  return byeDotColor(resulting); // null if <2
}
function candidateSharesTeamBye(teamIndex, candidate){
  if (!candidate.bye) return false;
  const starters = startersAllForTeam(teamIndex);
  return starters.some(p => (p?.bye||-1) === candidate.bye);
}

/* scarcity boost */
function computeScarcityBoost(p){
  const total = state.players.filter(x=>x.pos===p.pos).length;
  const remain = state.available.map(i=>state.players[i]).filter(x=>x.pos===p.pos).length;
  if(total === 0) return 0;
  const pctRemain = remain/total;
  const scarcity = (1 - pctRemain);
  const posFactor = (p.pos==="RB"||p.pos==="WR") ? 1.2 : (p.pos==="TE"? 1.0 : 0.6);
  return scarcity * posFactor * 4;
}

/* needs */
function rosterNeeds(teamIndex){
  const s=state.settings, slots=state.rosterSlots[teamIndex]||{QB:0,RB:0,WR:0,TE:0,FLEX:0,K:0,DEF:0,BEN:0};
  const target={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te,K:s.k,DEF:s.def}, need={};
  for(const pos of ["QB","RB","WR","TE","K","DEF"]){
    const have=slots[pos]||0, left=Math.max(0,(target[pos]||0)-have);
    need[pos]= 1 + (left*0.8);
  }
  return need;
}

/* upside */
function lateRoundUpsideBonus(p){
  const pct = draftProgressPct();
  if (pct < WEIGHTS.lateRoundStartPct) return 0;
  const discount = (state.dataFlags.hasADP && p.adp) ? Math.max(0, p.adp - (state.draftPicks.length+1)) : 0;
  if (discount <= 0) return 0;
  const tier = p.tier || 6;
  const tierLean = Math.max(0, (tier-2));
  const deep = (pct >= WEIGHTS.deepRoundStartPct) ? 1.25 : 1.0;
  return (Math.log10(1 + discount) * (0.75 + 0.25*tierLean)) * deep;
}

/* ====== SOS & HEALTH ====== */
function normalizeSOS(raw) {
  if (raw == null || !isFinite(raw)) return 0;
  const v = Number(raw);
  if (Math.abs(v) <= 5) return Math.max(-1, Math.min(1, v / 2.5));
  const centered = (v - 50) / 50; // -1..+1
  return Math.max(-1, Math.min(1, centered));
}
function getSOSFactor(p) { return normalizeSOS(p.sos); }

function healthRiskPenalty(p) {
  let risk = p.injury_risk;
  if (risk == null) risk = 0;
  if (risk > 1) risk = Math.min(1, risk/100);

  const missed = Math.max(0, Number(p.games_missed||0));
  const missedFactor = Math.min(1, missed / 6); // 6+ missed games ~ full signal

  const s = String(p.status||"").toUpperCase();
  let statusPen = 0;
  if (s === "Q") statusPen = 0.15;
  if (s === "D") statusPen = 0.35;
  if (s === "O" || s === "IR" || s === "PUP") statusPen = 0.6;

  const combined = 0.6*risk + 0.25*missedFactor + 0.15*statusPen;
  return Math.max(0, Math.min(1, combined)); // 0..1 where 1 = very risky
}

/* ====== DATA LOAD ====== */
async function loadConsensus() {
  const lastUpdatedEl = el("lastUpdated");
  const srcLabel = el("dataSourceLabel");
  try {
    const resp = await fetch(DATA_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — consensus.json not found`);
    const data = await resp.json();
    if (!Array.isArray(data.players)) throw new Error("consensus.json missing 'players' array");

    state.dataSource = "consensus.json";
    if (srcLabel) srcLabel.textContent = "consensus.json";
    if (lastUpdatedEl) lastUpdatedEl.textContent = `Last updated: ${data.updated_at || "unknown"} • players: ${data.players.length}`;

    ingestPlayers(data.players);
    render();
  } catch (e) {
    console.warn("Could not load consensus.json:", e.message);
    if (lastUpdatedEl)
      lastUpdatedEl.innerHTML = `<span style="color:#f59e0b; font-weight:bold;">Tip:</span> ${e.message}. You can upload a CSV below.`;
  }
}

function ingestPlayers(raw){
  const allowed = new Set(["QB","RB","WR","TE","K","DEF"]);
  state.players = raw.map((p,i)=>{
    const pos = normalizePos(p.pos || p.position || p.Position || "");
    return {
      ...p,
      id: p.id ?? i+1,
      drafted: false,
      pos,
      team: normalizeTeam(p.team || p.Team || ""),
      player: p.player || p.name || p.Player || "",
      ecr: p.ecr ?? p.rank ?? p.ECR ?? null,
      adp: p.adp ?? p.ADP ?? null,
      proj_ppr: p.proj_ppr ?? p.Projection_PPR ?? p.proj ?? null,
      tier: p.tier ?? p.Tier ?? null,
      bye: p.bye ?? p.Bye ?? p.bye_week ?? null,

      // Optional fields
      sos: toNum(p.sos ?? p.SOS) ?? null,
      injury_risk: toNum(p.injury_risk ?? p.InjuryRisk) ?? null,
      games_missed: toNum(p.games_missed ?? p.GamesMissed) ?? 0,
      status: String(p.status ?? p.Status ?? "").trim().toUpperCase()
    };
  }).filter(p => allowed.has(p.pos));

  state.available = state.players.map((_,i)=>i);
  state.dataFlags.hasProj = state.players.some(p=> (p.proj_ppr||0) > 0);
  state.dataFlags.hasADP  = state.players.some(p=> p.adp !== null && p.adp !== undefined);
  buildPosRankCache();
}

/* ====== CSV UPLOAD ====== */
function initCsvUpload(){
  const input = el("csvInput");
  if (input){
    const posSel = el("filterPos"); if (posSel) posSel.value = state.filters.pos;
    const qInput = el("searchName"); if (qInput) qInput.value = state.filters.q;

    input.addEventListener("change", handleCsvFiles);
    const uploader = input.closest(".uploader");
    if (uploader){
      uploader.addEventListener("dragover", e=>{ e.preventDefault(); uploader.classList.add("drag"); });
      uploader.addEventListener("dragleave", ()=> uploader.classList.remove("drag"));
      uploader.addEventListener("drop", e=>{
        e.preventDefault(); uploader.classList.remove("drag");
        const file = e.dataTransfer.files?.[0];
        if(file) parseCsvFile(file);
      });
    }
  }

  const btn = el("downloadConsensus");
  if (btn){
    btn.addEventListener("click", () => {
      if(!state.players.length){ alert("No players loaded yet. Upload a CSV first or ensure consensus.json has players."); return; }
      const json = JSON.stringify({
        source: state.dataSource === "CSV" ? "FantasyPros CSV (uploaded)" : DATA_URL,
        updated_at: new Date().toISOString(),
        players: state.players
      }, null, 2);
      const a=document.createElement("a");
      a.href=URL.createObjectURL(new Blob([json],{type:"application/json"}));
      a.download="consensus.json"; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1500);
    });
  }
}
function handleCsvFiles(e){ const file = e.target.files?.[0]; if(file) parseCsvFile(file); }
function parseCsvFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    const { headers, rows } = csvToRows(text);
    const players = rows.map(r => mapFantasyProsRow(headers, r)).filter(Boolean);
    if(!players.length){ alert("Could not parse any rows from CSV. Check the file format."); return; }
    const label = el("dataSourceLabel"); if (label) label.textContent = "CSV (uploaded)";
    const lu = el("lastUpdated"); if (lu) lu.textContent = `Loaded from CSV: ${file.name} • players: ${players.length}`;
    ingestPlayers(players);
    render();
  };
  reader.readAsText(file);
}
function csvToRows(text){
  const rows = [];
  let i=0, cur="", inQ=false, row=[];
  const pushCell=()=>{ row.push(cur); cur=""; };
  const pushRow=()=>{ rows.push(row); row=[]; };
  while(i<text.length){
    const c=text[i];
    if(inQ){
      if(c==='"' && text[i+1]==='"'){ cur+='"'; i+=2; continue; }
      if(c==='"' ){ inQ=false; i++; continue; }
      cur+=c; i++; continue;
    }else{
      if(c==='"'){ inQ=true; i++; continue; }
      if(c===','){ pushCell(); i++; continue; }
      if(c==='\r'){ i++; continue; }
      if(c==='\n'){ pushCell(); pushRow(); i++; continue; }
      cur+=c; i++; continue;
    }
  }
  if(cur.length>0 || row.length) { pushCell(); pushRow(); }
  const headers = rows.shift()?.map(h=>h.trim()) || [];
  return { headers, rows };
}
function mapFantasyProsRow(headers, row){
  const get = (aliases) => {
    for(const a of aliases){
      const idx = headers.findIndex(h => h.toLowerCase() === a.toLowerCase());
      if(idx>=0) return row[idx];
    }
    return undefined;
  };
  const player = get(["Player","PLAYER","Name"]); if(!player) return null;
  const team = normalizeTeam(get(["Team","TEAM"])||"");
  const pos  = normalizePos(get(["Pos","POS","Position"])||"");
  const bye  = parseInt(get(["Bye","BYE","Bye Week"])||"",10) || null;
  const ecr  = toNum(get(["ECR","Rank","RK"]));
  const adp  = toNum(get(["ADP","Avg. Draft Pos.","AVG"]));
  const tier = toNum(get(["Tier","TIER"]));
  const proj = toNum(get(["FPTS","PROJ","Proj PPR","Projected PPR","Projected Pts","FPTS (PPR)"]));

  // Optional new columns (OK if missing)
  const sos       = toNum(get(["sos","SOS"]));
  const injury    = toNum(get(["injury_risk","InjuryRisk","Injury Risk"]));
  const missed    = toNum(get(["games_missed","GamesMissed","Games Missed"]));
  const status    = (get(["status","Status"]) || "").toUpperCase();

  return {
    player, team, pos, bye,
    ecr: isFinite(ecr)? ecr : null,
    adp: isFinite(adp)? adp : null,
    tier: isFinite(tier)? tier : null,
    proj_ppr: isFinite(proj)? proj : null,
    sos: isFinite(sos) ? sos : null,
    injury_risk: isFinite(injury)? injury : null,
    games_missed: isFinite(missed)? missed : 0,
    status
  };
}
function toNum(x){ const n = Number(String(x||"").replace(/[^0-9.\-]/g,"")); return isFinite(n)? n : null; }

/* ====== INIT ====== */
document.addEventListener("DOMContentLoaded", init);
function init() {
  loadConsensus();
  setInterval(loadConsensus, 30*60*1000);
  initCsvUpload();

  const ids = ["teams","rounds","pickPos","scoring",
   "qbSlots","rbSlots","wrSlots","teSlots","flexSlots","kSlots","defSlots","benchSlots","draftMode"];
  ids.forEach(id=> el(id)?.addEventListener("input", syncSettings));

  // Start buttons (support both old/new IDs)
  el("startDraft")?.addEventListener("click", startDraft);
  el("startMock")?.addEventListener("click", startDraft);

  // Board tabs
  el("tabOverall")?.addEventListener("click", () => { state.boardView="overall"; localStorage.setItem("boardView","overall"); updateBoardTabs(); renderBoard(); });
  el("tabByRound")?.addEventListener("click", () => { state.boardView="round";   localStorage.setItem("boardView","round");   updateBoardTabs(); renderBoard(); });
  updateBoardTabs();

  // Subtabs (default "ranks" pre-draft)
  document.querySelector('.subtabs')?.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === 'subtabRecs' || t.id === 'subtabRanks') {
      state.midTab = (t.id === 'subtabRecs') ? 'recs' : 'ranks';
      localStorage.setItem('midTab', state.midTab);
      updateMidTabs();
      renderMidPanel();
    }
  });
  updateMidTabs();

  // Filters
  el("filterPos")?.addEventListener("change", (e) => {
    state.filters.pos = String(e.target.value || "").toUpperCase().trim();
    localStorage.setItem("filterPos", state.filters.pos);
    const posSel = el("filterPos"); if (posSel) posSel.value = state.filters.pos;
    renderMidPanel();
  });
  el("searchName")?.addEventListener("input", (e) => {
    state.filters.q = e.target.value || "";
    localStorage.setItem("searchName", state.filters.q);
    renderMidPanel();
  });

  // Roster viewer dropdown
  el("rosterTeamSelect")?.addEventListener("change", (e)=>{
    const v = Number(e.target.value || 0);
    if (Number.isFinite(v) && v >= 0 && v < state.settings.teams){
      state.viewTeamIndex = v;
      renderMyRoster();
    }
  });

  // default the dropdown once teams known
  state.viewTeamIndex = state.myTeamIndex;

  // reflect saved filters on first paint
  const posSel = el("filterPos"); if (posSel) posSel.value = state.filters.pos;
  const qInput = el("searchName"); if (qInput) qInput.value = state.filters.q;

  render();
}

function syncSettings(){
  const s=state.settings;
  s.teams=+el("teams")?.value||12;
  s.rounds=+el("rounds")?.value||16;
  s.pickPos=+el("pickPos")?.value||5;
  s.scoring=el("scoring")?.value || "PPR";
  s.qb=+el("qbSlots")?.value||1;
  s.rb=+el("rbSlots")?.value||2;
  s.wr=+el("wrSlots")?.value||2;
  s.te=+el("teSlots")?.value||1;
  s.flex=+el("flexSlots")?.value||1;
  s.k=+el("kSlots")?.value||1;
  s.def=+el("defSlots")?.value||1;
  s.bench=+el("benchSlots")?.value||8;
  s.mode=(el("draftMode")?.value||"regular");
}

/* ====== DRAFT ENGINE ====== */
function totalRosterSize(){
  const s=state.settings;
  return s.qb+s.rb+s.wr+s.te+s.k+s.def+s.flex + s.bench; // all starters + bench
}
function totalDraftPicksNeeded(){
  return totalRosterSize() * state.settings.teams;
}

function startDraft(){
  if (!state.players.length){ alert("Load players first (consensus.json or upload CSV)."); return; }
  syncSettings();
  state.myTeamIndex = Math.max(0, Math.min(state.settings.teams-1, (state.settings.pickPos|0)-1));
  state.viewTeamIndex = state.myTeamIndex;

  const T = state.settings.teams;
  state.teamRosters = new Array(T).fill(0).map(()=>[]);
  state.rosterSlots = new Array(T).fill(0).map(()=>({QB:0,RB:0,WR:0,TE:0,FLEX:0,K:0,DEF:0,BEN:0}));
  state.draftPicks = [];
  state.currentOverall = 1;
  state.started = true;

  render(); // show empty board + rankings

  if (state.settings.mode === "regular"){
    autoUntilMyPick();
  } else {
    // manual: user makes every selection
    flashOnTheClock();
  }
}

function currentTeamOnClock(){
  return overallToTeam(state.currentOverall);
}

function handleUserDraft(playerId){
  if (!state.started) { startDraft(); } // let them draft to start
  const team = currentTeamOnClock();
  if (state.settings.mode === "regular" && team !== state.myTeamIndex){
    // In regular mode you can only draft for your team when it's your pick
    alert("It's not your pick. In Regular mode, other teams auto-draft.");
    return;
  }
  draftPlayerById(playerId, team);
  advanceAfterPick();
  if (isDraftComplete()){
    showResultsModal();
    return;
  }

  if (state.settings.mode === "regular"){
    autoUntilMyPick();
  } else {
    flashOnTheClock();
  }
}

function autoUntilMyPick(){
  // Auto-draft until my turn or draft completes
  while(!isDraftComplete()){
    const team = currentTeamOnClock();
    if (team === state.myTeamIndex) break;
    aiPick(team);
    advanceAfterPick(false);
  }
  render();
  if (isDraftComplete()){
    showResultsModal();
  } else {
    flashOnTheClock();
  }
}

function isDraftComplete(){
  const target = totalRosterSize();
  for (let t=0; t<state.settings.teams; t++){
    if ((state.teamRosters[t]?.length||0) < target) return false;
  }
  return true;
}

function advanceAfterPick(shouldRender=true){
  state.currentOverall += 1;
  if (shouldRender) render();
}

function aiPick(teamIndex){
  const {list}=computeRecommendations(teamIndex);
  if(!list.length) return;
  const earlyPct = draftProgressPct();
  // sample from top candidates — wider early, tighter later
  const k = (earlyPct < 0.2) ? Math.min(6, list.length) : Math.min(3, list.length);
  const weights = Array.from({length:k},(_,i)=>(k-i));
  const sum=weights.reduce((a,b)=>a+b,0);
  let r=Math.random()*sum, pick=list[0];
  for(let i=0;i<k;i++){ r-=weights[i]; if(r<=0){ pick=list[i]; break; } }
  draftPlayerById(pick.id,teamIndex);
}

function draftPlayerById(id, teamIndex){
  const poolIdx = state.players.findIndex(p=>p.id===id);
  if(poolIdx===-1) return;
  draftByIndex(poolIdx, teamIndex);
}
function draftByIndex(poolIdx, teamIndex){
  if(state.players[poolIdx].drafted) return;
  // remove from available
  const idxAvail = state.available.indexOf(poolIdx);
  if(idxAvail!==-1) state.available.splice(idxAvail,1);

  state.players[poolIdx].drafted=true;

  const overall=state.currentOverall, round=getRound(overall), pir=pickInRound(overall);
  state.teamRosters[teamIndex].push(poolIdx);
  bumpRosterSlot(teamIndex, state.players[poolIdx].pos);
  state.draftPicks.push({overall, team:teamIndex, round, pickInRound:pir, playerIdx:poolIdx});

  // Update roster viewer dropdown (show counts)
  populateRosterTeamSelect();
}
function bumpRosterSlot(teamIndex,pos){
  const s=state.rosterSlots[teamIndex]; if(!s) return;
  if(pos in s && pos!=="FLEX") s[pos]++; else s.BEN++;
}

/* ====== EXPORT (disabled in UI, kept for internal) ====== */
function exportBoard(){
  const rows=[["overall","round","pickInRound","team","player","pos","teamAbbr","bye","ecr","adp","proj_ppr","tier"]];
  for(const p of [...state.draftPicks].sort((a,b)=>a.overall-b.overall)){
    const pl=state.players[p.playerIdx];
    rows.push([p.overall,p.round,p.pickInRound,p.team+1,pl.player,pl.pos,pl.team,pl.bye,pl.ecr,pl.adp,pl.proj_ppr,pl.tier]);
  }
  const csv=rows.map(r=>r.join(",")).join("\n");
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download="draft_board.csv";
  a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1500);
}

/* ====== SCORING / FILTERS ====== */
function replacementLevels(){
  if(!state.dataFlags.hasProj){ return {QB:0,RB:0,WR:0,TE:0,K:0,DEF:0}; }
  const s=state.settings, T=s.teams, flexShare=s.flex;
  const counts={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te,K:s.k,DEF:s.def}, idxAt={};
  for(const pos of ["QB","RB","WR","TE","K","DEF"]){
    let N=T*counts[pos];
    if(pos==="RB" || pos==="WR"){ N += Math.round(T * (0.5*flexShare)); } // FLEX is W/R only
    idxAt[pos]=Math.max(N,1);
  }
  const baseline={};
  for(const pos of ["QB","RB","WR","TE","K","DEF"]){
    const pool=state.available.map(i=>state.players[i]).filter(p=>p.pos===pos).sort((a,b)=>(b.proj_ppr||0)-(a.proj_ppr||0));
    const idx=Math.min(idxAt[pos]-1, Math.max(0,pool.length-1));
    baseline[pos]=pool[idx]? (pool[idx].proj_ppr||0):0;
  }
  return baseline;
}

function applyFilters(list){
  let out = list.slice();
  const pos = (state.filters.pos || "").toUpperCase().trim();
  const q = (state.filters.q || "").toLowerCase().trim();
  if (pos) out = out.filter(p => (p.pos || "").toUpperCase().trim() === pos);
  if (q)   out = out.filter(p => (p.player || "").toLowerCase().includes(q));
  return out;
}

function worstStarterEcrByPos(teamIndex){
  const { starters } = startersByPosForTeam(teamIndex);
  const worst = {};
  for (const pos of Object.keys(starters)){
    const arr = starters[pos];
    if (!arr.length) { worst[pos] = null; continue; }
    worst[pos] = Math.max(...arr.map(p=>p.ecr ?? 9999));
  }
  return worst;
}

/* ====== RECOMMENDATIONS (smart, two-pass) ====== */
function computeRecommendations(teamIndex){
  const base = replacementLevels();
  const needs = rosterNeeds(teamIndex);
  let candidates = state.available.map(i=>state.players[i]);
  candidates = applyFilters(candidates);

  const pct = draftProgressPct();
  const worstEcr = worstStarterEcrByPos(state.myTeamIndex);

  const myStartersNow = startersAllForTeam(state.myTeamIndex);
  const countsNow = byeOverlapCounts(myStartersNow);

  // PASS 1 — base score without stack
  let bestBaseScore = -Infinity;
  const prelim = candidates.map(p=>{
    const baseProj = state.dataFlags.hasProj ? (p.proj_ppr||0) : 0;
    const rep = state.dataFlags.hasProj ? (base[p.pos]||0) : 0;
    const vor = baseProj - rep;

    const tierBoost = (6 - Math.min(p.tier||6,6));
    const valueBoost = state.dataFlags.hasADP ? Math.max(0,(p.adp|| (state.draftPicks.length+1))- (state.draftPicks.length+1))/10 : 0;

    const needW = (needs[p.pos]||1.0);
    const scarcity = computeScarcityBoost(p);
    const byePenSamePos = byeOverlapPenalty(teamIndex, p);
    const teamByeDup = candidateSharesTeamBye(teamIndex, p) ? TEAM_WIDE_BYE_DUP_PENALTY : 0;
    const upside = lateRoundUpsideBonus(p);

    // NEW signals
    const sos = getSOSFactor(p);             // -1..+1
    const health = healthRiskPenalty(p);     // 0..1
    const ecrAssist = (p.ecr!=null) ? Math.max(0, (300 - p.ecr)/300) : 0;

    let baseScore =
      WEIGHTS.vor * (state.dataFlags.hasProj ? vor : 0) +
      WEIGHTS.tierBoost * tierBoost +
      WEIGHTS.valueVsADP * valueBoost +
      WEIGHTS.need * needW +
      WEIGHTS.scarcity * scarcity +
      WEIGHTS.byePenalty * Math.min(0, byePenSamePos) +
      teamByeDup +
      WEIGHTS.lateUpside * upside +
      WEIGHTS.sos * sos +
      WEIGHTS.health * health +
      WEIGHTS.ecrAssist * ecrAssist;

    if ((p.pos==="K" || p.pos==="DEF") && pct < 0.6) baseScore -= 3 * (0.6 - pct);

    if (baseScore > bestBaseScore) bestBaseScore = baseScore;

    const resulting = (p.bye!=null) ? ( (countsNow.get(p.bye) || 0) + 1 ) : 0;
    const byeWarnColor = byeDotColor(resulting);

    const worst = worstEcr[p.pos];
    const upgradeForPos = (worst!=null && p.ecr!=null) ? (p.ecr + UPGRADE_ECR_GAP < worst) : false;

    return {
      ...p,
      baseProj, rep, vor,
      baseScore,
      hasMyStack: hasPrimaryStackForMyTeam(p),
      upgradeForPos,
      byeWarnColor
    };
  });

  // PASS 2 — add conditional stack bonus
  const scored = prelim.map(p=>{
    const within = (bestBaseScore > -Infinity)
      ? ((bestBaseScore - p.baseScore) / Math.max(1, Math.abs(bestBaseScore))) <= STACK_PROXIMITY_THRESHOLD
      : true;

    const rawStack = stackBonusForTeam(teamIndex, p);
    const stackAdj = within ? (WEIGHTS.stackSynergy * rawStack) : 0;

    return { ...p, score: p.baseScore + stackAdj };
  });

  scored.sort((a,b)=> b.score-a.score);
  return { list: scored.slice(0,40), baseline: base, needs };
}

/* ====== PLAYER CARD ====== */
function playerCardHTML(p){
  const logo = teamLogoUrl(p.team);
  const pr = getPosRank(p);
  const t  = p.tier || 6;
  const ecrText = (p.ecr!=null)? `#${p.ecr}` : "#—";
  const adpBit  = state.dataFlags.hasADP ? ` • ADP ${p.adp||"-"}` : "";
  const projBit = state.dataFlags.hasProj
      ? (` • Proj ${Number(p.baseProj ?? p.proj_ppr ?? 0).toFixed(1)}`
         + (p.rep!=null ? ` (rep ${Number(p.rep).toFixed(1)})` : ""))
      : "";

  // optional small cues
  const sosStr = (()=>{ const s = getSOSFactor(p); if (s > 0.2) return " • SoS 👍"; if (s < -0.2) return " • SoS 👎"; return "";})();
  const riskStr = (()=>{ const h = healthRiskPenalty(p); if (h >= 0.5) return " • Risk ⚠️"; if (h >= 0.25) return " • Risk ⬆️"; return "";})();

  const stackBadge = (p.hasMyStack || hasPrimaryStackForMyTeam(p))
      ? `<span class="badge stack" title="Stacks with your roster">🔗 STACK</span>` : "";
  const upgradeBadge = p.upgradeForPos
      ? `<span class="badge" style="background:#22c55e1a;border:1px solid #22c55e;color:#22c55e;">Upgrade</span>`
      : "";
  const byeDot = p.byeWarnColor ? byeDotSpan(p.byeWarnColor) : "";

  const onClickAttr = `data-pid="${p.id}"`;

  return `<div class="flex item-row">
      <div class="flex" style="gap:10px;">
        ${logo ? `<img src="${logo}" alt="${p.team||''}" class="team-logo">` : ""}
        <div>
          <div class="name">${p.player} ${stackBadge} ${upgradeBadge}
            <span class="badge tier t${t}">T${t}</span>
            <span class="badge pos ${p.pos}">${p.pos}${pr ? posRankLabel(pr) : ""}</span>
            <span class="badge">${ecrText}</span>
          </div>
          <div class="small">${p.team||""} • Bye ${p.bye||"-"} ${byeDot}${adpBit}${projBit}${sosStr}${riskStr}</div>
        </div>
      </div>
      <div><button class="draft-btn" ${onClickAttr}>Draft</button></div>
    </div>`;
}

/* ====== RENDER ====== */
function render(){
  populateRosterTeamSelect(); // keep dropdown synced
  renderBoard();
  renderMidPanel();
  renderMyRoster();
}

function renderBoard(){
  const root=el("board"); if(!root) return; root.innerHTML="";

  // newest first
  const picks = [...state.draftPicks].sort((a,b)=>b.overall-a.overall);

  if(state.boardView === "overall"){
    picks.forEach(p=> root.appendChild(boardPickElem(p)));
  } else {
    const byRound = new Map();
    for (const p of picks){
      if(!byRound.has(p.round)) byRound.set(p.round, []);
      byRound.get(p.round).push(p);
    }
    // show latest rounds first (descending)
    Array.from(byRound.keys()).sort((a,b)=>b-a).forEach(r=>{
      const h = document.createElement("div"); h.className = "round-header"; h.textContent = `Round ${r}`; root.appendChild(h);
      byRound.get(r).forEach(p=> root.appendChild(boardPickElem(p)));
    });
  }
}
function boardPickElem(p){
  const pl=state.players[p.playerIdx]; const logo = teamLogoUrl(pl.team); const pr = getPosRank(pl);
  const div=document.createElement("div"); div.className="pick";
  div.innerHTML = `<div class="flex"><span class="badge">#${p.overall} R${p.round}.${p.pickInRound}</span><span class="small">Team ${p.team+1}</span></div>
                   <div class="flex" style="justify-content:flex-start; gap:8px;">
                     ${logo ? `<img src="${logo}" alt="${pl.team||''}" class="team-logo">` : ""}
                     <div class="name">${pl.player}</div>
                   </div>
                   <div class="small"><span class="badge pos ${pl.pos}">${pl.pos}${pr ? posRankLabel(pr) : ""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"}</div>`;
  return div;
}

function renderMidPanel(){
  const root = el("midList"); if(!root) return; root.innerHTML = "";

  const teamOnClock = state.started ? currentTeamOnClock() : state.myTeamIndex;
  const isMyTurn = state.started && (teamOnClock === state.myTeamIndex);

  const hookDraftButtons = (container) => {
    container.querySelectorAll("button.draft-btn").forEach(btn=>{
      btn.onclick = ()=>{
        const pid = Number(btn.getAttribute("data-pid"));
        if (!Number.isFinite(pid)) return;

        if (state.settings.mode === "regular"){
          // only allow on my pick
          if (!isMyTurn){
            alert("Not your pick. Other teams will auto-draft.");
            return;
          }
        }
        handleUserDraft(pid);
      };
    });
  };

  if(state.midTab === "recs"){
    const { list } = computeRecommendations(teamOnClock);
    list.forEach(p=>{
      const d=document.createElement("div"); d.className="item";
      d.innerHTML = playerCardHTML(p);
      root.appendChild(d);
    });
    hookDraftButtons(root);
  } else {
    let list = state.available.map(i=>state.players[i]);
    list = applyFilters(list);
    list.sort((a,b)=> (a.ecr??1e9) - (b.ecr??1e9));

    const countsNow = byeOverlapCounts(startersAllForTeam(state.myTeamIndex));

    list.slice(0,800).forEach(p=>{
      const resulting = (p.bye!=null) ? ((countsNow.get(p.bye) || 0) + 1) : 0;
      p.byeWarnColor = byeDotColor(resulting);
      const d=document.createElement("div"); d.className="item";
      d.innerHTML = playerCardHTML(p);
      root.appendChild(d);
    });
    hookDraftButtons(root);
  }
}

function benchValue(p){
  const proj = Number(p.proj_ppr||0);
  const ecrComp = (p.ecr!=null) ? (300 - p.ecr) * 0.5 : 0;
  return proj + ecrComp;
}
function positionOrder(pos){
  const order = { RB:0, WR:1, QB:2, TE:3, K:4, DEF:5 };
  return order[pos] ?? 9;
}
function coverageStatus(fill, target){
  if (target<=0) return {label:"0/0", color:"#64748b"};
  if (fill<=0)  return {label:`0/${target}`, color:"#ef4444"};
  if (fill<target) return {label:`${fill}/${target}`, color:"#f59e0b"};
  return {label:`${fill}/${target}`, color:"#22c55e"};
}

function renderMyRoster(){
  const root=el("myRoster"); if(!root) return; root.innerHTML="";

  // Which team to show?
  const tIndex = Math.max(0, Math.min(state.settings.teams-1, state.viewTeamIndex|0));
  const mineIdxs = (state.teamRosters[tIndex] || []);
  const mine = mineIdxs.map(i=>state.players[i]).sort((a,b)=> (a.ecr ?? 9999) - (b.ecr ?? 9999));

  const s = state.settings;
  const slotsTarget = { QB:s.qb, RB:s.rb, WR:s.wr, TE:s.te, FLEX:s.flex, K:s.k, DEF:s.def };

  const starters = { QB:[], RB:[], WR:[], TE:[], K:[], DEF:[], FLEX:[] };
  const bench = [];
  for(const p of mine){
    if (slotsTarget[p.pos] && starters[p.pos].length < slotsTarget[p.pos]) { starters[p.pos].push(p); continue; }
    if ((p.pos==="RB" || p.pos==="WR") && starters.FLEX.length < slotsTarget.FLEX){ starters.FLEX.push(p); continue; }
    bench.push(p);
  }

  bench.sort((a,b)=>{
    const pa = positionOrder(a.pos), pb = positionOrder(b.pos);
    if (pa !== pb) return pa - pb;
    return benchValue(b) - benchValue(a);
  });

  const startersAll = [...starters.QB, ...starters.RB, ...starters.WR, ...starters.TE, ...starters.K, ...starters.DEF, ...starters.FLEX];
  const counts = byeOverlapCounts(startersAll);

  const section = (label, list, target, benchMode=false) => {
    let headerBadges = "";
    if (!benchMode){
      const fill = list.length;
      const cov = coverageStatus(fill, target);
      headerBadges = `<span style="border:1px solid ${cov.color};color:${cov.color};padding:2px 6px;border-radius:6px;margin-left:6px;font-size:12px;">${cov.label}</span>`;
    }

    const wrap = document.createElement("div"); wrap.className = "roster-section";
    wrap.innerHTML = `<div class="roster-header small">${label}${headerBadges}</div>`;
    for(const pl of list){
      const logo = teamLogoUrl(pl.team); const pr = getPosRank(pl); const ecr = (pl.ecr!=null) ? `#${pl.ecr}` : "#—";
      const dotColor = (pl.bye!=null) ? byeDotColor(counts.get(pl.bye) || 0) : null;
      const dot = dotColor ? byeDotSpan(dotColor) : "";
      const row = document.createElement("div"); row.className = "roster-item";
      row.innerHTML = `${logo ? `<img src="${logo}" alt="${pl.team||''}" class="team-logo team-logo-sm">` : ""}
        <div class="roster-main"><div class="roster-name">${pl.player}</div>
        <div class="roster-meta"><span class="badge pos ${pl.pos}">${pl.pos}${pr ? posRankLabel(pr) : ""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"} ${dot} • ECR ${ecr}</div></div>`;
      wrap.appendChild(row);
    }
    if (!benchMode){
      for(let i=list.length; i<target; i++){
        const empty = document.createElement("div"); empty.className = "roster-item slot-empty";
        empty.innerHTML = `<div class="slot-dot"></div><div class="roster-main">
          <div class="roster-name muted">Empty ${label} Slot</div>
          <div class="roster-meta muted">—</div></div>`;
        wrap.appendChild(empty);
      }
    } else {
      for(let i=list.length; i<s.bench; i++){
        const empty = document.createElement("div"); empty.className = "roster-item slot-empty";
        empty.innerHTML = `<div class="slot-dot"></div><div class="roster-main">
          <div class="roster-name muted">Empty Bench</div>
          <div class="roster-meta muted">—</div></div>`;
        wrap.appendChild(empty);
      }
    }
    root.appendChild(wrap);
  };

  section("QB", starters.QB, slotsTarget.QB);
  section("RB", starters.RB, slotsTarget.RB);
  section("WR", starters.WR, slotsTarget.WR);
  section("TE", starters.TE, slotsTarget.TE);
  section("FLEX (W/R)", starters.FLEX, slotsTarget.FLEX);
  section("K", starters.K, slotsTarget.K);
  section("DEF", starters.DEF, slotsTarget.DEF);
  section("Bench", bench, s.bench, true);
}

/* ====== UI TABS ====== */
function updateBoardTabs(){
  el("tabOverall")?.classList.toggle("active", state.boardView==="overall");
  el("tabByRound")?.classList.toggle("active", state.boardView==="round");
}
function updateMidTabs(){
  el("subtabRecs")?.classList.toggle("active", state.midTab==="recs");
  el("subtabRanks")?.classList.toggle("active", state.midTab==="ranks");
}

/* ====== ROSTER VIEW DROPDOWN ====== */
function populateRosterTeamSelect(){
  const sel = el("rosterTeamSelect");
  if(!sel) return;
  const T = state.settings.teams;
  const prev = String(sel.value ?? "");
  sel.innerHTML = "";
  for (let i=0;i<T;i++){
    const opt = document.createElement("option");
    // Do NOT append "(You)" per request
    opt.value = String(i);
    opt.textContent = `Team ${i+1}`;
    sel.appendChild(opt);
  }
  // set selected to current viewTeamIndex
  sel.value = String(Math.max(0, Math.min(T-1, state.viewTeamIndex|0)));
}

/* ====== RESULTS MODAL ====== */
function showResultsModal(){
  const existing = document.querySelector(".modal-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const modal = document.createElement("div");
  modal.className = "modal";

  const title = document.createElement("h2");
  title.textContent = "Draft Results";
  modal.appendChild(title);

  const desc = document.createElement("div");
  desc.className = "small";
  desc.textContent = "Grades by position and overall for every team.";
  modal.appendChild(desc);

  // Compute grades
  const grades = computeLeagueGrades();
  const container = document.createElement("div");
  container.className = "grades-grid";

  grades.forEach((g, idx)=>{
    const card = document.createElement("div");
    card.className = "grade-card";
    const hdr = document.createElement("div");
    hdr.className = "grade-card-head";
    hdr.innerHTML = `<strong>Team ${idx+1}</strong> • Overall: <span class="grade">${g.overallGrade}</span>`;
    const body = document.createElement("div");
    body.className = "grade-card-body small";
    body.innerHTML = `
      QB: <strong>${g.byPos.QB.grade}</strong> &nbsp;
      RB: <strong>${g.byPos.RB.grade}</strong> &nbsp;
      WR: <strong>${g.byPos.WR.grade}</strong> &nbsp;
      TE: <strong>${g.byPos.TE.grade}</strong> &nbsp;
      K: <strong>${g.byPos.K.grade}</strong> &nbsp;
      DEF: <strong>${g.byPos.DEF.grade}</strong>
    `;
    card.appendChild(hdr); card.appendChild(body);
    container.appendChild(card);
  });

  modal.appendChild(container);

  const actions = document.createElement("div");
  actions.className = "row";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.onclick = ()=> overlay.remove();
  actions.appendChild(closeBtn);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function computeLeagueGrades(){
  const T = state.settings.teams;
  const positions = ["QB","RB","WR","TE","K","DEF"];

  // For each team, compute starter projections per position
  const perTeam = [];
  for (let t=0; t<T; t++){
    const { starters, flex } = startersByPosForTeam(t);

    // Build sums of projected PPR (use 0 if missing)
    const sumProj = (arr)=> arr.reduce((acc,p)=> acc + Number(p?.proj_ppr||0), 0);
    const byPosProj = {
      QB: sumProj(starters.QB),
      RB: sumProj(starters.RB) + sumProj(flex.filter(x=>x.pos==="RB")),
      WR: sumProj(starters.WR) + sumProj(flex.filter(x=>x.pos==="WR")),
      TE: sumProj(starters.TE),
      K:  sumProj(starters.K),
      DEF: sumProj(starters.DEF)
    };

    const total = byPosProj.QB + byPosProj.RB + byPosProj.WR + byPosProj.TE + byPosProj.K + byPosProj.DEF;
    perTeam.push({ t, byPosProj, total });
  }

  // Compute league means & stddevs for z-scores
  const stats = {};
  const mean = (vals)=> vals.reduce((a,b)=>a+b,0) / Math.max(1,vals.length);
  const std = (vals, m)=> Math.sqrt(mean(vals.map(v=> (v-m)*(v-m))));
  positions.concat(["TOTAL"]).forEach(pos=>{
    const vals = (pos==="TOTAL") ? perTeam.map(x=>x.total) : perTeam.map(x=>x.byPosProj[pos]);
    const m = mean(vals); const s = std(vals, m) || 1;
    stats[pos] = { m, s };
  });

  // Convert to letter grades
  const toGrade = (z)=>{
    if (z >= 1.25) return "A+";
    if (z >= 0.75) return "A";
    if (z >= 0.35) return "A-";
    if (z >= 0.15) return "B+";
    if (z >= -0.1) return "B";
    if (z >= -0.35) return "B-";
    if (z >= -0.75) return "C+";
    if (z >= -1.25) return "C";
    if (z >= -1.75) return "C-";
    return "D";
  };

  const out = perTeam.map(team=>{
    const byPos = {};
    positions.forEach(pos=>{
      const z = (team.byPosProj[pos] - stats[pos].m) / stats[pos].s;
      byPos[pos] = { z, grade: toGrade(z) };
    });
    const zTot = (team.total - stats.TOTAL.m) / stats.TOTAL.s;
    const overallGrade = toGrade(zTot);
    return { team: team.t, byPos, overallGrade };
  });

  return out;
}

/* ====== SMALL UI ====== */
function flashOnTheClock(){
  const elOTC = el("onTheClock");
  if (!elOTC) return;
  const t = currentTeamOnClock();
  elOTC.textContent = `On the clock: Team ${t+1}`;
  elOTC.classList.add("flash");
  setTimeout(()=> elOTC.classList.remove("flash"), 350);
}

/* ====== UTIL ====== */
