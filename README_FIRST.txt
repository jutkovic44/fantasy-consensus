README_FIRST — CSV-based Setup (single folder upload)

1) Create a PUBLIC repo named `fantasy-consensus`.
2) Upload ALL files/folders from this folder to the repo ROOT (including `.github`).
   You should see at repo top-level:
     - consensus.json
     - index.html
     - app.js
     - styles.css
     - csv_to_consensus.py
     - .github/workflows/update.yml
3) Upload the latest FantasyPros CSV export to the repo root with the EXACT name:
     FantasyPros_2025_Draft_ALL_Rankings.csv
4) Repo Settings → Pages → Deploy from a branch → Branch: main → Folder: /(root) → Save.
5) Repo Settings → Actions → General → Workflow permissions → select "Read and write permissions" → Save.
6) Actions tab → "Update Consensus from FantasyPros CSV" → Run workflow → wait ~30s.
7) App URL: https://<your-user>.github.io/fantasy-consensus/
   Data URL: https://<your-user>.github.io/fantasy-consensus/consensus.json

Notes:
- Step 3 is required each time you want to refresh to a newer CSV.
- If you prefer fully automatic scraping (no CSV uploads), tell me and I'll send a Playwright-based pack.
