/* =======================================================================
   Fantasy Football War Room — Full app.js (unabridged)
   - Manual vs Regular draft modes (Regular auto-drafts others)
   - Simplified controls (Start, Best Pick, Undo, Previous)
   - Recommendations with advanced scoring (VOR, needs, scarcity, stacks,
     bye overlap nudges, ADP value, late upside)
   - Bye overlap warning dots (2=yellow, 3=orange, 4+=red)
   - ADP delta badges (value/reach/neutral)
   - Unified player cards; projections & replacement baselines
   - My roster viewer + Team switcher to view any roster
   - End-of-draft grades modal (overall + by position; A/B/C/D)
   - Robust null-guarding for DOM hooks
   ======================================================================= */

const DATA_URL = "./consensus.json";

/* =======================
   Tunable Weights / Rules
   ======================= */
const WEIGHTS = {
  vor: 1.0,
  tierBoost: 1.0,
  valueVsADP: 0.8,

  need: 0.9,
  scarcity: 0.7,
  stackSynergy: 1.0,
  byePenalty: -0.5,      // same-position starter bye overlap (kept small)
  lateUpside: 0.6,

  lateRoundStartPct: 0.5,   // when late-round upside begins
  deepRoundStartPct: 0.75   // deeper rounds get extra bump
};
const TEAM_WIDE_BYE_DUP_PENALTY = -1.5; // small nudge away from team-wide overlaps
const UPGRADE_ECR_GAP = 5;              // show "Upgrade Available" if ECR improves this much

/* =======================
   Global Draft State
   ======================= */
let state = {
  settings: {
    mode: "regular", // "regular" | "manual"
    teams: 12, rounds: 16, pickPos: 5, scoring: "PPR",
    qb: 1, rb: 2, wr: 2, te: 1, flex: 1, k: 1, def: 1, bench: 8
  },

  players: [],
  available: [],     // indexes into players still available
  draftPicks: [],    // [{overall, team, round, pickInRound, playerIdx}]
  currentOverall: 1,

  myTeamIndex: 0,
  viewTeamIndex: 0,  // which team roster we are currently viewing in the right column
  teamRosters: [],   // per team: array of player indexes
  rosterSlots: [],   // per team: {QB,RB,WR,TE,FLEX,K,DEF,BEN} counts
  started: false,
  paused: false,

  features: { stack:true },

  dataFlags: { hasProj:false, hasADP:false },
  autoplay: { loopId:null, delayMs:350 },

  boardView: localStorage.getItem("boardView") || "overall",  // "overall" | "round"
  midTab: localStorage.getItem("midTab") || "recs",            // "recs" | "ranks"

  filters: {
    pos: (localStorage.getItem("filterPos") || "").toUpperCase(),
    q: localStorage.getItem("searchName") || ""
  },

  posRankCache: {},
  dataSource: "consensus.json"
};

/* =======================
   DOM Helpers
   ======================= */
const el = id => document.getElementById(id);
const qs = (sel, root=document) => root.querySelector(sel);
const qsa = (sel, root=document) => Array.from(root.querySelectorAll(sel));

/* Graceful class toggle */
function toggleClass(node, className, on){
  if(!node) return;
  if(on) node.classList.add(className); else node.classList.remove(className);
}

/* =======================
   Normalizers
   ======================= */
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

/* =======================
   Pos rank cache
   ======================= */
function buildPosRankCache(){
  state.posRankCache = {};
  ["QB","RB","WR","TE","K","DEF"].forEach(pos=>{
    const arr = state.players.filter(p=>p.pos===pos && p.ecr!=null)
      .sort((a,b)=>(a.ecr)-(b.ecr));
    const map = new Map();
    arr.forEach((p,idx)=> map.set(p.id ?? p.player, idx+1));
    state.posRankCache[pos] = map;
  });
}
function getPosRank(p){ const m = state.posRankCache[p.pos]; return m ? m.get(p.id ?? p.player) : undefined; }
function posRankLabel(rank) { return rank ? String(rank) : ""; }

/* =======================
   Draft Math
   ======================= */
function overallToTeam(overall){
  const T=state.settings.teams; const r=Math.ceil(overall/T); const pos=overall-(r-1)*T;
  return (r%2===1) ? (pos-1) : (T - pos);
}
function getRound(overall){ return Math.ceil(overall/state.settings.teams); }
function pickInRound(overall){ const r=getRound(overall), start=(r-1)*state.settings.teams+1; return overall-start+1; }
function totalPicks(){ return state.settings.teams * state.settings.rounds; }
function draftProgressPct(){ const total = totalPicks(); return Math.min(1, (state.currentOverall-1)/Math.max(1,total)); }

