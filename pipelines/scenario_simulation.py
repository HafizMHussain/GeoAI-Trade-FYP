"""
==============================================================================
SCRIPT 4 — SCENARIO SIMULATION ENGINE  v2.0  (DB-FIRST, MultiGraph-Safe)
==============================================================================
FYP: Geo-Resilience for Ports and Supply Chains (Pakistan)

CHANGES FROM v1.0:
    1. MultiGraph → SimpleGraph conversion at load time.
       network_model.py produces nx.MultiGraph (same node pair can have multiple
       edges of different modes).  All NetworkX analysis functions (shortest_path,
       betweenness_centrality, global_efficiency) work on simple Graphs.
       We keep the MultiGraph intact in the pickle; we project it to a
       SimpleGraph by retaining the MINIMUM travel_time_hr edge per node pair.
       This is the correct semantics: given two parallel connections, a vehicle
       always takes the fastest one.

    2. Edge-attribute mutations fixed.
       The v1.0 pattern  G_s[u][v]["travel_time_hr"] = X  silently fails on a
       MultiGraph (G_s[u][v] returns a dict-of-dicts, not a single edge dict).
       v2.0 works on the converted SimpleGraph so attribute access is correct.

    3. Cascading failure uses approximate betweenness (sampled, not subset) for
       stability across disconnected components.

    4. Spatial GeoDataFrame exports added:
         - scenario_results_latest.gpkg  (hotspot point layer per affected node)
         - corridor_risk_lines.gpkg      (LineString per corridor, colored by tier)
         - voronoi_risk_zones.gpkg       (Voronoi polygons clipped to Pakistan bbox)
         - recovery_stages.gpkg          (port/dryport points with recovery columns)

    5. Port stress integration: if port_stress_latest table exists in DB, its
       port_stress_index feeds into the strike_scenario degradation multiplier.

    6. node_id / asset_id column normalisation made robust.

    7. Economic model upgraded: uses UNCTAD methodology with per-port trade share.

INPUT PROVENANCE (priority order)
----------------------------------
  1. outputs/graph_baseline.gpickle      — primary  (network_model.py)
  2. DB: risk_nodes_latest               — node risk scores  (risk_engine.py)
  3. DB: risk_edges_latest               — edge risk scores
  4. DB: baseline_node_metrics           — centrality attributes
  5. DB: baseline_edge_metrics           — travel-time / capacity
  6. DB: baseline_shortest_paths         — pre-computed corridors
  7. FILE fallback for every DB table    — outputs/*.gpkg / *.csv

OUTPUTS (DB + files)
----------------------
  PostGIS tables:
    scenario_results_latest     (REPLACED)
    scenario_results_log        (APPENDED)
    scenario_kpis_log           (APPENDED)
    montecarlo_distribution     (REPLACED)
    economic_impact_latest      (REPLACED)
    corridor_analysis_latest    (REPLACED)
    recovery_timeline_latest    (REPLACED)

  Files in outputs/:
    scenario_results_latest.csv / .gpkg
    corridor_analysis.csv / corridor_risk_lines.gpkg
    recovery_timeline.csv / recovery_stages.gpkg
    voronoi_risk_zones.gpkg
    montecarlo_summary.json
    economic_impact.json
    scenario_full_report.json
    scenario_engine.pkl

==============================================================================
"""

from __future__ import annotations

import os, sys, json, math, time, pickle, warnings, traceback
from copy import deepcopy
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import geopandas as gpd
import networkx as nx
from shapely.geometry import Point, LineString, MultiPolygon, Polygon
from shapely.ops import unary_union
from sqlalchemy import create_engine, text, inspect

warnings.filterwarnings("ignore")

# ============================================================================
# CONFIGURATION
# ============================================================================
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")
os.makedirs(OUTPUT_DIR, exist_ok=True)

TIMESTAMP = datetime.utcnow().strftime("%Y%m%d_%H%M%S")

# ---- Database ---------------------------------------------------------------
DB_HOST   = os.environ.get("DB_HOST", "localhost")
DB_PORT   = int(os.environ.get("DB_PORT", 5432))
DB_NAME   = os.environ.get("DB_NAME", "fyp_georesilience")
DB_USER   = os.environ.get("DB_USER", "fyp_user")
DB_PASS   = os.environ.get("DB_PASSWORD", "fyp_pass")
DB_SCHEMA = "public"

# ---- DB input tables --------------------------------------------------------
TABLE_RISK_NODES     = "risk_nodes_latest"
TABLE_RISK_EDGES     = "risk_edges_latest"
TABLE_BASELINE_NODES = "baseline_node_metrics"
TABLE_BASELINE_EDGES = "baseline_edge_metrics"
TABLE_BASELINE_SP    = "baseline_shortest_paths"
TABLE_NET_NODES      = "network_nodes"
TABLE_NET_EDGES      = "network_edges"
TABLE_PORT_STRESS    = "port_stress_latest"

# ---- DB output tables -------------------------------------------------------
TABLE_SCEN_LATEST  = "scenario_results_latest"
TABLE_SCEN_LOG     = "scenario_results_log"
TABLE_SCEN_KPIS    = "scenario_kpis_log"
TABLE_MC_DIST      = "montecarlo_distribution"
TABLE_ECON         = "economic_impact_latest"
TABLE_CORRIDOR     = "corridor_analysis_latest"
TABLE_RECOVERY     = "recovery_timeline_latest"

# ---- File fallbacks ---------------------------------------------------------
FILE_ENGINE_PKL     = "scenario_engine.pkl"
FILE_RISK_NODES     = "risk_nodes_latest.gpkg"
FILE_RISK_EDGES     = "risk_edges_latest.gpkg"
FILE_NET_NODES      = "nodes.gpkg"
FILE_NET_EDGES      = "edges.gpkg"
FILE_BASELINE_NODES = "nodes_attributed.csv"
FILE_BASELINE_EDGES = "edges_attributed.csv"

# ---- Simulation parameters --------------------------------------------------
MONTE_CARLO_N          = 10
MC_FAILURE_THRESHOLD   = 0.65
MC_BETA_CONCENTRATION  = 5.0
TIME_STEPS_HOURS       = [0, 3, 6, 12, 24, 48, 72, 120, 168]

# ---- Pakistan economic parameters -------------------------------------------
PAKISTAN_DAILY_TRADE_USD  = 164_000_000   # ~$60B / year / 365
KARACHI_PORT_SHARE        = 0.60
PORT_QASIM_SHARE          = 0.30
GWADAR_SHARE              = 0.10
CARGO_PER_TEU_USD         = 30_000
DELAY_COST_PER_TEU_HOUR   = 800
TEU_PER_VESSEL_AVG        = 1_200
VESSELS_PER_DAY_KARACHI   = 8
PKR_PER_USD               = 278.0       # approximate 2024 rate

# ---- Risk thresholds --------------------------------------------------------
FLOOD_REMOVAL_THRESHOLD    = 0.60
CYCLONE_REMOVAL_THRESHOLD  = 0.60
STRIKE_REMOVAL_THRESHOLD   = 0.55
ACCIDENT_DEGRADE_THRESHOLD = 0.50

# ---- Pakistan approximate bounding box (for Voronoi clipping) ---------------
PK_BBOX = (60.5, 23.0, 77.5, 37.5)   # (min_lon, min_lat, max_lon, max_lat)


# ============================================================================
# LOGGING
# ============================================================================
def hdr(t: str):  print(f"\n{'='*78}\n  {t}\n{'='*78}")
def sub(t: str):  print(f"\n  ▸ {t}")
def info(t: str): print(f"    {t}")
def ok(t: str):   print(f"    ✓ {t}")
def warn(t: str): print(f"    ⚠ {t}")
def err(t: str):  print(f"    ✗ {t}")


# ============================================================================
# DATABASE HELPERS
# ============================================================================
def get_db_engine():
    try:
        engine = create_engine(
            f"postgresql://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}",
            pool_pre_ping=True)
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        ok(f"[DB] Connected → {DB_NAME}")
        return engine
    except Exception as e:
        warn(f"[DB] Connection failed: {e}")
        return None


def _tbl_exists(engine, table: str) -> bool:
    if engine is None: return False
    try:    return inspect(engine).has_table(table, schema=DB_SCHEMA)
    except: return False


def read_gdf_db(engine, table: str) -> Optional[gpd.GeoDataFrame]:
    if not _tbl_exists(engine, table): return None
    try:
        gdf = gpd.read_postgis(f"SELECT * FROM {DB_SCHEMA}.{table}",
                               engine, geom_col="geometry")
        ok(f"[DB] {table}: {len(gdf)} rows")
        return gdf if len(gdf) else None
    except Exception as e:
        warn(f"[DB] {table}: {e}")
        return None


def read_df_db(engine, table: str) -> Optional[pd.DataFrame]:
    if not _tbl_exists(engine, table): return None
    try:
        with engine.connect() as conn:
            df = pd.read_sql(f"SELECT * FROM {DB_SCHEMA}.{table}", conn)
        ok(f"[DB] {table}: {len(df)} rows")
        return df if len(df) else None
    except Exception as e:
        warn(f"[DB] {table}: {e}")
        return None


def write_df_db(df: pd.DataFrame, table: str, engine, if_exists="replace"):
    if engine is None: return False
    try:
        with engine.connect() as conn:
            df.to_sql(table, conn, schema=DB_SCHEMA,
                      if_exists=if_exists, index=False)
            conn.commit()
        ok(f"[DB] {table} ← {len(df)} rows ({if_exists})")
        return True
    except Exception as e:
        warn(f"[DB] {table}: {e}")
        return False


