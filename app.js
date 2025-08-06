/* Fantasy Football War Room — app.js (features always on)
   - CSV uploader (client-side) + "Download consensus.json"
   - Stack Awareness: always ON with scoring boost + visible STACK badge
   - Scarcity bars: always ON
   - Opponent bias option removed
   - Logos in Rankings/Recommendations/Board/Roster
   - Snake draft; CPU auto-drafts between your turns
   - My Roster auto-fills starters by best ECR, then FLEX, then Bench
*/

const DATA_URL = "./consensus.json";

let state = {
  settings: { teams:12, rounds:16, pickPos:5, scoring:"PPR",
    qb:1, rb:2, wr:2, te:1, flex:1, bench:6 },
  players: [],
  available: [],
  draftPicks: [],
  currentOverall: 1,
  myTeamIndex: 0,
  teamRosters: [],
  rosterSlots: [],
  started: false,
  paused: false,

  // Features: always on
  features: { stack:true, scarcity:true },

  dataFlags: { hasProj:false, hasADP:false },
  autoplay: { enabled:true, delayMs:1000, loopId:null },
  boardView: localStorage.getItem("boardView") || "overall",
  posRankCache: {},
  dataSource: "consensus.json"
};

// ---------- helpers ----------
const el = id => document.getElementById(id);
const show = (id, on)=>{ const n=el(id); if(!n) return; n.classList.toggle("hidden", !on); };

function teamLogoUrl(abbr){
  if(!abbr) return "";
  const map = { JAX:"JAC", LA:"LAR" };
  const code = (map[abbr] || abbr).toUpperCase().trim();
  return `https://static.www.nfl.com/league/api/clubs/logos/${code}.svg`;
}

function buildPosRankCache(){
  state.posRankCache = {};
  ["QB","RB","WR","TE"].forEach(pos=>{
    const arr = state.players.filter(p=>p.pos===pos && p.ecr!=null)
      .sort((a,b)=>(a.ecr)-(b.ecr));
    const map = new Map();
    arr.forEach((p,idx)=> map.set(p.id ?? p.player, idx+1));
    state.posRankCache[pos] = map;
  });
}
function getPosRank(p){ const m = state.posRankCache[p.pos]; return m ? m.get(p.id ?? p.player) : undefined; }
function posRankLabel(p, rank){ return rank ? `${p.pos}${rank}` : ""; }

// Stack detection (for MY team): true if candidate creates QB<->WR/TE stack with any rostered player from same team
function hasPrimaryStackForMyTeam(candidate){
  const rosterIdxs = state.teamRosters[state.myTeamIndex] || [];
  if(!candidate.team || !rosterIdxs.length) return false;
  for(const idx of rosterIdxs){
    const pl = state.players[idx];
    if(!pl || pl.team !== candidate.team) continue;
    if( (candidate.pos==="QB" && (pl.pos==="WR" || pl.pos==="TE")) ||
        ((candidate.pos==="WR" || candidate.pos==="TE") && pl.pos==="QB") ){
      return true;
    }
  }
  return false;
}

// Additional (smaller) stack synergy for same-team same-pos — used only for scoring
function stackBonusForTeam(teamIndex, candidate){
  if(!state.features.stack) return 0;
  const roster = (state.teamRosters[teamIndex]||[]).map(i=>state.players[i]);
  let bonus = 0;
  for(const pl of roster){
    if(!pl.team || !candidate.team) continue;
    if(pl.team !== candidate.team) continue;
    // Primary QB<->WR/TE stack: strong
    if( (pl.pos==="QB" && (candidate.pos==="WR" || candidate.pos==="TE")) ||
        (candidate.pos==="QB" && (pl.pos==="WR" || pl.pos==="TE")) ){ bonus += 6; }
    // Secondary (same-team WR/TE pairs): light
    else if (pl.pos===candidate.pos && (pl.pos==="WR" || pl.pos==="TE")) { bonus += 2; }
  }
  return bonus;
}