/* =======================
   Stack / Bye / Needs
   ======================= */
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

/* Same-position bye overlap (minor penalty) */
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

/* Team-wide helpers */
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
function candidateSharesTeamBye(teamIndex, candidate){
  if (!candidate.bye) return false;
  const starters = startersAllForTeam(teamIndex);
  return starters.some(p => (p?.bye||-1) === candidate.bye);
}

/* Positional scarcity boost */
function computeScarcityBoost(p){
  const total = state.players.filter(x=>x.pos===p.pos).length;
  const remain = state.available.map(i=>state.players[i]).filter(x=>x.pos===p.pos).length;
  if(total === 0) return 0;
  const pctRemain = remain/total;
  const scarcity = (1 - pctRemain);
  const posFactor = (p.pos==="RB"||p.pos==="WR") ? 1.2 : (p.pos==="TE"? 1.0 : 0.6);
  return scarcity * posFactor * 4;
}

/* Need weighting based on open starting slots */
function rosterNeeds(teamIndex){
  const s=state.settings, slots=state.rosterSlots[teamIndex]||{QB:0,RB:0,WR:0,TE:0,FLEX:0,K:0,DEF:0,BEN:0};
  const target={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te,K:s.k,DEF:s.def}, need={};
  for(const pos of ["QB","RB","WR","TE","K","DEF"]){
    const have=slots[pos]||0, left=Math.max(0,(target[pos]||0)-have);
    need[pos]= 1 + (left*0.8);
  }
  return need;
}

/* Late-round upside bonus based on ADP discount & round depth */
function lateRoundUpsideBonus(p){
  const pct = draftProgressPct();
  if (pct < WEIGHTS.lateRoundStartPct) return 0;
  const discount = (state.dataFlags.hasADP && p.adp) ? Math.max(0, p.adp - state.currentOverall) : 0;
  if (discount <= 0) return 0;
  const tier = p.tier || 6;
  const tierLean = Math.max(0, (tier-2));
  const deep = (pct >= WEIGHTS.deepRoundStartPct) ? 1.25 : 1.0;
  return (Math.log10(1 + discount) * (0.75 + 0.25*tierLean)) * deep;
}

/* =======================
   Data Load / CSV Upload
   ======================= */
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
      bye: p.bye ?? p.Bye ?? p.bye_week ?? null
    };
  }).filter(p => allowed.has(p.pos));

  state.available = state.players.map((_,i)=>i);
  state.dataFlags.hasProj = state.players.some(p=> (p.proj_ppr||0) > 0);
  state.dataFlags.hasADP  = state.players.some(p=> p.adp !== null && p.adp !== undefined);
  buildPosRankCache();
}

/* CSV Upload */
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
  return {
    player, team, pos, bye,
    ecr: isFinite(ecr)? ecr : null,
    adp: isFinite(adp)? adp : null,
    tier: isFinite(tier)? tier : null,
    proj_ppr: isFinite(proj)? proj : null
  };
}
function toNum(x){ const n = Number(String(x||"").replace(/[^0-9.\-]/g,"")); return isFinite(n)? n : null; }

/* =======================
   Init & Wiring
   ======================= */
document.addEventListener("DOMContentLoaded", init);

function init() {
  ensureGradesModal();
  wireSettings();
  initCsvUpload();
  wireControls();
  wireTabs();
  wireFilters();
  loadConsensus();
  setInterval(loadConsensus, 30*60*1000);
  render();
}

function wireSettings(){
  // Mode
  const modeSel = el("modeSelect");
  if (modeSel){
    modeSel.value = state.settings.mode;
    modeSel.addEventListener("change", ()=>{
      state.settings.mode = modeSel.value === "manual" ? "manual" : "regular";
      applyModeUI();
    });
  }

  const ids = ["teams","rounds","pickPos","scoring",
               "qbSlots","rbSlots","wrSlots","teSlots","flexSlots","kSlots","defSlots","benchSlots"];
  ids.forEach(id => el(id)?.addEventListener("input", syncSettings));

  // Team viewer select
  const teamSelect = el("teamSelect");
  if (teamSelect){
    teamSelect.addEventListener("change", ()=>{
      const ix = +teamSelect.value;
      if (Number.isFinite(ix)) { state.viewTeamIndex = ix; renderMyRoster(); }
    });
  }
  applyModeUI();
}

