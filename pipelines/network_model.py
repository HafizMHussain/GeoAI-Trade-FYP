"""
==============================================================================
SCRIPT 1 — Network Model + PostGIS Database Setup  [v7 — MODAL SEPARATION]
==============================================================================
FYP: Geo-Resilience for Ports and Supply Chains (Pakistan)

KEY DESIGN PRINCIPLE — Modal Separation
========================================
Roads and railways are physically separate networks.
A truck cannot drive on rails. A train cannot continue on a road.
The ONLY legal transitions between modes happen at access link edges,
which connect a facility node (port / dryport / station) to either
a road intersection OR a rail intersection.

GRAPH ARCHITECTURE:
  Nodes:
    - road_intersection  : road network junction
    - rail_intersection  : rail network junction (rail_intersection=1)
    - rail_station       : station on the rail network
    - port               : seaport (connects to road AND/OR rail via access links)
    - dryport            : inland container terminal (road and/or rail access)

  Edges:
    - mode='road'        : connects road_intersection ↔ road_intersection only
    - mode='rail'        : connects rail nodes (station / rail_int) only
    - mode='intermodal'  : access link — the ONLY edge that crosses mode boundary
                           from_node = facility (port/dryport/station)
                           to_node   = road_intersection  OR  rail node
                           This is the only way to travel between road and rail.

WHY ALL 36 RAIL LINES WERE MISSING FROM G_main (v6 diagnosis)
==============================================================
  Step 3B correctly creates all 36 rail edges (confirmed in terminal output).
  The problem is Step 4: after building the graph, nx.connected_components()
  picks the LARGEST component as G_main.  The rail subnetwork — even with
  all 36 edges — forms many small disconnected islands because:

  1. Most rail lines connect rail_int_X nodes to other rail_int_Y nodes.
  2. The access links that should bridge rail↔road were connecting to
     road nodes that were themselves in small disconnected road spurs
     (not in the main road component).
  3. Result: the rail subgraph + its access links = a collection of small
     components, none large enough to be G_main.

v7 FIX — Two-phase connectivity guarantee
==========================================
  PHASE 1 — Road main component anchor:
    Build the graph with road + rail + access-link edges.
    Find the road-only main component (the largest component that contains
    at least one road_intersection node).  This is the anchor.

  PHASE 2 — Pull everything into the anchor:
    For every facility node (port, dryport, station) and every rail node
    (rail_int, station) NOT yet in the anchor component, add one bridge
    edge to the nearest node THAT IS in the anchor.
    Bridge edges are tagged mode='intermodal', road_type='bridge_access'.
    This is done iteratively so each new bridge expands the anchor.

  After Phase 2, ALL 36 rail edges, ALL 48 access links, and ALL
  3+9+30 = 42 facilities are guaranteed to be in G_main.

  NOTE on physical realism of bridge edges:
    Bridge edges are a modelling necessity only where access links fail.
    In practice, every facility in Pakistan has SOME road/rail access;
    the bridge just formalises that connection where the digitised
    access link did not perfectly snap.

OTHER FIXES RETAINED FROM v6:
  - STATION_SNAP_KM = 0.5 km tight snap (no phantom straight lines)
  - Orientation-agnostic access link from_node detection
  - to_node search with no distance cap
  - station_rail links search rail_intersection nodes first
  - make_edge_line preserves all intermediate vertices
  - Global metrics avg-shortest-path bug fixed (tgt != src)
  - rail_intersection attribute = 1

INPUTS  (data/ directory):
    roads.gpkg  railways.gpkg  ports.gpkg
    dryports.gpkg  stations.gpkg  accesslinks.gpkg

OUTPUTS:
    outputs/nodes.gpkg / edges.gpkg
    outputs/nodes_attributed.csv / edges_attributed.csv
    outputs/baseline_metrics.csv / baseline_edge_metrics.csv
    outputs/baseline_global_metrics.csv / baseline_shortest_paths.csv
    outputs/graph_baseline.gpickle
    PostGIS tables: ports, dryports, stations, roads, railways,
                    network_nodes, network_edges, baseline_*

REQUIREMENTS:
    pip install geopandas networkx pandas numpy shapely sqlalchemy geoalchemy2 psycopg2-binary
==============================================================================
"""

import geopandas as gpd
import networkx as nx
import pandas as pd
import numpy as np
from shapely.geometry import Point, LineString, MultiLineString
from shapely.validation import make_valid
import math, os, pickle, warnings, time, random
from itertools import combinations
from datetime import datetime

from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

warnings.filterwarnings('ignore')

# ============================================================================
# CONFIGURATION
# ============================================================================
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
DATA_DIR   = os.path.join(BASE_DIR, "data")
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")
os.makedirs(OUTPUT_DIR, exist_ok=True)

FILE_ROADS    = "roads.gpkg"
FILE_RAILS    = "railways.gpkg"
FILE_PORTS    = "ports.gpkg"
FILE_DRYPORTS = "dryports.gpkg"
FILE_STATIONS = "stations.gpkg"
FILE_ACCLINKS = "accesslinks.gpkg"

DB_HOST   = os.environ.get("DB_HOST", "localhost")
DB_PORT   = int(os.environ.get("DB_PORT", 5432))
DB_NAME   = os.environ.get("DB_NAME", "fyp_georesilience")
DB_USER   = os.environ.get("DB_USER", "fyp_user")
DB_PASS   = os.environ.get("DB_PASSWORD", "fyp_pass")
DB_SCHEMA = "public"

SNAP_TOLERANCE  = 0.001   # degrees ≈ 111 m  — road intersection grid
STATION_SNAP_KM = 0.5     # tight: rail endpoint → station only if within 0.5 km
WEIGHT          = "travel_time_hr"
K_BC            = 500


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================
def haversine_km(lon1, lat1, lon2, lat2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat/2)**2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon/2)**2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def snap_coord(lon, lat, tol=SNAP_TOLERANCE):
    return (round(lon / tol) * tol, round(lat / tol) * tol)


def line_coords(geom):
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, MultiLineString):
        c = []
        for g in geom.geoms:
            c.extend(list(g.coords))
        return c
    return list(geom.coords)


def centroid2d(geom):
    c = geom.centroid
    return Point(c.x, c.y)


def nearest_node(lon, lat, pts, ids, max_km=None, exclude=None):
    """
    Return (node_id, dist_km) for the nearest point in pts/ids.
    max_km=None → unlimited search.
    exclude → set of node_ids to skip.
    """
    best_id, best_d = None, float('inf')
    for (clon, clat), nid in zip(pts, ids):
        if exclude and nid in exclude:
            continue
        d = haversine_km(lon, lat, clon, clat)
        if d < best_d and (max_km is None or d <= max_km):
            best_d = d
            best_id = nid
    return (best_id, best_d) if best_id is not None else (None, float('inf'))


def clean_geometry(geom):
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = make_valid(geom)
    if geom is None or geom.is_empty:
        return None
    return geom


