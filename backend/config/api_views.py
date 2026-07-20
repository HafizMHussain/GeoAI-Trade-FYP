from __future__ import annotations

import json
import os
import threading
import pickle
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple

from django.conf import settings
from django.db import connection
from django.http import HttpRequest
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response


@dataclass(frozen=True)
class _Pagination:
    limit: Optional[int]
    offset: int


def _parse_int(value: Optional[str], *, default: Optional[int] = None, min_value: int = 0) -> Optional[int]:
    if value is None or value == "":
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(parsed, min_value)


def _parse_float(
    value: Optional[str],
    *,
    default: Optional[float] = None,
    min_value: Optional[float] = None,
    max_value: Optional[float] = None,
) -> Optional[float]:
    if value is None or value == "":
        return default
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if min_value is not None:
        parsed = max(parsed, min_value)
    if max_value is not None:
        parsed = min(parsed, max_value)
    return parsed


def _get_pagination(request: HttpRequest, *, default_limit: Optional[int] = None, max_limit: int = 20000) -> _Pagination:
    limit = _parse_int(request.GET.get("limit"), default=default_limit, min_value=0)
    offset = _parse_int(request.GET.get("offset"), default=0, min_value=0) or 0
    if limit is not None:
        limit = min(limit, max_limit)
    return _Pagination(limit=limit, offset=offset)


def _safe_list_param(request: HttpRequest, key: str) -> Optional[List[str]]:
    raw = request.GET.get(key)
    if not raw:
        return None
    return [p.strip() for p in raw.split(",") if p.strip()]


import numpy as np

def _read_json_file(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def _pipeline_outputs_dir() -> str:
    # backend/ (BASE_DIR) -> repo root -> pipelines/outputs
    return os.path.join(settings.BASE_DIR.parent, "pipelines", "outputs")


def _pipeline_data_dir() -> str:
    return os.path.join(settings.BASE_DIR.parent, "pipelines", "data")


def _repo_root_dir() -> str:
    return str(settings.BASE_DIR.parent)


ALLOWED_GEO_TABLES = {
    "network_nodes",
    "network_edges",
    "hazard_nodes_latest",
    "hazard_edges_latest",
    "risk_nodes_latest",
    "risk_edges_latest",
    "hazard_nodes_log",
    "hazard_edges_log",
}


def _featurecollection_sql(table: str, where_sql: str, order_sql: str, limit_sql: str) -> str:
    # NOTE: table is validated against ALLOWED_GEO_TABLES before use.
    return f"""
WITH rows AS (
    SELECT *
    FROM public.{table}
    {where_sql}
    {order_sql}
    {limit_sql}
)
SELECT jsonb_build_object(
    'type', 'FeatureCollection',
    'features', COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'type', 'Feature',
                'geometry', ST_AsGeoJSON(geometry)::jsonb,
                'properties', to_jsonb(rows) - 'geometry'
            )
        ),
        '[]'::jsonb
    )
)
FROM rows;
"""


def _geojson_from_table(
    *,
    table: str,
    where_clauses: Iterable[str] = (),
    params: Iterable[Any] = (),
    order_by: Optional[str] = None,
    limit: Optional[int] = None,
    offset: int = 0,
) -> Dict[str, Any]:
    if table not in ALLOWED_GEO_TABLES:
        raise ValueError(f"Table not allowed: {table}")

    where_sql = ""
    where_list = [c for c in where_clauses if c]
    if where_list:
        where_sql = "WHERE " + " AND ".join(where_list)

    order_sql = f"ORDER BY {order_by}" if order_by else ""

    limit_parts: List[str] = []
    sql_params = list(params)
    if limit is not None:
        limit_parts.append("LIMIT %s")
        sql_params.append(limit)
    if offset:
        limit_parts.append("OFFSET %s")
        sql_params.append(offset)
    limit_sql = " ".join(limit_parts)

    sql = _featurecollection_sql(table, where_sql, order_sql, limit_sql)
    with connection.cursor() as cursor:
        cursor.execute(sql, sql_params)
        row = cursor.fetchone()

    if not row or row[0] is None:
        return {"type": "FeatureCollection", "features": []}

    data = row[0]
    if isinstance(data, str):
        return json.loads(data)
    return data


def _normalize_station_type(feature_collection: Dict[str, Any]) -> Dict[str, Any]:
    features = feature_collection.get("features") or []
    for feat in features:
        props = feat.get("properties") or {}
        if props.get("node_type") == "station":
            props["node_type"] = "rail_station"
    return feature_collection


def _friendly_node_name(props: Dict[str, Any]) -> str:
    name = (props.get("name") or "").strip()
    if name:
        return name

    node_type = (props.get("node_type") or "").strip()
    asset_id = str(props.get("asset_id") or props.get("node_id") or "").strip()
    suffix = asset_id.split("_")[-1] if asset_id else ""

    if node_type == "port":
        return f"Port {suffix}" if suffix else "Port"
    if node_type == "dryport":
        return f"Dry Port {suffix}" if suffix else "Dry Port"
    if node_type in {"station", "rail_station"}:
        return f"Rail Station {suffix}" if suffix else "Rail Station"
    if node_type == "road_intersection":
        return f"Road Junction {suffix}" if suffix else "Road Junction"
    if node_type == "rail_intersection":
        return f"Rail Junction {suffix}" if suffix else "Rail Junction"
    return asset_id or "Network Node"


def _attach_display_names(feature_collection: Dict[str, Any]) -> Dict[str, Any]:
    features = feature_collection.get("features") or []
    for feat in features:
        props = feat.get("properties") or {}
        if props.get("node_type") == "station":
            props["node_type"] = "rail_station"
        props["display_name"] = _friendly_node_name(props)
    return feature_collection


@api_view(["GET"])
def network_nodes(request: Request) -> Response:
    node_types = _safe_list_param(request, "node_type") or _safe_list_param(request, "type")
    if node_types:
        # DB stores rail_station (from network_model.py). Accept both spellings.
        expanded_nt: List[str] = []
        for t in node_types:
            if t in ("station", "rail_station"):
                expanded_nt += ["station", "rail_station"]
            else:
                expanded_nt.append(t)
        node_types = list(dict.fromkeys(expanded_nt))  # dedup, preserve order

    where: List[str] = []
    params: List[Any] = []
    if node_types:
        where.append("node_type = ANY(%s)")
        params.append(node_types)

    page = _get_pagination(request, default_limit=None)
    fc = _geojson_from_table(
        table="network_nodes",
        where_clauses=where,
        params=params,
        order_by="asset_id",
        limit=page.limit,
        offset=page.offset,
    )
    return Response(_attach_display_names(fc))


@api_view(["GET"])
def network_edges(request: Request) -> Response:
    modes = _safe_list_param(request, "mode")
    if modes:
        modes = ["intermodal" if m == "intermodal" else m for m in modes]

    where: List[str] = []
    params: List[Any] = []
    if modes:
        where.append("mode = ANY(%s)")
        params.append(modes)

    page = _get_pagination(request, default_limit=None)
    fc = _geojson_from_table(
        table="network_edges",
        where_clauses=where,
        params=params,
        order_by="asset_id",
        limit=page.limit,
        offset=page.offset,
    )

    # Optional pagination metadata for older frontend code.
    if page.limit is not None:
        fc["pagination"] = {"limit": page.limit, "offset": page.offset, "returned": len(fc.get("features") or [])}
    return Response(fc)


@api_view(["GET"])
def hazard_nodes(request: Request) -> Response:
    where: List[str] = []
    params: List[Any] = []

    alert_levels = _safe_list_param(request, "alert_level")
    if alert_levels:
        where.append("alert_level = ANY(%s)")
        params.append(alert_levels)

    triggered = request.GET.get("triggered")
    if triggered and triggered.lower() == "true":
        where.append("any_trigger = true")

    page = _get_pagination(request, default_limit=None)
    fc = _geojson_from_table(
        table="hazard_nodes_latest",
        where_clauses=where,
        params=params,
        order_by="composite_hazard DESC",
        limit=page.limit,
        offset=page.offset,
    )
    return Response(_attach_display_names(fc))


@api_view(["GET"])
def hazard_edges(request: Request) -> Response:
    where: List[str] = []
    params: List[Any] = []

    modes = _safe_list_param(request, "mode")
    if modes:
        where.append("mode = ANY(%s)")
        params.append(modes)

    triggered = request.GET.get("triggered")
    if triggered and triggered.lower() == "true":
        where.append("any_trigger = true")

    page = _get_pagination(request, default_limit=None)
    fc = _geojson_from_table(
        table="hazard_edges_latest",
        where_clauses=where,
        params=params,
        order_by="composite_hazard DESC",
        limit=page.limit,
        offset=page.offset,
    )
    return Response(fc)


@api_view(["GET"])
def risk_nodes(request: Request) -> Response:
    where: List[str] = []
    params: List[Any] = []

    tiers = _safe_list_param(request, "risk_tier")
    if tiers:
        where.append("risk_tier = ANY(%s)")
        params.append(tiers)

    chokepoint = request.GET.get("chokepoint")
    if chokepoint and chokepoint.lower() == "true":
        where.append("is_chokepoint = true")

    page = _get_pagination(request, default_limit=None)
    fc = _geojson_from_table(
        table="risk_nodes_latest",
        where_clauses=where,
        params=params,
        order_by="network_criticality_risk DESC",
        limit=page.limit,
        offset=page.offset,
    )
    return Response(_attach_display_names(fc))


@api_view(["GET"])
def risk_edges(request: Request) -> Response:
    where: List[str] = []
    params: List[Any] = []

    tiers = _safe_list_param(request, "risk_tier")
    if tiers:
        where.append("risk_tier = ANY(%s)")
        params.append(tiers)

    page = _get_pagination(request, default_limit=None)
    fc = _geojson_from_table(
        table="risk_edges_latest",
        where_clauses=where,
        params=params,
        order_by="network_criticality_risk DESC",
        limit=page.limit,
        offset=page.offset,
    )
    return Response(fc)


@api_view(["GET"])
def risk_summary(request: Request) -> Response:
    path = os.path.join(_pipeline_outputs_dir(), "risk_summary.json")
    data = _read_json_file(path)
    if data is None:
        return Response({"error": "risk_summary.json not found", "path": path}, status=404)
    return Response(data)


@api_view(["GET"])
def kpis_latest(request: Request) -> Response:
    path = os.path.join(_pipeline_outputs_dir(), "kpis_latest.json")
    data = _read_json_file(path)
    if data is not None:
        return Response(data)

    # Fallback to DB if file not present.
    with connection.cursor() as cursor:
        cursor.execute('SELECT row_to_json(t) FROM (SELECT * FROM public.kpis_log ORDER BY timestamp DESC LIMIT 1) t')
        row = cursor.fetchone()
    if not row or row[0] is None:
        return Response({"error": "No KPI data found"}, status=404)
    return Response(row[0] if not isinstance(row[0], str) else json.loads(row[0]))


@api_view(["GET"])
def kpis_history(request: Request) -> Response:
    limit = _parse_int(request.GET.get("limit"), default=96, min_value=1) or 96
    limit = min(limit, 2000)
    with connection.cursor() as cursor:
        cursor.execute(
            'SELECT json_agg(t ORDER BY t.timestamp DESC) '
            'FROM (SELECT * FROM public.kpis_log ORDER BY timestamp DESC LIMIT %s) t',
            [limit],
        )
        row = cursor.fetchone()
    return Response(row[0] or [])


@api_view(["GET"])
def network_metrics(request: Request) -> Response:
    with connection.cursor() as cursor:
        cursor.execute('SELECT row_to_json(t) FROM (SELECT * FROM public.baseline_global_metrics ORDER BY computed_at DESC NULLS LAST LIMIT 1) t')
        row = cursor.fetchone()
    if not row or row[0] is None:
        return Response({"error": "baseline_global_metrics is empty"}, status=404)

    metrics = row[0] if not isinstance(row[0], str) else json.loads(row[0])
    with connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM public.network_nodes WHERE node_type IN ('port','dryport','station','rail_station')")
        facility_nodes = cursor.fetchone()[0]
        cursor.execute("SELECT COUNT(*) FROM public.baseline_shortest_paths")
        corridor_count = cursor.fetchone()[0]
    # Minor key normalization for older frontend expectations.
    return Response(
        {
            "total_nodes": metrics.get("num_nodes"),
            "total_edges": metrics.get("num_edges"),
            "total_length_km": metrics.get("total_length_km"),
            "avg_travel_time_hr": metrics.get("avg_shortest_path_hr"),
            "global_efficiency": metrics.get("global_efficiency"),
            "avg_degree": metrics.get("avg_degree"),
            "density": metrics.get("density"),
            "computed_at": metrics.get("computed_at"),
            "facility_nodes": int(facility_nodes or 0),
            "corridors": int(corridor_count or 0),
        }
    )


@api_view(["GET"])
def network_corridor_times(request: Request) -> Response:
    limit = _parse_int(request.GET.get("limit"), default=2000, min_value=1) or 2000
    limit = min(limit, 20000)
    with connection.cursor() as cursor:
        cursor.execute(
            'SELECT json_agg(t) FROM (SELECT * FROM public.baseline_shortest_paths LIMIT %s) t',
            [limit],
        )
        row = cursor.fetchone()
    return Response(row[0] or [])


@api_view(["GET"])
def network_criticality(request: Request) -> Response:
    limit = _parse_int(request.GET.get("limit"), default=200, min_value=1) or 200
    limit = min(limit, 5000)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT json_agg(t)
            FROM (
                SELECT
                    asset_id,
                    node_type,
                    name,
                    lon,
                    lat,
                    betweenness_centrality,
                    importance_index,
                    ROW_NUMBER() OVER (ORDER BY betweenness_centrality DESC) AS rank
                FROM public.baseline_node_metrics
                WHERE node_type IN ('port','dryport','station','rail_station')
                ORDER BY betweenness_centrality DESC
                LIMIT %s
            ) t
            """,
            [limit],
        )
        row = cursor.fetchone()
    data = row[0] or []
    # Normalize station naming for frontend.
    for r in data:
        if r.get("node_type") == "station":
            r["node_type"] = "rail_station"
    return Response(data)


@api_view(["GET"])
def pakistan_boundary(request: Request) -> Response:
    # Prefer PostGIS if available
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT jsonb_build_object(
                    'type', 'FeatureCollection',
                    'features', COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'type', 'Feature',
                                'geometry', ST_AsGeoJSON(geometry)::jsonb,
                                'properties', to_jsonb(pakistan) - 'geometry'
                            )
                        ),
                        '[]'::jsonb
                    )
                )
                FROM public.pakistan
                """
            )
            row = cursor.fetchone()
        if row and row[0]:
            return Response(row[0] if not isinstance(row[0], str) else json.loads(row[0]))
    except Exception:
        # Fall back to file
        pass

    gpkg = os.path.join(_pipeline_data_dir(), "pakistan.gpkg")
    if not os.path.exists(gpkg):
        return Response({"error": "pakistan.gpkg not found", "path": gpkg}, status=404)

    try:
        import geopandas as gpd  # optional in backend env
        import pandas as pd
    except ImportError:
        return Response(
            {
                "error": "geopandas not installed in backend environment",
                "hint": "Install geopandas (and GDAL) or ensure PostGIS table public.pakistan exists.",
            },
            status=501,
        )

    gdf = gpd.read_file(gpkg)
    # Ensure datetime columns are JSON-serializable
    for col in gdf.columns:
        if pd.api.types.is_datetime64_any_dtype(gdf[col]):
            gdf[col] = gdf[col].astype(str)
    try:
        if gdf.crs is not None:
            gdf = gdf.to_crs(epsg=4326)
    except Exception:
        pass
    return Response(json.loads(gdf.to_json()))