def write_gdf_db(gdf: gpd.GeoDataFrame, table: str, engine, if_exists="replace"):
    if engine is None: return False
    try:
        g = gdf.copy()
        if g.crs and g.crs.to_epsg() != 4326:
            g = g.to_crs(4326)
        g.to_postgis(table, engine, schema=DB_SCHEMA,
                     if_exists=if_exists, index=False)
        ok(f"[DB] {table} ← {len(g)} rows spatial ({if_exists})")
        return True
    except Exception as e:
        warn(f"[DB] {table}: {e}")
        return write_df_db(gdf.drop(columns="geometry", errors="ignore"),
                           table, engine, if_exists)


# ============================================================================
# GRAPH UTILITIES
# ============================================================================
def multigraph_to_simple(G_multi: nx.Graph) -> nx.Graph:
    """
    Convert nx.MultiGraph → nx.Graph keeping the minimum-travel-time edge
    per (u, v) pair.  This is the correct semantics: any vehicle chooses the
    fastest available connection between two nodes.

    Node attributes are preserved unchanged.
    Edge attributes from the chosen (min-weight) edge are kept.
    """
    G_simple = nx.Graph()
    G_simple.add_nodes_from(G_multi.nodes(data=True))

    if isinstance(G_multi, (nx.MultiGraph, nx.MultiDiGraph)):
        for u, v, key, data in G_multi.edges(data=True, keys=True):
            w = float(data.get("travel_time_hr", 1.0) or 1.0)
            if not G_simple.has_edge(u, v):
                G_simple.add_edge(u, v, **data)
            else:
                cur_w = float(G_simple[u][v].get("travel_time_hr", float("inf")))
                if w < cur_w:
                    # Replace edge attributes with faster edge's data
                    G_simple[u][v].update(data)
    else:
        G_simple.add_edges_from(G_multi.edges(data=True))

    return G_simple


def largest_component(G: nx.Graph) -> nx.Graph:
    if nx.is_connected(G):
        return G
    comps = sorted(nx.connected_components(G), key=len, reverse=True)
    return G.subgraph(comps[0]).copy()


def global_efficiency(G: nx.Graph, weight: str = "travel_time_hr",
                      sample_n: int = 300) -> float:
    """
    Latora-Marchiori global efficiency (sampled for large graphs).
    Handles disconnected graph gracefully.
    """
    nodes = list(G.nodes())
    if len(nodes) < 2: return 0.0
    if len(nodes) > sample_n:
        rng = np.random.default_rng(42)
        nodes = rng.choice(nodes, size=sample_n, replace=False).tolist()
    total, pairs = 0.0, 0
    for i, s in enumerate(nodes):
        for t in nodes[i + 1:]:
            try:
                d = nx.shortest_path_length(G, s, t, weight=weight)
                if d and d > 0:
                    total += 1.0 / d
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                pass
            pairs += 1
    return total / pairs if pairs else 0.0


def _node_from_asset(G: nx.Graph, asset_id: str) -> Optional[str]:
    """Map an asset_id string → actual node id in G."""
    if asset_id in G:
        return asset_id
    for n, d in G.nodes(data=True):
        if d.get("asset_id") == asset_id or d.get("name") == asset_id:
            return n
    return None


def get_type_nodes(G: nx.Graph, node_type: str) -> List[str]:
    return [n for n, d in G.nodes(data=True)
            if d.get("node_type", "") == node_type]


# ============================================================================
# COLUMN HELPERS
# ============================================================================
def _col(df: pd.DataFrame, *names) -> str:
    for n in names:
        if n in df.columns:
            return n
    return names[0]


def _normalise_id_col(df: pd.DataFrame) -> pd.DataFrame:
    """Ensure a 'node_id' column exists (alias of asset_id / id if needed)."""
    if "node_id" in df.columns:
        return df
    df = df.copy()
    for alias in ["asset_id", "id"]:
        if alias in df.columns:
            df["node_id"] = df[alias]
            return df
    df["node_id"] = [f"n{i}" for i in range(len(df))]
    return df


def fp(filename: str) -> Optional[str]:
    p = os.path.join(OUTPUT_DIR, filename)
    return p if os.path.exists(p) else None


# ============================================================================
# SECTION 1 — LOAD DATA
# ============================================================================
hdr("SECTION 1 — LOAD DATA")

DB = get_db_engine()

# ---- 1.1 Load scenario_engine.pkl -----------------------------------------
sub("1.1 Load scenario engine pickle")
PKL_ENGINE = None
pkl_path = os.path.join(OUTPUT_DIR, FILE_ENGINE_PKL)
if os.path.exists(pkl_path):
    try:
        with open(pkl_path, "rb") as f:
            PKL_ENGINE = pickle.load(f)
        ok("[FILE] scenario_engine.pkl loaded")
    except Exception as e:
        warn(f"[FILE] Could not load pkl: {e}")

# ---- 1.2 Risk nodes ---------------------------------------------------------
sub("1.2 Load risk nodes (DB → file fallback)")
nodes_gdf = read_gdf_db(DB, TABLE_RISK_NODES)
if nodes_gdf is None:
    for fn in [FILE_RISK_NODES, FILE_NET_NODES]:
        p = fp(fn)
        if p:
            nodes_gdf = gpd.read_file(p)
            warn(f"[FILE] {fn}: {len(nodes_gdf)} rows")
            for c in ["composite_risk","risk_flood","risk_cyclone",
                      "risk_strike","risk_accident","network_criticality_risk"]:
                nodes_gdf.setdefault(c, 0.0)
            break
    if nodes_gdf is None:
        err("No node data found. Exiting."); sys.exit(1)

# ---- 1.3 Risk edges ---------------------------------------------------------
sub("1.3 Load risk edges (DB → file fallback)")
edges_gdf = read_gdf_db(DB, TABLE_RISK_EDGES)
if edges_gdf is None:
    for fn in [FILE_RISK_EDGES, FILE_NET_EDGES]:
        p = fp(fn)
        if p:
            edges_gdf = gpd.read_file(p)
            warn(f"[FILE] {fn}: {len(edges_gdf)} rows")
            for c in ["composite_risk","risk_flood","risk_cyclone",
                      "risk_strike","risk_accident"]:
                edges_gdf.setdefault(c, 0.0)
            break
    if edges_gdf is None:
        err("No edge data found. Exiting."); sys.exit(1)

# ---- 1.4 Load graph pickle --------------------------------------------------
sub("1.4 Load baseline graph (MultiGraph → SimpleGraph)")
G_RAW = None
graph_path = os.path.join(OUTPUT_DIR, "graph_baseline.gpickle")
if os.path.exists(graph_path):
    try:
        with open(graph_path, "rb") as f:
            G_RAW = pickle.load(f)
        ok(f"[FILE] graph_baseline.gpickle: {G_RAW.number_of_nodes()} nodes, "
           f"{G_RAW.number_of_edges()} edges  "
           f"[type={type(G_RAW).__name__}]")
    except Exception as e:
        warn(f"[FILE] Could not load graph: {e}")

if G_RAW is None and PKL_ENGINE is not None:
    try:
        G_RAW = PKL_ENGINE.G_base
        ok("[ENGINE] G_RAW from scenario_engine.pkl")
    except AttributeError:
        pass

if G_RAW is None:
    warn("No graph pickle found — building stub from nodes/edges GDFs")
    G_RAW = nx.Graph()
    for _, r in nodes_gdf.iterrows():
        nid = r.get("node_id", r.get("asset_id", ""))
        G_RAW.add_node(nid, **{k: v for k, v in r.items() if k != "geometry"})
    for _, r in edges_gdf.iterrows():
        G_RAW.add_edge(
            r.get("from_node", ""), r.get("to_node", ""),
            travel_time_hr=float(r.get("travel_time_hr", 1.0)),
            **{k: v for k, v in r.items() if k not in ("geometry", "from_node", "to_node")}
        )

# Convert MultiGraph → SimpleGraph (CRITICAL FIX v2.0)
sub("1.5 Convert MultiGraph to SimpleGraph (min travel-time per edge pair)")
G_BASELINE = multigraph_to_simple(G_RAW)
G_BASELINE = largest_component(G_BASELINE)
ok(f"SimpleGraph: {G_BASELINE.number_of_nodes()} nodes, "
   f"{G_BASELINE.number_of_edges()} edges (main component)")

# ---- 1.5 Port stress (optional — feeds strike severity) --------------------
sub("1.6 Load port stress index (optional)")
port_stress_map: Dict[str, float] = {}  # asset_id → psi
ps_df = read_df_db(DB, TABLE_PORT_STRESS)
if ps_df is not None and "asset_id" in ps_df.columns and "port_stress_index" in ps_df.columns:
    port_stress_map = dict(zip(ps_df["asset_id"], ps_df["port_stress_index"]))
    ok(f"Port stress loaded for {len(port_stress_map)} ports")


# ============================================================================
# SECTION 2 — HELPER FUNCTIONS & CONTEXT
# ============================================================================
hdr("SECTION 2 — BUILD SIMULATION CONTEXT")

sub("2.1 Normalise column names")
nodes_gdf = _normalise_id_col(nodes_gdf)
edges_gdf = _normalise_id_col(edges_gdf)
nodes_df  = pd.DataFrame(nodes_gdf.drop(columns="geometry", errors="ignore"))
edges_df  = pd.DataFrame(edges_gdf.drop(columns="geometry", errors="ignore"))