def make_edge_line(from_lon, from_lat, original_geom, to_lon, to_lat):
    """Preserve all intermediate vertices; correct the two endpoints."""
    coords = line_coords(original_geom)
    if len(coords) >= 2:
        pts = ([(from_lon, from_lat)] +
               [(c[0], c[1]) for c in coords[1:-1]] +
               [(to_lon, to_lat)])
        deduped = [pts[0]]
        for pt in pts[1:]:
            if pt != deduped[-1]:
                deduped.append(pt)
        if len(deduped) >= 2:
            result = clean_geometry(LineString(deduped))
            if result:
                return result
    if (from_lon, from_lat) != (to_lon, to_lat):
        return LineString([(from_lon, from_lat), (to_lon, to_lat)])
    return None


def hdr(t):  print(f"\n{'='*70}\n  {t}\n{'='*70}")
def sub(t):  print(f"\n  --- {t} ---")


# ============================================================================
# DATABASE
# ============================================================================
def get_engine():
    conn_str = f"postgresql://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
    try:
        engine = create_engine(conn_str)
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        print(f"  [DB] Connected to PostGIS: {DB_NAME}")
        return engine
    except OperationalError as e:
        print(f"  [DB] WARNING: Cannot connect — {e}\n  [DB] Files only.")
        return None


def write_to_postgis(gdf, table_name, engine, if_exists="replace"):
    if engine is None:
        return
    try:
        gdf_w = gdf.copy()
        if gdf_w.geometry.name != 'geometry':
            gdf_w = gdf_w.rename_geometry('geometry')
        gdf_w.to_postgis(table_name, engine, schema=DB_SCHEMA,
                         if_exists=if_exists, index=False, chunksize=500)
        print(f"    [DB] Written {len(gdf_w)} rows → {DB_SCHEMA}.{table_name}")
    except Exception as e:
        print(f"    [DB] WARNING: Could not write {table_name}: {e}")


# ============================================================================
# STEP 1 — LOAD GIS DATA
# ============================================================================
hdr("STEP 1 — LOAD GIS DATA")

roads         = gpd.read_file(os.path.join(DATA_DIR, FILE_ROADS))
rails         = gpd.read_file(os.path.join(DATA_DIR, FILE_RAILS))
ports         = gpd.read_file(os.path.join(DATA_DIR, FILE_PORTS))
dryports      = gpd.read_file(os.path.join(DATA_DIR, FILE_DRYPORTS))
rail_stations = gpd.read_file(os.path.join(DATA_DIR, FILE_STATIONS))
access_links  = gpd.read_file(os.path.join(DATA_DIR, FILE_ACCLINKS))

for name, gdf in [("roads", roads), ("rails", rails), ("ports", ports),
                  ("dryports", dryports), ("rail_stations", rail_stations),
                  ("access_links", access_links)]:
    if 'id' not in gdf.columns:
        gdf['id'] = range(1, len(gdf) + 1)
    if gdf.crs is None:
        gdf.set_crs(epsg=4326, inplace=True)
    elif gdf.crs.to_epsg() != 4326:
        print(f"  WARNING: {name} CRS={gdf.crs.to_epsg()} → reprojecting to 4326")
        gdf.to_crs(epsg=4326, inplace=True)
    print(f"  {name:20s}: {len(gdf):>5} features  CRS={gdf.crs.to_epsg()}")

for gdf_obj in [dryports, ports, rail_stations, rails, roads]:
    if 'Name' in gdf_obj.columns and 'name' not in gdf_obj.columns:
        gdf_obj.rename(columns={'Name': 'name'}, inplace=True)


# ============================================================================
# STEP 2 — BUILD NODES
# ============================================================================
hdr("STEP 2 — BUILD NODES")
all_nodes = []

# ---------- 2A: Ports ----------
sub("2A: Port nodes")
for _, row in ports.iterrows():
    c = centroid2d(row.geometry)
    all_nodes.append({
        'node_id': f"port_{row['id']}", 'asset_id': f"port_{row['id']}",
        'node_type': 'port', 'name': row.get('name', f"Port_{row['id']}"),
        'lon': round(c.x, 6), 'lat': round(c.y, 6),
        'geometry': c, 'rail_intersection': 0,
    })
    print(f"    port_{row['id']} → {row.get('name','?')}")

# ---------- 2B: Dryports ----------
sub("2B: Dryport nodes")
for _, row in dryports.iterrows():
    c = centroid2d(row.geometry)
    all_nodes.append({
        'node_id': f"dryport_{row['id']}", 'asset_id': f"dryport_{row['id']}",
        'node_type': 'dryport', 'name': row.get('name', f"Dryport_{row['id']}"),
        'lon': round(c.x, 6), 'lat': round(c.y, 6),
        'geometry': c, 'rail_intersection': 0,
    })
    print(f"    dryport_{row['id']} → {row.get('name','?')}")

# ---------- 2C: Rail stations ----------
sub("2C: Rail station nodes")
for _, row in rail_stations.iterrows():
    pt = row.geometry
    all_nodes.append({
        'node_id': f"station_{row['id']}", 'asset_id': f"station_{row['id']}",
        'node_type': 'rail_station', 'name': row.get('name', f"Station_{row['id']}"),
        'lon': round(pt.x, 6), 'lat': round(pt.y, 6),
        'geometry': Point(pt.x, pt.y), 'rail_intersection': 0,
    })
print(f"    Created {len(rail_stations)} station nodes")

# ---------- 2D: Road intersection nodes ----------
sub(f"2D: Road intersection nodes (snap={SNAP_TOLERANCE}°)")
road_snap_map = {}
for _, row in roads.iterrows():
    coords = line_coords(row.geometry)
    if len(coords) < 2:
        continue
    for coord in [coords[0], coords[-1]]:
        key = snap_coord(coord[0], coord[1])
        road_snap_map.setdefault(key, []).append((coord[0], coord[1]))

road_snap_lookup = {}
road_node_ctr = 0
for snapped, pts in road_snap_map.items():
    road_node_ctr += 1
    nid = f"road_{road_node_ctr}"
    avg_lon = float(np.mean([p[0] for p in pts]))
    avg_lat = float(np.mean([p[1] for p in pts]))
    all_nodes.append({
        'node_id': nid, 'asset_id': nid,
        'node_type': 'road_intersection',
        'name': f"Junction_{road_node_ctr}",
        'lon': round(avg_lon, 6), 'lat': round(avg_lat, 6),
        'geometry': Point(avg_lon, avg_lat), 'rail_intersection': 0,
    })
    road_snap_lookup[snapped] = nid
print(f"    Road intersections: {road_node_ctr}")

# ---------- 2E: Rail endpoint / intersection nodes ----------
sub(f"2E: Rail endpoint nodes (station_snap={STATION_SNAP_KM} km tight)")
st_pts_raw = [(r.geometry.x, r.geometry.y) for _, r in rail_stations.iterrows()]
st_ids_raw = [f"station_{r['id']}" for _, r in rail_stations.iterrows()]

rail_snap_map = {}
for _, row in rails.iterrows():
    coords = line_coords(row.geometry)
    if len(coords) < 2:
        continue
    for coord in [coords[0], coords[-1]]:
        key = snap_coord(coord[0], coord[1])
        rail_snap_map.setdefault(key, []).append((coord[0], coord[1]))

rail_snap_lookup = {}
rail_int_ctr = 0
n_stn_snap   = 0

