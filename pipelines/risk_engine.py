"""
==============================================================================
SCRIPT 3 — COMPREHENSIVE RISK ENGINE v8.1 (DB-FIRST)
==============================================================================
FYP: Geo-Resilience for Ports and Supply Chains (Pakistan)

CHANGES FROM v8.0:
    - DB-FIRST I/O: every input is loaded from PostGIS first, with automatic
      fallback to the file version if the DB table is unavailable or empty.
    - Clear source-of-truth logging: every load tells you whether it came
      from the database or from a file, so you always know the provenance.
    - ALL outputs are written to BOTH the database AND local files.
    - Handles column-name variation between DB and files robustly.

INPUT PROVENANCE (priority order):
    1. graph_baseline.gpickle          FILE ONLY
       (NetworkX graph pickle — not stored in DB)
    
    2. Node attributes                 DB: baseline_node_metrics
                                       FILE: outputs/nodes_attributed.csv
    
    3. Edge attributes                 DB: baseline_edge_metrics
                                       FILE: outputs/edges_attributed.csv
    
    4. Node geometries                 DB: network_nodes
                                       FILE: outputs/nodes.gpkg
    
    5. Edge geometries                 DB: network_edges
                                       FILE: outputs/edges.gpkg
    
    6. Node hazard scores              DB: hazard_nodes_latest
                                       FILE: (skipped — zero-hazard fallback)
    
    7. Edge hazard scores              DB: hazard_edges_latest
                                       FILE: (skipped — zero-hazard fallback)

OUTPUTS (written to BOTH):
    FILES (in outputs/):
        risk_nodes_latest.gpkg    risk_edges_latest.gpkg
        risk_nodes_latest.csv     risk_edges_latest.csv
        risk_summary.json         scenario_engine.pkl
    
    POSTGIS TABLES:
        risk_nodes_latest   (REPLACED each run)
        risk_edges_latest   (REPLACED each run)
        risk_nodes_log      (APPENDED — history for time-slider)
        risk_edges_log      (APPENDED — history for time-slider)
        risk_kpis_log       (APPENDED — KPI time series)

METHODOLOGY (unchanged from v8.0):
    Risk = Hazard × Exposure × Vulnerability   (UNDRR Sendai Framework)
    Composite risk aggregated via Noisy-OR probability model.
    Network criticality = composite_risk × centrality-weighted importance.
    Tiers: CRITICAL / HIGH / MEDIUM / LOW.

==============================================================================
"""

import os, sys, math, json, time, pickle, warnings
from datetime import datetime
from typing import Dict, List, Tuple, Optional, Any

import numpy as np
import pandas as pd
import geopandas as gpd
import networkx as nx
from shapely.geometry import Point, LineString
from sqlalchemy import create_engine, text, inspect

warnings.filterwarnings('ignore')

# ============================================================================
# CONFIGURATION
# ============================================================================
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")
os.makedirs(OUTPUT_DIR, exist_ok=True)

TIMESTAMP = datetime.utcnow().strftime("%Y%m%d_%H%M%S")

# ---- Database ----
DB_HOST   = os.environ.get("DB_HOST", "localhost")
DB_PORT   = int(os.environ.get("DB_PORT", 5432))
DB_NAME   = os.environ.get("DB_NAME", "fyp_georesilience")
DB_USER   = os.environ.get("DB_USER", "fyp_user")
DB_PASS   = os.environ.get("DB_PASSWORD", "fyp_pass")
DB_SCHEMA = "public"

# ---- Table names (DB inputs) ----
TABLE_NODE_ATTR   = "baseline_node_metrics"
TABLE_EDGE_ATTR   = "baseline_edge_metrics"
TABLE_NODE_GEOM   = "network_nodes"
TABLE_EDGE_GEOM   = "network_edges"
TABLE_NODE_HAZ    = "hazard_nodes_latest"
TABLE_EDGE_HAZ    = "hazard_edges_latest"

# ---- Table names (DB outputs) ----
TABLE_RISK_NODES_LATEST = "risk_nodes_latest"
TABLE_RISK_EDGES_LATEST = "risk_edges_latest"
TABLE_RISK_NODES_LOG    = "risk_nodes_log"
TABLE_RISK_EDGES_LOG    = "risk_edges_log"
TABLE_RISK_KPIS_LOG     = "risk_kpis_log"

# ---- File inputs (fallback) ----
FILE_GRAPH_PKL    = "graph_baseline.gpickle"
FILE_NODE_ATTR    = "nodes_attributed.csv"
FILE_EDGE_ATTR    = "edges_attributed.csv"
FILE_NODE_GEOM    = "nodes.gpkg"
FILE_EDGE_GEOM    = "edges.gpkg"

# ============================================================================
# VULNERABILITY MATRICES (UNDRR-based, calibrated for Pakistan)
# ============================================================================
VULNERABILITY_FLOOD = {
    'port': 0.75, 'dryport': 0.00, 'rail_station': 0.55,
    'road_intersection': 0.45, 'rail_intersection': 0.50,
    'road': 0.70, 'rail': 0.65, 'intermodal': 0.35,
}
VULNERABILITY_CYCLONE = {
    'port': 0.85, 'dryport': 0.25, 'rail_station': 0.45,
    'road_intersection': 0.35, 'rail_intersection': 0.40,
    'road': 0.40, 'rail': 0.55, 'intermodal': 0.35,
}
VULNERABILITY_STRIKE = {
    'port': 0.90, 'dryport': 0.80, 'rail_station': 0.65,
    'road_intersection': 0.35, 'rail_intersection': 0.40,
    'road': 0.45, 'rail': 0.55, 'intermodal': 0.40,
}
VULNERABILITY_ACCIDENT = {
    'port': 0.50, 'dryport': 0.45, 'rail_station': 0.60,
    'road_intersection': 0.75, 'rail_intersection': 0.50,
    'road': 0.60, 'rail': 0.65, 'intermodal': 0.45,
}

ROAD_IMPORTANCE = {
    'motorway': 1.00, 'trunk': 1.00, 'primary': 0.85,
    'secondary': 0.55, 'tertiary': 0.40,
    'ml1': 1.00, 'ml2': 0.90, 'ml3': 0.80,
    'connecting': 0.60, 'intermodal': 0.50,
    'fallback_access': 0.35, 'bridge_access': 0.30, 'unknown': 0.45,
}

