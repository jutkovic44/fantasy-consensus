const state = {
  players: [],
  available: [],
  myRoster: [],
  filters: { pos: '', q: '' }
};

// === Bye Week Tracker ===
const byeWeekTracker = {}; // bye -> count

function trackByeWeek(bye, add = true) {
  if (!bye) return;
  if (!byeWeekTracker[bye]) byeWeekTracker[bye] = 0;
  byeWeekTracker[bye] += add ? 1 : -1;
  if (byeWeekTracker[bye] < 0) byeWeekTracker[bye] = 0;
}

function getByeDotColor(bye) {
  const count = byeWeekTracker[bye] || 0;
  if (count >= 4) return 'red';
  if (count === 3) return 'orange';
  if (count === 2) return 'yellow';
  return '';
}

function getByeDotSpan(bye) {
  const color = getByeDotColor(bye);
  return color ? `<span class="bye-dot ${color}"></span>` : '';
}

function renderPlayerByeText(player) {
  if (!player.bye) return '';
  return `Bye ${player.bye} ${getByeDotSpan(player.bye)}`;
}

// === Example Data Loader ===
function loadPlayers() {
  state.players = [
    { id: 1, player: 'Josh Jacobs', pos: 'RB', team: 'GB', bye: 5, drafted: false },
    { id: 2, player: 'DJ Moore', pos: 'WR', team: 'CHI', bye: 5, drafted: false },
    { id: 3, player: 'DK Metcalf', pos: 'WR', team: 'SEA', bye: 5, drafted: false },
    { id: 4, player: 'Travis Kelce', pos: 'TE', team: 'KC', bye: 10, drafted: false }
  ];
  state.available = state.players.map((_, i) => i);
}

// === Rendering Functions ===
function renderRecommendations() {
  const root = document.getElementById('midList');
  root.innerHTML = '';

  state.available.map(i => state.players[i]).forEach(p => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div>
        ${p.player} • ${renderPlayerByeText(p)}
      </div>
      <button onclick="draftPlayer(${p.id})">Draft</button>
    `;
    root.appendChild(div);
  });
}

function renderRoster() {
  const root = document.getElementById('myRoster');
  root.innerHTML = '';

  state.myRoster.forEach(p => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      ${p.player} • ${renderPlayerByeText(p)}
    `;
    root.appendChild(div);
  });
}

// === Draft Logic ===
function draftPlayer(id) {
  const idx = state.players.findIndex(p => p.id === id);
  if (idx === -1) return;

  const player = state.players[idx];
  player.drafted = true;
  trackByeWeek(player.bye, true);

  state.myRoster.push(player);
  state.available = state.available.filter(i => i !== idx);

  renderRecommendations();
  renderRoster();
}

// === Init ===
document.addEventListener('DOMContentLoaded', () => {
  loadPlayers();
  renderRecommendations();
  renderRoster();
});