function applyModeUI(){
  // Hide/show controls per mode
  const isManual = state.settings.mode === "manual";
  const nextBtn = el("nextPick");
  const pauseBtn = el("pauseMock"); // may not exist anymore
  const resumeBtn = el("resumeMock"); // may not exist anymore
  const untilBtn = el("autoUntilMyPick"); // may not exist anymore
  const autoOthers = el("autoOthers"); // not displayed now
  const exportBtn = el("exportBoard"); // not displayed now

  if (nextBtn){
    // In Regular: "Best Pick" when it's your turn; In Manual: disabled (you draft by clicking)
    nextBtn.textContent = isManual ? "Best Pick (disabled in Manual)" : "Best Pick (My Turn)";
    nextBtn.disabled = isManual;
  }
  // Hide deprecated clutter if still in HTML
  [pauseBtn,resumeBtn,untilBtn,autoOthers,exportBtn].forEach(x=> x && (x.style.display="none"));
}

function wireControls(){
  el("startMock")?.addEventListener("click", startDraft);
  el("nextPick")?.addEventListener("click", doBestPickForMe);
  el("prevPick")?.addEventListener("click", () => { undoPick(); });
  el("undoPick")?.addEventListener("click", () => { undoPick(); });

  // Grades modal close
  el("closeGrades")?.addEventListener("click", closeGradesModal);
  // Close on backdrop click
  el("gradesModal")?.addEventListener("click", (e)=>{
    if (e.target && e.target.id === "gradesModal") closeGradesModal();
  });
}

function wireTabs(){
  el("tabOverall")?.addEventListener("click", () => {
    state.boardView="overall"; localStorage.setItem("boardView","overall");
    updateBoardTabs(); renderBoard();
  });
  el("tabByRound")?.addEventListener("click", () => {
    state.boardView="round";   localStorage.setItem("boardView","round");
    updateBoardTabs(); renderBoard();
  });
  updateBoardTabs();

  // Subtabs via event delegation
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
}

function wireFilters(){
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

  const posSel = el("filterPos"); if (posSel) posSel.value = state.filters.pos;
  const qInput = el("searchName"); if (qInput) qInput.value = state.filters.q;
}

/* =======================
   Start / Autoplay
   ======================= */
function syncSettings(){ const s=state.settings;
  s.teams=+el("teams")?.value||12; s.rounds=+el("rounds")?.value||16; s.pickPos=+el("pickPos")?.value||5;
  s.scoring=el("scoring")?.value||"PPR";
  s.qb=+el("qbSlots")?.value||1; s.rb=+el("rbSlots")?.value||2; s.wr=+el("wrSlots")?.value||2;
  s.te=+el("teSlots")?.value||1; s.flex=+el("flexSlots")?.value||1; s.k=+el("kSlots")?.value||1; s.def=+el("defSlots")?.value||1; s.bench=+el("benchSlots")?.value||8;
}

function startDraft(){
  if (!state.players.length){ alert("Load players first (consensus.json or upload CSV)."); return; }
  syncSettings();
  const s = state.settings;
  state.myTeamIndex = Math.min(Math.max(0, s.pickPos-1), s.teams-1);
  state.viewTeamIndex = state.myTeamIndex;

  const T = s.teams;
  state.teamRosters = new Array(T).fill(0).map(()=>[]);
  state.rosterSlots = new Array(T).fill(0).map(()=>({QB:0,RB:0,WR:0,TE:0,FLEX:0,K:0,DEF:0,BEN:0}));
  state.draftPicks = []; state.currentOverall = 1; state.started = true; state.paused=false;

  populateTeamSelect(T);
  applyModeUI();
  render();

  if (s.mode==="regular") startAutoLoop(); else stopAutoLoop();
}

function startAutoLoop(){
  stopAutoLoop();
  if (state.settings.mode !== "regular") return;
  state.autoplay.loopId = setInterval(autoTick, state.autoplay.delayMs);
}

function stopAutoLoop(){
  if(state.autoplay.loopId){ clearInterval(state.autoplay.loopId); state.autoplay.loopId=null; }
}

function autoTick(){
  if (!state.started) return;
  const total = totalPicks();
  if (state.currentOverall > total){ stopAutoLoop(); endDraftIfComplete(); return; }

  const team = overallToTeam(state.currentOverall);
  if (team === state.myTeamIndex){
    // Pause on my pick in regular mode; user clicks Draft on a player card or "Best Pick"
    stopAutoLoop();
    renderMidPanel(); // ensure buttons show enabled
    return;
  }

  // Auto-draft for others
  aiPick(team);
  advanceAfterPick(false); // compute next; we'll keep looping until my pick
  endDraftIfComplete();
}