NODE_IMPORTANCE_MULTIPLIER = {
    'port': 1.00, 'dryport': 0.90, 'rail_station': 0.75,
    'road_intersection': 0.65, 'rail_intersection': 0.55,
}

RISK_THRESHOLDS = {
    'composite': {'CRITICAL': 0.75, 'HIGH': 0.55, 'MEDIUM': 0.35},
    'network':   {'CRITICAL': 0.70, 'HIGH': 0.50, 'MEDIUM': 0.30},
}

COMPOSITE_WEIGHTS = {'natural': 0.60, 'human': 0.40}

HAZARD_COLS = ['hazard_flood', 'hazard_cyclone', 'hazard_strike', 'hazard_accident']

# ============================================================================
# LOGGING
# ============================================================================
def hdr(text: str):
    print(f"\n{'=' * 78}\n  {text}\n{'=' * 78}")

def sub(text: str):
    print(f"\n  ▸ {text}")

def info(text: str):
    print(f"    {text}")

def ok(text: str):
    print(f"    ✓ {text}")

def warn(text: str):
    print(f"    ⚠ {text}")


# ============================================================================
# DATABASE HELPERS
# ============================================================================
def get_db_engine():
    """Connect to PostGIS. Returns engine or None."""
    try:
        engine = create_engine(
            f"postgresql://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}",
            pool_pre_ping=True
        )
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        ok(f"[DB] Connected to {DB_NAME}")
        return engine
    except Exception as e:
        warn(f"[DB] Connection failed: {e}")
        warn(f"[DB] Will fall back to local files in {OUTPUT_DIR}")
        return None


def table_exists(engine, table: str, schema: str = DB_SCHEMA) -> bool:
    """Check whether a table exists in the database."""
    if engine is None:
        return False
    try:
        insp = inspect(engine)
        return insp.has_table(table, schema=schema)
    except Exception:
        return False


def read_db_spatial(engine, table: str, geom_col: str = "geometry") -> Optional[gpd.GeoDataFrame]:
    """Read a spatial table from PostGIS. Returns None on failure."""
    if not table_exists(engine, table):
        return None
    try:
        gdf = gpd.read_postgis(
            f'SELECT * FROM {DB_SCHEMA}."{table}"',
            engine, geom_col=geom_col
        )
        if len(gdf) == 0:
            warn(f"[DB] {table} is empty")
            return None
        ok(f"[DB] {table}: {len(gdf)} rows loaded")
        return gdf
    except Exception as e:
        warn(f"[DB] Could not read {table}: {e}")
        return None


def read_db_tabular(engine, table: str) -> Optional[pd.DataFrame]:
    """Read a non-spatial table from PostGIS. Returns None on failure."""
    if not table_exists(engine, table):
        return None
    try:
        df = pd.read_sql(f'SELECT * FROM {DB_SCHEMA}."{table}"', engine)
        if len(df) == 0:
            warn(f"[DB] {table} is empty")
            return None
        ok(f"[DB] {table}: {len(df)} rows loaded")
        return df
    except Exception as e:
        warn(f"[DB] Could not read {table}: {e}")
        return None


def write_postgis(gdf: gpd.GeoDataFrame, table: str, engine, if_exists: str = "replace"):
    """Write GeoDataFrame to PostGIS."""
    if engine is None:
        warn(f"[DB] Skipped {table} (no connection)")
        return False
    try:
        g = gdf.copy()
        if g.geometry.name != 'geometry':
            g = g.rename_geometry('geometry')
        # Ensure CRS is set
        if g.crs is None:
            g.set_crs("EPSG:4326", inplace=True)
        g.to_postgis(
            table, engine, schema=DB_SCHEMA,
            if_exists=if_exists, index=False, chunksize=500
        )
        ok(f"[DB] {table} ({if_exists}): {len(gdf)} rows")
        return True
    except Exception as e:
        warn(f"[DB] Failed to write {table}: {e}")
        return False


def write_table(df: pd.DataFrame, table: str, engine, if_exists: str = "append"):
    """Write plain DataFrame to PostGIS."""
    if engine is None:
        return False
    try:
        df.to_sql(table, engine, schema=DB_SCHEMA,
                  if_exists=if_exists, index=False, chunksize=500)
        ok(f"[DB] {table} ({if_exists}): {len(df)} rows")
        return True
    except Exception as e:
        warn(f"[DB] Failed to write {table}: {e}")
        return False


# ============================================================================
# UTILITY
# ============================================================================
def normalize_column(series: pd.Series) -> pd.Series:
    """Min-max normalize to [0, 1]."""
    s = series.fillna(0)
    mn, mx = s.min(), s.max()
    if mx - mn == 0:
        return pd.Series(0.0, index=s.index)
    return (s - mn) / (mx - mn)


def file_fallback(filename: str) -> Optional[str]:
    """Return full path if file exists, else None."""
    path = os.path.join(OUTPUT_DIR, filename)
    return path if os.path.exists(path) else None


# ============================================================================
# STEP 1 — LOAD INPUTS (DB-FIRST, FILE FALLBACK)
# ============================================================================
hdr("STEP 1 — LOAD INPUTS (DB-first, file fallback)")

engine = get_db_engine()

# --------------------------------------------------------------------------
# 1.1 GRAPH (file only — NetworkX pickle is not stored in DB)
# --------------------------------------------------------------------------
sub("1.1 Network graph  (FILE ONLY)")

graph_path = os.path.join(OUTPUT_DIR, FILE_GRAPH_PKL)
if not os.path.exists(graph_path):
    print(f"\n  ❌ FATAL: {graph_path} not found.")
    print("     The graph pickle is not stored in the database — it must")
    print("     exist as a file. Run network_model.py (Script 1) first.")
    sys.exit(1)

with open(graph_path, 'rb') as f:
    G_baseline = pickle.load(f)

ok(f"[FILE] graph_baseline.gpickle: "
   f"{G_baseline.number_of_nodes()} nodes, {G_baseline.number_of_edges()} edges")


# --------------------------------------------------------------------------
# 1.2 NODE ATTRIBUTES (DB: baseline_node_metrics  →  FILE: nodes_attributed.csv)
# --------------------------------------------------------------------------
sub("1.2 Node attributes  (DB → FILE fallback)")

