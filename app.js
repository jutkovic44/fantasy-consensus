/* ============================================================
   Fantasy Football War Room — app.js (full, unabridged)
   ============================================================ */

/* ---------- Config & constants ---------- */
const DATA_URL = "./consensus.json";

/** Tunable recommendation weights (kept sensible). */
const WEIGHTS = {
  vor: 1.0,
  tierBoost: 1.0,
  valueVsADP: 0.8,

  need: 0.9,
  scarcity: 0.7,
  stackSynergy: 1.0,
  byePenalty: -0.35, // tiny nudge
  lateUpside: 0.5,

  lateRoundStartPct: 0.5,
  deepRoundStartPct: 0.75
};

const TEAM_WIDE_BYE_DUP_PENALTY = -1.0;
const UPGRADE_ECR_GAP = 5;

/* ---------- App state ---------- */
let state = {
  settings: {
    teams: 12,
    rounds: 16,
    pickPos: 5,
    scoring: "PPR",
    qb: 1, rb: 2, wr: 2, te: 1, flex: 1, k: 1, def: 1, bench: 8,
    manualMode: false
  },

  // Data
  players: [],
  available: [],            // indexes of players array that are undrafted
  draftPicks: [],           // [{overall, round, pickInRound, team, playerIdx}]
  currentOverall: 1,

  // Draft / teams
  myTeamIndex: 0,
  teamRosters: [],          // array of arrays of player indexes
  rosterSlots: [],          // quick counters per team: {QB,RB,WR,TE,FLEX,K,DEF,BEN}
  started: false,
  paused: false,

  // UX
  features: { stack: true },
  dataFlags: { hasProj: false, hasADP: false },
  boardView: "overall",
  midTab: "ranks",          // <- default Full Rankings tab BEFORE draft
  filters: {
    pos: "",
    q: ""
  },

  posRankCache: {},
  dataSource: "consensus.json"
};

/* ---------- DOM helpers ---------- */
const el = (id) => document.getElementById(id);
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

