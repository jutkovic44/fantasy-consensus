const DATA_URL = "./consensus.json"; // same repo (GitHub Pages)

let state = {
  settings: { teams:12, rounds:16, pickPos:5, scoring:"PPR", qb:1, rb:2, wr:2, te:1, flex:1, bench:6, pickClock:30 },
  players: [], available: [], draftPicks: [], currentOverall:1, myTeamIndex:0,
  teamRosters: [], rosterSlots: [], started:false, timerId:null, clockRemaining:0, paused:false
};

const el = id => document.getElementById(id);

async function loadConsensus() {
  try {
    const resp = await fetch(DATA_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP "+resp.status);
    const data = await resp.json();
    const ts = data.updated_at || "unknown";
    document.getElementById("lastUpdated").textContent = `Last updated: ${ts} • Source: FantasyPros (PPR)`;
    state.players = (data.players||[]).map((p,i)=>({...p, id:p.id ?? i+1, drafted:false}));
    state.available = state.players.map((_,i)=>i);
  } catch (e) {
    document.getElementById("lastUpdated").textContent = "Could not load consensus.json yet.";
    console.error(e);
  }
}

function init() {
  loadConsensus();
  setInterval(loadConsensus, 30*60*1000);
  ["teams","rounds","pickPos","scoring","qbSlots","rbSlots","wrSlots","teSlots","flexSlots","benchSlots","pickClock"]
    .forEach(id=> el(id).addEventListener("input", syncSettings));

  el("startMock").onclick = startMock;
  el("pauseMock").onclick = pauseMock;
  el("resumeMock").onclick = resumeMock;
  el("nextPick").onclick = nextPick;
  el("autoUntilMyPick").onclick = autoUntilMyPick;
  el("undoPick").onclick = undoPick;
  el("exportBoard").onclick = exportBoard;
  el("doCompare").onclick = doCompare;
  render();
}
document.addEventListener("DOMContentLoaded", init);

function syncSettings(){ const s=state.settings;
  s.teams=+el("teams").value||12; s.rounds=+el("rounds").value||16; s.pickPos=+el("pickPos").value||5;
  s.scoring=el("scoring").value; s.qb=+el("qbSlots").value||1; s.rb=+el("rbSlots").value||2; s.wr=+el("wrSlots").value||2;
  s.te=+el("teSlots").value||1; s.flex=+el("flexSlots").value||1; s.bench=+el("benchSlots").value||6; s.pickClock=+el("pickClock").value||30;
}

function startMock(){
  if (!state.players.length){ alert("Waiting for rankings from consensus.json..."); return; }
  syncSettings();
  state.myTeamIndex = state.settings.pickPos - 1;
  const T = state.settings.teams;
  state.teamRosters = new Array(T).fill(0).map(()=>[]);
  state.rosterSlots = new Array(T).fill(0).map(()=>({QB:0,RB:0,WR:0,TE:0,FLEX:0,BEN:0}));
  state.draftPicks = []; state.currentOverall = 1; state.started = true; state.paused=false;
  tickClock(true); render();
}

function pauseMock(){ state.paused=true; stopClock(); }
function resumeMock(){ if(!state.started) return; state.paused=false; tickClock(false); }
function tickClock(reset){ stopClock(); if(reset) state.clockRemaining=state.settings.pickClock; updateClock();
  state.timerId = setInterval(()=>{ if(state.paused) return; state.clockRemaining -=1;
    if(state.clockRemaining<=0){ nextPick(true); } updateClock(); }, 1000);}
function stopClock(){ if(state.timerId) clearInterval(state.timerId); state.timerId=null; }
function updateClock(){ el("clock").textContent = state.started ? `${state.clockRemaining}s` : "—"; }

function overallToTeam(overall){ const T=state.settings.teams, r=Math.ceil(overall/T), pos=overall-(r-1)*T; return (r%2===1)?(pos-1):(T-pos); }
function getRound(overall){ return Math.ceil(overall/state.settings.teams); }
function pickInRound(overall){ const r=getRound(overall), start=(r-1)*state.settings.teams+1; return overall-start+1; }

function nextPick(auto=false){
  if(!state.started){ alert("Start the mock first."); return; }
  const total=state.settings.teams*state.settings.rounds; if(state.currentOverall>total){ stopClock(); return; }
  const team = overallToTeam(state.currentOverall);
  if(team===state.myTeamIndex){
    const {list}=computeRecommendations(team);
    if(auto && list.length){ draftPlayerById(list[0].id, team); state.currentOverall+=1; state.clockRemaining=state.settings.pickClock; }
    else { state.paused = true; updateClock(); render(); return; }
  } else { aiPick(team); state.currentOverall+=1; state.clockRemaining=state.settings.pickClock; }
  render();
}

function autoUntilMyPick(){
  if(!state.started){ alert("Start the mock first."); return; }
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
  const k=Math.min(6,list.length), weights=Array.from({length:k},(_,i)=>(k-i));
  const sum=weights.reduce((a,b)=>a+b,0); let r=Math.random()*sum, pick=list[0];
  for(let i=0;i<k;i++){ r-=weights[i]; if(r<=0){ pick=list[i]; break; } }
  draftPlayerById(pick.id,teamIndex);
}

function draftPlayerById(id, teamIndex){
  const poolIdx = state.players.findIndex(p=>p.id===id);
  const idx = state.available.indexOf(poolIdx);
  if(idx===-1 || poolIdx===-1) return;
  state.available.splice(idx,1); state.players[poolIdx].drafted=true;
  const overall=state.currentOverall, round=getRound(overall), pir=pickInRound(overall);
  state.teamRosters[teamIndex].push(poolIdx); bumpRosterSlot(teamIndex, state.players[poolIdx].pos);
  state.draftPicks.push({overall, team:teamIndex, round, pickInRound:pir, playerIdx:poolIdx});
}

function bumpRosterSlot(teamIndex,pos){ const s=state.rosterSlots[teamIndex]; if(!s) return; if(pos in s) s[pos]++; else s.BEN++; }

function undoPick(){
  if(!state.draftPicks.length) return;
  const last=state.draftPicks.pop(); const {playerIdx, team}=last;
  state.players[playerIdx].drafted=false; state.available.push(playerIdx);
  const r=state.teamRosters[team]; const ix=r.lastIndexOf(playerIdx); if(ix>=0) r.splice(ix,1);
  const pos=state.players[playerIdx].pos; if(pos in state.rosterSlots[team]) state.rosterSlots[team][pos]=Math.max(0, state.rosterSlots[team][pos]-1);
  state.currentOverall=Math.max(1,last.overall); render();
}

function exportBoard(){
  const rows=[["overall","round","pickInRound","team","player","pos","teamAbbr","bye","ecr","adp","proj_ppr","tier"]];
  for(const p of state.draftPicks){ const pl=state.players[p.playerIdx];
    rows.push([p.overall,p.round,p.pickInRound,p.team+1,pl.player,pl.pos,pl.team,pl.bye,pl.ecr,pl.adp,pl.proj_ppr,pl.tier]); }
  const csv=rows.map(r=>r.join(",")).join("\n");
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download="draft_board.csv"; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1500);
}