nodes_attr = read_db_tabular(engine, TABLE_NODE_ATTR)
if nodes_attr is None:
    fp = file_fallback(FILE_NODE_ATTR)
    if fp is None:
        print(f"\n  ❌ FATAL: No node attributes found in DB or in {FILE_NODE_ATTR}")
        sys.exit(1)
    nodes_attr = pd.read_csv(fp)
    ok(f"[FILE] {FILE_NODE_ATTR}: {len(nodes_attr)} rows loaded")
else:
    info("source: PostGIS")


# --------------------------------------------------------------------------
# 1.3 EDGE ATTRIBUTES (DB: baseline_edge_metrics  →  FILE: edges_attributed.csv)
# --------------------------------------------------------------------------
sub("1.3 Edge attributes  (DB → FILE fallback)")

edges_attr = read_db_tabular(engine, TABLE_EDGE_ATTR)
if edges_attr is None:
    fp = file_fallback(FILE_EDGE_ATTR)
    if fp is None:
        print(f"\n  ❌ FATAL: No edge attributes found in DB or in {FILE_EDGE_ATTR}")
        sys.exit(1)
    edges_attr = pd.read_csv(fp)
    ok(f"[FILE] {FILE_EDGE_ATTR}: {len(edges_attr)} rows loaded")
else:
    info("source: PostGIS")


# --------------------------------------------------------------------------
# 1.4 NODE GEOMETRIES (DB: network_nodes  →  FILE: nodes.gpkg)
# --------------------------------------------------------------------------
sub("1.4 Node geometries  (DB → FILE fallback)")

nodes_geom = read_db_spatial(engine, TABLE_NODE_GEOM)
if nodes_geom is None:
    fp = file_fallback(FILE_NODE_GEOM)
    if fp is None:
        warn(f"No node geometries in DB or {FILE_NODE_GEOM}")
        warn("Will construct Point geometries from lon/lat in attributes")
        nodes_geom = None
    else:
        nodes_geom = gpd.read_file(fp)
        ok(f"[FILE] {FILE_NODE_GEOM}: {len(nodes_geom)} rows loaded")
else:
    info("source: PostGIS")


# --------------------------------------------------------------------------
# 1.5 EDGE GEOMETRIES (DB: network_edges  →  FILE: edges.gpkg)
# --------------------------------------------------------------------------
sub("1.5 Edge geometries  (DB → FILE fallback)")

edges_geom = read_db_spatial(engine, TABLE_EDGE_GEOM)
if edges_geom is None:
    fp = file_fallback(FILE_EDGE_GEOM)
    if fp is None:
        print(f"\n  ❌ FATAL: No edge geometries in DB or in {FILE_EDGE_GEOM}")
        sys.exit(1)
    edges_geom = gpd.read_file(fp)
    ok(f"[FILE] {FILE_EDGE_GEOM}: {len(edges_geom)} rows loaded")
else:
    info("source: PostGIS")


# --------------------------------------------------------------------------
# 1.6 NODE HAZARD SCORES (DB: hazard_nodes_latest  →  ZERO fallback)
# --------------------------------------------------------------------------
sub("1.6 Node hazard scores  (DB → ZERO fallback)")

nodes_hazard = read_db_spatial(engine, TABLE_NODE_HAZ)
if nodes_hazard is None:
    warn("No hazard data for nodes — creating ZERO-hazard baseline")
    warn("Run hazard_model.py (Script 2) for real hazard scores")
    nodes_hazard = nodes_geom.copy() if nodes_geom is not None else pd.DataFrame({
        'asset_id': nodes_attr['asset_id']
    })
    for c in HAZARD_COLS:
        nodes_hazard[c] = 0.0
    nodes_hazard['composite_hazard'] = 0.0
else:
    info("source: PostGIS")


# --------------------------------------------------------------------------
# 1.7 EDGE HAZARD SCORES (DB: hazard_edges_latest  →  ZERO fallback)
# --------------------------------------------------------------------------
sub("1.7 Edge hazard scores  (DB → ZERO fallback)")

edges_hazard = read_db_spatial(engine, TABLE_EDGE_HAZ)
if edges_hazard is None:
    warn("No hazard data for edges — creating ZERO-hazard baseline")
    edges_hazard = edges_geom.copy() if edges_geom is not None else pd.DataFrame({
        'asset_id': edges_attr['asset_id']
    })
    for c in HAZARD_COLS:
        edges_hazard[c] = 0.0
    edges_hazard['composite_hazard'] = 0.0
else:
    info("source: PostGIS")


# ============================================================================
# STEP 2 — MERGE ATTRIBUTES + GEOMETRIES + HAZARDS
# ============================================================================
hdr("STEP 2 — MERGE ATTRIBUTES + GEOMETRIES + HAZARDS")

# --- NODES ---------------------------------------------------------------
sub("2.1 Merge node attributes → geometry → hazards")

# Step A: attach geometry to the attributes frame
if nodes_geom is not None and 'geometry' in nodes_geom.columns:
    # drop duplicate columns from geom frame
    geom_cols_keep = ['asset_id', 'geometry']
    ngeom = nodes_geom[[c for c in geom_cols_keep if c in nodes_geom.columns]].copy()
    nodes_merged = nodes_attr.merge(ngeom, on='asset_id', how='left')
else:
    # Fallback: build Point geometry from lon/lat
    if 'lon' in nodes_attr.columns and 'lat' in nodes_attr.columns:
        nodes_merged = nodes_attr.copy()
        nodes_merged['geometry'] = nodes_merged.apply(
            lambda r: Point(r['lon'], r['lat']) if pd.notna(r['lon']) else None,
            axis=1
        )
    else:
        print("\n  ❌ FATAL: cannot build node geometries (no lon/lat and no GPKG)")
        sys.exit(1)

# Step B: attach hazard scores
haz_keep = ['asset_id'] + HAZARD_COLS + ['composite_hazard']
haz_keep = [c for c in haz_keep if c in nodes_hazard.columns]
nodes_merged = nodes_merged.merge(
    nodes_hazard[haz_keep],
    on='asset_id', how='left', suffixes=('', '_haz')
)

# Fill missing hazards with 0
for c in HAZARD_COLS + ['composite_hazard']:
    if c not in nodes_merged.columns:
        nodes_merged[c] = 0.0
    else:
        nodes_merged[c] = nodes_merged[c].fillna(0.0)

nodes_gdf = gpd.GeoDataFrame(nodes_merged, geometry='geometry', crs="EPSG:4326")
ok(f"Merged nodes: {len(nodes_gdf)} rows, {len(nodes_gdf.columns)} columns")