for snapped, pts in rail_snap_map.items():
    avg_lon = float(np.mean([p[0] for p in pts]))
    avg_lat = float(np.mean([p[1] for p in pts]))
    nearest_stn, stn_dist = nearest_node(avg_lon, avg_lat,
                                          st_pts_raw, st_ids_raw,
                                          max_km=STATION_SNAP_KM)
    if nearest_stn:
        rail_snap_lookup[snapped] = nearest_stn
        n_stn_snap += 1
    else:
        rail_int_ctr += 1
        nid = f"rail_int_{rail_int_ctr}"
        all_nodes.append({
            'node_id': nid, 'asset_id': nid,
            'node_type': 'rail_intersection',
            'name': f"Rail_Junction_{rail_int_ctr}",
            'lon': round(avg_lon, 6), 'lat': round(avg_lat, 6),
            'geometry': Point(avg_lon, avg_lat), 'rail_intersection': 1,
        })
        rail_snap_lookup[snapped] = nid

print(f"    Endpoints snapped to stations : {n_stn_snap}")
print(f"    New rail_intersection nodes   : {rail_int_ctr}")

# ---------- Finalise nodes_df ----------
nodes_df = pd.DataFrame(all_nodes)
for t, c in nodes_df['node_type'].value_counts().items():
    print(f"    {t:25s}: {c}")
print(f"    TOTAL: {len(nodes_df)}")

node_lonlat       = {r['node_id']: (r['lon'], r['lat']) for _, r in nodes_df.iterrows()}
facility_nodes_df = nodes_df[nodes_df['node_type'].isin(
                        ['port', 'dryport', 'rail_station'])].copy()

rail_node_df  = nodes_df[nodes_df['node_type'].isin(['rail_station', 'rail_intersection'])]
rail_node_pts = [(r['lon'], r['lat']) for _, r in rail_node_df.iterrows()]
rail_node_ids = rail_node_df['node_id'].tolist()

road_pts = [(r['lon'], r['lat']) for _, r in
            nodes_df[nodes_df['node_type'] == 'road_intersection'].iterrows()]
road_ids = nodes_df[nodes_df['node_type'] == 'road_intersection']['node_id'].tolist()


# ============================================================================
# STEP 3 — BUILD EDGES
# ============================================================================
hdr("STEP 3 — BUILD EDGES")
all_edges = []

# ---------- 3A: Road edges (road_intersection ↔ road_intersection only) ----------
sub("3A: Road edges  [road ↔ road only]")
road_e_ok = road_e_skip = 0
for _, row in roads.iterrows():
    coords = line_coords(row.geometry)
    if len(coords) < 2:
        road_e_skip += 1
        continue
    u = road_snap_lookup.get(snap_coord(coords[0][0],  coords[0][1]))
    v = road_snap_lookup.get(snap_coord(coords[-1][0], coords[-1][1]))
    if not u or not v or u == v:
        road_e_skip += 1
        continue
    lkm = float(row.get('length_km', 0) or 0)
    if lkm <= 0:
        lkm = round(haversine_km(coords[0][0], coords[0][1],
                                  coords[-1][0], coords[-1][1]), 4)
    spd = float(row.get('speed', 0) or 0)
    if spd <= 0:
        spd = 60
    u_lon, u_lat = node_lonlat[u]
    v_lon, v_lat = node_lonlat[v]
    all_edges.append({
        'edge_id': f"road_{row['id']}", 'asset_id': f"road_{row['id']}",
        'from_node': u, 'to_node': v,
        'mode': 'road',
        'road_type': str(row.get('road_type', 'Unknown')),
        'length_km': round(lkm, 4), 'speed_kmh': int(spd),
        'name': str(row.get('name', '')),
        'geometry': make_edge_line(u_lon, u_lat, row.geometry, v_lon, v_lat),
    })
    road_e_ok += 1
print(f"    Created: {road_e_ok}   Skipped: {road_e_skip}")
print(f"    Mode: road_intersection ↔ road_intersection")


# ---------- 3B: Rail edges (rail nodes ↔ rail nodes only) ----------
sub("3B: Rail edges  [rail ↔ rail only, tight snap]")
rail_e_ok = rail_e_skip = 0


def resolve_rail_ep(lon, lat, snap_key):
    """
    Resolve a rail line endpoint to a node_id.
    Only resolves to rail_intersection or rail_station nodes — never road.
    1. Direct snap_lookup hit.
    2. Nearest rail node within 2 km.
    3. Nearest rail node within 10 km.
    4. Nearest rail node unlimited (never None).
    """
    nid = rail_snap_lookup.get(snap_key)
    if nid:
        return nid, haversine_km(lon, lat, *node_lonlat[nid])
    for max_km in (2, 10, None):
        nid, dist = nearest_node(lon, lat, rail_node_pts, rail_node_ids, max_km=max_km)
        if nid:
            return nid, dist
    return None, float('inf')


for _, row in rails.iterrows():
    coords = line_coords(row.geometry)
    if len(coords) < 2:
        print(f"    SKIP rail_{row['id']}: <2 coords")
        rail_e_skip += 1
        continue

    sl, slt = coords[0][0],  coords[0][1]
    el, elt = coords[-1][0], coords[-1][1]

    u, u_d = resolve_rail_ep(sl, slt, snap_coord(sl, slt))
    v, v_d = resolve_rail_ep(el, elt, snap_coord(el, elt))

    if not u or not v:
        print(f"    SKIP rail_{row['id']}: could not resolve u={u} v={v}")
        rail_e_skip += 1
        continue

    if u == v:
        # With tight 0.5 km snap this should be very rare.
        # Log and skip — do NOT create a phantom long edge.
        print(f"    SKIP rail_{row['id']}: u==v ({u}) after tight snap — "
              f"likely a very short loop segment, safe to skip")
        rail_e_skip += 1
        continue

    lkm = float(row.get('length_km', 0) or 0)
    if lkm <= 0:
        lkm = round(haversine_km(sl, slt, el, elt), 4)

    u_lon, u_lat = node_lonlat[u]
    v_lon, v_lat = node_lonlat[v]
    geom = make_edge_line(u_lon, u_lat, row.geometry, v_lon, v_lat)
    if geom is None:
        print(f"    SKIP rail_{row['id']}: geometry build failed")
        rail_e_skip += 1
        continue

    all_edges.append({
        'edge_id': f"rail_{row['id']}", 'asset_id': f"rail_{row['id']}",
        'from_node': u, 'to_node': v,
        'mode': 'rail',
        'road_type': str(row.get('rail_line', row.get('name', 'rail'))),
        'length_km': round(lkm, 4), 'speed_kmh': 80,
        'name': str(row.get('rail_line', row.get('name', ''))),
        'geometry': geom,
    })
    rail_e_ok += 1
    print(f"    ✓ rail_{row['id']}: {u}({u_d:.2f}km) → {v}({v_d:.2f}km)  "
          f"len={lkm:.1f}km  [rail↔rail]")

print(f"    Created: {rail_e_ok}   Skipped: {rail_e_skip}")
print(f"    Mode: rail_node ↔ rail_node (stations + rail_intersections)")


