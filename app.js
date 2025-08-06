/* Fantasy Football War Room — full app.js (no clock, no compare tool, logos everywhere)
   - Snake draft logic fixed
   - Auto-drafts others until your pick, waits, then resumes after you pick
   - Every pick is recorded and rendered (no skipping)
   - Recommendations + Rankings + Draft Board show team logos and rich info
*/

const DATA_URL = "./consensus.json";

let state = {
  settings: { teams:12, rounds:16, pickPos:5, scoring:"PPR",
    qb:1, rb:2, wr:2, te:1, flex:1, bench:6 },
  players: [],           // full player objects
  available: [],         // indices into players[]
  draftPicks: [],        // {overall, team, round, pickInRound, playerIdx}
  currentOverall: 1,     // 1-based overall pick counter
  myTeamIndex: 0,        // 0-based team index for the user
  teamRosters: [],       // teamIndex -> [playerIdx,...]
  rosterSlots: [],       // teamIndex -> {QB,RB,WR,TE,FLEX,BEN}
  started: false,
  paused: false,

  // Feature flags
  features: { biases:false, stack:false, scarcity:true }, // compare tool removed
  biasMap: {},          // optional team biases per CPU (unused unless you enable)
  stackBoost: false,    // derived from features.stack

  // Data flags
  dataFlags: { hasProj:false, hasADP:false },

  // Autoplay engine (hidden CPU delay)
  autoplay: { enabled:true, delayMs:1000, loopId:null },

  // UI
  boardView: localStorage.getItem("boardView") || "overall", // "overall" or "round"
  posRankCache: {}     // {QB: Map(playerId->rank), RB:..., WR:..., TE:...}
};

// --------- Helpers ----------
const el = id => document.getElementById(id);
const show = (id, on)=>{ const n=el(id); if(!n) return; n.classList.toggle("hidden", !on); };

// NFL club logos by team abbreviation (e.g., KC, DET, DAL, JAX/JAC).
function teamLogoUrl(abbr){
  if(!abbr) return "";
  const code = String(abbr).toUpperCase().trim();
  return `https://static.www.nfl.com/league/api/clubs/logos/${code}.svg`;
}

// Build position-rank cache from ECR so we can label WR3 / QB5, etc.
function buildPosRankCache(){
  state.posRankCache = {};
  ["QB","RB","WR","TE"].forEach(pos=>{
    const arr = state.players
      .filter(p=>p.pos===pos && p.ecr!=null)
      .sort((a,b)=>(a.ecr)-(b.ecr));
    const map = new Map();
    arr.forEach((p,idx)=> map.set(p.id ?? p._id ?? p.player, idx+1));
    state.posRankCache[pos] = map;
  });
}
function getPosRank(p){
  const m = state.posRankCache[p.pos];
  const key = p.id ?? p._id ?? p.player;
  return m ? m.get(key) : undefined;
}
function posRankLabel(p, rank){ return rank ? `${p.pos}${rank}` : ""; }