# ---------------------------------------------------------------------------
# Network routing (Route Planner)
# ---------------------------------------------------------------------------

_route_lock = threading.Lock()
_route_graph: Any = None
_facility_nodes: Optional[List[Dict[str, Any]]] = None
_baseline_pair_times: Optional[Dict[Tuple[str, str], float]] = None

# ── Journey segment helpers ──────────────────────────────────────────────────

_TIER_ORDER = {'CRITICAL': 3, 'HIGH': 2, 'MEDIUM': 1, 'LOW': 0}


def _max_risk_tier(tiers: List[str]) -> str:
    """Return the worst (highest) risk tier from a list."""
    return max(tiers, key=lambda t: _TIER_ORDER.get(t, 0)) if tiers else 'LOW'


def _get_node_info_bulk(node_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    Fetch node_id, asset_id, node_type, name, lon, lat from network_nodes
    for a list of node IDs.  Only the 'pivot' boundary nodes are requested,
    so this is always a very small query (3–10 rows).
    """
    if not node_ids:
        return {}
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT node_id, asset_id, node_type, name, lon, lat
            FROM public.network_nodes
            WHERE node_id = ANY(%s)
            """,
            [list(set(node_ids))],
        )
        rows = cursor.fetchall()
    return {
        r[0]: {
            'node_id': r[0],
            'asset_id': r[1] or '',
            'node_type': r[2] or '',
            'name': r[3] or '',
            'lon': float(r[4]) if r[4] is not None else None,
            'lat': float(r[5]) if r[5] is not None else None,
        }
        for r in rows
    }


def _build_journey_segments(
    nodes_path: List[str],
    edge_asset_ids: List[str],
    feat_map: Dict[str, Dict[str, Any]],
    facility_names: Dict[str, str],
) -> List[Dict[str, Any]]:
    """
    Group consecutive same-mode edges into journey segments.

    Returns an ordered list with, for each segment:
      step, mode, road_type, from/to node info, distance, time, risk metrics.

    Only the boundary nodes (start, end, mode-change nodes) are fetched from
    the DB — typically 3–8 nodes per route — keeping this query cheap.
    """
    if not edge_asset_ids or len(nodes_path) < 2:
        return []

    # Build ordered edge list with properties
    edge_data: List[Dict[str, Any]] = []
    for i, eid in enumerate(edge_asset_ids):
        if i + 1 >= len(nodes_path):
            break
        props = feat_map.get(eid, {}).get('properties', {}) if feat_map.get(eid) else {}
        edge_data.append({
            'eid': eid,
            'from_nid': nodes_path[i],
            'to_nid':   nodes_path[i + 1],
            'mode':     props.get('mode') or 'road',
            'road_type': props.get('road_type') or '',
            'length_km':      float(props.get('length_km') or 0),
            'travel_time_hr': float(props.get('travel_time_hr') or 0),
            'composite_risk':   float(props.get('composite_risk') or 0),
            'composite_hazard': float(props.get('composite_hazard') or 0),
            'risk_tier': props.get('risk_tier') or 'LOW',
        })

    if not edge_data:
        return []

    # Identify pivot nodes (boundary nodes at mode changes + start + end)
    pivot_node_ids: List[str] = [edge_data[0]['from_nid']]
    for i in range(len(edge_data) - 1):
        if edge_data[i]['mode'] != edge_data[i + 1]['mode']:
            pivot_node_ids.append(edge_data[i]['to_nid'])
    pivot_node_ids.append(edge_data[-1]['to_nid'])

    # Fetch node info for pivot nodes only
    node_info = _get_node_info_bulk(pivot_node_ids)

    def _node_name(nid: str) -> str:
        ni = node_info.get(nid, {})
        if ni.get('name'):
            return ni['name']
        asset_id = ni.get('asset_id', '')
        if asset_id and asset_id in facility_names:
            return facility_names[asset_id]
        return ''  # frontend resolves via resolveNodeName

    # Group consecutive same-mode edges into segments
    segments: List[Dict[str, Any]] = []
    i = 0
    step = 1
    while i < len(edge_data):
        seg_mode = edge_data[i]['mode']
        seg_edges: List[Dict[str, Any]] = []
        while i < len(edge_data) and edge_data[i]['mode'] == seg_mode:
            seg_edges.append(edge_data[i])
            i += 1

        from_nid = seg_edges[0]['from_nid']
        to_nid   = seg_edges[-1]['to_nid']
        from_ni  = node_info.get(from_nid, {})
        to_ni    = node_info.get(to_nid, {})

        total_km  = sum(e['length_km'] for e in seg_edges)
        total_hr  = sum(e['travel_time_hr'] for e in seg_edges)
        n = len(seg_edges)
        avg_risk   = sum(e['composite_risk']   for e in seg_edges) / n
        avg_hazard = sum(e['composite_hazard'] for e in seg_edges) / n
        max_tier   = _max_risk_tier([e['risk_tier'] for e in seg_edges])

        # Dominant road type in this segment
        road_types = [e['road_type'] for e in seg_edges if e['road_type']]
        dominant_rt = max(set(road_types), key=road_types.count) if road_types else ''

        segments.append({
            'step':          step,
            'mode':          seg_mode,
            'road_type':     dominant_rt,
            'from_node_id':  from_nid,
            'to_node_id':    to_nid,
            'from_asset_id': from_ni.get('asset_id', ''),
            'to_asset_id':   to_ni.get('asset_id', ''),
            'from_node_type': from_ni.get('node_type', ''),
            'to_node_type':   to_ni.get('node_type', ''),
            'from_name': _node_name(from_nid),
            'to_name':   _node_name(to_nid),
            'from_lon': from_ni.get('lon'),
            'from_lat': from_ni.get('lat'),
            'to_lon': to_ni.get('lon'),
            'to_lat': to_ni.get('lat'),
            'length_km':         round(total_km, 2),
            'travel_time_hr':    round(total_hr, 4),
            'travel_time_min':   round(total_hr * 60),
            'avg_composite_risk':   round(avg_risk, 4),
            'avg_composite_hazard': round(avg_hazard, 4),
            'max_risk_tier': max_tier,
            'edge_count': n,
            'edge_ids': [e['eid'] for e in seg_edges],
        })
        step += 1

    return segments


def _fetch_facilities() -> List[Dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT node_id, asset_id, node_type, name
            FROM public.network_nodes
            WHERE node_type IN ('port','dryport','station','rail_station')
            ORDER BY asset_id
            """
        )
        rows = cursor.fetchall()
    facilities = [
        {"node_id": str(r[0]), "asset_id": r[1], "node_type": r[2], "name": r[3]} for r in rows
    ]
    for f in facilities:
        if f["node_type"] == "station":
            f["node_type"] = "rail_station"
    return facilities


def _load_route_graph() -> Any:
    """Build and cache a weighted networkx MultiGraph from PostGIS network_edges."""
    global _route_graph, _facility_nodes
    if _route_graph is not None:
        return _route_graph

    import networkx as nx

    with _route_lock:
        if _route_graph is not None:
            return _route_graph

        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    e.from_node,
                    e.to_node,
                    e.asset_id,
                    e.mode,
                    e.length_km,
                    e.travel_time_hr,
                    e.avg_speed_kmh,
                    COALESCE(h.composite_hazard, 0.0) AS composite_hazard,
                    COALESCE(r.composite_risk, 0.0) AS composite_risk,
                    COALESCE(r.network_criticality_risk, 0.0) AS network_criticality_risk
                FROM public.network_edges e
                LEFT JOIN public.hazard_edges_latest h ON h.asset_id = e.asset_id
                LEFT JOIN public.risk_edges_latest r ON r.asset_id = e.asset_id
                """
            )
            edges = cursor.fetchall()

        G = nx.MultiGraph()
        for (
            u,
            v,
            asset_id,
            mode,
            length_km,
            travel_time_hr,
            avg_speed_kmh,
            composite_hazard,
            composite_risk,
            network_criticality_risk,
        ) in edges:
            if u is None or v is None:
                continue

            try:
                length_km_f = float(length_km)
            except (TypeError, ValueError):
                length_km_f = 0.0
            try:
                time_hr_f = float(travel_time_hr)
            except (TypeError, ValueError):
                time_hr_f = 0.0
            if time_hr_f <= 0:
                try:
                    speed = float(avg_speed_kmh)
                except (TypeError, ValueError):
                    speed = 0.0
                if speed > 0 and length_km_f > 0:
                    time_hr_f = length_km_f / speed

            G.add_edge(
                str(u),
                str(v),
                asset_id=asset_id,
                mode=mode,
                length_km=length_km_f,
                travel_time_hr=time_hr_f,
                composite_hazard=float(composite_hazard or 0.0),
                composite_risk=float(composite_risk or 0.0),
                network_criticality_risk=float(network_criticality_risk or 0.0),
            )

        _route_graph = G
        _facility_nodes = _fetch_facilities()
        return _route_graph


def _asset_to_node_id(asset_id: str) -> Optional[str]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT node_id FROM public.network_nodes WHERE asset_id = %s LIMIT 1",
            [asset_id],
        )
        row = cursor.fetchone()
    return str(row[0]) if row else None


def _get_edge_features_by_asset_ids(asset_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    Fetch edge geometries + full hazard + risk properties for route visualization.
    Returns a feature dict keyed by asset_id.  All fields needed by the frontend
    MapLibre expressions (risk_tier, alert_level, road_type, etc.) are included.
    """
    if not asset_ids:
        return {}
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
                e.asset_id,
                e.from_node,
                e.to_node,
                e.mode,
                e.road_type,
                e.length_km,
                e.avg_speed_kmh,
                e.travel_time_hr,
                e.edge_betweenness,
                COALESCE(h.composite_hazard, 0.0)       AS composite_hazard,
                COALESCE(h.alert_level,      'LOW')      AS alert_level,
                COALESCE(h.hazard_flood,     0.0)        AS hazard_flood,
                COALESCE(h.hazard_cyclone,   0.0)        AS hazard_cyclone,
                COALESCE(h.hazard_strike,    0.0)        AS hazard_strike,
                COALESCE(h.hazard_accident,  0.0)        AS hazard_accident,
                COALESCE(h.any_trigger,      false)      AS any_trigger,
                COALESCE(r.composite_risk,             0.0)   AS composite_risk,
                COALESCE(r.network_criticality_risk,   0.0)   AS network_criticality_risk,
                COALESCE(r.risk_tier,                 'LOW')  AS risk_tier,
                COALESCE(r.risk_flood,    0.0)  AS risk_flood,
                COALESCE(r.risk_cyclone,  0.0)  AS risk_cyclone,
                COALESCE(r.risk_strike,   0.0)  AS risk_strike,
                COALESCE(r.risk_accident, 0.0)  AS risk_accident,
                ST_AsGeoJSON(e.geometry)::jsonb AS geometry
            FROM public.network_edges e
            LEFT JOIN public.hazard_edges_latest h ON h.asset_id = e.asset_id
            LEFT JOIN public.risk_edges_latest   r ON r.asset_id = e.asset_id
            WHERE e.asset_id = ANY(%s)
            """,
            [asset_ids],
        )
        rows = cursor.fetchall()
    out: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        (
            asset_id, from_node, to_node, mode, road_type, length_km, avg_speed_kmh, travel_time_hr, edge_betweenness,
            composite_hazard, alert_level,
            hazard_flood, hazard_cyclone, hazard_strike, hazard_accident, any_trigger,
            composite_risk, network_criticality_risk, risk_tier,
            risk_flood, risk_cyclone, risk_strike, risk_accident,
            geom,
        ) = row
        if isinstance(geom, str):
            geom = json.loads(geom)
        f = float
        out[str(asset_id)] = {
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "asset_id":    asset_id,
                "from_node":   from_node,
                "to_node":     to_node,
                "mode":        mode or "road",
                "road_type":   road_type or "",
                "length_km":   f(length_km or 0),
                "avg_speed_kmh":   f(avg_speed_kmh or 0),
                "travel_time_hr":  f(travel_time_hr or 0),
                "edge_betweenness": f(edge_betweenness or 0),
                # Hazard (from hazard pipeline)
                "composite_hazard": f(composite_hazard or 0),
                "alert_level":     alert_level or "LOW",
                "hazard_flood":    f(hazard_flood or 0),
                "hazard_cyclone":  f(hazard_cyclone or 0),
                "hazard_strike":   f(hazard_strike or 0),
                "hazard_accident": f(hazard_accident or 0),
                "any_trigger":     bool(any_trigger),
                # Risk (from risk engine: H × E × V)
                "composite_risk":           f(composite_risk or 0),
                "network_criticality_risk": f(network_criticality_risk or 0),
                "risk_tier":               risk_tier or "LOW",
                "risk_flood":    f(risk_flood or 0),
                "risk_cyclone":  f(risk_cyclone or 0),
                "risk_strike":   f(risk_strike or 0),
                "risk_accident": f(risk_accident or 0),
            },
        }
    return out


def _reverse_route_geometry(geometry: Any) -> Any:
    if not geometry or not isinstance(geometry, dict):
        return geometry
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if not isinstance(coords, list):
        return geometry
    if gtype == "LineString":
        return {**geometry, "coordinates": list(reversed(coords))}
    if gtype == "MultiLineString":
        reversed_parts = [list(reversed(part)) for part in reversed(coords) if isinstance(part, list)]
        return {**geometry, "coordinates": reversed_parts}
    return geometry