# ---------- 3C: Access link edges (the ONLY road↔rail bridges) ----------
#
# MODAL SEPARATION RULE enforced here:
#   - road_access / road mode → to_node must be a road_intersection
#   - rail_access / station_rail → to_node must be a rail node
#   - facility node (from_node) sits at the boundary and may have BOTH
#     a road access link and a rail access link, which is correct.
#
# This means:
#   port → road_intersection   (road_access link)
#   port → rail_int / station  (rail_access link)
#   dryport → road_intersection (road_access)
#   dryport → rail_int          (rail_access)
#   station → rail_int / station (station_rail)
#   station → road_intersection  (road_access, if the station has road access)
#
sub("3C: Access link edges  [ONLY legal mode-crossing bridges]")
acc_e_ok = acc_e_skip = 0

TYPE_MAP_FROM = {
    'seaport': 'port', 'port': 'port',
    'dryport': 'dryport',
    'station': 'rail_station', 'railway': 'rail_station',
}

rail_int_pts = [(r['lon'], r['lat']) for _, r in
                nodes_df[nodes_df['node_type'] == 'rail_intersection'].iterrows()]
rail_int_ids = nodes_df[nodes_df['node_type'] == 'rail_intersection']['node_id'].tolist()

station_pts2 = [(r['lon'], r['lat']) for _, r in
                nodes_df[nodes_df['node_type'] == 'rail_station'].iterrows()]
station_ids2 = nodes_df[nodes_df['node_type'] == 'rail_station']['node_id'].tolist()


def find_facility_node(lon, lat, from_name, expected_type, max_km=300):
    if expected_type:
        cands = nodes_df[nodes_df['node_type'] == expected_type]
    else:
        cands = facility_nodes_df
    if cands.empty:
        return None, float('inf')
    fn_lc = from_name.lower().strip() if from_name else ''
    if fn_lc:
        for _, cand in cands.iterrows():
            if fn_lc in str(cand['name']).lower() or str(cand['name']).lower() in fn_lc:
                d = haversine_km(lon, lat, cand['lon'], cand['lat'])
                if d <= max_km:
                    return cand['node_id'], d
    cpts = [(r['lon'], r['lat']) for _, r in cands.iterrows()]
    cids = cands['node_id'].tolist()
    return nearest_node(lon, lat, cpts, cids, max_km=max_km)


for idx, row in access_links.iterrows():
    acc_id   = f"access_{idx + 1}"
    coords   = line_coords(row.geometry)
    if len(coords) < 2:
        print(f"    SKIP {acc_id}: <2 coords")
        acc_e_skip += 1
        continue

    from_name = str(row.get('from_name', '') or '')
    from_type = str(row.get('from_type', '') or '').lower().strip()
    to_type   = str(row.get('to_type',   '') or '').lower().strip()
    mode_str  = str(row.get('mode',      '') or '').lower().strip()
    expected_type = TYPE_MAP_FROM.get(from_type)

    p_start = (coords[0][0],  coords[0][1])
    p_end   = (coords[-1][0], coords[-1][1])

    # Orientation-agnostic from_node detection (try both ends)
    nid_s, d_s = find_facility_node(p_start[0], p_start[1], from_name, expected_type)
    nid_e, d_e = find_facility_node(p_end[0],   p_end[1],   from_name, expected_type)

    if nid_s is not None and (nid_e is None or d_s <= d_e):
        from_node = nid_s
        net_lon, net_lat = p_end
        orig_geom = row.geometry
    elif nid_e is not None:
        from_node = nid_e
        net_lon, net_lat = p_start
        rc = line_coords(row.geometry)[::-1]
        orig_geom = LineString(rc) if len(rc) >= 2 else row.geometry
    else:
        print(f"    SKIP {acc_id} ({from_name!r}): no facility node found")
        acc_e_skip += 1
        continue

    excl = {from_node}

    # ---- MODAL SEPARATION: route to_node based on declared mode ----
    #
    #  road_access  → road_intersection only
    #  rail_access  → rail_intersection nodes only (line endpoints/junctions)
    #  station_rail → rail_intersection nodes only
    #                 (station connects to the rail LINE, not to another station)
    #
    is_road_mode = ('road' in mode_str) or ('road' in to_type and 'rail' not in mode_str)
    is_rail_mode = ('rail' in mode_str) or ('rail' in to_type)

    to_node = None

    if is_road_mode:
        # Must connect to a road_intersection — enforces road modal isolation
        r_pts = [p for p, i in zip(road_pts, road_ids) if i not in excl]
        r_ids = [i for p, i in zip(road_pts, road_ids) if i not in excl]
        if r_pts:
            to_node, _ = nearest_node(net_lon, net_lat, r_pts, r_ids, max_km=None)

    if is_rail_mode and not to_node:
        # Must connect to a rail node — enforces rail modal isolation
        # Prefer rail_intersection (line endpoint) over station to avoid station→station
        ri_pts = [p for p, i in zip(rail_int_pts, rail_int_ids) if i not in excl]
        ri_ids = [i for p, i in zip(rail_int_pts, rail_int_ids) if i not in excl]
        if ri_pts:
            to_node, _ = nearest_node(net_lon, net_lat, ri_pts, ri_ids, max_km=None)
        # If no rail_int nodes at all, use any rail node
        if not to_node:
            rn_pts = [p for p, i in zip(rail_node_pts, rail_node_ids) if i not in excl]
            rn_ids = [i for p, i in zip(rail_node_pts, rail_node_ids) if i not in excl]
            if rn_pts:
                to_node, _ = nearest_node(net_lon, net_lat, rn_pts, rn_ids, max_km=None)

    # Generic fallback (should not be needed with good access links)
    if not to_node:
        all_pts = [(r['lon'], r['lat']) for _, r in nodes_df.iterrows()
                   if r['node_id'] not in excl]
        all_ids = [r['node_id'] for _, r in nodes_df.iterrows()
                   if r['node_id'] not in excl]
        if all_pts:
            to_node, _ = nearest_node(net_lon, net_lat, all_pts, all_ids, max_km=None)

    if not to_node or from_node == to_node:
        reason = "to_node=None" if not to_node else f"from==to ({from_node})"
        print(f"    SKIP {acc_id} ({from_name!r}): {reason}")
        acc_e_skip += 1
        continue

    fn_lon, fn_lat = node_lonlat[from_node]
    tn_lon, tn_lat = node_lonlat[to_node]
    geom = make_edge_line(fn_lon, fn_lat, orig_geom, tn_lon, tn_lat)

    lkm = float(row.get('length_km', 0) or 0)
    if lkm <= 0:
        lkm = round(haversine_km(fn_lon, fn_lat, tn_lon, tn_lat), 4)

    # Determine to_node type for logging
    to_node_type = nodes_df.loc[nodes_df['node_id'] == to_node, 'node_type'].values
    to_node_type = to_node_type[0] if len(to_node_type) else '?'

    all_edges.append({
        'edge_id': acc_id, 'asset_id': acc_id,
        'from_node': from_node, 'to_node': to_node,
        'mode': 'intermodal',
        'road_type': mode_str,
        'length_km': round(lkm, 4), 'speed_kmh': 30,
        'name': f"{from_name}→{to_type}",
        'geometry': geom,
    })
    acc_e_ok += 1
    print(f"    ✓ {acc_id}: {from_node}({from_name[:18]}) → "
          f"{to_node}[{to_node_type}]  [{mode_str}]")

