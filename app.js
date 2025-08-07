/* Fantasy Football War Room — with Manual Draft Mode, ECR/ADP/Proj inline, bye dots, stacks, etc. */
const DATA_URL = "./consensus.json";

// Tunable weights, etc.
const WEIGHTS = {
  vor:1, tierBoost:1, valueVsADP:0.8,
  need:0.9, scarcity:0.7, stackSynergy:1,
  byePenalty:-0.5, lateUpside:0.6,
  lateRoundStartPct:0.5, deepRoundStartPct:0.75
};
const TEAM_WIDE_BYE_DUP_PENALTY = -1.5;
const UPGRADE_ECR_GAP = 5;

let state = {
  settings: {
    teams:12, rounds:16, pickPos:5, scoring:"PPR",
    qb:1, rb:2, wr:2, te:1, flex:1, k:1, def:1, bench:8
  },
  players: [], available: [], draftPicks: [], currentOverall:1,
  myTeamIndex:0, teamRosters:[], rosterSlots:[], started:false, paused:false,
  features: { stack:true, manual:false },
  dataFlags: { hasProj:false, hasADP:false },
  autoplay: { enabled:true, delayMs:1000, loopId:null },
  boardView: localStorage.getItem("boardView") || "overall",
  midTab: localStorage.getItem("midTab") || "recs",
  filters: {
    pos:(localStorage.getItem("filterPos")||"").toUpperCase(),
    q:localStorage.getItem("searchName")||""
  },
  posRankCache:{}, dataSource:"consensus.json"
};

// shorthand
const el = id => document.getElementById(id);

/** Normalize team abbreviations. **/
function normalizeTeam(abbr){
  if(!abbr) return "";
  const code = String(abbr).toUpperCase().trim();
  const map = { JAX:"JAC", LA:"LAR", STL:"LAR", SD:"LAC", WSH:"WAS" };
  return map[code]||code;
}

/** Normalize position strings. **/
function normalizePos(pos){
  const p = String(pos||"").toUpperCase().replace(/[^A-Z]/g,"");
  if(p.startsWith("QB")) return "QB";
  if(p.startsWith("RB")) return "RB";
  if(p.startsWith("WR")) return "WR";
  if(p.startsWith("TE")) return "TE";
  if(p==="K"||p.startsWith("PK")) return "K";
  if(p==="DST"||p==="DEF") return "DEF";
  return p;
}

/** Build per-pos ranking cache from ECR. **/
function buildPosRankCache(){
  state.posRankCache = {};
  ["QB","RB","WR","TE","K","DEF"].forEach(pos=>{
    const arr = state.players.filter(p=>p.pos===pos&&p.ecr!=null)
                   .sort((a,b)=>a.ecr-b.ecr);
    const m = new Map();
    arr.forEach((p,i)=>m.set(p.id||p.player,i+1));
    state.posRankCache[pos]=m;
  });
}
function getPosRank(p){ return state.posRankCache[p.pos]?.get(p.id||p.player); }

/** Draft math helpers **/
function overallToTeam(o){
  const T=state.settings.teams, r=Math.ceil(o/T), idx=o-(r-1)*T;
  return (r%2===1)? idx-1 : T-idx;
}
function getRound(o){ return Math.ceil(o/state.settings.teams); }
function pickInRound(o){
  const r=getRound(o), start=(r-1)*state.settings.teams+1;
  return o-start+1;
}
function draftProgressPct(){
  const total=state.settings.teams*state.settings.rounds;
  return Math.min(1,(state.currentOverall-1)/total);
}

/** Stacking and bye logic (unchanged) **/
function stackBonusForTeam(i,p){ /* … */ /* omitted for brevity; same as before */ }
function byeOverlapPenalty(i,p){ /* … */ }
function byeOverlapCounts(list){ /* … */ }
function byeDotColor(n){ if(n>=4)return"#ef4444"; if(n===3)return"#f97316"; if(n===2)return"#f59e0b"; return null; }
function byeDotSpan(c){ return `<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${c};margin-left:6px;vertical-align:middle"></span>`; }

/** Scarcity, needs, upside **/
function computeScarcityBoost(p){ /* … */ }
function rosterNeeds(i){ /* … */ }
function lateRoundUpsideBonus(p){ /* … */ }