// --------- Data load ----------
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

    lastUpdatedEl.textContent = `Last updated: ${data.updated_at || "unknown"}`;

    // Normalize into internal shape
    state.players = data.players.map((p,i)=>({
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
    render();
  } catch (e) {
    console.error("Consensus load error:", e);
    lastUpdatedEl.innerHTML = `<span style="color:#f87171; font-weight:bold;">Error:</span> ${e.message}`;
  }
}

// --------- Init ----------
function init() {
  loadConsensus();
  // Periodically refresh rankings (in case your workflow updates the file)
  setInterval(loadConsensus, 30*60*1000);

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

  // Auto-draft others toggle
  el("autoOthers").onchange = () => {
    state.autoplay.enabled = el("autoOthers").checked;
    if (state.autoplay.enabled) startAutoLoop(); else stopAutoLoop();
  };

  // Feature toggles
  el("toggleBiases")?.addEventListener("change", ()=> state.features.biases = el("toggleBiases").checked );
  el("toggleStack")?.addEventListener("change", ()=> { state.features.stack = el("toggleStack").checked; state.stackBoost = state.features.stack; });
  el("toggleScarcity")?.addEventListener("change", ()=> { state.features.scarcity = el("toggleScarcity").checked; renderScarcityBars(); });

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

function updateTabs(){
  el("tabOverall").classList.toggle("active", state.boardView==="overall");
  el("tabByRound").classList.toggle("active", state.boardView==="round");
}

function syncSettings(){ const s=state.settings;
  s.teams=+el("teams").value||12; s.rounds=+el("rounds").value||16; s.pickPos=+el("pickPos").value||5;
  s.scoring=el("scoring").value; s.qb=+el("qbSlots").value||1; s.rb=+el("rbSlots").value||2; s.wr=+el("wrSlots").value||2;
  s.te=+el("teSlots").value||1; s.flex=+el("flexSlots").value||1; s.bench=+el("benchSlots").value||6;
}

// --------- Draft Engine ----------
function startMock(){
  if (!state.players.length){ alert("Waiting for rankings from consensus.json..."); return; }
  syncSettings();
  state.myTeamIndex = state.settings.pickPos - 1;

  const T = state.settings.teams;
  state.teamRosters = new Array(T).fill(0).map(()=>[]);
  state.rosterSlots = new Array(T).fill(0).map(()=>({QB:0,RB:0,WR:0,TE:0,FLEX:0,BEN:0}));

  state.draftPicks = [];
  state.currentOverall = 1;
  state.started = true;
  state.paused = false;

  render();
  if (state.autoplay.enabled) startAutoLoop();
}

function pauseMock(){ state.paused=true; stopAutoLoop(); }
function resumeMock(){ if(!state.started) return; state.paused=false; if(state.autoplay.enabled) startAutoLoop(); }

function overallToTeam(overall){
  const T=state.settings.teams;
  const r=Math.ceil(overall/T);
  const pos=overall-(r-1)*T;
  // odd rounds: 1..T; even rounds: T..1
  return (r%2===1) ? (pos-1) : (T - pos);
}
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
    advanceAfterPick(); // single source of truth to advance & render
  }, state.autoplay.delayMs);
}
function stopAutoLoop(){ if(state.autoplay.loopId) clearInterval(state.autoplay.loopId); state.autoplay.loopId=null; }

function nextPick(){
  if(!state.started){ alert("Start the draft first."); return; }
  const total=state.settings.teams*state.settings.rounds;
  if(state.currentOverall>total){ stopAutoLoop(); return; }

  const team = overallToTeam(state.currentOverall);

  if(team===state.myTeamIndex){
    const {list}=computeRecommendations(team);
    if(!list.length){ alert("No candidates available."); return; }
    draftPlayerById(list[0].id, team);
    advanceAfterPick();
    return;
  }

  // Force CPU one step
  aiPick(team);
  advanceAfterPick();
}

function autoUntilMyPick(){
  if(!state.started){ alert("Start the draft first."); return; }
  state.paused=false;
  while(overallToTeam(state.currentOverall)!==state.myTeamIndex){
    const total=state.settings.teams*state.settings.rounds; if(state.currentOverall>total) break;
    const team = overallToTeam(state.currentOverall);
    aiPick(team);
    advanceAfterPick(false); // batch; no render every loop
  }
  render();
}

function advanceAfterPick(shouldRender=true){
  state.currentOverall += 1;
  if (shouldRender) render();
}

function aiPick(teamIndex){
  const {list}=computeRecommendations(teamIndex);
  if(!list.length) return;

  // Optional simple biasing/stacking; kept light by default
  const bias = state.features.biases ? (state.biasMap[teamIndex+1] || "BAL") : "BAL";
  const weighted = list.slice(0,24).map(p=> ({
    ...p,
    biasScore: p.score + biasBoost(p, bias) + stackBonusForTeam(teamIndex, p)
  }));
  weighted.sort((a,b)=>b.biasScore-a.biasScore);

  // Weighted random among top K to vary CPU behavior
  const k=Math.min(7, weighted.length);
  const weights=Array.from({length:k},(_,i)=>(k-i));
  const sum=weights.reduce((a,b)=>a+b,0);
  let r=Math.random()*sum, pick=weighted[0];
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
  draftByIndex(poolIdx, teamIndex, /*incrementOverall*/false); // advance is centralized
}

