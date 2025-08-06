/* War Room — Team-wide BYE awareness
   - Global BYE indicator based on ALL starters
   - Player cards show BYE DUP badge if candidate shares any starter bye
   - Small AI penalty for team-wide bye duplication (in addition to same-position penalty)
   - Keeps: smarter AI (needs/scarcity/stacks/late-upside), stacks badge, shared filters,
            unified cards, instant starters, bench sorting, coverage indicator
*/

const DATA_URL = "./consensus.json";

/* ====== TUNABLE WEIGHTS ====== */
const WEIGHTS = {
  vor: 1.0,                 // value over replacement
  tierBoost: 1.0,           // favor earlier tiers
  valueVsADP: 0.8,          // ADP discount/steal potential

  need: 0.9,                // roster needs
  scarcity: 0.7,            // positional scarcity
  stackSynergy: 1.0,        // QB<->WR/TE stacks
  byePenalty: -0.5,         // same-position starter bye overlap penalty (existing)
  lateUpside: 0.6,          // late-round upside

lateRoundStartPct: 0.5,
deepRoundStartPct: 0.75
};

// Extra team-wide bye duplication penalty (applied when candidate shares any starter's bye)
const TEAM_WIDE_BYE_DUP_PENALTY = -1.5;

// How big of an ECR gap counts as a clear "upgrade" over your current starters
const UPGRADE_ECR_GAP = 5;

let state = {
@@ -99,10 +96,9 @@ function buildPosRankCache(){
});
}
function getPosRank(p){ const m = state.posRankCache[p.pos]; return m ? m.get(p.id ?? p.player) : undefined; }
// Return only numeric rank; we prepend position separately
function posRankLabel(rank) { return rank ? String(rank) : ""; }

