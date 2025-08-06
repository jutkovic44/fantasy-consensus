const state = {
  players: [],
  available: [],
  myRoster: [],
  filters: { pos: '', q: '' }
};

const byeWeekTracker = {};

function trackByeWeek(bye, add = true) {
  if (!bye) return;
  if (!byeWeekTracker[bye]) byeWeekTracker[bye] = 0;
  byeWeekTracker[bye] += add ? 1 : -1;
  if (byeWeekTracker[bye] < 0) byeWeekTracker[bye] = 0;
}

function renderPlayerByeText(player) {
  return player.bye ? `Bye ${player.bye}` : '';
}

function loadPlayers() {
  state.players = [
    { id: 1, player: 'Josh Jacobs', pos: 'RB', team: 'GB', bye: 5, drafted: false },
    { id: 2, player: 'DJ Moore', pos: 'WR', team: 'CHI', bye: 5, drafted: false },
    { id: 3, player: 'DK Metcalf', pos: 'WR', team: 'SEA', bye: 5, drafted: false },
    { id: 4, player: 'Travis Kelce', pos: 'TE', team: 'KC', bye: 10, drafted: false }
  ];
  state.available = state.players.map((_, i) => i);
}

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

document.addEventListener('DOMContentLoaded', () => {
  loadPlayers();
  renderRecommendations();
  renderRoster();
});
