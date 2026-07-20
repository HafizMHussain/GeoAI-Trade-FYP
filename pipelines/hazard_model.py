"""
==============================================================================
SCRIPT 2 — Unified Hazard Pipeline  v6.1 — EEZ/COAST GPKG FALLBACK
==============================================================================
FYP: Geo-Resilience for Ports and Supply Chains (Pakistan)

CHANGES FROM v6
    1. pakistan_eez, coast, coastline — now DB-first with automatic
       fallback to data/pakistan_eez.gpkg and data/coast_buffer.gpkg.
       Triggered by the v6 run error:
         permission denied for table pakistan_eez
       If you grant SELECT on those tables to fyp_user later, the script
       picks up the DB versions automatically without any code change.

    See v6 docstring for full feature history.
==============================================================================
"""

from __future__ import annotations

import os, re, json, time, pickle, warnings, traceback
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

import requests
import numpy as np
import pandas as pd
import geopandas as gpd
from bs4 import BeautifulSoup
from shapely.geometry import Point
from sqlalchemy import create_engine, text

try:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity
    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False
    print("  [NLP] scikit-learn not installed — run: pip install scikit-learn")

warnings.filterwarnings("ignore")


# ============================================================================
# CONFIGURATION
# ============================================================================
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
DATA_DIR   = os.path.join(BASE_DIR, "data")
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")
os.makedirs(OUTPUT_DIR, exist_ok=True)

TIMESTAMP = datetime.utcnow().strftime("%Y%m%d_%H%M")

# ---- PostGIS --------------------------------------------------------------
DB_HOST   = "localhost"; DB_PORT = 5432
DB_NAME   = "fyp_georesilience"
DB_USER   = "fyp_user";  DB_PASS   = "fyp_pass"
DB_SCHEMA = "public"

# ---- Open-Meteo (self-hosted once deployed) ------------------------------
OPEN_METEO_URL = os.environ.get(
    "OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast")
OPEN_METEO_CHUNK    = 900
OPEN_METEO_SLEEP_S  = 0.3

# ---- Weather cell aggregation --------------------------------------------
# 0.01°  ≈ 1.1 km cells.  Matches model resolution for Pakistan.
# 0.1°   ≈ 11 km cells.   Fast; blurs intra-city.
# 0.001° ≈ 0.1 km cells.  Below model resolution; no accuracy gain.
WEATHER_CELL_RESOLUTION_DEG = 0.01

# ---- IMERG fallback (requires ~/.netrc) ----------------------------------
ENABLE_IMERG_FALLBACK = True

# ---- Composite-hazard weights --------------------------------------------
COMPOSITE_WEIGHTS = {
    "hazard_flood"   : 1.00,
    "hazard_cyclone" : 1.00,
    "hazard_strike"  : 0.90,
    "hazard_accident": 0.80,
}

# ---- Dryport rule (hard zero for flood) ----------------------------------
DRYPORT_FLOOD_DAMPENING = 0.0

# ---- Trigger thresholds --------------------------------------------------
TRIGGER_FLOOD    = 0.60
TRIGGER_CYCLONE  = 0.60
TRIGGER_STRIKE   = 0.60
TRIGGER_ACCIDENT = 0.60

# ---- TF-IDF thresholds ---------------------------------------------------
# 0.12 was too permissive — articles like "port storage charge waivers" passed.
# Raised to 0.20 to require clearer semantic similarity to seed sentences.
TFIDF_THRESHOLD_STRIKE   = 0.20
TFIDF_THRESHOLD_ACCIDENT = 0.20

# ---- RSS ingestion -------------------------------------------------------
RSS_MAX_AGE_HOURS  = 48
RSS_ACCEPT_UNDATED = False

# ---- Cyclone decay -------------------------------------------------------
CYCLONE_DECAY_SCALE_KM = 150.0
CYCLONE_CATEGORY_BREAKS = [
    (63,   0.10),    # Tropical Depression
    (89,   0.30),    # Tropical Storm
    (117,  0.55),    # Cat 1
    (153,  0.70),    # Cat 2
    (177,  0.85),    # Cat 3
    (208,  0.95),    # Cat 4
    (300,  1.00),    # Cat 5
]

# ============================================================================
# TRADE-KEYWORD GATE
# ============================================================================
# NOTE: Mixes literals with regex patterns. Safe to add literal English
# phrases; anything with regex metacharacters will be interpreted as regex.
TRADE_KEYWORDS = [
    # physical network
    "freight", "cargo", "container", "shipment", "consignment",
    "trucks?", "lorry", "lorries", "tanker", "trailer",
    "motorway", "highway", "national highway", "indus highway",
    "gt road", "n-\\d+", "m-\\d+",
    "port", "seaport", "dry ?port", "terminal", "port gate",
    "railway", "rail line", "rail track", "goods train",
    "freight train", "cargo train", "rail service",
    "trade route", "supply chain", "trade corridor",
    "logistics", "shipping", "transporter", "transport",
    # border / customs / trade admin
    "border", "crossing", "wagah", "torkham", "chaman",
    "customs", "import", "export", "sanction", "embargo",
    "trade ban",
    # explicit disruption
    "road blocked", "road closed", "road closure",
    "traffic halted", "traffic standstill",
]

TRADE_KEYWORD_RE = re.compile(
    r"\b(" + "|".join(TRADE_KEYWORDS) + r")\b",
    re.IGNORECASE)


def has_trade_keyword(*texts):
    return bool(TRADE_KEYWORD_RE.search(" ".join(str(t or "") for t in texts)))


# ============================================================================
# LOGGING
# ============================================================================
def hdr(t):  print(f"\n{'='*70}\n  {t}\n{'='*70}")
def sub(t):  print(f"\n  --- {t} ---")
def info(t): print(f"  {t}")


# ============================================================================
# HTTP
# ============================================================================
def safe_get(url, timeout=15, session=None):
    req = session.get if session else requests.get
    try:
        r = req(url, timeout=timeout)
        r.raise_for_status()
        return r
    except requests.exceptions.SSLError:
        try:
            r = req(url, timeout=timeout, verify=False)
            r.raise_for_status()
            return r
        except BaseException as e2:
            info(f"[HTTP] {url[:65]}... → SSL retry failed: {e2}")
            return None
    except BaseException as e:
        info(f"[HTTP] {url[:65]}... → {e}")
        return None


# ============================================================================
# DATABASE
# ============================================================================
def get_db_engine():
    try:
        eng = create_engine(
            f"postgresql://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}")
        with eng.connect() as c:
            c.execute(text("SELECT 1"))
        info("[DB] Connected")
        return eng
    except Exception as e:
        info(f"[DB] FATAL: cannot connect ({e})")
        raise


def read_postgis(table, engine, geom_col="geometry"):
    try:
        gdf = gpd.read_postgis(
            f"SELECT * FROM {DB_SCHEMA}.{table}",
            engine, geom_col=geom_col)
        info(f"[DB] Loaded {table}: {len(gdf)} rows")
        return gdf
    except Exception as e:
        info(f"[DB] Cannot read {table}: {e}")
        return None


def load_layer_db_or_file(table_name, file_candidates):
    """
    Try reading a layer from PostGIS first; on any failure (missing
    table, permission denied, etc.) fall through to a list of candidate
    .gpkg / .geojson files inside data/.

    Returns the first successful GeoDataFrame or None if nothing works.
    """
    # DB attempt
    gdf = read_postgis(table_name, DB)
    if gdf is not None:
        return gdf, f"postgis:{table_name}"

    # File fallbacks
    for fname in file_candidates:
        fpath = os.path.join(DATA_DIR, fname)
        if os.path.exists(fpath):
            try:
                gdf = gpd.read_file(fpath)
                info(f"[FILE] Loaded {fname}: {len(gdf)} rows")
                return gdf, f"file:{fname}"
            except Exception as e:
                info(f"[FILE] Cannot read {fname}: {e}")
    return None, None


def write_postgis(gdf, table, engine, if_exists="replace"):
    if engine is None: return
    try:
        gdf_w = gdf.copy()
        if gdf_w.geometry.name != "geometry":
            gdf_w = gdf_w.rename_geometry("geometry")
        gdf_w.to_postgis(
            table, engine, schema=DB_SCHEMA,
            if_exists=if_exists, index=False, chunksize=500)
        info(f"[DB] {table}: {len(gdf_w)} rows")
    except Exception as e:
        info(f"[DB] Warning {table}: {e}")


# ============================================================================
# STEP 1 — LOAD NODES + EDGES FROM POSTGIS
# ============================================================================
hdr("STEP 1 — LOAD NODES + EDGES")
DB = get_db_engine()

nodes_base = read_postgis("network_nodes", DB)
edges_base = read_postgis("network_edges", DB)
if nodes_base is None or edges_base is None:
    raise RuntimeError(
        "network_nodes / network_edges missing from PostGIS. "
        "Run network_model.py first.")

nodes_base = nodes_base.to_crs(epsg=3857)
edges_base = edges_base.to_crs(epsg=3857)
info(f"Nodes: {len(nodes_base)}  Edges: {len(edges_base)}")


# ============================================================================
# STEP 2 — LOAD sf_index FROM POSTGIS
# ============================================================================
hdr("STEP 2 — LOAD sf_index FROM POSTGIS")

SF_CANDIDATES = ["sf_index", "static_flood_index", "flood_index",
                 "static_fi", "sf_idx", "static_flood", "flood_static",
                 "static_flood_idx", "sfi"]