function computeRecommendations(teamIndex){
  const s=state.settings; const pprMult = s.scoring==="PPR"?1.0:(s.scoring==="Half"?0.5:0.0);
  const base = replacementLevels(); const needs = rosterNeeds(teamIndex);
  let candidates = state.available.map(i=>state.players[i]);
  const posFilter=document.getElementById("filterPos").value; const nameFilter=document.getElementById("searchName").value.toLowerCase();
  if(posFilter) candidates=candidates.filter(p=>p.pos===posFilter);
  if(nameFilter) candidates=candidates.filter(p=>p.player.toLowerCase().includes(nameFilter));
  const scored = candidates.map(p=>{
    const baseProj = (p.proj_ppr||0) - (1-pprMult)*(p.receptions||0);
    const rep = base[p.pos]||0; const vor = baseProj - rep;
    const tierBoost = (6 - Math.min(p.tier||6,6)) * 1.5; const riskPenalty = (p.risk||0)*8;
    const needW = (needs[p.pos]||1.0); const nextOverall=state.currentOverall;
    const valueBoost = Math.min(Math.max(0,(p.adp||nextOverall)-nextOverall)/10, 8);
    const score = vor*needW + tierBoost + valueBoost - riskPenalty;
    return {...p, baseProj, rep, vor, score};
  });
  scored.sort((a,b)=>b.score-a.score);
  return { list: scored.slice(0,18), baseline: base, needs };
}