# Ensure risk columns exist
for c in ["composite_risk","risk_flood","risk_cyclone",
          "risk_strike","risk_accident","network_criticality_risk"]:
    if c not in nodes_df.columns: nodes_df[c] = 0.0
for c in ["composite_risk","risk_flood","risk_cyclone",
          "risk_strike","risk_accident"]:
    if c not in edges_df.columns: edges_df[c] = 0.0

sub("2.2 Baseline efficiency")
E_BASELINE = global_efficiency(G_BASELINE)
ok(f"Baseline global efficiency: {E_BASELINE:.4f}")

sub("2.3 Build baseline corridor dict")
BASELINE_PATHS: Dict[str, float] = {}

sp_df = read_df_db(DB, TABLE_BASELINE_SP)
if sp_df is not None and len(sp_df):
    for _, r in sp_df.iterrows():
        s = r.get("source", r.get("from_node", r.get("origin", "")))
        t = r.get("target", r.get("to_node", r.get("destination", "")))
        tt = float(r.get("travel_time_hr", r.get("path_time", 1.0)))
        if s and t:
            BASELINE_PATHS[f"{s}→{t}"] = tt
    ok(f"Loaded {len(BASELINE_PATHS)} corridors from DB")

if len(BASELINE_PATHS) == 0:
    p = fp("baseline_shortest_paths.csv")
    if p:
        sp_df = pd.read_csv(p)
        for _, r in sp_df.iterrows():
            s = r.get("source", r.get("from_node", ""))
            t = r.get("target", r.get("to_node", ""))
            tt = float(r.get("travel_time_hr", r.get("path_time", 1.0)) or 1.0)
            if s and t:
                BASELINE_PATHS[f"{s}→{t}"] = tt
        ok(f"Loaded {len(BASELINE_PATHS)} corridors from file")

if len(BASELINE_PATHS) == 0:
    sub("2.3b Auto-computing facility corridors")
    fac_types = {"port", "dryport", "rail_station"}
    fac_nodes = [n for n, d in G_BASELINE.nodes(data=True)
                 if d.get("node_type", "") in fac_types]
    for i, s in enumerate(fac_nodes):
        for t in fac_nodes[i + 1:]:
            try:
                d = nx.shortest_path_length(G_BASELINE, s, t, weight="travel_time_hr")
                BASELINE_PATHS[f"{s}→{t}"] = d
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                pass
    ok(f"Auto-computed {len(BASELINE_PATHS)} corridors")

sub("2.4 Identify asset groups")
PORT_NODES    = get_type_nodes(G_BASELINE, "port")
DRYPORT_NODES = get_type_nodes(G_BASELINE, "dryport")
STATION_NODES = get_type_nodes(G_BASELINE, "rail_station")
FACILITY_NODES = PORT_NODES + DRYPORT_NODES + STATION_NODES
info(f"Ports:{len(PORT_NODES)}  Dryports:{len(DRYPORT_NODES)}  "
     f"Stations:{len(STATION_NODES)}")

id_col = _col(nodes_df, "node_id", "asset_id")
cr_col = _col(nodes_df, "network_criticality_risk", "composite_risk")
bc_col = _col(nodes_df, "betweenness_centrality", "betweenness")

if bc_col in nodes_df.columns and cr_col in nodes_df.columns:
    nodes_df["_choke"] = nodes_df[bc_col].fillna(0) * nodes_df[cr_col].fillna(0)
    CHOKEPOINTS = nodes_df.nlargest(10, "_choke")[id_col].tolist()
elif cr_col in nodes_df.columns:
    CHOKEPOINTS = nodes_df.nlargest(10, cr_col)[id_col].tolist()
else:
    CHOKEPOINTS = FACILITY_NODES[:5]
ok(f"Top {len(CHOKEPOINTS)} chokepoints identified")


# ============================================================================
# SECTION 3 — IMPACT MEASUREMENT
# ============================================================================
def measure_scenario(G_scen: nx.Graph,
                     removed: List[str],
                     affected_edges: List[str]) -> Dict[str, Any]:
    """
    Compute impact metrics by comparing G_scen to G_BASELINE.
    Works on simple nx.Graph only.
    """
    if nx.is_connected(G_scen):
        n_comp = 1
        G_main = G_scen
    else:
        comps  = list(nx.connected_components(G_scen))
        n_comp = len(comps)
        G_main = G_scen.subgraph(max(comps, key=len)).copy()

    eff_s    = global_efficiency(G_main)
    eff_drop = round(100 * (1 - eff_s / E_BASELINE), 2) if E_BASELINE > 0 else 0.0

    unreachable = delayed = 0
    total_delay = 0.0
    for corridor, base_t in BASELINE_PATHS.items():
        parts = corridor.split("→")
        if len(parts) != 2: continue
        s, t = parts
        if s in G_main and t in G_main:
            try:
                new_t = nx.shortest_path_length(G_main, s, t, weight="travel_time_hr")
                if new_t > base_t + 0.01:
                    delayed    += 1
                    total_delay += new_t - base_t
            except nx.NetworkXNoPath:
                unreachable += 1
        else:
            unreachable += 1

    return {
        "network_components":    n_comp,
        "network_fragmented":    n_comp > 1,
        "efficiency_baseline":   round(E_BASELINE, 4),
        "efficiency_scenario":   round(eff_s, 4),
        "efficiency_drop_pct":   eff_drop,
        "corridors_unreachable": unreachable,
        "corridors_delayed":     delayed,
        "total_delay_hours":     round(total_delay, 2),
        "avg_delay_hours":       round(total_delay / delayed, 2) if delayed else 0.0,
        "nodes_removed":         removed,
        "edges_affected":        affected_edges[:30],
        "nodes_removed_count":   len(removed),
        "edges_affected_count":  len(affected_edges),
    }


# ============================================================================
# SECTION 4 — ECONOMIC IMPACT MODEL
# ============================================================================
def economic_impact(metrics: Dict, scenario_type: str,
                    port_stress: Dict[str, float] = None) -> Dict:
    """
    UNCTAD-inspired economic impact model for Pakistan trade disruption.
    All values in USD (also converted to PKR).
    """
    eff_drop  = metrics.get("efficiency_drop_pct", 0.0) / 100.0
    unreach   = metrics.get("corridors_unreachable", 0)
    delay_h   = metrics.get("total_delay_hours", 0.0)
    n_removed = len(metrics.get("nodes_removed", []))

    # --- Trade disruption fraction ---
    # Scales super-linearly with efficiency drop (infrastructure disruption
    # has amplified trade effects due to JIT logistics)
    disruption_frac = min(eff_drop * 1.5, 1.0)

    # --- Port closure cargo-at-risk ---
    port_closures = sum(
        1 for n in metrics.get("nodes_removed", [])
        if "port" in str(n).lower() and "dry" not in str(n).lower()
    )
    dryport_closures = sum(
        1 for n in metrics.get("nodes_removed", [])
        if "dryport" in str(n).lower()
    )

    # Per-port daily trade contribution
    port_daily = {
        "karachi": PAKISTAN_DAILY_TRADE_USD * KARACHI_PORT_SHARE,
        "qasim":   PAKISTAN_DAILY_TRADE_USD * PORT_QASIM_SHARE,
        "gwadar":  PAKISTAN_DAILY_TRADE_USD * GWADAR_SHARE,
    }

    cargo_at_risk_usd = 0.0
    for n in metrics.get("nodes_removed", []):
        n_lower = str(n).lower()
        for port_key, daily_val in port_daily.items():
            if port_key in n_lower:
                cargo_at_risk_usd += daily_val * 0.5  # 50% disruption per port

    # --- Delay cost (TEU × hours × rate) ---
    teu_affected = VESSELS_PER_DAY_KARACHI * TEU_PER_VESSEL_AVG * port_closures
    delay_cost_usd = delay_h * DELAY_COST_PER_TEU_HOUR * max(teu_affected, 500) * 0.1

    # --- Daily trade flow loss ---
    daily_trade_loss_usd = PAKISTAN_DAILY_TRADE_USD * disruption_frac

    # --- Supply chain ripple multiplier (Karachi handles 90% of Pakistan trade) ---
    ripple = 1.3 if port_closures > 0 else 1.1

    return {
        "cargo_at_risk_usd":       round(cargo_at_risk_usd * ripple, 0),
        "cargo_at_risk_pkr":       round(cargo_at_risk_usd * ripple * PKR_PER_USD, 0),
        "delay_cost_usd":          round(delay_cost_usd, 0),
        "delay_cost_pkr":          round(delay_cost_usd * PKR_PER_USD, 0),
        "daily_trade_loss_usd":    round(daily_trade_loss_usd, 0),
        "daily_trade_loss_pkr":    round(daily_trade_loss_usd * PKR_PER_USD, 0),
        "trade_disruption_pct":    round(disruption_frac * 100, 1),
        "teu_affected_per_day":    int(VESSELS_PER_DAY_KARACHI * TEU_PER_VESSEL_AVG * disruption_frac),
        "port_closures":           port_closures,
        "dryport_closures":        dryport_closures,
    }


