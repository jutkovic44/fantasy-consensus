/* Fantasy Football War Room — Full App (bugfix build)
   Fixes:
   - Full Rankings available BEFORE Start (default tab = ranks). Draft buttons disabled until start with message.
   - Recommendations tab shows message until draft started.
   - Draft Board shows a placeholder when no picks, so you don't need to toggle tabs to render.
   - Roster column refreshes reliably after every pick; clearer guards when drafting before start.
   - Manual vs Regular mode behavior retained.
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
  byePenalty: -0.5,
  lateUpside: 0.6,

  lateRoundStartPct: 0.5,
  deepRoundStartPct: 0.75
};

const TEAM_WIDE_BYE_DUP_PENALTY = -1.5;
const UPGRADE_ECR_GAP = 5;
const AI_PICK_DELAY_MS = 480;

/* ====== STATE ====== */
let state = {
  settings: {
    mode: "regular",  // "regular" | "manual"
    teams: 12, rounds: 16, pickPos: 5, scoring: "PPR",
    qb: 1, rb: 2, wr: 2, te: 1, flex: 1, k: 1, def: 1, bench: 8
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

  features: { stack:true },
  dataFlags: { hasProj:false, hasADP:false },

  // DEFAULT TAB = RANKS (Full Rankings first)
  midTab: localStorage.getItem("midTab") || "ranks",
  boardView: localStorage.getItem("boardView") || "overall",

  filters: {
    pos: (localStorage.getItem("filterPos") || "").toUpperCase(),
    q: localStorage.getItem("searchName") || ""
  },

  selectedTeamViewIndex: null,
  posRankCache: {},
  autoplay: { loopId:null },
  dataSource: "consensus.json"
};

/* ====== DOM ====== */
const el = id => document.getElementById(id);

/* ====== Helpers ====== */
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

/* ====== Rankings cache ====== */
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

/* ====== Draft math (snake) ====== */
function overallToTeam(overall){
  const T=state.settings.teams; const r=Math.ceil(overall/T); const pos=overall-(r-1)*T;
  return (r%2===1) ? (pos-1) : (T - pos);
}
function getRound(overall){ return Math.ceil(overall/state.settings.teams); }
function pickInRound(overall){ const r=getRound(overall), start=(r-1)*state.settings.teams+1; return overall-start+1; }
function draftProgressPct(){
  const total = totalPicks();
  return Math.min(1, Math.max(0, (state.currentOverall-1)/Math.max(1,total)));
}

/* ====== Bye & stack helpers ====== */
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
  return map;
}
function byeDotColor(count){
  if (count >= 4) return "#ef4444";
  if (count === 3) return "#f97316";
  if (count === 2) return "#f59e0b";
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

/* ====== Scarcity & Needs ====== */
function computeScarcityBoost(p){
  const total = state.players.filter(x=>x.pos===p.pos).length;
  const remain = state.available.map(i=>state.players[i]).filter(x=>x.pos===p.pos).length;
  if(total === 0) return 0;
  const pctRemain = remain/total;
  const scarcity = (1 - pctRemain);
  const posFactor = (p.pos==="RB"||p.pos==="WR") ? 1.2 : (p.pos==="TE"? 1.0 : 0.6);
  return scarcity * posFactor * 4;
}
function rosterNeeds(teamIndex){
  const s=state.settings, slots=state.rosterSlots[teamIndex]||{QB:0,RB:0,WR:0,TE:0,FLEX:0,K:0,DEF:0,BEN:0};
  const target={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te,K:s.k,DEF:s.def}, need={};
  for(const pos of ["QB","RB","WR","TE","K","DEF"]){
    const have=slots[pos]||0, left=Math.max(0,(target[pos]||0)-have);
    need[pos]= 1 + (left*0.8);
  }
  return need;
}

/* ====== Upside ====== */
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

/* ====== Data load ====== */
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

/* ====== CSV ====== */
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

/* ====== Settings & init ====== */
document.addEventListener("DOMContentLoaded", init);
function init() {
  loadConsensus();
  setInterval(loadConsensus, 30*60*1000);
  initCsvUpload();

  ["teams","rounds","pickPos","scoring",
   "qbSlots","rbSlots","wrSlots","teSlots","flexSlots","kSlots","defSlots","benchSlots"]
    .forEach(id=> el(id)?.addEventListener("input", syncSettings));

  const modeSel = el("modeSelect");
  if (modeSel) modeSel.addEventListener("change", ()=>{ state.settings.mode = modeSel.value; persistMode(); reflectModeUI(); });
  const modeReg = el("modeRegular"), modeMan = el("modeManual");
  if (modeReg && modeMan){
    [modeReg,modeMan].forEach(r=> r.addEventListener("change", ()=>{
      state.settings.mode = modeReg.checked ? "regular" : "manual";
      persistMode(); reflectModeUI();
    }));
  }

  const startBtn = el("startDraft") || el("startMock");
  startBtn?.addEventListener("click", startDraft);

  const nextBtn = el("nextPick");
  nextBtn?.addEventListener("click", onNextPickClick);

  const undoBtn = el("undoPick");
  undoBtn?.addEventListener("click", ()=>{ undoPick(); render(); });

  // Legacy—no-ops safe:
  el("pauseMock")?.addEventListener("click", ()=>{ state.paused=true; stopAutoLoop(); });
  el("resumeMock")?.addEventListener("click", ()=>{ if(!state.started) return; state.paused=false; if(state.settings.mode==="regular") startAutoLoop(); });
  el("autoUntilMyPick")?.addEventListener("click", autoUntilMyPick);
  el("prevPick")?.addEventListener("click", () => { state.paused=true; stopAutoLoop(); undoPick(); render(); });

  // Tabs
  el("tabOverall")?.addEventListener("click", () => { state.boardView="overall"; localStorage.setItem("boardView","overall"); updateBoardTabs(); renderBoard(); });
  el("tabByRound")?.addEventListener("click", () => { state.boardView="round";   localStorage.setItem("boardView","round");   updateBoardTabs(); renderBoard(); });
  updateBoardTabs();

  // Subtabs — Full Rankings should be default/first
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
  // Force default to ranks on first load (unless user had saved something else)
  if (!localStorage.getItem('midTab')) {
    state.midTab = 'ranks';
  }
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

  const posSel = el("filterPos"); if (posSel) posSel.value = state.filters.pos;
  const qInput = el("searchName"); if (qInput) qInput.value = state.filters.q;

  state.selectedTeamViewIndex = state.myTeamIndex;

  reflectModeUI();
  render();
}
function persistMode(){ try{ localStorage.setItem("draftMode", state.settings.mode); }catch{} }
function reflectModeUI(){
  // Hide legacy controls per your call
  el("autoOthers")?.closest("label")?.classList.add("hidden");
  el("exportBoard")?.classList.add("hidden");
}
function syncSettings(){
  const s=state.settings;
  s.teams=+el("teams")?.value||12; s.rounds=+el("rounds")?.value||16; s.pickPos=+el("pickPos")?.value||5;
  s.scoring=el("scoring")?.value || s.scoring;
  s.qb=+el("qbSlots")?.value||1; s.rb=+el("rbSlots")?.value||2; s.wr=+el("wrSlots")?.value||2;
  s.te=+el("teSlots")?.value||1; s.flex=+el("flexSlots")?.value||1; s.k=+el("kSlots")?.value||1; s.def=+el("defSlots")?.value||1; s.bench=+el("benchSlots")?.value||8;

  const modeSel = el("modeSelect");
  if (modeSel) s.mode = modeSel.value;
  const modeReg = el("modeRegular"), modeMan = el("modeManual");
  if (modeReg && modeMan) s.mode = modeReg.checked ? "regular" : "manual";
}

/* ====== Totals & end condition ====== */
function totalSlotsPerTeam(){
  const s = state.settings;
  return (s.qb + s.rb + s.wr + s.te + s.flex + s.k + s.def + s.bench);
}
function totalPicks(){
  return state.settings.teams * totalSlotsPerTeam();
}
function checkAllTeamsFull(){
  const perTeamTarget = totalSlotsPerTeam();
  if (!state.teamRosters || !state.teamRosters.length) return false;
  return state.teamRosters.every(r => (r?.length || 0) >= perTeamTarget);
}

/* ====== Draft engine ====== */
function startDraft(){
  if (!state.players.length){ alert("Load players first (consensus.json or upload CSV)."); return; }
  syncSettings();
  state.myTeamIndex = Math.max(0, Math.min(state.settings.teams-1, (state.settings.pickPos|0)-1));
  const T = state.settings.teams;
  state.teamRosters = new Array(T).fill(0).map(()=>[]);
  state.rosterSlots = new Array(T).fill(0).map(()=>({QB:0,RB:0,WR:0,TE:0,FLEX:0,K:0,DEF:0,BEN:0}));
  state.draftPicks = [];
  state.currentOverall = 1;
  state.started = true;
  state.paused = false;
  state.available = state.players.map((_,i)=>i);
  state.players.forEach(p => p.drafted=false);

  state.selectedTeamViewIndex = state.myTeamIndex;

  render(); // board, rankings visible, roster viewer shows empty slots
  if (state.settings.mode === "regular") startAutoLoop();
}
function onNextPickClick(){
  if (!state.started){ toast("Start the draft first."); return; }
  if (checkAllTeamsFull()){ endDraftIfComplete(); return; }

  const team = overallToTeam(state.currentOverall);
  if (state.settings.mode === "regular"){
    if (team === state.myTeamIndex){
      const { list } = computeRecommendations(team);
      if(!list.length){ alert("No candidates available."); return; }
      draftPlayerById(list[0].id, team);
      postPickFlow();
    } else {
      aiPick(team);
      postPickFlow();
    }
  } else {
    const { list } = computeRecommendations(team);
    if(!list.length){ alert("No candidates available."); return; }
    draftPlayerById(list[0].id, team);
    postPickFlow();
  }
}
function postPickFlow(){
  advanceAfterPick(false);
  render(); // force refresh board + rosters immediately after a pick
  if (state.settings.mode === "regular") startAutoLoop();
  endDraftIfComplete();
}
function autoUntilMyPick(){
  if(!state.started){ toast("Start the draft first."); return; }
  if (state.settings.mode !== "regular"){ render(); return; }
  stopAutoLoop();
  while(!checkAllTeamsFull() && overallToTeam(state.currentOverall)!==state.myTeamIndex){
    const team = overallToTeam(state.currentOverall);
    aiPick(team);
    advanceAfterPick(false);
  }
  render();
  endDraftIfComplete();
}
function startAutoLoop(){ stopAutoLoop();
  if (state.settings.mode !== "regular") return;
  state.autoplay.loopId = setInterval(autoTick, AI_PICK_DELAY_MS);
}
function stopAutoLoop(){ if(state.autoplay.loopId) clearInterval(state.autoplay.loopId); state.autoplay.loopId=null; }
function autoTick(){
  if (!state.started) return;
  if (checkAllTeamsFull()){ stopAutoLoop(); endDraftIfComplete(); return; }

  const team = overallToTeam(state.currentOverall);
  if (team === state.myTeamIndex){
    stopAutoLoop();
    renderMidPanel();
    return;
  }
  aiPick(team);
  advanceAfterPick(false);
  render(); // keep board current without tab toggling
  endDraftIfComplete();
}
function advanceAfterPick(shouldRender=true){
  state.currentOverall += 1;
  if (shouldRender) render();
}
function aiPick(teamIndex){
  const {list}=computeRecommendations(teamIndex);
  if(!list.length) return;
  const pct = draftProgressPct();
  const k = pct < 0.2 ? Math.min(6, list.length) : Math.min(3, list.length);
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
  const ixAvail = state.available.indexOf(poolIdx); if(ixAvail!==-1) state.available.splice(ixAvail,1);
  state.players[poolIdx].drafted=true;

  const overall=state.currentOverall, round=getRound(overall), pir=pickInRound(overall);
  state.teamRosters[teamIndex].push(poolIdx);
  bumpRosterSlot(teamIndex, state.players[poolIdx].pos);
  state.draftPicks.push({overall, team:teamIndex, round, pickInRound:pir, playerIdx:poolIdx});
}
function bumpRosterSlot(teamIndex,pos){
  const s=state.rosterSlots[teamIndex]; if(!s) return;
  if(pos==="RB" || pos==="WR"){
    if (pos==="RB"){
      if (s.RB < state.settings.rb){ s.RB++; return; }
      if (s.FLEX < state.settings.flex){ s.FLEX++; return; }
      s.BEN++; return;
    }
    if (pos==="WR"){
      if (s.WR < state.settings.wr){ s.WR++; return; }
      if (s.FLEX < state.settings.flex){ s.FLEX++; return; }
      s.BEN++; return;
    }
  } else if (pos in s){
    const cap = state.settings[pos.toLowerCase()];
    if (s[pos] < cap){ s[pos]++; return; }
    s.BEN++; return;
  } else {
    s.BEN++;
  }
}
function undoPick(){
  if(!state.draftPicks.length) return;
  const last=state.draftPicks.pop(); const {playerIdx, team, overall}=last;
  state.players[playerIdx].drafted=false; 
  if(!state.available.includes(playerIdx)) state.available.push(playerIdx);

  const r=state.teamRosters[team]; const ix=r.lastIndexOf(playerIdx); if(ix>=0) r.splice(ix,1);

  const pos=state.players[playerIdx].pos; const s=state.rosterSlots[team];
  if(pos==="RB" || pos==="WR"){
    if (s.FLEX>0){ s.FLEX--; }
    else if (pos==="RB" && s.RB>0){ s.RB--; }
    else if (pos==="WR" && s.WR>0){ s.WR--; }
    else if (s.BEN>0){ s.BEN--; }
  } else if (pos in s && s[pos]>0){ s[pos]--; }
  else if (s.BEN>0){ s.BEN--; }

  state.currentOverall = overall;
}

/* ====== Export (hidden UI) ====== */
function exportBoard(){
  const rows=[["overall","round","pickInRound","team","player","pos","teamAbbr","bye","ecr","adp","proj_ppr","tier"]];
  for(const p of [...state.draftPicks].sort((a,b)=>a.overall-b.overall)){
    const pl=state.players[p.playerIdx];
    rows.push([p.overall,p.round,p.pickInRound,p.team+1,pl.player,pl.pos,pl.team,pl.bye,pl.ecr,pl.adp,pl.proj_ppr,pl.tier]);
  }
  const csv=rows.map(r=>r.join(",")).join("\n"); const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download="draft_board.csv";
  a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1500);
}