// ---------- data load from consensus.json ----------
async function loadConsensus() {
  const lastUpdatedEl = el("lastUpdated");
  const srcLabel = el("dataSourceLabel");
  try {
    const resp = await fetch(DATA_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — consensus.json not found`);
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("Invalid JSON in consensus.json"); }
    if (!Array.isArray(data.players)) throw new Error("consensus.json missing 'players' array");

    const count = data.players.length;
    state.dataSource = "consensus.json";
    srcLabel.textContent = "consensus.json";
    lastUpdatedEl.textContent = `Last updated: ${data.updated_at || "unknown"} • players: ${count}`;

    if (count === 0) { state.players=[]; state.available=[]; render(); return; }

    ingestPlayers(data.players);
    render();
  } catch (e) {
    console.warn("Could not load consensus.json:", e.message);
    el("lastUpdated").innerHTML = `<span style="color:#f59e0b; font-weight:bold;">Tip:</span> ${e.message}. You can upload a CSV below.`;
  }
}

// normalize/ingest into state
function ingestPlayers(raw){
  state.players = raw.map((p,i)=>({
    ...p,
    id: p.id ?? i+1,
    drafted: false,
    pos: p.pos || p.position || p.Position || "",
    team: p.team || p.Team || "",
    player: p.player || p.name || p.Player || "",
    ecr: p.ecr ?? p.rank ?? p.ECR ?? null,
    adp: p.adp ?? p.ADP ?? null,
    proj_ppr: p.proj_ppr ?? p.Projection_PPR ?? p.proj ?? null,
    tier: p.tier ?? p.Tier ?? null,
    bye: p.bye ?? p.Bye ?? p.bye_week ?? null
  }));
  state.available = state.players.map((_,i)=>i);
  state.dataFlags.hasProj = state.players.some(p=> (p.proj_ppr||0) > 0);
  state.dataFlags.hasADP  = state.players.some(p=> p.adp !== null && p.adp !== undefined);
  buildPosRankCache();
}

// ---------- CSV Upload ----------
function initCsvUpload(){
  const input = el("csvInput");
  input.addEventListener("change", handleCsvFiles);
  // Drag & drop
  const uploader = input.closest(".uploader");
  uploader.addEventListener("dragover", e=>{ e.preventDefault(); uploader.classList.add("drag"); });
  uploader.addEventListener("dragleave", ()=> uploader.classList.remove("drag"));
  uploader.addEventListener("drop", e=>{
    e.preventDefault(); uploader.classList.remove("drag");
    const file = e.dataTransfer.files?.[0];
    if(file) parseCsvFile(file);
  });

  el("downloadConsensus").addEventListener("click", () => {
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
function handleCsvFiles(e){
  const file = e.target.files?.[0];
  if(file) parseCsvFile(file);
}
function parseCsvFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    const { headers, rows } = csvToRows(text);
    const players = rows.map(r => mapFantasyProsRow(headers, r)).filter(Boolean);
    if(!players.length){ alert("Could not parse any rows from CSV. Check the file format."); return; }
    state.dataSource = "CSV";
    el("dataSourceLabel").textContent = "CSV (uploaded)";
    el("lastUpdated").textContent = `Loaded from CSV: ${file.name} • players: ${players.length}`;
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
  const team = (get(["Team","TEAM"])||"").toUpperCase();
  const pos  = (get(["Pos","POS","Position"])||"").toUpperCase().replace(/[^A-Z]/g,"");
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
function init() {
  loadConsensus();
  setInterval(loadConsensus, 30*60*1000);
  initCsvUpload();

  ["teams","rounds","pickPos","scoring","qbSlots","rbSlots","wrSlots","teSlots","flexSlots","benchSlots"]
    .forEach(id=> el(id)?.addEventListener("input", syncSettings));

  // Draft controls
  el("startMock").onclick = startMock;
  el("pauseMock").onclick = pauseMock;
  el("resumeMock").onclick = resumeMock;
  el("nextPick").onclick = nextPick;
  el("prevPick").onclick = () => { pauseMock(); undoPick(); render(); };
  el("autoUntilMyPick").onclick = autoUntilMyPick;
  el("undoPick").onclick = undoPick;
  el("exportBoard").onclick = exportBoard;

  el("autoOthers").onchange = () => {
    state.autoplay.enabled = el("autoOthers").checked;
    if (state.autoplay.enabled) startAutoLoop(); else stopAutoLoop();
  };

  // Rankings filters
  el("rankingsSearch").addEventListener("input", renderRankings);
  el("rankingsPos").addEventListener("change", renderRankings);

  // Tabs
  el("tabOverall").onclick = () => { state.boardView = "overall"; localStorage.setItem("boardView","overall"); updateTabs(); renderBoard(); };
  el("tabByRound").onclick = () => { state.boardView = "round"; localStorage.setItem("boardView","round"); updateTabs(); renderBoard(); };
  updateTabs();

  render();
}
document.addEventListener("DOMContentLoaded", init);

function updateTabs(){ el("tabOverall").classList.toggle("active", state.boardView==="overall");
  el("tabByRound").classList.toggle("active", state.boardView==="round"); }
function syncSettings(){ const s=state.settings;
  s.teams=+el("teams").value||12; s.rounds=+el("rounds").value||16; s.pickPos=+el("pickPos").value||5;
  s.scoring=el("scoring").value; s.qb=+el("qbSlots").value||1; s.rb=+el("rbSlots").value||2; s.wr=+el("wrSlots").value||2;
  s.te=+el("teSlots").value||1; s.flex=+el("flexSlots").value||1; s.bench=+el("benchSlots").value||6; }

// ---------- draft engine ----------
function startMock(){
  if (!state.players.length){ alert("Load players first (consensus.json or upload CSV)."); return; }
  syncSettings();
  state.myTeamIndex = state.settings.pickPos - 1;
  const T = state.settings.teams;
  state.teamRosters = new Array(T).fill(0).map(()=>[]);
  state.rosterSlots = new Array(T).fill(0).map(()=>({QB:0,RB:0,WR:0,TE:0,FLEX:0,BEN:0}));
  state.draftPicks = []; state.currentOverall = 1; state.started = true; state.paused=false;
  render(); if (state.autoplay.enabled) startAutoLoop();
}
function pauseMock(){ state.paused=true; stopAutoLoop(); }
function resumeMock(){ if(!state.started) return; state.paused=false; if(state.autoplay.enabled) startAutoLoop(); }

function overallToTeam(overall){
  const T=state.settings.teams; const r=Math.ceil(overall/T); const pos=overall-(r-1)*T;
  return (r%2===1) ? (pos-1) : (T - pos);
}
function getRound(overall){ return Math.ceil(overall/state.settings.teams); }
function pickInRound(overall){ const r=getRound(overall), start=(r-1)*state.settings.teams+1; return overall-start+1; }

function startAutoLoop(){ stopAutoLoop();
  if (!state.autoplay.enabled) return;
  state.autoplay.loopId = setInterval(()=>{
    if (!state.started || state.paused) return;
    const total=state.settings.teams*state.settings.rounds;
    if(state.currentOverall>total){ stopAutoLoop(); return; }
    const team = overallToTeam(state.currentOverall);
    if (team === state.myTeamIndex) return; // wait on your pick
    aiPick(team); advanceAfterPick();
  }, state.autoplay.delayMs);
}
function stopAutoLoop(){ if(state.autoplay.loopId) clearInterval(state.autoplay.loopId); state.autoplay.loopId=null; }

function nextPick(){
  if(!state.started){ alert("Start the draft first."); return; }
  const total=state.settings.teams*state.settings.rounds;
  if(state.currentOverall>total){ stopAutoLoop(); return; }
  const team = overallToTeam(state.currentOverall);
  if(team===state.myTeamIndex){
    const {list}=computeRecommendations(team); if(!list.length){ alert("No candidates available."); return; }
    draftPlayerById(list[0].id, team); advanceAfterPick(); return;
  }
  aiPick(team); advanceAfterPick();
}
function autoUntilMyPick(){
  if(!state.started){ alert("Start the draft first."); return; }
  state.paused=false;
  while(overallToTeam(state.currentOverall)!==state.myTeamIndex){
    const total=state.settings.teams*state.settings.rounds; if(state.currentOverall>total) break;
    const team = overallToTeam(state.currentOverall);
    aiPick(team); advanceAfterPick(false);
  } render();
}
function advanceAfterPick(shouldRender=true){ state.currentOverall += 1; if (shouldRender) render(); }

function aiPick(teamIndex){
  const {list}=computeRecommendations(teamIndex); if(!list.length) return;
  // No opponent biases; rely on tiers, VOR, needs, and stack synergy
  const weighted = list.slice(0,24).map(p=> ({...p, biasScore: p.score + stackBonusForTeam(teamIndex, p)}));
  weighted.sort((a,b)=>b.biasScore-a.biasScore);
  const k=Math.min(7, weighted.length), weights=Array.from({length:k},(_,i)=>(k-i));
  const sum=weights.reduce((a,b)=>a+b,0); let r=Math.random()*sum, pick=weighted[0];
  for(let i=0;i<k;i++){ r-=weights[i]; if(r<=0){ pick=weighted[i]; break; } }
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
  state.currentOverall = overall; render();
}

// ---------- export ----------
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

// ---------- scoring / recs ----------
function computeRecommendations(teamIndex){
  const base = replacementLevels(); const needs = rosterNeeds(teamIndex);
  let candidates = state.available.map(i=>state.players[i]);
  const posFilter=el("filterPos").value; const nameFilter=(el("searchName").value||"").toLowerCase();
  if(posFilter) candidates=candidates.filter(p=>p.pos===posFilter);
  if(nameFilter) candidates=candidates.filter(p=>p.player.toLowerCase().includes(nameFilter));

  const scored = candidates.map(p=>{
    const baseProj = state.dataFlags.hasProj ? (p.proj_ppr||0) : 0;
    const rep = state.dataFlags.hasProj ? (base[p.pos]||0) : 0;
    const vor = baseProj - rep;
    const tierBoost = (6 - Math.min(p.tier||6,6)) * 1.2;
    const valueBoost = state.dataFlags.hasADP ? Math.min(Math.max(0,(p.adp||state.currentOverall)-state.currentOverall)/10, 8) : 0;
    const needW = (needs[p.pos]||1.0);
    // Always include stack synergy
    const stackSynergy = stackBonusForTeam(teamIndex, p);
    let score = (state.dataFlags.hasProj ? vor*needW : 0) + tierBoost + valueBoost + stackSynergy;
    return {...p, baseProj, rep, vor, score, hasMyStack: hasPrimaryStackForMyTeam(p) };
  });

  scored.sort((a,b)=>{
    if((a.tier||9)!==(b.tier||9)) return (a.tier||9)-(b.tier||9);
    return b.score-a.score;
  });

  return { list: scored.slice(0,30), baseline: base, needs };
}
function replacementLevels(){
  if(!state.dataFlags.hasProj){ return {QB:0,RB:0,WR:0,TE:0}; }
  const s=state.settings, T=s.teams, flexShare=s.flex;
  const counts={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te}, idxAt={};
  for(const pos of ["QB","RB","WR","TE"]){ let N=T*counts[pos]; if(pos!=="QB"){ N += Math.round(0.5*T*flexShare/3); } idxAt[pos]=Math.max(N,1); }
  const baseline={};
  for(const pos of ["QB","RB","WR","TE"]){
    const pool=state.available.map(i=>state.players[i]).filter(p=>p.pos===pos).sort((a,b)=>(b.proj_ppr||0)-(a.proj_ppr||0));
    const idx=Math.min(idxAt[pos]-1, Math.max(0,pool.length-1)); baseline[pos]=pool[idx]? (pool[idx].proj_ppr||0):0;
  } return baseline;
}
function rosterNeeds(teamIndex){
  const s=state.settings, slots=state.rosterSlots[teamIndex]||{QB:0,RB:0,WR:0,TE:0,FLEX:0,BEN:0};
  const target={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te}, need={};
  for(const pos of ["QB","RB","WR","TE"]){ const have=slots[pos]||0, left=Math.max(0,target[pos]-have); need[pos]=1+left*0.75; }
  return need;
}

// ---------- UI renders ----------
function render(){ renderBoard(); renderRecs(); renderMyRoster(); renderScarcityBars(); renderRankings(); }

function renderBoard(){
  const root=el("board"); root.innerHTML="";
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
  const pl=state.players[p.playerIdx]; const logo = teamLogoUrl(pl.team); const posRank = getPosRank(pl);
  const div=document.createElement("div"); div.className="pick";
  div.innerHTML = `<div class="flex"><span class="badge">#${p.overall} R${p.round}.${p.pickInRound}</span><span class="small">Team ${p.team+1}</span></div>
                   <div class="flex" style="justify-content:flex-start; gap:8px;">
                     ${logo ? `<img src="${logo}" alt="${pl.team||''}" class="team-logo">` : ""}
                     <div class="name">${pl.player}</div>
                   </div>
                   <div class="small"><span class="badge pos ${pl.pos}">${pl.pos}${posRank?posRankLabel(pl,posRank):""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"} • ECR ${pl.ecr||"-"}</div>`;
  return div;
}

function renderRecs(){
  const root=el("recs"); root.innerHTML=""; if(!state.players.length){ root.textContent="Load players (CSV or consensus.json)."; return; }
  const team = state.started? overallToTeam(state.currentOverall) : state.myTeamIndex;
  const {list} = computeRecommendations(team); let lastTier = null;
  list.forEach((p)=>{
    const t = p.tier || 6; if(lastTier===null || t!==lastTier){ const sep=document.createElement("div"); sep.className=`tier-divider t${t}`; sep.textContent=`Tier ${t}`; root.appendChild(sep); lastTier=t; }
    const logo = teamLogoUrl(p.team); const adpBit = state.dataFlags.hasADP ? ` • ADP ${p.adp||"-"}` : ""; const projBit = state.dataFlags.hasProj ? ` • Proj ${p.baseProj.toFixed(1)} (rep ${p.rep.toFixed(1)})` : ""; const posRank = getPosRank(p);
    const stackBadge = p.hasMyStack ? `<span class="badge stack" title="Stacks with your roster">🔗 STACK</span>` : "";
    const d=document.createElement("div"); d.className="item";
    d.innerHTML = `<div class="flex">
        <div class="flex" style="gap:10px;">
          ${logo ? `<img src="${logo}" alt="${p.team||''}" class="team-logo">` : ""}
          <div>
            <div class="name">${p.player} ${stackBadge} <span class="badge tier t${t}">T${t}</span> <span class="badge pos ${p.pos}">${p.pos}${posRank?posRankLabel(p,posRank):""}</span></div>
            <div class="small">${p.team||""} • Bye ${p.bye||"-"} • ECR ${p.ecr||"-"}${projBit}${adpBit}</div>
          </div>
        </div>
        <div><button data-pick="${p.id}">Draft</button></div>
      </div>`;
    d.querySelector("button").onclick=()=>{ draftPlayerById(p.id, state.myTeamIndex); advanceAfterPick(); };
    root.appendChild(d);
  });
}

function renderRankings(){
  const root = el("rankingsList"); root.innerHTML = "";
  let list = state.available.map(i=>state.players[i]);
  const q = (el("rankingsSearch").value||"").toLowerCase(); const pos = el("rankingsPos").value;
  if(q) list = list.filter(p=>p.player.toLowerCase().includes(q));
  if(pos) list = list.filter(p=>p.pos===pos);
  list.sort((a,b)=> (a.ecr??1e9) - (b.ecr??1e9));
  list.slice(0,500).forEach(p=>{
    const logo = teamLogoUrl(p.team); const adpBit = state.dataFlags.hasADP ? ` • ADP ${p.adp||"-"}` : ""; const projBit = state.dataFlags.hasProj ? ` • Proj ${Number(p.proj_ppr||0).toFixed(1)}` : ""; const ecr = (p.ecr!=null)? `#${p.ecr}` : "#—"; const posRank = getPosRank(p);
    const stackBadge = hasPrimaryStackForMyTeam(p) ? `<span class="badge stack" title="Stacks with your roster">🔗 STACK</span>` : "";
    const d=document.createElement("div"); d.className="item";
    d.innerHTML = `<div class="flex">
      <div class="flex" style="gap:10px;">
        ${logo ? `<img src="${logo}" alt="${p.team||''}" class="team-logo">` : ""}
        <div>
          <div class="name">${p.player} ${stackBadge} <span class="badge pos ${p.pos}">${p.pos}${posRank?posRankLabel(p,posRank):""}</span> <span class="badge">${ecr}</span></div>
          <div class="small">${p.team||""} • Bye ${p.bye||"-"}${adpBit}${projBit}</div>
        </div>
      </div>
      <div><button data-id="${p.id}">Draft</button></div>
    </div>`;
    d.querySelector("button").onclick = ()=>{ draftPlayerById(p.id, state.myTeamIndex); advanceAfterPick(); };
    root.appendChild(d);
  });
}

function renderMyRoster(){
  const root=el("myRoster"); root.innerHTML=""; if(!state.teamRosters.length){ root.textContent="Start the draft to see your roster."; return; }
  const mineIdxs = state.teamRosters[state.myTeamIndex] || []; const mine = mineIdxs.map(i=>state.players[i]);
  mine.sort((a,b)=> (a.ecr ?? 9999) - (b.ecr ?? 9999));
  const slotsTarget = { QB: state.settings.qb, RB: state.settings.rb, WR: state.settings.wr, TE: state.settings.te, FLEX: state.settings.flex };
  const starters = { QB:[], RB:[], WR:[], TE:[], FLEX:[] }; const bench = [];
  for(const p of mine){
    if (slotsTarget[p.pos] && starters[p.pos].length < slotsTarget[p.pos]) { starters[p.pos].push(p); continue; }
    if ((p.pos==="RB" || p.pos==="WR" || p.pos==="TE") && starters.FLEX.length < slotsTarget.FLEX){ starters.FLEX.push(p); continue; }
    bench.push(p);
  }
  const rowHTML = (pl) => { const logo = teamLogoUrl(pl.team); const posRank = getPosRank(pl); const ecr = (pl.ecr!=null) ? `#${pl.ecr}` : "#—";
    return `<div class="roster-item">${logo ? `<img src="${logo}" alt="${pl.team||''}" class="team-logo team-logo-sm">` : ""}
      <div class="roster-main"><div class="roster-name">${pl.player}</div><div class="roster-meta"><span class="badge pos ${pl.pos}">${pl.pos}${posRank?posRankLabel(pl,posRank):""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"} • ECR ${ecr}</div></div></div>`; };
  const section = (label, list) => { const wrap = document.createElement("div"); wrap.className = "roster-section"; const count = list.length;
    wrap.innerHTML = `<div class="roster-header small">${label}${label!=="Bench" ? ` (${count}/${slotsTarget[label] ?? ""})` : ""}</div>`;
    if (!count) { const empty = document.createElement("div"); empty.className = "roster-empty small"; empty.textContent = "—"; wrap.appendChild(empty); }
    else { list.forEach(pl => { const row = document.createElement("div"); row.innerHTML = rowHTML(pl); wrap.appendChild(row.firstElementChild); }); }
    root.appendChild(wrap); };
  section("QB", starters.QB); section("RB", starters.RB); section("WR", starters.WR); section("TE", starters.TE); if (state.settings.flex > 0) section("FLEX", starters.FLEX); section("Bench", bench);
}

function renderScarcityBars(){
  // always on
  show("scarcityWrap", true);
  const root = el("scarcityBars"); root.innerHTML="";
  ["QB","RB","WR","TE"].forEach(pos=>{
    const total = state.players.filter(p=>p.pos===pos).length;
    const remain = state.available.map(i=>state.players[i]).filter(p=>p.pos===pos).length;
    const pct = total? Math.round((remain/total)*100) : 0;
    const bar = document.createElement("div"); bar.className = "scarcity-row";
    bar.innerHTML = `<div class="scarcity-label">${pos} <span class="small">(${remain}/${total})</span></div>
      <div class="scarcity-track"><div class="scarcity-fill ${pos}" style="width:${pct}%"></div></div>`;
    root.appendChild(bar);
  });
}

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", init);