def load_sf_lookup(engine):
    lookup = {}
    for tname in ("roads", "railways", "ports", "stations"):
        try:
            with engine.connect() as conn:
                cols = pd.read_sql(
                    "SELECT column_name FROM information_schema.columns "
                    f"WHERE table_schema='{DB_SCHEMA}' "
                    f"AND table_name='{tname}'",
                    conn)["column_name"].tolist()
                sf_col = next((c for c in SF_CANDIDATES if c in cols), None)
                if sf_col is None or "asset_id" not in cols:
                    info(f"  {DB_SCHEMA}.{tname}: no sf_index / asset_id — skip")
                    continue
                df = pd.read_sql(
                    f"SELECT asset_id, {sf_col} FROM {DB_SCHEMA}.{tname} "
                    f"WHERE {sf_col} IS NOT NULL", conn)
                df[sf_col] = pd.to_numeric(df[sf_col], errors="coerce").fillna(0)
                for _, r in df.iterrows():
                    lookup[r["asset_id"]] = float(r[sf_col])
                nz = (df[sf_col] > 0).sum()
                info(f"  {DB_SCHEMA}.{tname}: col={sf_col}, "
                     f"n={len(df)}, non-zero={nz}")
        except Exception as e:
            info(f"  {DB_SCHEMA}.{tname} failed: {e}")
    return lookup


sf_lookup = load_sf_lookup(DB)
if not sf_lookup:
    info("  !! sf_index empty — flood will be rain-only !!")
info(f"  sf_index loaded for {len(sf_lookup)} assets")

nodes_base["sf_index"] = nodes_base["asset_id"].map(sf_lookup).fillna(0.0).round(6)
edges_base["sf_index"] = edges_base["asset_id"].map(sf_lookup).fillna(0.0).round(6)

access_mask = (edges_base["asset_id"]
               .astype(str)
               .str.startswith(("access_", "fallback_", "bridge_"))
               .fillna(False))
if access_mask.any() and (edges_base[~access_mask]["sf_index"] > 0).any():
    try:
        access_e = edges_base[access_mask].copy()
        rr_sf    = edges_base[~access_mask & (edges_base["sf_index"] > 0)][
                       ["asset_id", "sf_index", "geometry"]].copy()
        access_e["geometry"] = access_e.geometry.centroid
        rr_sf["geometry"]    = rr_sf.geometry.centroid
        joined = gpd.sjoin_nearest(
            access_e[["asset_id", "geometry"]],
            rr_sf[["sf_index", "geometry"]],
            how="left", distance_col="_dist")
        joined = joined.loc[~joined.index.duplicated(keep="first")]
        for _, row in joined.iterrows():
            if row["_dist"] <= 5000:
                edges_base.loc[
                    edges_base["asset_id"] == row["asset_id"],
                    "sf_index"] = float(row["sf_index"] or 0)
        info(f"  Access links inherited sf_index: "
             f"{(edges_base[access_mask]['sf_index']>0).sum()}/"
             f"{access_mask.sum()}")
    except Exception as e:
        info(f"  Access link inheritance failed: {e}")

info(f"  Nodes sf_index > 0: {(nodes_base['sf_index']>0).sum()}/{len(nodes_base)}")
info(f"  Edges sf_index > 0: {(edges_base['sf_index']>0).sum()}/{len(edges_base)}")


# ============================================================================
# OPEN-METEO BATCH
# ============================================================================
def open_meteo_batch(lats, lons, retries=2):
    if len(lats) == 0:
        return {}
    if len(lats) != len(lons):
        info("[Open-Meteo] lat/lon length mismatch")
        return {}

    out = {}
    n_chunks = (len(lats) + OPEN_METEO_CHUNK - 1) // OPEN_METEO_CHUNK
    info(f"  [Open-Meteo] endpoint={OPEN_METEO_URL}")
    info(f"  [Open-Meteo] {len(lats)} points across {n_chunks} chunk(s) "
         f"of up to {OPEN_METEO_CHUNK}")

    for ci, start in enumerate(range(0, len(lats), OPEN_METEO_CHUNK), 1):
        clats = lats[start:start + OPEN_METEO_CHUNK]
        clons = lons[start:start + OPEN_METEO_CHUNK]
        url = (
            f"{OPEN_METEO_URL}"
            f"?latitude={','.join(f'{x:.4f}' for x in clats)}"
            f"&longitude={','.join(f'{x:.4f}' for x in clons)}"
            "&current=precipitation,wind_speed_10m,visibility"
            "&wind_speed_unit=kmh"
            "&timezone=UTC"
        )
        data = None
        for attempt in range(retries + 1):
            r = safe_get(url, timeout=60)
            if r is None:
                info(f"  [Open-Meteo] chunk {ci}/{n_chunks} "
                     f"attempt {attempt+1} failed")
                continue
            try:
                data = r.json(); break
            except Exception as je:
                info(f"  [Open-Meteo] chunk {ci}/{n_chunks} "
                     f"JSON parse failed (attempt {attempt+1}): {je}")
        if data is None:
            info(f"  [Open-Meteo] chunk {ci}/{n_chunks} "
                 f"GIVING UP after {retries+1} attempts")
            if ci < n_chunks: time.sleep(OPEN_METEO_SLEEP_S)
            continue

        records = data if isinstance(data, list) else [data]
        for i, rec in enumerate(records):
            cur = rec.get("current") or {}
            out[start + i] = {
                "precipitation_mm": float(cur.get("precipitation", 0) or 0),
                "visibility_m"    : float(cur.get("visibility", 10000) or 10000),
                "wind_kmh"        : float(cur.get("wind_speed_10m", 0) or 0),
            }
        info(f"  [Open-Meteo] chunk {ci}/{n_chunks}: "
             f"{len(records)} pts → running total {len(out)}")
        if ci < n_chunks: time.sleep(OPEN_METEO_SLEEP_S)

    info(f"  [Open-Meteo] Completed: {len(out)}/{len(lats)} locations")
    return out


# ============================================================================
# IMERG FALLBACK
# ============================================================================
def imerg_fallback_rain(nodes_gdf, edges_gdf):
    try:
        import netrc, h5py
    except ImportError as ie:
        info(f"  [IMERG] missing package: {ie}")
        return {}
    try:
        host = "urs.earthdata.nasa.gov"
        creds = netrc.netrc().authenticators(host)
        if not creds:
            info(f"  [IMERG] no credentials for {host} in .netrc")
            return {}
        user, _, passwd = creds
        session = requests.Session()
        session.auth = (user, passwd)

        today = datetime.utcnow()
        base_url = (f"https://gpm1.gesdisc.eosdis.nasa.gov/data/GPM_L3/"
                    f"GPM_3IMERGHHE.07/{today.strftime('%Y')}/"
                    f"{today.strftime('%j')}/")
        r_dir = session.get(base_url, timeout=20); r_dir.raise_for_status()
        soup = BeautifulSoup(r_dir.text, "html.parser")
        files = sorted([a.get("href", "") for a in soup.find_all("a")
                        if a.get("href", "").endswith(".HDF5")])
        if not files:
            info(f"  [IMERG] no HDF5 files at {base_url}")
            return {}

        rain_dir = os.path.join(BASE_DIR, "rainfall")
        os.makedirs(rain_dir, exist_ok=True)
        fpath = os.path.join(rain_dir, "imerg_latest.HDF5")
        if os.path.exists(fpath): os.remove(fpath)

        rc = session.get(base_url + files[-1], stream=True, timeout=120)
        rc.raise_for_status()
        with open(fpath, "wb") as fh:
            for chunk in rc.iter_content(8192): fh.write(chunk)
        info(f"  [IMERG] downloaded {files[-1]} "
             f"({os.path.getsize(fpath)//1024} KB)")

        with h5py.File(fpath, "r") as hf:
            rain_arr = None
            for pp in ("Grid/precipitationCal", "Grid/precipitation",
                       "precipitationCal", "precipitation"):
                try:
                    rain_arr = np.array(hf[pp]); break
                except (KeyError, ValueError): continue
            if rain_arr is None:
                info("  [IMERG] precipitation dataset not found")
                return {}
            if rain_arr.ndim == 3: rain_arr = rain_arr[0]
            rain_arr = rain_arr.T
            rain_arr = np.where(rain_arr < 0, 0, rain_arr)
            lons = (np.array(hf["Grid/lon"][:]) if "Grid/lon" in hf
                    else np.linspace(-180, 180, rain_arr.shape[1]))
            lats = (np.array(hf["Grid/lat"][:]) if "Grid/lat" in hf
                    else np.linspace(-90, 90, rain_arr.shape[0]))

        def sample(lon, lat):
            i = int((lon - lons[0]) / (lons[1] - lons[0]))
            j = int((lat - lats[0]) / (lats[1] - lats[0]))
            i = max(0, min(i, rain_arr.shape[1] - 1))
            j = max(0, min(j, rain_arr.shape[0] - 1))
            return float(rain_arr[j, i])

        lookup = {}
        for g in (nodes_gdf, edges_gdf):
            for _, row in g.to_crs(4326).iterrows():
                pt = row.geometry.centroid
                lookup[row["asset_id"]] = min(sample(pt.x, pt.y) / 50.0, 1.0)
        info(f"  [IMERG] sampled {len(lookup)} assets, "
             f"max rain_idx = {max(lookup.values()):.3f}")
        return lookup

    except Exception as e:
        info(f"  [IMERG] fallback failed: {e}")
        return {}