/* ====== Recs / rankings ====== */
function replacementLevels(){
  if(!state.dataFlags.hasProj){ return {QB:0,RB:0,WR:0,TE:0,K:0,DEF:0}; }
  const s=state.settings, T=s.teams, flexShare=s.flex;
  const counts={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te,K:s.k,DEF:s.def}, idxAt={};
  for(const pos of ["QB","RB","WR","TE","K","DEF"]){
    let N=T*counts[pos];
    if(pos==="RB" || pos==="WR"){ N += Math.round(T * (0.5*flexShare)); }
    idxAt[pos]=Math.max(N,1);
  }
  const baseline={};
  for(const pos of ["QB","RB","WR","TE","K","DEF"]){
    const pool=state.available.map(i=>state.players[i]).filter(p=>p.pos===pos).sort((a,b)=>(b.proj_ppr||0)-(a.proj_ppr||0));
    const idx=Math.min(idxAt[pos]-1, Math.max(0,pool.length-1)); baseline[pos]=pool[idx]? (pool[idx].proj_ppr||0):0;
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

  // my starters (for bye dots on cards)
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

    const resulting = (p.bye!=null) ? ( (countsNow.get(p.bye) || 0) + 1 ) : 0;
    const byeWarnColor = byeDotColor(resulting);

    return {...p, baseProj, rep, vor, score,
            hasMyStack: hasPrimaryStackForMyTeam(p),
            upgradeForPos,
            byeWarnColor };
  });

  scored.sort((a,b)=> b.score-a.score);
  return { list: scored.slice(0,60), baseline: base, needs };
}