/** Load data **/
async function loadConsensus(){
  try {
    const resp = await fetch(DATA_URL,{cache:"no-store"});
    if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if(!Array.isArray(data.players)) throw new Error("Invalid JSON");
    state.dataSource="consensus.json";
    el("dataSourceLabel").textContent="consensus.json";
    el("lastUpdated").textContent=`Last updated: ${data.updated_at||"?"} • players: ${data.players.length}`;
    ingestPlayers(data.players);
    render();
  } catch(e){
    console.warn(e);
    el("lastUpdated").innerHTML=`<span style="color:#f59e0b;font-weight:bold">Tip:</span> ${e.message}`;
  }
}
function ingestPlayers(raw){
  state.players = raw.map((p,i)=>{
    return {
      ...p,
      id:p.id??i+1,
      pos: normalizePos(p.pos||p.position||""),
      team: normalizeTeam(p.team||p.Team||""),
      player: p.player||p.name||"",
      ecr: p.ecr??p.rank??null,
      adp: p.adp??p.ADP??null,
      proj_ppr: p.proj_ppr??p.Projection_PPR??null,
      tier: p.tier??null,
      bye: p.bye??p.Bye??null,
      drafted:false
    };
  }).filter(p=>["QB","RB","WR","TE","K","DEF"].includes(p.pos));
  state.available = state.players.map((_,i)=>i);
  state.dataFlags.hasProj = state.players.some(p=>p.proj_ppr>0);
  state.dataFlags.hasADP = state.players.some(p=>p.adp!=null);
  buildPosRankCache();
}

/** CSV upload (unchanged) **/
function initCsvUpload(){ /* … */ }
function parseCsvFile(file){ /* … */ }

/** Initialize app **/
document.addEventListener("DOMContentLoaded", init);
function init(){
  // load data
  loadConsensus();
  setInterval(loadConsensus,30*60*1000);
  initCsvUpload();

  // populate manual team selector
  const ms = el("manualTeamSelect");
  for(let i=1;i<=state.settings.teams;i++){
    const opt = document.createElement("option");
    opt.value = i; opt.textContent = `Team ${i}`;
    ms.append(opt);
  }

  // wire up manual mode toggle
  el("manualMode").addEventListener("change", e=>{
    state.features.manual = e.target.checked;
    ms.style.display = state.features.manual ? "" : "none";
    // show/hide controls
    ["startMock","pauseMock","resumeMock","nextPick","prevPick","autoUntilMyPick","autoOthers"].forEach(id=>{
      el(id).style.display = state.features.manual ? "none" : "";
    });
  });

  // league settings
  ["teams","rounds","pickPos","scoring",
   "qbSlots","rbSlots","wrSlots","teSlots","flexSlots","kSlots","defSlots","benchSlots"]
    .forEach(id=>el(id).addEventListener("input", syncSettings));

  // draft controls
  el("startMock").addEventListener("click", startMock);
  el("pauseMock").addEventListener("click", ()=>{ state.paused=true; stopAutoLoop(); });
  el("resumeMock").addEventListener("click", ()=>{ if(!state.started)return; state.paused=false; if(state.autoplay.enabled)startAutoLoop(); });
  el("nextPick").addEventListener("click", ()=>{ if(!state.features.manual) nextPick(); });
  el("prevPick").addEventListener("click", ()=>{ if(!state.features.manual)return; undoPick(); render(); });
  el("autoUntilMyPick").addEventListener("click", ()=>{ if(!state.features.manual) autoUntilMyPick(); });
  el("undoPick").addEventListener("click", undoPick);
  el("exportBoard").addEventListener("click", exportBoard);
  el("autoOthers").addEventListener("change", e=>{
    state.autoplay.enabled = e.target.checked;
    if(state.autoplay.enabled) startAutoLoop(); else stopAutoLoop();
  });

  // tabs
  el("tabOverall").addEventListener("click", ()=>{ state.boardView="overall"; localStorage.setItem("boardView","overall"); updateBoardTabs(); renderBoard(); });
  el("tabByRound").addEventListener("click", ()=>{ state.boardView="round"; localStorage.setItem("boardView","round"); updateBoardTabs(); renderBoard(); });
  updateBoardTabs();

  // subtabs
  document.querySelector(".subtabs").addEventListener("click", e=>{
    if(e.target.id==="subtabRecs"||e.target.id==="subtabRanks"){
      state.midTab = e.target.id==="subtabRecs" ? "recs":"ranks";
      localStorage.setItem("midTab",state.midTab);
      updateMidTabs();
      renderMidPanel();
    }
  });
  updateMidTabs();

  // filters
  el("filterPos").addEventListener("change", e=>{ state.filters.pos=e.target.value; localStorage.setItem("filterPos",state.filters.pos); renderMidPanel(); });
  el("searchName").addEventListener("input", e=>{ state.filters.q=e.target.value; localStorage.setItem("searchName",state.filters.q); renderMidPanel(); });

  // initial render
  syncSettings();
  render();
}