# ============================================================================
# NLP CLASSIFIER
# ============================================================================
class LocalNLPClassifier:
    STRIKE_SEEDS = [
        "wheel-jam strike halts goods transport nationwide",
        "truckers strike no freight movement highways",
        "transporters strike containers stuck karachi port",
        "shutter-down strike closes market trade halted",
        "railway workers strike freight trains suspended",
        "port workers strike cargo operations halted karachi",
        "road blocked protestors trucks cannot pass",
        "national highway blocked sit-in freight diverted",
        "motorway closed protesters supply chain disrupted",
        "container terminal shutdown strike workers",
        "dharna blocks access to dry port lahore",
        "trade route blocked demonstrators goods stuck",
        "border crossing closed strike imports exports halted",
        "traders boycott transport cargo movement stopped",
        "countrywide lockdown shuts freight operations roads",
        "sit-in blocks M-2 motorway trucks diverted",
        "rail line blocked protest freight service halted",
        "karachi port gate closed workers agitation",
        "importers exporters affected strike port operations",
        "goods stuck warehouses transport strike roads blocked",
        "wagah border closed trucks cargo stuck imports exports halted",
        "torkham border sealed military operation trade suspended",
        "pakistan india border closed trade disrupted freight stuck",
        "border crossing closed security forces imports exports halted",
        "curfew imposed transport halted goods movement stopped city",
        "section 144 imposed motorway highway closed freight vehicles banned",
        "military operation highway closed supply route disrupted",
        "government imposed trade ban port operations suspended",
        "sanctions imposed pakistan port operations cargo blocked",
        "pakistan india trade suspended border closed exports imports",
        "PTI shutdown protest blocks motorway M-2 freight trucks halted",
        "political shutdown paralyses transport karachi lahore roads blocked",
        "official lockdown shuts freight operations roads closed nationwide",
        "war conflict border area supply route closed freight diverted",
        "chaman border closed afghanistan trade halted trucks stuck",
    ]

    ACCIDENT_SEEDS = [
        "container truck overturns motorway road blocked hours",
        "freight train derailment railway track closed",
        "oil tanker overturns national highway blocked",
        "heavy vehicle pile-up motorway closed both directions",
        "goods truck accident M-2 motorway traffic halted",
        "tanker explosion port access road closed",
        "lorry overturns highway road blocked freight stuck",
        "cargo train accident track suspended hours",
        "multiple trucks crash motorway closed diverted",
        "trailer overturns national highway traffic standstill",
        "railway freight wagons derailed track blocked",
        "heavy goods vehicle accident road closure hours",
        "M-9 karachi hyderabad motorway accident closed",
        "M-2 lahore islamabad motorway truck accident blocked",
        "indus highway N-55 accident freight trucks stuck",
        "port road blocked tanker accident access disrupted",
        "bridge closed heavy vehicle accident freight diverted",
        "foggy motorway pile-up trucks road closed hours",
        "goods train collides track blocked lahore karachi",
        "container vehicle accident supply chain disrupted",
    ]

    STRIKE_SEVERITY_WEIGHTS = {
        "nationwide": 0.60, "countrywide": 0.55, "national": 0.45,
        "all cities": 0.50, "across pakistan": 0.50,
        "wheel-jam": 0.55, "wheel jam": 0.55,
        "rail service suspended": 0.55, "freight suspended": 0.55,
        "port operations halted": 0.65, "port gate closed": 0.60,
        "container terminal": 0.50,
        "border crossing closed": 0.55, "customs closed": 0.50,
        "freight": 0.35, "cargo": 0.35, "import": 0.30, "export": 0.30,
        "supply chain": 0.40, "goods stuck": 0.40, "trade halted": 0.45,
        "transport halted": 0.40, "trucks blocked": 0.40,
        "motorway blocked": 0.45, "highway blocked": 0.40,
        "railway blocked": 0.45, "port blocked": 0.55, "road blocked": 0.30,
        "blocked": 0.20, "closed": 0.20, "shutdown": 0.35, "lockdown": 0.35,
        "dharna": 0.20, "sit-in": 0.20, "strike": 0.20, "protest": 0.15,
        "boycott": 0.15,
        "border closed": 0.70, "border closure": 0.70, "border sealed": 0.70,
        "border blocked": 0.65, "wagah border": 0.70, "torkham": 0.70,
        "chaman": 0.65, "curfew": 0.60, "section 144": 0.55,
        "military operation": 0.50, "army operation": 0.50,
        "security forces": 0.25, "sanctions": 0.55, "trade ban": 0.70,
        "export ban": 0.65, "import ban": 0.65, "trade suspended": 0.65,
        "trade embargo": 0.70, "war": 0.40, "conflict": 0.30,
        "operation": 0.20, "tension": 0.15,
        "government shutdown": 0.55, "official lockdown": 0.55,
        "political shutdown": 0.50, "city shutdown": 0.55,
        "karachi shutdown": 0.60, "lahore shutdown": 0.60,
        "islamabad shutdown": 0.60,
    }

    STRIKE_IRRELEVANT_PENALTIES = {
        "hospital": -0.20, "school": -0.15, "university": -0.15,
        "funeral": -0.25, "judicial": -0.20, "court hearing": -0.20,
        "cricket": -0.30, "match": -0.20, "wedding": -0.20,
    }

    ACCIDENT_SEVERITY_WEIGHTS = {
        "motorway": 0.55, "m-2": 0.60, "m-9": 0.60, "m-3": 0.55,
        "m-4": 0.55, "m-10": 0.50, "national highway": 0.45,
        "n-55": 0.50, "n-25": 0.45, "n-5": 0.45,
        "gt road": 0.40, "indus highway": 0.45,
        "port road": 0.60, "port access": 0.60,
        "container": 0.50, "tanker": 0.45, "trailer": 0.45,
        "truck": 0.35, "lorry": 0.35, "heavy vehicle": 0.35,
        "goods train": 0.50, "freight train": 0.50, "cargo train": 0.50,
        "closed": 0.30, "blocked": 0.30, "halted": 0.35,
        "standstill": 0.35, "diverted": 0.25, "suspended": 0.35,
        "hours": 0.20, "derailment": 0.45, "derailed": 0.40,
        "overturned": 0.30, "pile-up": 0.35, "pileup": 0.35,
        "explosion": 0.35, "supply chain": 0.40, "freight": 0.30,
    }

    ACCIDENT_IRRELEVANT_PENALTIES = {
        "hospital": -0.20, "admitted": -0.20,
        "injured persons": -0.20, "passengers killed": -0.15,
        "motorbike": -0.20, "motorcycle": -0.20, "pedestrian": -0.25,
        "rickshaw": -0.20, "car accident": -0.15,
    }

    ROAD_TYPE_PATTERNS = {
        "motorway" : ["motorway","m-1","m-2","m-3","m-4","m-9","m-10","m-11"],
        "trunk"    : ["national highway","n-55","n-25","n-5","n-35",
                      "n-70","n-65","gt road","indus highway","trunk road"],
        "railway"  : ["railway","rail line","train","track","freight train",
                      "goods train","cargo train"],
        "port_road": ["port road","port access","port gate",
                      "karachi port road","bin qasim road"],
        "primary"  : ["primary road","provincial road","main road"],
    }

    ROAD_IMPORTANCE = {
        "port_road": 1.00, "motorway": 0.90, "trunk": 0.70,
        "railway"  : 0.75, "primary": 0.40, "unknown": 0.20,
    }

    BUFFER_RADIUS_M = {
        "port_road": 5000, "motorway": 8000, "trunk": 6000,
        "railway"  : 5000, "primary": 4000, "unknown": 3000,
    }

    def __init__(self, city_lookup):
        self.city_lookup = city_lookup
        sorted_cities = sorted(city_lookup.keys(), key=len, reverse=True)
        self.city_pattern = re.compile(
            r"\b(" + "|".join(re.escape(c) for c in sorted_cities) + r")\b",
            re.IGNORECASE)
        self._build_vectorizers()

    def _build_vectorizers(self):
        if not SKLEARN_AVAILABLE:
            self.vec_strike = self.vec_accident = None
            self.seed_strike_centroid = self.seed_accident_centroid = None
            return
        import hashlib
        cache = os.path.join(OUTPUT_DIR, "tfidf_cache.pkl")
        _seed_hash = hashlib.md5(
            (str(self.STRIKE_SEEDS) + str(self.ACCIDENT_SEEDS)).encode()
        ).hexdigest()[:12]
        if os.path.exists(cache):
            try:
                with open(cache, "rb") as f: d = pickle.load(f)
                if d.get("seed_hash") == _seed_hash:
                    self.vec_strike             = d["vec_strike"]
                    self.vec_accident           = d["vec_accident"]
                    self.seed_strike_centroid   = d["seed_strike_centroid"]
                    self.seed_accident_centroid = d["seed_accident_centroid"]
                    info(f"[NLP] TF-IDF loaded from cache (hash={_seed_hash})")
                    return
                os.remove(cache)
            except Exception: pass
        self.vec_strike   = TfidfVectorizer(
            ngram_range=(1, 2), min_df=1, sublinear_tf=True, lowercase=True)
        self.vec_accident = TfidfVectorizer(
            ngram_range=(1, 2), min_df=1, sublinear_tf=True, lowercase=True)
        self.vec_strike.fit(self.STRIKE_SEEDS)
        self.vec_accident.fit(self.ACCIDENT_SEEDS)
        self.seed_strike_centroid   = np.asarray(
            self.vec_strike.transform(self.STRIKE_SEEDS).mean(axis=0))
        self.seed_accident_centroid = np.asarray(
            self.vec_accident.transform(self.ACCIDENT_SEEDS).mean(axis=0))
        try:
            with open(cache, "wb") as f:
                pickle.dump({
                    "vec_strike"            : self.vec_strike,
                    "vec_accident"          : self.vec_accident,
                    "seed_strike_centroid"  : self.seed_strike_centroid,
                    "seed_accident_centroid": self.seed_accident_centroid,
                    "seed_hash"             : _seed_hash,
                }, f)
            info(f"[NLP] TF-IDF fitted and cached (hash={_seed_hash})")
        except Exception as ce:
            info(f"[NLP] Cache save failed ({ce})")

    def _tfidf_scores(self, titles, vectorizer, centroid):
        if vectorizer is None or not titles: return [0.0] * len(titles)
        try:
            mat  = vectorizer.transform(titles)
            sims = cosine_similarity(mat, centroid).flatten()
            return [float(s) for s in sims]
        except Exception as e:
            info(f"[NLP] TF-IDF failed: {e}")
            return [0.0] * len(titles)

    def _extract_city(self, text_in):
        m = self.city_pattern.search(str(text_in))
        if m:
            found = m.group(1).lower()
            if found in self.city_lookup:
                lat, lon = self.city_lookup[found]
                return found, lat, lon
        return None, None, None

    @staticmethod
    def _noisy_or(weights):
        p_no = 1.0
        for w in weights:
            if w > 0:
                p_no *= max(0.0, 1.0 - min(w, 0.95))
        return 1.0 - p_no

    def _strike_severity(self, txt):
        t = str(txt).lower()
        positive, penalty = [], 0.0
        for term, w in self.STRIKE_SEVERITY_WEIGHTS.items():
            if term in t: positive.append(w)
        for term, p in self.STRIKE_IRRELEVANT_PENALTIES.items():
            if term in t: penalty += p
        return float(np.clip(self._noisy_or(positive) + penalty, 0.0, 1.0))

    def _accident_severity(self, title, description=""):
        t = (str(title) + " " + str(description)).lower()
        positive, penalty = [], 0.0
        for term, w in self.ACCIDENT_SEVERITY_WEIGHTS.items():
            if term in t: positive.append(w)
        for term, p in self.ACCIDENT_IRRELEVANT_PENALTIES.items():
            if term in t: penalty += p
        return float(np.clip(self._noisy_or(positive) + penalty, 0.0, 1.0))

    def _extract_road_type(self, title, description=""):
        t = (str(title) + " " + str(description)).lower()
        for rtype, patterns in self.ROAD_TYPE_PATTERNS.items():
            if any(p in t for p in patterns): return rtype
        return "unknown"

    def classify_strikes(self, items, threshold=TFIDF_THRESHOLD_STRIKE):
        if not items: return []
        titles = [it["title"] for it in items]
        scores = self._tfidf_scores(titles, self.vec_strike,
                                    self.seed_strike_centroid)
        results, rel_count, gated_out = [], 0, 0
        for it, score in zip(items, scores):
            title, desc = it["title"], it.get("description", "")
            passes_gate = has_trade_keyword(title, desc)
            is_rel = passes_gate and (score >= threshold)
            if is_rel:
                sev = self._strike_severity(title + " " + desc)
                city, lat, lon = self._extract_city(title + " " + desc)
                is_national = any(w in (title + desc).lower() for w in
                                  ["nationwide","countrywide",
                                   "across pakistan","all cities"])
                rel_count += 1
            else:
                sev, city, lat, lon, is_national = 0.0, None, None, None, False
                if score >= threshold and not passes_gate:
                    gated_out += 1
            results.append({
                "title": title, "description": desc[:150],
                "is_relevant": is_rel, "passes_trade_gate": passes_gate,
                "city": city, "lat": lat, "lon": lon,
                "severity": sev, "is_national": is_national,
                "tfidf_score": round(score, 4),
            })
        info(f"[NLP] Strike: {rel_count}/{len(titles)} relevant "
             f"(gate rejected {gated_out} TF-IDF-positive articles)")
        return results

    def classify_accidents(self, items, threshold=TFIDF_THRESHOLD_ACCIDENT):
        if not items: return []
        titles = [it["title"] for it in items]
        scores = self._tfidf_scores(titles, self.vec_accident,
                                    self.seed_accident_centroid)
        results, rel_count, gated_out = [], 0, 0
        for it, score in zip(items, scores):
            title, desc = it["title"], it.get("description", "")
            passes_gate = has_trade_keyword(title, desc)
            is_rel = passes_gate and (score >= threshold)
            if is_rel:
                sev       = self._accident_severity(title, desc)
                road_type = self._extract_road_type(title, desc)
                city, lat, lon = self._extract_city(title + " " + desc)
                rel_count += 1
            else:
                sev, road_type, city, lat, lon = 0.0, "unknown", None, None, None
                if score >= threshold and not passes_gate:
                    gated_out += 1
            results.append({
                "title": title, "description": desc[:150],
                "is_relevant": is_rel, "passes_trade_gate": passes_gate,
                "city": city, "lat": lat, "lon": lon,
                "severity": sev, "road_type": road_type,
                "tfidf_score": round(score, 4),
            })
        info(f"[NLP] Accident: {rel_count}/{len(titles)} relevant "
             f"(gate rejected {gated_out} TF-IDF-positive articles)")
        return results