# --- EDGES ---------------------------------------------------------------
sub("2.2 Merge edge attributes → geometry → hazards")

if edges_geom is not None and 'geometry' in edges_geom.columns:
    egeom = edges_geom[['asset_id', 'geometry']].copy()
    edges_merged = edges_attr.merge(egeom, on='asset_id', how='left')
else:
    print("\n  ❌ FATAL: cannot build edge geometries (need LineString from gpkg/DB)")
    sys.exit(1)

haz_keep_e = ['asset_id'] + HAZARD_COLS + ['composite_hazard']
haz_keep_e = [c for c in haz_keep_e if c in edges_hazard.columns]
edges_merged = edges_merged.merge(
    edges_hazard[haz_keep_e],
    on='asset_id', how='left', suffixes=('', '_haz')
)

for c in HAZARD_COLS + ['composite_hazard']:
    if c not in edges_merged.columns:
        edges_merged[c] = 0.0
    else:
        edges_merged[c] = edges_merged[c].fillna(0.0)

edges_gdf = gpd.GeoDataFrame(edges_merged, geometry='geometry', crs="EPSG:4326")
ok(f"Merged edges: {len(edges_gdf)} rows, {len(edges_gdf.columns)} columns")


# ============================================================================
# STEP 3 — EXPOSURE MODELING
# ============================================================================
hdr("STEP 3 — EXPOSURE MODELING  (how much of the asset is in the hazard zone)")

def node_exposure(row: pd.Series, hz: str) -> float:
    h = row.get(f'hazard_{hz}', 0.0)
    if pd.isna(h) or h <= 0.001:
        return 0.0
    presence   = min(float(h), 1.0)
    importance = NODE_IMPORTANCE_MULTIPLIER.get(row.get('node_type', ''), 0.5)
    degree     = row.get('degree', 1)
    connectivity = 1.0 + 0.3 * min(float(degree) / 10.0, 1.0)
    return min(presence * importance * connectivity, 1.0)


def edge_exposure(row: pd.Series, hz: str) -> float:
    h = row.get(f'hazard_{hz}', 0.0)
    if pd.isna(h) or h <= 0.001:
        return 0.0
    presence = min(float(h), 1.0)
    rt       = ROAD_IMPORTANCE.get(row.get('road_type', ''), 0.5)
    length   = row.get('length_km', 1.0) or 1.0
    lf       = 1.0 + 0.2 * min(float(length) / 50.0, 1.0)
    cap      = row.get('capacity_index', 0.5) or 0.5
    cf       = 1.0 + 0.3 * float(cap)
    return min(presence * rt * lf * cf, 1.0)


for hz in ['flood', 'cyclone', 'strike', 'accident']:
    nodes_gdf[f'exposure_{hz}'] = nodes_gdf.apply(lambda r: node_exposure(r, hz), axis=1)
    edges_gdf[f'exposure_{hz}'] = edges_gdf.apply(lambda r: edge_exposure(r, hz), axis=1)

ok(f"Computed exposure for {len(nodes_gdf)} nodes and {len(edges_gdf)} edges "
   f"across 4 hazard types")


# ============================================================================
# STEP 4 — VULNERABILITY ASSIGNMENT
# ============================================================================
hdr("STEP 4 — VULNERABILITY ASSIGNMENT  (asset susceptibility when exposed)")

vuln_map = {
    'flood':    VULNERABILITY_FLOOD,
    'cyclone':  VULNERABILITY_CYCLONE,
    'strike':   VULNERABILITY_STRIKE,
    'accident': VULNERABILITY_ACCIDENT,
}

for hz in ['flood', 'cyclone', 'strike', 'accident']:
    nodes_gdf[f'vulnerability_{hz}'] = (
        nodes_gdf['node_type'].map(vuln_map[hz]).fillna(0.5)
    )
    edges_gdf[f'vulnerability_{hz}'] = (
        edges_gdf['mode'].map(vuln_map[hz]).fillna(0.5)
    )

ok("Assigned vulnerability scores for all asset/hazard combinations")


# ============================================================================
# STEP 5 — RISK CALCULATION  (H × E × V)
# ============================================================================
hdr("STEP 5 — RISK CALCULATION  (Risk = Hazard × Exposure × Vulnerability)")

for hz in ['flood', 'cyclone', 'strike', 'accident']:
    nodes_gdf[f'risk_{hz}'] = (
        nodes_gdf[f'hazard_{hz}'] *
        nodes_gdf[f'exposure_{hz}'] *
        nodes_gdf[f'vulnerability_{hz}']
    ).clip(0, 1).round(4)

    edges_gdf[f'risk_{hz}'] = (
        edges_gdf[f'hazard_{hz}'] *
        edges_gdf[f'exposure_{hz}'] *
        edges_gdf[f'vulnerability_{hz}']
    ).clip(0, 1).round(4)

ok("Per-hazard risk scores computed")


# ============================================================================
# STEP 6 — COMPOSITE RISK  (Noisy-OR aggregation)
# ============================================================================
hdr("STEP 6 — COMPOSITE RISK  (multi-hazard aggregation via Noisy-OR)")

def composite_risk(row: pd.Series) -> pd.Series:
    r_nat = max(row.get('risk_flood', 0.0),   row.get('risk_cyclone', 0.0))
    r_hum = max(row.get('risk_strike', 0.0),  row.get('risk_accident', 0.0))
    w_nat = COMPOSITE_WEIGHTS['natural']
    w_hum = COMPOSITE_WEIGHTS['human']
    p_safe = (1.0 - r_nat * w_nat) * (1.0 - r_hum * w_hum)
    return pd.Series({
        'risk_natural':   round(r_nat, 4),
        'risk_human':     round(r_hum, 4),
        'composite_risk': round(1.0 - p_safe, 4),
    })

n_comp = nodes_gdf.apply(composite_risk, axis=1)
nodes_gdf[['risk_natural', 'risk_human', 'composite_risk']] = n_comp

e_comp = edges_gdf.apply(composite_risk, axis=1)
edges_gdf[['risk_natural', 'risk_human', 'composite_risk']] = e_comp

info(f"Node composite — mean: {nodes_gdf['composite_risk'].mean():.3f}, "
     f"max: {nodes_gdf['composite_risk'].max():.3f}")
info(f"Edge composite — mean: {edges_gdf['composite_risk'].mean():.3f}, "
     f"max: {edges_gdf['composite_risk'].max():.3f}")