// synchronize settings object from inputs
function syncSettings(){
  const s = state.settings;
  s.teams=+el("teams").value; s.rounds=+el("rounds").value;
  s.pickPos=+el("pickPos").value; s.scoring=el("scoring").value;
  s.qb=+el("qbSlots").value; s.rb=+el("rbSlots").value; s.wr=+el("wrSlots").value;
  s.te=+el("teSlots").value; s.flex=+el("flexSlots").value;
  s.k=+el("kSlots").value; s.def=+el("defSlots").value; s.bench=+el("benchSlots").value;
}

// start draft (auto or manual)
function startMock(){
  if(!state.players.length){ alert("Load players first."); return; }
  syncSettings();
  state.myTeamIndex = state.settings.pickPos - 1;
  const T = state.settings.teams;
  state.teamRosters = Array.from({length:T},()=>[]);
  state.rosterSlots  = Array.from({length:T},()=>({QB:0,RB:0,WR:0,TE:0,FLEX:0,K:0,DEF:0,BEN:0}));
  state.draftPicks=[]; state.currentOverall=1; state.started=true; state.paused=false;
  render();
  if(state.autoplay.enabled && !state.features.manual) startAutoLoop();
}

// auto-draft loop for non-manual mode
function startAutoLoop(){
  stopAutoLoop();
  if(!state.autoplay.enabled) return;
  state.autoplay.loopId = setInterval(()=>{
    if(!state.started||state.paused) return;
    const total = state.settings.teams*state.settings.rounds;
    if(state.currentOverall>total){ stopAutoLoop(); return; }
    const tm = overallToTeam(state.currentOverall);
    if(tm === state.myTeamIndex) return;
    aiPick(tm);
    advanceAfterPick();
  }, state.autoplay.delayMs);
}
function stopAutoLoop(){
  clearInterval(state.autoplay.loopId);
  state.autoplay.loopId = null;
}

// advance pick count & re-render
function advanceAfterPick(renderBoardNow=true){
  state.currentOverall++;
  if(renderBoardNow) render();
}

// AI pick helper
function aiPick(teamIndex){
  const {list} = computeRecommendations(teamIndex);
  if(!list.length) return;
  // simple weighted random among top 3 or 6
  const early = draftProgressPct()<0.2;
  const k = early ? Math.min(6,list.length) : Math.min(3,list.length);
  const weights = Array.from({length:k},(_,i)=>(k-i));
  const sum = weights.reduce((a,b)=>a+b,0);
  let r = Math.random()*sum, pick=list[0];
  for(let i=0;i<k;i++){
    r -= weights[i];
    if(r<=0){ pick = list[i]; break; }
  }
  draftPlayerById(pick.id,teamIndex);
}

// handle clicking “Next Pick” in non-manual
function nextPick(){
  if(!state.started) { alert("Start draft first."); return; }
  const total = state.settings.teams*state.settings.rounds;
  if(state.currentOverall>total){ stopAutoLoop(); return; }
  const tm = overallToTeam(state.currentOverall);
  if(tm===state.myTeamIndex){
    const {list} = computeRecommendations(tm);
    if(!list.length){ alert("No available players."); return; }
    draftPlayerById(list[0].id,tm);
    advanceAfterPick();
  } else {
    aiPick(tm);
    advanceAfterPick();
  }
}

// manual or normal draft
function draftPlayerById(id, teamIndex){
  const poolIdx = state.players.findIndex(p=>p.id===id);
  if(poolIdx<0||state.players[poolIdx].drafted) return;
  // remove from available
  const ai = state.available.indexOf(poolIdx);
  if(ai>=0) state.available.splice(ai,1);
  state.players[poolIdx].drafted = true;
  // assign
  state.teamRosters[teamIndex].push(poolIdx);
  bumpRosterSlot(teamIndex, state.players[poolIdx].pos);
  const overall = state.currentOverall;
  const round = getRound(overall);
  const pr = pickInRound(overall);
  state.draftPicks.push({ overall, team:teamIndex, round, pickInRound:pr, playerIdx:poolIdx });
  // next
  state.currentOverall++;
  render();
}