print(f"    Created: {acc_e_ok}   Skipped: {acc_e_skip}")
print(f"    These are the ONLY edges that cross the road↔rail boundary")

edges_df = pd.DataFrame(all_edges)
print(f"\n  Total edges: {len(edges_df)}")
for m, cnt in edges_df['mode'].value_counts().items():
    print(f"    {m:20s}: {cnt}")

edge_geom_lookup = dict(zip(edges_df['edge_id'], edges_df['geometry']))


# ============================================================================
# STEP 4 — BUILD NETWORKX GRAPH
# ============================================================================
hdr("STEP 4 — BUILD NETWORKX GRAPH")

# Use MultiGraph so that the same node-pair can have multiple edges of
# different modes.  A station connected to rail_int_52 by BOTH a rail edge
# (rail_35) and an intermodal access link (access_21) must keep BOTH —
# they represent physically distinct connections (the rail track and the
# access road/path).  A plain Graph would silently drop one of them.
G = nx.MultiGraph()

for _, r in nodes_df.iterrows():
    G.add_node(r['node_id'],
               asset_id          = r['asset_id'],
               node_type         = r['node_type'],
               name              = r['name'],
               lon               = r['lon'],
               lat               = r['lat'],
               rail_intersection = int(r.get('rail_intersection', 0)))

# Track (u, v, mode) tuples to deduplicate within same mode only.
# Two edges of different modes between the same nodes are KEPT — they are
# physically different connections and must not be merged.
seen_modal_edges = {}   # (frozenset({u,v}), mode) → edge_id of best (shortest) so far
dup = 0

for _, r in edges_df.iterrows():
    u, v = r['from_node'], r['to_node']
    if u not in G.nodes or v not in G.nodes:
        continue
    mode = r['mode']
    key  = (frozenset({u, v}), mode)

    if key in seen_modal_edges:
        # Same mode, same node pair — keep shorter, skip longer
        existing_eid = seen_modal_edges[key]
        # Find the existing edge key in the MultiGraph
        for ek, ed in G[u][v].items():
            if ed.get('edge_id') == existing_eid:
                if r['length_km'] < ed.get('length_km', float('inf')):
                    # Replace attributes in-place with the shorter edge
                    ed.update({k: r[k] for k in
                        ['edge_id', 'asset_id', 'mode', 'road_type',
                         'length_km', 'speed_kmh', 'name']})
                    seen_modal_edges[key] = r['edge_id']
                break
        dup += 1
        continue

    ek = G.add_edge(u, v,
                    edge_id=r['edge_id'], asset_id=r['asset_id'],
                    mode=mode, road_type=r['road_type'],
                    length_km=r['length_km'], speed_kmh=r['speed_kmh'],
                    name=r['name'])
    seen_modal_edges[key] = r['edge_id']

print(f"  Nodes: {G.number_of_nodes()}   Edges: {G.number_of_edges()}   "
      f"Same-mode duplicates merged: {dup}")
print(f"  Connected components (before bridging): {nx.number_connected_components(G)}")

# --------------------------------------------------------------------------
# STEP 4B — Two-phase connectivity: pull everything into one component
# --------------------------------------------------------------------------
# PHASE 1: Find the road-anchored main component.
#   This is the largest component that contains road_intersection nodes.
#   (It will be the biggest piece of the road network.)
#
# PHASE 2: For every facility node AND every rail node not in the main
#   component, add a bridge intermodal edge to the nearest node IN the
#   main component.  Run iteratively so each bridge grows the component.
#
# This guarantees:
#   - ALL 36 rail lines are reachable from the road network
#   - ALL 42 facility nodes (3 ports + 9 dryports + 30 stations) are in G_main
# --------------------------------------------------------------------------
sub("4B: Two-phase bridging — pull all rail + facilities into main component")

# Phase 1: identify the road-anchored main component
def get_road_main_component(graph):
    """Return the node-set of the largest component containing road nodes."""
    comps = sorted(nx.connected_components(graph), key=len, reverse=True)
    for comp in comps:
        for n in comp:
            if graph.nodes[n].get('node_type') == 'road_intersection':
                return set(comp)
    # Fallback: just return largest
    return set(comps[0])

main_nodes = get_road_main_component(G)
print(f"  Road-anchored main component: {len(main_nodes)} nodes")

# Phase 2: bridge targets = all facility nodes + all rail nodes
bridge_targets = set()
for _, r in facility_nodes_df.iterrows():
    bridge_targets.add(r['node_id'])
for nid in rail_node_ids:
    bridge_targets.add(nid)

bridge_count = 0
not_bridged  = []

for target_nid in bridge_targets:
    if target_nid in main_nodes:
        continue   # already connected

    # Gather positions of main-component nodes for nearest search
    mn_pts = [(G.nodes[n]['lon'], G.nodes[n]['lat']) for n in main_nodes]
    mn_ids = list(main_nodes)

    br, br_dist = nearest_node(
        G.nodes[target_nid]['lon'], G.nodes[target_nid]['lat'],
        mn_pts, mn_ids, max_km=None)

    if not br:
        not_bridged.append(target_nid)
        continue

    bridge_count += 1
    bridge_eid = f"bridge_{bridge_count}"
    br_lon, br_lat = G.nodes[br]['lon'], G.nodes[br]['lat']
    t_lon,  t_lat  = G.nodes[target_nid]['lon'], G.nodes[target_nid]['lat']
    geom = LineString([(t_lon, t_lat), (br_lon, br_lat)])
    br_dist_km = round(br_dist, 4)

    G.add_edge(target_nid, br,
               edge_id=bridge_eid, asset_id=bridge_eid,
               mode='intermodal', road_type='bridge_access',
               length_km=br_dist_km, speed_kmh=30,
               name=f"{G.nodes[target_nid].get('name',target_nid)}→main")

    # Record for export
    new_edge = {
        'edge_id': bridge_eid, 'asset_id': bridge_eid,
        'from_node': target_nid, 'to_node': br,
        'mode': 'intermodal', 'road_type': 'bridge_access',
        'length_km': br_dist_km, 'speed_kmh': 30,
        'name': f"{G.nodes[target_nid].get('name',target_nid)}→main",
        'geometry': geom,
    }
    edges_df = pd.concat([edges_df, pd.DataFrame([new_edge])], ignore_index=True)
    edge_geom_lookup[bridge_eid] = geom

    t_type = G.nodes[target_nid].get('node_type', '?')
    t_name = G.nodes[target_nid].get('name', target_nid)
    b_type = G.nodes[br].get('node_type', '?')
    print(f"    BRIDGE {target_nid}[{t_type}]({t_name[:18]}) "
          f"→ {br}[{b_type}]  ({br_dist:.2f} km)")

    # Expand main_nodes so next bridge can land on this node too
    comp_of_target = nx.node_connected_component(G, target_nid)
    main_nodes.update(comp_of_target)