/* =======================
   Draft Actions
   ======================= */
function doBestPickForMe(){
  if (!state.started) return;
  if (state.settings.mode === "manual"){ return; }
  const team = overallToTeam(state.currentOverall);
  if (team !== state.myTeamIndex) return; // not my turn yet
  const { list } = computeRecommendations(team);
  if (!list.length) { alert("No candidates available."); return; }
  draftPlayerById(list[0].id, team);
  postPickFlow();
}

function nextPickManualByClick(playerId){
  // In manual mode, Draft button on card calls this implicitly via draftPlayerById
  const teamOnClock = overallToTeam(state.currentOverall);
  draftPlayerById(playerId, teamOnClock);
  postPickFlow();
}

function postPickFlow(){
  advanceAfterPick(false);
  if (state.settings.mode === "regular"){
    // Resume auto for others until it gets back to my pick
    startAutoLoop();
  } else {
    // Manual: wait for next user click
    render();
  }
  endDraftIfComplete();
}

function aiPick(teamIndex){
  const {list}=computeRecommendations(teamIndex);
  if(!list.length) return;
  const early = draftProgressPct() < 0.2;
  const k = early ? Math.min(6, list.length) : Math.min(3, list.length);
  const weights = Array.from({length:k},(_,i)=>(k-i));
  const sum=weights.reduce((a,b)=>a+b,0);
  let r=Math.random()*sum, pick=list[0];
  for(let i=0;i<k;i++){ r-=weights[i]; if(r<=0){ pick=list[i]; break; } }
  draftPlayerById(pick.id,teamIndex);
}

function draftPlayerById(id, teamIndex){
  const poolIdx = state.players.findIndex(p=>p.id===id); if(poolIdx===-1) return;
  draftByIndex(poolIdx, teamIndex);
}

function draftByIndex(poolIdx, teamIndex){
  if(state.players[poolIdx].drafted) return;
  // remove from available pool
  const idxAvail = state.available.indexOf(poolIdx); if(idxAvail!==-1) state.available.splice(idxAvail,1);
  state.players[poolIdx].drafted=true;

  const overall=state.currentOverall, round=getRound(overall), pir=pickInRound(overall);
  state.teamRosters[teamIndex].push(poolIdx);
  bumpRosterSlot(teamIndex, state.players[poolIdx].pos);
  state.draftPicks.push({overall, team:teamIndex, round, pickInRound:pir, playerIdx:poolIdx});

  render(); // update board + rosters + mid list
}

function bumpRosterSlot(teamIndex,pos){
  const s=state.rosterSlots[teamIndex]; if(!s) return;
  if(pos in s) s[pos]++; else s.BEN++;
}

function undoPick(){
  if(!state.draftPicks.length) return;
  const last=state.draftPicks.pop();
  const {playerIdx, team, overall}=last;

  // mark available again
  state.players[playerIdx].drafted=false;
  if(!state.available.includes(playerIdx)) state.available.push(playerIdx);

  // remove from roster
  const r=state.teamRosters[team]; const ix=r.lastIndexOf(playerIdx); if(ix>=0) r.splice(ix,1);

  // reduce slot counts
  const pos=state.players[playerIdx].pos;
  if(pos in state.rosterSlots[team]) state.rosterSlots[team][pos]=Math.max(0, state.rosterSlots[team][pos]-1);

  state.currentOverall = overall; // rewind the clock to that overall
  render();
}

function advanceAfterPick(shouldRender=true){
  state.currentOverall += 1;
  if (shouldRender) render();
}

/* =======================
   Export (kept but hidden UI)
   ======================= */
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

/* =======================
   Scoring / Filters
   ======================= */
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