// bump slot tally
function bumpRosterSlot(teamIndex,pos){
  const s = state.rosterSlots[teamIndex];
  if(pos in s) s[pos]++; else s.BEN++;
}

// undo
function undoPick(){
  if(!state.draftPicks.length) return;
  const last = state.draftPicks.pop();
  const {playerIdx,team,overall} = last;
  state.players[playerIdx].drafted = false;
  if(!state.available.includes(playerIdx)) state.available.push(playerIdx);
  const arr = state.teamRosters[team];
  arr.splice(arr.lastIndexOf(playerIdx),1);
  state.rosterSlots[team][state.players[playerIdx].pos]--;
  state.currentOverall = overall;
  render();
}

// export CSV
function exportBoard(){
  const rows = [["overall","round","pickInRound","team","player","pos","teamAbbr","bye","ecr","adp","proj_ppr","tier"]];
  state.draftPicks.sort((a,b)=>a.overall-b.overall).forEach(p=>{
    const pl = state.players[p.playerIdx];
    rows.push([p.overall,p.round,p.pickInRound,p.team+1,pl.player,pl.pos,pl.team,pl.bye,pl.ecr,pl.adp,pl.proj_ppr,pl.tier]);
  });
  const csv = rows.map(r=>r.join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download="draft_board.csv"; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1500);
}

/** Replacement levels, filters, recs **/
function replacementLevels(){ /* … */ }
function applyFilters(list){ /* … */ }
function worstStarterEcrByPos(i){ /* … */ }
function computeRecommendations(teamIndex){ /* … */ }

// unified player card renderer
function playerCardHTML(p){
  const logo = normalizeTeam(p.team) ? `<img src="${teamLogoUrl(p.team)}" class="team-logo">` : "";
  const pr = getPosRank(p);
  const tier = p.tier||6;
  // color-coded diffs for ADP/ECR/Proj:
  const ecrText = p.ecr!=null?`<span class="badge">#${p.ecr}</span>`:"";
  const adpText = state.dataFlags.hasADP?`<span class="badge">ADP ${p.adp||"-"}</span>`:"";
  const proj = Number(p.proj_ppr||0);
  const base = Number(p.baseProj||0);
  let diff = proj-base;
  let diffBadge="";
  if(diff>0) diffBadge=`<span class="badge badge-green">+${diff.toFixed(1)}</span>`;
  else if(diff<0) diffBadge=`<span class="badge badge-red">${diff.toFixed(1)}</span>`;
  else diffBadge=`<span class="badge badge-yellow">±0</span>`;

  const byeDot = p.byeWarnColor?byeDotSpan(p.byeWarnColor):"";

  return `
    <div class="flex" style="gap:10px;">
      ${logo}
      <div style="flex:1;">
        <div class="name">
          ${p.player}
          ${p.hasMyStack?`<span class="badge stack">STACK</span>`:""}
          <span class="badge tier t${tier}">T${tier}</span>
          <span class="badge pos ${p.pos}">${p.pos}${pr?pr:""}</span>
        </div>
        <div class="small">
          ${p.team} • Bye ${p.bye||"-"} ${byeDot}
          ${ecrText} ${adpText} <span class="badge">Proj ${proj.toFixed(1)}</span> ${diffBadge}
        </div>
      </div>
      <button data-pid="${p.id}">Draft</button>
    </div>`;
}

// rendering routines (board, mid panel, roster) — unchanged, but draft button handler now uses manualMode
function render(){
  renderBoard();
  renderMidPanel();
  renderMyRoster();
}
function renderBoard(){ /* … */ }
function renderMidPanel(){
  const root = el("midList");
  root.innerHTML="";
  const mode = state.midTab;
  const team = state.features.manual
    ? parseInt(el("manualTeamSelect").value,10)-1
    : (state.started?overallToTeam(state.currentOverall):state.myTeamIndex);
  const {list} = computeRecommendations(team);
  list.forEach(p=>{
    const div = document.createElement("div");
    div.className="item";
    div.innerHTML = playerCardHTML(p);
    div.querySelector("button").onclick = ()=>{
      const tgt = state.features.manual
        ? parseInt(el("manualTeamSelect").value,10)-1
        : team;
      draftPlayerById(p.id,tgt);
    };
    root.append(div);
  });
}
function renderMyRoster(){ /* … */ }
function updateBoardTabs(){ /* … */ }
function updateMidTabs(){ /* … */ }