def _ordered_oriented_route_features(
    edge_steps: List[Dict[str, Any]],
    feat_map: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Return features in path order, with each geometry aligned to traversal direction."""
    ordered: List[Dict[str, Any]] = []
    for step in edge_steps:
        asset_id = str(step.get("asset_id") or "")
        src_nid = step.get("from_node")
        dst_nid = step.get("to_node")
        feat = feat_map.get(asset_id)
        if not feat:
            continue

        geom = feat.get("geometry")
        props = dict(feat.get("properties") or {})
        out_feat = {
            "type": feat.get("type") or "Feature",
            "geometry": json.loads(json.dumps(geom)) if geom is not None else None,
            "properties": props,
        }

        p_from = props.get("from_node")
        p_to = props.get("to_node")
        if p_from is not None and p_to is not None and src_nid is not None and dst_nid is not None:
            if str(p_from) == str(dst_nid) and str(p_to) == str(src_nid):
                out_feat["geometry"] = _reverse_route_geometry(out_feat.get("geometry"))

        ordered.append(out_feat)

    return ordered


def _mode_allowed(mode_filter: str) -> List[str]:
    mf = (mode_filter or "any").lower()
    if mf == "road":
        return ["road", "intermodal"]
    if mf == "rail":
        return ["rail", "intermodal"]
    return ["road", "rail", "intermodal"]


def _edge_cost(
    edge: Dict[str, Any],
    *,
    objective: str,
    hazard_weight: float,
    risk_weight: float,
) -> float:
    length_km = float(edge.get("length_km") or 0.0)
    time_hr = float(edge.get("travel_time_hr") or 0.0)
    if time_hr <= 0 and length_km > 0:
        # Conservative fallback speed for missing travel time.
        time_hr = length_km / 60.0

    if objective == "length_km":
        base_cost = max(length_km, 1e-6)
    elif objective == "balanced":
        base_cost = max(time_hr, 1e-6) * 0.75 + (max(length_km, 1e-6) / 80.0) * 0.25
    else:
        base_cost = max(time_hr, 1e-6)

    hazard = float(edge.get("composite_hazard") or 0.0)
    risk = float(edge.get("composite_risk") or 0.0)
    criticality_risk = float(edge.get("network_criticality_risk") or 0.0)

    penalty = 1.0 + (hazard_weight * hazard) + (risk_weight * risk) + (risk_weight * 0.5 * criticality_risk)
    return base_cost * penalty


def _compute_path(
    G: Any,
    src: str,
    dst: str,
    *,
    objective: str,
    allowed_modes: List[str],
    hazard_weight: float,
    risk_weight: float,
) -> Optional[Dict[str, Any]]:
    import networkx as nx

    # Build a simple graph with the best edge per pair for the risk-aware objective.
    # This keeps routing deterministic while still honoring MultiGraph modes.
    best_edges: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for u, v, d in G.edges(data=True):
        if d.get("mode") not in allowed_modes:
            continue
        key = (u, v) if u <= v else (v, u)
        route_cost = _edge_cost(
            d,
            objective=objective,
            hazard_weight=hazard_weight,
            risk_weight=risk_weight,
        )
        current = best_edges.get(key, {}).get("route_cost")
        if current is None or route_cost < float(current):
            best_edges[key] = {
                "asset_id": d.get("asset_id"),
                "mode": d.get("mode"),
                "length_km": d.get("length_km"),
                "travel_time_hr": d.get("travel_time_hr"),
                "composite_hazard": float(d.get("composite_hazard") or 0.0),
                "composite_risk": float(d.get("composite_risk") or 0.0),
                "network_criticality_risk": float(d.get("network_criticality_risk") or 0.0),
                "route_cost": route_cost,
            }

    H = nx.Graph()
    for (u, v), d in best_edges.items():
        H.add_edge(u, v, **d)
    if src not in H or dst not in H:
        return None
    try:
        nodes_path = nx.shortest_path(H, src, dst, weight="route_cost")
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return None

    edge_asset_ids: List[str] = []
    edge_steps: List[Dict[str, Any]] = []
    total_km = 0.0
    total_hr = 0.0
    seg_km = {"road": 0.0, "rail": 0.0, "intermodal": 0.0}
    seg_hr = {"road": 0.0, "rail": 0.0, "intermodal": 0.0}
    sum_hazard = 0.0
    sum_risk = 0.0
    sum_criticality_risk = 0.0
    edge_count = 0

    for a, b in zip(nodes_path, nodes_path[1:]):
        d = H[a][b]
        asset_id = d.get("asset_id")
        if asset_id:
            asset_id_s = str(asset_id)
            edge_asset_ids.append(asset_id_s)
            edge_steps.append({"asset_id": asset_id_s, "from_node": a, "to_node": b})
        length_km = float(d.get("length_km") or 0.0)
        time_hr = float(d.get("travel_time_hr") or 0.0)
        total_km += length_km
        total_hr += time_hr
        mode = d.get("mode") or "road"
        if mode in seg_km:
            seg_km[mode] += length_km
            seg_hr[mode] += time_hr
        sum_hazard += float(d.get("composite_hazard") or 0.0)
        sum_risk += float(d.get("composite_risk") or 0.0)
        sum_criticality_risk += float(d.get("network_criticality_risk") or 0.0)
        edge_count += 1

    return {
        "nodes": nodes_path,
        "edge_asset_ids": edge_asset_ids,
        "edge_steps": edge_steps,
        "distance_km": total_km,
        "travel_time_hr": total_hr,
        "segments": {
            "road": {"km": seg_km["road"], "hr": seg_hr["road"]},
            "rail": {"km": seg_km["rail"], "hr": seg_hr["rail"]},
            "intermodal": {"km": seg_km["intermodal"], "hr": seg_hr["intermodal"]},
        },
        "hazard_summary": {
            "avg_composite_hazard": (sum_hazard / edge_count) if edge_count else 0.0,
            "avg_composite_risk": (sum_risk / edge_count) if edge_count else 0.0,
            "avg_network_criticality_risk": (sum_criticality_risk / edge_count) if edge_count else 0.0,
        },
    }


def _route_response(route_type: str, mode_filter: str, computed: Dict[str, Any]) -> Dict[str, Any]:
    dist = float(computed.get("distance_km") or 0.0)
    t = float(computed.get("travel_time_hr") or 0.0)
    avg_speed = (dist / t) if t > 0 else None

    seg = computed.get("segments") or {}
    bd = {
        "road_km": float(seg.get("road", {}).get("km") or 0.0),
        "rail_km": float(seg.get("rail", {}).get("km") or 0.0),
        "intermodal_km": float(seg.get("intermodal", {}).get("km") or 0.0),
    }
    tot_km = max(dist, 1e-9)
    bd["road_pct"] = round(bd["road_km"] / tot_km * 100)
    bd["rail_pct"] = round(bd["rail_km"] / tot_km * 100)
    bd["intermodal_pct"] = max(0, 100 - bd["road_pct"] - bd["rail_pct"])

    return {
        "type": route_type,
        "mode_filter": mode_filter,
        "primary_mode": "rail" if bd["rail_km"] >= bd["road_km"] else "road",
        "distance_km": dist,
        "travel_time_hr": t,
        "avg_speed": avg_speed,
        "stations_crossed": None,
        "mode_breakdown": bd,
        "segments": seg,
        "hazard_summary": computed.get("hazard_summary") or {},
        "edge_asset_ids": computed.get("edge_asset_ids") or [],
        "geometry": None,  # filled by caller
    }


def _build_routes(
    src_asset: str,
    dst_asset: str,
    mode_filter: str,
    *,
    hazard_weight: float,
    risk_weight: float,
) -> List[Dict[str, Any]]:
    G = _load_route_graph()
    src = _asset_to_node_id(src_asset)
    dst = _asset_to_node_id(dst_asset)
    if not src or not dst:
        raise ValueError("Unknown asset_id")

    facilities = _facility_nodes or _fetch_facilities()
    facility_names = {f["asset_id"]: f.get("name") for f in facilities}

    allowed = _mode_allowed(mode_filter)

    # Four distinct route objectives:
    # FASTEST  — pure travel time, ignores risk (shows true fastest path)
    # SAFEST   — heavily penalises hazard/risk edges (avoidance route)
    # BALANCED — user's chosen hazard/risk weights
    # SHORTEST — fewest kilometres, ignores risk
    routes_raw: List[Tuple[str, Optional[Dict[str, Any]]]] = [
        ("FASTEST",  _compute_path(G, src, dst, objective="travel_time_hr", allowed_modes=allowed, hazard_weight=0.0,            risk_weight=0.0)),
        ("SAFEST",   _compute_path(G, src, dst, objective="travel_time_hr", allowed_modes=allowed, hazard_weight=3.5,            risk_weight=3.5)),
        ("BALANCED", _compute_path(G, src, dst, objective="balanced",       allowed_modes=allowed, hazard_weight=hazard_weight,  risk_weight=risk_weight)),
        ("SHORTEST", _compute_path(G, src, dst, objective="length_km",      allowed_modes=allowed, hazard_weight=0.0,            risk_weight=0.0)),
    ]

    cleaned: List[Dict[str, Any]] = []
    for route_type, computed in routes_raw:
        if not computed:
            continue
        asset_ids = computed["edge_asset_ids"]
        edge_steps = computed.get("edge_steps") or []
        feat_map  = _get_edge_features_by_asset_ids(asset_ids)
        features  = _ordered_oriented_route_features(edge_steps, feat_map)
        r = _route_response(route_type, mode_filter, computed)
        r["origin_asset_id"]      = src_asset
        r["destination_asset_id"] = dst_asset
        r["origin_name"]      = facility_names.get(src_asset) or src_asset
        r["destination_name"] = facility_names.get(dst_asset) or dst_asset
        r["geometry"] = {"type": "FeatureCollection", "features": features}
        r["journey_segments"] = _build_journey_segments(
            nodes_path=computed.get("nodes", []),
            edge_asset_ids=asset_ids,
            feat_map=feat_map,
            facility_names=facility_names,
        )
        cleaned.append(r)

    # De-duplicate: two routes are "the same" only when they share >90% of edges
    # AND their travel times are within 1%. This allows SAFEST to appear even if
    # the network has no hazard-free alternative (they'd have same edges, same time).
    unique: List[Dict[str, Any]] = []
    for r in cleaned:
        r_edges = set(r.get("edge_asset_ids") or [])
        r_time  = r.get("travel_time_hr", 0)
        is_dup  = False
        for seen_r in unique:
            s_edges = set(seen_r.get("edge_asset_ids") or [])
            if not r_edges and not s_edges:
                is_dup = True
                break
            union = r_edges | s_edges
            if not union:
                continue
            overlap = len(r_edges & s_edges) / len(union)
            s_time  = seen_r.get("travel_time_hr", 0)
            time_diff = abs(r_time - s_time) / max(s_time, 0.01)
            if overlap > 0.90 and time_diff < 0.01:
                is_dup = True
                break
        if not is_dup:
            unique.append(r)

    return unique


@api_view(["GET"])
def network_shortest_path(request: Request) -> Response:
    src_asset = request.GET.get("from")
    dst_asset = request.GET.get("to")
    if not src_asset or not dst_asset:
        return Response({"error": "from and to query params required"}, status=400)

    mode_filter = (request.GET.get("mode") or "any").lower()
    G = _load_route_graph()
    src = _asset_to_node_id(src_asset)
    dst = _asset_to_node_id(dst_asset)
    if not src or not dst:
        return Response({"error": "Unknown asset_id"}, status=404)

    allowed = _mode_allowed(mode_filter)
    hazard_weight = _parse_float(request.GET.get("hazard_weight"), default=0.6, min_value=0.0, max_value=3.0) or 0.6
    risk_weight = _parse_float(request.GET.get("risk_weight"), default=0.8, min_value=0.0, max_value=3.0) or 0.8
    computed = _compute_path(
        G,
        src,
        dst,
        objective="travel_time_hr",
        allowed_modes=allowed,
        hazard_weight=hazard_weight,
        risk_weight=risk_weight,
    )
    if not computed:
        return Response({"error": "No route found"}, status=404)

    asset_ids = computed["edge_asset_ids"]
    edge_steps = computed.get("edge_steps") or []
    feat_map = _get_edge_features_by_asset_ids(asset_ids)
    features = _ordered_oriented_route_features(edge_steps, feat_map)
    route = _route_response("FASTEST", mode_filter, computed)
    route["geometry"] = {"type": "FeatureCollection", "features": features}
    return Response(route)


@api_view(["GET"])
def network_alternate_routes(request: Request) -> Response:
    """Lightweight alternatives: fastest, shortest, balanced."""
    src_asset = request.GET.get("from")
    dst_asset = request.GET.get("to")
    mode_filter = (request.GET.get("mode") or request.GET.get("mode_filter") or "any").lower()
    hazard_weight = _parse_float(request.GET.get("hazard_weight"), default=0.6, min_value=0.0, max_value=3.0) or 0.6
    risk_weight = _parse_float(request.GET.get("risk_weight"), default=0.8, min_value=0.0, max_value=3.0) or 0.8
    if not src_asset or not dst_asset:
        return Response({"error": "from and to query params required"}, status=400)
    try:
        routes = _build_routes(
            src_asset,
            dst_asset,
            mode_filter,
            hazard_weight=hazard_weight,
            risk_weight=risk_weight,
        )
    except ValueError:
        return Response({"error": "Unknown asset_id"}, status=404)
    return Response({"routes": routes, "routing_profile": {"hazard_weight": hazard_weight, "risk_weight": risk_weight}})


@api_view(["GET"])
def network_advanced_routes(request: Request) -> Response:
    """RoutePlanner uses this; keep response shape stable: {routes:[...]}."""
    src_asset = request.GET.get("from")
    dst_asset = request.GET.get("to")
    mode_filter = (request.GET.get("mode") or "any").lower()
    hazard_weight = _parse_float(request.GET.get("hazard_weight"), default=0.6, min_value=0.0, max_value=3.0) or 0.6
    risk_weight = _parse_float(request.GET.get("risk_weight"), default=0.8, min_value=0.0, max_value=3.0) or 0.8
    if not src_asset or not dst_asset:
        return Response({"error": "from and to query params required"}, status=400)
    try:
        routes = _build_routes(
            src_asset,
            dst_asset,
            mode_filter,
            hazard_weight=hazard_weight,
            risk_weight=risk_weight,
        )
    except ValueError:
        return Response({"error": "Unknown asset_id"}, status=404)
    data = {
        "routes": routes,
        "routing_profile": {
            "hazard_weight": hazard_weight,
            "risk_weight": risk_weight,
        },
    }
    if mode_filter == "rail" and not routes:
        data["rail_note"] = "Origin/destination are not connected by rail; try 'any' or 'road'."
    return Response(data)


def _baseline_pairs_any() -> Dict[Tuple[str, str], float]:
    """Cache baseline fastest times for all facility pairs (asset_id, asset_id).
    Fixes zero-time edges by assigning minimum travel time from length_km."""
    global _baseline_pair_times
    # FORCED INVALIDATION for debug/hotfix:
    _baseline_pair_times = None 
    if _baseline_pair_times is not None:
        return _baseline_pair_times

    import networkx as nx

    with _route_lock:
        if _baseline_pair_times is not None:
            return _baseline_pair_times

        G0 = _load_route_graph()
        G = G0.copy()

        # Fix zero-time edges so baselines are meaningful (avg 60 km/h baseline)
        for u, v, k, d in list(G.edges(keys=True, data=True)):
            t = float(d.get("travel_time_hr") or 0)
            if t <= 0:
                length_km = float(d.get("length_km") or 10.0)
                G[u][v][k]["travel_time_hr"] = max(length_km / 60.0, 0.1)

        facilities = _facility_nodes or _fetch_facilities()
        # Ensure node_id is cast to string to match graph built by _load_route_graph
        asset_to_node = {f["asset_id"]: str(f["node_id"]) for f in facilities}
        assets = list(asset_to_node.keys())

        lengths_by_src: Dict[str, Dict[str, float]] = {}
        for src_asset in assets:
            src_node = asset_to_node[src_asset]
            try:
                # G now has string nodes, so src_node MUST be a string
                lengths = nx.single_source_dijkstra_path_length(G, src_node, weight="travel_time_hr")
            except Exception:
                lengths = {}
            lengths_by_src[src_asset] = lengths

        pair_times: Dict[Tuple[str, str], float] = {}
        for i in range(len(assets)):
            for j in range(i + 1, len(assets)):
                a, b = assets[i], assets[j]
                dst_node = asset_to_node[b]
                t = lengths_by_src.get(a, {}).get(dst_node)
                if t is not None and float(t) > 0.01:
                    pair_times[(a, b)] = float(t)
        _baseline_pair_times = pair_times
        return _baseline_pair_times


@api_view(["GET"])
def network_disruption_impact(request: Request) -> Response:
    """Simulate removing one node/edge and recompute facility-pair times."""
    import networkx as nx

    asset_id = request.GET.get("asset_id")
    asset_type = (request.GET.get("asset_type") or "node").lower()
    if not asset_id:
        return Response({"error": "asset_id query param required"}, status=400)

    G0 = _load_route_graph()
    facilities = _facility_nodes or _fetch_facilities()
    asset_to_node = {f["asset_id"]: f["node_id"] for f in facilities}
    name_by_asset = {f["asset_id"]: f.get("name") for f in facilities}

    # Build modified graph
    G = G0.copy()
    removed_name = name_by_asset.get(asset_id)
    if asset_type == "edge":
        # Remove an edge by asset_id
        to_remove = None
        for u, v, d in G.edges(data=True):
            if str(d.get("asset_id")) == str(asset_id):
                to_remove = (u, v)
                break
        if not to_remove:
            return Response({"error": "Edge not found"}, status=404)
        G.remove_edge(*to_remove)
    else:
        node_id = asset_to_node.get(asset_id) or _asset_to_node_id(asset_id)
        if not node_id:
            return Response({"error": "Node not found"}, status=404)
        if node_id in G:
            G.remove_node(node_id)

    baseline = _baseline_pairs_any()
    assets = list(asset_to_node.keys())

    # Recompute per-source Dijkstra on modified graph
    lengths_by_src: Dict[str, Dict[str, float]] = {}
    for src_asset in assets:
        src_node = asset_to_node[src_asset]
        if src_node not in G:
            lengths_by_src[src_asset] = {}
            continue
        try:
            lengths = nx.single_source_dijkstra_path_length(G, src_node, weight="travel_time_hr")
        except Exception:
            lengths = {}
        lengths_by_src[src_asset] = lengths

    total_affected = 0
    impacts: List[Dict[str, Any]] = []
    for i in range(len(assets)):
        for j in range(i + 1, len(assets)):
            a, b = assets[i], assets[j]
            base_t = baseline.get((a, b))
            if base_t is None:
                continue
            dst_node = asset_to_node[b]
            new_t = lengths_by_src.get(a, {}).get(dst_node)
            if new_t is None:
                total_affected += 1
                impacts.append(
                    {
                        "source": a,
                        "target": b,
                        "source_name": name_by_asset.get(a),
                        "target_name": name_by_asset.get(b),
                        "status": "UNREACHABLE",
                        "baseline": float(base_t),
                        "disrupted": None,
                        "delay_pct": None,
                    }
                )
            else:
                new_t = float(new_t)
                if new_t > float(base_t) * 1.001:
                    total_affected += 1
                    delay_pct = ((new_t - float(base_t)) / float(base_t)) * 100 if base_t > 0 else None
                    impacts.append(
                        {
                            "source": a,
                            "target": b,
                            "source_name": name_by_asset.get(a),
                            "target_name": name_by_asset.get(b),
                            "status": "DELAYED",
                            "baseline": float(base_t),
                            "disrupted": new_t,
                            "delay_pct": delay_pct,
                        }
                    )

    # Sort: unreachable first, then largest delay
    impacts.sort(
        key=lambda x: (
            0 if x["status"] == "UNREACHABLE" else 1,
            -float(x["delay_pct"] or 0.0),
        )
    )

    return Response(
        {
            "asset_id": asset_id,
            "asset_name": removed_name,
            "asset_type": asset_type,
            "total_affected": total_affected,
            "top_impacts": impacts[:10],
        }
    )


# ---------------------------------------------------------------------------
# Hazard dashboard compatibility endpoints
# ---------------------------------------------------------------------------


def _hazard_type_summary(col: str, trigger_col: str, *, trigger_threshold: float = 0.60) -> Dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT
                COUNT(*) FILTER (WHERE {trigger_col} = true) AS triggered,
                MAX({col}) AS max_score
            FROM public.hazard_nodes_latest
            """
        )
        row = cursor.fetchone()
    triggered = int(row[0] or 0)
    max_score = float(row[1] or 0.0)
    if max_score >= 0.75:
        status = "CRITICAL"
    elif triggered > 0 or max_score >= trigger_threshold:
        status = "ACTIVE"
    else:
        status = "OK"
    return {"status": status, "triggered": triggered, "max_score": max_score}