function replacementLevels(){
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

function render(){ renderBoard(); renderRecs(); renderMyRoster(); renderScarcity(); }
function renderBoard(){
  const root=el("board"); root.innerHTML="";
  for(const p of state.draftPicks){ const pl=state.players[p.playerIdx];
    const div=document.createElement("div"); div.className="pick";
    div.innerHTML = `<div class="flex"><span class="badge">#${p.overall} R${p.round}.${p.pickInRound}</span><span class="small">Team ${p.team+1}</span></div>
                     <div class="name">${pl.player}</div>
                     <div class="small"><span class="badge">${pl.pos}</span> • ${pl.team||""} • Bye ${pl.bye||"-"} • ECR ${pl.ecr||"-"}</div>`;
    root.appendChild(div); }
}

function renderRecs(){
  const root=el("recs"); root.innerHTML=""; if(!state.players.length){ root.textContent="Waiting for rankings..."; return; }
  const team = state.started? overallToTeam(state.currentOverall) : state.myTeamIndex;
  const {list} = computeRecommendations(team);
  const container=document.createElement("div"); container.className="list";
  list.forEach((p,i)=>{
    const d=document.createElement("div"); d.className="item";
    d.innerHTML = `<div class="flex">
        <div>
          <div class="name">${i+1}. ${p.player} <span class="badge">${p.pos||"-"}</span> <span class="badge">Tier ${p.tier||"-"}</span></div>
          <div class="small">VOR ${p.vor.toFixed(1)} • Proj ${p.baseProj.toFixed(1)} (rep ${p.rep.toFixed(1)}) • ADP ${p.adp||"-"}</div>
        </div>
        <div><button data-pick="${p.id}">Draft</button></div>
      </div>`;
    d.querySelector("button").onclick=()=>{
      if(overallToTeam(state.currentOverall)!==state.myTeamIndex){ alert("It's not your pick yet. Use 'Auto until my pick'."); return; }
      draftPlayerById(p.id, state.myTeamIndex); state.currentOverall+=1; state.clockRemaining=state.settings.pickClock; render();
    };
    container.appendChild(d);
  });
  root.appendChild(container);
}

function renderMyRoster(){
  const root=el("myRoster"); root.innerHTML=""; if(!state.teamRosters.length){ root.textContent="Start the mock to see your roster."; return; }
  const mine=state.teamRosters[state.myTeamIndex]||[]; const byPos={QB:[],RB:[],WR:[],TE:[],FLEX:[],BEN:[]};
  for(const idx of mine){ const p=state.players[idx]; if(byPos[p.pos]) byPos[p.pos].push(p); else byPos.BEN.push(p); }
  const group=(label,arr)=>{ const div=document.createElement("div"); div.innerHTML=`<div class="small">${label}</div>`;
    arr.forEach(p=>{ const item=document.createElement("div"); item.className="small"; item.textContent=`${p.player} (${p.pos} • ${p.team||""})`; div.appendChild(item); });
    root.appendChild(div); };
  group("QB",byPos.QB); group("RB",byPos.RB); group("WR",byPos.WR); group("TE",byPos.TE); group("Bench/Others",byPos.BEN);
}

function renderScarcity(){
  const root=el("scarcity"); root.innerHTML=""; if(!state.players.length){ root.textContent="Load data first."; return; }
  const base=replacementLevels();
  ["QB","RB","WR","TE"].forEach(pos=>{
    const div=document.createElement("div");
    const pool=state.available.map(i=>state.players[i]).filter(p=>p.pos===pos).sort((a,b)=>(b.proj_ppr||0)-(a.proj_ppr||0));
    const top5=pool.slice(0,5).map(p=>`${p.player.split(" ").slice(-1)[0]}(${(p.proj_ppr||0).toFixed(0)})`).join(", ");
    div.className="small"; div.textContent=`${pos}: rep≈${base[pos].toFixed(1)} | top: ${top5}`; root.appendChild(div);
  });
}