function draftByIndex(poolIdx, teamIndex, incrementOverall=false){
  if(state.players[poolIdx].drafted) return;

  const idxAvail = state.available.indexOf(poolIdx);
  if(idxAvail!==-1) state.available.splice(idxAvail,1);

  state.players[poolIdx].drafted=true;

  const overall=state.currentOverall;
  const round=getRound(overall);
  const pir=pickInRound(overall);

  state.teamRosters[teamIndex].push(poolIdx);
  bumpRosterSlot(teamIndex, state.players[poolIdx].pos);

  state.draftPicks.push({overall, team:teamIndex, round, pickInRound:pir, playerIdx:poolIdx});

  // We do NOT advance here; advanceAfterPick() is the single source of truth.
  if(incrementOverall) state.currentOverall += 1; // (unused now; kept for safety)
}

function bumpRosterSlot(teamIndex,pos){
  const s=state.rosterSlots[teamIndex];
  if(!s) return;
  if(pos in s) s[pos]++; else s.BEN++;
}

function undoPick(){
  if(!state.draftPicks.length) return;
  const last=state.draftPicks.pop();
  const {playerIdx, team, overall}=last;

  state.players[playerIdx].drafted=false;
  if(!state.available.includes(playerIdx)) state.available.push(playerIdx);

  const r=state.teamRosters[team]; const ix=r.lastIndexOf(playerIdx);
  if(ix>=0) r.splice(ix,1);

  const pos=state.players[playerIdx].pos;
  if(pos in state.rosterSlots[team]) state.rosterSlots[team][pos]=Math.max(0, state.rosterSlots[team][pos]-1);

  // Reset overall back to the undone pick so you can re-pick
  state.currentOverall = overall;
  render();
}

// --------- Export ----------
function exportBoard(){
  const rows=[["overall","round","pickInRound","team","player","pos","teamAbbr","bye","ecr","adp","proj_ppr","tier"]];
  for(const p of [...state.draftPicks].sort((a,b)=>a.overall-b.overall)){
    const pl=state.players[p.playerIdx];
    rows.push([p.overall,p.round,p.pickInRound,p.team+1,pl.player,pl.pos,pl.team,pl.bye,pl.ecr,pl.adp,pl.proj_ppr,pl.tier]);
  }
  const csv=rows.map(r=>r.join(",")).join("\n");
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download="draft_board.csv"; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1500);
}

