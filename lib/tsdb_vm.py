import json
import logging
import time
import urllib.parse
import urllib.request
from typing import Dict, List, Optional

import config

log = logging.getLogger(__name__)


def _base_url() -> str:
    base = getattr(config, "tsdb_url", "http://localhost:8428")
    if not isinstance(base, str) or not base:
        return "http://localhost:8428"
    return base.rstrip("/")


def _request_json(url: str, *, timeout: float = 2.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
    try:
        return json.loads(body)
    except Exception as exc:
        raise RuntimeError("invalid_tsdb_json") from exc


def write_sample(*, t: int, temp: float, target: Optional[float], power_percent: Optional[float]) -> None:
    """Write one aligned sample to VictoriaMetrics.

    - t is unix seconds
    - values are numeric
    """

    ts_ms = int(t) * 1000
    lines = [f"kiln_temperature {float(temp)} {ts_ms}"]
    if target is not None:
        lines.append(f"kiln_target {float(target)} {ts_ms}")
    if power_percent is not None:
        lines.append(f"kiln_power_percent {float(power_percent)} {ts_ms}")

    data = "\n".join(lines).encode("utf-8")
    url = f"{_base_url()}/api/v1/import/prometheus"
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "text/plain; version=0.0.4")

    with urllib.request.urlopen(req, timeout=2.0) as resp:
        resp.read()


def _query_series(query: str, *, start: int, end: int, step: int) -> Dict[int, float]:
    params = urllib.parse.urlencode(
        {
            "query": query,
            "start": str(int(start)),
            "end": str(int(end)),
            "step": str(int(step)),
        }
    )
    url = f"{_base_url()}/api/v1/query_range?{params}"
    payload = _request_json(url)

    if payload.get("status") != "success":
        raise RuntimeError("tsdb_query_failed")

    data = payload.get("data") or {}
    result = data.get("result") or []
    if not result:
        return {}

    # We expect a single series for each metric.
    series = result[0]
    values = series.get("values") or []
    out: Dict[int, float] = {}
    for item in values:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            continue
        ts, val = item
        try:
            t = int(float(ts))
            v = float(val)
        except Exception:
            continue
        out[t] = v
    return out


def query_range(*, start: int, end: int, max_points: int) -> List[Dict[str, Optional[float]]]:
    start_i = int(start)
    end_i = int(end)
    if end_i < start_i:
        start_i, end_i = end_i, start_i

    span = max(0, end_i - start_i)
    max_points_i = int(max_points) if int(max_points) > 0 else 2000
    step = max(1, int(span / max_points_i) if span else 1)

    temp_map = _query_series("kiln_temperature", start=start_i, end=end_i, step=step)
    if not temp_map:
        return []

    target_map = _query_series("kiln_target", start=start_i, end=end_i, step=step)
    power_map = _query_series("kiln_power_percent", start=start_i, end=end_i, step=step)

    samples: List[Dict[str, Optional[float]]] = []
    for t in sorted(temp_map.keys()):
        samples.append(
            {
                "t": t,
                "temp": temp_map.get(t),
                "target": target_map.get(t),
                "power_percent": power_map.get(t),
            }
        )
    return samples