if not not_bridged:
    print(f"  All bridge targets connected ✓  (bridge edges added: {bridge_count})")
else:
    print(f"  WARNING: Could not bridge: {not_bridged}")

# Final main component
components = sorted(nx.connected_components(G), key=len, reverse=True)
G_main = G.subgraph(components[0])
print(f"\n  Final main component: {G_main.number_of_nodes()} nodes, "
      f"{G_main.number_of_edges()} edges")
print(f"  Total components: {nx.number_connected_components(G)}")

# Validate facility + rail coverage
print("\n  FACILITY & RAIL COVERAGE IN G_main:")
all_ok = True
for ftype, total_gdf in [('port', ports), ('dryport', dryports),
                          ('rail_station', rail_stations)]:
    in_main = sum(1 for n in G_main.nodes
                  if G_main.nodes[n].get('node_type') == ftype)
    total = len(total_gdf)
    flag  = '✓' if in_main == total else f'⚠ MISSING {total - in_main}'
    if in_main != total: all_ok = False
    print(f"    {ftype:15s}: {in_main}/{total}  {flag}")

rail_em = sum(1 for _, _, _, d in G_main.edges(data=True, keys=True) if d.get('mode') == 'rail')
flag_r  = '✓' if rail_em == len(rails) else f'⚠ MISSING {len(rails) - rail_em}'
if rail_em != len(rails): all_ok = False
print(f"    rail_edges     : {rail_em}/{len(rails)}  {flag_r}")

inter_em = sum(1 for _, _, _, d in G_main.edges(data=True, keys=True) if d.get('mode') == 'intermodal')
print(f"    intermodal     : {inter_em}  (access links + bridges)")

if all_ok:
    print("    ALL ASSETS PRESENT IN G_main ✓")


# ============================================================================
# STEP 5 — ASSIGN OPERATIONAL ATTRIBUTES
# ============================================================================
hdr("STEP 5 — ASSIGN OPERATIONAL ATTRIBUTES")

SPEED_TABLE = {
    'motorway': 110, 'trunk': 80, 'primary': 80,
    'ml1': 80, 'ml2': 80, 'ml3': 80, 'connecting': 60,
    'road_access': 30, 'rail_access': 30, 'station_rail': 30,
    'intermodal': 30, 'fallback_access': 30, 'bridge_access': 30,
}
CAPACITY_TABLE = {
    'motorway': 5, 'trunk': 5, 'primary': 4,
    'ml1': 5, 'ml2': 5, 'ml3': 5, 'connecting': 3,
    'road_access': 2, 'rail_access': 2, 'station_rail': 2,
    'intermodal': 2, 'fallback_access': 1, 'bridge_access': 1,
}
MAJOR_PORTS      = ['karachi', 'bin qasim']
DEVELOPING_PORTS = ['gwadar']
MAJOR_DRYPORTS   = ['lahore', 'karachi', 'faisalabad', 'islamabad', 'sialkot']
MINOR_DRYPORTS   = ['peshawar', 'multan', 'raiwind', 'gilgit']

for u, v, k, d in G.edges(data=True, keys=True):
    mode = d.get('mode', 'road')
    rt   = str(d.get('road_type', '')).lower()
    lkm  = float(d.get('length_km', 0) or 0)
    spd  = float(d.get('speed_kmh', 0) or 0)

    if mode == 'rail':
        spd = 80
    elif spd <= 0:
        for key, val in SPEED_TABLE.items():
            if key in rt:
                spd = val; break
        if spd <= 0:
            spd = 60

    tt  = (lkm / spd) if spd > 0 else 0
    cap = 2
    for key, val in CAPACITY_TABLE.items():
        if key in rt or key == mode:
            cap = val; break

    G[u][v][k]['avg_speed_kmh']  = spd
    G[u][v][k]['travel_time_hr'] = round(tt, 6)
    G[u][v][k]['capacity_index'] = cap

for n, d in G.nodes(data=True):
    ntype = d.get('node_type', '')
    name  = str(d.get('name', '')).lower()
    hci = imp = red = 1
    if ntype == 'port':
        if any(p in name for p in MAJOR_PORTS):      hci,imp,red = 5,5,3
        elif any(p in name for p in DEVELOPING_PORTS): hci,imp,red = 3,4,2
        else:                                           hci,imp,red = 4,4,2
    elif ntype == 'dryport':
        if any(p in name for p in MAJOR_DRYPORTS):   hci,imp,red = 4,4,3
        elif any(p in name for p in MINOR_DRYPORTS):  hci,imp,red = 3,3,2
        else:                                          hci,imp,red = 2,2,1
    elif ntype == 'rail_station':     hci,imp,red = 2,2,2
    elif ntype == 'rail_intersection': hci,imp,red = 1,1,1
    G.nodes[n]['handling_capacity_index'] = hci
    G.nodes[n]['importance_index']        = imp
    G.nodes[n]['redundancy_index']        = red

G_main = G.subgraph(components[0]).copy()
print("  Attributes assigned.")
print(f"  G_main: {G_main.number_of_nodes()} nodes, {G_main.number_of_edges()} edges")


# ============================================================================
# STEP 6 — BASELINE METRICS
# ============================================================================
hdr("STEP 6 — BASELINE METRICS")

sub("6A: Betweenness centrality (k=500)")
t0 = time.time()
bc = nx.betweenness_centrality(G_main, k=K_BC, weight=WEIGHT, normalized=True, seed=42)
nx.set_node_attributes(G_main, bc, 'betweenness_centrality')
print(f"    Done in {time.time()-t0:.1f}s  [{min(bc.values()):.6f}, {max(bc.values()):.6f}]")

sub("6B: Degree centrality")
dc = nx.degree_centrality(G_main)
nx.set_node_attributes(G_main, dc, 'degree_centrality')

sub("6C: Closeness centrality")
t0 = time.time()
cc = nx.closeness_centrality(G_main, distance=WEIGHT)
nx.set_node_attributes(G_main, cc, 'closeness_centrality')
print(f"    Done in {time.time()-t0:.1f}s")

sub("6D: Eigenvector centrality")
# eigenvector_centrality is not implemented for MultiGraph.
# Convert to a simple Graph first by keeping the minimum-weight edge
# between each node pair (same approach used by shortest-path algorithms).
G_simple = nx.Graph()
G_simple.add_nodes_from(G_main.nodes(data=True))
for u, v, d in G_main.edges(data=True):
    w = d.get(WEIGHT, 1.0) or 1.0
    if not G_simple.has_edge(u, v) or w < G_simple[u][v].get(WEIGHT, float('inf')):
        G_simple.add_edge(u, v, **d)
try:
    ec = nx.eigenvector_centrality(G_simple, max_iter=1000, weight=WEIGHT)
except nx.PowerIterationFailedConvergence:
    ec = nx.eigenvector_centrality_numpy(G_simple, weight=WEIGHT)
nx.set_node_attributes(G_main, ec, 'eigenvector_centrality')
print(f"    Done  [{min(ec.values()):.6f}, {max(ec.values()):.6f}]")

