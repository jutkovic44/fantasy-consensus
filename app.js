// Fantasy Football War Room - Fully Robust Draft Logic (Manual Draft Mode Included)

// ==============================
// GLOBAL STATE AND CONFIGURATION
// ==============================

const state = {
  settings: {
    teams: 12,
    rounds: 16,
    pickPos: 5,
    scoring: 'PPR',
    slots: {
      QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1, BENCH: 8
    }
  },
  data: [], // All player data loaded from CSV or consensus.json
  draftBoard: [], // Each pick slot filled as draft progresses
  teamRosters: [], // Array of team rosters (length == team count)
  availablePlayers: [],
  history: [], // For undo
  future: [], // For redo
  currentPick: 0,
  autoDraftEnabled: true,
  manualMode: false,
  teamAutoDraft: [],
  mode: 'idle', // idle | running | paused
  view: {
    boardTab: 'overall', // 'overall' or 'byRound'
    midTab: 'recs', // 'recs' or 'ranks'
    posFilter: '', // RB, WR, etc
    searchQuery: ''
  },
  lastUpdated: null
};

// ==============================
// DOM ELEMENTS CACHE
// ==============================

const dom = {
  csvInput: document.getElementById('csvInput'),
  downloadConsensus: document.getElementById('downloadConsensus'),
  dataSourceLabel: document.getElementById('dataSourceLabel'),
  startBtn: document.getElementById('startMock'),
  pauseBtn: document.getElementById('pauseMock'),
  resumeBtn: document.getElementById('resumeMock'),
  nextBtn: document.getElementById('nextPick'),
  prevBtn: document.getElementById('prevPick'),
  undoBtn: document.getElementById('undoPick'),
  exportBtn: document.getElementById('exportBoard'),
  autoUntilMyPickBtn: document.getElementById('autoUntilMyPick'),
  autoOthersToggle: document.getElementById('autoOthers'),
  boardContainer: document.getElementById('board'),
  midList: document.getElementById('midList'),
  filterPos: document.getElementById('filterPos'),
  searchName: document.getElementById('searchName'),
  myRoster: document.getElementById('myRoster'),
  lastUpdated: document.getElementById('lastUpdated'),
  tabOverall: document.getElementById('tabOverall'),
  tabByRound: document.getElementById('tabByRound'),
  subtabRecs: document.getElementById('subtabRecs'),
  subtabRanks: document.getElementById('subtabRanks'),
  settingsInputs: {
    teams: document.getElementById('teams'),
    rounds: document.getElementById('rounds'),
    pickPos: document.getElementById('pickPos'),
    scoring: document.getElementById('scoring'),
    qbSlots: document.getElementById('qbSlots'),
    rbSlots: document.getElementById('rbSlots'),
    wrSlots: document.getElementById('wrSlots'),
    teSlots: document.getElementById('teSlots'),
    flexSlots: document.getElementById('flexSlots'),
    kSlots: document.getElementById('kSlots'),
    defSlots: document.getElementById('defSlots'),
    benchSlots: document.getElementById('benchSlots')
  }
};

// ==============================
// EVENT LISTENERS (To be filled)
// ==============================

// Will go here...

