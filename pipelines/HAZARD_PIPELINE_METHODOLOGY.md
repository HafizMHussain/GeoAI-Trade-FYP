# UNIFIED HAZARD PIPELINE METHODOLOGY
## GeoResilience for Ports and Supply Chains — Pakistan

**Version:** 6.1  
**Date:** April 2026  
**Script:** `hazard_model.py`  
**Feeds into:** `risk_engine.py` (Script 3)

---

## TABLE OF CONTENTS

1. [Overview](#1-overview)
2. [Position in the Pipeline](#2-position-in-the-pipeline)
3. [Data Sources](#3-data-sources)
4. [Global Configuration](#4-global-configuration)
5. [Complete Pipeline Flow](#5-complete-pipeline-flow)
6. [Hazard Models — Detailed Breakdown](#6-hazard-models)
   - 6.1 [Flood](#61-flood-hazard-model)
   - 6.2 [Cyclone](#62-cyclone-hazard-model)
   - 6.3 [Strikes](#63-strike-hazard-model)
   - 6.4 [Accidents](#64-accident-hazard-model)
7. [Composite Hazard Index](#7-composite-hazard-index)
8. [Output Schema](#8-output-schema)
9. [NLP Subsystem](#9-nlp-subsystem)
10. [Worked Example](#10-worked-example)
11. [Dashboard Integration](#11-dashboard-integration)
12. [Limitations and Recommendations](#12-limitations-and-recommendations)
13. [Execution Guide](#13-execution-guide)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. OVERVIEW

### What is the Hazard Pipeline?

The Hazard Pipeline is **Script 2** of the GeoResilience platform. It runs on a live, recurring schedule and answers one question for every node and edge in Pakistan's supply-chain transport network:

> **"Right now, what is the probability that this asset is being disrupted by a hazard?"**

It combines **static terrain data** (pre-computed once in QGIS) with **live feeds** from free APIs and news sources to produce hazard scores that are always current.

### What does it produce?

- **4 per-hazard scores** for every node and edge: `hazard_flood`, `hazard_cyclone`, `hazard_strike`, `hazard_accident`
- **4 trigger flags**: `trigger_flood`, `trigger_cyclone`, `trigger_strike`, `trigger_accident`
- **Composite hazard index**: single score aggregated via Noisy-OR
- **Alert level**: CRITICAL / HIGH / MEDIUM / LOW
- **KPI summary**: total triggered assets, top-risk asset, per-hazard counts
- All results written to **PostGIS** (latest state + append log for time-slider)

### The Four Hazards

| Hazard | Type | Data Sources |
|---|---|---|
| Flood | Natural | Static terrain (sf_index) + Open-Meteo rainfall + GDACS flood alerts |
| Cyclone | Natural | GDACS cyclone events + Pakistan EEZ + coastal buffer |
| Strike | Human | GDELT GKG API + RSS news feeds + TF-IDF NLP classifier |
| Accident | Human | RSS news feeds + TF-IDF NLP classifier + Open-Meteo weather |

---

## 2. POSITION IN THE PIPELINE

```
┌─────────────────────────────────────────────────────────────────────┐
│  Script 1: network_model.py                                         │
│  Builds transport graph, computes centrality metrics                │
│  → Writes: network_nodes, network_edges (PostGIS)                   │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│  Script 2: hazard_model.py  ◄ YOU ARE HERE                         │
│  Live hazard scoring for all nodes and edges                        │
│  → Writes: hazard_nodes_latest, hazard_edges_latest (PostGIS)       │
│            hazard_nodes_log, hazard_edges_log (PostGIS, appended)   │
│            kpis_log (PostGIS, appended)                             │
│            kpis_latest.json (file)                                  │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│  Script 3: risk_engine.py                                           │
│  Applies UNDRR Risk = Hazard × Exposure × Vulnerability             │
│  Computes network criticality, chokepoints, scenario simulation     │
│  → Writes: risk_nodes_latest, risk_edges_latest (PostGIS)           │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│  Script 4: Dashboard + LLM API                                      │
│  Web map, KPI panel, time-slider, chatbot                           │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Design Principles

- **DB-first, file fallback:** Every input is read from PostGIS first. If the table is unavailable, the script falls back to a local `.gpkg` or `.csv` file automatically.
- **Idempotent re-runs:** `*_latest` tables are REPLACED each run. `*_log` tables are APPENDED, building the historical record for the dashboard time-slider.
- **Modular hazard functions:** Each hazard runs in its own isolated function (`run_flood`, `run_cyclone`, `run_strikes`, `run_accidents`) on independent copies of the GeoDataFrames. No cross-contamination.
- **All free sources:** No paid APIs. Open-Meteo, GDACS, GDELT, RSS feeds, NASA IMERG (free Earthdata login).

---

## 3. DATA SOURCES

| Source | Type | Update Frequency | Used By |
|---|---|---|---|
| PostGIS `network_nodes` / `network_edges` | Internal DB | Re-run of Script 1 | All hazards — base asset layer |
| `sf_index` columns (roads, railways, ports, stations) | Internal DB | Static (one-time QGIS pre-processing) | Flood — Static Flood Index |
| Open-Meteo `/v1/forecast` | Free REST API | Every 30 min | Flood — live rainfall; Accident — wind speed and visibility |
| NASA IMERG | Free FTP (requires `~/.netrc`) | Every 30 min | Flood — fallback rainfall when Open-Meteo returns zero |
| GDACS RSS `gdacs.org/xml/rss.xml` | Free RSS/XML | ~15 min | Flood — national alert flag; Cyclone — event list, position, intensity |
| Pakistan EEZ / Coastline `.gpkg` | Local file or PostGIS | Static | Cyclone — defines the 50 km coastal exposure zone |
| GDELT GKG API | Free REST | ~15 min | Strikes — trade-disruption event detection |
| RSS news feeds (Dawn, Geo, ARY, Express, Tribune, etc.) | Free RSS/XML | ~10–15 min | Strikes and Accidents — NLP event extraction |
| `Pakistan_Centeroids.csv` | Local CSV in `data/` | Static | Strikes and Accidents — city-name → lat/lon geocoding |

---

## 4. GLOBAL CONFIGURATION

All parameters are defined in the `CONFIGURATION` block at the top of `hazard_model.py` and can be tuned without touching the core logic.

```python
# Weather cell resolution (groups asset centroids into spatial cells)
WEATHER_CELL_RESOLUTION_DEG = 0.01   # ~1.1 km cells

# Fallback to NASA IMERG if Open-Meteo returns zero rain everywhere
ENABLE_IMERG_FALLBACK = True

# Composite hazard weights (applied before Noisy-OR aggregation)
COMPOSITE_WEIGHTS = {
    "hazard_flood"   : 1.00,
    "hazard_cyclone" : 1.00,
    "hazard_strike"  : 0.90,  # Human hazards discounted slightly
    "hazard_accident": 0.80,  # for lower certainty in NLP-derived severity
}

# Dryports are inland/elevated — zero flood hazard
DRYPORT_FLOOD_DAMPENING = 0.0

# Trigger thresholds (set trigger flag = True above this score)
TRIGGER_FLOOD    = 0.60
TRIGGER_CYCLONE  = 0.60
TRIGGER_STRIKE   = 0.60
TRIGGER_ACCIDENT = 0.60

# NLP thresholds (minimum TF-IDF cosine similarity to classify article)
TFIDF_THRESHOLD_STRIKE   = 0.12
TFIDF_THRESHOLD_ACCIDENT = 0.12

# Max age of RSS articles before they are discarded
RSS_MAX_AGE_HOURS = 48

# Cyclone distance decay scale
CYCLONE_DECAY_SCALE_KM = 150.0
```

---

## 5. COMPLETE PIPELINE FLOW

```
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 1: Load Nodes + Edges from PostGIS                             │
│ Re-project to EPSG:3857 (metres) for distance calculations          │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 2: Load Static Flood Index (sf_index)                          │
│ Join from source geometry tables by asset_id                        │
│ Propagate to access links via spatial nearest-join (≤5 000 m)       │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 3: Load City Lookup + Build NLP Classifiers                    │
│ Fit TF-IDF vectorizers on Strike and Accident seed corpora          │
│ Cache to disk to avoid re-fitting on every run                      │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 4: Run All Four Hazard Models in Sequence                      │
│                                                                     │
│   run_flood()     → nodes with hazard_flood, trigger_flood          │
│   run_cyclone()   → nodes with hazard_cyclone, trigger_cyclone      │
│   run_strikes()   → nodes with hazard_strike, trigger_strike        │
│   run_accidents() → nodes with hazard_accident, trigger_accident    │
│                                                                     │
│   Each function receives independent copies of the base GDFs        │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 5: Merge Hazard Columns                                        │
│ Left-join all four hazard outputs back onto single GeoDataFrame     │
│ Missing values filled with 0                                        │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 6: Composite Hazard (Noisy-OR)                                 │
│ hazard_natural  = max(flood, cyclone)                               │
│ hazard_human    = max(strike, accident)                             │
│ composite_hazard = 1 − Π(1 − hazard_i × weight_i)                  │
│ alert_level     = CRITICAL / HIGH / MEDIUM / LOW                    │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 7: Export to PostGIS                                           │
│ hazard_*_latest   (REPLACE — consumed by Script 3 + dashboard)      │
│ hazard_*_log      (APPEND — time-slider history)                    │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 8: KPI Summary                                                 │
│ Write kpis_log to PostGIS + kpis_latest.json to file                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. HAZARD MODELS

---

### 6.1 Flood Hazard Model

**`run_flood(nodes_gdf, edges_gdf)`**

Flood is modelled as a combination of **static terrain susceptibility** and **live rainfall intensity**. It is the only hazard with a pre-computed static component.

> **Rule:** Dry ports receive `hazard_flood = 0.0` regardless of terrain or rainfall. They are inland, elevated facilities not susceptible to river/coastal flooding.

#### Sub-Component A — Static Flood Index (sf_index)

Pre-computed in QGIS from two terrain inputs:

```
River Distance Index:
  Extracted major Pakistani rivers from HydroSheds (by Strahler order + flow)
  Converted to rasters → computed distance rasters
  Sampled distance values to every asset centroid
  Closer to river → higher index

Elevation Index:
  SRTM 10 m DEM sampled to every asset centroid
  Lower elevation → higher index

sf_index = combined(river_distance_index, elevation_index)
         = static flood susceptibility ∈ [0, 1]
```

This value is **loaded from PostGIS** at the start of every run (it does not change unless the terrain preprocessing is re-run).

#### Sub-Component B — Live Rainfall Index (rain_index)

```python
rain_index = min(precipitation_mm / 10.0, 1.0)

# Precipitation from Open-Meteo /v1/forecast
# Aggregated by 0.01° spatial cells to reduce API calls
# 10 mm/hr → rain_index = 1.0 (saturation point)
```

#### Sub-Component C — GDACS Flood Alert Boost

If the GDACS global RSS feed reports a flood event in Pakistan:

```python
rain_index += 0.20   # boost for official national disaster declaration
rain_index = clip(rain_index, 0, 1)
```

#### Combined Flood Hazard (Noisy-OR)

The static and live components are merged. Each is weighted by its reliability coefficient before combining:

```
SF_COEF   = 0.90   (terrain data is high quality)
RAIN_COEF = 0.80   (API rainfall has some uncertainty)

sf_scaled   = clip(sf_index × 0.90, 0, 1)
rain_scaled = clip(rain_index × 0.80, 0, 1)

hazard_flood = clip(1 − (1 − sf_scaled)(1 − rain_scaled), 0, 1)
```

#### Flood Trigger

```
trigger_flood = (hazard_flood ≥ 0.60)
```

---

### 6.2 Cyclone Hazard Model

**`run_cyclone(nodes_gdf, edges_gdf)`**

Cyclones only threaten assets within Pakistan's **50 km coastal exposure zone**. Assets outside this zone receive `hazard_cyclone = 0.0` regardless of any cyclone activity.

#### Coastal Exposure Zone

```
- 50 km buffer drawn around Pakistan's coastline
- Clipped to Pakistan's territory
- Pakistan EEZ boundary also loaded
- Asset flagged as coastal_exposed = True if centroid falls within buffer
```

#### GDACS Cyclone Ingestion

Live cyclone data fetched from GDACS RSS. For each active cyclone:

```
Attributes extracted:
  - Position (lat/lon) at fetch time
  - Maximum sustained wind speed (knots)
  - GLIDE number (event ID)
  - Whether cyclone centre is inside Pakistan's EEZ
```

#### Category-Based Base Intensity

Wind speed converted to base intensity using Saffir-Simpson-derived breakpoints:

| Wind Speed (knots) | Category | Base Intensity |
|---|---|---|
| < 63 | Tropical Depression | 0.10 |
| 63–88 | Tropical Storm | 0.30 |
| 89–116 | Category 1 | 0.55 |
| 117–152 | Category 2 | 0.70 |
| 153–176 | Category 3 | 0.85 |
| 177–207 | Category 4 | 0.95 |
| ≥ 208 | Category 5 | 1.00 |

#### Distance Decay

Intensity attenuates with distance from the cyclone centre using exponential decay:

```
hazard_cyclone = base_intensity × exp(−distance_km / 150)

CYCLONE_DECAY_SCALE_KM = 150
  → At 150 km from centre, intensity drops to ~37% of base
  → At 300 km from centre, intensity drops to ~14% of base
```

#### EEZ Amplification

If the cyclone is inside Pakistan's EEZ AND the asset is in the coastal zone:

```
hazard_cyclone = clip(hazard_cyclone × 1.20, 0, 1)
  → 20% boost to reflect elevated threat from cyclone in national waters
```

#### Cyclone Trigger

```
trigger_cyclone = (hazard_cyclone ≥ 0.60)
```

---

### 6.3 Strike Hazard Model

**`run_strikes(nodes_gdf, edges_gdf)`**

Detects trade-disrupting civil disturbances from news and event feeds using a **two-stage NLP pipeline**. Relevant event types include: shutter-down strikes, wheel-jam strikes, road blockades, border closures, port shutdowns, political city-wide shutdowns.

#### Stage 1 — Event Ingestion

Two sources are queried in parallel:

```
1. GDELT GKG API
   - Queries for events with QuadClass = 4 (Conflict/Protest)
   - Returns article metadata and location codes

2. RSS News Feeds (8+ Pakistani outlets)
   - Dawn, Geo, ARY, Express, The News, Tribune, Nation, Radio Pakistan
   - Articles older than 48 hours are discarded
```

#### Stage 2A — Trade-Keyword Gate

Every headline and description is tested against a compiled regex of ~50 trade-relevant terms:

```
Physical network:  freight, cargo, container, motorway, railway, port, terminal
Trade admin:       customs, border, import, export, sanction, wagah, torkham
Explicit blockage: road blocked, road closed, traffic halted, traffic standstill
```

**If an article does not mention any trade term, it is rejected before NLP classification.**  
This is the most important filter — it eliminates the majority of irrelevant noise.

#### Stage 2B — TF-IDF Cosine Similarity

Articles that pass the trade gate are scored against a **TF-IDF centroid** built from 20 seed sentences describing supply-chain strikes in Pakistan:

```python
vectorizer = TfidfVectorizer(ngram_range=(1,2), sublinear_tf=True)
vectorizer.fit(STRIKE_SEEDS)  # 20 curated seed sentences

cosine_score = cosine_similarity(article_vector, seed_centroid)

# Article is relevant if:
is_relevant = passes_trade_gate AND (cosine_score >= 0.12)
```

> **Caching:** The fitted vectorizer and centroid are cached to `outputs/tfidf_cache.pkl` using an MD5 hash of the seed corpus. Subsequent runs load from cache — no re-fitting required.

#### Severity Scoring

For each relevant article, a keyword-weighted severity score is computed:

```
STRIKE_SEVERITY_WEIGHTS (selected examples):
  "border closed"          → 0.70
  "port operations halted" → 0.65
  "trade ban"              → 0.70
  "wheel-jam"              → 0.55
  "nationwide"             → 0.60
  "road blocked"           → 0.30
  "protest"                → 0.15

IRRELEVANT PENALTIES:
  "hospital"               → −0.20
  "cricket"                → −0.30
  "wedding"                → −0.20

severity = clip(NoisyOR(matched_weights) + sum(penalties), 0, 1)
```

#### City Geocoding and Spatial Assignment

A regex pattern built from `Pakistan_Centeroids.csv` extracts city names from the article text and maps them to lat/lon coordinates. National-scope events (containing "nationwide", "across Pakistan", "all cities") are assigned to **all** assets.

Each relevant event is spatially buffered. Assets within the buffer receive a distance-decayed hazard contribution:

```
distance_probability = exp(−distance_m / buffer_radius_m)
hazard_contribution  = severity × distance_probability

# Multiple events combined via Noisy-OR:
hazard_strike = NoisyOR(all hazard_contributions for this asset)
```

#### Strike Index on Edges

A separate `strike_index` column is computed for edges using road type importance weights:

```
port_road : 1.00    motorway : 0.90    railway : 0.75
trunk     : 0.70    primary  : 0.40    unknown : 0.20
```

This is used downstream in the risk engine's edge exposure calculation.

#### Strike Trigger

```
trigger_strike = (hazard_strike ≥ 0.60)
```

---

### 6.4 Accident Hazard Model

**`run_accidents(nodes_gdf, edges_gdf)`**

Detects significant freight-transport accidents (truck overturns, rail derailments, tanker explosions, motorway pile-ups) using the same two-stage NLP pipeline as strikes, plus a **weather-augmented risk component**.

#### NLP Pipeline (Same as Strikes, Different Corpus)

```
Trade gate → same regex pattern as strikes
TF-IDF     → separate vectorizer fitted on ACCIDENT_SEEDS (20 sentences)
             e.g. "container truck overturns motorway road blocked hours"
                  "freight train derailment railway track closed"
                  "M-9 karachi hyderabad motorway accident closed"
Threshold  → cosine_score ≥ 0.12
```

#### Road Type Classification

Each relevant article's road type is extracted:

| Road Type | Buffer Radius | Importance Weight |
|---|---|---|
| port_road | 5 000 m | 1.00 |
| motorway | 8 000 m | 0.90 |
| railway | 5 000 m | 0.75 |
| trunk | 6 000 m | 0.70 |
| primary | 4 000 m | 0.40 |
| unknown | 3 000 m | 0.20 |

Larger buffers for higher-importance roads reflect the wider spatial impact of an incident on a major motorway vs a local road.

#### Accident Risk Index

```
accident_risk_index = severity × distance_probability × road_importance
hazard_accident_news = NoisyOR(all accident_risk_index values for this asset)
```

#### Weather-Augmented Accident Risk

Open-Meteo wind speed and visibility values are used to compute an independent weather risk factor:

```
wind_factor        = clip(wind_speed_kmh / 80.0, 0, 1)
visibility_factor  = clip(1 − visibility_m / 5000.0, 0, 1)
weather_risk       = NoisyOR(wind_factor, visibility_factor)
```

The weather risk is combined with the news-derived accident hazard:

```
hazard_accident = NoisyOR(hazard_accident_news, weather_risk × 0.40)
```

> The weather contribution is capped at weight 0.40 so that adverse weather supplements the news signal rather than dominating it. This avoids overpenalising assets on windy days when no accidents have actually occurred.

#### Accident Trigger

```
trigger_accident = (hazard_accident ≥ 0.60)
```

---

## 7. COMPOSITE HAZARD INDEX

### Natural vs Human Split

Before combining all four hazards, two sub-composites are derived:

```
hazard_natural = max(hazard_flood, hazard_cyclone)
hazard_human   = max(hazard_strike, hazard_accident)
```

### Noisy-OR Aggregation

The four per-hazard scores are combined into a single `composite_hazard` using the **Noisy-OR probability model**. Each input is weighted by `COMPOSITE_WEIGHTS` and clipped to a maximum of 0.95 (no single hazard can deterministically force composite = 1.0):

```
p_no_harm = Π_{i} (1 − clip(hazard_i × weight_i, 0, 0.95))
composite_hazard = 1 − p_no_harm

Expanded:
p_no_harm = (1 − clip(hazard_flood    × 1.00, 0, 0.95))
          × (1 − clip(hazard_cyclone  × 1.00, 0, 0.95))
          × (1 − clip(hazard_strike   × 0.90, 0, 0.95))
          × (1 − clip(hazard_accident × 0.80, 0, 0.95))
```

**Why Noisy-OR instead of simple average?**  
Simple averaging (`mean(flood, cyclone, strike, accident)`) underestimates combined risk when multiple hazards are simultaneously present. Noisy-OR correctly models probabilistic independence: if two separate events each have a 50% chance of disruption, the combined probability of at least one disruption is 75%, not 50%.

### Alert Level Classification

```
CRITICAL  →  composite_hazard ≥ 0.75
              OR (trigger_flood = True AND hazard_flood > 0.75)

HIGH      →  composite_hazard ≥ 0.50
              OR any_trigger = True

MEDIUM    →  composite_hazard ≥ 0.30

LOW       →  composite_hazard < 0.30 and no triggers
```

---

## 8. OUTPUT SCHEMA

### PostGIS Tables Written Per Run

| Table | Mode | Purpose |
|---|---|---|
| `hazard_nodes_latest` | REPLACE | Latest node hazard scores — consumed by Script 3 and dashboard live layer |
| `hazard_edges_latest` | REPLACE | Latest edge hazard scores |
| `hazard_nodes_log` | APPEND | Historical record — enables dashboard time-slider |
| `hazard_edges_log` | APPEND | Historical edge records |
| `kpis_log` | APPEND | Scalar KPIs per run — for KPI panel time series |

### Node Column Schema

| Column | Type | Description |
|---|---|---|
| `asset_id` | string | Unique identifier linking to network graph |
| `node_type` | string | port / dryport / rail_station / road_intersection / rail_intersection |
| `hazard_flood` | float [0,1] | Live flood hazard score |
| `hazard_cyclone` | float [0,1] | Live cyclone hazard score |
| `hazard_strike` | float [0,1] | Live strike hazard score |
| `hazard_accident` | float [0,1] | Live accident hazard score |
| `hazard_natural` | float [0,1] | max(flood, cyclone) |
| `hazard_human` | float [0,1] | max(strike, accident) |
| `trigger_flood` | boolean | Flood threshold exceeded |
| `trigger_cyclone` | boolean | Cyclone threshold exceeded |
| `trigger_strike` | boolean | Strike threshold exceeded |
| `trigger_accident` | boolean | Accident threshold exceeded |
| `any_trigger` | boolean | Any of the above is True |
| `composite_hazard` | float [0,1] | Noisy-OR composite score |
| `alert_level` | string | CRITICAL / HIGH / MEDIUM / LOW |
| `timestamp` | string | Run timestamp (YYYYMMDD_HHMM UTC) |
| `geometry` | Point | Asset centroid, EPSG:4326 |

### Edge Additional Column

| Column | Type | Description |
|---|---|---|
| `strike_index` | float [0,1] | Road-type-weighted strike susceptibility, used in Script 3 edge exposure |

### KPI JSON Structure

```json
{
  "timestamp": "20260421_1430",
  "nlp_method": "tfidf_regex_trade_gate_v6.1",
  "hazard_flood_status": "OK",
  "hazard_cyclone_status": "OK",
  "hazard_strike_status": "OK",
  "hazard_accident_status": "OK",
  "total_nodes": 1245,
  "total_edges": 2890,
  "triggered_nodes": 34,
  "triggered_edges": 89,
  "critical_nodes": 5,
  "high_nodes": 17,
  "flood_triggered_nodes": 22,
  "cyclone_triggered_nodes": 3,
  "strike_triggered_nodes": 9,
  "accident_triggered_nodes": 12,
  "max_composite_hazard": 0.8421,
  "avg_composite_hazard": 0.1183,
  "top_risk_asset": "Karachi Port"
}
```

---

## 9. NLP SUBSYSTEM

The NLP subsystem is shared between the Strike and Accident hazard models. It is implemented as the `LocalNLPClassifier` class.

### Architecture

```
                    RSS / GDELT articles
                           ↓
              ┌─────────────────────────┐
              │   Trade-Keyword Gate    │  ← Regex, ~50 terms
              │   (pre-filter)          │  Fast, kills most noise
              └────────────┬────────────┘
                           ↓ (passes gate)
              ┌─────────────────────────┐
              │  TF-IDF Classifier      │  ← cosine similarity
              │  Strike  │  Accident    │     vs seed centroid
              └────────────┬────────────┘
                           ↓ (score ≥ 0.12)
              ┌─────────────────────────┐
              │  Severity Scoring       │  ← keyword weights
              │  + Penalty Terms        │     + noisy-OR
              └────────────┬────────────┘
                           ↓
              ┌─────────────────────────┐
              │  City Geocoding         │  ← regex + CSV lookup
              └────────────┬────────────┘
                           ↓
              ┌─────────────────────────┐
              │  Spatial Buffer         │  ← buffer + sjoin
              │  Assignment to Assets   │     distance decay
              └─────────────────────────┘
```

### Seed Corpus (Strike — selected examples)

```
"karachi port wheel jam strike operations halted containers stuck"
"transport dharna blockade national highway trucks freight stuck"
"border closed wagah torkham trade suspended trucks cargo stuck"
"countrywide wheel jam motorway national highway freight standstill"
"chaman border closed afghanistan trade halted trucks stuck"
```

### Seed Corpus (Accident — selected examples)

```
"container truck overturns motorway road blocked hours"
"freight train derailment railway track closed"
"M-9 karachi hyderabad motorway accident closed"
"M-2 lahore islamabad motorway truck accident blocked"
"goods train collides track blocked lahore karachi"
```

### TF-IDF Cache

On first run, the vectorizers are fitted and saved:

```
outputs/tfidf_cache.pkl
  Contains: vec_strike, vec_accident, seed centroids, seed_hash (MD5)

On subsequent runs: loaded from cache if hash matches
  → Eliminates re-fitting cost (~3–5 seconds saved per run)
  → Cache invalidated automatically if seed corpus changes
```

---

## 10. WORKED EXAMPLE

### Asset: Karachi Port Node

**Input values (current run):**

```
sf_index          = 0.55  (close to river, low elevation)
precipitation_mm  = 8.0   (heavy rainfall event)
gdacs_flood_alert = True  (Pakistan flood event active on GDACS)
cyclone present   = No active cyclone in GDACS
strike events     = 1 relevant article: "Karachi port wheel-jam strike, operations halted"
accident events   = 0 relevant articles
```

---

**Step 1: Flood Hazard**

```
rain_index  = min(8.0 / 10.0, 1.0) = 0.80
rain_index += 0.20 (GDACS boost)   = 1.00 → clipped to 1.00

sf_scaled   = clip(0.55 × 0.90, 0, 1) = 0.495
rain_scaled = clip(1.00 × 0.80, 0, 1) = 0.80

hazard_flood = 1 − (1 − 0.495)(1 − 0.80)
             = 1 − (0.505)(0.20)
             = 1 − 0.101
             = 0.899

trigger_flood = (0.899 ≥ 0.60) → True
```

---

**Step 2: Cyclone Hazard**

```
No active GDACS cyclone → hazard_cyclone = 0.0
trigger_cyclone = False
```

---

**Step 3: Strike Hazard**

```
Article: "Karachi port wheel-jam strike, operations halted"
  passes_trade_gate = True  (contains "port", "freight")
  tfidf_score = 0.47        (well above 0.12 threshold)
  is_relevant = True

Severity keywords matched:
  "port operations halted" → 0.65
  "wheel-jam"              → 0.55
  severity = NoisyOR(0.65, 0.55) = 1 − (0.35)(0.45) = 0.843

City extracted: "Karachi" → lat=24.86, lon=67.01
Distance to Karachi Port centroid ≈ 1 200 m
buffer_radius = 5 000 m (port_road type)

distance_probability = exp(−1200 / 5000) = 0.787
hazard_contribution  = 0.843 × 0.787     = 0.663

hazard_strike = 0.663
trigger_strike = (0.663 ≥ 0.60) → True
```

---

**Step 4: Accident Hazard**

```
No relevant accident articles found
wind_speed = 12 km/h → wind_factor = 12/80 = 0.15
visibility = 8 000 m → visibility_factor = 1 − 8000/5000 → clipped to 0.0

weather_risk = NoisyOR(0.15, 0.0) = 0.15
hazard_accident = NoisyOR(0.0, 0.15 × 0.40) = NoisyOR(0.0, 0.06) = 0.06

trigger_accident = (0.06 ≥ 0.60) → False
```

---

**Step 5: Composite Hazard**

```
p_no_harm = (1 − clip(0.899 × 1.00, 0, 0.95))
          × (1 − clip(0.000 × 1.00, 0, 0.95))
          × (1 − clip(0.663 × 0.90, 0, 0.95))
          × (1 − clip(0.060 × 0.80, 0, 0.95))

          = (1 − 0.899) × (1 − 0.0) × (1 − 0.597) × (1 − 0.048)
          = (0.101)     × (1.000)   × (0.403)      × (0.952)
          = 0.0387

composite_hazard = 1 − 0.0387 = 0.961
```

---

**Step 6: Alert Level**

```
composite_hazard = 0.961 ≥ 0.75  → CRITICAL

any_trigger = trigger_flood (True) OR trigger_strike (True) = True

FINAL ALERT LEVEL: CRITICAL
```

---

## 11. DASHBOARD INTEGRATION

### Files and Tables for the Dashboard

```
PostGIS Tables:
  hazard_nodes_latest    → Live map layer (node colours, tooltips)
  hazard_edges_latest    → Live map layer (edge colours)
  hazard_nodes_log       → Time-slider (historical states)
  hazard_edges_log       → Time-slider (historical states)
  kpis_log               → KPI panel time series chart

File Output:
  outputs/kpis_latest.json   → Dashboard KPI panel (latest snapshot)
```

### Map Styling (Mapbox / Leaflet)

**Alert Level colours (consistent with Risk Engine):**

```
CRITICAL : #D32F2F  (Red)
HIGH     : #FF9800  (Orange)
MEDIUM   : #FFC107  (Yellow)
LOW      : #4CAF50  (Green)
```

**Trigger indicators:**  
Assets with `any_trigger = True` should display a flashing/pulsing outline or warning icon on the map.

**Separate hazard layers:**  
The dashboard should provide toggleable layers for each individual hazard:
- Flood layer → colour by `hazard_flood`
- Cyclone layer → colour by `hazard_cyclone`
- Strike layer → colour by `hazard_strike`
- Accident layer → colour by `hazard_accident`
- Composite layer → colour by `composite_hazard` / `alert_level`

### KPI Panel Widgets

| KPI Widget | Source Column / Field |
|---|---|
| Total triggered nodes today | `triggered_nodes` in kpis_log |
| Critical asset count | `critical_nodes` in kpis_log |
| Highest-risk asset name | `top_risk_asset` in kpis_log |
| Flood trigger count | `flood_triggered_nodes` in kpis_log |
| Strike trigger count | `strike_triggered_nodes` in kpis_log |
| Avg composite hazard | `avg_composite_hazard` in kpis_log |
| Hazard module status | `hazard_*_status` in kpis_log |

### Time Slider

The `hazard_nodes_log` and `hazard_edges_log` tables are indexed on `timestamp`. The dashboard time-slider queries:

```sql
SELECT * FROM hazard_nodes_log WHERE timestamp = '20260421_1400';
```

Each run appends a full snapshot, enabling the user to replay any historical hazard state.

---

## 12. LIMITATIONS AND RECOMMENDATIONS

### Current Limitations

| Limitation | Impact |
|---|---|
| City-level NLP geocoding | Strike and accident events are assigned to city centroids, not exact incident coordinates. Sub-city spatial accuracy is not achievable with free sources. |
| No AIS vessel data | Port stress from vessel congestion is not modelled. A port backlogged with ships has elevated operational risk not reflected in the current hazard scores. |
| IMERG requires ~/.netrc | NASA Earthdata credentials must be configured manually on new deployments. Script warns and skips if absent. |
| No historical normalisation | A `hazard_flood = 0.45` score has no context — is this high or normal for this asset? Without baseline stats, interpretation is relative rather than absolute. |
| Weather accidents use Open-Meteo indirectly | Direct PMD (Pakistan Meteorological Department) weather warning feeds would give more Pakistan-specific accuracy without additional API limits. |
| Pakistan_Centeroids.csv coverage | Towns not in the CSV are missed by the city geocoder. Events from smaller towns are either dropped or misassigned to the nearest matched city. |

### Recommendations

1. **Add AIS vessel data** (AISHub free tier) — compute a `port_stress_index` from vessel count, ETA density, and container terminal occupancy. Add as a 5th hazard with weight 0.70 (ports only).

2. **Add PMD RSS feeds** — Pakistan Meteorological Department publishes weather warnings via RSS. Replace or supplement the Open-Meteo weather_risk component with structured PMD cyclone/flood warnings.

3. **Expand Pakistan_Centeroids.csv** — Add tehsil-level administrative centroids (available from OCHA Pakistan HDX portal) to improve NLP geocoding from ~500 cities to ~5 000 settlement points.

4. **Rolling z-score normalisation** — Compute rolling mean and standard deviation from `hazard_*_log` over a configurable window (e.g., 90 days). Express current score as standard deviations above the historical mean, giving the dashboard a "2.3σ above normal" reading that is far more informative than a raw 0–1 score.

5. **Scheduled cron job** — Configure `hazard_model.py` to run every 30 minutes as a systemd service or cron task. Expose `kpis_latest.json` via a FastAPI endpoint for the dashboard.

6. **Compound scenario integration** — Pass the live `hazard_*` columns from this script as inputs to the ScenarioEngine in Script 3, enabling "what-if under current live hazard conditions" scenarios rather than only static scenario runs.

---

## 13. EXECUTION GUIDE

### Prerequisites

| Requirement | Install Command |
|---|---|
| Python ≥ 3.9 | — |
| geopandas, shapely | `pip install geopandas shapely` |
| pandas, numpy | `pip install pandas numpy` |
| requests, beautifulsoup4, lxml | `pip install requests beautifulsoup4 lxml` |
| sqlalchemy, psycopg2-binary | `pip install sqlalchemy psycopg2-binary` |
| scikit-learn | `pip install scikit-learn` *(optional but strongly recommended)* |
| PostGIS ≥ 3.0 | PostgreSQL + PostGIS extension |
| `~/.netrc` | NASA Earthdata credentials (IMERG fallback only) |

### Required Files in `data/`

```
data/
├── Pakistan_Centeroids.csv     # city, lat, lon columns required
├── pakistan_eez.gpkg           # EEZ boundary (fallback if PostGIS unavailable)
└── coast_buffer.gpkg           # 50 km coastal buffer (fallback)
```

### Run Order

```bash
# Step 1: Build the network (must run before hazard model)
python network_model.py

# Step 2: Run hazard pipeline
python hazard_model.py

# Step 3: Run risk engine
python risk_engine.py
```

### First-Run Behaviour

On the first execution, the TF-IDF models are fitted and cached:

```
[NLP] TF-IDF fitted and cached (hash=a3f7c9b12d04)
→ outputs/tfidf_cache.pkl written
```

Subsequent runs load from cache and skip fitting — typically ~5 seconds faster per run.

---

## 14. TROUBLESHOOTING

### "RuntimeError: network_nodes / network_edges missing"

**Cause:** Script 1 has not been run, or PostGIS connection credentials are wrong.  
**Fix:** Run `network_model.py` first. Verify `DB_HOST`, `DB_USER`, `DB_PASS` in the config block.

---

### "sf_index empty — flood will be rain-only"

**Cause:** The source geometry tables (`roads`, `railways`, `ports`, `stations`) in PostGIS do not have an `sf_index` column.  
**Fix:** Run the QGIS/Python pre-processing workflow to sample river distance and elevation rasters to assets and compute `sf_index`. Add the column to the PostGIS tables and re-run Script 1.

---

### "permission denied for table pakistan_eez"

**Cause:** The `fyp_user` PostGIS role does not have SELECT permission on `pakistan_eez`.  
**Fix (v6.1):** The script automatically falls back to `data/pakistan_eez.gpkg`. Ensure the file exists. Grant permissions later if needed: `GRANT SELECT ON pakistan_eez TO fyp_user;`

---

### "Open-Meteo returned zero rain everywhere"

**Cause:** Dry season (no rainfall), or transient Open-Meteo API outage.  
**Behaviour:** Script automatically attempts IMERG fallback if `ENABLE_IMERG_FALLBACK = True`.  
**Fix if both fail:** Check `~/.netrc` credentials. Flood hazard will be sf_index-only until APIs recover.

---

### "[NLP] scikit-learn not installed"

**Cause:** scikit-learn not in the Python environment.  
**Impact:** TF-IDF classification is disabled. Only the regex trade-keyword gate runs, which has lower precision.  
**Fix:** `pip install scikit-learn`

---

### "All hazard_strike / hazard_accident values are 0.0"

**Causes and checks:**
```
1. No RSS articles passed the 48-hour age filter
   → Check system clock is correct (UTC)
   → Try setting RSS_ACCEPT_UNDATED = True temporarily

2. Trade-keyword gate is too strict
   → Lower TFIDF_THRESHOLD_STRIKE to 0.08 for testing

3. Pakistan_Centeroids.csv missing or has wrong column names
   → Script requires columns: city, lat, lon (case-insensitive)

4. All news items are about non-trade topics
   → Check RSS feeds are returning current Pakistani news
```

---

### "Scenario engine crashes with KeyError on asset_id"

**Cause:** The `scenario_engine.pkl` was built with a different run's data and the `asset_id` you are querying no longer exists.  
**Fix:** Re-run `risk_engine.py` to rebuild `scenario_engine.pkl` from the current PostGIS data.

---

## SUMMARY

The Unified Hazard Pipeline implements a **live, multi-source, multi-hazard scoring system** for Pakistan's supply-chain transport network. It combines:

- **Static terrain analysis** (pre-computed sf_index from HydroSheds and SRTM)
- **Live weather data** (Open-Meteo, NASA IMERG fallback)
- **Official disaster alerts** (GDACS flood and cyclone feeds)
- **NLP event extraction** (GDELT + RSS + TF-IDF + trade-keyword gate)
- **Probabilistic aggregation** (Noisy-OR composite hazard)

All outputs are dashboard-ready, LLM-consumable, and feed directly into the Risk Engine (Script 3) for the full `Hazard × Exposure × Vulnerability` risk calculation.

**Next Steps:**
1. Run `hazard_model.py` and verify `kpis_latest.json` shows OK status for all four hazards
2. Open PostGIS and inspect `hazard_nodes_latest` — check `alert_level` distribution
3. Visualise in QGIS using the alert-level colour scheme above
4. Run `risk_engine.py` to compute full risk scores
5. Integrate `hazard_nodes_log` into the dashboard time-slider
6. Connect the LLM chatbot to `kpis_latest.json` for natural language hazard queries

---

**End of Methodology Document**