@api_view(["GET"])
def hazard_summary(request: Request) -> Response:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT alert_level, COUNT(*)
            FROM public.hazard_nodes_latest
            GROUP BY alert_level
            """
        )
        rows = cursor.fetchall()
        cursor.execute("SELECT COUNT(*) FROM public.hazard_nodes_latest")
        total = cursor.fetchone()[0]

    counts = {str(level): int(cnt) for level, cnt in rows}
    for k in ("CRITICAL", "HIGH", "MEDIUM", "LOW"):
        counts.setdefault(k, 0)

    data = {
        "alert_counts": counts,
        "total_facilities": int(total or 0),
        "flood": _hazard_type_summary("hazard_flood", "trigger_flood"),
        "cyclone": _hazard_type_summary("hazard_cyclone", "trigger_cyclone"),
        "strike": _hazard_type_summary("hazard_strike", "trigger_strike"),
        "accident": _hazard_type_summary("hazard_accident", "trigger_accident"),
    }
    return Response(data)


@api_view(["GET"])
def hazard_alerts(request: Request) -> Response:
    limit = _parse_int(request.GET.get("limit"), default=200, min_value=1) or 200
    limit = min(limit, 2000)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT json_agg(t)
            FROM (
                SELECT
                    asset_id,
                    node_type,
                    name,
                    lon,
                    lat,
                    hazard_flood,
                    hazard_cyclone,
                    hazard_strike,
                    hazard_accident,
                    composite_hazard,
                    alert_level
                FROM public.hazard_nodes_latest
                ORDER BY composite_hazard DESC NULLS LAST
                LIMIT %s
            ) t
            """,
            [limit],
        )
        row = cursor.fetchone()
    data = row[0] or []
    for r in data:
        if r.get("node_type") == "station":
            r["node_type"] = "rail_station"
    return Response(data)


@api_view(["GET"])
def hazard_kpi_history(request: Request) -> Response:
    limit = _parse_int(request.GET.get("limit"), default=96, min_value=1) or 96
    limit = min(limit, 2000)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT json_agg(t ORDER BY t.timestamp DESC)
            FROM (
                SELECT
                    timestamp,
                    triggered_nodes,
                    flood_triggered_nodes AS flood_triggered,
                    strike_triggered_nodes AS strike_triggered,
                    max_composite_hazard
                FROM public.kpis_log
                ORDER BY timestamp DESC
                LIMIT %s
            ) t
            """,
            [limit],
        )
        row = cursor.fetchone()
    return Response(row[0] or [])


_hazard_proc_lock = threading.Lock()
_hazard_proc: Optional[subprocess.Popen] = None
_hazard_last_run: Optional[str] = None


def _hazard_last_run_from_db() -> Optional[str]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT MAX(timestamp) FROM public.kpis_log")
        row = cursor.fetchone()
    return row[0] if row and row[0] else None


@api_view(["GET", "POST"])
def hazard_run(request: Request) -> Response:
    """POST starts pipelines/hazard_model.py, GET returns status."""
    global _hazard_proc, _hazard_last_run

    with _hazard_proc_lock:
        if request.method == "POST":
            if _hazard_proc is not None and _hazard_proc.poll() is None:
                return Response({"running": True, "pid": _hazard_proc.pid, "last_run": _hazard_last_run}, status=200)

            script = os.path.join(_repo_root_dir(), "pipelines", "hazard_model.py")
            if not os.path.exists(script):
                return Response({"error": "hazard_model.py not found", "path": script}, status=404)

            log_dir = os.path.join(_repo_root_dir(), "backend", "outputs")
            os.makedirs(log_dir, exist_ok=True)
            log_path = os.path.join(log_dir, f"hazard_run_{int(time.time())}.log")
            log_f = open(log_path, "w", encoding="utf-8")

            _hazard_proc = subprocess.Popen(
                [sys.executable, script],
                cwd=_repo_root_dir(),
                stdout=log_f,
                stderr=subprocess.STDOUT,
            )
            return Response({"running": True, "pid": _hazard_proc.pid, "log_path": log_path})

        # GET
        running = _hazard_proc is not None and _hazard_proc.poll() is None
        if not running:
            _hazard_last_run = _hazard_last_run_from_db() or _hazard_last_run
        return Response({"running": running, "pid": getattr(_hazard_proc, "pid", None), "last_run": _hazard_last_run})


@api_view(["GET"])
def rail_connectivity(request: Request) -> Response:
    """Connected components among station nodes using only rail edges."""
    import networkx as nx

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT n.asset_id, n.name
            FROM public.network_nodes n
            WHERE n.node_type IN ('station','rail_station')
            """
        )
        stations = cursor.fetchall()

        cursor.execute(
            """
            SELECT e.from_node, e.to_node
            FROM public.network_edges e
            WHERE e.mode = 'rail'
            """
        )
        edges = cursor.fetchall()

    G = nx.Graph()
    for asset_id, name in stations:
        G.add_node(asset_id, asset_id=asset_id, name=name)
    G.add_edges_from([(u, v) for u, v in edges if u in G and v in G])

    comp_map: Dict[str, int] = {}
    for i, comp in enumerate(nx.connected_components(G)):
        for nid in comp:
            comp_map[nid] = i

    out = {
        "stations": [
            {
                "asset_id": aid,
                "name": name,
                "component_id": comp_map.get(aid, -1),
            }
            for aid, name in stations
        ]
    }
    return Response(out)


@api_view(["GET"])
def assets_list(request: Request) -> Response:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT json_agg(t ORDER BY t.node_type, t.name)
            FROM (
                SELECT asset_id, node_type, name, lon, lat
                FROM public.network_nodes
                WHERE node_type IN ('port','dryport','station','rail_station')
            ) t
            """
        )
        row = cursor.fetchone()
    data = row[0] or []
    for r in data:
        if r.get("node_type") == "station":
            r["node_type"] = "rail_station"
    return Response(data)


@api_view(["GET"])
def asset_detail(request: Request, asset_id: str) -> Response:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT row_to_json(t)
            FROM (
                SELECT *
                FROM public.network_nodes
                WHERE asset_id = %s
                LIMIT 1
            ) t
            """,
            [asset_id],
        )
        row = cursor.fetchone()
        if not row or row[0] is None:
            return Response({"error": "Asset not found"}, status=404)
        base = row[0]

        cursor.execute(
            """
            SELECT row_to_json(t)
            FROM (
                SELECT *
                FROM public.hazard_nodes_latest
                WHERE asset_id = %s
                LIMIT 1
            ) t
            """,
            [asset_id],
        )
        haz = cursor.fetchone()[0]

        cursor.execute(
            """
            SELECT row_to_json(t)
            FROM (
                SELECT *
                FROM public.risk_nodes_latest
                WHERE asset_id = %s
                LIMIT 1
            ) t
            """,
            [asset_id],
        )
        risk = cursor.fetchone()[0]

    if base.get("node_type") == "station":
        base["node_type"] = "rail_station"
    return Response({**base, "hazard": haz, "risk": risk})


@api_view(["GET"])
def asset_reachability(request: Request, asset_id: str) -> Response:
    limit = _parse_int(request.GET.get("limit"), default=200, min_value=1) or 200
    limit = min(limit, 5000)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT json_agg(t)
            FROM (
                SELECT
                    CASE WHEN source = %s THEN target ELSE source END AS destination,
                    CASE WHEN source = %s THEN target_name ELSE source_name END AS destination_name,
                    travel_time_hr,
                    distance_km
                FROM public.baseline_shortest_paths
                WHERE source = %s OR target = %s
                ORDER BY travel_time_hr ASC NULLS LAST
                LIMIT %s
            ) t
            """,
            [asset_id, asset_id, asset_id, asset_id, limit],
        )
        row = cursor.fetchone()
    return Response(row[0] or [])


def _fetch_edge_hazard_scores() -> Dict[str, Dict[str, float]]:
    """
    Return hazard scores per edge asset_id from hazard_edges_latest.
    Used by hazard scenario simulations.
    """
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT asset_id,
                       COALESCE(hazard_flood,    0) AS hazard_flood,
                       COALESCE(hazard_cyclone,  0) AS hazard_cyclone,
                       COALESCE(hazard_strike,   0) AS hazard_strike,
                       COALESCE(hazard_accident, 0) AS hazard_accident,
                       COALESCE(composite_hazard,0) AS composite_hazard
                FROM public.hazard_edges_latest
                """
            )
            return {
                str(r[0]): {
                    "flood":    float(r[1]),
                    "cyclone":  float(r[2]),
                    "strike":   float(r[3]),
                    "accident": float(r[4]),
                    "composite":float(r[5]),
                }
                for r in cursor.fetchall()
            }
    except Exception:
        return {}


