const DATA_URL = "./consensus.json";

let state = {
  settings: { teams:12, rounds:16, pickPos:5, scoring:"PPR",
    qb:1, rb:2, wr:2, te:1, flex:1, bench:6, pickClock:30 },
  players: [], available: [], draftPicks: [], currentOverall:1, myTeamIndex:0,
  teamRosters: [], rosterSlots: [], started:false, timerId:null, clockRemaining:0, paused:false,
  keepersByTeam: {}, biasMap: {}, stackBoost:false,
  features: { live:false, keepers:true, biases:false, stack:false, compare:false, scarcity:true, advanced:false },
  dataFlags: { hasProj:false, hasADP:false },
  autoplay: { enabled:true, delayMs:900, loopId:null }
};

const el = id => document.getElementById(id);
const show = (id, on)=>{ const n=el(id); if(!n) return; n.classList.toggle("hidden", !on); };

// ---------- Load & Detect Data ----------
async function loadConsensus() {
  const lastUpdatedEl = el("lastUpdated");
  try {
    const resp = await fetch(DATA_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — consensus.json not found at ${DATA_URL}`);
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("Invalid JSON in consensus.json"); }
    if (!data.players || !Array.isArray(data.players) || data.players.length === 0)
      throw new Error("consensus.json loaded but contains no player data");

    const ts = data.updated_at || "unknown";
    lastUpdatedEl.textContent = `Last updated: ${ts}`;

    state.players = data.players.map((p,i)=>({...p, id:p.id ?? i+1, drafted:false}));
    state.available = state.players.map((_,i)=>i);

    state.dataFlags.hasProj = state.players.some(p=> (p.proj_ppr||0) > 0);
    state.dataFlags.hasADP  = state.players.some(p=> p.adp !== null && p.adp !== undefined);

    if(!state.dataFlags.hasProj){ state.features.compare=false; const t=el("toggleCompare"); if(t) t.checked=false; }
    render();
  } catch (e) {
    console.error("Consensus load error:", e);
    lastUpdatedEl.innerHTML = `<span style="color:#f87171; font-weight:bold;">Error:</span> ${e.message}`;
  }
}

function bindFeatureToggles(){
  el("toggleLive").onchange = () => { state.features.live = el("toggleLive").checked; updateFeatureVisibility(); };
  el("toggleKeepers").onchange = () => { state.features.keepers = el("toggleKeepers").checked; updateFeatureVisibility(); };
  el("toggleBiases").onchange = () => { state.features.biases = el("toggleBiases").checked; updateFeatureVisibility(); };
  el("toggleStack").onchange = () => { state.features.stack = el("toggleStack").checked; state.stackBoost = state.features.stack; updateFeatureVisibility(); };
  el("toggleCompare").onchange = () => { state.features.compare = el("toggleCompare").checked && state.dataFlags.hasProj; updateFeatureVisibility(); };
  el("toggleScarcity").onchange = () => { state.features.scarcity = el("toggleScarcity").checked; updateFeatureVisibility(); };
  el("toggleAdvanced").onchange = () => { state.features.advanced = el("toggleAdvanced").checked; updateFeatureVisibility(); };
}

function updateFeatureVisibility(){
  show("liveModeWrap", state.features.live);
  show("liveManualWrap", state.features.live);
  show("keepersWrap", state.features.keepers);
  show("biasesWrap", state.features.biases);
  show("compareWrap", state.features.compare && state.dataFlags.hasProj);
  show("scarcityWrap", state.features.scarcity);
}

// ---------- Init ----------
function init() {
  loadConsensus();
  setInterval(loadConsensus, 30*60*1000);
  ["teams","rounds","pickPos","scoring","qbSlots","rbSlots","wrSlots","teSlots","flexSlots","benchSlots","pickClock"]
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

  // Auto-draft others controls
  el("autoOthers").onchange = () => {
    state.autoplay.enabled = el("autoOthers").checked;
    if (state.autoplay.enabled) startAutoLoop(); else stopAutoLoop();
  };
  el("cpuDelay").oninput = () => {
    const v = +el("cpuDelay").value || 900;
    state.autoplay.delayMs = Math.max(200, v);
    if (state.autoplay.enabled) startAutoLoop(); // restart cadence
  };

  // Keepers
  el("addKeeper").onclick = addKeeper;
  el("clearKeepers").onclick = clearKeepers;
  el("biasInput")?.addEventListener("change", parseBiasInput);
  el("manualPickBtn").onclick = manualPick;

  bindFeatureToggles();
  updateFeatureVisibility();
  render();
}
document.addEventListener("DOMContentLoaded", init);

function syncSettings(){ const s=state.settings;
  s.teams=+el("teams").value||12; s.rounds=+el("rounds").value||16; s.pickPos=+el("pickPos").value||5;
  s.scoring=el("scoring").value; s.qb=+el("qbSlots").value||1; s.rb=+el("rbSlots").value||2; s.wr=+el("wrSlots").value||2;
  s.te=+el("teSlots").value||1; s.flex=+el("flexSlots").value||1; s.bench=+el("benchSlots").value||6; s.pickClock=+el("pickClock").value||30;
}

// ---------- Draft Engine ----------
function startMock(){
  if (!state.players.length){ alert("Waiting for rankings from consensus.json..."); return; }
  syncSettings();
  state.myTeamIndex = state.settings.pickPos - 1;
  const T = state.settings.teams;
  state.teamRosters = new Array(T).fill(0).map(()=>[]);
  state.rosterSlots = new Array(T).fill(0).map(()=>({QB:0,RB:0,WR:0,TE:0,FLEX:0,BEN:0}));
  state.draftPicks = []; state.currentOverall = 1; state.started = true; state.paused=false;

  // apply keepers by team before pick 1.1
  applyKeepersByTeam();

  tickClock(true); render();
  if (!state.features.live && state.autoplay.enabled) startAutoLoop();
}

function pauseMock(){ state.paused=true; stopClock(); stopAutoLoop(); }
function resumeMock(){ if(!state.started) return; state.paused=false; tickClock(false); if(!state.features.live && state.autoplay.enabled) startAutoLoop(); }
function tickClock(reset){ stopClock(); if(reset) state.clockRemaining=state.settings.pickClock; updateClock();
  state.timerId = setInterval(()=>{ if(state.paused) return; state.clockRemaining -=1;
    if(state.clockRemaining<=0){ nextPick(true); } updateClock(); }, 1000);}
function stopClock(){ if(state.timerId) clearInterval(state.timerId); state.timerId=null; }
function updateClock(){ el("clock").textContent = state.started ? `${state.clockRemaining}s` : "—"; }

function overallToTeam(overall){ const T=state.settings.teams, r=Math.ceil(overall/T), pos=overall-(r-1)*T; return (r%2===1)?(pos-1):(T-pos); }
function getRound(overall){ return Math.ceil(overall/state.settings.teams); }
function pickInRound(overall){ const r=getRound(overall), start=(r-1)*state.settings.teams+1; return overall-start+1; }

function startAutoLoop(){
  stopAutoLoop();
  if (!state.autoplay.enabled) return;
  state.autoplay.loopId = setInterval(()=>{
    if (!state.started || state.paused) return;
    const total=state.settings.teams*state.settings.rounds;
    if(state.currentOverall>total){ stopAutoLoop(); return; }
    const team = overallToTeam(state.currentOverall);
    // stop at my pick
    if (team === state.myTeamIndex) return;
    // otherwise CPU pick
    aiPick(team);
    state.currentOverall += 1;
    render();
  }, state.autoplay.delayMs);
}
function stopAutoLoop(){ if(state.autoplay.loopId) clearInterval(state.autoplay.loopId); state.autoplay.loopId=null; }

function nextPick(auto=false){
  if(!state.started){ alert("Start the draft first."); return; }
  const total=state.settings.teams*state.settings.rounds;
  if(state.currentOverall>total){ stopClock(); stopAutoLoop(); return; }

  const team = overallToTeam(state.currentOverall);

  // If it's my turn
  if(team===state.myTeamIndex){
    const {list}=computeRecommendations(team);
    if(list.length){
      draftPlayerById(list[0].id, team);
      state.currentOverall += 1;
      updateClock(); render(); return;
    } else { alert("No candidates available."); return; }
  }

  // If CPU turn and user clicked Next => force one pick
  aiPick(team); state.currentOverall += 1; updateClock(); render();
}

function manualPick(){
  if(!state.started){ alert("Start the draft first."); return; }
  const t = parseInt(el("manualTeam").value, 10);
  const name = (el("manualPlayer").value||"").trim();
  if(isNaN(t) || t<1 || t>state.settings.teams){ alert("Enter a valid team number."); return; }
  if(!name){ alert("Enter a player name."); return; }
  const idx = state.players.findIndex(p=>p.player.toLowerCase()===name.toLowerCase());
  if(idx<0){ alert("Player not found."); return; }
  draftByIndex(idx, t-1, false, /*incrementOverall*/true);
  render();
}

function autoUntilMyPick(){
  if(!state.started){ alert("Start the draft first."); return; }
  if(state.features.live){ alert("Live Mode is on. Enter picks via Manual Pick."); return; }
  state.paused=false;
  while(overallToTeam(state.currentOverall)!==state.myTeamIndex){
    const total=state.settings.teams*state.settings.rounds; if(state.currentOverall>total) break;
    nextPick(true);
  }
  state.paused=true; updateClock(); render();
}

function aiPick(teamIndex){
  const {list}=computeRecommendations(teamIndex);
  if(!list.length) return;
  const bias = state.features.biases ? (state.biasMap[teamIndex+1] || "BAL") : "BAL";
  const weighted = list.slice(0,24).map(p=> ({...p, biasScore: p.score + biasBoost(p, bias) + stackBonusForTeam(teamIndex, p)}));
  weighted.sort((a,b)=>b.biasScore-a.biasScore);
  const k=Math.min(7, weighted.length), weights=Array.from({length:k},(_,i)=>(k-i));
  const sum=weights.reduce((a,b)=>a+b,0); let r=Math.random()*sum, pick=weighted[0];
  for(let i=0;i<k;i++){ r-=weights[i]; if(r<=0){ pick=weighted[i]; break; } }
  draftPlayerById(pick.id,teamIndex);
}

function biasBoost(p, bias){
  const map = {RB:{RB:6,WR:1,QB:0,TE:0}, WR:{WR:6,RB:1,QB:0,TE:0}, QB:{QB:6,WR:0,RB:0,TE:0}, TE:{TE:5,WR:0,RB:0,QB:0}, BAL:{RB:0,WR:0,QB:0,TE:0}};
  const m = map[bias] || map.BAL; return (m[p.pos]||0);
}

function stackBonusForTeam(teamIndex, candidate){
  if(!state.stackBoost) return 0;
  const roster = (state.teamRosters[teamIndex]||[]).map(i=>state.players[i]);
  let bonus = 0;
  for(const pl of roster){
    if(!pl.team || !candidate.team) continue;
    if(pl.team === candidate.team){
      if( (pl.pos==="QB" && (candidate.pos==="WR" || candidate.pos==="TE")) ||
          (candidate.pos==="QB" && (pl.pos==="WR" || pl.pos==="TE")) ){ bonus += 5; }
      else if (pl.pos===candidate.pos && (pl.pos==="WR" || pl.pos==="TE")) { bonus += 2; }
      else { bonus += 1; }
    }
  }
  return bonus;
}

function draftPlayerById(id, teamIndex){
  const poolIdx = state.players.findIndex(p=>p.id===id);
  if(poolIdx===-1) return;
  draftByIndex(poolIdx, teamIndex, false, /*incrementOverall*/true);
}

function draftByIndex(poolIdx, teamIndex, isKeeper=false, incrementOverall=true){
  if(state.players[poolIdx].drafted) return;
  const idxAvail = state.available.indexOf(poolIdx);
  if(idxAvail!==-1) state.available.splice(idxAvail,1);
  state.players[poolIdx].drafted=true;
  const overall=state.currentOverall, round=getRound(overall), pir=pickInRound(overall);
  state.teamRosters[teamIndex].push(poolIdx); bumpRosterSlot(teamIndex, state.players[poolIdx].pos);
  state.draftPicks.push({overall, team:teamIndex, round, pickInRound:pir, playerIdx:poolIdx, keeper:isKeeper});
  if(incrementOverall) state.currentOverall += 1;
}

function bumpRosterSlot(teamIndex,pos){ const s=state.rosterSlots[teamIndex]; if(!s) return; if(pos in s) s[pos]++; else s.BEN++; }

function undoPick(){
  if(!state.draftPicks.length) return;
  const last=state.draftPicks.pop(); const {playerIdx, team}=last;
  state.players[playerIdx].drafted=false;
  if(!state.available.includes(playerIdx)) state.available.push(playerIdx);
  const r=state.teamRosters[team]; const ix=r.lastIndexOf(playerIdx); if(ix>=0) r.splice(ix,1);
  const pos=state.players[playerIdx].pos; if(pos in state.rosterSlots[team]) state.rosterSlots[team][pos]=Math.max(0, state.rosterSlots[team][pos]-1);
  state.currentOverall=Math.max(1,last.overall); render();
}

// ---------- Export ----------
function exportBoard(){
  const rows=[["overall","round","pickInRound","team","player","pos","teamAbbr","bye","ecr","adp","proj_ppr","tier","keeper"]];
  for(const p of state.draftPicks){ const pl=state.players[p.playerIdx];
    rows.push([p.overall,p.round,p.pickInRound,p.team+1,pl.player,pl.pos,pl.team,pl.bye,pl.ecr,pl.adp,pl.proj_ppr,pl.tier, p.keeper?1:0]); }
  const csv=rows.map(r=>r.join(",")).join("\n");
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download="draft_board.csv"; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1500);
}

// ---------- Recommendations ----------
function computeRecommendations(teamIndex){
  const base = replacementLevels();
  const needs = rosterNeeds(teamIndex);

  let candidates = state.available.map(i=>state.players[i]);
  const posFilter=el("filterPos").value; const nameFilter=el("searchName").value.toLowerCase();
  if(posFilter) candidates=candidates.filter(p=>p.pos===posFilter);
  if(nameFilter) candidates=candidates.filter(p=>p.player.toLowerCase().includes(nameFilter));

  const scored = candidates.map(p=>{
    const baseProj = state.dataFlags.hasProj ? (p.proj_ppr||0) : 0;
    const rep = state.dataFlags.hasProj ? (base[p.pos]||0) : 0;
    const vor = baseProj - rep;
    const tierBoost = (6 - Math.min(p.tier||6,6)) * 1.2;
    const valueBoost = state.dataFlags.hasADP ? Math.min(Math.max(0,(p.adp||state.currentOverall)-state.currentOverall)/10, 8) : 0;
    const needW = (needs[p.pos]||1.0);
    let score = (state.dataFlags.hasProj ? vor*needW : 0) + tierBoost + valueBoost;
    score += stackBonusForTeam(teamIndex, p);
    return {...p, baseProj, rep, vor, score};
  });

  scored.sort((a,b)=>{
    if((a.tier||9)!==(b.tier||9)) return (a.tier||9)-(b.tier||9);
    return b.score-a.score;
  });

  return { list: scored.slice(0,30), baseline: base, needs };
}

function replacementLevels(){
  if(!state.dataFlags.hasProj){ return {QB:0,RB:0,WR:0,TE:0}; }
  const s=state.settings, T=s.teams, flexShare=s.flex, counts={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te}, idxAt={};
  for(const pos of ["QB","RB","WR","TE"]){ let N=T*counts[pos]; if(pos!=="QB"){ N += Math.round(0.5*T*flexShare/3); } idxAt[pos]=Math.max(N,1); }
  const baseline={};
  for(const pos of ["QB","RB","WR","TE"]){
    const pool=state.available.map(i=>state.players[i]).filter(p=>p.pos===pos).sort((a,b)=>(b.proj_ppr||0)-(a.proj_ppr||0));
    const idx=Math.min(idxAt[pos]-1, Math.max(0,pool.length-1)); baseline[pos]=pool[idx]? (pool[idx].proj_ppr||0):0;
  }
  return baseline;
}

function rosterNeeds(teamIndex){
  const s=state.settings, slots=state.rosterSlots[teamIndex]||{QB:0,RB:0,WR:0,TE:0,FLEX:0,BEN:0};
  const target={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te}, need={};
  for(const pos of ["QB","RB","WR","TE"]){ const have=slots[pos]||0, left=Math.max(0,target[pos]-have); need[pos]=1+left*0.75; }
  return need;
}

// ---------- Keepers & Biases ----------
function addKeeper(){
  const teamStr = el("keeperTeam").value;
  const name = (el("keeperName").value||"").trim();
  const team = parseInt(teamStr,10);
  if(isNaN(team) || team<1 || team>state.settings.teams){ alert("Team # 1.."+state.settings.teams); return; }
  if(!name){ alert("Enter player name"); return; }
  state.keepersByTeam[team] = state.keepersByTeam[team] || [];
  if(!state.keepersByTeam[team].includes(name)) state.keepersByTeam[team].push(name);
  el("keeperName").value=""; renderKeepers();
}

function clearKeepers(){ state.keepersByTeam = {}; renderKeepers(); }

function renderKeepers(){
  const root = el("keepersList"); root.innerHTML = "";
  const entries = Object.entries(state.keepersByTeam);
  if(!entries.length){ root.textContent = "No keepers added."; return; }
  entries.sort((a,b)=>parseInt(a[0],10)-parseInt(b[0],10));
  entries.forEach(([team, arr])=>{
    const div=document.createElement("div"); div.className="small";
    div.textContent = `Team ${team}: ${arr.join(", ")}`;
    root.appendChild(div);
  });
}

function parseBiasInput(){
  const input = el("biasInput"); if(!input) return;
  const txt = (input.value||"").trim();
  state.biasMap = {};
  if(!txt) return;
  txt.split(",").forEach(pair=>{
    const [teamStr,biasRaw] = pair.split(":").map(s=>s.trim());
    const t = parseInt(teamStr,10);
    const bias = (biasRaw||"").toUpperCase();
    if(!isNaN(t) && t>=1 && t<=state.settings.teams && ["RB","WR","QB","TE"].includes(bias)){
      state.biasMap[t] = bias;
    }
  });
}

// ---------- Rendering ----------
function render(){ renderBoard(); renderRecs(); renderMyRoster(); renderScarcityBars(); renderKeepers(); updateFeatureVisibility(); }

function renderBoard(){
  const root=el("board"); root.innerHTML="";
  for(const p of state.draftPicks){
    const pl=state.players[p.playerIdx];
    const div=document.createElement("div"); div.className="pick" + (p.keeper?" keeper":"");
    div.innerHTML = `<div class="flex"><span class="badge">#${p.overall} R${p.round}.${p.pickInRound}</span><span class="small">Team ${p.team+1}${p.keeper?" • Keeper":""}</span></div>
                     <div class="name">${pl.player}</div>
                     <div class="small"><span class="badge pos ${pl.pos}">${pl.pos}</span> • ${pl.team||""} • Bye ${pl.bye||"-"} • ECR ${pl.ecr||"-"}</div>`;
    root.appendChild(div);
  }
}

function renderRecs(){
  const root=el("recs"); root.innerHTML=""; if(!state.players.length){ root.textContent="Waiting for rankings..."; return; }
  const team = state.started? overallToTeam(state.currentOverall) : state.myTeamIndex;
  const {list} = computeRecommendations(team);
  let lastTier = null;
  list.forEach((p)=>{
    const t = p.tier || 6;
    if(lastTier===null || t!==lastTier){
      const sep=document.createElement("div");
      sep.className = `tier-divider t${t}`;
      sep.textContent = `Tier ${t}`;
      root.appendChild(sep);
      lastTier = t;
    }
    const d=document.createElement("div"); d.className="item";
    const line = state.dataFlags.hasProj ? `VOR ${p.vor.toFixed(1)} • Proj ${p.baseProj.toFixed(1)} (rep ${p.rep.toFixed(1)})` : "Tiered recommendation";
    const adpBit = state.dataFlags.hasADP ? ` • ADP ${p.adp||"-"}` : "";
    d.innerHTML = `<div class="flex">
        <div>
          <div class="name">${p.player} <span class="badge tier t${t}">T${t}</span> <span class="badge pos ${p.pos||"-"}">${p.pos||"-"}</span></div>
          <div class="small">${line}${adpBit}</div>
        </div>
        <div><button data-pick="${p.id}">Draft</button></div>
      </div>`;
    d.querySelector("button").onclick=()=>{
      draftPlayerById(p.id, state.myTeamIndex);
      render();
    };
    root.appendChild(d);
  });
}

function renderMyRoster(){
  const root=el("myRoster"); root.innerHTML=""; if(!state.teamRosters.length){ root.textContent="Start the draft to see your roster."; return; }
  const mine=state.teamRosters[state.myTeamIndex]||[]; const byPos={QB:[],RB:[],WR:[],TE:[],FLEX:[],BEN:[]};
  for(const idx of mine){ const p=state.players[idx]; if(byPos[p.pos]) byPos[p.pos].push(p); else byPos.BEN.push(p); }
  const group=(label,arr)=>{ const div=document.createElement("div"); div.innerHTML=`<div class="small">${label}</div>`;
    arr.forEach(p=>{ const item=document.createElement("div"); item.className="small"; item.textContent=`${p.player} (${p.pos} • ${p.team||""})`; div.appendChild(item); });
    root.appendChild(div); };
  group("QB",byPos.QB); group("RB",byPos.RB); group("WR",byPos.WR); group("TE",byPos.TE); group("Bench/Others",byPos.BEN);
}

function renderScarcityBars(){
  if(!state.features.scarcity){ return; }
  const root = el("scarcityBars"); root.innerHTML="";
  ["QB","RB","WR","TE"].forEach(pos=>{
    const total = state.players.filter(p=>p.pos===pos).length;
    const remain = state.available.map(i=>state.players[i]).filter(p=>p.pos===pos).length;
    const pct = total? Math.round((remain/total)*100) : 0;
    const bar = document.createElement("div");
    bar.className = "scarcity-row";
    bar.innerHTML = `<div class="scarcity-label">${pos} <span class="small">(${remain}/${total})</span></div>
      <div class="scarcity-track"><div class="scarcity-fill ${pos}" style="width:${pct}%"></div></div>`;
    root.appendChild(bar);
  });
}