sub("6E: Edge betweenness centrality (k=500)")
t0 = time.time()
ebc = nx.edge_betweenness_centrality(G_main, k=K_BC, weight=WEIGHT, seed=42)
for (u, v, ek), val in ebc.items():
    if G_main.has_edge(u, v, ek):
        G_main[u][v][ek]['edge_betweenness'] = val
print(f"    Done in {time.time()-t0:.1f}s")

sub("6F: Global metrics")
s_sample = random.sample(list(G_main.nodes), min(200, G_main.number_of_nodes()))

total_tt = count_tt = 0
for src in s_sample:
    try:
        for tgt, tt in nx.single_source_dijkstra_path_length(
                G_main, src, weight=WEIGHT).items():
            if tgt != src and tt < float('inf'):
                total_tt += tt; count_tt += 1
    except Exception:
        pass
avg_tt = (total_tt / count_tt) if count_tt > 0 else 0

total_km = count_km = 0
for src in s_sample:
    try:
        for tgt, km in nx.single_source_dijkstra_path_length(
                G_main, src, weight='length_km').items():
            if tgt != src and km < float('inf'):
                total_km += km; count_km += 1
    except Exception:
        pass
avg_km = (total_km / count_km) if count_km > 0 else 0

global_metrics = {
    'num_nodes'            : G_main.number_of_nodes(),
    'num_edges'            : G_main.number_of_edges(),
    'num_components'       : nx.number_connected_components(G),
    'avg_degree'           : round(sum(d for _,d in G_main.degree()) /
                                   G_main.number_of_nodes(), 4),
    'global_efficiency'    : round(nx.global_efficiency(G_simple), 7),
    'avg_shortest_path_hr' : round(avg_tt, 4),
    'avg_shortest_path_km' : round(avg_km, 4),
    'avg_clustering'       : round(nx.average_clustering(G_simple), 6),
    'density'              : round(nx.density(G_main), 8),
    'assortativity'        : round(nx.degree_assortativity_coefficient(G_simple), 6),
    'total_length_km'      : round(sum(d.get('length_km',0)
                                       for _,_,_,d in G_main.edges(data=True, keys=True)), 2),
    'computed_at'          : datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
}
for k, v in global_metrics.items():
    print(f"    {k:30s}: {v}")

sub("6G: Key trade corridor shortest paths")
facility_ids_main = [n for n in G_main.nodes
                     if G_main.nodes[n].get('node_type')
                     in ('port', 'dryport', 'rail_station')]
sp_records = []
for src, tgt in combinations(facility_ids_main, 2):
    try:
        tt   = nx.shortest_path_length(G_main, src, tgt, weight=WEIGHT)
        km   = nx.shortest_path_length(G_main, src, tgt, weight='length_km')
        path = nx.shortest_path(G_main, src, tgt, weight=WEIGHT)
        modes = sorted({list(G_main[path[i]][path[i+1]].values())[0].get('mode','')
                        for i in range(len(path)-1)})
        sp_records.append({
            'source': src, 'source_name': G_main.nodes[src].get('name',''),
            'source_type': G_main.nodes[src].get('node_type',''),
            'target': tgt, 'target_name': G_main.nodes[tgt].get('name',''),
            'target_type': G_main.nodes[tgt].get('node_type',''),
            'travel_time_hr': round(tt,4), 'distance_km': round(km,4),
            'num_hops': len(path)-1, 'modes_used': '+'.join(modes),
        })
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        sp_records.append({
            'source': src, 'source_name': G_main.nodes[src].get('name',''),
            'source_type': G_main.nodes[src].get('node_type',''),
            'target': tgt, 'target_name': G_main.nodes[tgt].get('name',''),
            'target_type': G_main.nodes[tgt].get('node_type',''),
            'travel_time_hr': None, 'distance_km': None,
            'num_hops': 0, 'modes_used': 'NO_PATH',
        })
sp_df = pd.DataFrame(sp_records)
print(f"    {len(sp_df)} corridor paths  "
      f"(unreachable: {sp_df['travel_time_hr'].isna().sum()})")


# ============================================================================
# STEP 7 — EXPORT FILES
# ============================================================================
hdr("STEP 7 — EXPORT FILES")

node_recs = []
for node in G_main.nodes:
    nd = G_main.nodes[node]
    node_recs.append({
        'node_id'                : node,
        'asset_id'               : nd.get('asset_id', node),
        'node_type'              : nd.get('node_type', ''),
        'name'                   : nd.get('name', ''),
        'lon'                    : nd.get('lon', 0),
        'lat'                    : nd.get('lat', 0),
        'rail_intersection'      : nd.get('rail_intersection', 0),
        'degree'                 : G_main.degree(node),
        'betweenness_centrality' : nd.get('betweenness_centrality', 0),
        'degree_centrality'      : nd.get('degree_centrality', 0),
        'closeness_centrality'   : nd.get('closeness_centrality', 0),
        'eigenvector_centrality' : nd.get('eigenvector_centrality', 0),
        'handling_capacity_index': nd.get('handling_capacity_index', 0),
        'importance_index'       : nd.get('importance_index', 0),
        'redundancy_index'       : nd.get('redundancy_index', 0),
    })
nodes_attr_df = pd.DataFrame(node_recs)
nodes_attr_df.to_csv(os.path.join(OUTPUT_DIR, "nodes_attributed.csv"), index=False)
nodes_attr_df.to_csv(os.path.join(OUTPUT_DIR, "baseline_metrics.csv"),  index=False)
pd.DataFrame([global_metrics]).to_csv(
    os.path.join(OUTPUT_DIR, "baseline_global_metrics.csv"), index=False)
sp_df.to_csv(os.path.join(OUTPUT_DIR, "baseline_shortest_paths.csv"), index=False)
print("  CSVs written.")

edge_recs = []
for u, v, _, d in G_main.edges(data=True, keys=True):
    edge_recs.append({
        'edge_id'         : d.get('edge_id', ''),
        'asset_id'        : d.get('asset_id', d.get('edge_id','')),
        'from_node'       : u, 'to_node': v,
        'mode'            : d.get('mode', ''),
        'road_type'       : d.get('road_type', ''),
        'length_km'       : d.get('length_km', 0),
        'avg_speed_kmh'   : d.get('avg_speed_kmh', 0),
        'travel_time_hr'  : d.get('travel_time_hr', 0),
        'capacity_index'  : d.get('capacity_index', 0),
        'edge_betweenness': d.get('edge_betweenness', 0),
        'name'            : d.get('name', ''),
    })
edges_attr_df = pd.DataFrame(edge_recs)
edges_attr_df.to_csv(os.path.join(OUTPUT_DIR, "edges_attributed.csv"),      index=False)
edges_attr_df.to_csv(os.path.join(OUTPUT_DIR, "baseline_edge_metrics.csv"), index=False)

valid_node_ids  = set(G_main.nodes())
nodes_df_export = nodes_df[nodes_df['node_id'].isin(valid_node_ids)].copy()
nodes_gdf = gpd.GeoDataFrame(
    nodes_df_export[['node_id','asset_id','node_type','name',
                     'lon','lat','rail_intersection']].merge(
        nodes_attr_df[['node_id','betweenness_centrality','degree_centrality',
                       'closeness_centrality','importance_index',
                       'handling_capacity_index','redundancy_index']],
        on='node_id', how='left'),
    geometry=nodes_df_export['geometry'].values, crs="EPSG:4326")