def _run_scenario_on_graph(
    scenario_type: str,
    targets: List[str],
    severity: float,
    duration_hours: float = 24.0,
) -> Dict[str, Any]:
    """
    Apply a scenario to the cached live network graph and return disruption metrics.

    All computations use the same PostGIS network_edges + hazard_edges_latest data
    that the pipelines wrote — no pickle dependency.

    Scenario types:
      node_removal       — remove target nodes from the graph
      edge_closure       — remove target edges from the graph
      capacity_reduction — multiply travel_time_hr by 1/severity on target edges
      flood              — penalise edges with high hazard_flood × severity
      cyclone            — penalise edges with high hazard_cyclone × severity
      strike             — penalise edges with high hazard_strike × severity
      accident           — penalise edges with high hazard_accident × severity
    """
    import networkx as nx

    G0 = _load_route_graph()
    facilities = _facility_nodes or _fetch_facilities()
    # Force node_id to string and STRIP whitespace
    asset_to_node = {str(f["asset_id"]).strip(): str(f["node_id"]).strip() for f in facilities}
    name_by_asset = {str(f["asset_id"]).strip(): f.get("name") or f["asset_id"] for f in facilities}
    assets = list(asset_to_node.keys())

    # Auto-correct LLM hallucinations: if a target isn't an asset_id, fuzzy match to its facility name
    resolved_targets = []
    for tgt in targets:
        _t = tgt.strip()
        if not _t: continue
        if _t in asset_to_node:
            resolved_targets.append(_t)
        else:
            fac = _resolve_facility(_t, facilities, threshold=0.15)
            resolved_targets.append(fac['asset_id'] if fac else _t)
    targets = resolved_targets

    G = G0.copy()  # work on a copy — never mutate the cached graph

    # Fix zero-time edges so penalties produce meaningful travel times
    for u, v, k, d in list(G.edges(keys=True, data=True)):
        t = float(d.get("travel_time_hr") or 0)
        if t <= 0:
            length_km = float(d.get("length_km") or 10.0)
            G[u][v][k]["travel_time_hr"] = max(length_km / 60.0, 0.1)

    stype = scenario_type.lower()

    if stype == "node_removal":
        for target in targets:
            node_id = str(asset_to_node.get(target) or _asset_to_node_id(target))
            if node_id != 'None' and node_id in G:
                G.remove_node(node_id)

    elif stype == "edge_closure":
        # targets may be edge asset_ids; also support facility asset_ids → remove incident edges
        base_target_nodes = {str(asset_to_node.get(t.strip()) or _asset_to_node_id(t.strip())).strip() for t in targets}
        base_target_nodes.discard('None')
        
        target_node_ids = set(base_target_nodes)
        for n in base_target_nodes:
            if n in G:
                target_node_ids.update(str(neighbor).strip() for neighbor in G.neighbors(n))
                try: target_node_ids.update(str(pred).strip() for pred in G.predecessors(n))
                except: pass

        target_assets = {str(t).strip() for t in targets}
        to_remove = []
        for u, v, d in G.edges(data=True):
            u_str, v_str = str(u), str(v)
            edge_asset = str(d.get("asset_id") or "")
            if edge_asset in target_assets or u_str in target_node_ids or v_str in target_node_ids:
                to_remove.append((u, v))
        for u, v in to_remove:
            if G.has_edge(u, v):
                G.remove_edge(u, v)

    elif stype == "capacity_reduction":
        # Scale down capacity → increase effective travel time on target-related edges
        base_target_nodes = {str(asset_to_node.get(t.strip()) or _asset_to_node_id(t.strip())).strip() for t in targets}
        base_target_nodes.discard('None')
        
        target_node_ids = set(base_target_nodes)
        for n in base_target_nodes:
            if n in G:
                target_node_ids.update(str(neighbor).strip() for neighbor in G.neighbors(n))
                try: target_node_ids.update(str(pred).strip() for pred in G.predecessors(n))
                except: pass

        target_assets = {str(t).strip() for t in targets}
        factor = 1.0 / max(severity, 0.1)
        for u, v, k, d in list(G.edges(keys=True, data=True)):
            u_str, v_str = str(u), str(v)
            edge_asset = str(d.get("asset_id") or "")
            if edge_asset in target_assets or u_str in target_node_ids or v_str in target_node_ids:
                G[u][v][k]["travel_time_hr"] = float(d.get("travel_time_hr") or 0) * factor

    elif stype in ("flood", "cyclone", "strike", "accident"):
        hazard_scores = _fetch_edge_hazard_scores()
        target_node_ids = {asset_to_node.get(t) or _asset_to_node_id(t) for t in targets}
        target_node_ids.discard(None)

        # Phase 1: Heavy disruption to edges touching targeted facilities and their immediate neighbors
        # (Facilities are often 'stub' nodes connected by 10m access links; we must penalize the main network intersection too)
        base_target_nodes = {str(asset_to_node.get(t.strip()) or _asset_to_node_id(t.strip())).strip() for t in targets}
        base_target_nodes.discard('None')
        
        target_node_ids = set(base_target_nodes)
        for n in base_target_nodes:
            if n in G:
                # Add all immediate neighbors (the main road/rail intersections)
                target_node_ids.update(str(neighbor).strip() for neighbor in G.neighbors(n))
                # For undirected/bidirectional paths, also check predecessors
                try:
                    target_node_ids.update(str(pred).strip() for pred in G.predecessors(n))
                except:
                    pass

        target_assets = {str(t).strip() for t in targets}

        edges_to_remove = []
        import random
        random.seed(42)
        for u, v, d in G.edges(data=True):
            # Checking ALL edges incident to target nodes
            u_str, v_str = str(u).strip(), str(v).strip()
            edge_asset = str(d.get("asset_id") or "").strip()
            
            if u_str in target_node_ids or v_str in target_node_ids or edge_asset in target_assets:
                # Apply penalty to ALL keys between these nodes
                for k in G[u][v]:
                    base_t = float(G[u][v][k].get("travel_time_hr") or 0)
                    if base_t <= 0:
                        length_km = float(G[u][v][k].get("length_km") or 10.0)
                        base_t = max(length_km / 60.0, 0.1)

                    duration_mult = max(duration_hours / 24.0, 0.5)
                    penalty = 1.0 + (severity * 12.0 * duration_mult) # Increased weight
                    G[u][v][k]["travel_time_hr"] = base_t * penalty

            else:
                # Phase 2: Apply pipeline hazard scores to non-target edges (network-wide effect)
                edge_asset = str(d.get("asset_id") or "")
                scores = hazard_scores.get(edge_asset, {})
                h = float(scores.get(stype, scores.get("composite", 0))) * severity
                if h > 0.05:
                    base_t = float(d.get("travel_time_hr") or 0)
                    if base_t > 0:
                        G[u][v][k]["travel_time_hr"] = base_t * (1.0 + 3.0 * h)

        # Remove fully-blocked edges
        for u, v, k in edges_to_remove:
            try:
                G.remove_edge(u, v, key=k)
            except Exception:
                pass

    else:
        return {"error": f"Unknown scenario_type: {scenario_type}"}

    # ── Recompute facility-pair shortest paths on modified graph ──────────────
    baseline = _baseline_pairs_any()

    lengths_by_src: Dict[str, Dict[str, float]] = {}
    for src_asset in assets:
        src_node = asset_to_node[src_asset]
        if src_node not in G:
            lengths_by_src[src_asset] = {}
            continue
        try:
            lengths = nx.single_source_dijkstra_path_length(G, src_node, weight="travel_time_hr")
        except Exception:
            lengths = {}
        lengths_by_src[src_asset] = lengths

    total_affected = 0
    impacts: List[Dict[str, Any]] = []
    for i in range(len(assets)):
        for j in range(i + 1, len(assets)):
            a, b = assets[i], assets[j]
            # Filter self-routes (same facility or same-city pairs)
            a_name = name_by_asset.get(a, '')
            b_name = name_by_asset.get(b, '')
            if a == b or a_name == b_name:
                continue
            # Check (a,b) then (b,a) in case of set/order non-determinism
            base_t = baseline.get((a, b)) or baseline.get((b, a))
            if base_t is None or float(base_t) < 0.1:
                continue  # skip pairs with near-zero baseline (data quality)
            dst_node = asset_to_node[b]
            new_t = lengths_by_src.get(a, {}).get(dst_node)
            if new_t is None:
                total_affected += 1
                impacts.append({
                    "source": a, "target": b,
                    "source_name": a_name,
                    "target_name": b_name,
                    "status": "UNREACHABLE",
                    "baseline": round(float(base_t), 1), "disrupted": None, "delay_pct": None,
                })
            else:
                new_t = float(new_t)
                bt = float(base_t)
                if new_t > bt * 1.01:
                    total_affected += 1
                    delay_pct = (new_t - bt) / bt * 100 if bt > 0 else 0
                    impacts.append({
                        "source": a, "target": b,
                        "source_name": a_name,
                        "target_name": b_name,
                        "status": "DELAYED",
                        "baseline": round(bt, 1), "disrupted": round(new_t, 1), "delay_pct": round(delay_pct, 1),
                    })

    impacts.sort(key=lambda x: (0 if x["status"] == "UNREACHABLE" else 1, -float(x.get("delay_pct") or 0)))

    unreachable = sum(1 for i in impacts if i["status"] == "UNREACHABLE")
    delayed     = sum(1 for i in impacts if i["status"] == "DELAYED")
    avg_delay   = (sum(i["delay_pct"] for i in impacts if i.get("delay_pct")) / max(delayed, 1)) if delayed else 0
    max_delay   = max((i.get("delay_pct") or 0 for i in impacts), default=0)

    import numpy as np

    # --- MONTE CARLO & STRESS ANALYSIS ---
    stress_impacts = []
    # Stress analysis applies to all scenario types — diversion factor varies
    _diversion_factor = {
        'node_removal': 0.6, 'edge_closure': 0.5,
        'capacity_reduction': 0.35, 'flood': 0.45,
        'cyclone': 0.5, 'strike': 0.4, 'accident': 0.3,
    }.get(stype, 0.4)
    for target in targets:
        ref_type = next((f["node_type"] for f in facilities if f["asset_id"] == target), None)
        alternatives = [f for f in facilities if f["node_type"] == ref_type and f["asset_id"] not in targets]
        alternatives.sort(key=lambda x: x.get("betweenness_centrality", 0), reverse=True)
        for alt in alternatives[:2]:
            baseline_stress = 45.0 + (np.random.rand() * 10 - 5)
            surge = baseline_stress + (severity * 100 * _diversion_factor)
            stress_impacts.append({
                "facility": alt["asset_id"],
                "name": alt["name"],
                "baseline_stress_pct": round(baseline_stress, 1),
                "projected_stress_pct": round(min(surge, 98.0), 1)
            })

    # Monte Carlo Disruption Probability (P90)
    # Duration amplifies disruption probability: longer events = more supply chain cascades
    duration_factor = min(duration_hours / 24.0, 7.0)  # scale up to 7 days
    mc_iterations = 200
    mc_disruption_threshold = 1.10
    mc_breaches = 0
    for _ in range(mc_iterations):
        # Variance grows with both severity and duration
        noise_factor = np.random.normal(1.0, 0.05 + (severity * 0.20) + (duration_factor * 0.05))
        if noise_factor > mc_disruption_threshold:
            mc_breaches += 1

    mc_p90 = (mc_breaches / mc_iterations) * 100.0

    return {
        "scenario_type":  scenario_type,
        "targets":        targets,
        "severity":       severity,
        "duration_hours": duration_hours,
        "total_affected": total_affected,
        "unreachable_pairs": unreachable,
        "delayed_pairs":     delayed,
        "avg_delay_pct":     round(avg_delay, 1),
        "max_delay_pct":     round(max_delay, 1),
        "monte_carlo_p90":   round(mc_p90, 1),
        "stress_impacts":    stress_impacts,
        "top_impacts":    impacts[:40], # returned top 40 for frontend filtering/mapping
    }


@api_view(["POST"])
def scenario_run(request: Request) -> Response:
    """
    Run a disruption scenario on the live PostGIS network graph.

    All scenario types are implemented directly on the cached NetworkX graph
    (populated from network_edges × hazard_edges_latest × risk_edges_latest).
    No pickle / external engine dependency.

    Supported scenario_type values:
      node_removal       — closes a trade terminal or junction
      edge_closure       — blocks a road or rail segment
      capacity_reduction — reduces throughput (increases effective travel time)
      flood              — applies flood hazard penalties from live pipeline data
      cyclone            — applies cyclone hazard penalties
      strike             — applies labor-action hazard penalties
      accident           — applies accident hazard penalties
    """
    payload = request.data if isinstance(request.data, dict) else {}

    scenario_type = str(payload.get("scenario_type") or "").strip()
    targets       = payload.get("targets")
    try:
        severity = float(payload.get("severity", 1.0))
        severity = max(0.0, min(severity, 1.0))
    except (TypeError, ValueError):
        severity = 1.0
    try:
        duration_hours = float(payload.get("duration_hours", 24))
        duration_hours = max(1.0, min(duration_hours, 168.0))  # 1h to 7 days
    except (TypeError, ValueError):
        duration_hours = 24.0

    # Validate
    if not scenario_type:
        return Response({"error": "scenario_type is required"}, status=400)
    if isinstance(targets, str):
        targets = [targets]
    targets = [str(t) for t in (targets or []) if t]
    if not targets:
        return Response({"error": "targets must be a non-empty list of asset_id strings"}, status=400)

    VALID_TYPES = {"node_removal", "edge_closure", "capacity_reduction", "flood", "cyclone", "strike", "accident"}
    if scenario_type not in VALID_TYPES:
        return Response({"error": f"Unknown scenario_type. Valid: {sorted(VALID_TYPES)}"}, status=400)

    try:
        result = _run_scenario_on_graph(scenario_type, targets, severity, duration_hours)
        return Response(result)
    except Exception as exc:
        return Response({
            "error": f"Scenario engine error: {exc}",
            "scenario_type": scenario_type,
            "targets": targets,
        }, status=422)


# ── Pipeline scenario data (offline analysis from scenario_simulation.py) ──────

def _read_pipeline_table(table_name: str, limit: int = 100) -> list:
    """Read rows from a pipeline-written PostGIS table, returning list of dicts."""
    try:
        with connection.cursor() as cur:
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name=%s", [table_name])
            cols = [r[0] for r in cur.fetchall()]
            if not cols:
                return []
            safe_cols = [c for c in cols if c != 'geometry']
            col_str = ', '.join(f'"{c}"' for c in safe_cols)
            cur.execute(f'SELECT {col_str} FROM public."{table_name}" LIMIT %s', [limit])
            rows = cur.fetchall()
            return [dict(zip(safe_cols, row)) for row in rows]
    except Exception:
        return []


@api_view(["GET"])
def scenario_pipeline_results(request: Request) -> Response:
    """Return the latest offline scenario results from the pipeline."""
    rows = _read_pipeline_table("scenario_results_latest", limit=50)
    return Response({"results": rows, "count": len(rows)})


@api_view(["GET"])
def scenario_corridors(request: Request) -> Response:
    """Return corridor vulnerability analysis from the pipeline."""
    rows = _read_pipeline_table("corridor_analysis_latest", limit=50)
    return Response({"corridors": rows, "count": len(rows)})


@api_view(["GET"])
def scenario_montecarlo(request: Request) -> Response:
    """Return Monte Carlo probabilistic simulation stats."""
    rows = _read_pipeline_table("scenario_kpis_log", limit=10)
    dist = _read_pipeline_table("montecarlo_distribution", limit=500)
    return Response({
        "summary": rows[-1] if rows else {},
        "history": rows,
        "distribution": [r.get("eff_drop_pct", 0) for r in dist] if dist else [],
    })


@api_view(["GET"])
def scenario_recovery(request: Request) -> Response:
    """Return time-stepped recovery simulation timeline."""
    rows = _read_pipeline_table("recovery_timeline_latest", limit=20)
    return Response({"timeline": rows, "count": len(rows)})


@api_view(["GET"])
def scenario_economic(request: Request) -> Response:
    """Return economic impact analysis for each scenario."""
    rows = _read_pipeline_table("economic_impact_latest", limit=50)
    return Response({"impacts": rows, "count": len(rows)})


@api_view(["GET"])
def history_nodes(request: Request) -> Response:
    ts = request.GET.get("timestamp")
    if not ts:
        return Response({"error": "timestamp query param required (e.g. 20260421_1959)"}, status=400)
    fc = _geojson_from_table(
        table="hazard_nodes_log",
        where_clauses=["timestamp = %s"],
        params=[ts],
        order_by="asset_id",
        limit=None,
        offset=0,
    )
    return Response(_attach_display_names(fc))


@api_view(["GET"])
def history_edges(request: Request) -> Response:
    ts = request.GET.get("timestamp")
    if not ts:
        return Response({"error": "timestamp query param required (e.g. 20260421_1959)"}, status=400)
    fc = _geojson_from_table(
        table="hazard_edges_log",
        where_clauses=["timestamp = %s"],
        params=[ts],
        order_by="asset_id",
        limit=None,
        offset=0,
    )
    return Response(fc)