function computeRecommendations(teamIndex){
  const base = replacementLevels();
  const needs = rosterNeeds(teamIndex);
  let candidates = state.available.map(i=>state.players[i]);
  candidates = applyFilters(candidates);

  const pct = draftProgressPct();
  const worstEcr = worstStarterEcrByPos(state.myTeamIndex);

  // Precompute current team-wide bye counts for the viewer's team
  const myStartersNow = startersAllForTeam(state.myTeamIndex);
  const countsNow = byeOverlapCounts(myStartersNow);

  const scored = candidates.map(p=>{
    const baseProj = state.dataFlags.hasProj ? (p.proj_ppr||0) : 0;
    const rep = state.dataFlags.hasProj ? (base[p.pos]||0) : 0;
    const vor = baseProj - rep;
    const tierBoost = (6 - Math.min(p.tier||6,6));
    const valueBoost = state.dataFlags.hasADP ? Math.max(0,(p.adp||state.currentOverall)-state.currentOverall)/10 : 0;

    const needW = (needs[p.pos]||1.0);
    const scarcity = computeScarcityBoost(p);
    const stackSynergy = stackBonusForTeam(teamIndex, p);
    const byePenSamePos = byeOverlapPenalty(teamIndex, p);
    const teamByeDup = candidateSharesTeamBye(teamIndex, p) ? TEAM_WIDE_BYE_DUP_PENALTY : 0;
    const upside = lateRoundUpsideBonus(p);

    let score =
      WEIGHTS.vor * (state.dataFlags.hasProj ? vor : 0) +
      WEIGHTS.tierBoost * tierBoost +
      WEIGHTS.valueVsADP * valueBoost +
      WEIGHTS.need * needW +
      WEIGHTS.scarcity * scarcity +
      WEIGHTS.stackSynergy * stackSynergy +
      WEIGHTS.byePenalty * Math.min(0, byePenSamePos) +
      teamByeDup +
      WEIGHTS.lateUpside * upside;

    // Deprioritize K/DEF before 60% of the draft
    if ((p.pos==="K" || p.pos==="DEF") && pct < 0.6) score -= 3 * (0.6 - pct);

    const upgradeForPos = (() => {
      const worst = worstEcr[p.pos];
      if (worst==null || p.ecr==null) return false;
      return p.ecr + UPGRADE_ECR_GAP < worst;
    })();

    // Dot color if selecting p would bring that bye to 2/3/4+
    const resulting = (p.bye!=null) ? ( (countsNow.get(p.bye) || 0) + 1 ) : 0;
    const byeWarnColor = byeDotColor(resulting);

    return {...p, baseProj, rep, vor, score,
            hasMyStack: hasPrimaryStackForMyTeam(p),
            upgradeForPos,
            byeWarnColor };
  });

  scored.sort((a,b)=> b.score-a.score);
  return { list: scored.slice(0,40), baseline: base, needs };
}

/* =======================
   Player Cards
   ======================= */
function adpDeltaBadgeHTML(adp){
  if (!state.dataFlags.hasADP || !Number.isFinite(adp)) return "";
  const delta = Math.round(adp - state.currentOverall);
  let cls="badge-yellow", label="";
  if (delta >= 8) { cls="badge-green";  label=`Value +${delta}`; }
  else if (delta <= -8) { cls="badge-red"; label=`Reach ${delta}`; }
  else { label = `±${delta}`; }
  return `<span class="badge ${cls}" title="ADP delta vs current pick">${label}</span>`;
}

function playerCardHTML(p, allowDraft){
  const logo = teamLogoUrl(p.team);
  const pr = getPosRank(p);
  const t  = p.tier || 6;
  const ecrText = (p.ecr!=null)? `#${p.ecr}` : "#—";

  const projBit = state.dataFlags.hasProj
      ? (` • Proj ${Number(p.baseProj ?? p.proj_ppr ?? 0).toFixed(1)}`
         + (p.rep!=null ? ` (rep ${Number(p.rep).toFixed(1)})` : "")
         + (p.vor!=null ? ` • VOR ${(p.vor).toFixed(1)}` : ""))
      : "";

  const stackBadge = (p.hasMyStack || hasPrimaryStackForMyTeam(p))
      ? `<span class="badge stack" title="Stacks with your roster">🔗 STACK</span>` : "";
  const upgradeBadge = p.upgradeForPos
      ? `<span class="badge" style="background:#22c55e1a;border:1px solid #22c55e;color:#22c55e;">Upgrade Available</span>`
      : "";
  const byeDot = p.byeWarnColor ? byeDotSpan(p.byeWarnColor) : "";

  const adpPlain = state.dataFlags.hasADP ? ` • ADP ${p.adp || "-"}` : "";
  const adpDelta = (state.dataFlags.hasADP && Number.isFinite(p.adp)) ? adpDeltaBadgeHTML(p.adp) : "";

  const btn = allowDraft
    ? `<button class="draft-btn" data-pid="${p.id}">Draft</button>`
    : `<button class="draft-btn" disabled title="Not your pick yet">Waiting…</button>`;

  return `<div class="item">
    <div class="flex">
      <div class="flex" style="gap:10px;">
        ${logo ? `<img src="${logo}" alt="${p.team||''}" class="team-logo">` : ""}
        <div>
          <div class="name">${p.player} ${stackBadge} ${upgradeBadge}
            <span class="badge tier t${t}">T${t}</span>
            <span class="badge pos ${p.pos}">${p.pos}${pr ? posRankLabel(pr) : ""}</span>
            <span class="badge">${ecrText}</span>
            ${adpDelta}
          </div>
          <div class="small">${p.team||""} • Bye ${p.bye||"-"} ${byeDot}${adpPlain}${projBit}</div>
        </div>
      </div>
      <div>${btn}</div>
    </div>
  </div>`;
}