# ============================================================================
# RSS PUB-DATE PARSING + FETCHER
# ============================================================================
_PUB_DATE_FMTS = [
    "%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z",
    "%a, %d %b %Y %H:%M:%S",    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%SZ",       "%Y-%m-%d %H:%M:%S",
]


def _parse_pub_date(raw):
    if not raw: return None
    raw = re.sub(r"\s*\([^)]*\)\s*$", "", raw.strip()).strip()
    tz_map = {"GMT":"+0000","UTC":"+0000","UT":"+0000",
              "EST":"-0500","EDT":"-0400","CST":"-0600","CDT":"-0500",
              "MST":"-0700","MDT":"-0600","PST":"-0800","PDT":"-0700",
              "PKT":"+0500"}
    for name, offset in tz_map.items():
        if raw.endswith(f" {name}"):
            raw = raw[: -len(name)].strip() + offset; break
    for fmt in _PUB_DATE_FMTS:
        try:
            dt = datetime.strptime(raw, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone(timedelta(hours=5)))
            return dt.astimezone(timezone.utc)
        except (ValueError, OverflowError):
            continue
    return None


def fetch_rss_items(urls, max_age_hours=RSS_MAX_AGE_HOURS,
                    accept_undated=RSS_ACCEPT_UNDATED):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
    items, seen = [], set()
    total, dropped, undated = 0, 0, 0
    for url in urls:
        r = safe_get(url)
        if not r: continue
        try:
            soup = BeautifulSoup(r.content, "xml")
            for item in soup.find_all("item"):
                title = item.title.text.strip()       if item.title       else ""
                desc  = item.description.text.strip() if item.description else ""
                if not title or len(title) <= 10 or title in seen: continue
                total += 1
                pub_tag = item.find("pubDate") or item.find("pubdate")
                pub_raw = pub_tag.text.strip() if pub_tag else None
                pub_dt  = _parse_pub_date(pub_raw)
                if pub_dt is None:
                    undated += 1
                    if not accept_undated: continue
                elif pub_dt < cutoff:
                    dropped += 1; continue
                seen.add(title)
                items.append({"title": title, "description": desc,
                              "pub_date": pub_raw or "unknown",
                              "pub_dt": pub_dt})
        except Exception as pe:
            info(f"  [RSS parse] {url[:60]}... → {pe}")
    info(f"  RSS: {total} total, {dropped} too old, "
         f"{undated} undated ({'kept' if accept_undated else 'dropped'}), "
         f"{len(items)} kept")
    return items


# ============================================================================
# STEP 3 — CITY LOOKUP (FROM CSV) + CLASSIFIER
# ============================================================================
hdr("STEP 3 — CITY LOOKUP (CSV) + CLASSIFIER")

cities_csv_path = os.path.join(DATA_DIR, "Pakistan_Centeroids.csv")
if not os.path.exists(cities_csv_path):
    raise RuntimeError(f"Cities CSV missing: {cities_csv_path}")
cities_df = pd.read_csv(cities_csv_path)

city_col = next((c for c in cities_df.columns if c.lower() == "city"), None)
lat_col  = next((c for c in cities_df.columns if c.lower() == "lat"),  None)
lon_col  = next((c for c in cities_df.columns if c.lower() == "lon"),  None)
if not (city_col and lat_col and lon_col):
    raise RuntimeError(
        f"Pakistan_Centeroids.csv needs city/lat/lon columns. "
        f"Found: {list(cities_df.columns)}")

CITY_LOOKUP = {str(r[city_col]).lower(): (float(r[lat_col]), float(r[lon_col]))
               for _, r in cities_df.iterrows()
               if pd.notna(r[city_col])}
info(f"Loaded {len(CITY_LOOKUP)} cities from {os.path.basename(cities_csv_path)}")

classifier    = LocalNLPClassifier(CITY_LOOKUP)
HAZARD_STATUS = {h: "NOT_RUN" for h in ["flood","cyclone","strike","accident"]}


# ============================================================================
# HELPER — clean event-buffer GDF
# ============================================================================
def _buffered_events_gdf(events_df, value_cols, crs_target="EPSG:3857"):
    if len(events_df) == 0:
        return gpd.GeoDataFrame(columns=list(value_cols) + ["geometry"],
                                geometry="geometry", crs=crs_target)
    pts = gpd.GeoDataFrame(
        events_df,
        geometry=[Point(r["lon"], r["lat"]) for _, r in events_df.iterrows()],
        crs="EPSG:4326").to_crs(crs_target)
    buffers = [geom.buffer(float(r.get("buf_radius", 5000)))
               for geom, (_, r) in zip(pts.geometry, pts.iterrows())]
    return gpd.GeoDataFrame(
        events_df[value_cols].copy().reset_index(drop=True),
        geometry=buffers, crs=crs_target)


