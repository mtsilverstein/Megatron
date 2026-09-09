import pandas as pd
import pytest
from ffmodel.site.kickoffs import build_kickoffs

def test_eastern_kickoffs_and_coverage():
    df=pd.DataFrame([dict(season=2026,week=1,game_type="REG",gameday="2026-09-09",gametime="20:20",home_team="SEA",away_team="NE")])
    p=build_kickoffs(df,2026,1)
    assert p["games"][0]["kickoff"]=="2026-09-10T00:20:00+00:00"
    assert p["teams"]==["NE","SEA"]
    with pytest.raises(ValueError,match="Duplicate"):
        build_kickoffs(pd.concat([df,df]),2026,1)
    df["gametime"]=None
    with pytest.raises(ValueError,match="unknown"):
        build_kickoffs(df,2026,1)