// --------- Recommendations / Scoring ----------
function computeRecommendations(teamIndex){
  const base = replacementLevels();
  const needs = rosterNeeds(teamIndex);

  let candidates = state.available.map(i=>state.players[i]);
  const posFilter=el("filterPos").value;
  const nameFilter=(el("searchName").value||"").toLowerCase();
  if(posFilter) candidates=candidates.filter(p=>p.pos===posFilter);
  if(nameFilter) candidates=candidates.filter(p=>p.player.toLowerCase().includes(nameFilter));

  const scored = candidates.map(p=>{
    const baseProj = state.dataFlags.hasProj ? (p.proj_ppr||0) : 0;
    const rep = state.dataFlags.hasProj ? (base[p.pos]||0) : 0;
    const vor = baseProj - rep;
    const tierBoost = (6 - Math.min(p.tier||6,6)) * 1.2; // T1 > T2 > ...
    const valueBoost = state.dataFlags.hasADP
      ? Math.min(Math.max(0,(p.adp||state.currentOverall)-state.currentOverall)/10, 8)
      : 0;
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
  const s=state.settings, T=s.teams, flexShare=s.flex;
  const counts={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te}, idxAt={};
  for(const pos of ["QB","RB","WR","TE"]){
    let N=T*counts[pos];
    if(pos!=="QB"){ N += Math.round(0.5*T*flexShare/3); } // share FLEX across RB/WR/TE
    idxAt[pos]=Math.max(N,1);
  }
  const baseline={};
  for(const pos of ["QB","RB","WR","TE"]){
    const pool=state.available.map(i=>state.players[i])
      .filter(p=>p.pos===pos)
      .sort((a,b)=>(b.proj_ppr||0)-(a.proj_ppr||0));
    const idx=Math.min(idxAt[pos]-1, Math.max(0,pool.length-1));
    baseline[pos]=pool[idx]? (pool[idx].proj_ppr||0):0;
  }
  return baseline;
}

function rosterNeeds(teamIndex){
  const s=state.settings, slots=state.rosterSlots[teamIndex]||{QB:0,RB:0,WR:0,TE:0,FLEX:0,BEN:0};
  const target={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te}, need={};
  for(const pos of ["QB","RB","WR","TE"]){
    const have=slots[pos]||0, left=Math.max(0,target[pos]-have);
    need[pos]=1+left*0.75; // more need => more weight
  }
  return need;
}

// --------- Rankings (always visible) ----------
function renderRankings(){
  const root = el("rankingsList"); if(!root) return;
  root.innerHTML = "";

  let list = state.available.map(i=>state.players[i]);
  const q = (el("rankingsSearch").value||"").toLowerCase();
  const pos = el("rankingsPos").value;
  if(q) list = list.filter(p=>p.player.toLowerCase().includes(q));
  if(pos) list = list.filter(p=>p.pos===pos);
  list.sort((a,b)=> (a.ecr??1e9) - (b.ecr??1e9));

  list.slice(0,500).forEach(p=>{
    const logo = teamLogoUrl(p.team);
    const adpBit = state.dataFlags.hasADP ? ` • ADP ${p.adp||"-"}` : "";
    const projBit = state.dataFlags.hasProj ? ` • Proj ${Number(p.proj_ppr||0).toFixed(1)}` : "";
    const ecr = (p.ecr!=null)? `#${p.ecr}` : "#—";
    const posRank = getPosRank(p);

    const d=document.createElement("div"); d.className="item";
    d.innerHTML = `<div class="flex">
      <div class="flex" style="gap:10px;">
        ${logo ? `<img src="${logo}" alt="${p.team||''}" class="team-logo">` : ""}
        <div>
          <div class="name">${p.player} <span class="badge pos ${p.pos}">${p.pos}${posRank?posRankLabel(p,posRank):""}</span> <span class="badge">${ecr}</span></div>
          <div class="small">${p.team||""} • Bye ${p.bye||"-"}${adpBit}${projBit}</div>
        </div>
      </div>
      <div><button data-id="${p.id}">Draft</button></div>
    </div>`;
    d.querySelector("button").onclick = ()=>{ 
      draftPlayerById(p.id, state.myTeamIndex); 
      advanceAfterPick();              // advance so CPU resumes
    };
    root.appendChild(d);
  });
}

// --------- Rendering ----------
function render(){
  renderBoard();
  renderRecs();
  renderMyRoster();
  renderScarcityBars();
  renderRankings();
}

function renderBoard(){
  const root=el("board"); root.innerHTML="";
  const picks = [...state.draftPicks].sort((a,b)=>a.overall-b.overall);

  if(state.boardView === "overall"){
    picks.forEach(p=> root.appendChild(boardPickElem(p)));
  } else {
    const byRound = new Map();
    picks.forEach(p=>{
      if(!byRound.has(p.round)) byRound.set(p.round, []);
      byRound.get(p.round).push(p);
    });
    Array.from(byRound.keys()).sort((a,b)=>a-b).forEach(r=>{
      const h = document.createElement("div");
      h.className = "round-header";
      h.textContent = `Round ${r}`;
      root.appendChild(h);
      byRound.get(r).forEach(p=> root.appendChild(boardPickElem(p)));
    });
  }
}

function boardPickElem(p){
  const pl=state.players[p.playerIdx];
  const logo = teamLogoUrl(pl.team);
  const posRank = getPosRank(pl);
  const div=document.createElement("div"); div.className="pick";
  div.innerHTML = `<div class="flex">
                     <span class="badge">#${p.overall} R${p.round}.${p.pickInRound}</span>
                     <span class="small">Team ${p.team+1}</span>
                   </div>
                   <div class="flex" style="justify-content:flex-start; gap:8px;">
                     ${logo ? `<img src="${logo}" alt="${pl.team||''}" class="team-logo">` : ""}
                     <div class="name">${pl.player}</div>
                   </div>
                   <div class="small">
                     <span class="badge pos ${pl.pos}">${pl.pos}${posRank?posRankLabel(pl,posRank):""}</span>
                     • ${pl.team||""} • Bye ${pl.bye||"-"} • ECR ${pl.ecr||"-"}
                   </div>`;
  return div;
}

// Recommendations (logos + full info)
function renderRecs(){
  const root=el("recs"); root.innerHTML="";
  if(!state.players.length){ root.textContent="Waiting for rankings..."; return; }

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
    const logo = teamLogoUrl(p.team);
    const adpBit = state.dataFlags.hasADP ? ` • ADP ${p.adp||"-"}` : "";
    const projBit = state.dataFlags.hasProj ? ` • Proj ${p.baseProj.toFixed(1)} (rep ${p.rep.toFixed(1)})` : "";
    const posRank = getPosRank(p);

    const d=document.createElement("div"); d.className="item";
    d.innerHTML = `<div class="flex">
        <div class="flex" style="gap:10px;">
          ${logo ? `<img src="${logo}" alt="${p.team||''}" class="team-logo">` : ""}
          <div>
            <div class="name">${p.player} <span class="badge tier t${t}">T${t}</span> <span class="badge pos ${p.pos}">${p.pos}${posRank?posRankLabel(p,posRank):""}</span></div>
            <div class="small">${p.team||""} • Bye ${p.bye||"-"} • ECR ${p.ecr||"-"}${projBit}${adpBit}</div>
          </div>
        </div>
        <div><button data-pick="${p.id}">Draft</button></div>
      </div>`;

    d.querySelector("button").onclick=()=>{ 
      draftPlayerById(p.id, state.myTeamIndex); 
      advanceAfterPick(); // advance so CPU resumes
    };
    root.appendChild(d);
  });
}