# ============================================================================
# HAZARD 1 — FLOOD
# ============================================================================
def run_flood(nodes_gdf, edges_gdf):
    hdr("HAZARD 1 — FLOOD")
    nodes_gdf = nodes_gdf.copy(); edges_gdf = edges_gdf.copy()
    for g in (nodes_gdf, edges_gdf):
        g["hazard_flood"]  = 0.0
        g["trigger_flood"] = False
    gdacs_flood = False

    try:
        sub("1A: Static sf_index")
        info(f"  Node sf_index range: "
             f"[{nodes_gdf['sf_index'].min():.3f}, "
             f"{nodes_gdf['sf_index'].max():.3f}]")

        sub(f"1B: Live rainfall (cell aggregation at "
            f"{WEATHER_CELL_RESOLUTION_DEG}°)")

        assets_4326 = pd.concat([
            nodes_gdf[["asset_id", "geometry"]].to_crs(4326),
            edges_gdf[["asset_id", "geometry"]].to_crs(4326),
        ], ignore_index=True)
        assets_4326["lat"] = assets_4326.geometry.centroid.y
        assets_4326["lon"] = assets_4326.geometry.centroid.x
        assets_4326 = assets_4326.dropna(subset=["lat", "lon", "asset_id"])

        scale = 1.0 / WEATHER_CELL_RESOLUTION_DEG
        assets_4326["cell"] = list(zip(
            (assets_4326["lat"] * scale).round().astype(int),
            (assets_4326["lon"] * scale).round().astype(int),
        ))
        cell_centroids = assets_4326.groupby("cell").agg(
            lat=("lat", "mean"), lon=("lon", "mean")).reset_index()
        info(f"  {len(assets_4326)} asset-centroids → "
             f"{len(cell_centroids)} weather cells")

        weather_by_cell_idx = open_meteo_batch(
            cell_centroids["lat"].tolist(),
            cell_centroids["lon"].tolist())

        rain_by_cell = {}
        for i, cell in enumerate(cell_centroids["cell"]):
            mm = weather_by_cell_idx.get(i, {}).get("precipitation_mm", 0)
            rain_by_cell[cell] = min(mm / 10.0, 1.0)

        assets_4326["rain_idx"] = assets_4326["cell"].map(rain_by_cell).fillna(0)
        rain_lookup = (assets_4326.groupby("asset_id")["rain_idx"]
                       .max().to_dict())

        if ENABLE_IMERG_FALLBACK and (not rain_lookup or
                                       max(rain_lookup.values(), default=0) == 0):
            info("  Open-Meteo returned zero rain everywhere — "
                 "trying IMERG fallback")
            imerg_lookup = imerg_fallback_rain(nodes_gdf, edges_gdf)
            if imerg_lookup:
                rain_lookup = imerg_lookup
                info("  Using IMERG rainfall")

        nodes_gdf["_rain"] = nodes_gdf["asset_id"].map(rain_lookup).fillna(0)
        edges_gdf["_rain"] = edges_gdf["asset_id"].map(rain_lookup).fillna(0)
        max_rain = max(rain_lookup.values()) if rain_lookup else 0
        info(f"  Rain idx max={max_rain:.3f}  "
             f"nonzero_nodes={(nodes_gdf['_rain']>0).sum()}  "
             f"nonzero_edges={(edges_gdf['_rain']>0).sum()}")

        sub("1C: GDACS Pakistan flood alert")
        r_g = safe_get("https://www.gdacs.org/xml/rss.xml", timeout=10)
        if r_g:
            try:
                root = ET.fromstring(r_g.content)
                for item in root.iter("item"):
                    t = ""
                    if item.find("title") is not None:
                        t = item.find("title").text or ""
                    if "Flood" in t and "Pakistan" in t:
                        gdacs_flood = True; break
            except Exception as ge:
                info(f"  GDACS parse failed: {ge}")
        info(f"  GDACS Pakistan flood alert: {gdacs_flood}")

        sub("1D: Compute hazard_flood (rain-driven, sf_index as amplifier)")
        # sf_index is STATIC SUSCEPTIBILITY, not a live hazard.
        # It CANNOT independently push hazard above TRIGGER_FLOOD (0.60).
        #   PASSIVE_SF_CAP : max background hazard from susceptibility alone (no rain)
        #                    hard-capped at 0.15 — well below TRIGGER_FLOOD = 0.60
        #   SF_AMP         : how much sf_index amplifies rain effect
        #                    sf=0 → no amplification; sf=1 → 1.5× rain effect
        #   RAIN_COEF      : rain_idx is already normalized [0,1] (10 mm = 1.0)
        PASSIVE_SF_CAP = 0.15
        SF_AMP         = 0.50
        RAIN_COEF      = 1.00

        def _combine(sf, rain):
            passive   = np.minimum(sf * PASSIVE_SF_CAP, PASSIVE_SF_CAP)
            rain_norm = np.minimum(rain * RAIN_COEF, 1.0)
            # sf boosts rain impact; high-susceptibility zones flood faster
            active    = rain_norm * (1.0 + sf * SF_AMP)
            return np.clip(passive + active, 0.0, 1.0)

        nodes_gdf["hazard_flood"] = _combine(nodes_gdf["sf_index"],
                                             nodes_gdf["_rain"])
        edges_gdf["hazard_flood"] = _combine(edges_gdf["sf_index"],
                                             edges_gdf["_rain"])

        if gdacs_flood:
            nodes_gdf["hazard_flood"] = nodes_gdf["hazard_flood"].clip(lower=0.30)
            edges_gdf["hazard_flood"] = edges_gdf["hazard_flood"].clip(lower=0.30)
            info("  GDACS floor 0.30 applied (active flood alert in region)")

        dp_mask = (nodes_gdf["node_type"] == "dryport")
        nodes_gdf.loc[dp_mask, "hazard_flood"] *= DRYPORT_FLOOD_DAMPENING
        if "from_node" in edges_gdf.columns and DRYPORT_FLOOD_DAMPENING == 0.0:
            dp_ids = set(nodes_gdf.loc[dp_mask, "asset_id"])
            e_mask = (edges_gdf["from_node"].isin(dp_ids) |
                      edges_gdf["to_node"].isin(dp_ids))
            edges_gdf.loc[e_mask, "hazard_flood"] = 0.0
            info(f"  Dryports zeroed (nodes: {dp_mask.sum()}, "
                 f"edges: {e_mask.sum()})")

        nodes_gdf["hazard_flood"] = nodes_gdf["hazard_flood"].clip(0, 1).round(4)
        edges_gdf["hazard_flood"] = edges_gdf["hazard_flood"].clip(0, 1).round(4)
        nodes_gdf.drop(columns=["_rain"], inplace=True, errors="ignore")
        edges_gdf.drop(columns=["_rain"], inplace=True, errors="ignore")

        nodes_gdf["trigger_flood"] = nodes_gdf["hazard_flood"] > TRIGGER_FLOOD
        edges_gdf["trigger_flood"] = edges_gdf["hazard_flood"] > TRIGGER_FLOOD

        info(f"  Flood triggered: {nodes_gdf['trigger_flood'].sum()} nodes, "
             f"{edges_gdf['trigger_flood'].sum()} edges")
        HAZARD_STATUS["flood"] = "OK"

    except Exception as e:
        info(f"[FLOOD FATAL] {e}\n{traceback.format_exc()}")
        HAZARD_STATUS["flood"] = f"FAILED: {e}"

    return nodes_gdf, edges_gdf


# ============================================================================
# HAZARD 2 — CYCLONE  (EEZ/coast DB-first, .gpkg fallback — v6.1 fix)
# ============================================================================
def _cyclone_wind_factor(wind_kmh):
    if not np.isfinite(wind_kmh) or wind_kmh <= 0: return 0.0
    for limit, factor in CYCLONE_CATEGORY_BREAKS:
        if wind_kmh <= limit: return factor
    return 1.0


