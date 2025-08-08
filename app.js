/* ===========================================================
   Fantasy Football War Room — app.js (full)
   - Default tab: Full Rankings (visible pre-draft)
   - Manual vs Regular Draft Modes
   - Simple controls: Start Draft, Next Pick, Back One, Undo
   - Roster Viewer dropdown (view any team)
   - Recommendations engine (VOR when projections exist)
   - Bye-overlap dots (2=yellow, 3=orange, 4+=red)
   - Stack badge (QB<->WR/TE on same NFL team)
   - Draft ends when each team fills total roster spots (starters+bench)
   - Results modal with per-position and overall grades
   - CSV upload fallback for consensus data
   =========================================================== */

const DATA_URL = "./consensus.json";

/* ----------------------------- State ----------------------------- */

const state = {
  settings: {
    teams: 12,
    rounds: 16,
    pickPos: 5,           // 1-based
    scoring: "PPR",
    qb: 1, rb: 2, wr: 2, te: 1, flex: 1, k: 1, def: 1, bench: 8,
    manual: false         // Manual Draft Mode toggle (from UI or URL ?manual=1)
  },

  // pools
  players: [],            // full player objects
  available: [],          // indexes into players that are not drafted
  dataFlags: { hasProj:false, hasADP:false },

  // draft runtime
  started: false,
  currentOverall: 1,
  teamRosters: [],        // [teamIndex] -> [playerPoolIndex,...]
  rosterSlots: [],        // [teamIndex] -> counts per pos
  draftPicks: [],         // chronological picks

  // ui
  boardView: "overall",   // 'overall' | 'round'
  midTab: "ranks",        // 'ranks' (default) | 'recs'
  filters: { pos:"", q:"" },
  myTeamIndex: 0,         // derived from pickPos when draft starts
  viewTeamIndex: 0,       // roster viewer select
  posRankCache: {},

  // results modal
  results: null           // { rows:[...], meta:{...} } after finalize
};

/* ----------------------------- Utilities ----------------------------- */

const el = id => document.getElementById(id);

function normalizeTeam(abbr){
  if(!abbr) return "";
  const code = String(abbr).toUpperCase().trim();
  const map = { JAX:"JAC", LA:"LAR", WSH:"WAS", STL:"LAR", SD:"LAC" };
  return map[code] || code;
}
function normalizePos(pos){
  const p = String(pos||"").toUpperCase();
  if (p.startsWith("QB")) return "QB";
  if (p.startsWith("RB")) return "RB";
  if (p.startsWith("WR")) return "WR";
  if (p.startsWith("TE")) return "TE";
  if (p === "K" || p.startsWith("PK")) return "K";
  if (p === "DST" || p === "DEF" || p === "DSTDEF") return "DEF";
  return p;
}
function teamLogoUrl(abbr){
  const c = normalizeTeam(abbr);
  return c ? `https://static.www.nfl.com/league/api/clubs/logos/${c}.svg` : "";
}

function buildPosRankCache(){
  const cache = {};
  ["QB","RB","WR","TE","K","DEF"].forEach(pos=>{
    const arr = state.players.filter(p=>p.pos===pos && p.ecr!=null)
      .sort((a,b)=>(a.ecr)-(b.ecr));
    const m = new Map();
    arr.forEach((p,idx)=> m.set(p.id ?? p.player, idx+1));
    cache[pos] = m;
  });
  state.posRankCache = cache;
}
function getPosRank(p){
  const m = state.posRankCache[p.pos];
  return m ? m.get(p.id ?? p.player) : undefined;
}

/* ---- draft pick math ---- */
function overallToTeam(overall){
  const T = state.settings.teams;
  const r = Math.ceil(overall / T);
  const pos = overall - (r-1)*T;
  // snake
  return (r % 2 === 1) ? (pos-1) : (T - pos);
}
function getRound(overall){ return Math.ceil(overall / state.settings.teams); }
function pickInRound(overall){
  const r = getRound(overall), start=(r-1)*state.settings.teams+1;
  return overall - start + 1;
}

