/* Fantasy Football War Room — Full App
   - Regular / Manual Draft modes (League Settings)
   - Minimal controls (Start Draft, Undo)
   - Status bar updates while drafting
   - Rankings visible pre-draft; Recommendations available
   - Player cards: ADP + Proj (+ rep), stack badge, upgrade badge, bye overlap dot
   - Board shows most recent pick first
   - Roster viewer dropdown to view any team's roster
   - End-of-draft grades modal for all teams
*/

const DATA_URL = "./consensus.json";

/* ====== TUNABLE WEIGHTS ====== */
const WEIGHTS = {
  vor: 1.0,
  tierBoost: 1.0,
  valueVsADP: 0.8,

  need: 0.9,
  scarcity: 0.7,
  stackSynergy: 1.0,
  byePenalty: -0.5,      // same-position starter bye overlap (kept small)
  lateUpside: 0.6,

  lateRoundStartPct: 0.5,
  deepRoundStartPct: 0.75
};

const TEAM_WIDE_BYE_DUP_PENALTY = -1.5; // small nudge away from team-wide overlaps
const UPGRADE_ECR_GAP = 5;

let state = {
  settings: {
    teams: 12, rounds: 16, pickPos: 5, scoring: "PPR",
    qb: 1, rb: 2, wr: 2, te: 1, flex: 1, k: 1, def: 1, bench: 8,
    manualMode: false
  },

  players: [],
  available: [],
  draftPicks: [],
  currentOverall: 1,

  myTeamIndex: 0,
  viewTeamIndex: 0,
  teamRosters: [],
  rosterSlots: [],
  started: false,
  paused: false,

  features: { stack:true },

  dataFlags: { hasProj:false, hasADP:false },
  autoplay: { enabled:true, delayMs:120 },

  boardView: localStorage.getItem("boardView") || "overall",
  midTab: localStorage.getItem("midTab") || "ranks",

  filters: {
    pos: (localStorage.getItem("filterPos") || "").toUpperCase(),
    q: localStorage.getItem("searchName") || ""
  },

  posRankCache: {},
  dataSource: "consensus.json"
};

// ---------- helpers ----------
const el = id => document.getElementById(id);
const fmt1 = (x) => Number(x||0).toFixed(1);

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
    const arr = state.players.filter(p=>p.pos===pos && p.ecr!=null)
      .sort((a,b)=>(a.ecr)-(b.ecr));
    const map = new Map();
    arr.forEach((p,idx)=> map.set(p.id ?? p.player, idx+1));
    state.posRankCache[pos] = map;
  });
}
function getPosRank(p){ const m = state.posRankCache[p.pos]; return m ? m.get(p.id ?? p.player) : undefined; }
function posRankLabel(rank) { return rank ? String(rank) : ""; }

// --- draft math
function overallToTeam(overall){
  const T=state.settings.teams; const r=Math.ceil(overall/T); const pos=overall-(r-1)*T;
  return (r%2===1) ? (pos-1) : (T - pos);
}
function getRound(overall){ return Math.ceil(overall/state.settings.teams); }
function pickInRound(overall){ const r=getRound(overall), start=(r-1)*state.settings.teams+1; return overall-start+1; }
function draftProgressPct(){
  const total = state.settings.teams * rosterSizePerTeam();
  return Math.min(1, (state.draftPicks.length)/Math.max(1,total));
}
function rosterSizePerTeam(){
  const s=state.settings;
  return (s.qb+s.rb+s.wr+s.te+s.flex+s.k+s.def) + s.bench;
}

// ---------- stacks / bye / needs ----------
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

// Same-position bye overlap (minor)
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

/* ===== Team-wide starters & bye helpers ===== */
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

// Positional scarcity boost
function computeScarcityBoost(p){
  const total = state.players.filter(x=>x.pos===p.pos).length;
  const remain = state.available.map(i=>state.players[i]).filter(x=>x.pos===p.pos).length;
  if(total === 0) return 0;
  const pctRemain = remain/total;
  const scarcity = (1 - pctRemain);
  const posFactor = (p.pos==="RB"||p.pos==="WR") ? 1.2 : (p.pos==="TE"? 1.0 : 0.6);
  return scarcity * posFactor * 4;
}

// Need weighting
function rosterNeeds(teamIndex){
  const s=state.settings, slots=state.rosterSlots[teamIndex]||{QB:0,RB:0,WR:0,TE:0,FLEX:0,K:0,DEF:0,BEN:0};
  const target={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te,K:s.k,DEF:s.def}, need={};
  for(const pos of ["QB","RB","WR","TE","K","DEF"]){
    const have=slots[pos]||0, left=Math.max(0,(target[pos]||0)-have);
    need[pos]= 1 + (left*0.8);
  }
  return need;
}