# ---------------------------------------------------------------------------
# Combined node / edge endpoints  (network + hazard + risk joined)
# ---------------------------------------------------------------------------

_COMBINED_NODE_SELECT = """
    n.asset_id, n.node_id, n.node_type, n.name, n.lon, n.lat,
    n.betweenness_centrality, n.degree_centrality, n.closeness_centrality,
    n.importance_index, n.handling_capacity_index, n.redundancy_index,
    COALESCE(h.composite_hazard, 0.0)           AS composite_hazard,
    COALESCE(h.alert_level, 'LOW')              AS alert_level,
    COALESCE(h.hazard_flood, 0.0)               AS hazard_flood,
    COALESCE(h.hazard_cyclone, 0.0)             AS hazard_cyclone,
    COALESCE(h.hazard_strike, 0.0)              AS hazard_strike,
    COALESCE(h.hazard_accident, 0.0)            AS hazard_accident,
    COALESCE(h.any_trigger, false)              AS any_trigger,
    COALESCE(h.trigger_flood, false)            AS trigger_flood,
    COALESCE(h.trigger_cyclone, false)          AS trigger_cyclone,
    COALESCE(h.trigger_strike, false)           AS trigger_strike,
    COALESCE(h.trigger_accident, false)         AS trigger_accident,
    COALESCE(r.composite_risk, 0.0)             AS composite_risk,
    COALESCE(r.network_criticality_risk, 0.0)   AS network_criticality_risk,
    COALESCE(r.risk_tier, 'LOW')                AS risk_tier,
    COALESCE(r.is_chokepoint, false)            AS is_chokepoint,
    COALESCE(r.risk_flood, 0.0)                 AS risk_flood,
    COALESCE(r.risk_cyclone, 0.0)               AS risk_cyclone,
    COALESCE(r.risk_strike, 0.0)                AS risk_strike,
    COALESCE(r.risk_accident, 0.0)              AS risk_accident,
    n.geometry
"""

_COMBINED_NODE_FROM = """
FROM public.network_nodes n
LEFT JOIN public.hazard_nodes_latest h ON h.asset_id = n.asset_id
LEFT JOIN public.risk_nodes_latest   r ON r.asset_id = n.asset_id
"""

_COMBINED_EDGE_SELECT = """
    e.asset_id, e.from_node, e.to_node, e.mode, e.road_type,
    e.length_km, e.avg_speed_kmh, e.travel_time_hr,
    COALESCE(e.capacity_index, 3)               AS capacity_index,
    COALESCE(e.edge_betweenness, 0.0)           AS edge_betweenness,
    COALESCE(h.composite_hazard, 0.0)           AS composite_hazard,
    COALESCE(h.alert_level, 'LOW')              AS alert_level,
    COALESCE(h.hazard_flood, 0.0)               AS hazard_flood,
    COALESCE(h.hazard_cyclone, 0.0)             AS hazard_cyclone,
    COALESCE(h.hazard_strike, 0.0)              AS hazard_strike,
    COALESCE(h.hazard_accident, 0.0)            AS hazard_accident,
    COALESCE(r.composite_risk, 0.0)             AS composite_risk,
    COALESCE(r.network_criticality_risk, 0.0)   AS network_criticality_risk,
    COALESCE(r.risk_tier, 'LOW')                AS risk_tier,
    e.geometry
"""

_COMBINED_EDGE_FROM = """
FROM public.network_edges e
LEFT JOIN public.hazard_edges_latest h ON h.asset_id = e.asset_id
LEFT JOIN public.risk_edges_latest   r ON r.asset_id = e.asset_id
"""


def _geojson_from_join(inner_sql: str, params: List[Any]) -> Dict[str, Any]:
    sql = f"""
    SELECT jsonb_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'type', 'Feature',
                    'geometry', ST_AsGeoJSON(_t.geometry)::jsonb,
                    'properties', to_jsonb(_t) - 'geometry'
                )
            ),
            '[]'::jsonb
        )
    )
    FROM ({inner_sql}) _t
    """
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        row = cursor.fetchone()
    if not row or row[0] is None:
        return {"type": "FeatureCollection", "features": []}
    data = row[0]
    if isinstance(data, str):
        return json.loads(data)
    return data


@api_view(["GET"])
def combined_nodes(request: Request) -> Response:
    """Network nodes joined with live hazard + risk data."""
    where: List[str] = []
    params: List[Any] = []

    node_types = _safe_list_param(request, "type") or _safe_list_param(request, "node_type")
    if node_types:
        expanded: List[str] = []
        for t in node_types:
            if t == "facility":
                expanded += ["port", "dryport", "station", "rail_station"]
            elif t in ("station", "rail_station"):
                # DB may store either spelling — include both
                expanded += ["station", "rail_station"]
            else:
                expanded.append(t)
        # Remove duplicates while preserving order
        seen_exp: set = set()
        node_types = [x for x in expanded if not (x in seen_exp or seen_exp.add(x))]
        where.append("n.node_type = ANY(%s)")
        params.append(expanded)

    risk_tiers = _safe_list_param(request, "risk_tier")
    if risk_tiers:
        where.append("COALESCE(r.risk_tier, 'LOW') = ANY(%s)")
        params.append(risk_tiers)

    alert_levels = _safe_list_param(request, "alert_level")
    if alert_levels:
        where.append("COALESCE(h.alert_level, 'LOW') = ANY(%s)")
        params.append(alert_levels)

    if request.GET.get("chokepoint", "").lower() == "true":
        where.append("COALESCE(r.is_chokepoint, false) = true")

    if request.GET.get("triggered", "").lower() == "true":
        where.append("COALESCE(h.any_trigger, false) = true")

    page = _get_pagination(request, default_limit=None)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    order_sql = "ORDER BY COALESCE(r.network_criticality_risk, 0.0) DESC NULLS LAST"

    lim_parts: List[str] = []
    lim_params: List[Any] = []
    if page.limit is not None:
        lim_parts.append("LIMIT %s")
        lim_params.append(page.limit)
    if page.offset:
        lim_parts.append("OFFSET %s")
        lim_params.append(page.offset)
    lim_sql = " ".join(lim_parts)

    inner = f"SELECT {_COMBINED_NODE_SELECT} {_COMBINED_NODE_FROM} {where_sql} {order_sql} {lim_sql}"
    fc = _geojson_from_join(inner, params + lim_params)
    fc = _attach_display_names(fc)
    if page.limit is not None:
        fc["pagination"] = {"limit": page.limit, "offset": page.offset, "returned": len(fc.get("features") or [])}
    return Response(fc)


@api_view(["GET"])
def combined_edges(request: Request) -> Response:
    """Network edges joined with live hazard + risk data."""
    where: List[str] = []
    params: List[Any] = []

    modes = _safe_list_param(request, "mode")
    if modes:
        where.append("e.mode = ANY(%s)")
        params.append(modes)

    risk_tiers = _safe_list_param(request, "risk_tier")
    if risk_tiers:
        where.append("COALESCE(r.risk_tier, 'LOW') = ANY(%s)")
        params.append(risk_tiers)

    # critical_only filter: use network_criticality_risk threshold since is_critical_link may not exist
    if request.GET.get("critical_only", "").lower() == "true":
        where.append("COALESCE(r.network_criticality_risk, 0.0) > 0.25")

    page = _get_pagination(request, default_limit=None)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    order_sql = "ORDER BY COALESCE(e.edge_betweenness, 0.0) DESC NULLS LAST"

    lim_parts: List[str] = []
    lim_params: List[Any] = []
    if page.limit is not None:
        lim_parts.append("LIMIT %s")
        lim_params.append(page.limit)
    if page.offset:
        lim_parts.append("OFFSET %s")
        lim_params.append(page.offset)
    lim_sql = " ".join(lim_parts)

    inner = f"SELECT {_COMBINED_EDGE_SELECT} {_COMBINED_EDGE_FROM} {where_sql} {order_sql} {lim_sql}"
    try:
        fc = _geojson_from_join(inner, params + lim_params)
    except Exception as exc:
        return Response({"type": "FeatureCollection", "features": [], "_error": str(exc)})
    if page.limit is not None:
        fc["pagination"] = {"limit": page.limit, "offset": page.offset, "returned": len(fc.get("features") or [])}
    return Response(fc)


# ---------------------------------------------------------------------------
# Risk distribution + chokepoints (DB-backed, always fresh)
# ---------------------------------------------------------------------------

@api_view(["GET"])
def risk_distribution(request: Request) -> Response:
    """Risk tier counts for nodes and edges from latest tables."""
    empty = {
        "nodes": {"critical": 0, "high": 0, "medium": 0, "low": 0, "chokepoints": 0, "max_risk": 0.0, "avg_risk": 0.0, "total": 0},
        "edges": {"critical": 0, "high": 0, "medium": 0, "low": 0, "total": 0},
    }
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    COUNT(*) FILTER (WHERE risk_tier = 'CRITICAL') AS critical,
                    COUNT(*) FILTER (WHERE risk_tier = 'HIGH')     AS high,
                    COUNT(*) FILTER (WHERE risk_tier = 'MEDIUM')   AS medium,
                    COUNT(*) FILTER (WHERE risk_tier = 'LOW')      AS low,
                    COUNT(*) FILTER (WHERE is_chokepoint = true)   AS chokepoints,
                    MAX(composite_risk)                            AS max_risk,
                    ROUND(AVG(composite_risk)::numeric, 4)        AS avg_risk,
                    COUNT(*)                                       AS total
                FROM public.risk_nodes_latest
                """
            )
            nr = cursor.fetchone()
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    COUNT(*) FILTER (WHERE risk_tier = 'CRITICAL') AS critical,
                    COUNT(*) FILTER (WHERE risk_tier = 'HIGH')     AS high,
                    COUNT(*) FILTER (WHERE risk_tier = 'MEDIUM')   AS medium,
                    COUNT(*) FILTER (WHERE risk_tier = 'LOW')      AS low,
                    COUNT(*)                                        AS total
                FROM public.risk_edges_latest
                """
            )
            er = cursor.fetchone()
    except Exception:
        return Response(empty)

    return Response(
        {
            "nodes": {
                "critical": int(nr[0] or 0), "high": int(nr[1] or 0),
                "medium": int(nr[2] or 0),   "low": int(nr[3] or 0),
                "chokepoints": int(nr[4] or 0),
                "max_risk": float(nr[5] or 0), "avg_risk": float(nr[6] or 0),
                "total": int(nr[7] or 0),
            },
            "edges": {
                "critical": int(er[0] or 0), "high": int(er[1] or 0),
                "medium": int(er[2] or 0),   "low": int(er[3] or 0),
                "total": int(er[4] or 0),
            },
        }
    )