/* ---------- Normalizers ---------- */
function normalizeTeam(abbr) {
  if (!abbr) return "";
  const code = String(abbr).toUpperCase().trim();
  const map = { JAX: "JAC", LA: "LAR", WSH: "WAS", STL: "LAR", SD: "LAC" };
  return map[code] || code;
}
function normalizePos(pos) {
  const p = String(pos || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (p.startsWith("QB")) return "QB";
  if (p.startsWith("RB")) return "RB";
  if (p.startsWith("WR")) return "WR";
  if (p.startsWith("TE")) return "TE";
  if (p === "K" || p.startsWith("PK")) return "K";
  if (p === "DST" || p === "DEF" || p === "DSTDEF") return "DEF";
  return p;
}
function teamLogoUrl(abbr) {
  const c = normalizeTeam(abbr);
  return c ? `https://static.www.nfl.com/league/api/clubs/logos/${c}.svg` : "";
}

/* ---------- Position rank cache ---------- */
function buildPosRankCache() {
  state.posRankCache = {};
  ["QB","RB","WR","TE","K","DEF"].forEach(pos => {
    const arr = state.players.filter(p => p.pos === pos && p.ecr != null)
      .sort((a,b) => (a.ecr) - (b.ecr));
    const map = new Map();
    arr.forEach((p, idx) => map.set(p.id ?? p.player, idx+1));
    state.posRankCache[pos] = map;
  });
}
function getPosRank(p) {
  const m = state.posRankCache[p.pos]; 
  return m ? m.get(p.id ?? p.player) : undefined;
}
function posRankLabel(rank) { return rank ? String(rank) : ""; }

/* ---------- Draft math ---------- */
function overallToTeam(overall) {
  const T = state.settings.teams;
  const r = Math.ceil(overall / T);
  const pos = overall - (r-1)*T;
  return (r % 2 === 1) ? (pos-1) : (T - pos);
}
function getRound(overall) { return Math.ceil(overall / state.settings.teams); }
function pickInRound(overall) {
  const r = getRound(overall);
  const start = (r-1)*state.settings.teams + 1;
  return overall - start + 1;
}
function draftProgressPct() {
  const total = state.settings.teams * state.settings.rounds;
  return Math.min(1, (state.currentOverall-1) / Math.max(1, total));
}

/* ---------- Stacks / bye / needs ---------- */
function hasPrimaryStackForMyTeam(candidate) {
  const rosterIdxs = state.teamRosters[state.myTeamIndex] || [];
  const candTeam = normalizeTeam(candidate.team);
  if (!candTeam || !rosterIdxs.length) return false;
  for (const idx of rosterIdxs) {
    const pl = state.players[idx];
    if (!pl || normalizeTeam(pl.team) !== candTeam) continue;
    if ((candidate.pos === "QB" && (pl.pos === "WR" || pl.pos === "TE")) ||
        ((candidate.pos === "WR" || candidate.pos === "TE") && pl.pos === "QB")) {
      return true;
    }
  }
  return false;
}
function stackBonusForTeam(teamIndex, candidate) {
  if (!state.features.stack) return 0;
  const roster = (state.teamRosters[teamIndex] || []).map(i => state.players[i]);
  let bonus = 0;
  const candTeam = normalizeTeam(candidate.team);
  for (const pl of roster) {
    if (!pl || normalizeTeam(pl.team) !== candTeam) continue;
    if ((pl.pos === "QB" && (candidate.pos === "WR" || pl.pos === "TE")) ||
        (candidate.pos === "QB" && (pl.pos === "WR" || pl.pos === "TE"))) { bonus += 6; }
    else if (pl.pos === candidate.pos && (pl.pos === "WR" || pl.pos === "TE")) { bonus += 2; }
  }
  return bonus;
}

function startersByPosForTeam(teamIndex) {
  const s = state.settings;
  const targets = { QB:s.qb, RB:s.rb, WR:s.wr, TE:s.te, K:s.k, DEF:s.def };
  const idxs = (state.teamRosters[teamIndex] || []);
  const roster = idxs.map(i => state.players[i]).sort((a,b) => (a.ecr ?? 9999) - (b.ecr ?? 9999));
  const starters = { QB:[], RB:[], WR:[], TE:[], K:[], DEF:[] };
  const flex = [];
  for (const p of roster) {
    if (targets[p.pos] && starters[p.pos].length < targets[p.pos]) { starters[p.pos].push(p); continue; }
    if ((p.pos === "RB" || p.pos === "WR") && flex.length < s.flex) { flex.push(p); continue; }
  }
  return { starters, flex };
}
function startersAllForTeam(teamIndex) {
  const { starters, flex } = startersByPosForTeam(teamIndex);
  return [...starters.QB, ...starters.RB, ...starters.WR, ...starters.TE, ...starters.K, ...starters.DEF, ...flex];
}
function byeOverlapCounts(players) {
  const map = new Map();
  for (const p of players) {
    if (p?.bye == null) continue;
    map.set(p.bye, (map.get(p.bye) || 0) + 1);
  }
  return map;
}
function candidateSharesTeamBye(teamIndex, candidate) {
  if (!candidate.bye) return false;
  const starters = startersAllForTeam(teamIndex);
  return starters.some(p => (p?.bye || -1) === candidate.bye);
}

/* Same-position bye overlap penalty — kept tiny */
function byeOverlapPenalty(teamIndex, candidate) {
  const s = state.settings;
  const startersTarget = { QB:s.qb, RB:s.rb, WR:s.wr, TE:s.te, K:s.k, DEF:s.def };
  const rosterIdxs = state.teamRosters[teamIndex] || [];
  const bye = candidate.bye || null;
  if (!bye) return 0;

  const roster = rosterIdxs.map(i=>state.players[i]).sort((a,b)=>(a.ecr??9999)-(b.ecr??9999));
  const starters = { QB:[], RB:[], WR:[], TE:[], K:[], DEF:[] };
  for (const p of roster) {
    if (startersTarget[p.pos] && starters[p.pos].length < startersTarget[p.pos]) starters[p.pos].push(p);
  }
  const list = starters[candidate.pos] || [];
  const overlap = list.some(p => (p.bye||-1) === bye);
  if (!overlap) return 0;
  const fillingLastStarter = list.length+1 >= (startersTarget[candidate.pos]||0);
  return fillingLastStarter ? -2.0 : -1.0;
}

/* Positional scarcity boost */
function computeScarcityBoost(p) {
  const total = state.players.filter(x => x.pos === p.pos).length;
  const remain = state.available.map(i => state.players[i]).filter(x => x.pos === p.pos).length;
  if (total === 0) return 0;
  const pctRemain = remain / total;
  const scarcity = (1 - pctRemain);
  const posFactor = (p.pos==="RB"||p.pos==="WR") ? 1.2 : (p.pos==="TE"? 1.0 : 0.6);
  return scarcity * posFactor * 4;
}

/* Need weighting */
function rosterNeeds(teamIndex) {
  const s = state.settings, slots = state.rosterSlots[teamIndex] || {QB:0,RB:0,WR:0,TE:0,FLEX:0,K:0,DEF:0,BEN:0};
  const target = { QB:s.qb, RB:s.rb, WR:s.wr, TE:s.te, K:s.k, DEF:s.def };
  const need = {};
  for (const pos of ["QB","RB","WR","TE","K","DEF"]) {
    const have = slots[pos] || 0;
    const left = Math.max(0, (target[pos] || 0) - have);
    need[pos] = 1 + (left*0.8);
  }
  return need;
}

/* Late-round upside */
function lateRoundUpsideBonus(p) {
  const pct = draftProgressPct();
  if (pct < WEIGHTS.lateRoundStartPct) return 0;
  const discount = (state.dataFlags.hasADP && p.adp) ? Math.max(0, p.adp - state.currentOverall) : 0;
  if (discount <= 0) return 0;
  const tier = p.tier || 6;
  const tierLean = Math.max(0, (tier-2));
  const deep = (pct >= WEIGHTS.deepRoundStartPct) ? 1.25 : 1.0;
  return (Math.log10(1 + discount) * (0.75 + 0.25*tierLean)) * deep;
}

/* ---------- Data load ---------- */
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
    // Before draft starts we still show rankings
    renderAll();
  } catch (e) {
    console.warn("Could not load consensus.json:", e.message);
    if (lastUpdatedEl) lastUpdatedEl.innerHTML = `<span style="color:#f59e0b; font-weight:bold;">Tip:</span> ${e.message}. You can upload a CSV below.`;
    // Still render shell
    renderAll();
  }
}