/* =======================
   Render
   ======================= */
function render(){ renderBoard(); renderMidPanel(); renderRosterPanelHeader(); renderMyRoster(); }

function renderBoard(){
  const root=el("board"); if(!root) return; root.innerHTML="";
  const picks = [...state.draftPicks].sort((a,b)=>a.overall-b.overall);

  if(state.boardView === "overall"){
    picks.forEach(p=> root.appendChild(boardPickElem(p)));
  } else {
    const byRound = new Map();
    picks.forEach(p=>{ if(!byRound.has(p.round)) byRound.set(p.round, []); byRound.get(p.round).push(p); });
    Array.from(byRound.keys()).sort((a,b)=>a-b).forEach(r=>{
      const h = document.createElement("div"); h.className = "round-header"; h.textContent = `Round ${r}`; root.appendChild(h);
      byRound.get(r).forEach(p=> root.appendChild(boardPickElem(p)));
    });
  }
}

function boardPickElem(p){
  const pl=state.players[p.playerIdx]; const logo = teamLogoUrl(pl.team); const pr = getPosRank(pl);
  const div=document.createElement("div"); div.className="pick";
  div.innerHTML = `
    <div class="flex"><span class="badge">#${p.overall} R${p.round}.${p.pickInRound}</span><span class="small">Team ${p.team+1}</span></div>
    <div class="flex" style="justify-content:flex-start; gap:8px;">
      ${logo ? `<img src="${logo}" alt="${pl.team||''}" class="team-logo">` : ""}
      <div class="name">${pl.player}</div>
    </div>
    <div class="small"><span class="badge pos ${pl.pos}">${pl.pos}${pr ? posRankLabel(pr) : ""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"}</div>`;
  return div;
}

function renderMidPanel(){
  const root = el("midList"); if(!root) return; root.innerHTML = "";
  const total = totalPicks();
  if (!state.started || state.currentOverall > total){
    root.innerHTML = `<div class="small muted">Start the draft to see recommendations.</div>`;
    return;
  }

  const teamOnClock = overallToTeam(state.currentOverall);
  const isMyTurn = teamOnClock === state.myTeamIndex;
  const allowDraft = (state.settings.mode === "manual") ? true : isMyTurn;

  if(state.midTab === "recs"){
    const { list } = computeRecommendations(teamOnClock);
    list.forEach(p=>{
      const html = playerCardHTML(p, allowDraft);
      const d = document.createElement("div");
      d.innerHTML = html;
      const btn = d.querySelector("button[data-pid]");
      if (btn){
        btn.onclick = ()=>{
          if (!allowDraft) return;
          if (state.settings.mode === "manual"){
            nextPickManualByClick(p.id);
          } else {
            // Regular: only allowed on my pick
            draftPlayerById(p.id, teamOnClock);
            postPickFlow();
          }
        };
      }
      // unwrap one level to append .item directly
      root.appendChild(d.firstElementChild);
    });
  } else {
    let list = state.available.map(i=>state.players[i]);
    list = applyFilters(list);
    list.sort((a,b)=> (a.ecr??1e9) - (b.ecr??1e9));

    // For rankings, we still show bye warn color as hypothetical
    const countsNow = byeOverlapCounts(startersAllForTeam(state.myTeamIndex));

    list.slice(0,800).forEach(p=>{
      const resulting = (p.bye!=null) ? ((countsNow.get(p.bye) || 0) + 1) : 0;
      p.byeWarnColor = byeDotColor(resulting);
      p.baseProj = p.proj_ppr || 0;
      p.rep = 0; p.vor = 0;
      const html = playerCardHTML(p, allowDraft);
      const d = document.createElement("div");
      d.innerHTML = html;
      const btn = d.querySelector("button[data-pid]");
      if (btn){
        btn.onclick = ()=>{
          if (!allowDraft) return;
          const team = overallToTeam(state.currentOverall);
          if (state.settings.mode === "manual") nextPickManualByClick(p.id);
          else {
            if (team !== state.myTeamIndex) return;
            draftPlayerById(p.id, team);
            postPickFlow();
          }
        };
      }
      root.appendChild(d.firstElementChild);
    });
  }
}