# ============================================================================
# STEP 7 — NETWORK CRITICALITY RISK
# ============================================================================
hdr("STEP 7 — NETWORK CRITICALITY RISK  (composite × topology importance)")

def node_importance(row: pd.Series) -> float:
    bc = row.get('betweenness_centrality', 0.0) or 0.0
    dc = row.get('degree_centrality',     0.0) or 0.0
    ec = row.get('eigenvector_centrality', 0.0) or 0.0
    cc = row.get('closeness_centrality',   0.0) or 0.0
    return round(0.40*bc + 0.25*dc + 0.20*ec + 0.15*cc, 4)

nodes_gdf['importance_score'] = nodes_gdf.apply(node_importance, axis=1)
nodes_gdf['network_criticality_risk'] = (
    nodes_gdf['composite_risk'] * nodes_gdf['importance_score']
).clip(0, 1).round(4)

# Edges use normalized edge betweenness as importance proxy
edges_gdf['importance_score'] = normalize_column(
    edges_gdf['edge_betweenness'] if 'edge_betweenness' in edges_gdf.columns
    else pd.Series(0.0, index=edges_gdf.index)
).round(4)
edges_gdf['network_criticality_risk'] = (
    edges_gdf['composite_risk'] * edges_gdf['importance_score']
).clip(0, 1).round(4)

ok(f"Node net-risk max: {nodes_gdf['network_criticality_risk'].max():.3f} | "
   f"Edge net-risk max: {edges_gdf['network_criticality_risk'].max():.3f}")


# ============================================================================
# STEP 8 — RISK TIERING
# ============================================================================
hdr("STEP 8 — RISK TIER CLASSIFICATION")

def assign_tier(row: pd.Series) -> str:
    cr = row.get('composite_risk', 0.0)
    nr = row.get('network_criticality_risk', 0.0)
    if cr >= RISK_THRESHOLDS['composite']['CRITICAL'] or nr >= RISK_THRESHOLDS['network']['CRITICAL']:
        return 'CRITICAL'
    if cr >= RISK_THRESHOLDS['composite']['HIGH'] or nr >= RISK_THRESHOLDS['network']['HIGH']:
        return 'HIGH'
    if cr >= RISK_THRESHOLDS['composite']['MEDIUM'] or nr >= RISK_THRESHOLDS['network']['MEDIUM']:
        return 'MEDIUM'
    return 'LOW'

nodes_gdf['risk_tier'] = nodes_gdf.apply(assign_tier, axis=1)
edges_gdf['risk_tier'] = edges_gdf.apply(assign_tier, axis=1)

info("Node Risk Tier Distribution:")
for tier in ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']:
    n = int((nodes_gdf['risk_tier'] == tier).sum())
    pct = 100 * n / max(len(nodes_gdf), 1)
    info(f"  {tier:10s}: {n:5d}  ({pct:5.1f}%)")

info("\n    Edge Risk Tier Distribution:")
for tier in ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']:
    n = int((edges_gdf['risk_tier'] == tier).sum())
    pct = 100 * n / max(len(edges_gdf), 1)
    info(f"  {tier:10s}: {n:5d}  ({pct:5.1f}%)")


# ============================================================================
# STEP 9 — CHOKEPOINT IDENTIFICATION
# ============================================================================
hdr("STEP 9 — CHOKEPOINT IDENTIFICATION  (high centrality + high risk)")

nodes_gdf['is_chokepoint'] = (
    (nodes_gdf['betweenness_centrality'].fillna(0) >= 0.10) &
    (nodes_gdf['composite_risk'] >= 0.50)
)

chokepoints = nodes_gdf[nodes_gdf['is_chokepoint']].sort_values(
    'network_criticality_risk', ascending=False
)
info(f"Identified {len(chokepoints)} chokepoints")
if len(chokepoints) > 0:
    info("Top chokepoints:")
    for _, row in chokepoints.head(5).iterrows():
        info(f"  • {str(row.get('name','—'))[:30]:30s}  "
             f"risk={row['composite_risk']:.2f}  BC={row['betweenness_centrality']:.3f}")


# ============================================================================
# STEP 10 — METADATA STAMPING
# ============================================================================
hdr("STEP 10 — METADATA STAMPING")

ts_iso = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
for g in (nodes_gdf, edges_gdf):
    g['timestamp']     = TIMESTAMP
    g['analysis_date'] = ts_iso

ok(f"Stamped with timestamp {TIMESTAMP}")


# ============================================================================
# STEP 11 — EXPORT OUTPUTS (BOTH FILES AND DATABASE)
# ============================================================================
hdr("STEP 11 — EXPORT OUTPUTS  (files AND database)")

# Build export schemas, using only columns that actually exist
NODE_COLS = [
    'asset_id', 'node_id', 'node_type', 'name', 'lon', 'lat',
    'hazard_flood', 'hazard_cyclone', 'hazard_strike', 'hazard_accident',
    'exposure_flood', 'exposure_cyclone', 'exposure_strike', 'exposure_accident',
    'vulnerability_flood', 'vulnerability_cyclone',
    'vulnerability_strike', 'vulnerability_accident',
    'risk_flood', 'risk_cyclone', 'risk_strike', 'risk_accident',
    'risk_natural', 'risk_human', 'composite_risk',
    'betweenness_centrality', 'degree_centrality',
    'closeness_centrality', 'eigenvector_centrality',
    'importance_score', 'network_criticality_risk',
    'risk_tier', 'is_chokepoint',
    'timestamp', 'analysis_date', 'geometry'
]

EDGE_COLS = [
    'asset_id', 'edge_id', 'from_node', 'to_node', 'mode', 'road_type',
    'length_km', 'avg_speed_kmh', 'travel_time_hr',
    'hazard_flood', 'hazard_cyclone', 'hazard_strike', 'hazard_accident',
    'exposure_flood', 'exposure_cyclone', 'exposure_strike', 'exposure_accident',
    'vulnerability_flood', 'vulnerability_cyclone',
    'vulnerability_strike', 'vulnerability_accident',
    'risk_flood', 'risk_cyclone', 'risk_strike', 'risk_accident',
    'risk_natural', 'risk_human', 'composite_risk',
    'edge_betweenness', 'importance_score', 'network_criticality_risk',
    'risk_tier', 'timestamp', 'analysis_date', 'geometry'
]

n_cols = [c for c in NODE_COLS if c in nodes_gdf.columns]
e_cols = [c for c in EDGE_COLS if c in edges_gdf.columns]