def run_cyclone(nodes_gdf, edges_gdf):
    hdr("HAZARD 2 — CYCLONE")
    nodes_gdf = nodes_gdf.copy(); edges_gdf = edges_gdf.copy()
    for g in (nodes_gdf, edges_gdf):
        g["hazard_cyclone"]  = 0.0
        g["trigger_cyclone"] = False

    try:
        sub("2A: Load EEZ + coastal filters (DB first, file fallback)")

        # ── EEZ: try DB, fall back to data/pakistan_eez.gpkg ────────────
        # If this keeps falling back, run once in your DB as a superuser:
        #   GRANT SELECT ON public.pakistan_eez, public.coast,
        #                   public.coastline TO fyp_user;
        eez, eez_src = load_layer_db_or_file(
            "pakistan_eez",
            ["pakistan_eez.gpkg"])
        if eez is None:
            raise RuntimeError(
                "pakistan_eez missing from both DB and data/ folder. "
                "Provide data/pakistan_eez.gpkg or grant SELECT to fyp_user.")
        info(f"  EEZ source: {eez_src}")

        # ── Coast: DB 'coast' → DB 'coastline' → data/coast_buffer.gpkg
        coast, coast_src = load_layer_db_or_file(
            "coast",
            ["coast_buffer.gpkg", "coast.gpkg", "coastline.gpkg"])
        if coast is None:
            # try DB 'coastline' table explicitly (alt name seen in your DB)
            coast, coast_src = load_layer_db_or_file(
                "coastline",
                ["coast_buffer.gpkg", "coast.gpkg", "coastline.gpkg"])
        if coast is None:
            raise RuntimeError(
                "coast / coastline missing from both DB and data/ folder. "
                "Provide data/coast_buffer.gpkg or grant SELECT to fyp_user.")
        info(f"  Coast source: {coast_src}")

        eez   = eez.to_crs(3857)
        coast = coast.to_crs(3857)
        eez_geom, coast_geom = eez.union_all(), coast.union_all()

        sub("2B: GDACS cyclone feed")
        wind_re = re.compile(r"(\d+)\s?(?:km/?h|kph)", re.IGNORECASE)
        def _extract_wind(desc):
            m = wind_re.search(str(desc))
            return int(m.group(1)) if m else np.nan

        r_cy = safe_get("https://www.gdacs.org/xml/rss.xml?eventtype=TC")
        cyc = []
        if r_cy:
            soup_cy = BeautifulSoup(r_cy.content, "xml")
            for item in soup_cy.find_all("item"):
                try:
                    cyc.append({
                        "lat"       : float(item.find("geo:lat").text),
                        "lon"       : float(item.find("geo:long").text),
                        "wind_speed": _extract_wind(item.description.text),
                    })
                except Exception: continue

        if not cyc:
            info("  GDACS has no cyclones — hazard_cyclone = 0")
            nodes_gdf.loc[nodes_gdf["node_type"]=="dryport","hazard_cyclone"] = 0.0
            HAZARD_STATUS["cyclone"] = "OK (no events)"
            return nodes_gdf, edges_gdf

        cyc_gdf = gpd.GeoDataFrame(
            cyc, geometry=[Point(c["lon"], c["lat"]) for c in cyc],
            crs="EPSG:4326").to_crs(3857)
        cyc_gdf["cyclone_id"] = cyc_gdf.index
        cyc_gdf["position"] = cyc_gdf.geometry.apply(
            lambda g: ("INSIDE_EEZ" if g.within(eez_geom)
                       else "COASTAL" if g.within(coast_geom)
                       else "OUTSIDE"))
        active = cyc_gdf[cyc_gdf["position"].isin(["INSIDE_EEZ","COASTAL"])].copy()
        info(f"  {len(cyc_gdf)} cyclones in feed, "
             f"{len(active)} near Pakistan")

        if len(active) == 0:
            nodes_gdf.loc[nodes_gdf["node_type"]=="dryport","hazard_cyclone"] = 0.0
            HAZARD_STATUS["cyclone"] = "OK (none near PK)"
            return nodes_gdf, edges_gdf

        sub("2C: Exponential decay + Saffir-Simpson intensity")
        coast_mask_n = nodes_gdf.geometry.intersects(coast_geom.buffer(1000))
        coast_mask_e = edges_gdf.geometry.intersects(coast_geom.buffer(1000))

        def _apply(asset_df, cyc_df):
            if len(asset_df) == 0:
                return pd.DataFrame(columns=["asset_id", "hazard_cyclone"])
            joined = gpd.sjoin_nearest(
                asset_df[["asset_id", "geometry"]],
                cyc_df[["cyclone_id", "wind_speed", "geometry"]],
                how="left", distance_col="distance_m")
            joined = joined.loc[~joined.index.duplicated(keep="first")]
            dist_km = joined["distance_m"].fillna(1e9) / 1000.0
            wind_f  = joined["wind_speed"].apply(_cyclone_wind_factor)
            decay   = np.exp(-dist_km / CYCLONE_DECAY_SCALE_KM)
            joined["hazard_cyclone"] = (wind_f * decay).clip(0, 1).round(4)
            return joined[["asset_id", "hazard_cyclone"]]

        n_cyc = _apply(nodes_gdf[coast_mask_n].copy(), active)
        e_cyc = _apply(edges_gdf[coast_mask_e].copy(), active)

        for main, res, lbl in [(nodes_gdf, n_cyc, "nodes"),
                               (edges_gdf, e_cyc, "edges")]:
            if len(res) == 0: continue
            res = res.groupby("asset_id")["hazard_cyclone"].max().reset_index()
            mg = main.merge(res, on="asset_id", how="left", suffixes=("", "_new"))
            mg["hazard_cyclone"] = mg["hazard_cyclone_new"].fillna(
                mg["hazard_cyclone"]).fillna(0)
            mg.drop(columns=["hazard_cyclone_new"], inplace=True, errors="ignore")
            if lbl == "nodes": nodes_gdf = mg
            else:              edges_gdf = mg

        nodes_gdf.loc[nodes_gdf["node_type"]=="dryport","hazard_cyclone"] = 0.0
        if "from_node" in edges_gdf.columns:
            dp_ids = set(nodes_gdf.loc[nodes_gdf["node_type"]=="dryport","asset_id"])
            dp_e = (edges_gdf["from_node"].isin(dp_ids) |
                    edges_gdf["to_node"].isin(dp_ids))
            edges_gdf.loc[dp_e, "hazard_cyclone"] = 0.0

        nodes_gdf["trigger_cyclone"] = nodes_gdf["hazard_cyclone"] > TRIGGER_CYCLONE
        edges_gdf["trigger_cyclone"] = edges_gdf["hazard_cyclone"] > TRIGGER_CYCLONE

        info(f"  Cyclone triggered: {nodes_gdf['trigger_cyclone'].sum()} nodes, "
             f"{edges_gdf['trigger_cyclone'].sum()} edges")
        HAZARD_STATUS["cyclone"] = "OK"

    except Exception as e:
        info(f"[CYCLONE FATAL] {e}\n{traceback.format_exc()}")
        HAZARD_STATUS["cyclone"] = f"FAILED: {e}"

    return nodes_gdf, edges_gdf


# ============================================================================
# HAZARD 3 — STRIKES
# ============================================================================
def run_strikes(nodes_gdf, edges_gdf):
    hdr("HAZARD 3 — STRIKES")
    nodes_gdf = nodes_gdf.copy(); edges_gdf = edges_gdf.copy()
    for g in (nodes_gdf, edges_gdf):
        g["hazard_strike"]  = 0.0
        g["trigger_strike"] = False
    edges_gdf["strike_index"] = 0.0

    try:
        sub("3A: Fetch RSS feeds")
        RSS_URLS = [
            "https://www.dawn.com/feeds/home",
            "https://www.thenews.com.pk/rss/1/1",
            "https://tribune.com.pk/feed/rss",
            "https://www.geo.tv/rss/1/0",
            "https://arynews.tv/feed/",
            "https://feeds.bbci.co.uk/news/world/rss.xml",
            "https://news.google.com/rss/search?q=Pakistan+wheel+jam+strike+transport",
            "https://news.google.com/rss/search?q=Pakistan+truckers+strike+highway+blocked",
            "https://news.google.com/rss/search?q=Pakistan+dharna+motorway+road+block",
            "https://news.google.com/rss/search?q=Pakistan+port+workers+strike+cargo",
            "https://news.google.com/rss/search?q=Pakistan+border+closed+trade+cargo",
            "https://news.google.com/rss/search?q=Pakistan+wagah+torkham+border+blocked",
            "https://news.google.com/rss/search?q=Pakistan+curfew+lockdown+transport",
            "https://news.google.com/rss/search?q=Pakistan+sanctions+port+trade+suspended",
            "https://news.google.com/rss/search?q=Pakistan+section+144+road+blocked",
        ]
        items = fetch_rss_items(RSS_URLS)
        info(f"  Unique articles: {len(items)}")
        if not items:
            raise ValueError("No articles fetched")

        sub("3B: Trade-gate + TF-IDF classification")
        classified = classifier.classify_strikes(items)
        audit_path = os.path.join(OUTPUT_DIR, f"strike_audit_{TIMESTAMP}.json")
        with open(audit_path, "w", encoding="utf-8") as f:
            json.dump(classified, f, indent=2, ensure_ascii=False)
        info(f"  Audit saved: {audit_path}")

        relevant = [c for c in classified
                    if c["is_relevant"] and c["lat"] is not None
                    and c["severity"] > 0.10]
        info(f"  Relevant events: {len(relevant)}")

        if not relevant:
            HAZARD_STATUS["strike"] = "OK (no events)"
            return nodes_gdf, edges_gdf

        sub("3C: Severity-scaled spatial join")
        df_ev = pd.DataFrame(relevant)

        # Separate national from local events
        # National strikes get a UNIFORM moderate hazard across ALL network assets
        # (not a huge geographic circle centered on one city)
        national_events = df_ev[df_ev["is_national"]].copy()
        local_events    = df_ev[~df_ev["is_national"]].copy()

        NATIONAL_STRIKE_CAP   = 0.50   # national strikes capped below max (they're diffuse)
        NATIONAL_STRIKE_DAMP  = 0.65   # fraction of severity applied uniformly
        LOCAL_BUF_BASE_M      = 4000   # minimum buffer radius for local events
        LOCAL_BUF_PER_SEV_M   = 12000  # additional radius per unit of severity

        # Apply national hazard uniformly
        if len(national_events) > 0:
            max_nat_sev = national_events["severity"].max()
            nat_hazard  = float(np.clip(max_nat_sev * NATIONAL_STRIKE_DAMP, 0,
                                         NATIONAL_STRIKE_CAP))
            for g in (nodes_gdf, edges_gdf):
                g["hazard_strike"] = g["hazard_strike"].clip(lower=nat_hazard)
            info(f"  National strike uniform floor: {nat_hazard:.3f}  "
                 f"(severity={max_nat_sev:.3f})")

        # Apply local events with small, sensible buffers
        if len(local_events) > 0:
            local_events = local_events[local_events["lat"].notna()].copy()
            local_events["buf_radius"] = (
                LOCAL_BUF_BASE_M +
                (LOCAL_BUF_PER_SEV_M * local_events["severity"]).astype(int))
            buf_gdf = _buffered_events_gdf(local_events, value_cols=["severity"])

            for main, lbl in [(nodes_gdf, "nodes"), (edges_gdf, "edges")]:
                imp = gpd.sjoin(
                    main[["asset_id", "geometry"]],
                    buf_gdf, how="left", predicate="intersects")
                mx = imp.groupby("asset_id")["severity"].max().reset_index()
                mx.columns = ["asset_id", "hazard_strike_local"]
                mg = main.merge(mx, on="asset_id", how="left")
                mg["hazard_strike"] = mg[["hazard_strike",
                                          "hazard_strike_local"]].max(axis=1).fillna(
                                              mg["hazard_strike"])
                mg.drop(columns=["hazard_strike_local"], inplace=True, errors="ignore")
                if lbl == "nodes": nodes_gdf = mg
                else:              edges_gdf = mg

        nodes_gdf["trigger_strike"] = nodes_gdf["hazard_strike"] > TRIGGER_STRIKE
        edges_gdf["trigger_strike"] = edges_gdf["hazard_strike"] > TRIGGER_STRIKE

        if "avg_speed_kmh" in edges_gdf.columns and "length_km" in edges_gdf.columns:
            edges_gdf["strike_index"] = (
                (edges_gdf["length_km"] /
                 edges_gdf["avg_speed_kmh"].replace(0, 60)) *
                (1 + edges_gdf["hazard_strike"])
            ).round(6)

        info(f"  Strike triggered: {nodes_gdf['trigger_strike'].sum()} nodes, "
             f"{edges_gdf['trigger_strike'].sum()} edges")
        HAZARD_STATUS["strike"] = "OK"

    except Exception as e:
        info(f"[STRIKE FATAL] {e}\n{traceback.format_exc()}")
        HAZARD_STATUS["strike"] = f"FAILED: {e}"

    return nodes_gdf, edges_gdf