# ============================================================================
# SECTION 5 — FULL SCENARIO ENGINE
# ============================================================================
class FullScenarioEngine:
    """
    9-type scenario engine (MultiGraph-safe, v2.0).

    Works on a SIMPLE nx.Graph (G_BASELINE already converted).
    All edge-attribute mutations use G[u][v]["attr"] = x which is correct
    on a simple Graph.
    """

    def __init__(self, G: nx.Graph, nodes_df: pd.DataFrame,
                 edges_df: pd.DataFrame):
        self.G         = G
        self.nodes_df  = nodes_df.copy()
        self.edges_df  = edges_df.copy()
        self._id_col   = _col(nodes_df, "node_id", "asset_id")
        self._eid_col  = _col(edges_df, "asset_id", "edge_id")

    # -----------------------------------------------------------------------
    def _copy(self) -> nx.Graph:
        """Deep-copy the working graph (simple Graph only)."""
        return deepcopy(self.G)

    def _to_node(self, asset_id: str) -> Optional[str]:
        return _node_from_asset(self.G, asset_id)

    def _get_risk(self, df: pd.DataFrame, id_col: str,
                  id_val: str, col: str) -> float:
        row = df[df[id_col] == id_val]
        return float(row.iloc[0].get(col, 0)) if len(row) else 0.0

    def _build_summary(self, scenario_type: str, targets: List[str],
                        m: Dict, econ: Dict) -> str:
        parts = [f"SCENARIO [{scenario_type.upper()}] on {targets}."]
        if m.get("nodes_removed"):
            parts.append(f"{len(m['nodes_removed'])} node(s) removed.")
        if m["corridors_unreachable"]:
            parts.append(
                f"CRITICAL: {m['corridors_unreachable']} trade corridor(s) "
                f"became unreachable.")
        if m["corridors_delayed"]:
            parts.append(
                f"{m['corridors_delayed']} corridor(s) delayed; "
                f"total +{m['total_delay_hours']:.1f}h; "
                f"avg +{m['avg_delay_hours']:.1f}h each.")
        parts.append(
            f"Efficiency dropped {m['efficiency_drop_pct']:.1f}% "
            f"(baseline={m['efficiency_baseline']:.3f} → "
            f"scenario={m['efficiency_scenario']:.3f}).")
        if econ["trade_disruption_pct"] > 0:
            parts.append(
                f"Estimated trade disruption: {econ['trade_disruption_pct']:.1f}% "
                f"(~USD {econ['daily_trade_loss_usd']:,.0f}/day "
                f"= PKR {econ['daily_trade_loss_pkr']/1e9:.2f}B/day).")
        if m["network_fragmented"]:
            parts.append(
                f"⚠ Network split into {m['network_components']} components.")
        return " ".join(parts)

    def _pack(self, scenario_type: str, targets: List[str],
              severity: float, m: Dict, econ: Dict,
              scenario_id: str) -> Dict:
        return {
            "scenario_id":     scenario_id,
            "scenario_type":   scenario_type,
            "targets":         targets,
            "severity":        severity,
            "timestamp":       TIMESTAMP,
            "impact_metrics":  m,
            "economic_impact": econ,
            "summary_for_llm": self._build_summary(scenario_type, targets, m, econ),
        }

    # -----------------------------------------------------------------------
    # TYPE 1: Node Removal
    # -----------------------------------------------------------------------
    def node_removal(self, targets: List[str],
                     severity: float = 1.0, label: str = "") -> Dict:
        G_s = self._copy()
        removed = []
        for t in targets:
            nid = self._to_node(t)
            if nid and nid in G_s:
                G_s.remove_node(nid)
                removed.append(nid)
        m    = measure_scenario(G_s, removed, [])
        econ = economic_impact(m, "node_removal")
        return self._pack("node_removal", targets, severity, m, econ,
                          label or f"node_removal_{'+'.join(str(t)[:8] for t in targets[:2])}")

    # -----------------------------------------------------------------------
    # TYPE 2: Edge Closure  (road/rail blockage)
    # -----------------------------------------------------------------------
    def edge_closure(self, targets: List[str],
                     severity: float = 1.0, label: str = "") -> Dict:
        G_s = self._copy()
        affected = []
        for t in targets:
            # Simple Graph: iterate edges, find matching asset_id
            found = False
            for u, v, d in G_s.edges(data=True):
                if d.get("asset_id") == t or d.get("edge_id") == t:
                    G_s[u][v]["travel_time_hr"] = 9999.0
                    affected.append(f"{u}→{v}")
                    found = True
                    break
            if not found:
                warn(f"  edge_closure: asset_id {t!r} not found in graph")
        m    = measure_scenario(G_s, [], affected)
        econ = economic_impact(m, "edge_closure")
        return self._pack("edge_closure", targets, severity, m, econ,
                          label or f"edge_closure_{'+'.join(str(t)[:8] for t in targets[:2])}")

    # -----------------------------------------------------------------------
    # TYPE 3: Capacity Reduction (congestion / partial operation)
    # -----------------------------------------------------------------------
    def capacity_reduction(self, targets: List[str],
                           severity: float = 0.5, label: str = "") -> Dict:
        G_s = self._copy()
        affected = []
        for t in targets:
            nid = self._to_node(t)
            if nid and nid in G_s:
                for nbr in list(G_s.neighbors(nid)):
                    old = G_s[nid][nbr].get("travel_time_hr", 1.0)
                    G_s[nid][nbr]["travel_time_hr"] = old * (1.0 + severity * 3.0)
                    affected.append(f"{nid}→{nbr}")
        m    = measure_scenario(G_s, [], affected)
        econ = economic_impact(m, "capacity_reduction")
        return self._pack("capacity_reduction", targets, severity, m, econ,
                          label or f"cap_reduction_{'+'.join(str(t)[:8] for t in targets[:2])}")

    # -----------------------------------------------------------------------
    # TYPE 4: Flood Scenario
    # -----------------------------------------------------------------------
    def flood_scenario(self, severity: float = 1.0, label: str = "") -> Dict:
        risk_col = _col(self.nodes_df, "risk_flood", "hazard_flood", "composite_risk")
        thr = FLOOD_REMOVAL_THRESHOLD / max(severity, 0.5)
        targets = self.nodes_df.loc[
            self.nodes_df[risk_col] > thr, self._id_col].dropna().tolist()
        result = self.node_removal(targets, severity,
                                   label or f"flood_s{severity:.1f}")
        result["scenario_type"] = "flood_scenario"
        return result

    # -----------------------------------------------------------------------
    # TYPE 5: Cyclone Scenario (remove coastal high-risk, degrade moderate)
    # -----------------------------------------------------------------------
    def cyclone_scenario(self, severity: float = 1.0, label: str = "") -> Dict:
        G_s = self._copy()
        removed, affected = [], []
        risk_col = _col(self.nodes_df, "risk_cyclone", "hazard_cyclone", "composite_risk")

        thr_remove = CYCLONE_REMOVAL_THRESHOLD
        thr_degrade = thr_remove * 0.6

        high = self.nodes_df.loc[
            self.nodes_df[risk_col] > thr_remove, self._id_col].dropna().tolist()
        mid  = self.nodes_df.loc[
            (self.nodes_df[risk_col] > thr_degrade) &
            (self.nodes_df[risk_col] <= thr_remove), self._id_col].dropna().tolist()

        for t in high:
            nid = self._to_node(t)
            if nid and nid in G_s:
                G_s.remove_node(nid); removed.append(nid)

        for t in mid:
            nid = self._to_node(t)
            if nid and nid in G_s:
                for nbr in list(G_s.neighbors(nid)):
                    old = G_s[nid][nbr].get("travel_time_hr", 1.0)
                    G_s[nid][nbr]["travel_time_hr"] = old * (1.0 + severity)
                    affected.append(f"{nid}→{nbr}")

        m    = measure_scenario(G_s, removed, affected)
        econ = economic_impact(m, "cyclone_scenario")
        return self._pack("cyclone_scenario",
                          high[:5] + (["[moderate-degraded]"] if mid else []),
                          severity, m, econ, label or f"cyclone_s{severity:.1f}")

    # -----------------------------------------------------------------------
    # TYPE 6: Strike Scenario
    # -----------------------------------------------------------------------
    def strike_scenario(self, severity: float = 1.0, label: str = "") -> Dict:
        G_s = self._copy()
        removed, affected = [], []
        risk_col = _col(self.nodes_df, "risk_strike", "hazard_strike", "composite_risk")

        # Node types most affected by strikes
        ntype_col = "node_type" if "node_type" in self.nodes_df.columns else None
        if ntype_col:
            strike_types = {"port", "dryport", "rail_station"}
            mask = ((self.nodes_df[risk_col] > STRIKE_REMOVAL_THRESHOLD) &
                    self.nodes_df[ntype_col].isin(strike_types))
            strike_nodes = self.nodes_df.loc[mask, self._id_col].dropna().tolist()
        else:
            strike_nodes = self.nodes_df.loc[
                self.nodes_df[risk_col] > STRIKE_REMOVAL_THRESHOLD,
                self._id_col].dropna().tolist()

        if not strike_nodes:
            strike_nodes = PORT_NODES + DRYPORT_NODES  # fallback

        for t in strike_nodes:
            nid = self._to_node(t)
            if not nid or nid not in G_s:
                continue
            # Use live port stress if available (AIS integration)
            psi = port_stress_map.get(t, 0.0)
            effective_sev = min(1.0, severity + psi * 0.5)

            if effective_sev >= 0.8:
                G_s.remove_node(nid)
                removed.append(nid)
            else:
                for nbr in list(G_s.neighbors(nid)):
                    old = G_s[nid][nbr].get("travel_time_hr", 1.0)
                    G_s[nid][nbr]["travel_time_hr"] = old * (1.0 + effective_sev * 4)
                    affected.append(f"{nid}→{nbr}")

        m    = measure_scenario(G_s, removed, affected)
        econ = economic_impact(m, "strike_scenario")
        return self._pack("strike_scenario", strike_nodes[:5],
                          severity, m, econ, label or f"strike_s{severity:.1f}")

    # -----------------------------------------------------------------------
    # TYPE 7: Accident Scenario (road/rail edge degradation)
    # -----------------------------------------------------------------------
    def accident_scenario(self, severity: float = 1.0, label: str = "") -> Dict:
        G_s = self._copy()
        affected = []
        risk_col = _col(self.edges_df, "risk_accident", "hazard_accident", "composite_risk")

        # Build lookup: asset_id → accident risk
        eid_col = self._eid_col
        risk_lookup = dict(zip(self.edges_df[eid_col],
                               self.edges_df[risk_col].fillna(0)))

        for u, v, d in G_s.edges(data=True):
            aid = d.get("asset_id", d.get("edge_id", ""))
            fr  = risk_lookup.get(aid, 0.0)
            rt  = d.get("road_type", "unknown")

            # Motorway/trunk degrade even without explicit risk score
            if fr > ACCIDENT_DEGRADE_THRESHOLD or rt in ("motorway", "trunk"):
                fr = max(fr, 0.4)
                old = d.get("travel_time_hr", 1.0)
                G_s[u][v]["travel_time_hr"] = old * (1.0 + fr * severity * 1.5)
                affected.append(f"{u}→{v}")

        m    = measure_scenario(G_s, [], affected)
        econ = economic_impact(m, "accident_scenario")
        return self._pack("accident_scenario", ["road_network"],
                          severity, m, econ, label or f"accident_s{severity:.1f}")

    # -----------------------------------------------------------------------
    # TYPE 8: Compound Multi-Hazard
    # -----------------------------------------------------------------------
    def compound_scenario(self, hazards: List[str],
                          severities: Optional[Dict[str, float]] = None,
                          label: str = "") -> Dict:
        if severities is None:
            severities = {h: 1.0 for h in hazards}
        G_s = self._copy()
        removed = set(); affected = []

        def _rm(nid):
            if nid and nid in G_s:
                G_s.remove_node(nid); removed.add(nid)

        def _degrade(nid, mult):
            if nid and nid in G_s:
                for nbr in list(G_s.neighbors(nid)):
                    old = G_s[nid][nbr].get("travel_time_hr", 1.0)
                    G_s[nid][nbr]["travel_time_hr"] = old * mult
                    affected.append(f"{nid}→{nbr}")

        if "flood" in hazards:
            sev = severities.get("flood", 1.0)
            rc  = _col(self.nodes_df, "risk_flood", "hazard_flood")
            thr = FLOOD_REMOVAL_THRESHOLD / max(sev, 0.5)
            for nid in self.nodes_df.loc[
                    self.nodes_df[rc] > thr, self._id_col].dropna():
                _rm(self._to_node(nid))

        if "cyclone" in hazards:
            sev = severities.get("cyclone", 1.0)
            rc  = _col(self.nodes_df, "risk_cyclone", "hazard_cyclone")
            thr = CYCLONE_REMOVAL_THRESHOLD / max(sev, 0.5)
            for nid in self.nodes_df.loc[
                    self.nodes_df[rc] > thr, self._id_col].dropna():
                _rm(self._to_node(nid))

        if "strike" in hazards:
            sev = severities.get("strike", 1.0)
            for nid in PORT_NODES + DRYPORT_NODES:
                if sev >= 0.7:
                    _rm(nid)
                else:
                    _degrade(nid, 1.0 + sev * 3)

        if "accident" in hazards:
            sev = severities.get("accident", 1.0)
            rc  = _col(self.edges_df, "risk_accident", "hazard_accident")
            eid = self._eid_col
            risk_lk = dict(zip(self.edges_df[eid], self.edges_df[rc].fillna(0)))
            for u, v, d in G_s.edges(data=True):
                fr = risk_lk.get(d.get("asset_id", ""), 0.0)
                if fr > 0.4:
                    old = d.get("travel_time_hr", 1.0)
                    G_s[u][v]["travel_time_hr"] = old * (1.0 + fr * sev)
                    affected.append(f"{u}→{v}")

        m    = measure_scenario(G_s, list(removed), affected)
        econ = economic_impact(m, "compound")
        cid  = label or f"compound_{'_'.join(sorted(hazards))}"
        return self._pack("compound_scenario", hazards, 1.0, m, econ, cid)

    # -----------------------------------------------------------------------
    # TYPE 9: Cascading Failure
    # -----------------------------------------------------------------------
    def cascading_failure(self, seed_nodes: List[str],
                          cascade_depth: int = 3,
                          cascade_threshold: float = 0.6,
                          severity: float = 1.0,
                          label: str = "") -> Dict:
        """
        Progressive network failure propagating from seed nodes.

        Algorithm:
          Depth 0: remove seed nodes.
          Depth 1..N: for each remaining node, compute approximate betweenness
                      (sampled 200-node subset).  If betweenness increased by
                      more than cascade_threshold × severity relative to its
                      baseline value, the node is overloaded and fails.
          Cascade stops when no new failures occur or max depth reached.
        """
        G_s = self._copy()
        removed_all = []
        steps = []

        def approx_bc(G: nx.Graph, n_sample: int = 200) -> Dict[str, float]:
            nodes = list(G.nodes())
            if len(nodes) <= n_sample:
                sample = nodes
            else:
                rng = np.random.default_rng(42)
                sample = rng.choice(nodes, n_sample, replace=False).tolist()
            try:
                return nx.betweenness_centrality(
                    G, k=min(n_sample, len(nodes)),
                    weight="travel_time_hr", normalized=True, seed=42)
            except Exception:
                return {n: 0.0 for n in nodes}

        # Baseline BC before any failures
        bc_pre = approx_bc(G_s)

        # Depth 0 — remove seed nodes
        seeds = [self._to_node(s) for s in seed_nodes]
        seeds = [n for n in seeds if n is not None and n in G_s]
        for nid in seeds:
            G_s.remove_node(nid)
            removed_all.append(nid)
        steps.append({"depth": 0, "failed": list(seeds), "reason": "seed"})

        # Depth 1..N
        for depth in range(1, cascade_depth + 1):
            if G_s.number_of_nodes() < 2: break
            bc_post = approx_bc(G_s)
            newly_failed = []
            for candidate in list(G_s.nodes()):
                bc_b = bc_pre.get(candidate, 0.0)
                bc_a = bc_post.get(candidate, 0.0)
                if bc_b > 0:
                    overload = (bc_a - bc_b) / bc_b
                else:
                    overload = bc_a * 100.0  # zero → any load is "infinite" increase
                if overload > cascade_threshold * severity:
                    newly_failed.append(candidate)
            for nid in newly_failed:
                if nid in G_s:
                    G_s.remove_node(nid)
                    removed_all.append(nid)
            steps.append({"depth": depth,
                          "failed": newly_failed,
                          "reason": "cascade_overload"})
            if not newly_failed:
                break
            bc_pre = bc_post

        m    = measure_scenario(G_s, removed_all, [])
        m["cascade_steps"]    = steps
        m["total_cascaded"]   = len(removed_all) - len(seeds)
        econ = economic_impact(m, "cascading_failure")
        result = self._pack("cascading_failure", seed_nodes, severity, m, econ,
                            label or f"cascade_from_{'+'.join(str(s)[:8] for s in seed_nodes[:2])}")
        result["cascade_steps"] = steps
        return result

    # -----------------------------------------------------------------------
    # Monte Carlo Probabilistic Simulation
    # -----------------------------------------------------------------------
    def monte_carlo(self, n_iter: int = MONTE_CARLO_N,
                    failure_threshold: float = MC_FAILURE_THRESHOLD,
                    concentration: float = MC_BETA_CONCENTRATION) -> Dict:
        """
        Beta-sampled Monte Carlo:
          For each node, sample hazard intensity from Beta(α, β) where
          mean = composite_risk.  If sample > failure_threshold → node fails.
        Returns P10/P50/P90/P99 efficiency-drop statistics.
        """
        sub(f"Running Monte Carlo ({n_iter} iterations) …")
        risk_col = _col(self.nodes_df, "composite_risk", "network_criticality_risk")
        id_col   = self._id_col

        risk_scores = self.nodes_df.set_index(id_col)[risk_col].fillna(0).to_dict()
        rng = np.random.default_rng(seed=0)

        eff_drops, unreach_arr, n_failed_arr = [], [], []

        for _ in range(n_iter):
            G_mc = self._copy()
            failed = []
            for nid, score in risk_scores.items():
                sc = float(np.clip(score, 0.01, 0.99))
                alpha = sc * concentration
                beta  = (1 - sc) * concentration
                if rng.beta(alpha, beta) > failure_threshold:
                    resolved = self._to_node(nid)
                    if resolved and resolved in G_mc:
                        G_mc.remove_node(resolved)
                        failed.append(resolved)

            if G_mc.number_of_nodes() < 2:
                eff_drops.append(100.0)
                unreach_arr.append(len(BASELINE_PATHS))
                n_failed_arr.append(len(failed))
                continue

            G_mc_main = largest_component(G_mc)
            eff = global_efficiency(G_mc_main, sample_n=150)
            drop = max(100 * (1 - eff / E_BASELINE), 0.0) if E_BASELINE > 0 else 0.0
            eff_drops.append(drop)

            unreach = sum(
                1 for k in BASELINE_PATHS
                for s, t in [k.split("→")]
                if s not in G_mc_main or t not in G_mc_main
            )
            unreach_arr.append(unreach)
            n_failed_arr.append(len(failed))

        arr = np.array(eff_drops)
        results = {
            "n_iterations":          n_iter,
            "failure_threshold":     failure_threshold,
            "beta_concentration":    concentration,
            "eff_drop_mean":         round(float(np.mean(arr)), 2),
            "eff_drop_std":          round(float(np.std(arr)), 2),
            "eff_drop_p10":          round(float(np.percentile(arr, 10)), 2),
            "eff_drop_p50":          round(float(np.percentile(arr, 50)), 2),
            "eff_drop_p90":          round(float(np.percentile(arr, 90)), 2),
            "eff_drop_p99":          round(float(np.percentile(arr, 99)), 2),
            "avg_nodes_failed":      round(float(np.mean(n_failed_arr)), 1),
            "avg_corridors_unreach": round(float(np.mean(unreach_arr)), 1),
            "p90_corridors_unreach": round(float(np.percentile(unreach_arr, 90)), 1),
            "worst_case_drop_pct":   round(float(np.max(arr)), 2),
            "prob_gt10pct_drop":     round(float((arr > 10).mean() * 100), 1),
            "prob_gt25pct_drop":     round(float((arr > 25).mean() * 100), 1),
            "prob_gt50pct_drop":     round(float((arr > 50).mean() * 100), 1),
            "timestamp":             TIMESTAMP,
            "eff_drop_distribution": arr.round(2).tolist()[:200],
        }
        ok(f"MC: P50={results['eff_drop_p50']}% | P90={results['eff_drop_p90']}%")
        return results

    # -----------------------------------------------------------------------
    # Time-Stepped Recovery Simulation
    # -----------------------------------------------------------------------
    def recovery_simulation(self, initial_scenario: Dict,
                            time_steps: List[int] = TIME_STEPS_HOURS,
                            recovery_half_life_hours: float = 24.0) -> List[Dict]:
        """
        Logistic recovery model:
            recovery_fraction(t) = 1 / (1 + exp(-k*(t - t_half)))
        where k = ln(9) / t_half  →  50% recovery at t = t_half.

        At t=0 → 0% recovered (full damage).
        At t→∞ → 100% recovered.
        """
        m0        = initial_scenario.get("impact_metrics", {})
        eff_drop0 = m0.get("efficiency_drop_pct", 0.0)
        delay0    = m0.get("total_delay_hours", 0.0)
        unreach0  = m0.get("corridors_unreachable", 0)

        k = math.log(9) / recovery_half_life_hours

        records = []
        for t in time_steps:
            rf = 0.0 if t == 0 else \
                 1.0 / (1.0 + math.exp(-k * (t - recovery_half_life_hours)))
            records.append({
                "time_hours":            t,
                "recovery_fraction":     round(rf, 3),
                "eff_drop_pct":          round(eff_drop0 * (1 - rf), 2),
                "corridors_unreachable": int(unreach0 * (1 - rf)),
                "residual_delay_hours":  round(delay0  * (1 - rf), 2),
                "operational_pct":       round(rf * 100, 1),
                "scenario_id":           initial_scenario.get("scenario_id", ""),
                "timestamp":             TIMESTAMP,
            })
        return records

    # -----------------------------------------------------------------------
    # Critical Corridor Analysis
    # -----------------------------------------------------------------------
    def corridor_analysis(self, top_n: int = 25) -> List[Dict]:
        """
        For each corridor: baseline time, detour time if primary path removed,
        average risk on path, vulnerability tier.
        """
        sub("Running corridor analysis …")
        records = []
        for corridor, base_t in list(BASELINE_PATHS.items())[:top_n]:
            parts = corridor.split("→")
            if len(parts) != 2: continue
            s, t = parts

            try:
                path_nodes = nx.shortest_path(self.G, s, t, weight="travel_time_hr")
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                records.append({
                    "corridor": corridor, "from_node": s, "to_node": t,
                    "base_time_hours": base_t, "detour_time_hours": None,
                    "delay_increase_pct": None, "path_length_nodes": None,
                    "avg_path_risk": None, "vulnerability": "UNKNOWN",
                    "timestamp": TIMESTAMP,
                })
                continue

            # Average risk along path nodes
            path_risks = []
            for n in path_nodes:
                row = self.nodes_df[self.nodes_df[self._id_col] == n]
                if len(row):
                    path_risks.append(float(row.iloc[0].get("composite_risk", 0)))
            avg_risk = round(np.mean(path_risks), 3) if path_risks else 0.0

            # Detour: remove path edges, find alternate
            G_d = self._copy()
            for i in range(len(path_nodes) - 1):
                u, v = path_nodes[i], path_nodes[i + 1]
                if G_d.has_edge(u, v):
                    G_d.remove_edge(u, v)
            try:
                det_t = nx.shortest_path_length(G_d, s, t, weight="travel_time_hr")
                delay_pct = round(100 * (det_t - base_t) / base_t, 1) \
                            if base_t > 0 else 0.0
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                det_t = None; delay_pct = None

            if det_t is None:            vuln = "CRITICAL"
            elif avg_risk > 0.6:         vuln = "HIGH"
            elif avg_risk > 0.35:        vuln = "MEDIUM"
            else:                        vuln = "LOW"

            records.append({
                "corridor":           corridor,
                "from_node":          s, "to_node": t,
                "base_time_hours":    round(base_t, 2),
                "detour_time_hours":  round(det_t, 2) if det_t else None,
                "delay_increase_pct": delay_pct,
                "path_length_nodes":  len(path_nodes),
                "avg_path_risk":      avg_risk,
                "vulnerability":      vuln,
                "timestamp":          TIMESTAMP,
            })
        return records