/* ====== Card / badges ====== */
function valueBadgeHTML(vor){
  if (!isFinite(vor)) return "";
  if (vor >= 40) return `<span class="badge badge-green" title="Value Over Replacement +${vor.toFixed(1)}">VOR +${vor.toFixed(1)}</span>`;
  if (vor >= 15) return `<span class="badge badge-yellow" title="VOR +${vor.toFixed(1)}">VOR +${vor.toFixed(1)}</span>`;
  if (vor <= 0)  return `<span class="badge badge-red" title="VOR ${vor.toFixed(1)}">VOR ${vor.toFixed(1)}</span>`;
  return `<span class="badge" title="VOR +${vor.toFixed(1)}">VOR +${vor.toFixed(1)}</span>`;
}
function playerCardHTML(p, opts={}){
  const logo = teamLogoUrl(p.team);
  const pr = getPosRank(p);
  const t  = p.tier || 6;
  const ecrText = (p.ecr!=null)? `#${p.ecr}` : "#—";
  const adpBit  = state.dataFlags.hasADP ? ` • ADP ${p.adp||"-"}` : "";
  const projBit = state.dataFlags.hasProj
      ? (` • Proj ${Number(p.baseProj ?? p.proj_ppr ?? 0).toFixed(1)}`
         + (p.rep!=null ? ` (rep ${Number(p.rep).toFixed(1)})` : ""))
      : "";
  const stackBadge = (p.hasMyStack || hasPrimaryStackForMyTeam(p))
      ? `<span class="badge stack" title="Stacks with your roster">🔗 STACK</span>` : "";
  const upgradeBadge = p.upgradeForPos
      ? `<span class="badge" style="background:#22c55e1a;border:1px solid #22c55e;color:#22c55e;">Upgrade Available</span>`
      : "";
  const byeDot = p.byeWarnColor ? byeDotSpan(p.byeWarnColor) : "";
  const vorBadge = valueBadgeHTML(Number(p.vor ?? (p.baseProj||0) - (p.rep||0)));

  const disabled = !!opts.disabledDraft;
  const onClockTeam = overallToTeam(state.currentOverall);

  return `<div class="flex item-inner">
      <div class="flex" style="gap:10px;">
        ${logo ? `<img src="${logo}" alt="${p.team||''}" class="team-logo">` : ""}
        <div>
          <div class="name">
            ${p.player} ${stackBadge} ${upgradeBadge}
            <span class="badge tier t${t}">T${t}</span>
            <span class="badge pos ${p.pos}">${p.pos}${pr ? posRankLabel(pr) : ""}</span>
            <span class="badge">${ecrText}</span>
          </div>
          <div class="small">${p.team||""} • Bye ${p.bye||"-"} ${byeDot}${adpBit}${projBit} ${vorBadge}</div>
        </div>
      </div>
      <div>
        <button class="draft-btn${disabled ? " disabled" : ""}" ${disabled?"disabled":""} data-pid="${p.id}" title="${disabled?"Start the draft first":"Draft to Team "+(onClockTeam+1)}">Draft</button>
      </div>
    </div>`;
}