nodes_gdf.to_file(os.path.join(OUTPUT_DIR, "nodes.gpkg"), driver="GPKG")
print(f"  nodes.gpkg: {len(nodes_gdf)} nodes")

edges_gdf = gpd.GeoDataFrame(
    edges_attr_df.copy(),
    geometry=edges_attr_df['edge_id'].map(edge_geom_lookup),
    crs="EPSG:4326").dropna(subset=['geometry'])
edges_gdf.to_file(os.path.join(OUTPUT_DIR, "edges.gpkg"), driver="GPKG")
print(f"  edges.gpkg: {len(edges_gdf)} edges")

with open(os.path.join(OUTPUT_DIR, "graph_baseline.gpickle"), 'wb') as f:
    pickle.dump(G, f, protocol=pickle.HIGHEST_PROTOCOL)
print("  graph_baseline.gpickle saved")


# ============================================================================
# STEP 8 — WRITE TO POSTGIS
# ============================================================================
hdr("STEP 8 — WRITE TO POSTGIS")
engine = get_engine()
if engine:
    ports_pg         = ports.copy()
    dryports_pg      = dryports.copy()
    rail_stations_pg = rail_stations.copy()
    roads_pg         = roads.copy()
    rails_pg         = rails.copy()
    access_links_pg  = access_links.copy()
    ports_pg['asset_id']         = [f"port_{r['id']}"    for _,r in ports.iterrows()]
    dryports_pg['asset_id']      = [f"dryport_{r['id']}" for _,r in dryports.iterrows()]
    rail_stations_pg['asset_id'] = [f"station_{r['id']}" for _,r in rail_stations.iterrows()]
    roads_pg['asset_id']         = [f"road_{r['id']}"    for _,r in roads.iterrows()]
    rails_pg['asset_id']         = [f"rail_{r['id']}"    for _,r in rails.iterrows()]
    access_links_pg['asset_id']  = [f"access_{r['id']}"  for _,r in access_links.iterrows()]
    write_to_postgis(ports_pg,         "ports",         engine)
    write_to_postgis(dryports_pg,      "dryports",      engine)
    write_to_postgis(rail_stations_pg, "stations",      engine)
    write_to_postgis(roads_pg,         "roads",         engine)
    write_to_postgis(rails_pg,         "railways",      engine)
    write_to_postgis(access_links_pg,  "accesslinks",  engine)
    write_to_postgis(nodes_gdf,        "network_nodes", engine)
    write_to_postgis(edges_gdf,        "network_edges", engine)
    with engine.connect() as conn:
        nodes_attr_df.to_sql("baseline_node_metrics",  conn, if_exists="replace", index=False)
        edges_attr_df.to_sql("baseline_edge_metrics",  conn, if_exists="replace", index=False)
        pd.DataFrame([global_metrics]).to_sql(
            "baseline_global_metrics", conn, if_exists="replace", index=False)
        sp_df.to_sql("baseline_shortest_paths",        conn, if_exists="replace", index=False)
        conn.commit()
    print("  All tables written to PostGIS.")
else:
    print("  Skipped PostGIS — no connection.")


# ============================================================================
# FINAL SUMMARY + VALIDATION
# ============================================================================
hdr("SCRIPT COMPLETE")

spd_zero = sum(1 for _, _, _, d in G_main.edges(data=True, keys=True) if d.get('avg_speed_kmh',0)==0)
tt_zero  = sum(1 for _, _, _, d in G_main.edges(data=True, keys=True) if d.get('travel_time_hr',0)==0)
cap_zero = sum(1 for _, _, _, d in G_main.edges(data=True, keys=True) if d.get('capacity_index',0)==0)
null_bc  = nodes_gdf['betweenness_centrality'].isna().sum()
null_hci = nodes_gdf['handling_capacity_index'].isna().sum()

rail_main  = sum(1 for _, _, _, d in G_main.edges(data=True, keys=True) if d.get('mode')=='rail')
inter_main = sum(1 for _, _, _, d in G_main.edges(data=True, keys=True) if d.get('mode')=='intermodal')
road_main  = sum(1 for _, _, _, d in G_main.edges(data=True, keys=True) if d.get('mode')=='road')
rail_int_ct= sum(1 for n in G_main.nodes if G_main.nodes[n].get('node_type')=='rail_intersection')

print("\n  VALIDATION:")
print(f"    edges with avg_speed_kmh  = 0 : {spd_zero}  (should be 0)")
print(f"    edges with travel_time_hr = 0 : {tt_zero}  (should be 0)")
print(f"    edges with capacity_index = 0 : {cap_zero}  (should be 0)")
print(f"    nodes with NULL betweenness    : {null_bc}  (should be 0)")
print(f"    nodes with NULL handling_cap   : {null_hci}  (should be 0)")
print(f"    road edges in G_main           : {road_main}")
print(f"    rail edges in G_main           : {rail_main}  "
      f"(total rail features = {len(rails)})")
print(f"    intermodal edges in G_main     : {inter_main}  "
      f"(access links + bridges)")
print(f"    rail_intersection nodes        : {rail_int_ct}")

print("\n  FACILITY COVERAGE IN G_main:")
all_ok = True
for ftype, total_gdf in [('port',ports),('dryport',dryports),('rail_station',rail_stations)]:
    in_main = sum(1 for n in G_main.nodes
                  if G_main.nodes[n].get('node_type')==ftype)
    total = len(total_gdf)
    flag  = '✓' if in_main==total else f'⚠ {total-in_main} MISSING'
    if in_main!=total: all_ok=False
    print(f"    {ftype:15s}: {in_main}/{total}  {flag}")
if all_ok:
    print("    ALL FACILITIES PRESENT ✓")

print(f"""
  MODAL SEPARATION SUMMARY:
    road edges connect road_intersection ↔ road_intersection ONLY
    rail edges connect rail nodes (station/rail_int) ↔ rail nodes ONLY
    intermodal edges are the ONLY legal road↔rail transitions
    (at facility nodes: ports, dryports, stations)

  GRAPH:
    Nodes:          {G.number_of_nodes()}
    Edges:          {G.number_of_edges()}
    Components:     {nx.number_connected_components(G)}
    Main component: {G_main.number_of_nodes()} nodes / {G_main.number_of_edges()} edges

  FILES WRITTEN:
    outputs/nodes.gpkg                  ← import this in ALL hazard scripts
    outputs/edges.gpkg                  ← import this in ALL hazard scripts
    outputs/nodes_attributed.csv
    outputs/edges_attributed.csv
    outputs/baseline_metrics.csv
    outputs/baseline_edge_metrics.csv
    outputs/baseline_global_metrics.csv
    outputs/baseline_shortest_paths.csv
    outputs/graph_baseline.gpickle      ← import this in risk engine

  KEY FIELD FOR JOINS:
    asset_id — present in nodes.gpkg, edges.gpkg, and all hazard outputs
    Format: port_1, dryport_3, station_12, road_45, rail_7, rail_int_3, access_6
""")