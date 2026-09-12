import pandas as pd
import pytest
from ffmodel.site.weekly_experts import build_payload


def test_weekly_export_ignores_points_and_preserves_date_precision(tmp_path):
    path = tmp_path / 'FantasyPros_2026_Week_1_RB_Rankings_09-10-26.csv'
    path.write_text('RK,PLAYER NAME,TEAM,PROJ. FPTS\n1,Player One,DET,24.2\n""\n2,Unknown,NYJ,-\n')
    crosswalk = pd.DataFrame([{'merge_name':'Player One','position':'RB','gsis_id':'gsis1'}])
    result = build_payload([path], crosswalk, scoring_format='ppr')
    assert 'projected_fpts' not in result['players'][0]
    assert result['horizon'] == 'weekly'
    assert result['snapshot_precision'] == 'date'
    assert result['snapshot_at'] == '2026-09-10'
    assert len(result['coverage']['unmatched']) == 1
    with pytest.raises(ValueError, match='explicit source scoring'):
        build_payload([path], crosswalk, scoring_format='unknown')
    with pytest.raises(ValueError, match='duplicate mapped'):
        build_payload([path,path], crosswalk, scoring_format='ppr')
    ambiguous = pd.concat([crosswalk, crosswalk.assign(gsis_id='other')])
    with pytest.raises(ValueError, match='nonempty'):
        build_payload([path], ambiguous, scoring_format='ppr')


def test_invalid_external_points_are_not_consumed(tmp_path):
    path = tmp_path / 'FantasyPros_2026_Week_1_QB_Rankings_09-10-26.csv'
    path.write_text('RK,PLAYER NAME,TEAM,PROJ. FPTS\n1,Player One,DET,NaN\n')
    crosswalk = pd.DataFrame([{'merge_name':'Player One','position':'QB','gsis_id':'gsis1'}])
    result = build_payload([path], crosswalk, scoring_format='ppr')
    assert 'projected_fpts' not in result['players'][0]
