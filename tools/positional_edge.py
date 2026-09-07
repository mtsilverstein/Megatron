"""Which position actually carried the biggest top-vs-replacement edge?

Answers a question that keeps coming up when the board recommends a
position the market prices lower -- e.g. "is Trey McBride at pick 14 a
reach, or is elite TE genuinely the biggest edge available?"

Scores nflverse ACTUALS with the league's own rules (`scoring.LEAGUE`) at
the board's own replacement ranks, so it is the same quantity the board
calls `vorp`, measured on what happened instead of on a projection.

Run:  python tools/positional_edge.py

READ THE RESULT CAREFULLY. These gaps are EX-POST: they take each
season's realized #1 at a position, chosen with hindsight. No drafter can
capture that, and high-variance positions are inflated most -- which is
why QB reads ~133 here while the 2026 board projects the best available
QB at 20. Use this for the ORDERING of positions, not the magnitudes.

Result as of 2026-09-07 (2021-25, FAM rules, repl QB11/RB28/WR34/TE11):
  mean gap  QB 133   RB 215   WR 202   TE 127
  TE was the largest in 0 of 5 seasons; RB 3, WR 2.
So an elite TE is a real edge but never the biggest one -- consistent
with the 2026 board, which ranks Gibbs 105 > Chase 97 > McBride 79.
"""
import sys; sys.path.insert(0, "src")
import pandas as pd
from ffmodel.scoring import LEAGUE, fantasy_points

REPL = {"RB": 28, "WR": 34, "TE": 11, "QB": 11}   # FAM board, from draft-fam.json
df = pd.read_parquet("data/raw/weekly_v2_2012_2025.parquet")
df = df[df["week"] <= 17]
df["pts"] = fantasy_points(df, LEAGUE)
season_tot = (df.groupby(["season", "player_id", "player_display_name", "position"])
                ["pts"].sum().reset_index())

print(f"Realized season points, FAM rules (PPR, 6-pt pass TD, -2 INT).")
print(f"VORP = that season's #1 at the position minus the replacement-rank player.\n")
print(f"{'season':<8}" + "".join(f"{p:>10}" for p in ("QB", "RB", "WR", "TE")))
rows = {}
for season in range(2021, 2026):
    s = season_tot[season_tot["season"] == season]
    line, vals = f"{season:<8}", {}
    for pos in ("QB", "RB", "WR", "TE"):
        v = s[s["position"] == pos].nlargest(REPL[pos], "pts")["pts"].tolist()
        if len(v) < REPL[pos]:
            line += f"{'n/a':>10}"; continue
        vorp = v[0] - v[REPL[pos] - 1]
        vals[pos] = vorp
        line += f"{vorp:>10.0f}"
    rows[season] = vals
    print(line)

print(f"\n{'mean':<8}" + "".join(
    f"{sum(rows[s][p] for s in rows)/len(rows):>10.0f}" for p in ("QB", "RB", "WR", "TE")))
wins = {p: sum(1 for s in rows if max(rows[s], key=rows[s].get) == p) for p in ("QB","RB","WR","TE")}
print(f"\nseasons where that position had the LARGEST top-vs-replacement gap: {wins}")

print("\n--- and what the 2026 BOARD claims for the same quantity ---")
import json
b = json.load(open("site/data/draft-fam.json"))
for pos in ("QB", "RB", "WR", "TE"):
    top = max((p for p in b["players"] if p["position"] == pos),
              key=lambda p: p.get("vorp") or -1e9)
    print(f"  {pos}: best available vorp {top['vorp']:.0f}  ({top['name']})")