// --- team/round helpers
function overallToTeam(overall){
const T=state.settings.teams; const r=Math.ceil(overall/T); const pos=overall-(r-1)*T;
return (r%2===1) ? (pos-1) : (T - pos);
@@ -136,14 +132,14 @@ function stackBonusForTeam(teamIndex, candidate){
const candTeam = normalizeTeam(candidate.team);
for(const pl of roster){
if(!pl || normalizeTeam(pl.team)!==candTeam) continue;
    if( (pl.pos==="QB" && (candidate.pos==="WR" || candidate.pos==="TE")) ||
(candidate.pos==="QB" && (pl.pos==="WR" || pl.pos==="TE")) ){ bonus += 6; }
else if (pl.pos===candidate.pos && (pl.pos==="WR" || pl.pos==="TE")) { bonus += 2; }
}
return bonus;
}

// Same-position bye penalty (existing behavior)
function byeOverlapPenalty(teamIndex, candidate){
const s = state.settings;
const startersTarget = { QB:s.qb, RB:s.rb, WR:s.wr, TE:s.te, K:s.k, DEF:s.def };
@@ -165,7 +161,7 @@ function byeOverlapPenalty(teamIndex, candidate){
return fillingLastStarter ? -3 : -1.5;
}

/* ===== NEW: team-wide starters + bye helpers ===== */
function startersByPosForTeam(teamIndex){
const s = state.settings;
const targets = { QB:s.qb, RB:s.rb, WR:s.wr, TE:s.te, K:s.k, DEF:s.def };
@@ -183,14 +179,30 @@ function startersAllForTeam(teamIndex){
const { starters, flex } = startersByPosForTeam(teamIndex);
return [...starters.QB, ...starters.RB, ...starters.WR, ...starters.TE, ...starters.K, ...starters.DEF, ...flex];
}
function teamByeStatus(startersAll){
  const byes = startersAll.map(p=>p?.bye).filter(b=>b!=null);
  const hasMissing = startersAll.some(p => p?.bye == null);
  const seen = new Set(); let dup=false;
  for(const b of byes){ if(seen.has(b)) { dup=true; break; } seen.add(b); }
  if (dup)        return { text:"BYE!", color:"#ef4444" };  // red
  if (hasMissing) return { text:"BYE?", color:"#f59e0b" };  // yellow
  return { text:"BYE✓", color:"#22c55e" };                  // green
}
function candidateSharesTeamBye(teamIndex, candidate){
if (!candidate.bye) return false;
@@ -556,7 +568,6 @@ function replacementLevels(){
} return baseline;
}

// robust shared filters
function applyFilters(list){
let out = list.slice();
const pos = (state.filters.pos || "").toUpperCase().trim();
@@ -566,7 +577,6 @@ function applyFilters(list){
return out;
}

/* ===== scoring with team-wide bye consideration & upgrade badge ===== */
function worstStarterEcrByPos(teamIndex){
const { starters } = startersByPosForTeam(teamIndex);
const worst = {};
@@ -585,8 +595,11 @@ function computeRecommendations(teamIndex){
candidates = applyFilters(candidates);

const pct = draftProgressPct();
  const worstEcr = worstStarterEcrByPos(state.myTeamIndex); // compare upgrades vs YOUR starters
  const myTeamIndex = state.myTeamIndex;

const scored = candidates.map(p=>{
const baseProj = state.dataFlags.hasProj ? (p.proj_ppr||0) : 0;
@@ -621,11 +634,14 @@ function computeRecommendations(teamIndex){
return p.ecr + UPGRADE_ECR_GAP < worst;
})();

    const sharesTeamBye = candidateSharesTeamBye(myTeamIndex, p);

return {...p, baseProj, rep, vor, score,
hasMyStack: hasPrimaryStackForMyTeam(p),
            upgradeForPos, sharesTeamBye };
});

scored.sort((a,b)=> b.score-a.score);
@@ -648,20 +664,18 @@ function playerCardHTML(p){
const upgradeBadge = p.upgradeForPos
? `<span class="badge" style="background:#22c55e1a;border:1px solid #22c55e;color:#22c55e;">Upgrade Available</span>`
: "";
  const byeDupBadge = p.sharesTeamBye
      ? `<span class="badge" style="background:#ef44441a;border:1px solid #ef4444;color:#ef4444;" title="Shares a bye week with one of your starters">BYE DUP</span>`
      : "";

return `<div class="flex">
     <div class="flex" style="gap:10px;">
       ${logo ? `<img src="${logo}" alt="${p.team||''}" class="team-logo">` : ""}
       <div>
          <div class="name">${p.player} ${stackBadge} ${upgradeBadge} ${byeDupBadge}
           <span class="badge tier t${t}">T${t}</span>
           <span class="badge pos ${p.pos}">${p.pos}${pr ? posRankLabel(pr) : ""}</span>
           <span class="badge">${ecrText}</span>
         </div>
          <div class="small">${p.team||""} • Bye ${p.bye||"-"}${adpBit}${projBit}</div>
       </div>
     </div>
     <div><button data-pid="${p.id}">Draft</button></div>
@@ -693,7 +707,7 @@ function boardPickElem(p){
                    ${logo ? `<img src="${logo}" alt="${pl.team||''}" class="team-logo">` : ""}
                    <div class="name">${pl.player}</div>
                  </div>
                   <div class="small"><span class="badge pos ${pl.pos}">${pl.pos}${pr ? posRankLabel(pr) : ""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"} • ECR ${pl.ecr||"-"}</div>`;
return div;
}

@@ -713,9 +727,13 @@ function renderMidPanel(){
let list = state.available.map(i=>state.players[i]);
list = applyFilters(list);
list.sort((a,b)=> (a.ecr??1e9) - (b.ecr??1e9));
list.slice(0,600).forEach(p=>{
      // for Full Rankings we still want to show BYE DUP if applicable
      p.sharesTeamBye = candidateSharesTeamBye(state.myTeamIndex, p);
const d=document.createElement("div"); d.className="item";
d.innerHTML = playerCardHTML(p);
d.querySelector("button").onclick = ()=>{ draftPlayerById(p.id, state.myTeamIndex); advanceAfterPick(); };
@@ -767,16 +785,12 @@ function renderMyRoster(){
return benchValue(b) - benchValue(a);
});

  // Global team-wide BYE badge for starters (across all)
const startersAll = [...starters.QB, ...starters.RB, ...starters.WR, ...starters.TE, ...starters.K, ...starters.DEF, ...starters.FLEX];
  const bye = teamByeStatus(startersAll);
  const rosterHeader = el("myRosterHeaderBadge");
  if (rosterHeader){
    rosterHeader.innerHTML = `<span style="border:1px solid ${bye.color};color:${bye.color};padding:2px 6px;border-radius:6px;margin-left:8px;font-size:12px;">${bye.text}</span>`;
  }

const section = (label, list, target, benchMode=false) => {
    // Positional coverage only (R/Y/G) — bye is global now
let headerBadges = "";
if (!benchMode){
const fill = list.length;
@@ -788,10 +802,12 @@ function renderMyRoster(){
wrap.innerHTML = `<div class="roster-header small">${label}${headerBadges}</div>`;
for(const pl of list){
const logo = teamLogoUrl(pl.team); const pr = getPosRank(pl); const ecr = (pl.ecr!=null) ? `#${pl.ecr}` : "#—";
const row = document.createElement("div"); row.className = "roster-item";
row.innerHTML = `${logo ? `<img src="${logo}" alt="${pl.team||''}" class="team-logo team-logo-sm">` : ""}
       <div class="roster-main"><div class="roster-name">${pl.player}</div>
        <div class="roster-meta"><span class="badge pos ${pl.pos}">${pl.pos}${pr ? posRankLabel(pr) : ""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"} • ECR ${ecr}</div></div>`;
wrap.appendChild(row);
}
if (!benchMode){
@@ -840,6 +856,6 @@ function boardPickElem(p){
const div=document.createElement("div"); div.className="pick";
div.innerHTML=`<div class="flex"><span class="badge">#${p.overall} R${p.round}.${p.pickInRound}</span><span class="small">Team ${p.team+1}</span></div>
 <div class="flex" style="justify-content:flex-start; gap:8px;">${logo?`<img src="${logo}" class="team-logo">`:""}<div class="name">${pl.player}</div></div>
  <div class="small"><span class="badge pos ${pl.pos}">${pl.pos}${pr ? posRankLabel(pr) : ""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"} • ECR ${pl.ecr||"-"}</div>`;
return div;
}