# ============================================================================
# HAZARD 4 — ACCIDENTS
# ============================================================================
def run_accidents(nodes_gdf, edges_gdf):
    hdr("HAZARD 4 — ACCIDENTS")
    nodes_gdf = nodes_gdf.copy(); edges_gdf = edges_gdf.copy()
    for g in (nodes_gdf, edges_gdf):
        g["hazard_accident"]  = 0.0
        g["trigger_accident"] = False

    try:
        sub("4A: Fetch accident RSS")
        RSS_URLS = [
            "https://news.google.com/rss/search?q=Pakistan+truck+motorway+blocked",
            "https://news.google.com/rss/search?q=Pakistan+container+truck+accident+highway",
            "https://news.google.com/rss/search?q=Pakistan+freight+train+derailment",
            "https://news.google.com/rss/search?q=Pakistan+motorway+closed+accident",
            "https://news.google.com/rss/search?q=Pakistan+tanker+accident+road+blocked",
            "https://news.google.com/rss/search?q=Pakistan+national+highway+accident+blocked",
            "https://www.dawn.com/feeds/home",
            "https://www.geo.tv/rss/1/0",
        ]
        items = fetch_rss_items(RSS_URLS)
        info(f"  Unique articles: {len(items)}")
        if not items:
            raise ValueError("No articles fetched")

        sub("4B: Trade-gate + TF-IDF classification")
        classified = classifier.classify_accidents(items)
        audit_path = os.path.join(OUTPUT_DIR, f"accident_audit_{TIMESTAMP}.json")
        with open(audit_path, "w", encoding="utf-8") as f:
            json.dump(classified, f, indent=2, ensure_ascii=False)

        relevant = [c for c in classified
                    if c["is_relevant"] and c["lat"] is not None
                    and c["severity"] > 0.25]  # raised from 0.15 — exclude weak matches
        info(f"  Relevant events: {len(relevant)}")

        if not relevant:
            HAZARD_STATUS["accident"] = "OK (no events)"
            return nodes_gdf, edges_gdf

        sub("4C: Weather via Open-Meteo")
        unique_cities = list({(c["city"], c["lat"], c["lon"])
                              for c in relevant if c["city"]})
        w_lats = [x[1] for x in unique_cities]
        w_lons = [x[2] for x in unique_cities]
        weather_raw = open_meteo_batch(w_lats, w_lons) if unique_cities else {}

        WEATHER_MULTIPLIER = {
            "port_road": 0.8, "motorway": 1.0, "trunk": 0.8,
            "railway"  : 0.4, "primary": 0.3, "unknown": 0.1,
        }

        def _weather_risk(city, road_type):
            if not city: return 0.0
            try:
                idx = next(i for i, (c, _, _) in enumerate(unique_cities)
                           if c == city)
            except StopIteration:
                return 0.0
            w = weather_raw.get(idx, {})
            fog  = max(0, 1 - w.get("visibility_m", 10000) / 10000)
            rain = min(w.get("precipitation_mm", 0) / 10.0, 1.0)
            wind = min(w.get("wind_kmh", 0) / 80.0, 1.0)
            base = 0.50 * fog + 0.35 * rain + 0.15 * wind
            return float(np.clip(base * WEATHER_MULTIPLIER.get(road_type, 0.1),
                                 0, 1))

        sub("4D: Event GDF with severity × weather × road importance")
        # Dampening factor: noisy-OR of many moderate-weight keywords can stack
        # to unrealistically high values (e.g. 0.942 for a single truck fire).
        # Scale final event_hazard down to keep individual accidents proportionate.
        ACCIDENT_HAZARD_SCALE = 0.70
        events = []
        for c in relevant:
            wr = _weather_risk(c["city"], c["road_type"])
            ev_prob = 1 - (1 - min(c["severity"], 0.95)) * (1 - min(wr, 0.95))
            road_imp = classifier.ROAD_IMPORTANCE.get(c["road_type"], 0.20)
            event_hazard = float(np.clip(ev_prob * road_imp * ACCIDENT_HAZARD_SCALE,
                                         0, 1))
            events.append({**c,
                "weather_risk": round(wr, 4),
                "event_hazard": round(event_hazard, 4),
                "buf_radius"  : classifier.BUFFER_RADIUS_M.get(
                                    c["road_type"], 3000),
            })

        df_ev = pd.DataFrame(events)
        info("  Events summary:")
        for _, row in df_ev.iterrows():
            info(f"    {str(row['title'])[:40]:40s}  "
                 f"{row['road_type']:10s}  "
                 f"sev={row['severity']:.3f}  "
                 f"wx={row['weather_risk']:.3f}  "
                 f"hz={row['event_hazard']:.3f}")

        sub("4E: Spatial join to road/rail edges")
        buf_gdf   = _buffered_events_gdf(df_ev, value_cols=["event_hazard"])
        road_rail = edges_gdf[edges_gdf["mode"].isin(["road","rail"])].copy()
        if len(road_rail) == 0:
            info("  No road/rail edges found")
            HAZARD_STATUS["accident"] = "OK (no road/rail edges)"
            return nodes_gdf, edges_gdf

        e_imp = gpd.sjoin(
            road_rail[["asset_id", "geometry"]],
            buf_gdf, how="left", predicate="intersects")
        e_imp["event_hazard"] = e_imp["event_hazard"].fillna(0)
        e_mx = e_imp.groupby("asset_id")["event_hazard"].max().reset_index()
        e_mx.columns = ["asset_id", "hazard_accident"]
        edges_gdf = edges_gdf.merge(e_mx, on="asset_id", how="left",
                                    suffixes=("", "_acc"))
        edges_gdf["hazard_accident"] = edges_gdf["hazard_accident_acc"].fillna(
            edges_gdf["hazard_accident"]).fillna(0)
        edges_gdf.drop(columns=["hazard_accident_acc"],
                       inplace=True, errors="ignore")

        sub("4F: Node propagation (rail_station + road_intersection only)")
        node_hz = {}
        if "from_node" in edges_gdf.columns and "to_node" in edges_gdf.columns:
            for _, edge in edges_gdf[edges_gdf["hazard_accident"] > 0].iterrows():
                for nid in (edge["from_node"], edge["to_node"]):
                    node_hz[nid] = max(node_hz.get(nid, 0.0),
                                       float(edge["hazard_accident"]))

        id_col = "node_id" if "node_id" in nodes_gdf.columns else "asset_id"
        nodes_gdf["hazard_accident"] = nodes_gdf[id_col].map(node_hz).fillna(0.0)
        nodes_gdf.loc[
            nodes_gdf["node_type"].isin(["port","dryport"]),
            "hazard_accident"] = 0.0

        nodes_gdf["hazard_accident"] = nodes_gdf["hazard_accident"].round(4)
        edges_gdf["hazard_accident"] = edges_gdf["hazard_accident"].round(4)
        nodes_gdf["trigger_accident"] = nodes_gdf["hazard_accident"] > TRIGGER_ACCIDENT
        edges_gdf["trigger_accident"] = edges_gdf["hazard_accident"] > TRIGGER_ACCIDENT

        info(f"  Accident triggered: "
             f"{nodes_gdf['trigger_accident'].sum()} nodes, "
             f"{edges_gdf['trigger_accident'].sum()} edges")
        HAZARD_STATUS["accident"] = "OK"

    except Exception as e:
        info(f"[ACCIDENT FATAL] {e}\n{traceback.format_exc()}")
        HAZARD_STATUS["accident"] = f"FAILED: {e}"

    return nodes_gdf, edges_gdf