/* ====== Render ====== */
function render(){ renderBoard(); renderMidPanel(); renderRosterColumn(); }

/* -- Board -- */
function renderBoard(){
  const root=el("board"); if(!root) return; root.innerHTML="";

  const picks = [...state.draftPicks].sort((a,b)=>a.overall-b.overall);
  if (!picks.length){
    // Placeholder so you don't need to tab to render
    const placeholder = document.createElement("div");
    placeholder.className = "small muted";
    placeholder.style.padding = "8px";
    placeholder.style.gridColumn = "1 / -1";
    placeholder.textContent = "No picks yet. Start the draft and make your first selection.";
    root.appendChild(placeholder);
    return;
  }

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
  div.innerHTML = `<div class="flex"><span class="badge">#${p.overall} R${p.round}.${p.pickInRound}</span><span class="small">Team ${p.team+1}</span></div>
                   <div class="flex" style="justify-content:flex-start; gap:8px;">
                     ${logo ? `<img src="${logo}" alt="${pl.team||''}" class="team-logo">` : ""}
                     <div class="name">${pl.player}</div>
                   </div>
                   <div class="small"><span class="badge pos ${pl.pos}">${pl.pos}${pr ? posRankLabel(pr) : ""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"}</div>`;
  return div;
}

/* -- Mid panel -- */
function renderMidPanel(){
  const root = el("midList"); if(!root) return; root.innerHTML = "";

  // One-time event delegation for Draft buttons
  root.onclick = (e) => {
    const t = e.target;
    if (t && t.matches && t.matches("button.draft-btn")){
      const pid = +t.getAttribute("data-pid");
      onDraftButton(pid);
    }
  };

  // Default/first tab = Full Rankings (ranks)
  if(state.midTab === "ranks"){
    let list = state.available.length ? state.available.map(i=>state.players[i]) : state.players.slice();
    list = applyFilters(list);
    list.sort((a,b)=> (a.ecr??1e9) - (b.ecr??1e9));

    const disabledDraft = !state.started;
    if (disabledDraft){
      const note = document.createElement("div");
      note.className = "small muted";
      note.style.marginBottom = "8px";
      note.textContent = "Full rankings are shown. Start the draft to enable drafting from this list.";
      root.appendChild(note);
    }

    list.slice(0,800).forEach(p=>{
      // Compute bye dot hypothetically vs my starters for consistency
      const countsNow = byeOverlapCounts(startersAllForTeam(state.myTeamIndex));
      const resulting = (p.bye!=null) ? ((countsNow.get(p.bye) || 0) + 1) : 0;
      p.byeWarnColor = byeDotColor(resulting);

      const d=document.createElement("div"); d.className="item";
      d.innerHTML = playerCardHTML(p, {disabledDraft});
      root.appendChild(d);
    });
    return;
  }

  // Recommendations tab
  if(!state.started){
    root.innerHTML = `<div class="small muted">Start the draft to see live recommendations.</div>`;
    return;
  }

  const teamOnClock = overallToTeam(state.currentOverall);
  const { list } = computeRecommendations(teamOnClock);
  list.forEach(p=>{
    const d=document.createElement("div"); d.className="item";
    d.innerHTML = playerCardHTML(p);
    root.appendChild(d);
  });
}
function onDraftButton(playerId){
  if (!state.started){ toast("Start the draft first."); return; }
  const teamOnClock = overallToTeam(state.currentOverall);

  if (state.settings.mode === "regular"){
    if (teamOnClock !== state.myTeamIndex) return; // only your pick is clickable
    draftPlayerById(playerId, teamOnClock);
    postPickFlow();
    return;
  }

  draftPlayerById(playerId, teamOnClock);
  postPickFlow();
}