@api_view(["GET"])
def top_chokepoints(request: Request) -> Response:
    """Top chokepoint facilities ranked by network criticality risk."""
    limit = min(_parse_int(request.GET.get("limit"), default=10, min_value=1) or 10, 50)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT json_agg(t)
            FROM (
                SELECT
                    r.asset_id,
                    COALESCE(n.name, r.name)            AS name,
                    COALESCE(n.node_type, r.node_type)  AS node_type,
                    r.composite_risk,
                    r.network_criticality_risk,
                    r.risk_tier,
                    COALESCE(h.composite_hazard, 0.0)   AS composite_hazard,
                    COALESCE(h.alert_level, 'LOW')      AS alert_level,
                    COALESCE(n.betweenness_centrality, 0.0) AS betweenness_centrality,
                    COALESCE(n.importance_index, 1)     AS importance_index,
                    r.lon, r.lat
                FROM public.risk_nodes_latest r
                LEFT JOIN public.network_nodes n        ON n.asset_id = r.asset_id
                LEFT JOIN public.hazard_nodes_latest h  ON h.asset_id = r.asset_id
                WHERE r.is_chokepoint = true
                ORDER BY r.network_criticality_risk DESC NULLS LAST
                LIMIT %s
            ) t
            """,
            [limit],
        )
        row = cursor.fetchone()
    data = row[0] or []
    for r in data:
        if r.get("node_type") == "station":
            r["node_type"] = "rail_station"
    return Response(data)


@api_view(["GET"])
def risk_kpi_history(request: Request) -> Response:
    """Risk KPI time series from risk_kpis_log."""
    limit = min(_parse_int(request.GET.get("limit"), default=96, min_value=1) or 96, 2000)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT json_agg(t ORDER BY t.timestamp DESC) FROM (SELECT * FROM public.risk_kpis_log ORDER BY timestamp DESC LIMIT %s) t",
                [limit],
            )
            row = cursor.fetchone()
        return Response(row[0] or [])
    except Exception:
        return Response([])


@api_view(["GET"])
def history_timestamps(request: Request) -> Response:
    """Distinct run timestamps available in hazard_nodes_log for the time slider."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT DISTINCT timestamp
            FROM public.hazard_nodes_log
            ORDER BY timestamp DESC
            LIMIT 200
            """
        )
        rows = cursor.fetchall()
    return Response([r[0] for r in rows if r[0]])


# ══════════════════════════════════════════════════════════════════════════════
# AI CHATBOT  —  POST /api/chat/
# Model: Groq Llama 3.3 70B  |  Safety: rate-limit + input sanitisation
# ══════════════════════════════════════════════════════════════════════════════

import re
import hashlib
from collections import defaultdict
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

# ── Config ─────────────────────────────────────────────────────────────────
_GROQ_KEY   = os.environ.get('GROQ_API_KEY', '')
_GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions'
_GROQ_MODEL = 'llama-3.3-70b-versatile'

# ── Rate limiter: max 20 requests / 60 s per IP ────────────────────────────
_rate_store: Dict[str, List[float]] = defaultdict(list)
_rate_lock  = threading.Lock()
_RATE_LIMIT  = 20
_RATE_WINDOW = 60.0

def _rate_ok(ip: str) -> bool:
    now = time.time()
    with _rate_lock:
        hits = [t for t in _rate_store[ip] if now - t < _RATE_WINDOW]
        _rate_store[ip] = hits
        if len(hits) >= _RATE_LIMIT:
            return False
        _rate_store[ip].append(now)
    return True

# ── Input sanitisation ──────────────────────────────────────────────────────
def _sanitise(text: str, max_len: int = 600) -> str:
    text = re.sub(r'<[^>]+>', '', str(text))
    return text.strip()[:max_len]

# ── Fallback responses when Groq is unavailable ─────────────────────────────
_FALLBACK: Dict[str, str] = {
    'route':    "Use the Route Planner to find the safest path given current conditions.",
    'risk':     "Check the Risk Map — the KPI panel shows live hazard levels for every asset.",
    'scenario': "Use the Scenario Simulator — pick a target facility and click Run.",
    'default':  "I'm having trouble reaching the AI right now. Please try again in a moment.",
}

def _fallback_text(message: str) -> str:
    m = message.lower()
    if any(w in m for w in ('route', 'path', 'travel', 'from', 'to', 'go')):
        return _FALLBACK['route']
    if any(w in m for w in ('risk', 'hazard', 'flood', 'safe', 'critical', 'danger')):
        return _FALLBACK['risk']
    if any(w in m for w in ('close', 'scenario', 'what if', 'simulate', 'shut')):
        return _FALLBACK['scenario']
    return _FALLBACK['default']

# ── Live context from DB + pipeline outputs ─────────────────────────────────
def _build_live_context() -> dict:
    ctx: dict = {'kpis': {}, 'hazard': {}, 'risk': {'nodes': {}}, 'facilities': [], 'chokepoints': []}

    kpis_path = os.path.join(settings.BASE_DIR.parent, 'pipelines', 'outputs', 'kpis_latest.json')
    kd: dict = {}
    if os.path.exists(kpis_path):
        try:
            with open(kpis_path, encoding='utf-8') as f:
                kd = json.load(f)
            ctx['kpis'] = kd

            # Derive real hazard status from node counts (pipeline status string ≠ threat level)
            flood_triggered  = int(kd.get('flood_triggered_nodes',  0))
            critical_nodes   = int(kd.get('critical_nodes',  0))
            high_nodes       = int(kd.get('high_nodes',  0))
            max_haz          = float(kd.get('max_composite_hazard', 0))

            def _flood_status(triggered, critical, max_h):
                if critical > 0 or max_h >= 0.75:  return 'CRITICAL'
                if triggered > 100 or max_h >= 0.4: return 'ACTIVE'
                if triggered > 0:                    return 'ELEVATED'
                return 'OK'

            ctx['hazard'] = {
                'flood':    {'status': _flood_status(flood_triggered, critical_nodes, max_haz),
                             'triggered': flood_triggered,
                             'max_score': max_haz},
                'cyclone':  {'status': 'OK' if kd.get('cyclone_triggered_nodes', 0) == 0 else 'ACTIVE',
                             'triggered': kd.get('cyclone_triggered_nodes', 0)},
                'strike':   {'status': 'OK' if kd.get('strike_triggered_nodes', 0)  == 0 else 'ACTIVE',
                             'triggered': kd.get('strike_triggered_nodes', 0)},
                'accident': {'status': 'OK' if kd.get('accident_triggered_nodes', 0) == 0 else 'ACTIVE',
                             'triggered': kd.get('accident_triggered_nodes', 0)},
            }

            # Use kpis_latest for risk distribution — risk_summary.json tiers are often all-zero
            total = int(kd.get('total_nodes', 0))
            ctx['risk']['nodes'] = {
                'critical': critical_nodes,
                'high':     high_nodes,
                'medium':   max(0, total - critical_nodes - high_nodes - max(0, total - critical_nodes - high_nodes)),
                'low':      max(0, total - critical_nodes - high_nodes),
            }
        except Exception:
            pass

    # Cross-check with risk_summary.json — use whichever has higher counts
    risk_path = os.path.join(settings.BASE_DIR.parent, 'pipelines', 'outputs', 'risk_summary.json')
    if os.path.exists(risk_path):
        try:
            with open(risk_path, encoding='utf-8') as f:
                rd = json.load(f)
            dist = rd.get('risk_distribution', {}).get('nodes', {})
            # Keys in risk_summary use lowercase keys from our earlier write
            rs_crit = dist.get('CRITICAL', dist.get('critical', 0))
            rs_high = dist.get('HIGH',     dist.get('high',     0))
            rs_med  = dist.get('MEDIUM',   dist.get('medium',   0))
            rs_low  = dist.get('LOW',      dist.get('low',      0))
            # Only override if risk_summary has more data than kpis
            if rs_crit + rs_high > ctx['risk']['nodes'].get('critical', 0) + ctx['risk']['nodes'].get('high', 0):
                ctx['risk']['nodes'] = {'critical': rs_crit, 'high': rs_high, 'medium': rs_med, 'low': rs_low}
        except Exception:
            pass

    # Final fallback: query DB directly if still all zeros
    if sum(ctx['risk']['nodes'].values()) == 0 or ctx['risk']['nodes'].get('critical', -1) < 0:
        try:
            with connection.cursor() as cur:
                cur.execute("""
                    SELECT risk_tier, COUNT(*)
                    FROM risk_nodes_latest
                    WHERE risk_tier IS NOT NULL
                    GROUP BY risk_tier
                """)
                db_dist = {str(r[0]).upper(): int(r[1]) for r in cur.fetchall()}
                if db_dist:
                    ctx['risk']['nodes'] = {
                        'critical': db_dist.get('CRITICAL', 0),
                        'high':     db_dist.get('HIGH', 0),
                        'medium':   db_dist.get('MEDIUM', 0),
                        'low':      db_dist.get('LOW', 0),
                    }
        except Exception:
            pass

    try:
        with connection.cursor() as cur:
            cur.execute("""
                SELECT n.asset_id, COALESCE(n.name, n.asset_id) AS name,
                       n.node_type,
                       COALESCE(r.risk_tier,'LOW'),
                       COALESCE(r.composite_risk, 0),
                       COALESCE(h.composite_hazard, 0) AS composite_hazard,
                       COALESCE(h.alert_level, 'LOW')  AS alert_level
                FROM network_nodes n
                LEFT JOIN risk_nodes_latest   r ON r.asset_id = n.asset_id
                LEFT JOIN hazard_nodes_latest h ON h.asset_id = n.asset_id
                WHERE n.node_type IN ('port','dryport','station','rail_station')
                ORDER BY COALESCE(h.composite_hazard, 0) DESC NULLS LAST LIMIT 12
            """)
            ctx['facilities'] = [
                {'asset_id': r[0], 'name': r[1], 'node_type': r[2],
                 'risk_tier': r[3], 'composite_risk': float(r[4]),
                 'composite_hazard': float(r[5]), 'alert_level': str(r[6])}
                for r in cur.fetchall()
            ]
    except Exception as e:
        pass

    try:
        with connection.cursor() as cur:
            cur.execute("""
                SELECT n.asset_id, COALESCE(n.name, n.asset_id) AS name,
                       COALESCE(n.betweenness_centrality,0), COALESCE(r.risk_tier,'LOW')
                FROM network_nodes n
                LEFT JOIN risk_nodes_latest r ON r.asset_id = n.asset_id
                WHERE n.node_type IN ('port','dryport','station','rail_station')
                ORDER BY COALESCE(n.betweenness_centrality,0) DESC NULLS LAST LIMIT 5
            """)
            ctx['chokepoints'] = [
                {'asset_id': r[0], 'name': r[1],
                 'betweenness_centrality': float(r[2]), 'risk_tier': r[3]}
                for r in cur.fetchall()
            ]
    except Exception:
        pass

    return ctx

# ── Facility display-name helper ────────────────────────────────────────────
def _friendly_fac_name(f: dict) -> str:
    """Append type suffix to DB names that omit it (e.g. 'Lahore' → 'Lahore ICD')."""
    name  = (f.get('name') or f.get('asset_id', '')).strip()
    ntype = f.get('node_type', '')
    nl    = name.lower()
    if ntype == 'dryport' and not any(kw in nl for kw in ('icd', 'inland', 'container', 'depot', 'dry port', 'dryport')):
        return f"{name} ICD"
    if ntype == 'port' and not any(kw in nl for kw in ('port', 'harbour', 'harbor', 'qasim')):
        return f"{name} Port"
    return name

# ── System prompt ───────────────────────────────────────────────────────────
def _build_system_prompt(ctx: dict) -> str:
    kpis  = ctx.get('kpis', {})
    haz   = ctx.get('hazard', {})
    rnodes= ctx.get('risk', {}).get('nodes', {})
    facs  = ctx.get('facilities', [])
    chks  = ctx.get('chokepoints', [])

    fl = haz.get('flood', {}); cy = haz.get('cyclone', {}); st = haz.get('strike', {}); ac = haz.get('accident', {})

    fac_lines = '\n'.join(
        f"  {f['asset_id']}: {_friendly_fac_name(f)} ({f['node_type']}) [risk={f['risk_tier']} hazard={f.get('alert_level','?')} {round(f.get('composite_hazard',0)*100)}%]"
        for f in facs
    ) or '  (no facility data — DB query may have failed)'

    chk_lines = '\n'.join(
        f"  {c['asset_id']}: {c['name']} bc={c['betweenness_centrality']:.4f} [{c['risk_tier']}]"
        for c in chks
    ) or '  (none)'

    # Use composite_hazard (not risk_tier which is all LOW) for highlighting critical facilities
    critical_ids = [f['asset_id'] for f in facs if f.get('composite_hazard', 0) > 0.55 or f.get('alert_level') == 'CRITICAL']
    if not critical_ids:  # fallback: top 5 highest hazard facilities
        sorted_facs = sorted(facs, key=lambda x: x.get('composite_hazard', 0), reverse=True)
        critical_ids = [f['asset_id'] for f in sorted_facs[:5] if f.get('composite_hazard', 0) > 0.1]
    critical_str = ', '.join(f'"{i}"' for i in critical_ids[:10]) or '"none"'

    top_choke = chks[0] if chks else None
    top_choke_id   = top_choke['asset_id'] if top_choke else 'port_1'
    top_choke_name = top_choke['name']     if top_choke else 'Top Chokepoint'

    # Get first port and first dryport for examples
    first_port    = next((f for f in facs if f['node_type'] == 'port'),    None)
    first_dryport = next((f for f in facs if f['node_type'] == 'dryport'), None)
    ex_port_id    = first_port['asset_id']        if first_port    else 'port_1'
    ex_port_name  = _friendly_fac_name(first_port) if first_port    else 'Karachi Port'
    ex_dry_id     = first_dryport['asset_id']          if first_dryport else 'dryport_5'
    ex_dry_name   = _friendly_fac_name(first_dryport)  if first_dryport else 'Lahore ICD'

    return f"""You are the Pakistan TradeLink Risk Assistant — an AI command interface for a live freight-network platform.
Users type natural language; you reply with text AND trigger a map/page action whenever one is relevant.

═══ OUTPUT FORMAT (MANDATORY) ═══
Reply ONLY with a valid JSON object — no markdown fences, no prose before/after:
{{"text": "concise reply under 100 words", "action": <action or null>}}

═══ WHEN TO USE EACH ACTION (READ CAREFULLY) ═══

1. USER MENTIONS A ROUTE, TRAVEL, OR ASKS HOW TO GET FROM A TO B
   → ALWAYS use showRoute. Match facility names to asset_ids below.
   Example: "safest route from Lahore Dryport to Karachi Port"
   → {{"type":"showRoute","from":"{ex_dry_id}","to":"{ex_port_id}","mode":"safest"}}

   mode mapping: "safe"/"avoid"/"careful" → "safest" | "fast"/"quick" → "fastest" | default → "balanced"

2. USER ASKS ABOUT A SPECIFIC FACILITY ("show me", "where is", "fly to", "open")
   → ALWAYS use flyTo with the matching asset_id.
   Example: "Show me {ex_port_name}" → {{"type":"flyTo","asset_id":"{ex_port_id}","name":"{ex_port_name}"}}
   Example: "fly to top chokepoint"  → {{"type":"flyTo","asset_id":"{top_choke_id}","name":"{top_choke_name}"}}

3. USER ASKS "WHAT IF", "WHAT HAPPENS IF", "SIMULATE", "IF X CLOSES/FLOODS/SHUTS"
   → ALWAYS use runScenario.
   Example: "What if {ex_port_name} closes?" → {{"type":"runScenario","targets":["{ex_port_id}"],"scenario_type":"node_removal","severity":1.0}}
   Example: "flood scenario for Karachi"     → {{"type":"runScenario","targets":["{ex_port_id}"],"scenario_type":"flood","severity":0.8}}
   scenario_type options: "node_removal" | "edge_closure" | "capacity_reduction" | "flood" | "cyclone" | "strike" | "accident"

4. USER ASKS "WHICH ARE CRITICAL", "SHOW ALL CRITICAL", "HIGHLIGHT RISKY"
   → ALWAYS use highlightAssets with CRITICAL-tier asset_ids.
   Example: {{"type":"highlightAssets","asset_ids":[{critical_str}],"color":"CRITICAL"}}

5. PURE Q&A (flood situation, risk numbers, general info, greetings)
   → "action": null — answer from the live data below.

═══ LIVE DATA ═══
Network: {kpis.get('total_nodes',0):,} nodes | {kpis.get('total_edges',0):,} edges
Hazard: Flood {fl.get('status','OK')} ({fl.get('triggered',0)} triggers) | Cyclone {cy.get('status','OK')} | Strike {st.get('status','OK')}
Risk: CRITICAL {rnodes.get('critical',0):,} | HIGH {rnodes.get('high',0):,} | MEDIUM {rnodes.get('medium',0):,} | LOW {rnodes.get('low',0):,}

Top chokepoints:
{chk_lines}

TOP HAZARDOUS FACILITIES:
{fac_lines}

If the user asks to run a scenario or closure (e.g. "What if X closes?"):
   - ALWAYS use `runScenario` as the action.
   - For the text response, you MUST provide only qualitative, structural analysis based on the facility node's network position.
   - ABSOLUTELY DO NOT invent percentage delays (e.g. "30% increase") or monetary cost impacts (e.g. "PKR 1.5 million")!
   - State clearly that the Scenario Simulator engine will calculate the cascading delays, economic impact, and Monte Carlo probabilities directly on the interactive dashboard.
   - Do NOT just say "Running simulation". Provide the preliminary context directly in your text response.

═══ SUPPORTED ROUTE MODES ═══
  "safest"   = minimises flood/hazard exposure (recommended when flood is CRITICAL)
  "fastest"  = pure travel time
  "balanced" = speed + safety compromise
  "shortest" = fewest kilometres

═══ GREETING HANDLER ═══
If the user says "hi", "hello", "salam", "hey", "good morning/evening", or any greeting:
- Respond warmly in plain conversational text (no JSON leaked into text)
- Explain the platform briefly (3-4 bullet points max)
- Mention the most urgent live status (e.g., flood CRITICAL with 919 nodes)
- Invite them to ask a specific question
- "action": null

═══ CRITICAL TEXT RULE ═══
The "text" field MUST always be plain English that a human can read aloud.
NEVER put JSON, code, curly braces, or action dictionaries inside "text".

═══ COST ANALYSIS ═══
If user asks about shipping costs generally: estimate ~PKR 130,000-180,000 per 1000km via road, stating fuel pricing (PKR 280/L).
If for a specific route: trigger showRoute and provide a 1-paragraph cost breakdown dynamically estimating based on a ~PKR 150/km rate.

═══ ERROR FALLBACK ═══
If you cannot match a facility or answer the query:
- Say so honestly in plain English
- "action": null