function ingestPlayers(raw) {
  const allowed = new Set(["QB","RB","WR","TE","K","DEF"]);
  state.players = raw.map((p,i) => {
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

  state.available = state.players.map((_,i) => i);
  state.dataFlags.hasProj = state.players.some(p => (p.proj_ppr||0) > 0);
  state.dataFlags.hasADP  = state.players.some(p => p.adp !== null && p.adp !== undefined);
  buildPosRankCache();
}

/* ---------- CSV Upload ---------- */
function initCsvUpload() {
  const input = el("csvInput");
  if (input) {
    input.addEventListener("change", handleCsvFiles);
    const uploader = input.closest(".uploader");
    if (uploader) {
      uploader.addEventListener("dragover", e => { e.preventDefault(); uploader.classList.add("drag"); });
      uploader.addEventListener("dragleave", () => uploader.classList.remove("drag"));
      uploader.addEventListener("drop", e => {
        e.preventDefault(); uploader.classList.remove("drag");
        const file = e.dataTransfer.files?.[0];
        if (file) parseCsvFile(file);
      });
    }
  }
  const btn = el("downloadConsensus");
  if (btn) {
    btn.addEventListener("click", () => {
      if (!state.players.length) { alert("No players loaded yet."); return; }
      const json = JSON.stringify({
        source: state.dataSource === "CSV" ? "FantasyPros CSV (uploaded)" : DATA_URL,
        updated_at: new Date().toISOString(),
        players: state.players
      }, null, 2);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], {type:"application/json"}));
      a.download = "consensus.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    });
  }
}
function handleCsvFiles(e){ const file = e.target.files?.[0]; if (file) parseCsvFile(file); }
function parseCsvFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    const { headers, rows } = csvToRows(text);
    const players = rows.map(r => mapFantasyProsRow(headers, r)).filter(Boolean);
    if (!players.length) { alert("Could not parse any rows from CSV. Check the file format."); return; }
    const label = el("dataSourceLabel"); if (label) label.textContent = "CSV (uploaded)";
    const lu = el("lastUpdated"); if (lu) lu.textContent = `Loaded from CSV: ${file.name} • players: ${players.length}`;
    ingestPlayers(players);
    renderAll();
  };
  reader.readAsText(file);
}
function csvToRows(text) {
  const rows = [];
  let i=0, cur="", inQ=false, row=[];
  const pushCell = () => { row.push(cur); cur=""; };
  const pushRow  = () => { rows.push(row); row=[]; };
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cur+='"'; i+=2; continue; }
      if (c === '"') { inQ=false; i++; continue; }
      cur+=c; i++; continue;
    } else {
      if (c === '"'){ inQ=true; i++; continue; }
      if (c === ','){ pushCell(); i++; continue; }
      if (c === '\r'){ i++; continue; }
      if (c === '\n'){ pushCell(); pushRow(); i++; continue; }
      cur+=c; i++; continue;
    }
  }
  if (cur.length>0 || row.length) { pushCell(); pushRow(); }
  const headers = rows.shift()?.map(h => h.trim()) || [];
  return { headers, rows };
}
function mapFantasyProsRow(headers, row) {
  const get = (aliases) => {
    for (const a of aliases) {
      const idx = headers.findIndex(h => h.toLowerCase() === a.toLowerCase());
      if (idx >= 0) return row[idx];
    }
    return undefined;
  };
  const player = get(["Player","PLAYER","Name"]); if (!player) return null;
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

/* ---------- Settings ---------- */
function syncSettings() {
  const s = state.settings;
  s.teams  = +el("teams").value || 12;
  s.rounds = +el("rounds").value || 16;
  s.pickPos = +el("pickPos").value || 5;
  s.scoring = el("scoring").value || "PPR";
  s.qb = +el("qbSlots").value || 1;
  s.rb = +el("rbSlots").value || 2;
  s.wr = +el("wrSlots").value || 2;
  s.te = +el("teSlots").value || 1;
  s.flex = +el("flexSlots").value || 1;
  s.k = +el("kSlots").value || 1;
  s.def = +el("defSlots").value || 1;
  s.bench = +el("benchSlots").value || 8;
  s.manualMode = !!el("manualMode")?.checked;
  // When flipping manual/regular, reflect helper text & other toggles
  renderDraftModeHelp();
}

/* ---------- Draft engine ---------- */
function startDraft() {
  if (!state.players.length) { alert("Load players first (consensus.json or upload CSV)."); return; }
  syncSettings();
  state.myTeamIndex = state.settings.pickPos - 1;
  const T = state.settings.teams;
  state.teamRosters = new Array(T).fill(0).map(() => []);
  state.rosterSlots = new Array(T).fill(0).map(() => ({QB:0,RB:0,WR:0,TE:0,FLEX:0,K:0,DEF:0,BEN:0}));
  state.draftPicks = [];
  state.currentOverall = 1;
  state.started = true;
  state.paused = false;

  // Populate viewer dropdown now that teams exist
  populateRosterViewer();
  renderAll();
}

function nextPick() {
  if (!state.started) { startDraft(); return; }
  const total = state.settings.teams * state.settings.rounds;
  if (state.currentOverall > total) return;

  const team = overallToTeam(state.currentOverall);

  if (state.settings.manualMode) {
    // In manual mode, do nothing here; user must click Draft on a player.
    renderAll();
    return;
  } else {
    // Regular mode: if it's MY team, wait for user pick; others auto-pick.
    if (team === state.myTeamIndex) { renderAll(); return; }
    aiPick(team);
    advanceAfterPick();
  }
}

function backOne() {
  if (!state.started || !state.draftPicks.length) return;
  undoPick();
  renderAll();
}

function undoPick() {
  if (!state.draftPicks.length) return;
  const last = state.draftPicks.pop();
  const { playerIdx, team, overall } = last;

  state.players[playerIdx].drafted = false;
  if (!state.available.includes(playerIdx)) state.available.push(playerIdx);

  const r = state.teamRosters[team];
  const ix = r.lastIndexOf(playerIdx);
  if (ix >= 0) r.splice(ix, 1);

  const pos = state.players[playerIdx].pos;
  if (pos in state.rosterSlots[team]) state.rosterSlots[team][pos] = Math.max(0, state.rosterSlots[team][pos]-1);
  else state.rosterSlots[team].BEN = Math.max(0, state.rosterSlots[team].BEN-1);

  state.currentOverall = overall;
}

/* Advance + end detection */
function advanceAfterPick(shouldRender=true) {
  state.currentOverall += 1;
  // Did we finish the draft by total picks?
  const total = state.settings.teams * state.settings.rounds;
  if (state.draftPicks.length >= total) {
    // Lock & show results
    state.started = false;
    showResultsModal();
    renderAll();
    return;
  }
  if (shouldRender) renderAll();
}

/* AI pick (simple: best of recommendations/rankings mix) */
function aiPick(teamIndex) {
  const { list } = computeRecommendations(teamIndex);
  if (!list.length) return;
  const k = Math.min(3, list.length);
  const weights = Array.from({length:k}, (_,i) => (k-i));
  const sum = weights.reduce((a,b) => a+b, 0);
  let r = Math.random()*sum, pick = list[0];
  for (let i=0; i<k; i++) { r -= weights[i]; if (r<=0) { pick=list[i]; break; } }
  draftPlayerById(pick.id, teamIndex);
}

function draftPlayerById(id, teamIndex) {
  const poolIdx = state.players.findIndex(p => p.id === id);
  if (poolIdx === -1) return;
  draftByIndex(poolIdx, teamIndex);
}

function draftByIndex(poolIdx, teamIndex) {
  if (state.players[poolIdx].drafted) return;
  const idxAvail = state.available.indexOf(poolIdx);
  if (idxAvail !== -1) state.available.splice(idxAvail, 1);
  state.players[poolIdx].drafted = true;

  const overall = state.currentOverall, round = getRound(overall), pir = pickInRound(overall);

  state.teamRosters[teamIndex].push(poolIdx);
  bumpRosterSlot(teamIndex, state.players[poolIdx].pos);
  state.draftPicks.push({ overall, team: teamIndex, round, pickInRound: pir, playerIdx: poolIdx });

  // In manual mode: drafting a player should auto-advance to next overall
  if (state.settings.manualMode) {
    advanceAfterPick(false);
  }
}

function bumpRosterSlot(teamIndex, pos) {
  const s = state.rosterSlots[teamIndex]; if (!s) return;
  if (pos in s) s[pos]++; else s.BEN++;
}

/* ---------- Export board ---------- */
function exportBoard() {
  const rows = [["overall","round","pickInRound","team","player","pos","teamAbbr","bye","ecr","adp","proj_ppr","tier"]];
  for (const p of [...state.draftPicks].sort((a,b)=>a.overall-b.overall)) {
    const pl = state.players[p.playerIdx];
    rows.push([p.overall,p.round,p.pickInRound,p.team+1,pl.player,pl.pos,pl.team,pl.bye,pl.ecr,pl.adp,pl.proj_ppr,pl.tier]);
  }
  const csv = rows.map(r => r.join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download = "draft_board.csv";
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1500);
}

/* ---------- Scoring / filters / recommendations ---------- */
function replacementLevels() {
  if (!state.dataFlags.hasProj) { return {QB:0,RB:0,WR:0,TE:0,K:0,DEF:0}; }
  const s = state.settings, T=s.teams, flexShare=s.flex;
  const counts={QB:s.qb,RB:s.rb,WR:s.wr,TE:s.te,K:s.k,DEF:s.def}, idxAt={};
  for (const pos of ["QB","RB","WR","TE","K","DEF"]) {
    let N=T*counts[pos];
    if (pos==="RB" || pos==="WR") { N += Math.round(T*(0.5*flexShare)); }
    idxAt[pos] = Math.max(N,1);
  }
  const baseline = {};
  for (const pos of ["QB","RB","WR","TE","K","DEF"]) {
    const pool = state.available.map(i=>state.players[i]).filter(p=>p.pos===pos).sort((a,b)=>(b.proj_ppr||0)-(a.proj_ppr||0));
    const idx = Math.min(idxAt[pos]-1, Math.max(0, pool.length-1)); 
    baseline[pos] = pool[idx] ? (pool[idx].proj_ppr||0) : 0;
  }
  return baseline;
}

function applyFilters(list) {
  let out = list.slice();
  const pos = (state.filters.pos || "").toUpperCase().trim();
  const q   = (state.filters.q || "").toLowerCase().trim();
  if (pos) out = out.filter(p => (p.pos || "").toUpperCase().trim() === pos);
  if (q)   out = out.filter(p => (p.player || "").toLowerCase().includes(q));
  return out;
}

function worstStarterEcrByPos(teamIndex) {
  const { starters } = startersByPosForTeam(teamIndex);
  const worst = {};
  for (const pos of Object.keys(starters)) {
    const arr = starters[pos];
    if (!arr.length) { worst[pos] = null; continue; }
    worst[pos] = Math.max(...arr.map(p => p.ecr ?? 9999));
  }
  return worst;
}

function computeRecommendations(teamIndex) {
  const base = replacementLevels();
  const needs = rosterNeeds(teamIndex);
  let candidates = state.available.map(i => state.players[i]);

  // Allow browsing recs before draft starts (we don't need teamIndex then)
  candidates = applyFilters(candidates);

  const pct = draftProgressPct();
  const worstEcr = worstStarterEcrByPos(state.myTeamIndex);

  const myStartersNow = startersAllForTeam(state.myTeamIndex);
  const countsNow = byeOverlapCounts(myStartersNow);

  const scored = candidates.map(p => {
    const baseProj = state.dataFlags.hasProj ? (p.proj_ppr || 0) : 0;
    const rep = state.dataFlags.hasProj ? (base[p.pos] || 0) : 0;
    const vor = baseProj - rep;
    const tierBoost = (6 - Math.min(p.tier || 6, 6));
    const valueBoost = state.dataFlags.hasADP ? Math.max(0, (p.adp || state.currentOverall) - state.currentOverall) / 10 : 0;

    const needW = (needs[p.pos] || 1.0);
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

    // Push K/DEF later
    if ((p.pos === "K" || p.pos === "DEF") && pct < 0.6) score -= 3 * (0.6 - pct);

    const upgradeForPos = (() => {
      const worst = worstEcr[p.pos];
      if (worst == null || p.ecr == null) return false;
      return p.ecr + UPGRADE_ECR_GAP < worst;
    })();

    // (We no longer display VOR in UI; keep only for scoring)

    return { ...p, baseProj, rep, vor, score,
      hasMyStack: hasPrimaryStackForMyTeam(p),
      upgradeForPos
    };
  });

  scored.sort((a,b) => b.score - a.score);
  return { list: scored.slice(0, 60), baseline: base, needs };
}

/* ---------- Rendering ---------- */
function renderAll() {
  renderDraftModeHelp();
  renderBoard();
  renderMidPanel();
  renderRoster();
  updateTabsUI();
}

/* Helper text line under controls */
function renderDraftModeHelp() {
  const t = el("modeHelp"); if (!t) return;
  t.innerHTML =
    `<strong>Manual Draft Mode:</strong> You select every pick for every team; only your picks add to your roster automatically, but all teams' rosters are filled.
     <strong>Regular Mode:</strong> Other teams auto-draft; you draft on your turn.`;
}

/* Board — newest first at the top */
function renderBoard() {
  const root = el("board"); if (!root) return; root.innerHTML = "";
  const picks = [...state.draftPicks];

  // Newest first (descending overall)
  picks.sort((a,b) => b.overall - a.overall);

  if (!picks.length) {
    const emptyWrap = document.createElement("div");
    emptyWrap.className = "board-empty";
    emptyWrap.innerHTML = `
      <div class="empty-card dashed">
        <div class="hint-title">No picks yet. Start the draft and make your first selection.</div>
      </div>`;
    root.appendChild(emptyWrap);
    return;
  }

  if (state.boardView === "overall") {
    picks.forEach(p => root.appendChild(boardPickElem(p)));
  } else {
    // Group by round, but keep newest first inside each group
    const byRound = new Map();
    picks.forEach(p => { if (!byRound.has(p.round)) byRound.set(p.round, []); byRound.get(p.round).push(p); });
    Array.from(byRound.keys()).sort((a,b)=>b-a).forEach(r => {
      const h = document.createElement("div");
      h.className = "round-header";
      h.textContent = `Round ${r}`;
      root.appendChild(h);
      byRound.get(r).sort((a,b)=>b.overall-a.overall).forEach(p => root.appendChild(boardPickElem(p)));
    });
  }
}

function boardPickElem(p) {
  const pl = state.players[p.playerIdx];
  const logo = teamLogoUrl(pl.team);
  const pr = getPosRank(pl);
  const div = document.createElement("div"); div.className = "pick";
  div.innerHTML = `
    <div class="flex">
      <span class="badge">#${p.overall} R${p.round}.${p.pickInRound}</span>
      <span class="small">Team ${p.team+1}</span>
    </div>
    <div class="flex" style="justify-content:flex-start; gap:8px;">
      ${logo ? `<img src="${logo}" alt="${pl.team||''}" class="team-logo">` : ""}
      <div class="name">${pl.player}</div>
    </div>
    <div class="small">
      <span class="badge pos ${pl.pos}">${pl.pos}${pr ? posRankLabel(pr) : ""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"}
    </div>`;
  return div;
}

/* Mid panel */
function renderMidPanel() {
  const root = el("midList"); if (!root) return; root.innerHTML = "";

  const activeTeam = state.started ? overallToTeam(state.currentOverall) : state.myTeamIndex;

  if (state.midTab === "recs") {
    const { list } = computeRecommendations(activeTeam);
    if (!state.started) {
      // Pre-draft: recommendations are kinda meaningless; still show top ECR
      const ranked = state.available.map(i=>state.players[i]).sort((a,b)=>(a.ecr??1e9)-(b.ecr??1e9));
      ranked.slice(0, 50).forEach(p => root.appendChild(playerCard(p)));
      return;
    }
    list.forEach(p => root.appendChild(playerCard(p)));
  } else {
    // Full rankings (default) — always visible before/after start
    let list = state.available.map(i => state.players[i]);
    list = applyFilters(list);
    list.sort((a,b) => (a.ecr ?? 1e9) - (b.ecr ?? 1e9));
    list.slice(0, 200).forEach(p => root.appendChild(playerCard(p)));
  }
}

function playerCard(p) {
  const d = document.createElement("div");
  d.className = "item";
  const logo = teamLogoUrl(p.team);
  const pr = getPosRank(p);
  const t = p.tier || 6;
  const ecrText = (p.ecr != null) ? `#${p.ecr}` : "#—";
  const adpBit = state.dataFlags.hasADP ? ` • ADP ${p.adp || "-"}` : "";

  const stackBadge = (p.hasMyStack || hasPrimaryStackForMyTeam(p))
    ? `<span class="badge stack" title="Stacks with your roster">🔗 STACK</span>` : "";
  const upgradeBadge = "";// keep UI quieter: no giant "Upgrade Available" badge by default

  d.innerHTML = `
    <div class="flex">
      <div class="left">
        ${logo ? `<img src="${logo}" alt="${p.team||''}" class="team-logo-sm">` : ""}
        <div>
          <div class="name">
            ${p.player} ${stackBadge} ${upgradeBadge}
            <span class="badge tier t${t}">T${t}</span>
            <span class="badge pos ${p.pos}">${p.pos}${pr ? posRankLabel(pr) : ""}</span>
            <span class="badge">${ecrText}</span>
          </div>
          <div class="small">${p.team || ""} • Bye ${p.bye || "-"}${adpBit}</div>
        </div>
      </div>
      <div>
        <button class="btn-draft" data-pid="${p.id}">Draft</button>
      </div>
    </div>
  `;

  d.querySelector("button").onclick = () => {
    if (!state.started) startDraft();
    const onClock = overallToTeam(state.currentOverall);
    // If manual mode: this assigns the pick to current team (whoever is on clock)
    // If regular mode: we only allow drafting when onClock == myTeam; otherwise ignore
    if (!state.settings.manualMode && onClock !== state.myTeamIndex) {
      alert("It's not your pick yet.");
      return;
    }
    draftPlayerById(p.id, onClock);
    advanceAfterPick();
  };

  return d;
}

/* Roster (viewer) */
function populateRosterViewer() {
  const sel = el("rosterViewerSelect"); if (!sel) return;
  const T = state.settings.teams;
  sel.innerHTML = "";
  for (let t=0; t<T; t++) {
    const opt = document.createElement("option");
    const label = (t === state.myTeamIndex) ? `Team ${t+1} (You)` : `Team ${t+1}`;
    opt.value = String(t);
    opt.textContent = label;
    sel.appendChild(opt);
  }
  sel.value = String(state.myTeamIndex);
}

function renderRoster() {
  const root = el("myRoster"); if (!root) return; root.innerHTML = "";

  const viewSel = el("rosterViewerSelect");
  const teamIndex = viewSel ? +viewSel.value : state.myTeamIndex;

  const mineIdxs = (state.teamRosters[teamIndex] || []);
  const mine = mineIdxs.map(i => state.players[i]).sort((a,b) => (a.ecr ?? 9999) - (b.ecr ?? 9999));

  const slotsTarget = {
    QB: state.settings.qb, RB: state.settings.rb, WR: state.settings.wr,
    TE: state.settings.te, FLEX: state.settings.flex, K: state.settings.k, DEF: state.settings.def
  };

  // Build starters & bench
  const starters = { QB:[], RB:[], WR:[], TE:[], K:[], DEF:[], FLEX:[] };
  const bench = [];
  for (const p of mine) {
    if (slotsTarget[p.pos] && starters[p.pos].length < slotsTarget[p.pos]) { starters[p.pos].push(p); continue; }
    if ((p.pos==="RB" || p.pos==="WR") && starters.FLEX.length < slotsTarget.FLEX) { starters.FLEX.push(p); continue; }
    bench.push(p);
  }

  // Bench sorting by “value” heuristic
  bench.sort((a,b) => (benchValue(b) - benchValue(a)));

  // Map bye overlaps among all starters
  const startersAll = [...starters.QB, ...starters.RB, ...starters.WR, ...starters.TE, ...starters.K, ...starters.DEF, ...starters.FLEX];
  const counts = byeOverlapCounts(startersAll);

  const section = (label, list, target, benchMode=false) => {
    let headerBadges = "";
    if (!benchMode) {
      const fill = list.length;
      const cov = coverageStatus(fill, target);
      const klass = (fill<=0) ? "cov-bad" : (fill<target ? "cov-warn" : "cov-ok");
      headerBadges = `<span class="cov-chip ${klass}">${cov.label}</span>`;
    }

    const wrap = document.createElement("div");
    wrap.className = "roster-section";
    wrap.innerHTML = `<div class="roster-header small">${label} ${headerBadges}</div>`;
    for (const pl of list) {
      const logo = teamLogoUrl(pl.team); const pr = getPosRank(pl); const ecr = (pl.ecr != null) ? `#${pl.ecr}` : "#—";
      const dotColor = (pl.bye != null) ? byeDotColor(counts.get(pl.bye) || 0) : null;
      const dot = dotColor ? byeDotSpan(dotColor) : "";
      const row = document.createElement("div"); row.className = "roster-item";
      row.innerHTML = `${logo ? `<img src="${logo}" alt="${pl.team||''}" class="team-logo team-logo-sm">` : ""}
        <div class="roster-main">
          <div class="roster-name">${pl.player}</div>
          <div class="roster-meta"><span class="badge pos ${pl.pos}">${pl.pos}${pr ? posRankLabel(pr) : ""}</span> • ${pl.team||""} • Bye ${pl.bye||"-"} ${dot} • ECR ${ecr}</div>
        </div>`;
      wrap.appendChild(row);
    }
    if (!benchMode) {
      for (let i=list.length; i<target; i++) {
        const empty = document.createElement("div"); empty.className = "roster-item slot-empty";
        empty.innerHTML = `<div class="slot-dot"></div>
          <div class="roster-main">
            <div class="roster-name muted">Empty ${label} Slot</div>
            <div class="roster-meta muted">—</div>
          </div>`;
        wrap.appendChild(empty);
      }
    } else {
      for (let i=list.length; i<state.settings.bench; i++) {
        const empty = document.createElement("div"); empty.className = "roster-item slot-empty";
        empty.innerHTML = `<div class="slot-dot"></div>
          <div class="roster-main">
            <div class="roster-name muted">Empty Bench</div>
            <div class="roster-meta muted">—</div>
          </div>`;
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

/* Small helpers for roster chips */
function benchValue(p) {
  const proj = Number(p.proj_ppr || 0);
  const ecrComp = (p.ecr != null) ? (300 - p.ecr) * 0.5 : 0;
  return proj + ecrComp;
}
function coverageStatus(fill, target) {
  if (target <= 0) return {label:"0/0"};
  if (fill <= 0)  return {label:`0/${target}`};
  if (fill < target) return {label:`${fill}/${target}`};
  return {label:`${fill}/${target}`};
}
function byeDotColor(count) {
  if (count >= 4) return "#ef4444";
  if (count === 3) return "#f97316";
  if (count === 2) return "#f59e0b";
  return null;
}
function byeDotSpan(color) {
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${color};margin-left:6px;vertical-align:middle"></span>`;
}

/* Tabs UI */
function updateTabsUI() {
  el("tabOverall")?.classList.toggle("active", state.boardView==="overall");
  el("tabByRound")?.classList.toggle("active", state.boardView==="round");

  el("subtabRanks")?.classList.toggle("active", state.midTab==="ranks");
  el("subtabRecs")?.classList.toggle("active", state.midTab==="recs");
}

/* ---------- Results modal ---------- */
function showResultsModal() {
  const modal = el("resultsModal"); if (!modal) return;
  const body = el("resultsBody"); if (!body) return;

  // Compute simple grade metrics
  const T = state.settings.teams;
  const startersSumByTeam = []; // approximate quality metric: sum of inverse ECR of starters
  const posBreakdown = [];      // {QB:score, RB:..., ...}
  for (let t=0; t<T; t++) {
    const { starters, flex } = startersByPosForTeam(t);
    const startersAll = [...starters.QB, ...starters.RB, ...starters.WR, ...starters.TE, ...starters.K, ...starters.DEF, ...flex];
    const inv = (p) => p?.ecr ? (400 - p.ecr) : 0;
    const sum = startersAll.reduce((a,p)=>a+inv(p), 0);
    startersSumByTeam.push(sum);

    const posScore = {
      QB: starters.QB.reduce((a,p)=>a+inv(p),0),
      RB: starters.RB.reduce((a,p)=>a+inv(p),0),
      WR: starters.WR.reduce((a,p)=>a+inv(p),0),
      TE: starters.TE.reduce((a,p)=>a+inv(p),0),
      K:  starters.K.reduce((a,p)=>a+inv(p),0),
      DEF:starters.DEF.reduce((a,p)=>a+inv(p),0),
      FLEX:flex.reduce((a,p)=>a+inv(p),0)
    };
    posBreakdown.push(posScore);
  }

  // Rank teams by sum
  const indices = [...Array(T)].map((_,i)=>i);
  indices.sort((a,b)=>startersSumByTeam[b]-startersSumByTeam[a]);

  // Helper: grade by percentile
  const gradeForRank = (rank) => {
    const pct = rank / (T-1); // 0 = best
    if (pct <= 0.2) return "A";
    if (pct <= 0.45) return "B";
    if (pct <= 0.75) return "C";
    return "D";
  };

  const rowsHtml = indices.map((team, rank) => {
    const grade = gradeForRank(rank);
    const pillCls = `grade-pill grade-${grade}`;
    const label = (team === state.myTeamIndex) ? `Team ${team+1} (You)` : `Team ${team+1}`;
    const pos = posBreakdown[team];
    return `<tr>
      <td>${rank+1}</td>
      <td>${label}</td>
      <td><span class="${pillCls}">${grade}</span></td>
      <td>${pos.QB.toFixed(0)}</td>
      <td>${pos.RB.toFixed(0)}</td>
      <td>${pos.WR.toFixed(0)}</td>
      <td>${pos.TE.toFixed(0)}</td>
      <td>${pos.FLEX.toFixed(0)}</td>
      <td>${pos.K.toFixed(0)}</td>
      <td>${pos.DEF.toFixed(0)}</td>
    </tr>`;
  }).join("");

  body.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Rank</th>
          <th>Team</th>
          <th>Grade</th>
          <th>QB</th>
          <th>RB</th>
          <th>WR</th>
          <th>TE</th>
          <th>FLEX</th>
          <th>K</th>
          <th>DEF</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;

  modal.classList.remove("hidden");
}
function closeResultsModal() {
  el("resultsModal")?.classList.add("hidden");
}

/* ---------- Event wiring ---------- */
function init() {
  loadConsensus();
  setInterval(loadConsensus, 30*60*1000);
  initCsvUpload();

  // Settings inputs
  ["teams","rounds","pickPos","scoring","qbSlots","rbSlots","wrSlots","teSlots","flexSlots","kSlots","defSlots","benchSlots","manualMode"]
    .forEach(id => el(id)?.addEventListener("input", () => { syncSettings(); renderAll(); }));

  // Controls
  el("startBtn")?.addEventListener("click", startDraft);
  el("nextBtn")?.addEventListener("click", nextPick);
  el("backBtn")?.addEventListener("click", backOne);
  el("undoBtn")?.addEventListener("click", backOne); // alias

  // Tabs (board)
  el("tabOverall")?.addEventListener("click", () => { state.boardView = "overall"; renderBoard(); updateTabsUI(); });
  el("tabByRound")?.addEventListener("click", () => { state.boardView = "round"; renderBoard(); updateTabsUI(); });

  // Mid-panel tabs
  el("subtabRanks")?.addEventListener("click", () => { state.midTab = "ranks"; renderMidPanel(); updateTabsUI(); });
  el("subtabRecs")?.addEventListener("click", () => { state.midTab = "recs"; renderMidPanel(); updateTabsUI(); });

  // Filters
  el("filterPos")?.addEventListener("change", (e) => { state.filters.pos = String(e.target.value || "").toUpperCase().trim(); renderMidPanel(); });
  el("searchName")?.addEventListener("input", (e) => { state.filters.q = e.target.value || ""; renderMidPanel(); });

  // Roster viewer
  el("rosterViewerSelect")?.addEventListener("change", renderRoster);

  // Results modal
  el("resultsClose")?.addEventListener("click", closeResultsModal);
  el("resultsOk")?.addEventListener("click", closeResultsModal);

  // Initial render (rankings visible even before data)
  renderAll();
}

document.addEventListener("DOMContentLoaded", init);