# ============================================================================
# STEP 4 — RUN ALL FOUR HAZARDS INDEPENDENTLY
# ============================================================================
hdr("STEP 4 — RUN ALL FOUR HAZARDS")

n_flood,   e_flood   = run_flood(    nodes_base.copy(), edges_base.copy())
n_cyclone, e_cyclone = run_cyclone(  nodes_base.copy(), edges_base.copy())
n_strike,  e_strike  = run_strikes(  nodes_base.copy(), edges_base.copy())
n_acc,     e_acc     = run_accidents(nodes_base.copy(), edges_base.copy())


# ============================================================================
# STEP 5 — MERGE HAZARD COLUMNS
# ============================================================================
hdr("STEP 5 — MERGE HAZARD COLUMNS")


def merge_col(base, src, col, trig):
    m = base.merge(src[["asset_id", col, trig]], on="asset_id",
                   how="left", suffixes=("", "_h"))
    if col + "_h" in m.columns:
        m[col]  = m[col + "_h"].fillna(0)
        m[trig] = m[trig + "_h"].fillna(False)
        m.drop(columns=[col + "_h", trig + "_h"],
               inplace=True, errors="ignore")
    else:
        m[col]  = m.get(col, 0.0)
        m[trig] = m.get(trig, False)
    return m


nodes_out = nodes_base.copy()
edges_out = edges_base.copy()

for sn, se, col, trig in [
    (n_flood,   e_flood,   "hazard_flood",    "trigger_flood"),
    (n_cyclone, e_cyclone, "hazard_cyclone",  "trigger_cyclone"),
    (n_strike,  e_strike,  "hazard_strike",   "trigger_strike"),
    (n_acc,     e_acc,     "hazard_accident", "trigger_accident"),
]:
    nodes_out = merge_col(nodes_out, sn, col, trig)
    edges_out = merge_col(edges_out, se, col, trig)

if "strike_index" in e_strike.columns:
    edges_out = edges_out.merge(
        e_strike[["asset_id","strike_index"]], on="asset_id", how="left")
    edges_out["strike_index"] = edges_out["strike_index"].fillna(0)
else:
    edges_out["strike_index"] = 0.0


# ============================================================================
# STEP 6 — COMPOSITE HAZARD
# ============================================================================
hdr("STEP 6 — COMPOSITE HAZARD")


def _composite_noisy_or(df):
    p_no = np.ones(len(df))
    for col, w in COMPOSITE_WEIGHTS.items():
        h = (df[col].clip(0, 1) * w).clip(0, 0.95).values
        p_no *= (1.0 - h)
    return (1.0 - p_no).clip(0, 1).round(4)


def _alert_level(row):
    ch = row["composite_hazard"]
    # CRITICAL: composite hazard very high, OR confirmed severe flood
    if ch >= 0.75 or (row.get("trigger_flood", False)
                      and row.get("hazard_flood", 0) > 0.80):
        return "CRITICAL"
    # HIGH: composite hazard genuinely elevated (multiple/strong hazards combining)
    if ch >= 0.55:
        return "HIGH"
    # MEDIUM: moderate composite hazard, OR any single hazard has triggered
    #         (any_trigger alone = localised event, not network-wide crisis)
    if ch >= 0.35 or row.get("any_trigger", False):
        return "MEDIUM"
    return "LOW"


for gdf in (nodes_out, edges_out):
    gdf["hazard_natural"]   = gdf[["hazard_flood","hazard_cyclone"]].max(axis=1).round(4)
    gdf["hazard_human"]     = gdf[["hazard_strike","hazard_accident"]].max(axis=1).round(4)
    gdf["composite_hazard"] = _composite_noisy_or(gdf)
    gdf["any_trigger"]      = (gdf["trigger_flood"]    |
                               gdf["trigger_cyclone"]  |
                               gdf["trigger_strike"]   |
                               gdf["trigger_accident"])
    gdf["alert_level"]      = gdf.apply(_alert_level, axis=1)
    gdf["timestamp"]        = TIMESTAMP

info("Node alert distribution:")
info(nodes_out["alert_level"].value_counts().to_string())
info("\nEdge alert distribution:")
info(edges_out["alert_level"].value_counts().to_string())


# ============================================================================
# STEP 7 — EXPORT TO POSTGIS
# ============================================================================
hdr("STEP 7 — EXPORT TO POSTGIS")

NODE_COLS = ["asset_id","node_type","name","lon","lat",
             "hazard_flood","hazard_cyclone","hazard_strike","hazard_accident",
             "hazard_natural","hazard_human",
             "trigger_flood","trigger_cyclone","trigger_strike","trigger_accident",
             "any_trigger","composite_hazard","alert_level","timestamp","geometry"]
EDGE_COLS = ["asset_id","from_node","to_node","mode","road_type",
             "length_km","avg_speed_kmh",
             "hazard_flood","hazard_cyclone","hazard_strike","hazard_accident",
             "hazard_natural","hazard_human",
             "trigger_flood","trigger_cyclone","trigger_strike","trigger_accident",
             "any_trigger","composite_hazard","strike_index",
             "alert_level","timestamp","geometry"]

for col in NODE_COLS:
    if col not in nodes_out.columns and col != "geometry": nodes_out[col] = 0
for col in EDGE_COLS:
    if col not in edges_out.columns and col != "geometry": edges_out[col] = 0

n_exp = nodes_out[[c for c in NODE_COLS if c in nodes_out.columns]].copy()
e_exp = edges_out[[c for c in EDGE_COLS if c in edges_out.columns]].copy()

n_4326 = n_exp.to_crs(4326)
e_4326 = e_exp.to_crs(4326)
write_postgis(n_4326, "hazard_nodes_latest", DB, if_exists="replace")
write_postgis(e_4326, "hazard_edges_latest", DB, if_exists="replace")
write_postgis(n_4326, "hazard_nodes_log",    DB, if_exists="append")
write_postgis(e_4326, "hazard_edges_log",    DB, if_exists="append")
try:
    with DB.connect() as conn:
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_nodes_log_ts "
                          "ON hazard_nodes_log (timestamp)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_edges_log_ts "
                          "ON hazard_edges_log (timestamp)"))
        conn.commit()
    info("[DB] Timestamp indexes ensured")
except Exception as _ie:
    info(f"[DB] Index creation skipped: {_ie}")


# ============================================================================
# STEP 8 — KPI SUMMARY
# ============================================================================
hdr("STEP 8 — KPI SUMMARY")

kpis = {
    "timestamp"               : TIMESTAMP,
    "nlp_method"              : "tfidf_regex_trade_gate_v6.1",
    "sklearn_available"       : SKLEARN_AVAILABLE,
    "weather_cell_resolution" : WEATHER_CELL_RESOLUTION_DEG,
    "open_meteo_endpoint"     : OPEN_METEO_URL,
    "imerg_fallback_enabled"  : ENABLE_IMERG_FALLBACK,
    "hazard_flood_status"     : HAZARD_STATUS["flood"],
    "hazard_cyclone_status"   : HAZARD_STATUS["cyclone"],
    "hazard_strike_status"    : HAZARD_STATUS["strike"],
    "hazard_accident_status"  : HAZARD_STATUS["accident"],
    "total_nodes"             : int(len(n_exp)),
    "total_edges"             : int(len(e_exp)),
    "triggered_nodes"         : int(n_exp["any_trigger"].sum()),
    "triggered_edges"         : int(e_exp["any_trigger"].sum()),
    "critical_nodes"          : int((n_exp["alert_level"] == "CRITICAL").sum()),
    "high_nodes"              : int((n_exp["alert_level"] == "HIGH").sum()),
    "flood_triggered_nodes"   : int(n_exp["trigger_flood"].sum()),
    "cyclone_triggered_nodes" : int(n_exp["trigger_cyclone"].sum()),
    "strike_triggered_nodes"  : int(n_exp["trigger_strike"].sum()),
    "accident_triggered_nodes": int(n_exp["trigger_accident"].sum()),
    "max_composite_hazard"    : float(n_exp["composite_hazard"].max()),
    "avg_composite_hazard"    : float(round(n_exp["composite_hazard"].mean(), 4)),
    "top_risk_asset"          : str(n_exp.loc[n_exp["composite_hazard"].idxmax(),
                                              "name"]) if len(n_exp) else "N/A",
}
try:
    with DB.connect() as conn:
        pd.DataFrame([kpis]).to_sql(
            "kpis_log", conn, if_exists="append", index=False)
        conn.commit()
    info("[DB] kpis_log updated")
except Exception as _ke:
    info(f"[DB] kpis_log write failed: {_ke}")

with open(os.path.join(OUTPUT_DIR, "kpis_latest.json"), "w") as f:
    json.dump(kpis, f, indent=2, default=str)


hdr("SCRIPT 2 COMPLETE")
info(f"Hazard run status         : {HAZARD_STATUS}")
info(f"Weather cell resolution   : {WEATHER_CELL_RESOLUTION_DEG}° "
     f"(~{WEATHER_CELL_RESOLUTION_DEG*111:.2f} km)")
info(f"Open-Meteo endpoint       : {OPEN_METEO_URL}")
info(f"IMERG fallback            : {ENABLE_IMERG_FALLBACK}")
info("Outputs written:")
info("  PostGIS: hazard_nodes_latest, hazard_edges_latest  (replaced each run)")
info("  PostGIS: hazard_nodes_log,    hazard_edges_log     (appended)")
info("  PostGIS: kpis_log                                  (appended)")
info(f"  Audit:   outputs/strike_audit_{TIMESTAMP}.json")
info(f"  Audit:   outputs/accident_audit_{TIMESTAMP}.json")
info("  Sidecar: outputs/kpis_latest.json")