# ============================================================================
# SECTION 6 — RUN SCENARIOS
# ============================================================================
hdr("SECTION 6 — RUN SCENARIOS")

engine = FullScenarioEngine(G_BASELINE, nodes_df, edges_df)

scenario_results = []

# ---- Standard hazard scenarios ----
for sev, lbl in [(1.0, "moderate"), (1.5, "extreme")]:
    sub(f"Flood scenario ({lbl})")
    r = engine.flood_scenario(severity=sev); scenario_results.append(r)
    info(r["summary_for_llm"][:200])

sub("Cyclone scenario")
r = engine.cyclone_scenario(severity=1.0); scenario_results.append(r)
info(r["summary_for_llm"][:200])

for sev, lbl in [(0.7, "partial"), (1.0, "full_shutdown")]:
    sub(f"Strike scenario ({lbl})")
    r = engine.strike_scenario(severity=sev, label=f"strike_{lbl}")
    scenario_results.append(r); info(r["summary_for_llm"][:200])

sub("Accident scenario")
r = engine.accident_scenario(severity=1.0); scenario_results.append(r)
info(r["summary_for_llm"][:200])

# ---- Individual port / dryport closures ----
sub("Individual port closure scenarios")
for pn in PORT_NODES[:min(3, len(PORT_NODES))]:
    nm = G_BASELINE.nodes[pn].get("name", pn) if pn in G_BASELINE else pn
    r  = engine.node_removal([pn], label=f"port_closure_{nm[:20]}")
    scenario_results.append(r); info(r["summary_for_llm"][:140])