nodes_export = nodes_gdf[n_cols].copy()
edges_export = edges_gdf[e_cols].copy()

# ---- 11.1  FILES ----------------------------------------------------------
sub("11.1 Write files")

path_n_gpkg = os.path.join(OUTPUT_DIR, "risk_nodes_latest.gpkg")
path_e_gpkg = os.path.join(OUTPUT_DIR, "risk_edges_latest.gpkg")
nodes_export.to_file(path_n_gpkg, driver="GPKG")
edges_export.to_file(path_e_gpkg, driver="GPKG")
ok(f"[FILE] risk_nodes_latest.gpkg: {len(nodes_export)}")
ok(f"[FILE] risk_edges_latest.gpkg: {len(edges_export)}")

path_n_csv = os.path.join(OUTPUT_DIR, "risk_nodes_latest.csv")
path_e_csv = os.path.join(OUTPUT_DIR, "risk_edges_latest.csv")
nodes_export.drop(columns=['geometry']).to_csv(path_n_csv, index=False)
edges_export.drop(columns=['geometry']).to_csv(path_e_csv, index=False)
ok(f"[FILE] risk_nodes_latest.csv")
ok(f"[FILE] risk_edges_latest.csv")


# ---- 11.2  POSTGIS --------------------------------------------------------
sub("11.2 Write to PostGIS")

if engine is not None:
    # LATEST state (replace)
    write_postgis(nodes_export, TABLE_RISK_NODES_LATEST, engine, if_exists="replace")
    write_postgis(edges_export, TABLE_RISK_EDGES_LATEST, engine, if_exists="replace")
    
    # LOG (append) — one row per run, time-slider ready
    write_postgis(nodes_export, TABLE_RISK_NODES_LOG, engine, if_exists="append")
    write_postgis(edges_export, TABLE_RISK_EDGES_LOG, engine, if_exists="append")
    
    # Create useful indexes
    try:
        with engine.connect() as conn:
            conn.execute(text(f'CREATE INDEX IF NOT EXISTS idx_risk_nodes_log_ts ON {TABLE_RISK_NODES_LOG} ("timestamp")'))
            conn.execute(text(f'CREATE INDEX IF NOT EXISTS idx_risk_edges_log_ts ON {TABLE_RISK_EDGES_LOG} ("timestamp")'))
            conn.execute(text(f'CREATE INDEX IF NOT EXISTS idx_risk_nodes_tier  ON {TABLE_RISK_NODES_LATEST} (risk_tier)'))
            conn.execute(text(f'CREATE INDEX IF NOT EXISTS idx_risk_edges_tier  ON {TABLE_RISK_EDGES_LATEST} (risk_tier)'))
            conn.commit()
        ok("[DB] Indexes created/verified")
    except Exception as e:
        warn(f"[DB] Index creation warning: {e}")
else:
    warn("[DB] Skipping DB writes (no connection) — files were still written")


# ============================================================================
# STEP 12 — KPI SUMMARY  (JSON + DB log)
# ============================================================================
hdr("STEP 12 — KPI SUMMARY")

def top_n_df_to_records(df, col, n=10, cols_keep=None):
    if col not in df.columns or len(df) == 0:
        return []
    d = df.nlargest(n, col)
    if cols_keep:
        cols_keep = [c for c in cols_keep if c in d.columns]
        d = d[cols_keep]
    return d.to_dict('records')

top_10_nodes = top_n_df_to_records(
    nodes_gdf, 'network_criticality_risk', 10,
    ['asset_id', 'name', 'node_type', 'composite_risk',
     'network_criticality_risk', 'risk_tier']
)
top_10_edges = top_n_df_to_records(
    edges_gdf, 'network_criticality_risk', 10,
    ['asset_id', 'from_node', 'to_node', 'mode', 'road_type',
     'composite_risk', 'network_criticality_risk', 'risk_tier']
)

def count_tier(df, tier):
    return int((df['risk_tier'] == tier).sum())

