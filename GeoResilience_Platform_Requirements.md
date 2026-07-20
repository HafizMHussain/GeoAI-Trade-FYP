# GeoResilience for Ports & Supply Chains — Risk Intelligence Platform
## Complete Dashboard & Integration Requirements
### Pakistan FYP — Technical Specification v1.0 | April 2026

---

# TABLE OF CONTENTS

1. [End-to-End Pipeline & Data Flow](#1-end-to-end-pipeline--data-flow)
2. [All External Dependencies, APIs & Services](#2-all-external-dependencies-apis--services)
3. [Dashboard Modules & Features](#3-dashboard-modules--features)
4. [LLM Chatbot Integration](#4-llm-chatbot-integration)
5. [Hosting, Scheduling & Deployment](#5-hosting-scheduling--deployment)
6. [Complete Map Layer Inventory](#6-complete-map-layer-inventory)
7. [First-Time Setup Checklist](#7-first-time-setup-checklist)
8. [Complete PostGIS Table Reference](#8-complete-postgis-table-reference)
9. [Common Integration Pitfalls & Solutions](#9-common-integration-pitfalls--solutions)
10. [Final Platform Completeness Checklist](#10-final-platform-completeness-checklist)

---

# 1. End-to-End Pipeline & Data Flow

## 1.1 Script Execution Order (Mandatory)

```
1. network_model.py         →  Builds the multimodal transport graph
2. hazard_model.py          →  Live hazard scoring (flood, cyclone, strike, accident)
3. risk_engine.py           →  UNDRR Risk = Hazard × Exposure × Vulnerability
4. ais_port_stress.py       →  Real-time vessel tracking & port stress index
5. scenario_simulation.py  →  What-if disruption simulations (run last)
```

> **Every downstream script depends on all prior scripts. Never skip a step.**

---

## 1.2 File & Database Output Map

| Script | PostGIS Tables Written | Files Written | Consumed By |
|---|---|---|---|
| `network_model.py` | `ports`, `dryports`, `stations`, `roads`, `railways`, `network_nodes`, `network_edges`, `baseline_node_metrics`, `baseline_edge_metrics`, `baseline_shortest_paths`, `baseline_global_metrics` | `nodes.gpkg`, `edges.gpkg`, `nodes_attributed.csv`, `edges_attributed.csv`, `baseline_*.csv`, `graph_baseline.gpickle` | ALL downstream scripts |
| `hazard_model.py` | `hazard_nodes_latest`, `hazard_edges_latest`, `hazard_nodes_log`, `hazard_edges_log`, `kpis_log` | `kpis_latest.json`, `strike_audit_*.json`, `accident_audit_*.json`, `tfidf_cache.pkl` | `risk_engine.py`, dashboard live map |
| `risk_engine.py` | `risk_nodes_latest`, `risk_edges_latest`, `risk_nodes_log`, `risk_edges_log`, `risk_kpis_log` | `risk_nodes_latest.gpkg/.csv`, `risk_edges_latest.gpkg/.csv`, `risk_summary.json`, `scenario_engine.pkl` | `scenario_simulation.py`, dashboard, LLM API |
| `ais_port_stress.py` | `port_stress_latest`, `port_stress_log`, `vessel_positions_latest`, `vessel_positions_log`, `arrivals_schedule_24h` + updates `risk_nodes_latest` (PSI columns) | `port_stress_latest.csv/.gpkg`, `vessel_positions_latest.gpkg`, `arrivals_24h.csv`, `ais_port_stress_report.json` | `scenario_simulation.py`, dashboard AIS layer |
| `scenario_simulation.py` | `scenario_results_latest`, `scenario_results_log`, `scenario_kpis_log`, `montecarlo_distribution`, `economic_impact_latest`, `corridor_analysis_latest`, `recovery_timeline_latest`, `scenario_hotspots_latest`, `corridor_risk_lines_latest`, `voronoi_risk_zones`, `recovery_stages_latest` | `scenario_results_latest.csv`, `scenario_full_report.json`, `montecarlo_summary.json`, `economic_impact.json`, all `*.gpkg` spatial layers | Dashboard map layers, LLM chatbot context |

---

## 1.3 Key Join Key — `asset_id`

`asset_id` is the universal primary key used for all spatial joins across every script:

| Asset Type | Format | Example |
|---|---|---|
| Seaport | `port_N` | `port_1`, `port_2`, `port_3` |
| Dry Port | `dryport_N` | `dryport_4`, `dryport_9` |
| Railway Station | `station_N` | `station_12`, `station_30` |
| Road Segment | `road_N` | `road_45`, `road_12973` |
| Railway Segment | `rail_N` | `rail_7`, `rail_36` |
| Rail Intersection | `rail_int_N` | `rail_int_28` |
| Access Link | `access_N` | `access_6` |
| Bridge Edge | `bridge_N` | `bridge_3` |

---

# 2. All External Dependencies, APIs & Services

## 2.1 Python Libraries (Backend / Analysis Scripts)

| Library | Version | Used In | Install Command | Purpose |
|---|---|---|---|---|
| `geopandas` | ≥0.14 | All scripts | `pip install geopandas` | Spatial DataFrames, CRS transforms, PostGIS I/O |
| `networkx` | ≥3.2 | network_model, risk_engine, scenario_simulation | `pip install networkx` | Graph construction, centrality, shortest paths |
| `pandas` / `numpy` | ≥2.0 / ≥1.26 | All scripts | `pip install pandas numpy` | Data manipulation, array math |
| `shapely` | ≥2.0 | All scripts | `pip install shapely` | Geometry operations, buffers, intersections |
| `sqlalchemy` | ≥2.0 | All scripts | `pip install sqlalchemy` | PostGIS ORM connection layer |
| `psycopg2-binary` | ≥2.9 | All scripts | `pip install psycopg2-binary` | PostgreSQL adapter |
| `geoalchemy2` | ≥0.14 | network_model, risk_engine | `pip install geoalchemy2` | PostGIS geometry types for SQLAlchemy |
| `requests` | ≥2.31 | hazard_model, ais_port_stress | `pip install requests` | HTTP calls to Open-Meteo, GDACS, RSS |
| `beautifulsoup4` + `lxml` | ≥4.12 | hazard_model, ais_port_stress | `pip install beautifulsoup4 lxml` | XML/RSS parsing |
| `scikit-learn` | ≥1.4 | hazard_model | `pip install scikit-learn` | TF-IDF vectoriser for NLP event classification |
| `scipy` | ≥1.12 | scenario_simulation | `pip install scipy` | Voronoi tessellation for risk zone polygons |
| `websocket-client` | ≥1.7 | ais_port_stress | `pip install websocket-client` | aisstream.io WebSocket live AIS feed |
| `h5py` | ≥3.10 | hazard_model (IMERG fallback) | `pip install h5py` | Read NASA IMERG HDF5 rainfall files |
| `netrc` (stdlib) | ≥3.9 | hazard_model (IMERG fallback) | Built-in | NASA Earthdata credential management |
| `pickle` (stdlib) | ≥3.9 | risk_engine, scenario_simulation | Built-in | Serialise NetworkX graph and scenario engine |

**Full one-liner install:**
```bash
pip install geopandas networkx pandas numpy shapely sqlalchemy psycopg2-binary \
  geoalchemy2 requests beautifulsoup4 lxml scikit-learn scipy websocket-client h5py
```

---

## 2.2 Free External APIs & Live Data Sources

| Service | URL / Endpoint | Used In | Auth Required | Update Frequency | Fallback |
|---|---|---|---|---|---|
| **Open-Meteo** | `api.open-meteo.com/v1/forecast` | `hazard_model.py` | None (free, no key) | 15 min | NASA IMERG |
| **NASA IMERG** | `gpm1.gesdisc.eosdis.nasa.gov` (FTP) | `hazard_model.py` | `~/.netrc` (free Earthdata account) | 30 min | Open-Meteo rain only |
| **GDACS RSS — General** | `gdacs.org/xml/rss.xml` | `hazard_model.py` (flood alerts) | None | ~15 min | Flag defaults to False |
| **GDACS RSS — Cyclones** | `gdacs.org/xml/rss.xml?eventtype=TC` | `hazard_model.py` | None | ~15 min | `hazard_cyclone = 0` |
| **aisstream.io** | `wss://stream.aisstream.io/v0/stream` | `ais_port_stress.py` | Free API key (`AISSTREAM_API_KEY`) | Real-time | Synthetic AIS data |
| **Google News RSS (Strike)** | `news.google.com/rss/search?q=...` | `hazard_model.py` | None | 15 min | Fewer articles |
| **Dawn RSS** | `dawn.com/feeds/home` | `hazard_model.py` | None | 15 min | Skipped |
| **Geo.tv RSS** | `geo.tv/rss/1/0` | `hazard_model.py` | None | 15 min | Skipped |
| **ARY News RSS** | `arynews.tv/feed/` | `hazard_model.py` | None | 15 min | Skipped |
| **The News RSS** | `thenews.com.pk/rss/1/1` | `hazard_model.py` | None | 15 min | Skipped |
| **Tribune RSS** | `tribune.com.pk/feed/rss` | `hazard_model.py` | None | 15 min | Skipped |
| **BBC World RSS** | `feeds.bbci.co.uk/news/world/rss.xml` | `hazard_model.py` | None | 15 min | Skipped |

---

## 2.3 Database Infrastructure

| Component | Version | Install / Command | Config Variable |
|---|---|---|---|
| PostgreSQL | ≥14 | `apt install postgresql-14` | `DB_HOST`, `DB_PORT`, `DB_NAME` |
| PostGIS Extension | ≥3.3 | `apt install postgresql-14-postgis-3` + `CREATE EXTENSION postgis;` | — |
| Database | — | `CREATE DATABASE fyp_georesilience;` | `DB_NAME = 'fyp_georesilience'` |
| Schema | `public` | Default | `DB_SCHEMA = 'public'` |
| User | `fyp_user` | `CREATE USER fyp_user WITH PASSWORD 'fyp_pass';` | `DB_USER` / `DB_PASS` |
| Permissions | — | `GRANT ALL ON DATABASE fyp_georesilience TO fyp_user;` | Must include SELECT on all tables |
| Spatial Index | GIST | Created automatically by `geopandas.to_postgis()` | Speeds up all map queries |

---

## 2.4 Dashboard Frontend Stack

| Package | Version | Purpose |
|---|---|---|
| React | 18+ | Primary SPA framework |
| **MapLibre GL JS** (recommended — 100% free) **OR Mapbox GL JS** | 4.x / 3.x | Interactive WebGL map rendering. MapLibre is open-source with free tile providers |
| **deck.gl** | 9.x | GPU-accelerated layers: HexagonLayer, ScatterplotLayer, ArcLayer, HeatmapLayer, PolygonLayer (Voronoi), PathLayer (corridors), ColumnLayer (3D TEU bars) |
| Turf.js | 6.x | Client-side geospatial calculations (buffers, midpoints, distances) |
| Recharts **OR** Plotly.js | 2.x | KPI time-series charts, radar charts, bar/histogram charts |
| Axios / Fetch API | — | REST calls to the FastAPI backend |
| React Query (TanStack) | 5.x | Data fetching, caching, auto-refresh polling every 30 min |
| Tailwind CSS | 3.x | Utility-first styling |
| Framer Motion | 11.x | Panel animations, alert pulse transitions |
| Socket.io-client | 4.x | Real-time WebSocket for live alerts and AIS vessel updates |
| date-fns | 3.x | Time-slider date formatting |
| PMTiles (optional) | — | Local tile files if using MapLibre without any tile service |

---

## 2.5 Backend API Stack

| Package | Version | Purpose |
|---|---|---|
| **FastAPI** | 0.111+ | REST API server exposing all PostGIS tables as GeoJSON endpoints |
| **Uvicorn** | 0.30+ | ASGI server running FastAPI |
| `asyncpg` or `psycopg2` | — | Async PostgreSQL queries from FastAPI |
| GeoJSON (via shapely/geopandas) | — | Serialize GeoDataFrames to GeoJSON for API responses |
| `python-dotenv` | — | Load `.env` for API keys, DB credentials |
| **Anthropic Python SDK** | ≥0.28 | LLM chatbot — Claude API calls from FastAPI |
| `apscheduler` | 3.x | Background scheduler to run pipeline scripts on cron |
| `python-socketio` | 5.x | Push live alerts and vessel positions to dashboard in real time |

---

# 3. Dashboard Modules & Features

## 3.1 Application Layout

Six primary modules accessible from a persistent left sidebar:

| # | Module | Primary Content |
|---|---|---|
| 1 | **Live Map** | Full-screen interactive map with toggleable hazard, risk, AIS, and scenario layers |
| 2 | **KPI Dashboard** | Summary tiles: alert counts, top-risk assets, PSI gauges, trigger feeds |
| 3 | **Scenario Simulator** | Interactive what-if panel: run scenarios, view impact metrics, economic loss |
| 4 | **AIS Port Monitor** | Port stress gauges, vessel table, 24h arrival schedule, berth occupancy |
| 5 | **Time Slider / History** | Replay historical hazard states from the log tables |
| 6 | **AI Risk Assistant** | LLM chatbot for natural language risk queries |

---

## 3.2 Live Map Module — Complete Layer Catalogue

### 3.2.1 Base & Reference Layers
- Dark base map (MapLibre + Stadia Alidade Smooth Dark — free, no signup)
- Pakistan administrative boundary overlay (districts, provinces)
- Pakistan coastline and EEZ boundary (from `data/pakistan_eez.gpkg`)
- 50 km coastal buffer zone (cyclone exposure zone)

### 3.2.2 Network Layers (from `network_nodes` / `network_edges`)
- Road network edges — colour-coded by `road_type` (motorway=cyan, trunk=blue, primary=teal)
- Railway network edges — dashed magenta lines
- Access links — thin grey connectors showing facility-to-network passages
- Node markers — distinct icons by `node_type`: ⚓ port, 📦 dryport, 🚉 station, ● intersection
- Click any node/edge → popup panel with all attributes (asset_id, centrality scores, capacity)

### 3.2.3 Live Hazard Layers (from `hazard_nodes_latest` / `hazard_edges_latest`)
- **Flood Hazard Layer**: nodes + edges on blue gradient (`hazard_flood`)
- **Cyclone Hazard Layer**: coastal nodes on orange gradient + cyclone position marker with wind radius circle
- **Strike Hazard Layer**: nodes + edges on yellow→red gradient (`hazard_strike`)
- **Accident Hazard Layer**: road/rail edges on red gradient (`hazard_accident`)
- **Composite Hazard Layer**: all assets coloured by `composite_hazard` with CRITICAL/HIGH/MEDIUM/LOW tiers
- **Triggered Assets**: pulsing animated markers where `any_trigger = True`
- **Alert Level Heatmap**: deck.gl HeatmapLayer of `composite_hazard` across all nodes

### 3.2.4 Risk Layers (from `risk_nodes_latest` / `risk_edges_latest`)
- **Composite Risk Choropleth**: all nodes sized and coloured by `composite_risk`
- **Network Criticality Layer**: nodes sized by `network_criticality_risk`
- **Chokepoint Layer**: ⭐ red star markers for `is_chokepoint = True` nodes
- **Risk Tier Layer**: CRITICAL (red `#E63946`), HIGH (orange `#F4A261`), MEDIUM (yellow `#E9C46A`), LOW (green `#2A9D8F`)
- **Natural vs Human Risk Split**: toggle between `risk_natural` and `risk_human`
- **Per-Hazard Risk Layers**: individual `risk_flood`, `risk_cyclone`, `risk_strike`, `risk_accident` layers

### 3.2.5 Scenario Output Map Layers
- **Scenario Hotspot Layer** (`scenario_hotspots_latest.gpkg`): red point markers for every node removed in worst-case scenario, sized by `max_eff_drop`
- **Voronoi Risk Zones** (`voronoi_risk_zones.gpkg`): filled polygons showing risk catchment per facility; colour = `composite_risk`
- **Corridor Risk Lines** (`corridor_risk_lines.gpkg`): LineStrings coloured by vulnerability tier; tooltip shows detour time and delay %
- **Recovery Stage Layer** (`recovery_stages.gpkg`): port/dryport points with pie-chart overlay showing % operational at 24h / 48h / 72h
- **Cascade Failure Animation**: sequential animated node removal following `cascade_steps`

### 3.2.6 AIS & Port Layers (from `ais_port_stress.py`)
- **Vessel Positions Layer**: individual vessel markers coloured by `status_class` (IN_PORT=green, APPROACHING=blue, ANCHORED=yellow, DEPARTING=grey)
- **Vessel Trail Layer**: optional 6h position history from `vessel_positions_log`
- **Port Stress Halo**: pulsing ring around each port sized by `port_stress_index`
- **Port Inner/Outer Zone Circles**: 0.5 nm and 5.0 nm elliptical buffer outlines
- **Arrival Arc Layer**: deck.gl ArcLayer animated arcs from vessel position to destination port
- **TEU 3D Bars**: deck.gl ColumnLayer extruded over each port ∝ `teu_in_port`

### 3.2.7 Map Controls
- Layer toggle panel (each layer on/off independently)
- Opacity slider per layer group
- Time slider (replays `hazard_nodes_log` / `hazard_edges_log` by timestamp)
- Hazard filter: show only CRITICAL / HIGH alerts
- Zoom to Pakistan extent button
- Basemap switcher (satellite / dark / light / terrain)
- Export current map view as PNG

---

## 3.3 KPI Dashboard Module

| Widget | Data Source | Refresh |
|---|---|---|
| Total Triggered Nodes (today) | `kpis_log.triggered_nodes` | Every 30 min |
| CRITICAL / HIGH / MEDIUM / LOW node counts | `risk_kpis_log` tier breakdown | Every 30 min |
| Top Risk Asset name + tier badge | `kpis_log.top_risk_asset` | Every 30 min |
| Hazard Module Status (flood / cyclone / strike / accident) | `kpis_log.hazard_*_status` | Every 30 min |
| Max Composite Hazard gauge (0–1) | `kpis_log.max_composite_hazard` | Every 30 min |
| Avg Composite Hazard sparkline (last 48 runs) | `kpis_log` time series | Every 30 min |
| Flood / Cyclone / Strike / Accident Trigger Counts | `kpis_log.*_triggered_nodes` | Every 30 min |
| Port Stress Index (per port) — gauge chart | `port_stress_latest.port_stress_index` | Every 30 min |
| PSI Trend (↑ RISING / → STABLE / ↓ FALLING) | `port_stress_latest.psi_trend` | Every 30 min |
| Vessels In Port (sum all ports) | `port_stress_latest.vessel_count_in_port` | Every 30 min |
| Expected Arrivals Next 24h | `arrivals_schedule_24h` count | Every 30 min |
| Total TEU In-Port | `port_stress_latest.teu_in_port` (sum) | Every 30 min |
| Network Efficiency (P50 from last MC run) | `scenario_kpis_log.eff_drop_p50` | Every 60 min |
| Monte Carlo P90 Efficiency Drop | `montecarlo_distribution` | Every 60 min |
| CRITICAL Corridors (no detour available) | `corridor_analysis_latest` `vulnerability=CRITICAL` | Every 60 min |
| Top 5 Chokepoints table | `risk_nodes_latest` `is_chokepoint=True` sorted by `network_criticality_risk` | Every 30 min |
| Top 10 Riskiest Nodes table | `risk_summary.json` → `top_risks.top_10_nodes` | Every 30 min |

---

## 3.4 Scenario Simulator Module

### 3.4.1 Interactive Scenario Types

| Scenario Type | User Inputs | Map Output | Metric Output |
|---|---|---|---|
| Node Removal (Port / Dryport / Station Closure) | Select asset(s) from dropdown; severity 0–1 slider | Removed nodes in red; affected corridors highlighted | Efficiency drop %, corridors unreachable, delay hours, economic loss USD + PKR |
| Edge Closure (Road / Rail Blockage) | Select edge from map click or dropdown | Blocked edge in red; rerouted paths in blue | Same as above |
| Capacity Reduction (Congestion) | Select facility; severity slider | Degraded facility amber halo; slower paths | Delay increase per corridor |
| Flood Scenario | Severity slider (0.5 moderate → 1.5 extreme) | Flood-risk nodes removed in blue overlay | Efficiency, delay, economic loss |
| Cyclone Scenario | Severity slider | Coastal removed nodes + degraded periphery ring | Coastal corridor impact |
| Strike Scenario | Severity slider; integrates live PSI from AIS | Port/dryport shutdowns; rerouting shown | Port closure economic loss in TEU/day |
| Accident Scenario | Severity slider | Degraded motorway/trunk edges in amber | Motorway delay propagation |
| Compound Multi-Hazard | Select any combination of 4 hazards + per-hazard severity sliders | Combined overlay of all affected assets | Worst-case compound impact |
| Cascading Failure | Select seed node; cascade depth 1–5; threshold slider | Animated step-by-step node failure cascade | Total cascaded failures, depth breakdown, efficiency drop |

### 3.4.2 Pre-computed Scenario Gallery

Cards loaded from `scenario_results_latest`:
- Flood Moderate / Extreme
- Cyclone (current conditions)
- Strike Partial / Full Shutdown
- Accident
- Karachi Port / Port Qasim / Gwadar Closure
- All 9 individual dryport closures
- Top Chokepoint Closure
- Compound: Flood + Strike
- Compound: Cyclone + Accident
- Compound: Worst Case (Flood + Cyclone + Strike)
- Cascade from Top Chokepoint
- Cascade from Primary Port

### 3.4.3 Monte Carlo Output Panel
- Histogram of 500-iteration efficiency-drop distribution
- P10 / P50 / P90 / P99 band lines overlaid
- Probability of >10% / >25% / >50% efficiency drop
- Average nodes failed per iteration

### 3.4.4 Recovery Timeline Panel
- Logistic recovery curve chart (time hours vs operational %)
- Key milestones: 25% / 50% / 75% / 100% operational
- Per-facility recovery stages map

---

## 3.5 AIS Port Monitor Module
- Per-port card: PSI gauge, trend arrow, berth occupancy bar, container terminal occupancy bar
- Live vessel table (MMSI, name, type, SOG, distance, ETA, `status_class`) with sort + filter
- Arrival schedule: next 24h arrivals by port with ETA, vessel name, TEU estimate
- TEU throughput chart: daily TEU in-port + arriving vs `daily_capacity_teu`
- Vessel type distribution pie chart per port
- PSI history sparkline from `port_stress_log`

---

## 3.6 Time Slider / Historical Module
- Slider bar spanning all timestamps in `hazard_nodes_log`
- Each tick = one pipeline run (every 30 min when scheduled)
- Play / pause / speed controls (1× / 2× / 5×)
- Export selected time window as GeoJSON or CSV

---

# 4. LLM Chatbot Integration

## 4.1 Architecture

Claude API (`claude-sonnet-4-6`) via Anthropic Python SDK, exposed as `POST /api/chat` on FastAPI. The LLM receives structured context summaries — never raw database rows.

---

## 4.2 Context Injected Per Query

| Context Block | Source | ~Max Tokens |
|---|---|---|
| Current KPI snapshot | `kpis_latest.json` | ~400 |
| Risk summary (top 10 nodes, tier distribution) | `risk_summary.json` → `top_risks` | ~600 |
| Port stress summary (PSI per port, trend) | `port_stress_latest.csv` summary | ~300 |
| Relevant scenario results (matched to query) | `scenario_results_latest.csv` — keyword match | ~800 |
| Corridor analysis (CRITICAL corridors only) | `corridor_analysis_latest` CRITICAL rows | ~400 |
| Active hazard triggers | `hazard_nodes_latest` WHERE `any_trigger=True`, top 20 | ~400 |
| Monte Carlo summary | `montecarlo_summary.json` | ~200 |
| Economic impact of worst scenario | `economic_impact_latest` top row | ~300 |

---

## 4.3 Example Query Capabilities

| User Query | How the System Answers |
|---|---|
| "What is the current risk status of Karachi Port?" | Reads PSI, `risk_tier`, `composite_risk`, active triggers from context |
| "What happens if Lahore Dryport closes?" | Backend runs `engine.node_removal(['dryport_5'])` live, LLM narrates `summary_for_llm` |
| "Which corridors have no alternate route?" | Reads `corridor_analysis` CRITICAL rows and explains each |
| "Show me the Monte Carlo risk distribution" | Reads `montecarlo_summary`, explains P50/P90/P99, requests chart display |
| "What is the economic impact of a Karachi strike?" | Matches `scenario_type=strike_scenario`, reads `economic_impact` block, narrates PKR + USD |
| "Which assets are most critical right now?" | Reads `top_10_nodes` from `risk_summary`, explains chokepoints |
| "How long would the network take to recover from a flood?" | Reads `recovery_timeline` from worst flood scenario, explains logistic curve |
| "Compare flood risk vs cyclone risk for coastal ports" | Reads `hazard_flood` vs `hazard_cyclone` for port nodes from context |
| "Which rail corridors are most vulnerable?" | Filters `rail` mode edges from corridor analysis and risk layers |
| "What is the compound risk of flood + strike today?" | Backend runs `compound_scenario(['flood','strike'])` live |

---

## 4.4 Scenario Execution via Chat

When the LLM detects a what-if query, the FastAPI backend calls `ScenarioEngine` directly:

```
User: "What if both Karachi Port and Port Qasim close simultaneously?"
  → Backend: engine.node_removal(['port_1', 'port_2'])
  → Returns: impact dict with summary_for_llm
  → LLM: narrates the result with economic context
```

---

## 4.5 Chatbot UI Components
- Chat panel — right sidebar, collapsible
- Message bubbles with timestamps
- Inline map command: chat response can trigger map layer change (e.g. "Show Karachi Port" → zoom + highlight)
- Scenario result card embedded inline in chat message
- Voice input button (Web Speech API)
- Export conversation as PDF

---

# 5. Hosting, Scheduling & Deployment

## 5.1 Recommended Architecture (Local / VPS)

| Component | Technology | Port | Notes |
|---|---|---|---|
| PostgreSQL + PostGIS | Docker: `postgis/postgis:16-3.4` | 5432 | Mount volume: `-v pgdata:/var/lib/postgresql/data` |
| Backend API | FastAPI + Uvicorn | 8000 | `uvicorn main:app --reload --host 0.0.0.0 --port 8000` |
| Frontend SPA | React (Vite) | 3000 (dev) / 80 (prod) | Served via Nginx in production |
| Analysis Scripts | Python cron via APScheduler or Linux `crontab` | N/A | See schedule below |
| WebSocket Server | `python-socketio` mounted on FastAPI | 8000 `/socket.io` | Push live alerts and vessel positions |
| Tile Server (optional) | Martin or `pg_tileserv` for vector tiles | 3001 | Only needed for very large edge layers |

---

## 5.2 Environment Variables (`.env`)

| Variable | Value / Source | Used By |
|---|---|---|
| `DB_HOST` | `localhost` (or Docker container name) | All scripts, FastAPI |
| `DB_PORT` | `5432` | All scripts, FastAPI |
| `DB_NAME` | `fyp_georesilience` | All scripts, FastAPI |
| `DB_USER` | `fyp_user` | All scripts, FastAPI |
| `DB_PASS` | `fyp_pass` (**change in production!**) | All scripts, FastAPI |
| `AISSTREAM_API_KEY` | Key from aisstream.io (free) | `ais_port_stress.py` |
| `OPEN_METEO_URL` | `https://api.open-meteo.com/v1/forecast` | `hazard_model.py` |
| `ANTHROPIC_API_KEY` | Key from console.anthropic.com | FastAPI LLM endpoint |
| `MAPBOX_TOKEN` | mapbox.com free tier **OR** leave blank for MapLibre | React frontend |
| `REACT_APP_API_URL` | `http://localhost:8000` | React frontend |

---

## 5.3 Cron / Scheduler Configuration

| Script | Frequency | Cron Expression | Rationale |
|---|---|---|---|
| `hazard_model.py` | Every 30 min | `*/30 * * * *` | Matches Open-Meteo + IMERG update cadence |
| `ais_port_stress.py` | Every 30 min | `*/30 * * * *` | AIS vessel positions change frequently |
| `risk_engine.py` | Every 60 min | `5 * * * *` | Runs 5 min after hazard update |
| `scenario_simulation.py` | Every 60 min | `0 * * * *` | Computationally heavy; runs after risk |
| `network_model.py` | On demand only | — | Only re-run when new GIS data digitised |

---

## 5.4 FastAPI Endpoints Required

| Method | Endpoint | Returns | Used By |
|---|---|---|---|
| GET | `/api/hazard/nodes` | GeoJSON — `hazard_nodes_latest` | Live hazard map layers |
| GET | `/api/hazard/edges` | GeoJSON — `hazard_edges_latest` | Live hazard edge layer |
| GET | `/api/risk/nodes` | GeoJSON — `risk_nodes_latest` | Risk map layers, KPI tiles |
| GET | `/api/risk/edges` | GeoJSON — `risk_edges_latest` | Risk edge layer |
| GET | `/api/risk/summary` | JSON — `risk_summary.json` | KPI dashboard, LLM context |
| GET | `/api/kpis/latest` | JSON — `kpis_latest.json` | KPI tiles |
| GET | `/api/kpis/history` | JSON array — `kpis_log` by timestamp | KPI sparklines |
| GET | `/api/ais/stress` | GeoJSON — `port_stress_latest` | AIS module, PSI gauges |
| GET | `/api/ais/vessels` | GeoJSON — `vessel_positions_latest` | AIS vessel layer |
| GET | `/api/ais/arrivals` | JSON — `arrivals_schedule_24h` | Arrival schedule table |
| GET | `/api/scenarios/latest` | JSON — `scenario_results_latest` | Scenario gallery |
| GET | `/api/scenarios/montecarlo` | JSON — `montecarlo_summary.json` | Monte Carlo panel |
| GET | `/api/scenarios/corridors` | JSON — `corridor_analysis_latest` | Corridor risk table |
| GET | `/api/scenarios/recovery` | JSON — `recovery_timeline_latest` | Recovery chart |
| GET | `/api/spatial/hotspots` | GeoJSON — `scenario_hotspots_latest` | Hotspot map layer |
| GET | `/api/spatial/voronoi` | GeoJSON — `voronoi_risk_zones` | Voronoi map layer |
| GET | `/api/spatial/corridors` | GeoJSON — `corridor_risk_lines_latest` | Corridor map layer |
| POST | `/api/scenario/run` | JSON — ScenarioEngine result dict | Interactive scenario panel |
| POST | `/api/chat` | JSON — LLM response + optional map command | AI chatbot |
| GET | `/api/history/nodes?timestamp=YYYYMMDD_HHMM` | GeoJSON snapshot from `hazard_nodes_log` | Time slider |

---

# 6. Complete Map Layer Inventory

| Layer Name | Data Source | Deck.gl / GL Layer | Colour Encoding | Interaction |
|---|---|---|---|---|
| Road Network | `network_edges` (mode=road) | PathLayer | road_type category (motorway=cyan, trunk=blue, primary=teal) | Click → edge attributes popup |
| Railway Network | `network_edges` (mode=rail) | PathLayer (dashed) | Fixed magenta | Click → attributes popup |
| Access Links | `network_edges` (mode=intermodal) | PathLayer (thin) | Grey | Hover → from/to facility names |
| Node Markers | `network_nodes` | ScatterplotLayer + IconLayer | node_type categorical icons | Click → full attribute panel |
| Flood Hazard Nodes | `hazard_nodes_latest` | ScatterplotLayer | `hazard_flood` blue gradient | Click → value + trigger flag |
| Flood Hazard Edges | `hazard_edges_latest` | PathLayer | Blue gradient | Hover → value |
| Cyclone Hazard | `hazard_nodes_latest` + GDACS position | ScatterplotLayer + Circle | Orange gradient; eye = red circle | Click → wind speed, decay radius |
| Strike Hazard | `hazard_nodes_latest` | ScatterplotLayer | Yellow (0.0) → red (1.0) | Click → severity, article preview |
| Accident Hazard | `hazard_edges_latest` (road+rail) | PathLayer | White → dark red gradient | Hover → severity |
| Composite Hazard Heatmap | `hazard_nodes_latest` `composite_hazard` | HeatmapLayer | Blue → green → yellow → red | Weight by composite_hazard |
| Alert — CRITICAL (pulsing) | `hazard_nodes_latest` `alert_level=CRITICAL` | ScatterplotLayer + CSS animation | Red `#E63946` | Click → full alert details |
| Alert — HIGH | `hazard_nodes_latest` `alert_level=HIGH` | ScatterplotLayer | Orange `#F4A261` | Click |
| Risk Tier Choropleth | `risk_nodes_latest` `risk_tier` | ScatterplotLayer | CRITICAL/HIGH/MEDIUM/LOW colours | Click → all risk scores |
| Composite Risk Bubbles | `risk_nodes_latest` `composite_risk` | ScatterplotLayer size-encoded | Size ∝ composite_risk | Click |
| Network Criticality Bubbles | `risk_nodes_latest` `network_criticality_risk` | ScatterplotLayer size-encoded | Navy fill, size ∝ criticality | Click → centrality scores |
| Chokepoint Stars | `risk_nodes_latest` `is_chokepoint=True` | IconLayer (star) | Red fill, white border | Click → BC, composite_risk, tier |
| Scenario Hotspots | `scenario_hotspots_latest.gpkg` | ScatterplotLayer | `max_eff_drop` → red intensity | Click → scenario name, eff drop % |
| Voronoi Risk Zones | `voronoi_risk_zones.gpkg` | PolygonLayer (filled + stroked) | `composite_risk` fill opacity | Click → facility name, risk score |
| Corridor Risk Lines | `corridor_risk_lines.gpkg` | PathLayer (thick) | CRITICAL=red, HIGH=orange, MEDIUM=yellow, LOW=green | Click → base time, detour time, delay % |
| Cascade Failure Animation | Scenario result `cascade_steps` | ScatterplotLayer animated | Grey → red → black (timed) | Play/pause button |
| Recovery Stage Pies | `recovery_stages.gpkg` | IconLayer (SVG pie per port) | Operational % green sweep | Click → full recovery timeline |
| Vessel Positions | `vessel_positions_latest.gpkg` | IconLayer (ship icons by type) | IN_PORT=green, APPROACHING=blue, ANCHORED=yellow, DEPARTING=grey | Click → MMSI, name, SOG, ETA |
| Vessel Arrival Arcs | Approaching vessels | ArcLayer (deck.gl) | Source=vessel colour, target=port; height ∝ ETA hours | Click → ETA, vessel name, TEU |
| Port Stress Halo | `port_stress_latest` | ScatterplotLayer (large transparent ring) | PSI → ring colour + opacity | Click → full PSI breakdown |
| Port TEU 3D Bars | `port_stress_latest` `teu_in_port` | ColumnLayer (deck.gl) | Height ∝ TEU; colour = `stress_tier` | Hover → exact TEU count |
| EEZ / Coastal Buffer | `data/pakistan_eez.gpkg` + coast buffer | PolygonLayer (stroke only) | EEZ = dashed blue; coastal = faint orange fill | Static reference layer |
| Historical Snapshot | `hazard_nodes_log` / `hazard_edges_log` by timestamp | ScatterplotLayer + PathLayer | Same as live hazard layers | Controlled by time slider |

---

# 7. First-Time Setup Checklist

## 7.1 PostgreSQL / PostGIS

```bash
sudo apt install postgresql-14 postgresql-14-postgis-3

sudo -u postgres psql -c "CREATE DATABASE fyp_georesilience;"
sudo -u postgres psql -d fyp_georesilience -c "CREATE EXTENSION postgis;"
sudo -u postgres psql -c "CREATE USER fyp_user WITH PASSWORD 'fyp_pass';"
sudo -u postgres psql -c "GRANT ALL ON DATABASE fyp_georesilience TO fyp_user;"
sudo -u postgres psql -d fyp_georesilience -c "GRANT ALL ON SCHEMA public TO fyp_user;"
```

## 7.2 Python Environment

```bash
python -m venv venv && source venv/bin/activate

pip install geopandas networkx pandas numpy shapely sqlalchemy psycopg2-binary \
  geoalchemy2 requests beautifulsoup4 lxml scikit-learn scipy websocket-client \
  h5py fastapi uvicorn asyncpg python-dotenv anthropic apscheduler python-socketio
```

## 7.3 Required Files in `data/`

```
data/
├── roads.gpkg
├── railways.gpkg
├── ports.gpkg
├── dryports.gpkg
├── stations.gpkg
├── accesslinks.gpkg
├── Pakistan_Centeroids.csv       # columns: city, lat, lon
├── pakistan_eez.gpkg             # EEZ boundary (PostGIS fallback)
└── coast_buffer.gpkg             # 50 km coastal buffer (PostGIS fallback)
```

## 7.4 NASA IMERG Credentials

```bash
# Register at urs.earthdata.nasa.gov (free)
# Add to ~/.netrc:
machine urs.earthdata.nasa.gov login YOUR_USERNAME password YOUR_PASSWORD

chmod 600 ~/.netrc
```

## 7.5 AIS Stream Key
Register at [aisstream.io](https://aisstream.io) (free tier: 2 bounding boxes, unlimited vessel messages). Add to `.env`:
```
AISSTREAM_API_KEY=your_key_here
```

## 7.6 Anthropic API Key
Create account at [console.anthropic.com](https://console.anthropic.com). Add to `.env`:
```
ANTHROPIC_API_KEY=your_key_here
```

## 7.7 Mapbox / MapLibre (Choose One)
- **Option A (Mapbox):** Register at mapbox.com; free tier = 50,000 map loads/month. Add `MAPBOX_TOKEN` to `.env`
- **Option B — fully free (recommended):** Use MapLibre GL JS with [Stadia Maps](https://stadiamaps.com/) dark tiles. No API key required for non-commercial use.
  - Tile style: `https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json`

## 7.8 Run Sequence

```bash
python network_model.py        # One-time baseline (~30 min for centrality)
python hazard_model.py         # Live hazards (~3 min per run)
python risk_engine.py          # Risk calculation (~2 min per run)
python ais_port_stress.py      # AIS data (~1 min per run)
python scenario_simulation.py  # Simulations (~15 min with MC N=500)

uvicorn main:app --reload      # Start FastAPI backend
cd frontend && npm install && npm run dev  # Start React frontend
```

---

# 8. Complete PostGIS Table Reference

| Table Name | Written By | Mode | Key Columns | Dashboard Consumer |
|---|---|---|---|---|
| `network_nodes` | `network_model.py` | REPLACE | `asset_id`, `node_type`, `name`, `lon`, `lat`, all centrality scores, `handling_capacity_index`, `geometry` | Network layer, LLM context |
| `network_edges` | `network_model.py` | REPLACE | `asset_id`, `from_node`, `to_node`, `mode`, `road_type`, `length_km`, `avg_speed_kmh`, `travel_time_hr`, `capacity_index`, `edge_betweenness`, `geometry` | Network layer |
| `baseline_node_metrics` | `network_model.py` | REPLACE | All centrality scores per `asset_id` | `risk_engine.py` input |
| `baseline_edge_metrics` | `network_model.py` | REPLACE | Edge travel metrics per `asset_id` | `risk_engine.py`, scenario |
| `baseline_global_metrics` | `network_model.py` | REPLACE | Global efficiency, `avg_path_hr`, density, etc. | KPI dashboard |
| `baseline_shortest_paths` | `network_model.py` | REPLACE | `source`, `target`, `travel_time_hr`, `distance_km`, `modes_used` (861 rows) | Scenario baseline corridors |
| `ports` / `dryports` / `stations` / `roads` / `railways` | `network_model.py` | REPLACE | Original GIS attributes + `asset_id` | Source reference |
| `hazard_nodes_latest` | `hazard_model.py` | **REPLACE** each run | `asset_id`, all `hazard_*`, `composite_hazard`, `alert_level`, `any_trigger`, `timestamp`, `geometry` | Live hazard map, KPI tiles |
| `hazard_edges_latest` | `hazard_model.py` | **REPLACE** each run | Same hazard columns for edges + `strike_index` | Live hazard edge layer |
| `hazard_nodes_log` | `hazard_model.py` | **APPEND** each run | Same as latest + timestamp index | Time slider history |
| `hazard_edges_log` | `hazard_model.py` | **APPEND** each run | Same as latest + timestamp | Time slider history |
| `kpis_log` | `hazard_model.py` | **APPEND** each run | All scalar KPI metrics + timestamp | KPI sparklines, LLM context |
| `risk_nodes_latest` | `risk_engine.py` + AIS updates | **REPLACE** each run | `asset_id`, all `risk_*`, `exposure_*`, `vulnerability_*`, `composite_risk`, `network_criticality_risk`, `risk_tier`, `is_chokepoint`, `port_stress_index`, `ais_stress_tier`, `psi_trend` | Risk layers, KPI, LLM, scenario |
| `risk_edges_latest` | `risk_engine.py` | **REPLACE** each run | `asset_id`, all `risk_*`, `edge_betweenness`, `importance_score`, `risk_tier` | Risk edge layer |
| `risk_nodes_log` / `risk_edges_log` | `risk_engine.py` | **APPEND** each run | Same as latest + timestamp | Time slider |
| `risk_kpis_log` | `risk_engine.py` | **APPEND** each run | Tier counts, mean/max `composite_risk`, chokepoints, timestamp | KPI time series |
| `port_stress_latest` | `ais_port_stress.py` | **REPLACE** each run | `port_name`, `asset_id`, PSI, `stress_tier`, `psi_trend`, vessel counts, `teu_in_port`, `berth_occupancy_pct`, `geometry` | AIS module, PSI gauges, map halo |
| `port_stress_log` | `ais_port_stress.py` | **APPEND** each run | Same + timestamp | PSI sparkline, trend analysis |
| `vessel_positions_latest` | `ais_port_stress.py` | **REPLACE** each run | `mmsi`, `name`, `lat`, `lon`, `sog`, `vessel_type`, `status_class`, `port_name`, `dist_to_port_nm`, `eta_hours`, `teu_estimate`, `geometry` | Vessel map layer |
| `vessel_positions_log` | `ais_port_stress.py` | **APPEND** each run | Same + timestamp | Vessel trail layer |
| `arrivals_schedule_24h` | `ais_port_stress.py` | **REPLACE** each run | `mmsi`, `name`, `vessel_type`, `port_name`, `eta_hours`, `eta_utc`, `teu_estimate` | Arrival schedule panel |
| `scenario_results_latest` | `scenario_simulation.py` | **REPLACE** each run | `scenario_id`, `scenario_type`, `efficiency_drop_pct`, `corridors_unreachable`, `total_delay_hours`, `cargo_at_risk_usd`, `daily_trade_loss_usd`, `summary_for_llm` | Scenario gallery, LLM context |
| `scenario_results_log` | `scenario_simulation.py` | **APPEND** each run | Same + timestamp | Historical scenario comparison |
| `montecarlo_distribution` | `scenario_simulation.py` | **REPLACE** each run | `run_id`, `eff_drop_pct` per MC iteration | MC histogram |
| `economic_impact_latest` | `scenario_simulation.py` | **REPLACE** each run | Per-scenario economic figures in USD + PKR | Economic loss panel, LLM |
| `corridor_analysis_latest` | `scenario_simulation.py` | **REPLACE** each run | `corridor`, `base_time_hours`, `detour_time_hours`, `delay_increase_pct`, `avg_path_risk`, `vulnerability` | Corridor risk table, LLM |
| `recovery_timeline_latest` | `scenario_simulation.py` | **REPLACE** each run | `time_hours`, `recovery_fraction`, `eff_drop_pct`, `operational_pct` per timestep | Recovery chart |
| `scenario_hotspots_latest` | `scenario_simulation.py` | **REPLACE** each run | `node_id`, `name`, `composite_risk`, `max_eff_drop`, `worst_scenario`, `geometry` (Points) | Hotspot map layer |
| `corridor_risk_lines_latest` | `scenario_simulation.py` | **REPLACE** each run | `corridor`, `vulnerability`, `detour_time_hours`, `geometry` (Lines) | Corridor line map layer |
| `voronoi_risk_zones` | `scenario_simulation.py` | **REPLACE** each run | `node_id`, `composite_risk`, `geometry` (Polygons) | Voronoi polygon layer |
| `recovery_stages_latest` | `scenario_simulation.py` | **REPLACE** each run | `node_id`, `composite_risk`, `recovery_24h_pct`, `geometry` (Points) | Recovery stage map layer |

---

# 9. Common Integration Pitfalls & Solutions

| Issue | Cause | Solution |
|---|---|---|
| `permission denied for table pakistan_eez` | `fyp_user` lacks SELECT on EEZ table | `GRANT SELECT ON pakistan_eez, coast, coastline TO fyp_user;` **OR** place `pakistan_eez.gpkg` + `coast_buffer.gpkg` in `data/` — v6.1 auto-fallback activates |
| `network_nodes / network_edges missing` | `network_model.py` never run, or DB not connected | Run `network_model.py` first. Check `DB_HOST`, `DB_USER`, `DB_PASS` |
| Rail edges = 35/36 in G_main | `nx.Graph` used instead of `nx.MultiGraph` — duplicate-merge dropped a rail edge | Confirm `nx.MultiGraph()` at Step 4. Merge key must be `(frozenset({u,v}), mode)` not just `(u,v)` |
| Port 2/3 in G_main — 1 missing | Access link landed in disconnected road spur | Bridge phase should fix automatically. Check `from_type` values in `accesslinks.gpkg` match: `seaport`, `dryport`, `station`, `railway` |
| `hazard_strike` / `hazard_accident` all zeros | Articles older than 48h cutoff; trade gate too strict; `Pakistan_Centeroids.csv` wrong columns | Check system clock is UTC. Try `RSS_ACCEPT_UNDATED=True`. Verify CSV has `city`, `lat`, `lon` columns |
| Open-Meteo returns zero rain everywhere | Dry season or transient API outage | Script auto-tries IMERG fallback if `ENABLE_IMERG_FALLBACK=True`. Verify `~/.netrc` for Earthdata |
| AIS vessels all classified as TRANSITING | v1.0 flat-Cartesian bearing bug | Confirm `ais_port_stress.py` v2.0 is installed — uses `spherical_bearing()` formula |
| Scenario engine crashes: KeyError on `asset_id` | `scenario_engine.pkl` built from different run than current DB | Re-run `risk_engine.py` to rebuild `scenario_engine.pkl` from current PostGIS data |
| FastAPI returns empty GeoJSON for risk layers | `risk_engine.py` not run since last hazard update | Check `risk_nodes_latest` row count in PostGIS. Re-run `risk_engine.py` |
| MapLibre / Deck.gl renders no features | GeoJSON missing `crs` property or features array is null | Ensure FastAPI serialises with `geometry.to_json()` and includes `"type":"FeatureCollection"` |
| LLM chatbot gives stale risk information | Context not refreshed from latest `kpis_latest.json` | Backend `/api/chat` must read `kpis_latest.json` from disk on every call, not cache it in memory |
| Monte Carlo takes > 30 min | `MONTE_CARLO_N=500` on large graph | Reduce to `MONTE_CARLO_N=200` for demo. Set `sample_n=100` in `global_efficiency()` |
| Voronoi layer missing polygons | Port has no valid lat/lon or < 4 facility points | Check `network_nodes` WHERE `node_type='port'` in PostGIS has valid coordinates |
| PSI not updating in `risk_nodes_latest` | `ais_port_stress.py` run before `risk_engine.py` created the table | Run order: `hazard_model` → `risk_engine` → `ais_port_stress`. PSI UPDATE requires `risk_nodes_latest` to exist first |

---

# 10. Final Platform Completeness Checklist

## 10.1 Backend — Status

| Component | Status |
|---|---|
| `network_model.py` — modal-separated multigraph, all 36 rail lines, bridging guarantee | ✅ Complete |
| `hazard_model.py` — flood, cyclone, strike, accident; Noisy-OR composite; PostGIS log | ✅ Complete |
| `risk_engine.py` — UNDRR H×E×V; 4 vulnerability matrices; network criticality; chokepoints; scenario engine | ✅ Complete |
| `ais_port_stress.py` — PSI; spherical bearing fix; vessel classification; arrivals forecast; PSI trend | ✅ Complete |
| `scenario_simulation.py` — 9 scenario types; Monte Carlo; recovery; economic model; spatial layers | ✅ Complete |
| FastAPI backend — expose all tables as GeoJSON REST endpoints | 🔲 Remaining |
| WebSocket server — push live alert events to frontend | 🔲 Remaining |
| APScheduler / cron — auto-run pipeline every 30 min | 🔲 Remaining |

## 10.2 Frontend — Status

| Component | Status |
|---|---|
| Live Map with all 27+ layers (deck.gl + MapLibre) | 🔲 Remaining |
| KPI Dashboard (20 KPI widgets, sparklines, gauge charts) | 🔲 Remaining |
| Scenario Simulator panel (9 types, gallery, Monte Carlo, recovery chart) | 🔲 Remaining |
| AIS Port Monitor (PSI gauges, vessel table, arrival calendar, TEU 3D bars) | 🔲 Remaining |
| Time Slider (replay historical hazard states from log tables) | 🔲 Remaining |
| LLM Chatbot panel (Claude API, inline map commands, live scenario execution) | 🔲 Remaining |

## 10.3 Research Contribution — What This Platform Delivers

- **First integrated Pakistan supply-chain georesilience platform** combining static GIS + live hazard intelligence
- **Four-hazard composite risk scoring** aligned to UNDRR Sendai Framework
- **Real-time AIS port stress** with vessel classification and PSI feedback into the risk model
- **Nine scenario types** including cascading failure, compound multi-hazard, and Monte Carlo probabilistic simulation
- **Economic impact model** with UNCTAD methodology — trade loss in USD and PKR
- **LLM-powered natural language risk interface** — first such integration for Pakistan freight infrastructure
- **Voronoi risk zones, corridor vulnerability analysis, and time-stepped recovery simulation**
- **Full temporal archive** via log tables enabling historical replay and trend analysis

---

*End of Document — GeoResilience Pakistan Platform Requirements v1.0*