sub("Individual dryport closure scenarios")
for dn in DRYPORT_NODES[:min(3, len(DRYPORT_NODES))]:
    nm = G_BASELINE.nodes[dn].get("name", dn) if dn in G_BASELINE else dn
    r  = engine.node_removal([dn], label=f"dryport_closure_{nm[:20]}")
    scenario_results.append(r); info(r["summary_for_llm"][:140])

# ---- Top chokepoint removal ----
if CHOKEPOINTS:
    sub("Top chokepoint removal")
    r = engine.node_removal([CHOKEPOINTS[0]], label="top_chokepoint_closure")
    scenario_results.append(r); info(r["summary_for_llm"][:200])

# ---- Compound scenarios ----
sub("Compound: Flood + Strike")
r = engine.compound_scenario(["flood","strike"],
                              {"flood":1.0,"strike":0.8},
                              "compound_flood_strike")
scenario_results.append(r); info(r["summary_for_llm"][:200])

sub("Compound: Cyclone + Accident")
r = engine.compound_scenario(["cyclone","accident"],
                              {"cyclone":1.0,"accident":0.7},
                              "compound_cyclone_accident")
scenario_results.append(r); info(r["summary_for_llm"][:200])

sub("Compound: Flood + Cyclone + Strike (worst case)")
r = engine.compound_scenario(["flood","cyclone","strike"],
                              {"flood":1.5,"cyclone":1.2,"strike":1.0},
                              "compound_worst_case")
scenario_results.append(r); info(r["summary_for_llm"][:200])

# ---- Cascading failure ----
if CHOKEPOINTS:
    sub("Cascade from top chokepoint")
    r = engine.cascading_failure([CHOKEPOINTS[0]], cascade_depth=3,
                                  label="cascade_top_chokepoint")
    scenario_results.append(r); info(r["summary_for_llm"][:200])

