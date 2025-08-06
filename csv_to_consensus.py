#!/usr/bin/env python3
import pandas as pd, json, sys, datetime

def to_int(x):
    try:
        if pd.isna(x): return None
        s = str(x).strip()
        if s == "": return None
        return int(float(s))
    except: return None

def to_float(x):
    try:
        if pd.isna(x): return None
        s = str(x).strip().replace("%","")
        if s == "": return None
        return float(s)
    except: return None

def convert(csv_path, out_path="consensus.json"):
    df = pd.read_csv(csv_path)
    rows = []
    for _, r in df.iterrows():
        rk   = to_int(r.get("RK"))
        name = str(r.get("PLAYER NAME") or "").strip()
        team = str(r.get("TEAM") or "").strip()
        pos  = str(r.get("POS") or "").strip().upper()
        bye  = to_int(r.get("BYE WEEK"))
        tier = to_int(r.get("TIERS"))
        if not name:
            continue
        rows.append({
            "id": rk or (len(rows)+1),
            "player": name,
            "pos": pos,
            "team": team,
            "bye": bye or 0,
            "ecr": rk,
            "adp": None,
            "proj_ppr": 0.0,
            "receptions": 0.0,
            "risk": 0.0,
            "tier": tier or 0,
            "notes": {
                "ecr_vs_adp": (r.get("ECR VS. ADP") or None),
                "avg_diff": to_float(r.get("AVG. DIFF ")),
                "pct_over": to_float(r.get("% OVER "))
            }
        })
    out = {
        "source": "FantasyPros CSV (PPR Cheatsheet download)",
        "updated_at": datetime.datetime.utcnow().isoformat() + "Z",
        "players": rows
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

if __name__ == "__main__":
    csv_in = sys.argv[1] if len(sys.argv) > 1 else "FantasyPros_2025_Draft_ALL_Rankings.csv"
    convert(csv_in)
    print("Wrote consensus.json")