// Late-round upside bonus
function lateRoundUpsideBonus(p){
  const pct = draftProgressPct();
  if (pct < WEIGHTS.lateRoundStartPct) return 0;
  const discount = (state.dataFlags.hasADP && p.adp) ? Math.max(0, p.adp - (state.currentOverall||1)) : 0;
  if (discount <= 0) return 0;
  const tier = p.tier || 6;
  const tierLean = Math.max(0, (tier-2));
  const deep = (pct >= WEIGHTS.deepRoundStartPct) ? 1.25 : 1.0;
  return (Math.log10(1 + discount) * (0.75 + 0.25*tierLean)) * deep;
}

// ---------- data load ----------
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
    lastUpdatedEl.textContent = `Last updated: ${data.updated_at || "unknown"} • players: ${data.players.length}`;

    ingestPlayers(data.players);
    render();
    renderDraftStatus();
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
  populateTeamSelect();
}

// ---------- CSV Upload ----------
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
    if(!players.length){ alert("Could not parse any rows from CSV: unexpected format."); return; }
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

// ---------- init ----------
document.addEventListener("DOMContentLoaded", init);
function init() {
  syncSettings();
  state.myTeamIndex = Math.max(0, (state.settings.pickPos || 1) - 1);
  state.viewTeamIndex = state.myTeamIndex;

  loadConsensus();
  setInterval(loadConsensus, 30*60*1000);
  initCsvUpload();

  // Settings inputs...
  ["teams","rounds","pickPos","scoring","draftMode",
   "qbSlots","rbSlots","wrSlots","teSlots","flexSlots","kSlots","defSlots","benchSlots"]
    .forEach(id=> el(id)?.addEventListener("input", ()=>{
      syncSettings();
      populateTeamSelect();
      renderDraftStatus();
    }));

  // Draft controls (support both ids just in case)
  (el("startDraft") || el("startMock"))?.addEventListener("click", startDraft);
  el("undoPick")?.addEventListener("click", undoPick);

  // Board tabs
  el("tabOverall")?.addEventListener("click", () => { state.boardView="overall"; localStorage.setItem("boardView","overall"); updateBoardTabs(); renderBoard(); });
  el("tabByRound")?.addEventListener("click", () => { state.boardView="round";   localStorage.setItem("boardView","round");   updateBoardTabs(); renderBoard(); });
  updateBoardTabs();

  // Subtabs (Rankings/Recs) — default to Full Rankings
  state.midTab = "ranks";
  localStorage.setItem("midTab", state.midTab);
  document.querySelector('.subtabs')?.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === 'subtabRecs' || t.id === 'subtabRanks') {
      state.midTab = (t.id === 'subtabRecs') ? 'recs' : 'ranks';
      updateMidTabs();
      localStorage.setItem('midTab', state.midTab);
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

  // Roster viewer
  el("viewTeamSelect")?.addEventListener("change", (e) => {
    const v = Number(e.target.value || 0);
    state.viewTeamIndex = Math.max(0, Math.min(state.settings.teams-1, v));
    renderMyRoster();
  });
  populateTeamSelect();

  // Modal buttons
  el("resultsClose")?.addEventListener("click", closeResultsModal);
  el("resultsOk")?.addEventListener("click", closeResultsModal);

  render();
  renderDraftStatus();
}