if PORT_NODES:
    sub("Cascade from primary port")
    r = engine.cascading_failure(PORT_NODES[:1], cascade_depth=3,
                                  label="cascade_port_primary")
    scenario_results.append(r); info(r["summary_for_llm"][:200])

ok(f"Total scenarios run: {len(scenario_results)}")


# ============================================================================
# SECTION 7 — MONTE CARLO
# ============================================================================
hdr("SECTION 7 — MONTE CARLO PROBABILISTIC SIMULATION")

mc_results = engine.monte_carlo(MONTE_CARLO_N, MC_FAILURE_THRESHOLD,
                                 MC_BETA_CONCENTRATION)
for k in ["eff_drop_p50","eff_drop_p90","eff_drop_p99",
          "prob_gt25pct_drop","avg_nodes_failed"]:
    info(f"{k}: {mc_results[k]}")


# ============================================================================
# SECTION 8 — RECOVERY SIMULATION
# ============================================================================
hdr("SECTION 8 — TIME-STEPPED RECOVERY")

worst_sc = max(scenario_results,
               key=lambda r: r["impact_metrics"].get("efficiency_drop_pct", 0))
info(f"Recovery seed: {worst_sc['scenario_id']}")

recovery_records = engine.recovery_simulation(
    worst_sc, TIME_STEPS_HOURS, recovery_half_life_hours=24.0)
for rec in recovery_records:
    info(f"  t={rec['time_hours']:4d}h  "
         f"operational={rec['operational_pct']:5.1f}%  "
         f"eff_drop={rec['eff_drop_pct']:5.2f}%")


# ============================================================================
# SECTION 9 — CORRIDOR ANALYSIS
# ============================================================================
hdr("SECTION 9 — CORRIDOR ANALYSIS")

corridor_records = engine.corridor_analysis(top_n=25)
vuln_counts = {}
for r in corridor_records:
    v = r["vulnerability"]
    vuln_counts[v] = vuln_counts.get(v, 0) + 1
info(f"Vulnerability distribution: {vuln_counts}")


# ============================================================================
# SECTION 10 — ECONOMIC IMPACT SUMMARY
# ============================================================================
hdr("SECTION 10 — ECONOMIC IMPACT SUMMARY")

econ_records = []
for sc in scenario_results:
    econ = sc.get("economic_impact", {})
    econ_records.append({
        "scenario_id":          sc["scenario_id"],
        "scenario_type":        sc["scenario_type"],
        "efficiency_drop_pct":  sc["impact_metrics"].get("efficiency_drop_pct", 0),
        **econ,
        "timestamp": TIMESTAMP,
    })

econ_df = pd.DataFrame(econ_records)
if len(econ_df):
    worst_econ = econ_df.loc[econ_df["daily_trade_loss_usd"].idxmax()]
    info(f"Worst-case daily trade loss: USD {worst_econ['daily_trade_loss_usd']:,.0f}"
         f" → scenario: {worst_econ['scenario_id']}")


# ============================================================================
# SECTION 11 — SPATIAL OUTPUTS FOR MAPS
# ============================================================================
hdr("SECTION 11 — SPATIAL OUTPUTS (Hotspots, Voronoi, Corridors)")

sub("11.1 Scenario hotspot layer (node impact by risk tier)")

# Collect all unique affected nodes across all scenarios
node_impact: Dict[str, Dict] = {}
for sc in scenario_results:
    m   = sc["impact_metrics"]
    eff = m.get("efficiency_drop_pct", 0)
    for nid in m.get("nodes_removed", []):
        if nid not in node_impact or eff > node_impact[nid]["max_eff_drop"]:
            node_impact[nid] = {
                "node_id":       nid,
                "max_eff_drop":  eff,
                "worst_scenario": sc["scenario_id"],
                "scenario_type": sc["scenario_type"],
            }

# Build hotspot GDF
hotspot_rows = []
for nid, data in node_impact.items():
    node_data = G_BASELINE.nodes.get(nid, {})
    lat = float(node_data.get("lat", 0))
    lon = float(node_data.get("lon", 0))
    if lat and lon:
        risk_row = nodes_df[nodes_df[id_col] == nid]
        cr = float(risk_row.iloc[0].get("composite_risk", 0)) if len(risk_row) else 0.0
        hotspot_rows.append({
            "node_id":       nid,
            "name":          node_data.get("name", nid),
            "node_type":     node_data.get("node_type", "unknown"),
            "composite_risk":cr,
            "max_eff_drop":  data["max_eff_drop"],
            "worst_scenario":data["worst_scenario"],
            "geometry":      Point(lon, lat),
        })

hotspot_gdf = gpd.GeoDataFrame(hotspot_rows, crs="EPSG:4326") \
              if hotspot_rows else gpd.GeoDataFrame(columns=["geometry"], crs="EPSG:4326")
ok(f"Hotspot layer: {len(hotspot_gdf)} nodes")

sub("11.2 Corridor risk lines (LineString per corridor)")

corridor_lines = []
for r in corridor_records:
    s_id, t_id = r["from_node"], r["to_node"]
    s_n = G_BASELINE.nodes.get(s_id, {}); t_n = G_BASELINE.nodes.get(t_id, {})
    s_lat = float(s_n.get("lat", 0)); s_lon = float(s_n.get("lon", 0))
    t_lat = float(t_n.get("lat", 0)); t_lon = float(t_n.get("lon", 0))
    if not (s_lat and s_lon and t_lat and t_lon): continue
    corridor_lines.append({
        "corridor":           r["corridor"],
        "from_node":          s_id, "to_node": t_id,
        "base_time_hours":    r["base_time_hours"],
        "detour_time_hours":  r["detour_time_hours"],
        "delay_increase_pct": r["delay_increase_pct"],
        "avg_path_risk":      r["avg_path_risk"],
        "vulnerability":      r["vulnerability"],
        "geometry":           LineString([(s_lon, s_lat), (t_lon, t_lat)]),
    })

corridor_lines_gdf = gpd.GeoDataFrame(corridor_lines, crs="EPSG:4326") \
                     if corridor_lines else \
                     gpd.GeoDataFrame(columns=["geometry"], crs="EPSG:4326")
ok(f"Corridor lines: {len(corridor_lines_gdf)}")

sub("11.3 Recovery stage layer (ports/dryports with recovery timeline)")