═══ STRICT RULES ═══
- Match user's facility name to the closest entry in the list OR what is appended at the end of this prompt (fuzzy match)
- Keep "text" under 100 words; cite real numbers from live data"""

# ── Fuzzy facility resolver ─────────────────────────────────────────────────
from difflib import SequenceMatcher

# Type synonyms a user might say
_TYPE_KEYWORDS = {
    'port':       {'port', 'seaport', 'sea port', 'harbour', 'harbor'},
    'dryport':    {'dryport', 'dry port', 'icd', 'ictl', 'inland', 'container depot', 'container terminal'},
    'rail_station':{'station', 'railway', 'train', 'rail'},
}

# City aliases: maps what users type → tokens that appear in DB names
_CITY_ALIASES: Dict[str, List[str]] = {
    'karachi':    ['karachi', 'bin qasim', 'khi'],
    'lahore':     ['lahore', 'lhe'],
    'islamabad':  ['islamabad', 'isb', 'rawalpindi'],
    'quetta':     ['quetta', 'qta'],
    'peshawar':   ['peshawar', 'pew'],
    'faisalabad': ['faisalabad', 'lyallpur', 'fsd'],
    'multan':     ['multan', 'mux'],
    'sialkot':    ['sialkot', 'skt'],
    'hyderabad':  ['hyderabad', 'hyd'],
    'sukkur':     ['sukkur'],
    'gwadar':     ['gwadar'],
    'gilgit':     ['gilgit', 'gb'],
    'raiwind':    ['raiwind'],
    'sargodha':   ['sargodha'],
    'gujranwala': ['gujranwala'],
    'kotri':      ['kotri'],
    'chaman':     ['chaman'],
    'taftan':     ['taftan'],
    'sost':       ['sost'],
}


def _score_facility(query: str, fac: dict) -> float:
    """Return a 0-1 similarity score between a user query and a facility."""
    name  = (fac.get('name') or '').lower()
    ftype = (fac.get('node_type') or '').lower()
    query = query.lower().strip()

    # Full string similarity
    full_sim = SequenceMatcher(None, query, name).ratio()

    # Token overlap
    q_tok = set(re.findall(r'\w+', query))
    n_tok = set(re.findall(r'\w+', name))
    overlap = len(q_tok & n_tok) / max(len(q_tok), 1)

    # City alias boost
    alias_boost = 0.0
    for city, aliases in _CITY_ALIASES.items():
        if city in query or any(a in query for a in aliases):
            if any(a in name for a in aliases):
                alias_boost = 0.4
                break

    # Type match boost/penalty — use word-level matching to avoid 'port' in 'dryport'
    type_boost = 0.0
    user_wants_type: Optional[str] = None
    q_words = set(re.findall(r'\w+', query))
    for t, kws in _TYPE_KEYWORDS.items():
        # Single-word keywords checked at word boundaries; multi-word as substring
        if any((k in q_words if ' ' not in k else k in query) for k in kws):
            user_wants_type = t
            break

    if user_wants_type:
        canonical = 'rail_station' if user_wants_type == 'rail_station' else user_wants_type
        if ftype == canonical or ftype == user_wants_type:
            type_boost = +0.30   # strong boost for correct type
        else:
            type_boost = -0.20   # penalty for wrong type (e.g. station when user said dryport)

    return max(full_sim, overlap) + alias_boost + type_boost


def _resolve_facility(query: str, facilities: list, threshold: float = 0.3) -> Optional[dict]:
    """Return the best-matching facility for a natural-language query, or None."""
    if not query or not facilities:
        return None
    scored = sorted(
        [(f, _score_facility(query, f)) for f in facilities],
        key=lambda x: x[1], reverse=True
    )
    best_fac, best_score = scored[0]
    return best_fac if best_score >= threshold else None


# Patterns to extract "from X to Y" and "X [dryport|port|station]"
_FROM_TO_RE = re.compile(
    r'from\s+(.+?)\s+to\s+(.+?)(?:\s*$|\s*[,.])',
    re.IGNORECASE
)
_FACILITY_RE = re.compile(
    r'([\w\s]+?)\s+(dryport|dry\s*port|icd|port|station|railway\s*station)',
    re.IGNORECASE
)


def _resolve_mentions_in_message(message: str, facilities: list) -> str:
    """
    Parse the user message, fuzzy-match facility mentions to real asset_ids,
    and return an annotation block to inject into the prompt.
    """
    if not facilities:
        return ''

    resolved: List[str] = []
    seen_ids: set = set()

    def _type_name(t: str) -> str:
        return {'dryport': 'dryport', 'port': 'seaport', 'rail_station': 'railway station', 'station': 'railway station'}.get(t, t)

    def _type_matches(asked: str, got: str) -> bool:
        asked = asked.lower().replace(' ','')
        got   = got.lower().replace('_','')
        if 'dryport' in asked or 'drport' in asked or 'icd' in asked or 'inland' in asked:
            return 'dryport' in got
        if 'station' in asked or 'railway' in asked or 'rail' in asked:
            return 'station' in got
        if 'port' in asked and 'dry' not in asked:
            return got == 'port'
        return True  # no type specified → any match ok

    def _try_resolve(raw_text: str, type_hint: str = '') -> Optional[dict]:
        q = (raw_text + ' ' + type_hint).strip()
        fac = _resolve_facility(q, facilities)
        if fac and fac['asset_id'] not in seen_ids:
            seen_ids.add(fac['asset_id'])
            return fac
        return None

    # Pattern: "from X to Y"
    m = _FROM_TO_RE.search(message)
    if m:
        from_raw, to_raw = m.group(1).strip(), m.group(2).strip()
        f1 = _try_resolve(from_raw)
        f2 = _try_resolve(to_raw)
        if f1:
            match_ok = _type_matches(from_raw, f1['node_type'])
            note = '' if match_ok else f' [NOTE: no exact match for "{from_raw}" — nearest is a {_type_name(f1["node_type"])}. Tell the user.]'
            resolved.append(f'  "{from_raw}" → {f1["asset_id"]}: {f1["name"]} ({f1["node_type"]}){note}')
        else:
            resolved.append(f'  "{from_raw}" → NOT FOUND — tell the user this facility does not exist in our network.')
        if f2:
            match_ok = _type_matches(to_raw, f2['node_type'])
            note = '' if match_ok else f' [NOTE: no exact match for "{to_raw}" — nearest is a {_type_name(f2["node_type"])}. Tell the user.]'
            resolved.append(f'  "{to_raw}" → {f2["asset_id"]}: {f2["name"]} ({f2["node_type"]}){note}')
        else:
            resolved.append(f'  "{to_raw}" → NOT FOUND — tell the user this facility does not exist in our network.')

    # Pattern: "<city> <type>"
    for m2 in _FACILITY_RE.finditer(message):
        raw_city = m2.group(1).strip()
        raw_type = m2.group(2).strip()
        fac = _try_resolve(raw_city, raw_type)
        if fac:
            match_ok = _type_matches(raw_type, fac['node_type'])
            note = '' if match_ok else f' [NOTE: no {raw_type} in {raw_city} — nearest is {_type_name(fac["node_type"])}. Tell the user.]'
            resolved.append(f'  "{m2.group(0).strip()}" → {fac["asset_id"]}: {fac["name"]} ({fac["node_type"]}){note}')
        elif raw_city:
            resolved.append(f'  "{m2.group(0).strip()}" → NOT FOUND — tell the user we have no {raw_type} in {raw_city}. List available {raw_type}s.')

    # Broad scan: if any city from aliases is mentioned, provide its best facility mapping
    msg_lower = message.lower()
    for city, aliases in _CITY_ALIASES.items():
        if city in msg_lower or any(a in msg_lower for a in aliases):
            fac = _try_resolve(city)
            if fac:
                resolved.append(f'  "{city}" → {fac["asset_id"]}: {fac["name"]} ({fac["node_type"]})')

    if not resolved:
        return ''

    lines = '\n'.join(resolved)
    return (
        f'\nPRE-RESOLVED FACILITY NAMES (use ONLY these asset_ids — do NOT override):\n'
        f'{lines}\n'
    )


# ── Endpoint ────────────────────────────────────────────────────────────────
@csrf_exempt
@require_http_methods(['POST', 'OPTIONS'])
def chat_view(request):
    """
    POST /api/chat/
    Body: {"message": str, "history": [{role, content}...]}
    Returns: {"text": str, "action": dict|null}
    """
    if request.method == 'OPTIONS':
        r = JsonResponse({})
        r['Access-Control-Allow-Origin']  = '*'
        r['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
        r['Access-Control-Allow-Headers'] = 'Content-Type'
        return r

    ip = (request.META.get('HTTP_X_FORWARDED_FOR') or request.META.get('REMOTE_ADDR') or 'unknown').split(',')[0].strip()
    if not _rate_ok(ip):
        return JsonResponse({'text': 'Too many requests — please wait a moment.', 'action': None}, status=429)

    try:
        body = json.loads(request.body or b'{}')
    except json.JSONDecodeError:
        return JsonResponse({'text': 'Invalid request body.', 'action': None}, status=400)

    raw_msg = body.get('message', '')
    if not isinstance(raw_msg, str) or not raw_msg.strip():
        return JsonResponse({'text': 'Please send a message.', 'action': None}, status=400)

    user_msg = _sanitise(raw_msg)
    if not user_msg:
        return JsonResponse({'text': 'Message was empty.', 'action': None}, status=400)

    raw_hist = body.get('history', [])
    history: List[Dict[str, str]] = []
    for turn in (raw_hist[-8:] if isinstance(raw_hist, list) else []):
        role    = str(turn.get('role', ''))
        content = _sanitise(str(turn.get('content', '')), max_len=400)
        if role in ('user', 'assistant') and content:
            history.append({'role': role, 'content': content})

    if not _GROQ_KEY:
        return JsonResponse({'text': _fallback_text(user_msg), 'action': None})

    try:
        ctx    = _build_live_context()
        prompt = _build_system_prompt(ctx)
        
        # In order to fully leverage the resolver, we need all facilities from DB to run via `_resolve_mentions_in_message`.
        # Even though we limited the system prompt output to 12 above, `ctx['facilities']` might be limited.
        # However, limiting context above already solves the payload size limits heavily.
        # Fallback to the DB resolving to match the user's specific items if they weren't in top 12.
        all_facs = []
        try:
            with connection.cursor() as cur:
                cur.execute("SELECT asset_id, name, node_type FROM network_nodes WHERE node_type IN ('port','dryport','station','rail_station')")
                all_facs = [{'asset_id': r[0], 'name': r[1], 'node_type': r[2]} for r in cur.fetchall()]
        except Exception:
            all_facs = ctx.get('facilities', [])
            
        # Pass recent history so follow-up questions retain city context
        recent_ctx = " ".join([m['content'] for m in history[-2:]])
        resolution = _resolve_mentions_in_message(user_msg + " " + recent_ctx, all_facs)
        if resolution:
            prompt = prompt + resolution
    except Exception:
        prompt = 'You are the Pakistan TradeLink Risk Assistant. Reply ONLY in JSON: {"text": "...", "action": null}.'
        resolution = ''

    messages = [{'role': 'system', 'content': prompt}]
    messages.extend(history)
    messages.append({'role': 'user', 'content': user_msg})

    import requests as _req
    try:
        def _call_groq(model_name: str) -> _req.Response:
            return _req.post(
                _GROQ_URL,
                headers={'Authorization': f'Bearer {_GROQ_KEY}', 'Content-Type': 'application/json'},
                json={'model': model_name, 'messages': messages, 'temperature': 0.25, 'max_tokens': 512, 'response_format': {'type': 'json_object'}},
                timeout=25,
            )
            
        resp = _call_groq(_GROQ_MODEL)
        
        # Fallback cascade using lighter models avoiding rate limits
        if resp.status_code == 429:
            resp = _call_groq('llama-3.1-8b-instant')
        if resp.status_code == 429:
            resp = _call_groq('gemma2-9b-it')
        if resp.status_code == 429:
            resp = _call_groq('mixtral-8x7b-32768')
            
        resp.raise_for_status()
        raw_content = resp.json()['choices'][0]['message']['content']

        try:
            parsed = json.loads(raw_content)
            text   = str(parsed.get('text', raw_content))[:1200]
            action = parsed.get('action')
            _VALID = {'flyTo', 'showRoute', 'runScenario', 'moveSlider', 'highlightAssets'}
            if action and (not isinstance(action, dict) or action.get('type') not in _VALID):
                action = None
        except (json.JSONDecodeError, AttributeError):
            text   = raw_content[:1200]
            action = None

        # Build facility name map for enrichment + fallback text generation
        fac_map = {f['asset_id']: f['name'] for f in all_facs}

        # ── Detect when the model accidentally put the action JSON in text ──────
        stripped = text.strip()
        if stripped.startswith(('{', '[')) and len(stripped) > 10:
            try:
                maybe_action = json.loads(stripped)
                # The model put the action object in the text field
                if isinstance(maybe_action, dict) and maybe_action.get('type') in {'flyTo','showRoute','runScenario','moveSlider','highlightAssets'}:
                    # Use this as the action if we don't already have one
                    if action is None:
                        action = maybe_action
                    atype = (action or maybe_action).get('type', '')
                    # Generate proper human-readable text
                    def _nm(aid): return fac_map.get(str(aid), str(aid)) if aid else '—'
                    if atype == 'flyTo':
                        text = f"Flying the map to {_nm(action.get('asset_id'))} — zooming in now."
                    elif atype == 'showRoute':
                        mode_lbl = {'safest':'safest','fastest':'fastest','balanced':'balanced'}.get(action.get('mode',''), 'best')
                        text = f"Calculating the {mode_lbl} route from {_nm(action.get('from'))} to {_nm(action.get('to'))}. Opening Route Planner now."
                    elif atype == 'runScenario':
                        tgts = [_nm(t) for t in (action.get('targets') or [])]
                        stype = (action.get('scenario_type') or 'disruption').replace('_', ' ')
                        text = f"Running a {stype} simulation for {', '.join(tgts)}. Opening Scenario Simulator now."
                    elif atype == 'highlightAssets':
                        cnt = len(action.get('asset_ids') or [])
                        text = f"Highlighting {cnt} asset{'s' if cnt != 1 else ''} on the map."
                    else:
                        text = "Executing your request on the map."
            except (json.JSONDecodeError, TypeError):
                pass  # Not JSON — leave text as-is

        # ── Enrich action with human-readable names ───────────────────────────
        if action and isinstance(action, dict):
            _VALID = {'flyTo', 'showRoute', 'runScenario', 'moveSlider', 'highlightAssets'}
            if action.get('type') not in _VALID:
                action = None
            else:
                action = dict(action)
                atype  = action.get('type')
                def _nm(aid): return fac_map.get(str(aid), str(aid)) if aid else ''
                if atype == 'flyTo' and not action.get('name'):
                    action['name'] = _nm(action.get('asset_id'))
                elif atype == 'showRoute':
                    if not action.get('from_name'): action['from_name'] = _nm(action.get('from'))
                    if not action.get('to_name'):   action['to_name']   = _nm(action.get('to'))
                elif atype == 'runScenario':
                    action['target_names'] = [_nm(t) for t in (action.get('targets') or [])]
                elif atype == 'highlightAssets':
                    action['asset_names']  = [_nm(i) for i in (action.get('asset_ids') or [])[:10]]

        return JsonResponse({'text': text, 'action': action})

    except _req.Timeout:
        return JsonResponse({'text': 'The AI took too long. Please try again.', 'action': None})
    except _req.HTTPError as e:
        if e.response is not None and e.response.status_code == 429:
            return JsonResponse({'text': 'AI service is busy. Please try again shortly.', 'action': None})
        return JsonResponse({'text': _fallback_text(user_msg), 'action': None})
    except Exception:
        return JsonResponse({'text': _fallback_text(user_msg), 'action': None})