/* -- Roster column with team dropdown -- */
function renderRosterColumn(){
  const root=el("myRoster"); if(!root) return; root.innerHTML="";

  const wrap = document.createElement("div");
  wrap.className = "roster-wrap";

  const header = document.createElement("div");
  header.className = "row";
  header.style.marginBottom = "8px";

  const label = document.createElement("label");
  label.className = "small";
  label.style.fontWeight = "600";
  label.textContent = "View Roster:";
  label.style.display = "flex";
  label.style.flexDirection = "column";
  label.style.gap = "6px";

  const sel = document.createElement("select");
  sel.id = "rosterTeamSelect";
  for(let i=0;i<state.settings.teams;i++){
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = (i===state.myTeamIndex) ? `Team ${i+1} (You)` : `Team ${i+1}`;
    sel.appendChild(opt);
  }
  sel.value = String(state.selectedTeamViewIndex ?? state.myTeamIndex);
  sel.addEventListener("change", (e)=>{
    state.selectedTeamViewIndex = +(e.target.value||0);
    renderMyRosterInto(wrapBody, state.selectedTeamViewIndex);
  });

  label.appendChild(sel);
  header.appendChild(label);
  wrap.appendChild(header);

  const wrapBody = document.createElement("div");
  wrap.appendChild(wrapBody);
  root.appendChild(wrap);

  renderMyRosterInto(wrapBody, state.selectedTeamViewIndex ?? state.myTeamIndex);
}
function renderMyRosterInto(container, teamIndex){
  container.innerHTML = "";

  const mineIdxs = (state.teamRosters[teamIndex] || []);
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

  bench.sort((a,b)=> benchValue(b) - benchValue(a));

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
    container.appendChild(wrap);
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

/* ====== Tabs ====== */
function updateBoardTabs(){
  el("tabOverall")?.classList.toggle("active", state.boardView==="overall");
  el("tabByRound")?.classList.toggle("active", state.boardView==="round");
}
function updateMidTabs(){
  // Full Rankings first / default
  el("subtabRanks")?.classList.add("active");
  el("subtabRecs")?.classList.remove("active");
  if (state.midTab === "recs"){
    el("subtabRanks")?.classList.remove("active");
    el("subtabRecs")?.classList.add("active");
  }
}

/* ====== End-of-draft & Grades ====== */
function endDraftIfComplete(){
  if (!state.started) return;
  if (checkAllTeamsFull()){
    state.started = false;
    stopAutoLoop();
    showGradesModal(buildDraftGrades());
  }
}
function buildDraftGrades(){
  const s = state.settings;
  const result = { teams: [], scale: {} };
  const rep = replacementLevels();

  let allScores = [];
  for(let t=0;t<s.teams;t++){
    const { starters, flex } = startersByPosForTeam(t);

    const posGroups = {
      QB: starters.QB,
      RB: starters.RB.concat([]),
      WR: starters.WR.concat([]),
      TE: starters.TE,
      K : starters.K,
      DEF: starters.DEF
    };

    if (flex.length){
      flex.forEach(pl => {
        if (pl.pos==="RB") posGroups.RB.push(pl);
        else if (pl.pos==="WR") posGroups.WR.push(pl);
      });
    }

    const posScores = {};
    let overallSum = 0, overallCnt = 0;

    for(const key of ["QB","RB","WR","TE","K","DEF"]){
      const arr = posGroups[key] || [];
      const baseline = rep[key] || 0;
      const vorSum = arr.reduce((acc,pl)=> acc + Math.max(0, (pl.proj_ppr||0) - baseline), 0);
      const score = vorSum;
      posScores[key] = score;
      overallSum += score; overallCnt++;
    }

    const overall = overallCnt ? (overallSum/overallCnt) : 0;
    allScores.push(overall);

    result.teams.push({
      teamIndex: t,
      overall,
      byPos: posScores
    });
  }

  const min = Math.min(...allScores), max = Math.max(...allScores);
  const avg = allScores.reduce((a,b)=>a+b,0)/Math.max(1,allScores.length);
  result.scale = { min, max, avg };

  result.teams.forEach(team => {
    team.letter = toLetter(team.overall, min, max, avg);
    const byPosLetters = {};
    for(const k of Object.keys(team.byPos)){
      byPosLetters[k] = toLetter(team.byPos[k], min, max, avg, 0.7);
    }
    team.byPosLetter = byPosLetters;
  });

  return result;
}
function toLetter(val, min, max, avg, tighten=1.0){
  let norm = (max>min) ? (val - min) / (max - min) : 0.5;
  norm = Math.max(0, Math.min(1, norm));
  norm = 0.5 + (norm-0.5) * tighten;
  if (norm >= 0.93) return "A+";
  if (norm >= 0.85) return "A";
  if (norm >= 0.77) return "A-";
  if (norm >= 0.69) return "B+";
  if (norm >= 0.61) return "B";
  if (norm >= 0.53) return "B-";
  if (norm >= 0.45) return "C+";
  if (norm >= 0.37) return "C";
  if (norm >= 0.29) return "C-";
  if (norm >= 0.21) return "D+";
  if (norm >= 0.13) return "D";
  if (norm >= 0.05) return "D-";
  return "F";
}
function showGradesModal(gradeData){
  let modal = document.getElementById("gradesModal");
  if (!modal){
    modal = document.createElement("div");
    modal.id = "gradesModal";
    modal.style.position = "fixed";
    modal.style.left = "0"; modal.style.top = "0";
    modal.style.width = "100%"; modal.style.height = "100%";
    modal.style.background = "rgba(0,0,0,0.6)";
    modal.style.display = "flex";
    modal.style.alignItems = "center";
    modal.style.justifyContent = "center";
    modal.style.zIndex = "9999";
    modal.innerHTML = `
      <div id="gradesInner" style="max-width:960px;width:90%;background:#0f172a;border:1px solid #334155;border-radius:12px;padding:16px;">
        <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h3 style="margin:0;">Draft Grades</h3>
          <button id="gradesClose" class="secondary">Close</button>
        </div>
        <div id="gradesBody"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e)=>{ if (e.target.id==="gradesModal") modal.remove(); });
    modal.querySelector("#gradesClose").addEventListener("click", ()=> modal.remove());
  }

  const body = modal.querySelector("#gradesBody");
  body.innerHTML = "";

  const table = document.createElement("div");
  table.style.display = "grid";
  table.style.gridTemplateColumns = "80px 1fr 60px 60px 60px 60px 60px 60px";
  table.style.gap = "6px";
  table.style.alignItems = "center";

  const head = document.createElement("div");
  head.style.gridColumn = "1 / -1";
  head.innerHTML = `
    <div class="row" style="gap:8px; font-size:12px; color:#94a3b8;">
      <div style="width:80px;">Team</div>
      <div style="flex:1;">(higher is better)</div>
      <div style="width:60px;text-align:center;">QB</div>
      <div style="width:60px;text-align:center;">RB</div>
      <div style="width:60px;text-align:center;">WR</div>
      <div style="width:60px;text-align:center;">TE</div>
      <div style="width:60px;text-align:center;">K</div>
      <div style="width:60px;text-align:center;">DEF</div>
    </div>`;
  body.appendChild(head);

  gradeData.teams
    .sort((a,b) => (a.teamIndex - b.teamIndex))
    .forEach(t => {
      const row = document.createElement("div");
      row.className = "row";
      row.style.gap = "8px";
      row.style.fontSize = "13px";
      row.innerHTML = `
        <div style="width:80px;font-weight:600;">Team ${t.teamIndex+1}${(t.teamIndex===state.myTeamIndex)?" (You)":""}</div>
        <div style="flex:1;">Overall: <span class="badge">${t.letter}</span> <span class="small muted">(${t.overall.toFixed(1)})</span></div>
        <div style="width:60px;text-align:center;"><span class="badge">${t.byPosLetter.QB}</span></div>
        <div style="width:60px;text-align:center;"><span class="badge">${t.byPosLetter.RB}</span></div>
        <div style="width:60px;text-align:center;"><span class="badge">${t.byPosLetter.WR}</span></div>
        <div style="width:60px;text-align:center;"><span class="badge">${t.byPosLetter.TE}</span></div>
        <div style="width:60px;text-align:center;"><span class="badge">${t.byPosLetter.K}</span></div>
        <div style="width:60px;text-align:center;"><span class="badge">${t.byPosLetter.DEF}</span></div>
      `;
      table.appendChild(row);
    });

  body.appendChild(table);
}

/* ====== Toast ====== */
function toast(msg){
  let t = document.getElementById("toast");
  if (!t){
    t = document.createElement("div");
    t.id = "toast";
    t.style.position="fixed";
    t.style.bottom="20px";
    t.style.left="50%";
    t.style.transform="translateX(-50%)";
    t.style.background="#111827";
    t.style.border="1px solid #334155";
    t.style.color="#e2e8f0";
    t.style.padding="8px 12px";
    t.style.borderRadius="8px";
    t.style.fontSize="13px";
    t.style.zIndex="99999";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity="1";
  setTimeout(()=>{ t.style.transition="opacity 300ms"; t.style.opacity="0"; }, 1600);
}