/* ---- starters helpers ---- */
function startersByPosForTeam(teamIndex){
  const s = state.settings;
  const targets = { QB:s.qb, RB:s.rb, WR:s.wr, TE:s.te, K:s.k, DEF:s.def };
  const idxs = (state.teamRosters[teamIndex]||[]);
  const roster = idxs.map(i=>state.players[i]).sort((a,b)=>(a.ecr??9999)-(b.ecr??9999));

  const starters = { QB:[], RB:[], WR:[], TE:[], K:[], DEF:[] };
  const flex = [];
  for(const p of roster){
    if (targets[p.pos] && starters[p.pos].length < targets[p.pos]) {
      starters[p.pos].push(p); continue;
    }
    if ((p.pos==="RB" || p.pos==="WR") && flex.length < s.flex) {
      flex.push(p); continue;
    }
  }
  return { starters, flex };
}
function startersAllForTeam(teamIndex){
  const {starters, flex} = startersByPosForTeam(teamIndex);
  return [...starters.QB, ...starters.RB, ...starters.WR, ...starters.TE, ...starters.K, ...starters.DEF, ...flex];
}

function teamTotalCapacity(){
  const s = state.settings;
  return s.qb + s.rb + s.wr + s.te + s.k + s.def + s.flex + s.bench;
}

/* ---- bye overlap dots ---- */
function byeOverlapCounts(players){
  const m = new Map();
  for(const p of players){ if (p?.bye == null) continue;
    m.set(p.bye, (m.get(p.bye)||0)+1);
  }
  return m;
}
function byeDotColor(count){
  if (count >= 4) return "#ef4444";
  if (count === 3) return "#f97316";
  if (count === 2) return "#f59e0b";
  return null;
}
function byeDotSpan(color){
  return color
    ? `<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${color};margin-left:6px;vertical-align:middle"></span>`
    : "";
}

/* ---- stacks ---- */
function hasPrimaryStackForMyTeam(candidate){
  const candTeam = normalizeTeam(candidate.team);
  if(!candTeam) return false;
  const idxs = state.teamRosters[state.myTeamIndex] || [];
  for(const i of idxs){
    const pl = state.players[i];
    if (!pl || normalizeTeam(pl.team)!==candTeam) continue;
    if ((candidate.pos==="QB" && (pl.pos==="WR"||pl.pos==="TE")) ||
        ((candidate.pos==="WR"||candidate.pos==="TE") && pl.pos==="QB")) return true;
  }
  return false;
}
function stackBonusForTeam(teamIndex, candidate){
  const candTeam = normalizeTeam(candidate.team);
  if(!candTeam) return 0;
  let bonus = 0;
  const roster = (state.teamRosters[teamIndex]||[]).map(i=>state.players[i]);
  for(const pl of roster){
    if(!pl || normalizeTeam(pl.team)!==candTeam) continue;
    if ((pl.pos==="QB" && (candidate.pos==="WR"||candidate.pos==="TE")) ||
        (candidate.pos==="QB" && (pl.pos==="WR"||pl.pos==="TE"))) bonus += 6;
    else if (pl.pos===candidate.pos && (pl.pos==="WR"||pl.pos==="TE")) bonus += 2;
  }
  return bonus;
}

/* ----------------------------- Data Load ----------------------------- */