recovery_stage_rows = []
for pn in PORT_NODES + DRYPORT_NODES:
    node_data = G_BASELINE.nodes.get(pn, {})
    lat = float(node_data.get("lat", 0))
    lon = float(node_data.get("lon", 0))
    if not (lat and lon): continue
    row_rec = recovery_records[len(recovery_records) // 2]  # midpoint
    risk_row = nodes_df[nodes_df[id_col] == pn]
    cr = float(risk_row.iloc[0].get("composite_risk", 0)) if len(risk_row) else 0.0
    recovery_stage_rows.append({
        "node_id":          pn,
        "name":             node_data.get("name", pn),
        "node_type":        node_data.get("node_type", ""),
        "composite_risk":   cr,
        "recovery_24h_pct": recovery_records[
            min(4, len(recovery_records)-1)]["operational_pct"],
        "geometry":         Point(lon, lat),
    })

recovery_stages_gdf = gpd.GeoDataFrame(recovery_stage_rows, crs="EPSG:4326") \
                      if recovery_stage_rows else \
                      gpd.GeoDataFrame(columns=["geometry"], crs="EPSG:4326")
ok(f"Recovery stage layer: {len(recovery_stages_gdf)} facilities")

sub("11.4 Voronoi risk zones (facility-level risk catchment polygons)")

try:
    from scipy.spatial import Voronoi
    # Collect all facility node coordinates
    fac_pts = []
    fac_meta = []
    for nid in FACILITY_NODES:
        nd = G_BASELINE.nodes.get(nid, {})
        lat, lon = float(nd.get("lat", 0)), float(nd.get("lon", 0))
        if lat and lon:
            fac_pts.append([lon, lat])
            risk_row = nodes_df[nodes_df[id_col] == nid]
            cr = float(risk_row.iloc[0].get("composite_risk", 0)) if len(risk_row) else 0.0
            fac_meta.append({"node_id": nid, "name": nd.get("name", nid),
                             "node_type": nd.get("node_type",""),
                             "composite_risk": cr})

    pk_poly = Polygon([
        (PK_BBOX[0], PK_BBOX[1]), (PK_BBOX[2], PK_BBOX[1]),
        (PK_BBOX[2], PK_BBOX[3]), (PK_BBOX[0], PK_BBOX[3]),
    ])

    if len(fac_pts) >= 4:
        pts = np.array(fac_pts)
        # Add mirror points far outside to close Voronoi regions
        margin = 10.0
        mirrors = [
            [pts[:,0].min()-margin, pts[:,1].mean()],
            [pts[:,0].max()+margin, pts[:,1].mean()],
            [pts[:,0].mean(),       pts[:,1].min()-margin],
            [pts[:,0].mean(),       pts[:,1].max()+margin],
        ]
        all_pts = np.vstack([pts, mirrors])
        vor = Voronoi(all_pts)

        voronoi_rows = []
        from shapely.ops import unary_union
        from shapely.geometry import MultiPoint

        for i, meta in enumerate(fac_meta):
            region_idx = vor.point_region[i]
            region = vor.regions[region_idx]
            if -1 in region or len(region) == 0:
                continue
            verts = [vor.vertices[v] for v in region]
            try:
                poly = Polygon(verts).intersection(pk_poly)
                if not poly.is_empty:
                    voronoi_rows.append({**meta, "geometry": poly})
            except Exception:
                pass

        voronoi_gdf = gpd.GeoDataFrame(voronoi_rows, crs="EPSG:4326") \
                      if voronoi_rows else \
                      gpd.GeoDataFrame(columns=["geometry"], crs="EPSG:4326")
        ok(f"Voronoi zones: {len(voronoi_gdf)}")
    else:
        warn("Not enough facility points for Voronoi — skipping")
        voronoi_gdf = gpd.GeoDataFrame(columns=["geometry"], crs="EPSG:4326")

except ImportError:
    warn("scipy not installed — Voronoi skipped. pip install scipy")
    voronoi_gdf = gpd.GeoDataFrame(columns=["geometry"], crs="EPSG:4326")
except Exception as e:
    warn(f"Voronoi failed: {e}")
    voronoi_gdf = gpd.GeoDataFrame(columns=["geometry"], crs="EPSG:4326")


# ============================================================================
# SECTION 12 — EXPORT TO DB + FILES
# ============================================================================
hdr("SECTION 12 — EXPORT RESULTS")

sub("12.1 Flatten scenario results")
flat_records = []
for sc in scenario_results:
    m    = sc.get("impact_metrics", {})
    econ = sc.get("economic_impact", {})
    flat_records.append({
        "scenario_id":          sc["scenario_id"],
        "scenario_type":        sc["scenario_type"],
        "targets":              json.dumps(sc.get("targets", [])),
        "severity":             sc.get("severity", 1.0),
        "timestamp":            sc.get("timestamp", TIMESTAMP),
        "efficiency_drop_pct":  m.get("efficiency_drop_pct", 0),
        "efficiency_scenario":  m.get("efficiency_scenario", 0),
        "corridors_unreachable":m.get("corridors_unreachable", 0),
        "corridors_delayed":    m.get("corridors_delayed", 0),
        "total_delay_hours":    m.get("total_delay_hours", 0),
        "avg_delay_hours":      m.get("avg_delay_hours", 0),
        "network_components":   m.get("network_components", 1),
        "nodes_removed_count":  m.get("nodes_removed_count", 0),
        "edges_affected_count": m.get("edges_affected_count", 0),
        "cargo_at_risk_usd":    econ.get("cargo_at_risk_usd", 0),
        "delay_cost_usd":       econ.get("delay_cost_usd", 0),
        "daily_trade_loss_usd": econ.get("daily_trade_loss_usd", 0),
        "trade_disruption_pct": econ.get("trade_disruption_pct", 0),
        "summary_for_llm":      sc.get("summary_for_llm", ""),
    })

results_df   = pd.DataFrame(flat_records)
recovery_df  = pd.DataFrame(recovery_records)
corridor_df  = pd.DataFrame(corridor_records)
mc_flat      = {k: v for k, v in mc_results.items() if not isinstance(v, list)}
mc_df        = pd.DataFrame([mc_flat])
mc_dist_df   = pd.DataFrame({
    "run_id":       range(len(mc_results["eff_drop_distribution"])),
    "eff_drop_pct": mc_results["eff_drop_distribution"],
    "timestamp":    TIMESTAMP,
})
econ_df2 = pd.DataFrame(econ_records)

sub("12.2 Write to PostGIS")
if DB is not None:
    write_df_db(results_df,  TABLE_SCEN_LATEST, DB, "replace")
    write_df_db(results_df,  TABLE_SCEN_LOG,    DB, "append")
    write_df_db(mc_df,       TABLE_SCEN_KPIS,   DB, "append")
    write_df_db(mc_dist_df,  TABLE_MC_DIST,     DB, "replace")
    write_df_db(econ_df2,    TABLE_ECON,        DB, "replace")
    write_df_db(corridor_df, TABLE_CORRIDOR,    DB, "replace")
    write_df_db(recovery_df, TABLE_RECOVERY,    DB, "replace")
    if len(hotspot_gdf):
        write_gdf_db(hotspot_gdf, "scenario_hotspots_latest", DB, "replace")
    if len(corridor_lines_gdf):
        write_gdf_db(corridor_lines_gdf, "corridor_risk_lines_latest", DB, "replace")
    if len(voronoi_gdf):
        write_gdf_db(voronoi_gdf, "voronoi_risk_zones", DB, "replace")
    if len(recovery_stages_gdf):
        write_gdf_db(recovery_stages_gdf, "recovery_stages_latest", DB, "replace")

sub("12.3 Write to files")
results_df.to_csv(os.path.join(OUTPUT_DIR, "scenario_results_latest.csv"), index=False)
corridor_df.to_csv(os.path.join(OUTPUT_DIR, "corridor_analysis.csv"), index=False)
recovery_df.to_csv(os.path.join(OUTPUT_DIR, "recovery_timeline.csv"), index=False)
econ_df2.to_csv(os.path.join(OUTPUT_DIR, "economic_impact.csv"), index=False)

if len(hotspot_gdf):
    hotspot_gdf.to_file(
        os.path.join(OUTPUT_DIR, "scenario_hotspots_latest.gpkg"), driver="GPKG")
    ok("[FILE] scenario_hotspots_latest.gpkg")
if len(corridor_lines_gdf):
    corridor_lines_gdf.to_file(
        os.path.join(OUTPUT_DIR, "corridor_risk_lines.gpkg"), driver="GPKG")
    ok("[FILE] corridor_risk_lines.gpkg")
if len(voronoi_gdf):
    voronoi_gdf.to_file(
        os.path.join(OUTPUT_DIR, "voronoi_risk_zones.gpkg"), driver="GPKG")
    ok("[FILE] voronoi_risk_zones.gpkg")
if len(recovery_stages_gdf):
    recovery_stages_gdf.to_file(
        os.path.join(OUTPUT_DIR, "recovery_stages.gpkg"), driver="GPKG")
    ok("[FILE] recovery_stages.gpkg")

with open(os.path.join(OUTPUT_DIR, "montecarlo_summary.json"), "w") as f:
    json.dump(mc_flat, f, indent=2, default=str)
ok("[FILE] montecarlo_summary.json")

with open(os.path.join(OUTPUT_DIR, "economic_impact.json"), "w") as f:
    json.dump(econ_records, f, indent=2, default=str)
ok("[FILE] economic_impact.json")

full_report = {
    "timestamp":           TIMESTAMP,
    "baseline_efficiency": E_BASELINE,
    "scenarios":           scenario_results,
    "monte_carlo":         mc_flat,
    "recovery_timeline":   recovery_records,
    "corridor_analysis":   corridor_records,
    "economic_impact":     econ_records,
}
with open(os.path.join(OUTPUT_DIR, "scenario_full_report.json"), "w") as f:
    json.dump(full_report, f, indent=2, default=str)
ok("[FILE] scenario_full_report.json")

with open(os.path.join(OUTPUT_DIR, "scenario_engine.pkl"), "wb") as f:
    pickle.dump(engine, f, protocol=pickle.HIGHEST_PROTOCOL)
ok("[FILE] scenario_engine.pkl")


# ============================================================================
# FINAL SUMMARY
# ============================================================================
hdr("SCENARIO SIMULATION ENGINE COMPLETE ✓")

if len(results_df):
    best  = results_df.nsmallest(1, "efficiency_drop_pct").iloc[0]
    worst = results_df.nlargest(1,  "efficiency_drop_pct").iloc[0]
    print(f"""
╔══════════════════════════════════════════════════════════════════════════════╗
║            SCENARIO SIMULATION ENGINE v2.0 — RUN SUMMARY                  ║
╚══════════════════════════════════════════════════════════════════════════════╝

  Timestamp          : {TIMESTAMP}
  DB connection      : {'YES' if DB is not None else 'NO (file-only)'}
  Graph type         : SimpleGraph (converted from MultiGraph)
  Baseline efficiency: {E_BASELINE:.4f}
  Corridors tracked  : {len(BASELINE_PATHS)}

  SCENARIOS
    Total: {len(scenario_results)}
    Worst: {worst['scenario_id']}
           efficiency drop = {worst['efficiency_drop_pct']:.1f}%
           trade loss/day  = USD {worst['daily_trade_loss_usd']:,.0f}
    Best : {best['scenario_id']}
           efficiency drop = {best['efficiency_drop_pct']:.1f}%

  MONTE CARLO ({MONTE_CARLO_N} iterations)
    P50={mc_results['eff_drop_p50']}%  P90={mc_results['eff_drop_p90']}%
    P99={mc_results['eff_drop_p99']}%  P(>25%)={mc_results['prob_gt25pct_drop']}%

  CORRIDOR ANALYSIS
    CRITICAL (no detour): {vuln_counts.get('CRITICAL', 0)}
    HIGH:                 {vuln_counts.get('HIGH', 0)}
    MEDIUM:               {vuln_counts.get('MEDIUM', 0)}
    LOW:                  {vuln_counts.get('LOW', 0)}

  SPATIAL OUTPUTS
    Hotspot layer:        scenario_hotspots_latest.gpkg  ({len(hotspot_gdf)} nodes)
    Corridor lines:       corridor_risk_lines.gpkg        ({len(corridor_lines_gdf)} corridors)
    Voronoi zones:        voronoi_risk_zones.gpkg          ({len(voronoi_gdf)} zones)
    Recovery stages:      recovery_stages.gpkg             ({len(recovery_stages_gdf)} facilities)
""")