from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from app import DailySale, run_forecast


source = Path(sys.argv[1])
daily: dict[str, float] = defaultdict(float)
rows = 0
with source.open("r", encoding="utf-8-sig", newline="") as handle:
    reader = csv.DictReader(handle)
    for row in reader:
        parsed = datetime.strptime(row["Sale_Date"], "%d/%m/%Y").date().isoformat()
        daily[parsed] += float(row["Net_Sales_LKR"])
        rows += 1

points = [DailySale(date=key, sales=value) for key, value in sorted(daily.items())]
print(json.dumps({"source": str(source), "rows": rows, "dailyPoints": len(points), "start": points[0].date.isoformat(), "end": points[-1].date.isoformat()}, indent=2))
for horizon in (7, 30, 90, 180):
    result = run_forecast(points, horizon)
    print(json.dumps({
        "horizon": horizon,
        "winner": result["winner"]["name"],
        "wape": result["winner"]["wape"],
        "mae": result["winner"]["mae"],
        "bias": result["winner"]["bias"],
        "confidence": result["confidence"],
        "folds": result["folds"],
        "baselineWape": result["baseline"]["wape"],
        "relativeImprovement": result["relativeImprovement"],
    }, indent=2))