async function loadConsensus(){
  const lastUpdatedEl = el("lastUpdated");
  try {
    const resp = await fetch(DATA_URL, { cache:"no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — consensus.json not found`);
    const data = await resp.json();
    if (!Array.isArray(data.players)) throw new Error("consensus.json missing 'players' array");

    ingestPlayers(data.players);
    lastUpdatedEl.textContent = `Last updated: ${data.updated_at || "unknown"} • players: ${state.players.length}`;
  } catch (e) {
    console.warn("Load consensus.json failed:", e);
    if (lastUpdatedEl) lastUpdatedEl.textContent = "Error loading data — falling back to CSV upload.";
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

  // First render of side lists even before the draft
  renderMidPanel();
}

/* CSV upload (optional) */
function initCsvUpload(){
  const input = el("csvInput");
  if (!input) return;
  input.addEventListener("change", (e)=>{
    const file = e.target.files?.[0]; if(!file) return;
    const r = new FileReader();
    r.onload = ()=>{
      const text = String(r.result || "");
      const { headers, rows } = csvToRows(text);
      const players = rows.map(rw => mapFantasyProsRow(headers, rw)).filter(Boolean);
      ingestPlayers(players);
      const label = el("dataSourceLabel"); if (label) label.textContent = "CSV (uploaded)";
      render();
    };
    r.readAsText(file);
  });

  const uploader = input.closest(".uploader");
  if (uploader){
    uploader.addEventListener("dragover", e=>{ e.preventDefault(); uploader.classList.add("drag"); });
    uploader.addEventListener("dragleave", ()=> uploader.classList.remove("drag"));
    uploader.addEventListener("drop", e=>{
      e.preventDefault(); uploader.classList.remove("drag");
      const file = e.dataTransfer.files?.[0];
      if (file) {
        const r = new FileReader();
        r.onload = ()=>{
          const text = String(r.result || "");
          const { headers, rows } = csvToRows(text);
          const players = rows.map(rw => mapFantasyProsRow(headers, rw)).filter(Boolean);
          ingestPlayers(players);
          const label = el("dataSourceLabel"); if (label) label.textContent = "CSV (uploaded)";
          render();
        };
        r.readAsText(file);
      }
    });
  }
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
      if(c==='"'){ inQ=false; i++; continue; }
      cur+=c; i++; continue;
    }else{
      if(c==='"'){ inQ=true; i++; continue; }
      if(c===','){ pushCell(); i++; continue; }
      if(c==='\r'){ i++; continue; }
      if(c==='\n'){ pushCell(); pushRow(); i++; continue; }
      cur+=c; i++; continue;
    }
  }
  if(cur.length>0 || row.length){ pushCell(); pushRow(); }
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

/* ----------------------------- Draft Engine ----------------------------- */

function syncSettingsFromUI(){
  const s = state.settings;

  const g = id => el(id);
  const num = id => +g(id).value || 0;
  const val = id => g(id).value;

  if (g("teams"))     s.teams = Math.max(2, num("teams"));
  if (g("rounds"))    s.rounds = Math.max(1, num("rounds"));
  if (g("pickPos"))   s.pickPos = Math.max(1, num("pickPos"));
  if (g("scoring"))   s.scoring = val("scoring");

  if (g("qbSlots"))   s.qb = Math.max(0, num("qbSlots"));
  if (g("rbSlots"))   s.rb = Math.max(0, num("rbSlots"));
  if (g("wrSlots"))   s.wr = Math.max(0, num("wrSlots"));
  if (g("teSlots"))   s.te = Math.max(0, num("teSlots"));
  if (g("flexSlots")) s.flex = Math.max(0, num("flexSlots"));
  if (g("kSlots"))    s.k = Math.max(0, num("kSlots"));
  if (g("defSlots"))  s.def = Math.max(0, num("defSlots"));
  if (g("benchSlots"))s.bench = Math.max(0, num("benchSlots"));

  // manual mode may be a checkbox in League Settings or a URL param
  const manualEl = g("manualMode");
  if (manualEl) s.manual = !!manualEl.checked;
}

function startDraft(){
  if (!state.players.length){
    alert("Load players first (consensus.json or upload CSV).");
    return;
  }
  syncSettingsFromUI();

  state.myTeamIndex = state.settings.pickPos - 1;
  const T = state.settings.teams;

  state.teamRosters = Array.from({length:T}, ()=>[]);
  state.rosterSlots = Array.from({length:T}, ()=>({QB:0,RB:0,WR:0,TE:0,K:0,DEF:0,BEN:0}));
  state.draftPicks = [];
  state.currentOverall = 1;
  state.started = true;
  state.viewTeamIndex = state.myTeamIndex;
  state.results = null;

  populateRosterViewer();
  render();
}

function backOne(){ undoPick(); }
function undoPick(){
  if(!state.draftPicks.length) return;
  const last = state.draftPicks.pop();
  const { playerIdx, team, overall } = last;

  state.players[playerIdx].drafted = false;
  if(!state.available.includes(playerIdx)) state.available.push(playerIdx);

  const r = state.teamRosters[team];
  const ix = r.lastIndexOf(playerIdx);
  if (ix>=0) r.splice(ix,1);

  const pos = state.players[playerIdx].pos;
  if (pos in state.rosterSlots[team])
    state.rosterSlots[team][pos] = Math.max(0, state.rosterSlots[team][pos]-1);
  else
    state.rosterSlots[team].BEN = Math.max(0, state.rosterSlots[team].BEN-1);

  state.currentOverall = overall;
  state.results = null;
  render();
}

function nextPick(){
  if(!state.started){ alert("Start the draft first."); return; }
  const total = state.settings.teams * state.settings.rounds;
  if (state.currentOverall > total) return;

  const team = overallToTeam(state.currentOverall);

  // In Regular mode: if it's not my pick, auto-pick for that team.
  // If it's my pick, auto-pick best rec for me.
  // In Manual mode: Next Pick always auto-picks best rec for the team on the clock.
  const { list } = computeRecommendations(team);
  if (!list.length){
    advanceAfterPick(true); // nothing to pick (shouldn't happen), but advance to avoid lock
    return;
  }
  draftPlayerById(list[0].id, team);
  advanceAfterPick(true);
}

function advanceAfterPick(shouldRender){
  state.currentOverall += 1;
  if (shouldRender) render();
  // Check completion
  if (isDraftComplete()){
    finalizeDraft();
  }
}

function draftPlayerById(id, teamIndex){
  const poolIdx = state.players.findIndex(p=>p.id===id);
  if (poolIdx===-1) return;
  draftByIndex(poolIdx, teamIndex);
}
function draftByIndex(poolIdx, teamIndex){
  const p = state.players[poolIdx];
  if (!p || p.drafted) return;

  // mark drafted & remove from available
  p.drafted = true;
  const avIx = state.available.indexOf(poolIdx);
  if (avIx>=0) state.available.splice(avIx,1);

  // add to team roster
  state.teamRosters[teamIndex].push(poolIdx);
  bumpRosterSlot(teamIndex, p.pos);

  // record pick
  const overall = state.currentOverall;
  const round = getRound(overall);
  const pir = pickInRound(overall);
  state.draftPicks.push({ overall, team:teamIndex, round, pickInRound:pir, playerIdx:poolIdx });
}

function bumpRosterSlot(teamIndex,pos){
  const s = state.rosterSlots[teamIndex]; if(!s) return;
  if (pos in s) s[pos]++; else s.BEN++;
}

/* ----------------------------- Recommendations ----------------------------- */

const WEIGHTS = {
  vor: 1.0,
  tierBoost: 1.0,
  valueVsADP: 0.8,
  need: 0.9,
  scarcity: 0.7,
  stackSynergy: 1.0,
  byePenalty: -0.4,
  lateUpside: 0.6,
  lateRoundStartPct: 0.5,
  deepRoundStartPct: 0.75
};
const UPGRADE_ECR_GAP = 5;
const TEAM_WIDE_BYE_DUP_PENALTY = -1.0;

function replacementLevels(){
  if(!state.dataFlags.hasProj){ return {QB:0,RB:0,WR:0,TE:0,K:0,DEF:0}; }
  const s=state.settings, T=s.teams, flexShare=s.flex;
  const counts={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te,K:s.k,DEF:s.def}, idxAt={};
  for(const pos of ["QB","RB","WR","TE","K","DEF"]){
    let N=T*counts[pos];
    if(pos==="RB" || pos==="WR"){ N += Math.round(T * (0.5*flexShare)); } // FLEX is W/R
    idxAt[pos]=Math.max(N,1);
  }
  const baseline={};
  for(const pos of ["QB","RB","WR","TE","K","DEF"]){
    const pool=state.available.map(i=>state.players[i]).filter(p=>p.pos===pos)
      .sort((a,b)=>(b.proj_ppr||0)-(a.proj_ppr||0));
    const idx=Math.min(idxAt[pos]-1, Math.max(0,pool.length-1));
    baseline[pos]=pool[idx]? (pool[idx].proj_ppr||0) : 0;
  }
  return baseline;
}

function computeScarcityBoost(p){
  const total = state.players.filter(x=>x.pos===p.pos).length;
  const remain = state.available.map(i=>state.players[i]).filter(x=>x.pos===p.pos).length;
  if(total===0) return 0;
  const pctRemain = remain/total;
  const scarcity = 1 - pctRemain;
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
function draftProgressPct(){
  const total = state.settings.teams * state.settings.rounds;
  return Math.min(1, (state.currentOverall-1)/Math.max(1,total));
}
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
  let candidates = state.available.map(i=>state.players[i]);
  candidates = applyFilters(candidates);

  const base = replacementLevels();
  const needs = rosterNeeds(teamIndex);
  const worstEcr = worstStarterEcrByPos(state.myTeamIndex);
  const pct = draftProgressPct();

  // current my-team bye counts for dot simulation
  const myStartersNow = startersAllForTeam(state.myTeamIndex);
  const countsNow = byeOverlapCounts(myStartersNow);

  const scored = candidates.map(p=>{
    const baseProj = state.dataFlags.hasProj ? (p.proj_ppr||0) : 0;
    const rep = state.dataFlags.hasProj ? (base[p.pos]||0) : 0;
    const vor = baseProj - rep; // value over replacement

    const tierBoost = (6 - Math.min(p.tier||6,6));
    const valueBoost = state.dataFlags.hasADP ? Math.max(0,(p.adp||state.currentOverall)-state.currentOverall)/10 : 0;

    const needW = (needs[p.pos]||1.0);
    const scarcity = computeScarcityBoost(p);
    const stackSynergy = stackBonusForTeam(teamIndex, p);
    const teamByeDup = sharesTeamBye(teamIndex, p) ? TEAM_WIDE_BYE_DUP_PENALTY : 0;
    const upside = lateRoundUpsideBonus(p);

    let score =
      WEIGHTS.vor * (state.dataFlags.hasProj ? vor : 0) +
      WEIGHTS.tierBoost * tierBoost +
      WEIGHTS.valueVsADP * valueBoost +
      WEIGHTS.need * needW +
      WEIGHTS.scarcity * scarcity +
      WEIGHTS.stackSynergy * stackSynergy +
      teamByeDup +
      WEIGHTS.lateUpside * upside;

    // de-emphasize K/DEF early
    if ((p.pos==="K" || p.pos==="DEF") && pct < 0.6) score -= 3*(0.6-pct);

    const upgradeForPos = (() => {
      const worst = worstEcr[p.pos];
      if (worst==null || p.ecr==null) return false;
      return p.ecr + UPGRADE_ECR_GAP < worst;
    })();

    const resulting = (p.bye!=null) ? ((countsNow.get(p.bye) || 0) + 1) : 0;
    const byeWarnColor = byeDotColor(resulting);

    return { ...p, baseProj, rep, vor, score,
      hasMyStack: hasPrimaryStackForMyTeam(p),
      upgradeForPos,
      byeWarnColor
    };
  });

  scored.sort((a,b)=> b.score-a.score);
  return { list: scored.slice(0, 200), baseline: base, needs };
}

function sharesTeamBye(teamIndex, candidate){
  if (!candidate.bye) return false;
  const starters = startersAllForTeam(teamIndex);
  return starters.some(p => (p?.bye||-1) === candidate.bye);
}

function applyFilters(list){
  let out = list.slice();
  const pos = (state.filters.pos||"").toUpperCase().trim();
  const q = (state.filters.q||"").toLowerCase().trim();
  if (pos) out = out.filter(p => (p.pos||"").toUpperCase().trim() === pos);
  if (q)   out = out.filter(p => (p.player||"").toLowerCase().includes(q));
  return out;
}

/* ----------------------------- Grading ----------------------------- */

function isDraftComplete(){
  const cap = teamTotalCapacity();
  return state.teamRosters.every(arr => arr.length >= cap);
}

function finalizeDraft(){
  // Build per-team features
  const T = state.settings.teams;
  const metrics = []; // {team, qb, rb, wr, te, flex, k, def, bench, overall}

  function sumValue(players){
    // use ECR as value proxy (lower ECR -> higher value)
    // value = 300 - ecr (floor at 0)
    return players.reduce((acc,p)=> acc + Math.max(0, 300 - (p.ecr ?? 300)), 0);
  }

  for(let t=0;t<T;t++){
    const idxs = state.teamRosters[t] || [];
    const roster = idxs.map(i=>state.players[i]).sort((a,b)=>(a.ecr??9999)-(b.ecr??9999));
    const { starters, flex } = startersByPosForTeam(t);

    const bench = roster.filter(p => !starters.QB.includes(p)
      && !starters.RB.includes(p)
      && !starters.WR.includes(p)
      && !starters.TE.includes(p)
      && !starters.K.includes(p)
      && !starters.DEF.includes(p)
      && !flex.includes(p));

    const m = {
      team: t,
      qb:   sumValue(starters.QB),
      rb:   sumValue(starters.RB),
      wr:   sumValue(starters.WR),
      te:   sumValue(starters.TE),
      flex: sumValue(flex),
      k:    sumValue(starters.K),
      def:  sumValue(starters.DEF),
      bench:sumValue(bench)
    };
    m.overall = m.qb + m.rb + m.wr + m.te + m.flex + m.k + m.def + 0.25*m.bench;
    metrics.push(m);
  }

  // Convert to letter grades by z-scores
  function zScore(arr, key){
    const vals = arr.map(x=>x[key]);
    const mean = vals.reduce((a,b)=>a+b,0)/Math.max(1,vals.length);
    const sd = Math.sqrt(vals.reduce((a,b)=> a + (b-mean)*(b-mean),0) / Math.max(1,vals.length));
    return arr.map(x => ({ team:x.team, z: sd ? ((x[key]-mean)/sd) : 0 }));
  }
  function zToGrade(z){
    if (z >= 1.0) return "A";
    if (z >= 0.5) return "B";
    if (z >= -0.5) return "C";
    if (z >= -1.0) return "D";
    return "F";
  }

  const cols = ["qb","rb","wr","te","flex","k","def","bench","overall"];
  const zmap = {};
  for(const c of cols){
    zmap[c] = new Map(zScore(metrics, c).map(o=>[o.team,o.z]));
  }

  const rows = metrics.map(m => ({
    team: m.team,
    grades: {
      qb: zToGrade(zmap.qb.get(m.team)),
      rb: zToGrade(zmap.rb.get(m.team)),
      wr: zToGrade(zmap.wr.get(m.team)),
      te: zToGrade(zmap.te.get(m.team)),
      flex: zToGrade(zmap.flex.get(m.team)),
      k: zToGrade(zmap.k.get(m.team)),
      def: zToGrade(zmap.def.get(m.team)),
      bench: zToGrade(zmap.bench.get(m.team)),
      overall: zToGrade(zmap.overall.get(m.team))
    }
  }));

  state.results = { rows, meta:{ when: new Date().toISOString() } };
  showResultsModal();
}

/* ----------------------------- Rendering ----------------------------- */

function render(){ renderBoard(); renderMidPanel(); renderRoster(); updateDraftHelpText(); }

function updateDraftHelpText(){
  // Optional: show a small one-liner context under Draft Controls (handled in HTML markup already)
}

function renderBoard(){
  const root = el("board"); if(!root) return;
  root.innerHTML = "";

  const picks = [...state.draftPicks].sort((a,b)=>a.overall-b.overall);
  if (!picks.length){
    const hint = document.createElement("div");
    hint.className = "board-empty-hint small";
    hint.textContent = "No picks yet. Start the draft and make your first selection.";
    root.appendChild(hint);
    return;
  }

  if (state.boardView === "overall"){
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
  const pl = state.players[p.playerIdx];
  const logo = teamLogoUrl(pl.team);
  const pr = getPosRank(pl);

  const div = document.createElement("div");
  div.className = "pick";
  div.innerHTML = `
    <div class="flex">
      <span class="badge tiny">#${p.overall} R${p.round}.${p.pickInRound}</span>
      <span class="tiny muted">Team ${p.team+1}</span>
    </div>
    <div class="flex" style="justify-content:flex-start; gap:8px;">
      ${logo ? `<img src="${logo}" alt="${pl.team||''}" class="team-logo">` : ""}
      <div class="name">${pl.player}</div>
    </div>
    <div class="small">
      <span class="badge pos ${pl.pos}">${pl.pos}${pr ? pr : ""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"}
    </div>`;
  return div;
}

function renderMidPanel(){
  const root = el("midList"); if(!root) return;
  root.innerHTML = "";

  const countsNow = byeOverlapCounts(startersAllForTeam(state.myTeamIndex));

  if (state.midTab === "recs"){
    if (!state.started){
      const info = document.createElement("div");
      info.className = "board-empty-hint small";
      info.textContent = "Start the draft to see live recommendations.";
      root.appendChild(info);
      return;
    }
    const team = overallToTeam(state.currentOverall);
    const { list } = computeRecommendations(team);
    list.slice(0, 100).forEach(p=>{
      const d = document.createElement("div");
      d.className = "item";
      d.innerHTML = playerCardHTML(p, countsNow);
      const btn = d.querySelector("button");
      btn.disabled = !state.started;
      btn.onclick = ()=> onDraftButton(p.id);
      root.appendChild(d);
    });
  } else {
    // Full Rankings (default — shown pre-draft)
    let list = state.available.map(i=>state.players[i]);
    list = applyFilters(list);
    list.sort((a,b)=> (a.ecr??9999) - (b.ecr??9999));
    list.slice(0, 400).forEach(p=>{
      const resulting = (p.bye!=null) ? ((countsNow.get(p.bye)||0)+1) : 0;
      const byeWarnColor = byeDotColor(resulting);
      const row = { ...p, byeWarnColor,
        hasMyStack: hasPrimaryStackForMyTeam(p),
        baseProj:p.proj_ppr||0, rep:0, vor:0, upgradeForPos:false
      };
      const d = document.createElement("div");
      d.className = "item";
      d.innerHTML = playerCardHTML(row, countsNow);
      const btn = d.querySelector("button");
      btn.disabled = !state.started;
      btn.onclick = ()=> onDraftButton(p.id);
      root.appendChild(d);
    });
  }
}

function playerCardHTML(p /* scored */, countsNow){
  const logo = teamLogoUrl(p.team);
  const pr = getPosRank(p);
  const t  = p.tier || 6;
  const ecrText = (p.ecr!=null)? `#${p.ecr}` : "#—";
  const adpBit  = state.dataFlags.hasADP ? ` • ADP ${p.adp||"-"}` : "";

  const byeDot = p.byeWarnColor ? byeDotSpan(p.byeWarnColor) : "";
  const stackBadge = (p.hasMyStack) ? `<span class="badge stack" title="Stacks with your roster">🔗 STACK</span>` : "";
  const upgradeBadge = p.upgradeForPos
      ? `<span class="badge" style="background:#22c55e1a;border:1px solid #22c55e;color:#22c55e;">Upgrade</span>`
      : "";

  return `<div class="flex">
    <div class="flex" style="gap:10px;">
      ${logo ? `<img src="${logo}" alt="${p.team||''}" class="team-logo">` : ""}
      <div>
        <div class="name">${p.player} ${stackBadge} ${upgradeBadge}
          <span class="badge tier t${t}">T${t}</span>
          <span class="badge pos ${p.pos}">${p.pos}${pr ? pr : ""}</span>
          <span class="badge">${ecrText}</span>
        </div>
        <div class="small">${p.team||""} • Bye ${p.bye||"-"} ${byeDot}${adpBit}</div>
      </div>
    </div>
    <div><button class="btn-draft" data-pid="${p.id}">Draft</button></div>
  </div>`;
}

function onDraftButton(playerId){
  if (!state.started){
    alert("Start the draft first.");
    return;
  }
  const team = overallToTeam(state.currentOverall);
  // In Regular mode: you can only draft on your turn (or Next Pick to auto)
  if (!state.settings.manual && team !== state.myTeamIndex){
    alert("It's not your turn. Use Next Pick or wait for your turn.");
    return;
  }
  draftPlayerById(playerId, team);
  advanceAfterPick(true);
}

/* ---- roster ---- */

function renderRoster(){
  const root = el("myRoster"); if(!root) return;
  root.innerHTML = "";

  const t = state.viewTeamIndex ?? state.myTeamIndex;

  const idxs = (state.teamRosters[t] || []);
  const mine = idxs.map(i=>state.players[i]).sort((a,b)=>(a.ecr ?? 9999) - (b.ecr ?? 9999));

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

  // coverage pills
  const coveragePill = (fill, target)=>{
    let cls="coverage";
    if (target<=0) cls+="";
    else if (fill<=0) cls+=" bad";
    else if (fill<target) cls+=" warn";
    else cls+=" ok";
    return `<span class="${cls}">${Math.min(fill,target)}/${target}</span>`;
  };

  // build sections
  const section = (label, list, target, benchMode=false) => {
    const wrap = document.createElement("div");
    wrap.className = "roster-section";
    const fill = list.length;
    const pill = benchMode ? "" : coveragePill(fill, target);
    wrap.innerHTML = `<div class="roster-header small">${label} ${pill}</div>`;
    for(const pl of list){
      const logo = teamLogoUrl(pl.team);
      const pr = getPosRank(pl);
      const dotColor = (pl.bye!=null)
        ? byeDotColor( (byeOverlapCounts(startersAllForTeam(t)).get(pl.bye)||0) )
        : null;
      const dot = byeDotSpan(dotColor);
      const row = document.createElement("div");
      row.className = "roster-item";
      row.innerHTML = `${logo? `<img src="${logo}" class="team-logo team-logo-sm" alt="${pl.team||''}">`:""}
        <div class="roster-main">
          <div class="roster-name">${pl.player}</div>
          <div class="roster-meta"><span class="badge pos ${pl.pos}">${pl.pos}${pr?pr:""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"} ${dot} • ECR ${pl.ecr!=null?("#"+pl.ecr):"#—"}</div>
        </div>`;
      wrap.appendChild(row);
    }
    // empty slots
    const lim = benchMode ? state.settings.bench : target;
    for(let i=list.length;i<lim;i++){
      const empty = document.createElement("div");
      empty.className = "roster-item slot-empty";
      empty.innerHTML = `<div class="slot-dot"></div>
        <div class="roster-main">
          <div class="roster-name muted">Empty ${label} Slot</div>
          <div class="roster-meta muted">—</div>
        </div>`;
      wrap.appendChild(empty);
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

/* ---- roster viewer select ---- */
function populateRosterViewer(){
  const sel = el("rosterViewer");
  if(!sel) return;
  sel.innerHTML = "";
  const T = state.settings.teams;
  for(let i=0;i<T;i++){
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = (i===state.myTeamIndex) ? `Team ${i+1} (You)` : `Team ${i+1}`;
    sel.appendChild(opt);
  }
  sel.value = String(state.viewTeamIndex ?? state.myTeamIndex);
}

/* ----------------------------- Results Modal ----------------------------- */

function showResultsModal(){
  const modal = el("resultsModal");
  const body = el("resultsBody");
  const title = el("resultsTitle");
  if (!modal || !body || !state.results) return;

  const rows = state.results.rows.slice().sort((a,b)=> a.team - b.team);

  title.textContent = "Draft Results & Grades";

  let html = `<table class="results-table">
    <thead><tr>
      <th>Team</th>
      <th>QB</th><th>RB</th><th>WR</th><th>TE</th><th>FLEX</th><th>K</th><th>DEF</th><th>Bench</th><th>Overall</th>
    </tr></thead><tbody>`;

  for(const r of rows){
    const g = r.grades;
    const cls = letter => `grade-${letter}`;
    html += `<tr>
      <td>Team ${r.team+1}${r.team===state.myTeamIndex?" (You)":""
      }</td>
      <td class="${cls(g.qb)}">${g.qb}</td>
      <td class="${cls(g.rb)}">${g.rb}</td>
      <td class="${cls(g.wr)}">${g.wr}</td>
      <td class="${cls(g.te)}">${g.te}</td>
      <td class="${cls(g.flex)}">${g.flex}</td>
      <td class="${cls(g.k)}">${g.k}</td>
      <td class="${cls(g.def)}">${g.def}</td>
      <td class="${cls(g.bench)}">${g.bench}</td>
      <td class="${cls(g.overall)}"><strong>${g.overall}</strong></td>
    </tr>`;
  }
  html += `</tbody></table>`;

  body.innerHTML = html;
  modal.classList.remove("hidden");
}
function hideResultsModal(){
  const modal = el("resultsModal");
  if (modal) modal.classList.add("hidden");
}

/* ----------------------------- UI Wiring ----------------------------- */

function init(){
  // querystring manual override ?manual=1
  try {
    const url = new URL(location.href);
    const param = url.searchParams.get("manual");
    if (param != null) state.settings.manual = (param === "1" || param === "true");
  } catch {}

  // load data & csv
  loadConsensus();
  initCsvUpload();

  // set defaults
  state.boardView = "overall";
  state.midTab = "ranks"; // Full Rankings first
  persistTabButtons();
  persistSubtabButtons();

  // League setting changes
  ["teams","rounds","pickPos","scoring","qbSlots","rbSlots","wrSlots","teSlots","flexSlots","kSlots","defSlots","benchSlots","manualMode"]
    .forEach(id => el(id)?.addEventListener("input", ()=>{
      syncSettingsFromUI();
      // If draft not started, keep roster viewer synthetic (only after start it fills)
    }));

  // draft controls
  el("startDraft")?.addEventListener("click", startDraft);
  el("nextPick")?.addEventListener("click", nextPick);
  el("backOne")?.addEventListener("click", backOne);
  el("undo")?.addEventListener("click", undoPick);

  // board tabs
  el("tabOverall")?.addEventListener("click", ()=>{ state.boardView="overall"; persistTabButtons(); renderBoard(); });
  el("tabByRound")?.addEventListener("click", ()=>{ state.boardView="round";   persistTabButtons(); renderBoard(); });

  // mid subtabs
  el("subtabRanks")?.addEventListener("click", ()=>{ state.midTab="ranks"; persistSubtabButtons(); renderMidPanel(); });
  el("subtabRecs")?.addEventListener("click", ()=>{ state.midTab="recs";  persistSubtabButtons(); renderMidPanel(); });

  // filters
  el("filterPos")?.addEventListener("change", (e)=>{
    state.filters.pos = String(e.target.value||"").toUpperCase().trim();
    renderMidPanel();
  });
  el("searchName")?.addEventListener("input", (e)=>{
    state.filters.q = e.target.value || "";
    renderMidPanel();
  });

  // roster viewer
  el("rosterViewer")?.addEventListener("change", (e)=>{
    const v = Number(e.target.value);
    if (!Number.isNaN(v)) { state.viewTeamIndex = v; renderRoster(); }
  });

  // modal buttons
  el("closeResults")?.addEventListener("click", hideResultsModal);

  render();
}

function persistTabButtons(){
  el("tabOverall")?.classList.toggle("active", state.boardView==="overall");
  el("tabByRound")?.classList.toggle("active", state.boardView==="round");
}
function persistSubtabButtons(){
  el("subtabRanks")?.classList.toggle("active", state.midTab==="ranks");
  el("subtabRecs")?.classList.toggle("active", state.midTab==="recs");
}

/* ----------------------------- Start ----------------------------- */
document.addEventListener("DOMContentLoaded", init);