// --------- My Roster / Scarcity ----------
function renderMyRoster(){
  const root=el("myRoster"); root.innerHTML="";
  if(!state.teamRosters.length){ root.textContent="Start the draft to see your roster."; return; }

  const mine=state.teamRosters[state.myTeamIndex]||[];
  const players=mine.map(i=>state.players[i]);

  // Sort by ECR (best first) so starters fill with highest-ranked at each slot
  players.sort((a,b)=> (a.ecr??9999) - (b.ecr??9999));

  const slots = { QB: state.settings.qb, RB: state.settings.rb, WR: state.settings.wr, TE: state.settings.te };
  const starters = { QB:[], RB:[], WR:[], TE:[], FLEX:[] };
  const bench = [];

  for(const p of players){
    if(slots[p.pos] && starters[p.pos].length < slots[p.pos]){
      starters[p.pos].push(p);
    } else if ( (p.pos==="RB" || p.pos==="WR" || p.pos==="TE") && starters.FLEX.length < state.settings.flex ){
      starters.FLEX.push(p);
    } else {
      bench.push(p);
    }
  }

  const group=(label,arr)=>{
    const div=document.createElement("div"); div.innerHTML=`<div class="small">${label}</div>`;
    arr.forEach(pl=>{ const item=document.createElement("div"); item.className="small"; item.textContent=`${pl.player} (${pl.pos} • ${pl.team||""})`; div.appendChild(item); });
    root.appendChild(div);
  };

  group("QB", starters.QB);
  group("RB", starters.RB);
  group("WR", starters.WR);
  group("TE", starters.TE);
  if (state.settings.flex>0) group("FLEX", starters.FLEX);
  group("Bench", bench);
}

function renderScarcityBars(){
  show("scarcityWrap", state.features.scarcity);
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

// expose for debugging (optional)
// window._state = state;