kpi = {
    'metadata': {
        'timestamp':     TIMESTAMP,
        'analysis_date': ts_iso,
        'version':       'risk_engine_v8.1_db_first',
    },
    'network_overview': {
        'total_nodes': int(len(nodes_gdf)),
        'total_edges': int(len(edges_gdf)),
        'ports':         int((nodes_gdf['node_type'] == 'port').sum()),
        'dryports':      int((nodes_gdf['node_type'] == 'dryport').sum()),
        'rail_stations': int((nodes_gdf['node_type'] == 'rail_station').sum()),
    },
    'risk_distribution': {
        'nodes': {t.lower(): count_tier(nodes_gdf, t)
                  for t in ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']},
        'edges': {t.lower(): count_tier(edges_gdf, t)
                  for t in ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']},
    },
    'risk_statistics': {
        'nodes': {
            'mean_composite_risk': float(round(nodes_gdf['composite_risk'].mean(), 4)),
            'max_composite_risk':  float(round(nodes_gdf['composite_risk'].max(),  4)),
            'mean_network_risk':   float(round(nodes_gdf['network_criticality_risk'].mean(), 4)),
            'max_network_risk':    float(round(nodes_gdf['network_criticality_risk'].max(),  4)),
        },
        'edges': {
            'mean_composite_risk': float(round(edges_gdf['composite_risk'].mean(), 4)),
            'max_composite_risk':  float(round(edges_gdf['composite_risk'].max(),  4)),
            'mean_network_risk':   float(round(edges_gdf['network_criticality_risk'].mean(), 4)),
            'max_network_risk':    float(round(edges_gdf['network_criticality_risk'].max(),  4)),
        },
    },
    'chokepoints': {
        'total_chokepoints':    int(nodes_gdf['is_chokepoint'].sum()),
        'critical_chokepoints': int(
            (nodes_gdf['is_chokepoint'] & (nodes_gdf['risk_tier'] == 'CRITICAL')).sum()
        ),
    },
    'top_risks': {
        'top_10_nodes': top_10_nodes,
        'top_10_edges': top_10_edges,
    },
}

# --- write JSON ---
kpi_path = os.path.join(OUTPUT_DIR, "risk_summary.json")
with open(kpi_path, 'w') as f:
    json.dump(kpi, f, indent=2, default=str)
ok(f"[FILE] risk_summary.json written")

# --- write DB log ---
if engine is not None:
    kpi_row = {
        'timestamp':          TIMESTAMP,
        'analysis_date':      ts_iso,
        'total_nodes':        kpi['network_overview']['total_nodes'],
        'total_edges':        kpi['network_overview']['total_edges'],
        'critical_nodes':     kpi['risk_distribution']['nodes']['critical'],
        'high_nodes':         kpi['risk_distribution']['nodes']['high'],
        'medium_nodes':       kpi['risk_distribution']['nodes']['medium'],
        'low_nodes':          kpi['risk_distribution']['nodes']['low'],
        'critical_edges':     kpi['risk_distribution']['edges']['critical'],
        'high_edges':         kpi['risk_distribution']['edges']['high'],
        'medium_edges':       kpi['risk_distribution']['edges']['medium'],
        'low_edges':          kpi['risk_distribution']['edges']['low'],
        'mean_node_risk':     kpi['risk_statistics']['nodes']['mean_composite_risk'],
        'max_node_risk':      kpi['risk_statistics']['nodes']['max_composite_risk'],
        'mean_edge_risk':     kpi['risk_statistics']['edges']['mean_composite_risk'],
        'max_edge_risk':      kpi['risk_statistics']['edges']['max_composite_risk'],
        'total_chokepoints':  kpi['chokepoints']['total_chokepoints'],
        'critical_chokepoints': kpi['chokepoints']['critical_chokepoints'],
    }
    write_table(pd.DataFrame([kpi_row]), TABLE_RISK_KPIS_LOG, engine, if_exists="append")


# ============================================================================
# STEP 13 — SCENARIO SIMULATOR
# ============================================================================
hdr("STEP 13 — SCENARIO SIMULATOR  (builds scenario_engine.pkl)")

class ScenarioEngine:
    """
    Scenario engine for 'what-if' disruption analysis.
    
    Scenario types:
        node_removal         — permanently remove node(s)
        edge_closure         — block specific edge(s)
        capacity_reduction   — slow traffic at a node (congestion)
        flood_scenario       — apply flood risk-based disruption
    
    Returns a dict with impact metrics (efficiency drop, corridor delays,
    unreachable corridors, etc.), plus a plain-text summary that the LLM
    can narrate to the user.
    """
    
    def __init__(self, graph: nx.Graph, nodes_df: pd.DataFrame, edges_df: pd.DataFrame):
        self.G_base   = graph.copy()
        self.nodes_df = nodes_df.copy()
        self.edges_df = edges_df.copy()
        
        if nx.is_connected(self.G_base):
            self.G_main = self.G_base
        else:
            comps = list(nx.connected_components(self.G_base))
            self.G_main = self.G_base.subgraph(max(comps, key=len)).copy()
        
        self.baseline_paths = self._compute_key_corridors()
        info(f"Scenario engine: {self.G_main.number_of_nodes()} nodes / "
             f"{self.G_main.number_of_edges()} edges in main component")
    
    def _compute_key_corridors(self) -> Dict[str, float]:
        import itertools
        facilities = self.nodes_df[
            self.nodes_df['node_type'].isin(['port', 'dryport', 'rail_station'])
        ]['node_id'].tolist()
        pairs = list(itertools.combinations(facilities, 2))[:50]
        
        paths = {}
        for s, t in pairs:
            if s in self.G_main and t in self.G_main:
                try:
                    paths[f"{s}→{t}"] = round(
                        nx.shortest_path_length(self.G_main, s, t, weight='travel_time_hr'),
                        2
                    )
                except nx.NetworkXNoPath:
                    paths[f"{s}→{t}"] = float('inf')
        return paths
    
    def _asset_to_node(self, asset_id: str) -> Optional[str]:
        m = self.nodes_df[self.nodes_df['asset_id'] == asset_id]
        return m.iloc[0]['node_id'] if len(m) else None
    
    def _efficiency(self, G: nx.Graph, sample: int = 100) -> float:
        import random
        if G.number_of_nodes() <= 1:
            return 0.0
        nodes = list(G.nodes())
        k = min(sample, len(nodes))
        picked = random.sample(nodes, k)
        tot, pairs = 0.0, 0
        for i, s in enumerate(picked):
            for t in picked[i+1:]:
                try:
                    d = nx.shortest_path_length(G, s, t, weight='travel_time_hr')
                    if d > 0:
                        tot += 1.0 / d
                    pairs += 1
                except nx.NetworkXNoPath:
                    pairs += 1
        return tot / pairs if pairs else 0.0
    
    def _measure(self, G_s: nx.Graph, removed, affected) -> Dict:
        if nx.is_connected(G_s):
            n_comp = 1
            main   = G_s
        else:
            comps  = list(nx.connected_components(G_s))
            n_comp = len(comps)
            main   = G_s.subgraph(max(comps, key=len)).copy()
        
        eff_b = self._efficiency(self.G_main)
        eff_s = self._efficiency(main)
        drop_pct = round(100 * (1 - eff_s / eff_b), 2) if eff_b > 0 else 0.0
        
        unreachable, delayed, total_delay = 0, 0, 0.0
        for corridor, base_t in self.baseline_paths.items():
            s, t = corridor.split('→')
            if s in main and t in main:
                try:
                    new_t = nx.shortest_path_length(main, s, t, weight='travel_time_hr')
                    if new_t > base_t:
                        delayed    += 1
                        total_delay += (new_t - base_t)
                except nx.NetworkXNoPath:
                    unreachable += 1
            else:
                unreachable += 1
        
        return {
            'network_components':     n_comp,
            'network_fragmentation':  n_comp > 1,
            'efficiency_baseline':    round(eff_b, 4),
            'efficiency_scenario':    round(eff_s, 4),
            'efficiency_drop_pct':    drop_pct,
            'corridors_unreachable':  int(unreachable),
            'corridors_delayed':      int(delayed),
            'total_delay_hours':      round(float(total_delay), 2),
            'avg_delay_hours':        round(float(total_delay) / delayed, 2) if delayed else 0.0,
            'nodes_removed_count':    len(removed),
            'edges_affected_count':   len(affected),
        }
    
    def run_scenario(self, scenario_type: str, targets: List[str],
                     severity: float = 1.0,
                     duration_hours: Optional[int] = None) -> Dict[str, Any]:
        G_s = self.G_main.copy()
        removed, affected = [], []
        
        if scenario_type == 'node_removal':
            for t in targets:
                nid = self._asset_to_node(t)
                if nid and nid in G_s:
                    G_s.remove_node(nid)
                    removed.append(nid)
        
        elif scenario_type == 'edge_closure':
            for t in targets:
                for u, v, d in list(G_s.edges(data=True)):
                    if d.get('asset_id') == t:
                        G_s[u][v]['travel_time_hr'] = 9999.0
                        affected.append(f"{u}→{v}")
                        break
        
        elif scenario_type == 'capacity_reduction':
            for t in targets:
                nid = self._asset_to_node(t)
                if nid and nid in G_s:
                    for nbr in list(G_s.neighbors(nid)):
                        old = G_s[nid][nbr].get('travel_time_hr', 1.0)
                        G_s[nid][nbr]['travel_time_hr'] = old * (1.0 + severity * 2.0)
                        affected.append(f"{nid}→{nbr}")
        
        elif scenario_type == 'flood_scenario':
            hi = self.nodes_df[self.nodes_df['risk_flood'] > 0.6]['node_id'].tolist()
            for nid in hi:
                if nid in G_s:
                    G_s.remove_node(nid)
                    removed.append(nid)
            for u, v, d in G_s.edges(data=True):
                aid = d.get('asset_id')
                row = self.edges_df[self.edges_df['asset_id'] == aid]
                if len(row) and row.iloc[0].get('risk_flood', 0) > 0.4:
                    fr  = row.iloc[0]['risk_flood']
                    old = d.get('travel_time_hr', 1.0)
                    G_s[u][v]['travel_time_hr'] = old * (1.0 + fr * severity)
                    affected.append(f"{u}→{v}")
        
        else:
            raise ValueError(f"Unknown scenario_type: {scenario_type}")
        
        metrics = self._measure(G_s, removed, affected)
        
        # Plain-text summary (LLM-consumable)
        summary_parts = [f"SCENARIO: {scenario_type.replace('_',' ').upper()} on {targets}."]
        if removed:
            summary_parts.append(f"{len(removed)} node(s) removed.")
        if metrics['corridors_unreachable']:
            summary_parts.append(
                f"CRITICAL: {metrics['corridors_unreachable']} corridor(s) became unreachable."
            )
        if metrics['corridors_delayed']:
            summary_parts.append(
                f"{metrics['corridors_delayed']} corridor(s) delayed; "
                f"total +{metrics['total_delay_hours']:.1f} hours; "
                f"avg +{metrics['avg_delay_hours']:.1f} hours."
            )
        summary_parts.append(f"Network efficiency dropped {metrics['efficiency_drop_pct']}%.")
        
        return {
            'scenario_type':    scenario_type,
            'targets':          targets,
            'severity':         severity,
            'duration_hours':   duration_hours,
            'nodes_removed':    removed,
            'edges_affected':   affected[:20],
            'impact_metrics':   metrics,
            'summary_for_llm':  " ".join(summary_parts),
            'timestamp':        TIMESTAMP,
        }


# Build and pickle the scenario engine
sub("13.1 Instantiate and serialize scenario engine")

scenario_engine = ScenarioEngine(
    graph    = G_baseline,
    nodes_df = nodes_gdf,
    edges_df = edges_gdf,
)

eng_pkl = os.path.join(OUTPUT_DIR, "scenario_engine.pkl")
with open(eng_pkl, 'wb') as f:
    pickle.dump(scenario_engine, f, protocol=pickle.HIGHEST_PROTOCOL)
ok(f"[FILE] scenario_engine.pkl saved")


# ============================================================================
# FINAL SUMMARY
# ============================================================================
hdr("RISK ENGINE COMPLETE ✓")

def row_count(df, tier):
    return int((df['risk_tier'] == tier).sum())

print(f"""
╔══════════════════════════════════════════════════════════════════════════╗
║                       RISK ENGINE — RUN SUMMARY                          ║
╚══════════════════════════════════════════════════════════════════════════╝

  Timestamp:         {TIMESTAMP}
  DB connection:     {'YES' if engine is not None else 'NO (file-only mode)'}

  NETWORK
    Nodes:      {len(nodes_gdf):5d}      Edges:    {len(edges_gdf):5d}
    Ports:      {(nodes_gdf['node_type']=='port').sum():5d}      Dryports: {(nodes_gdf['node_type']=='dryport').sum():5d}
    Stations:   {(nodes_gdf['node_type']=='rail_station').sum():5d}

  RISK TIER DISTRIBUTION
                     Nodes        Edges
    CRITICAL:      {row_count(nodes_gdf,'CRITICAL'):5d}        {row_count(edges_gdf,'CRITICAL'):5d}
    HIGH:          {row_count(nodes_gdf,'HIGH'):5d}        {row_count(edges_gdf,'HIGH'):5d}
    MEDIUM:        {row_count(nodes_gdf,'MEDIUM'):5d}        {row_count(edges_gdf,'MEDIUM'):5d}
    LOW:           {row_count(nodes_gdf,'LOW'):5d}        {row_count(edges_gdf,'LOW'):5d}

  RISK STATISTICS
    Node composite — mean: {nodes_gdf['composite_risk'].mean():.3f}   max: {nodes_gdf['composite_risk'].max():.3f}
    Edge composite — mean: {edges_gdf['composite_risk'].mean():.3f}   max: {edges_gdf['composite_risk'].max():.3f}
    Chokepoints:     {nodes_gdf['is_chokepoint'].sum()}

  OUTPUTS WRITTEN
    Files (outputs/):
      ├─ risk_nodes_latest.gpkg   risk_edges_latest.gpkg
      ├─ risk_nodes_latest.csv    risk_edges_latest.csv
      ├─ risk_summary.json
      └─ scenario_engine.pkl

    PostGIS tables (if DB available):
      ├─ risk_nodes_latest          (replaced)
      ├─ risk_edges_latest          (replaced)
      ├─ risk_nodes_log             (appended)
      ├─ risk_edges_log             (appended)
      └─ risk_kpis_log              (appended)
""")

top5 = nodes_gdf.nlargest(5, 'network_criticality_risk')
if len(top5) and top5['network_criticality_risk'].max() > 0:
    print("  TOP 5 HIGHEST-RISK NODES (by network criticality):\n")
    for _, r in top5.iterrows():
        nm = str(r.get('name') or '—')[:30]
        print(f"    • {nm:30s}  {str(r['node_type']):14s}  "
              f"risk={r['network_criticality_risk']:.3f}  tier={r['risk_tier']}")

print("\n" + "=" * 78 + "\n")