function renderRosterPanelHeader(){
  const title = el("rosterTitle");
  const teamSelect = el("teamSelect");
  if (!title && !teamSelect) return;

  const T = state.settings.teams || 12;
  if (teamSelect && teamSelect.options.length !== T){
    populateTeamSelect(T);
  }
  if (title){
    const ix = state.viewTeamIndex ?? state.myTeamIndex;
    title.textContent = `Roster — Team ${ix+1}`;
  }
}

function populateTeamSelect(T){
  const sel = el("teamSelect");
  if (!sel) return;
  sel.innerHTML = "";
  for(let i=0;i<T;i++){
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = (i===state.myTeamIndex) ? `Team ${i+1} (Me)` : `Team ${i+1}`;
    sel.appendChild(opt);
  }
  sel.value = String(state.viewTeamIndex ?? state.myTeamIndex);
}

function coverageStatus(fill, target){
  if (target<=0) return {label:"0/0", color:"#64748b"};
  if (fill<=0)  return {label:`0/${target}`, color:"#ef4444"};
  if (fill<target) return {label:`${fill}/${target}`, color:"#f59e0b"};
  return {label:`${fill}/${target}`, color:"#22c55e"};
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

function renderMyRoster(){
  const root=el("myRoster"); if(!root) return; root.innerHTML="";

  const teamIndex = state.viewTeamIndex ?? state.myTeamIndex;
  const mineIdxs = (state.teamRosters[teamIndex] || []);
  const mine = mineIdxs.map(i=>state.players[i]).sort((a,b)=> (a.ecr ?? 9999) - (b.ecr ?? 9999));

  const slotsTarget = {
    QB: state.settings.qb, RB: state.settings.rb, WR: state.settings.wr,
    TE: state.settings.te, FLEX: state.settings.flex, K: state.settings.k, DEF: state.settings.def
  };

  // Build starters & bench
  const starters = { QB:[], RB:[], WR:[], TE:[], K:[], DEF:[], FLEX:[] };
  const bench = [];
  for(const p of mine){
    if (slotsTarget[p.pos] && starters[p.pos].length < slotsTarget[p.pos]) { starters[p.pos].push(p); continue; }
    if ((p.pos==="RB" || p.pos==="WR") && starters.FLEX.length < slotsTarget.FLEX){ starters.FLEX.push(p); continue; }
    bench.push(p);
  }

  // Bench sorting
  bench.sort((a,b)=>{
    const pa = positionOrder(a.pos), pb = positionOrder(b.pos);
    if (pa !== pb) return pa - pb;
    return benchValue(b) - benchValue(a);
  });

  // Bye overlaps among ALL starters (including FLEX)
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
      for(let i=list.length; i<state.settings.bench; i++){
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
  section("Bench", bench, state.settings.bench, true);
}

/* =======================
   UI Tabs Helpers
   ======================= */
function updateBoardTabs(){
  toggleClass(el("tabOverall"), "active", state.boardView==="overall");
  toggleClass(el("tabByRound"), "active", state.boardView==="round");
}
function updateMidTabs(){
  toggleClass(el("subtabRecs"), "active", state.midTab==="recs");
  toggleClass(el("subtabRanks"), "active", state.midTab==="ranks");
}

/* =======================
   End-of-Draft Grades
   ======================= */
function endDraftIfComplete(){
  const total = totalPicks();
  if (state.started && state.currentOverall > total){
    state.started = false;
    stopAutoLoop();
    showGradesModal(buildDraftGrades());
  }
}

function buildDraftGrades(){
  // Collect per-team positional totals for starters (including FLEX)
  const T = state.settings.teams;
  const slotTargets = {
    QB: state.settings.qb, RB: state.settings.rb, WR: state.settings.wr,
    TE: state.settings.te, FLEX: state.settings.flex, K: state.settings.k, DEF: state.settings.def
  };
  const teamTotals = Array.from({length:T}, (_,ti) => {
    const { starters, flex } = startersByPosForTeam(ti);
    const sumPos = (list) => list.reduce((acc,p)=> acc + (p.proj_ppr||0), 0);
    const pos = {
      QB: sumPos(starters.QB),
      RB: sumPos(starters.RB),
      WR: sumPos(starters.WR),
      TE: sumPos(starters.TE),
      FLEX: sumPos(flex),
      K: sumPos(starters.K),
      DEF: sumPos(starters.DEF)
    };
    const overall = pos.QB + pos.RB + pos.WR + pos.TE + pos.FLEX + pos.K + pos.DEF;
    return { team: ti, pos, overall };
  });

  // Build arrays for percentile thresholds
  const getArray = (key) => teamTotals.map(t => key==="overall" ? t.overall : t.pos[key]);
  const metrics = ["overall","QB","RB","WR","TE","FLEX","K","DEF"];
  const thresholds = {};
  metrics.forEach(m=>{
    const arr = getArray(m).slice().sort((a,b)=>a-b);
    thresholds[m] = {
      p25: percentile(arr, 0.25),
      p50: percentile(arr, 0.50),
      p75: percentile(arr, 0.75)
    };
  });

  // Assign letter grades
  const withGrades = teamTotals.map(t=>{
    const g = {};
    metrics.forEach(m=>{
      const v = (m==="overall") ? t.overall : t.pos[m];
      g[m] = letterFor(v, thresholds[m]);
    });
    return { ...t, grades: g };
  });

  // Sort by overall descending for display
  withGrades.sort((a,b)=> b.overall - a.overall);
  return { teams: withGrades, thresholds };
}

function percentile(arr, p){
  if (!arr.length) return 0;
  const idx = (arr.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

function letterFor(v, thr){
  if (v >= thr.p75) return "A";
  if (v >= thr.p50) return "B";
  if (v >= thr.p25) return "C";
  return "D";
}

/* Modal creation & rendering */
function ensureGradesModal(){
  if (el("gradesModal")) return;
  const wrap = document.createElement("div");
  wrap.id = "gradesModal";
  wrap.className = "modal hidden";
  wrap.innerHTML = `
    <div class="modal-box">
      <div class="modal-head">
        <h3>Draft Grades</h3>
        <button id="closeGrades" class="icon-btn" title="Close">✕</button>
      </div>
      <div class="grades-wrap">
        <table class="grades-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Team</th>
              <th>Overall</th>
              <th>QB</th>
              <th>RB</th>
              <th>WR</th>
              <th>TE</th>
              <th>FLEX</th>
              <th>K</th>
              <th>DEF</th>
            </tr>
          </thead>
          <tbody id="gradesTbody"></tbody>
        </table>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  // wire close
  el("closeGrades")?.addEventListener("click", closeGradesModal);
  el("gradesModal")?.addEventListener("click", (e)=>{ if (e.target && e.target.id==="gradesModal") closeGradesModal(); });
}

function showGradesModal(data){
  const modal = el("gradesModal"); if (!modal) return;
  const tbody = el("gradesTbody"); if (!tbody) return;

  tbody.innerHTML = "";

  const badge = (L) => {
    const cls = (L==="A")?"grade-A":(L==="B")?"grade-B":(L==="C")?"grade-C":"grade-D";
    return `<span class="grade-badge ${cls}">${L}</span>`;
    };

  data.teams.forEach((t, idx)=>{
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx+1}</td>
      <td>Team ${t.team+1}${t.team===state.myTeamIndex ? " (Me)" : ""}</td>
      <td>${badge(t.grades.overall)}</td>
      <td>${badge(t.grades.QB)}</td>
      <td>${badge(t.grades.RB)}</td>
      <td>${badge(t.grades.WR)}</td>
      <td>${badge(t.grades.TE)}</td>
      <td>${badge(t.grades.FLEX)}</td>
      <td>${badge(t.grades.K)}</td>
      <td>${badge(t.grades.DEF)}</td>
    `;
    tbody.appendChild(tr);
  });

  toggleClass(modal, "hidden", false);
}

function closeGradesModal(){
  const modal = el("gradesModal"); if (!modal) return;
  toggleClass(modal, "hidden", true);
}

/* =======================
   Small utils (dupe guard)
   ======================= */
function boardPickElemDup(p){
  // legacy duplicate guard; not used
  const pl=state.players[p.playerIdx]; const logo = teamLogoUrl(pl.team); const pr = getPosRank(pl);
  const div=document.createElement("div"); div.className="pick";
  div.innerHTML=`<div class="flex"><span class="badge">#${p.overall} R${p.round}.${p.pickInRound}</span><span class="small">Team ${p.team+1}</span></div>
  <div class="flex" style="justify-content:flex-start; gap:8px;">${logo?`<img src="${logo}" class="team-logo">`:""}<div class="name">${pl.player}</div></div>
  <div class="small"><span class="badge pos ${pl.pos}">${p.pos}${pr ? posRankLabel(pr) : ""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"}</div>`;
  return div;
}