function populateTeamSelect(){
  const sel = el("viewTeamSelect");
  if(!sel) return;
  const T = Number(el("teams")?.value || state.settings.teams || 12);
  sel.innerHTML = "";
  for(let i=0;i<T;i++){
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Team ${i+1}`;
    sel.appendChild(opt);
  }
  sel.value = String(Math.max(0, Math.min(T-1, state.viewTeamIndex||0)));
}

function syncSettings(){ const s=state.settings;
  s.teams=+el("teams").value||12; s.rounds=+el("rounds").value||16; s.pickPos=+el("pickPos").value||5;
  s.scoring=el("scoring").value; s.qb=+el("qbSlots").value||1; s.rb=+el("rbSlots").value||2; s.wr=+el("wrSlots").value||2;
  s.te=+el("teSlots").value||1; s.flex=+el("flexSlots").value||1; s.k=+el("kSlots").value||1; s.def=+el("defSlots").value||1; s.bench=+el("benchSlots").value||8;
  s.manualMode = (el("draftMode")?.value === "manual");
}

// ---------- draft engine ----------
function startDraft(){
  if (!state.players.length){ alert("Load players first (consensus.json or upload CSV)."); return; }

  // reset structures
  state.myTeamIndex = Math.max(0, state.settings.pickPos - 1);
  state.viewTeamIndex = state.myTeamIndex;
  const T = state.settings.teams;
  state.teamRosters = new Array(T).fill(0).map(()=>[]);
  state.rosterSlots = new Array(T).fill(0).map(()=>({QB:0,RB:0,WR:0,TE:0,FLEX:0,K:0,DEF:0,BEN:0}));
  state.draftPicks = []; state.currentOverall = 1; state.started = true; state.paused=false;

  disableStartButton();

  render();
  renderDraftStatus();

  // If Regular mode, auto-draft others until it's your pick
  if(!state.settings.manualMode){
    autoUntilYourPick();
    render();
    renderDraftStatus();
  }
}

function disableStartButton(){
  const btn = document.getElementById("startDraft") || document.getElementById("startMock");
  if (btn){
    btn.disabled = true;
    btn.textContent = "Drafting…";
    btn.style.opacity = "0.7";
    btn.style.cursor = "default";
  }
}

function autoUntilYourPick(){
  const total=state.settings.teams*rosterSizePerTeam();
  while(state.currentOverall<=total){
    const team = overallToTeam(state.currentOverall);
    if (team === state.myTeamIndex) break; // stop on your pick
    aiPick(team);
    // advance without triggering nested auto:
    state.currentOverall += 1;
  }
  render(); renderDraftStatus(); checkDraftEnd();
}

function nextPick(){ /* not exposed; kept for completeness */
  const total=state.settings.teams*rosterSizePerTeam();
  if(state.currentOverall>total){ return; }
  const team = overallToTeam(state.currentOverall);
  if(state.settings.manualMode){
    return; // user will click a player
  }
  if(team===state.myTeamIndex){
    const {list}=computeRecommendations(team); if(!list.length){ alert("No candidates available."); return; }
    draftPlayerById(list[0].id, team);
    state.currentOverall += 1;
    autoUntilYourPick();
    return;
  }
  aiPick(team); state.currentOverall += 1; autoUntilYourPick();
}

function advanceAfterPick(shouldRender=true){
  state.currentOverall += 1;
  if (shouldRender) { render(); renderDraftStatus(); }
  checkDraftEnd();
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
  const idxAvail = state.available.indexOf(poolIdx); if(idxAvail!==-1) state.available.splice(idxAvail,1);
  state.players[poolIdx].drafted=true;
  const overall=state.currentOverall, round=getRound(overall), pir=pickInRound(overall);
  state.teamRosters[teamIndex].push(poolIdx); bumpRosterSlot(teamIndex, state.players[poolIdx].pos);
  state.draftPicks.push({overall, team:teamIndex, round, pickInRound:pir, playerIdx:poolIdx});
}
function bumpRosterSlot(teamIndex,pos){ const s=state.rosterSlots[teamIndex]; if(!s) return; if(pos in s) s[pos]++; else s.BEN++; }

function undoPick(){
  if(!state.draftPicks.length) return;
  const last=state.draftPicks.pop(); const {playerIdx, team, overall}=last;
  state.players[playerIdx].drafted=false; if(!state.available.includes(playerIdx)) state.available.push(playerIdx);
  const r=state.teamRosters[team]; const ix=r.lastIndexOf(playerIdx); if(ix>=0) r.splice(ix,1);
  const pos=state.players[playerIdx].pos; if(pos in state.rosterSlots[team]) state.rosterSlots[team][pos]=Math.max(0, state.rosterSlots[team][pos]-1);
  state.currentOverall = overall; // step back to that pick
  render(); renderDraftStatus();
}

function checkDraftEnd(){
  const totalNeeded = state.settings.teams * rosterSizePerTeam();
  if (state.draftPicks.length >= totalNeeded){
    showResultsModal();
  }
}

// ---------- results / grades ----------
function showResultsModal(){
  const modal = el("resultsModal");
  if(!modal) return;
  const { tableHtml, summary } = buildResultsTable();
  el("resultsSummary").textContent = summary;
  el("resultsTableWrap").innerHTML = tableHtml;
  modal.style.display = "block";
}
function closeResultsModal(){
  const modal = el("resultsModal");
  if(modal) modal.style.display = "none";
}

function buildResultsTable(){
  const T = state.settings.teams;
  const rows = [];
  const totals = []; // team projected total (starters+flex)
  for(let t=0;t<T;t++){
    const { starters, flex } = startersByPosForTeam(t);
    const startersAll = [...starters.QB, ...starters.RB, ...starters.WR, ...starters.TE, ...starters.K, ...starters.DEF, ...flex];
    const totalProj = startersAll.reduce((acc,p)=> acc + (Number(p.proj_ppr)||0), 0);
    totals.push({ team:t, totalProj, startersAll });
  }
  // rank and grade
  const sorted = [...totals].sort((a,b)=> b.totalProj - a.totalProj);
  const max = sorted[0]?.totalProj || 1;
  const min = sorted[sorted.length-1]?.totalProj || 0;
  const table = [];
  table.push(`<table class="results-table"><thead><tr><th>Team</th><th>Projected (Starters)</th><th>Grade</th></tr></thead><tbody>`);
  let yourLine="";
  for(const row of sorted){
    const pct = (max===min)? 1 : (row.totalProj - min) / (max - min);
    const grade = pctToLetter(pct);
    const cls = `grade ${grade}`;
    const tr = `<tr><td>Team ${row.team+1}</td><td>${fmt1(row.totalProj)}</td><td class="${cls}">${grade}</td></tr>`;
    table.push(tr);
    if (row.team === state.myTeamIndex) yourLine = `Your team finished ${(sorted.findIndex(x=>x.team===row.team))+1}/${T} — Grade ${grade} — ${fmt1(row.totalProj)} projected points.`;
  }
  table.push(`</tbody></table>`);
  return { tableHtml: table.join(""), summary: yourLine || "Draft complete." };
}
function pctToLetter(p){
  if (p>=0.9) return "A";
  if (p>=0.7) return "B";
  if (p>=0.4) return "C";
  if (p>=0.2) return "D";
  return "F";
}

// ---------- scoring / filters / recommendations ----------
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
    const idx=Math.min(idxAt[pos]-1, Math.max(0,pool.length-1)); baseline[pos]=pool[idx]? (pool[idx].proj_ppr||0):0;
  } return baseline;
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

// ---------- unified player card ----------
function playerCardHTML(p){
  const logo = teamLogoUrl(p.team);
  const pr = getPosRank(p);
  const t  = p.tier || 6;
  const ecrText = (p.ecr!=null)? `#${p.ecr}` : "#—";
  const adpBit  = state.dataFlags.hasADP ? ` • ADP ${p.adp||"-"}` : "";
  const projBit = state.dataFlags.hasProj
      ? (` • Proj ${fmt1(p.baseProj ?? p.proj_ppr ?? 0)}`
         + (p.rep!=null ? ` (rep ${fmt1(p.rep)})` : ""))
      : "";
  const stackBadge = (p.hasMyStack || hasPrimaryStackForMyTeam(p))
      ? `<span class="badge stack" title="Stacks with your roster">🔗 STACK</span>` : "";
  const upgradeBadge = p.upgradeForPos
      ? `<span class="badge" style="background:#22c55e1a;border:1px solid #22c55e;color:#22c55e;">Upgrade</span>`
      : "";
  const byeDot = p.byeWarnColor ? byeDotSpan(p.byeWarnColor) : "";

  const onClock = overallToTeam(state.currentOverall);
  const targetTeam = state.settings.manualMode ? onClock : state.myTeamIndex;
  const canClick = (!state.started) ? false
                 : (state.settings.manualMode ? true
                                              : (onClock===state.myTeamIndex));

  const btnAttr = canClick ? `data-pid="${p.id}" data-team="${targetTeam}"` : `disabled`;

  return `<div class="flex">
      <div class="flex" style="gap:8px;">
        ${logo ? `<img src="${logo}" alt="${p.team||''}" class="team-logo">` : ""}
        <div>
          <div class="name">${p.player} ${stackBadge} ${upgradeBadge}
            <span class="badge tier t${t}">T${t}</span>
            <span class="badge pos ${p.pos}">${p.pos}${pr ? posRankLabel(pr) : ""}</span>
            <span class="badge">${ecrText}</span>
          </div>
          <div class="small">${p.team||""} • Bye ${p.bye||"-"} ${byeDot}${adpBit}${projBit}</div>
        </div>
      </div>
      <div><button class="btn-primary" ${btnAttr}>Draft</button></div>
    </div>`;
}

// ---------- render ----------
function render(){ renderBoard(); renderMidPanel(); renderMyRoster(); }

function renderBoard(){
  const root=el("board"); if(!root) return; root.innerHTML="";
  const picks = [...state.draftPicks].sort((a,b)=>b.overall-a.overall); // newest first
  if(state.boardView === "overall"){
    if(!picks.length){
      const empty = document.createElement("div");
      empty.className = "small";
      empty.textContent = "No picks yet.";
      root.appendChild(empty);
    } else {
      picks.forEach(p=> root.appendChild(boardPickElem(p)));
    }
  } else {
    const byRound = new Map();
    picks.forEach(p=>{ if(!byRound.has(p.round)) byRound.set(p.round, []); byRound.get(p.round).push(p); });
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

  if(state.midTab === "recs"){
    const team = state.started ? overallToTeam(state.currentOverall) : state.myTeamIndex;
    const { list } = computeRecommendations(team);
    list.forEach(p=>{
      const d=document.createElement("div"); d.className="item";
      d.innerHTML = playerCardHTML(p);
      const btn = d.querySelector("button");
      if (btn && btn.hasAttribute("data-pid")){
        btn.onclick = ()=>{
          const pid = Number(btn.getAttribute("data-pid"));
          const team = Number(btn.getAttribute("data-team"));
          draftPlayerById(pid, team);

          // AFTER USER PICK IN REGULAR MODE: auto others until your next pick
          if (!state.settings.manualMode){
            advanceAfterPick(false);   // increment once for your pick
            autoUntilYourPick();       // burn through other teams
            return;                    // render happens inside autoUntilYourPick()
          }

          // Manual mode just advances one pick
          advanceAfterPick();
        };
      }
      root.appendChild(d);
    });
  } else {
    let list = state.available.map(i=>state.players[i]);
    list = applyFilters(list);
    list.sort((a,b)=> (a.ecr??1e9) - (b.ecr??1e9));

    const countsNow = byeOverlapCounts(startersAllForTeam(state.myTeamIndex));

    list.slice(0,600).forEach(p=>{
      const resulting = (p.bye!=null) ? ((countsNow.get(p.bye) || 0) + 1) : 0;
      p.byeWarnColor = byeDotColor(resulting);
      const d=document.createElement("div"); d.className="item";
      d.innerHTML = playerCardHTML(p);
      const btn = d.querySelector("button");
      if (btn && btn.hasAttribute("data-pid")){
        btn.onclick = ()=>{
          const pid = Number(btn.getAttribute("data-pid"));
          const team = Number(btn.getAttribute("data-team"));
          draftPlayerById(pid, team);

          // AFTER USER PICK IN REGULAR MODE: auto others until your next pick
          if (!state.settings.manualMode){
            advanceAfterPick(false);
            autoUntilYourPick();
            return;
          }

          advanceAfterPick();
        };
      }
      root.appendChild(d);
    });

    if (!list.length){
      const d=document.createElement("div"); d.className="small"; d.textContent="No available players (did you load data?)";
      root.appendChild(d);
    }
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

  const viewTeam = Math.max(0, Math.min(state.settings.teams-1, state.viewTeamIndex||0));
  const mineIdxs = (state.teamRosters[viewTeam] || []);
  const mine = mineIdxs.map(i=>state.players[i]).sort((a,b)=> (a.ecr ?? 9999) - (b.ecr ?? 9999));

  const slotsTarget = {
    QB: state.settings.qb, RB: state.settings.rb, WR: state.settings.wr,
    TE: state.settings.te, FLEX: state.settings.flex, K: state.settings.k, DEF: state.settings.def
  };

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

// ---------- ui tabs ----------
function updateBoardTabs(){
  el("tabOverall")?.classList.toggle("active", state.boardView==="overall");
  el("tabByRound")?.classList.toggle("active", state.boardView==="round");
}
function updateMidTabs(){
  el("subtabRecs")?.classList.toggle("active", state.midTab==="recs");
  el("subtabRanks")?.classList.toggle("active", state.midTab==="ranks");
}

// ---------- utility ----------
function renderDraftStatus(){
  const bar = document.getElementById("draftStatus");
  if (!bar) return;

  if (!state.started){
    bar.style.display = "none";
    bar.textContent = "";
    return;
  }

  const total = state.settings.teams * rosterSizePerTeam();
  const on = Math.min(state.currentOverall, total);
  const r = getRound(on);
  const pir = pickInRound(on);
  const team = overallToTeam(on);
  const you = (team === state.myTeamIndex);

  const prefix = `Round ${r} • Pick ${pir}/${state.settings.teams}`;
  const who = you ? `You’re on the clock (Team ${team+1})`
                  : `Auto-drafting for Team ${team+1}…`;

  bar.style.display = "block";
  bar.textContent = `${prefix} — ${who}`;
}
