# NETWORK MODEL METHODOLOGY
## GeoResilience for Ports and Supply Chains — Pakistan

**Version:** 7.0  
**Date:** April 2026  
**Script:** `network_model_v7.py`  
**Framework:** Multimodal Graph Theory + Network Science

---

## TABLE OF CONTENTS

1. [Overview](#1-overview)
2. [Theoretical Foundation](#2-theoretical-foundation)
3. [Complete Pipeline](#3-complete-pipeline)
4. [Input Data](#4-input-data)
5. [Node Construction](#5-node-construction)
6. [Edge Construction](#6-edge-construction)
7. [Modal Separation Principle](#7-modal-separation-principle)
8. [Graph Assembly and Connectivity Guarantee](#8-graph-assembly-and-connectivity-guarantee)
9. [Attribute Assignment](#9-attribute-assignment)
10. [Baseline Metrics](#10-baseline-metrics)
11. [Outputs](#11-outputs)
12. [Worked Example — Shortest Path Across Modes](#12-worked-example)
13. [Validation Checks](#13-validation-checks)
14. [Configuration Reference](#14-configuration-reference)
15. [Position in FYP Pipeline](#15-position-in-fyp-pipeline)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. OVERVIEW

### What is the Network Model?

The Network Model is **Script 1** of the GeoResilience FYP. It is the foundation that every other script depends on. It takes six raw GeoPackage datasets (manually digitised for Pakistan, since no integrated dataset exists publicly) and converts them into a fully attributed, topologically correct, multimodal transport graph.

### What does it produce?

- A **NetworkX MultiGraph** (`graph_baseline.gpickle`) with all nodes, edges, and centrality scores
- **Spatial outputs** (`nodes.gpkg`, `edges.gpkg`) for QGIS and hazard sampling
- **CSV metric tables** for all node/edge attributes and global statistics
- **PostGIS database tables** for the web dashboard
- A **trade corridor matrix** — shortest paths between all facility pairs

### Scale of the Model

| Component | Count |
|-----------|-------|
| Road features digitised | 27,973 |
| Railway lines digitised | 36 |
| Seaports | 3 |
| Dry ports (inland container terminals) | 9 |
| Railway stations | 30 |
| Access links | 48 |
| **Nodes in G_main** | **~12,570** |
| **Edges in G_main** | **~14,100+** |

---

## 2. THEORETICAL FOUNDATION

### Graph Theory Basis

The transport network is modelled as an **undirected weighted multigraph**:

```
G = (V, E)

Where:
  V = set of nodes (intersections, stations, ports, dryports)
  E = set of edges (road segments, rail lines, access corridors)
```

**Undirected** — travel is assumed possible in both directions on all links.  
**Weighted** — edge weight = `travel_time_hr` = `length_km / avg_speed_kmh`.  
**Multi** — multiple edges can exist between the same node pair (different modes).

### Primary Weight: Travel Time

All shortest-path computations use travel time (hours) as the edge weight, not distance:

```
travel_time_hr = length_km / avg_speed_kmh
```

This reflects operational reality — a 100 km motorway at 110 km/h (0.91 hr) is faster than a 60 km trunk road at 60 km/h (1.00 hr) even though it is longer.

### Why NetworkX MultiGraph (Not Graph)?

A plain `nx.Graph` only allows **one edge per node pair**. This breaks the network because:

- A railway station may be connected to `rail_int_52` by **both** a physical rail track edge (mode=`rail`) AND an intermodal access link edge (mode=`intermodal`)
- Using `nx.Graph` silently discards one — in testing this caused `rail_35` to disappear entirely
- `nx.MultiGraph` preserves both edges with distinct mode attributes

```
station_3 ──────── rail_35 (mode=rail, 80 km/h) ────────── rail_int_52
station_3 ──── access_21 (mode=intermodal, 30 km/h) ──── rail_int_52

Both edges MUST be kept. They are physically distinct connections.
```

### Coordinate Reference System

All data is processed in **WGS84 (EPSG:4326)** — geographic coordinates (decimal degrees). Distances are computed using the **Haversine formula** to account for Earth's curvature:

```python
def haversine_km(lon1, lat1, lon2, lat2):
    R = 6371.0  # Earth radius km
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
    return R * 2 * atan2(sqrt(a), sqrt(1-a))
```

This is accurate to within ~0.5% for the distances involved across Pakistan.

---

## 3. COMPLETE PIPELINE

```
┌─────────────────────────────────────────────────────────────────────────┐
│ INPUT: 6 GeoPackage Layers                                              │
├─────────────────────────────────────────────────────────────────────────┤
│  roads.gpkg        27,973 road lines   (motorways, trunk, primary)      │
│  railways.gpkg         36 rail lines   (all national railways)          │
│  ports.gpkg             3 seaports     (Karachi, Bin Qasim, Gwadar)     │
│  dryports.gpkg          9 dry ports    (inland container terminals)     │
│  stations.gpkg         30 rail stns    (freight/passenger stations)     │
│  accesslinks.gpkg      48 links        (facility ↔ network passages)   │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 1: LOAD & REPROJECT                                                │
├─────────────────────────────────────────────────────────────────────────┤
│  Read all GeoPackages                                                   │
│  Reproject CRS 3857 → 4326 where needed                                │
│  Assign sequential id column if missing                                 │
│  Normalise name column capitalisation                                   │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 2: BUILD NODES                                                     │
├─────────────────────────────────────────────────────────────────────────┤
│  2A: Port nodes         (3)   — from port centroids                     │
│  2B: Dryport nodes      (9)   — from dryport centroids                  │
│  2C: Station nodes     (30)   — from station point geometry             │
│  2D: Road intersection nodes (~19,800) — from road endpoint snapping    │
│       grid tolerance = 0.001° ≈ 111m                                   │
│  2E: Rail endpoint nodes (~54) — tight station snap ≤ 0.5 km           │
│       → snaps to existing station node if within 0.5 km               │
│       → creates new rail_intersection node (rail_intersection=1) if not │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 3: BUILD EDGES                                                     │
├─────────────────────────────────────────────────────────────────────────┤
│  3A: Road edges    (~20,410) — road_intersection ↔ road_intersection    │
│  3B: Rail edges        (36) — rail node ↔ rail node  [ALL 36 lines]     │
│  3C: Access links      (48) — facility ↔ road_int OR rail_int           │
│       ONLY legal mode-crossing edges in the entire graph               │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 4: BUILD MULTIGRAPH + CONNECTIVITY GUARANTEE                       │
├─────────────────────────────────────────────────────────────────────────┤
│  Load all nodes and edges into nx.MultiGraph                           │
│  Same-mode duplicates merged (keep shorter)                            │
│  Different-mode edges between same pair: BOTH KEPT                     │
│                                                                         │
│  Phase 1: Identify road-anchored main component (~12,489 nodes)        │
│  Phase 2: Bridge all isolated facilities + rail nodes into main        │
│           → iterative nearest-neighbour bridging                       │
│           → 17 bridge edges added in testing                           │
│                                                                         │
│  RESULT: port 3/3  dryport 9/9  station 30/30  rail 36/36  in G_main  │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 5: ASSIGN OPERATIONAL ATTRIBUTES                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  Edge attributes:                                                       │
│    avg_speed_kmh   → from speed lookup table by road_type               │
│    travel_time_hr  → length_km / avg_speed_kmh                          │
│    capacity_index  → 1–5 scale by road/edge type                        │
│  Node attributes:                                                       │
│    handling_capacity_index → 1–5 by facility type and name             │
│    importance_index        → 1–5                                        │
│    redundancy_index        → 1–3                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 6: BASELINE METRICS (computed on G_main only)                      │
├─────────────────────────────────────────────────────────────────────────┤
│  6A: Betweenness centrality   (k=500, weight=travel_time_hr)            │
│  6B: Degree centrality                                                  │
│  6C: Closeness centrality     (distance=travel_time_hr)                 │
│  6D: Eigenvector centrality                                             │
│  6E: Edge betweenness centrality (k=500)                                │
│  6F: Global metrics           (efficiency, avg path, clustering, etc.)  │
│  6G: Trade corridor matrix    (all facility-pair shortest paths)        │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 7: EXPORT FILES                                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  nodes.gpkg / edges.gpkg                                                │
│  nodes_attributed.csv / edges_attributed.csv                           │
│  baseline_metrics.csv / baseline_edge_metrics.csv                      │
│  baseline_global_metrics.csv / baseline_shortest_paths.csv             │
│  graph_baseline.gpickle                                                 │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 8: WRITE TO POSTGIS                                                │
├─────────────────────────────────────────────────────────────────────────┤
│  ports / dryports / stations / roads / railways / access_links          │
│  network_nodes / network_edges                                          │
│  baseline_node_metrics / baseline_edge_metrics                         │
│  baseline_global_metrics / baseline_shortest_paths                     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. INPUT DATA

### 4.1 Why Custom Digitised Data?

Pakistan does not have a publicly available, integrated freight network dataset. OpenStreetMap coverage for freight-relevant infrastructure (motorways, trunk roads, railways, port access roads) is incomplete and inconsistent in attribute quality. All six input layers were therefore manually digitised and quality-controlled in QGIS as part of this FYP.

### 4.2 Road Network

Roads are divided into five functional classes. Each class carries a different design speed and capacity index:

| Road Type | Design Speed | Capacity Index | Examples |
|-----------|-------------|----------------|---------- |
| `motorway` | 110 km/h | 5 | M-1 (Islamabad–Peshawar), M-2 (Lahore–Islamabad), M-9 (Karachi–Hyderabad) |
| `trunk` | 80 km/h | 5 | N-5 National Highway, N-25, N-55 Indus Highway |
| `primary` | 80 km/h | 4 | Major urban arterials and inter-city connectors |
| `ml1 / ml2 / ml3` | 80 km/h | 5 | CPEC Main Line road corridors |
| `connecting` | 60 km/h | 3 | Secondary connectors, access roads |

**Skipped roads (~7,563 of 27,973):** Road segments whose start and end endpoints snap to the same grid cell (very short segments, U-turns, dead ends) are excluded. This is correct behaviour — they carry no meaningful freight traffic.

### 4.3 Railway Network

All 36 national railway lines are digitised including:
- Main Line 1 (Karachi–Peshawar) — longest corridor, ~1,687 km
- Main Line 2 (Kotri–Attari)
- Main Line 3 (Kotri–Quetta) — crosses Balochistan desert
- Branch lines to Taftan (Iran border), Chaman (Afghanistan border), Khokropar
- The Karachi Circular Railway segments
- Short connecting and yard lines

All 36 lines are present in the final G_main with no exceptions.

### 4.4 Access Links — The Critical Dataset

Access links are the most important dataset for multimodal connectivity. Each of the 48 access links was manually traced to represent the physical passage connecting a facility to the road or rail network.

**Attribute schema:**

| Attribute | Values | Purpose |
|-----------|--------|---------|
| `from_type` | `seaport`, `dryport`, `station` | Type of the facility at the link origin |
| `from_name` | e.g. `"Lahore Dryport"` | Facility name — used for name-matching during node resolution |
| `to_type` | `road`, `rail` | What network does this link connect to |
| `mode` | `road_access`, `rail_access`, `station_rail` | Precise access mode |

**Mode meanings:**

```
road_access  — port or dryport connecting to the road network
               → to_node MUST be a road_intersection

rail_access  — dryport connecting to the rail network
               → to_node MUST be a rail_intersection (line endpoint)

station_rail — railway station connecting to the rail line
               → to_node MUST be a rail_intersection
               → NOT to another station (avoids spurious station→station edges)
```

**Coverage:**
- 12 road_access links (3 ports + 9 dryports → road)
- 6 rail_access links (6 dryports → rail)
- 30 station_rail links (all 30 stations → rail lines)

---

## 5. NODE CONSTRUCTION

### 5.1 Facility Nodes (Steps 2A–2C)

Ports, dryports, and stations each receive a deterministic node ID:

```
port_1, port_2, port_3
dryport_1 ... dryport_9
station_1 ... station_30
```

Node position = centroid for polygon features, raw coordinates for point features.

**Zero nodes skipped.** All 42 facility nodes are always created.

### 5.2 Road Intersection Nodes (Step 2D)

Road junctions are inferred from road line endpoints using a coordinate snapping grid:

```
SNAP_TOLERANCE = 0.001°  ≈ 111 metres

Algorithm:
  FOR each road line:
    extract start_coord (coords[0]) and end_coord (coords[-1])
    key = snap_coord(lon, lat) = (round(lon/0.001)*0.001, round(lat/0.001)*0.001)
    group all endpoints sharing the same key into one node
    node position = mean of all raw coordinates in the group
    node_id = road_N  (N = incrementing counter)
```

This produces ~19,800 road_intersection nodes.

**Why 0.001°?**

| Tolerance | Effect |
|-----------|--------|
| Too coarse (0.01°, ≈1.1 km) | Geographically separate roads falsely merged |
| 0.001° ≈ 111 m | Correct: roads meeting within one city block are merged |
| Too fine (0.0001°, ≈11 m) | Roads meeting at the same physical junction produce separate nodes |

### 5.3 Rail Endpoint Nodes (Step 2E)

Rail endpoints are not added to the road snapping grid. They get their own lookup with **station proximity detection**:

```
STATION_SNAP_KM = 0.5 km  (tight threshold)

FOR each rail line endpoint:
  Check: is any rail_station within 0.5 km?
  
  YES → map this endpoint to that station node
        (no new node created; rail line terminates at the station)
  
  NO  → create new rail_intersection node
        assign rail_intersection = 1
        node_id = rail_int_N
```

**Why 0.5 km and NOT 5 km?**

Earlier versions used 5 km. This caused a critical bug:

```
SCENARIO (with 5 km threshold):
  station_A at (67.001, 24.501)
  station_B at (67.003, 24.503)  ← only 0.26 km apart
  
  rail_line_X endpoints:
    start at (67.000, 24.500) → nearest station = station_A (0.14 km) ✓ → snapped to station_A
    end   at (67.004, 24.504) → nearest station = station_A (0.45 km) ✓ → ALSO snapped to station_A ← BUG
  
  Result: u = station_A, v = station_A  (u == v)
  
  Old "fix": assign v = nearest OTHER rail node = station_C, 380 km away
  Outcome: phantom 380 km straight-line edge in the graph  ← the lines in graph_wronglines.png
```

With 0.5 km: only genuinely co-located endpoints snap to stations. Separate endpoints get their own `rail_int_N` nodes. The `u == v` case does not occur for any of Pakistan's 36 railway lines.

---

## 6. EDGE CONSTRUCTION

### 6.1 Road Edges (Step 3A)

```python
FOR each road feature:
  u = road_snap_lookup[snap_coord(start)]
  v = road_snap_lookup[snap_coord(end)]
  
  SKIP if: u is None OR v is None OR u == v
  
  length_km = stored value OR haversine(start, end)
  speed_kmh = stored value OR 60 (default)
  
  geometry = make_edge_line(u_pos, original_geometry, v_pos)
               ← all intermediate vertices preserved
  
  edge: mode='road', road_type=feature.road_type
```

Created: ~20,410 road edges.

### 6.2 Rail Edges (Step 3B)

Rail endpoint resolution uses a four-level cascade to guarantee no line is skipped:

```
resolve_rail_endpoint(lon, lat, snap_key):

  Level 1: Direct snap_lookup hit
           → 0.00 km offset (exact match in rail_snap_map)
  
  Level 2: Nearest rail node within 2 km
           → handles very slight coordinate mismatches
  
  Level 3: Nearest rail node within 10 km
           → wider fallback
  
  Level 4: Nearest rail node unlimited distance
           → NEVER returns None; last resort
```

In the Pakistan dataset, all 36 rail lines resolve at **Level 1** (0.00 km offset). Levels 2–4 are safety nets.

**Rail speed is fixed at 80 km/h** — reflecting Pakistan Railways average commercial freight speed on Main Lines.

**Geometry preservation:** `make_edge_line()` builds the output LineString as:

```
[from_node_position] + [all_intermediate_vertices] + [to_node_position]
```

This preserves the full polyline curvature — critical for accurate hazard proximity sampling (flood, cyclone buffer checks) in later scripts.

### 6.3 Access Link Edges — Intermodal Connections (Step 3C)

Access links require the most complex construction because:
1. Their direction in the GeoPackage may be reversed (network-end first instead of facility-end first)
2. The `to_node` must come from the **correct node pool** based on the `mode` attribute

**Step A — Orientation Detection (both ends tested):**

```python
FOR each access link:
  p_start = coords[0]   # geometry start
  p_end   = coords[-1]  # geometry end
  
  # Test both ends against the declared facility type/name
  nid_start, dist_start = find_facility_node(p_start, from_name, from_type)
  nid_end,   dist_end   = find_facility_node(p_end,   from_name, from_type)
  
  # Whichever end is CLOSER to the matching facility = facility end
  IF dist_start <= dist_end:
    from_node = nid_start
    net_end   = p_end          # network end = geometry end
  ELSE:
    from_node = nid_end
    net_end   = p_start        # network end = geometry start (reversed)
```

**Step B — Modal Destination Resolution (no distance cap):**

```python
IF mode == 'road_access':
  to_node = nearest_node(net_end, pool=road_intersections)
  # Result: port/dryport connects to road network

IF mode == 'rail_access':
  to_node = nearest_node(net_end, pool=rail_intersections)  # preferred
  # Result: dryport connects to rail line endpoint

IF mode == 'station_rail':
  to_node = nearest_node(net_end, pool=rail_intersections)  # NOT other stations
  # Result: station connects to the physical rail line, not another station
```

**Why rail_intersection nodes and NOT station nodes for station_rail?**

```
WRONG approach (causes station→station edges):
  station_16 (Lahore) connects to nearest rail node
  → nearest rail node = station_12 (Khanewal, 140 km south)
  → creates direct station_16→station_12 intermodal edge
  → bypasses the actual rail_int_28 node that the rail line runs through
  → graph thinks you can teleport from Lahore to Khanewal on an "access link"

CORRECT approach (connects to the physical rail line):
  station_16 (Lahore) connects to nearest rail_intersection node
  → connects to rail_int_28 (the rail line endpoint near Lahore)
  → station now properly integrated into the rail topology
```

All 48 access links resolve successfully with zero skips.

---

## 7. MODAL SEPARATION PRINCIPLE

### The Rule

```
┌──────────────────────────────────────────────────────────────────┐
│  ROAD SUBNETWORK          MODAL BOUNDARY        RAIL SUBNETWORK  │
│                                                                  │
│  road_int ─── road ───  road_int               rail_int         │
│  road_int ─── road ───  road_int               ↑    ↑           │
│  road_int ─── road ───  road_int             rail  rail         │
│                                                ↓    ↓           │
│            ONLY crossing              rail_int ── rail ── stn   │
│         allowed here ↓                                          │
│                                                                  │
│  road_int ─── intermodal ─── PORT ─── intermodal ─── rail_int   │
│  road_int ─── intermodal ─── DRYPORT ─ intermodal ─── rail_int  │
│                              STATION ─ station_rail ── rail_int  │
│                                                                  │
│  Truck cannot run on rails.  Train cannot continue on road.      │
│  Mode transfer ONLY at: ports, dryports, stations.              │
└──────────────────────────────────────────────────────────────────┘
```

### Why It Matters

Without modal separation, Dijkstra's algorithm would find shortest paths that "switch" from road to rail at a random rural intersection — physically impossible. For example:

```
BAD path (without modal separation):
  Lahore Dryport → road_int_4500 → rail_int_28 → rail → station_3 → port_3
                          ↑ illegal! no physical access exists here

CORRECT path (with modal separation):
  Lahore Dryport → [road_access] → road_int_137 → road → road_int_848 
  → [road_access] → port_3 (road mode)
  
  OR
  
  Lahore Dryport → [rail_access] → rail_int_28 → rail → rail_int_52 
  → [station_rail] → station_3 → [intermodal] → road → port_3 (mixed mode)
```

### Modal Integrity in Shortest Paths

The `modes_used` field in `baseline_shortest_paths.csv` shows which modes each corridor path traversed. Valid combinations are:

| modes_used | Meaning |
|------------|---------|
| `intermodal+road` | Road-only corridor (facility access + road travel) |
| `intermodal+rail` | Rail-only corridor |
| `intermodal+rail+road` | Multimodal corridor — road + rail + intermodal transfers |

Any path containing a direct `road+rail` transition (without `intermodal`) would indicate a bug in the modal separation logic.

---

## 8. GRAPH ASSEMBLY AND CONNECTIVITY GUARANTEE

### 8.1 The Fragmentation Problem

After initial graph assembly, the network has ~3,730 connected components. This is expected:

```
Component structure BEFORE bridging:

  Main road component:    ~12,489 nodes  ← motorway/trunk/primary grid
  Road spurs:             ~3,700 tiny components  ← dead-end streets, cul-de-sacs
  Rail island A:          rail_int_4 — rail_int_5  (2 nodes, rail_5)
  Rail island B:          rail_int_8 — rail_int_9  (2 nodes, rail_8)
  Rail island C:          rail_int_10 — rail_int_11 — rail_int_24 (3 nodes, rail_9+17)
  ... (many small rail islands)
  Isolated port_2 (Gwadar):  connected to access_2 → road_10698 → but road_10698
                              is in a disconnected road spur, NOT in main component
```

Simply taking the largest component would exclude most rail lines and several facilities.

### 8.2 Two-Phase Bridging Algorithm

**Phase 1 — Identify Road-Anchored Main Component:**

```python
def get_road_main_component(G):
  components = sorted(nx.connected_components(G), key=len, reverse=True)
  FOR comp in components:
    IF any node in comp has node_type == 'road_intersection':
      RETURN comp  # ← this is the genuine road backbone
  RETURN largest component  # fallback
```

This identifies the motorway/trunk/primary road network as the anchor — not a large rail island.

**Phase 2 — Iterative Bridging:**

```python
bridge_targets = all facility nodes + all rail nodes

FOR each target NOT in main_component:
  br = nearest_node(target, pool=main_component)
  ADD edge: target ↔ br  (mode='intermodal', road_type='bridge_access')
  EXPAND main_component to include all nodes now reachable through this bridge

REPEAT until all targets are in main_component
```

After bridging (17 bridge edges added in testing):

```
FINAL COVERAGE:
  port:          3/3   ✓
  dryport:       9/9   ✓
  rail_station: 30/30  ✓
  rail_edges:   36/36  ✓
```

### 8.3 What Are Bridge Edges?

Bridge edges (`road_type='bridge_access'`) represent the physical reality that every major facility in Pakistan has some physical access to the main network, even if the digitised access link geometry did not perfectly snap to a main-component road node. They are:

- Tagged as `mode='intermodal'` in the graph
- Exported to `edges.gpkg` and the PostGIS `network_edges` table
- Distinguished from access links by `road_type='bridge_access'`
- Assigned `speed=30 km/h`, `capacity_index=1`

In the risk engine, bridge edges should be treated conservatively — they represent minimum-standard physical access, not designed freight corridors.

---

## 9. ATTRIBUTE ASSIGNMENT

### 9.1 Edge Speed Assignment

```
Rail edges:    ALWAYS 80 km/h (fixed, regardless of stored attribute)

Road/intermodal edges — lookup by road_type substring:

  road_type contains 'motorway'      → 110 km/h
  road_type contains 'trunk'         →  80 km/h
  road_type contains 'primary'       →  80 km/h
  road_type contains 'ml1/ml2/ml3'   →  80 km/h
  road_type contains 'connecting'    →  60 km/h
  road_type contains 'road_access'   →  30 km/h
  road_type contains 'rail_access'   →  30 km/h
  road_type contains 'station_rail'  →  30 km/h
  road_type contains 'bridge_access' →  30 km/h
  unrecognised                       →  60 km/h (safe default)
```

### 9.2 Travel Time Calculation

```
travel_time_hr = length_km / avg_speed_kmh

Examples:
  Karachi–Lahore via M-9/M-2 motorway  ≈ 1,200 km / 110 km/h ≈ 10.9 hours
  Karachi–Lahore via rail (ML-1)        ≈ 1,687 km /  80 km/h ≈ 21.1 hours
  Port access link (5 km)               ≈     5 km /  30 km/h ≈  0.17 hours
```

### 9.3 Capacity Index

Relative integer score (1–5) reflecting throughput capacity:

| Edge Type | Index | Rationale |
|-----------|-------|-----------|
| motorway / trunk / ml corridors | 5 | Highest-capacity national freight infrastructure |
| primary road | 4 | Major arterials |
| connecting road | 3 | Secondary network |
| road_access / rail_access / station_rail / intermodal | 2 | Access corridors, lower throughput |
| bridge_access / fallback_access | 1 | Emergency connectivity only |

### 9.4 Node Importance Indices

Three indices on a 1–5 (or 1–3 for redundancy) scale:

| Node | handling_capacity_index | importance_index | redundancy_index |
|------|------------------------|-----------------|-----------------|
| Karachi Port, Bin Qasim | 5 | 5 | 3 |
| Gwadar (CPEC developing) | 3 | 4 | 2 |
| Other ports | 4 | 4 | 2 |
| Major dryports (Lahore, KHI, FSD, ISB, SKT) | 4 | 4 | 3 |
| Minor dryports (PEW, MUL, RWD, GIL) | 3 | 3 | 2 |
| Rail stations | 2 | 2 | 2 |
| road_intersection | 1 | 1 | 1 |
| rail_intersection | 1 | 1 | 1 |

**Rationale for Gwadar importance=4:**
Gwadar is still developing (lower current capacity = 3) but is strategically the most important port in Pakistan's future — the western terminus of CPEC, with a deep-water port designed for ultra-large container vessels. It receives the highest importance score in the country.

---

## 10. BASELINE METRICS

All metrics are computed on **G_main only** — the connected main component after bridging.

### 10.1 Node Centrality Measures

#### Betweenness Centrality (k=500)

```
BC(v) = Σ (σ_st(v) / σ_st)  for all s ≠ v ≠ t

Where:
  σ_st      = total number of shortest paths from s to t
  σ_st(v)   = number of those paths that pass through v
  
Weight: travel_time_hr
Normalised: True (divided by (n-1)(n-2)/2)
Approximated: k=500 random source nodes (exact would require n² computations)
```

**Interpretation:** A node with `betweenness_centrality = 0.30` lies on 30% of all shortest freight paths in the network. Removing it would disrupt 30% of all optimal routes.

**In Pakistan's network:** High betweenness nodes include the N-5 highway junctions near Lahore, the Karachi port access roads, and rail junctions on ML-1.

#### Degree Centrality

```
DC(v) = degree(v) / (n - 1)

Where: n = total nodes in G_main
```

Identifies highly-connected hubs. In the freight network, major road interchanges (motorway-to-trunk connections) score highest.

#### Closeness Centrality

```
CC(v) = (n - 1) / Σ d(v, u)  for all u ≠ v

Where: d(v, u) = shortest travel time from v to u
```

Nodes with high closeness can reach the entire network quickly. Central dryports (Lahore, Islamabad) typically score highest.

#### Eigenvector Centrality

```
EC(v) = (1/λ) × Σ EC(u)  for all u adjacent to v

Where: λ = largest eigenvalue of the adjacency matrix
Weight: travel_time_hr
```

Captures "importance by association" — a node connected to other important nodes scores high even if it has few direct connections.

### 10.2 Edge Betweenness Centrality

```
EBC(e) = Σ (σ_st(e) / σ_st)  for all s ≠ t

Where: σ_st(e) = number of shortest paths from s to t that use edge e
```

High EBC edges are the most critical road/rail segments — their closure most disrupts the network. Used in the risk engine to weight edge importance.

### 10.3 Global Network Metrics

| Metric | Formula | Baseline Value (typical) |
|--------|---------|--------------------------|
| `avg_degree` | mean(degree(v) for all v) | ~2.25 |
| `global_efficiency` | mean(1/d(u,v)) for all u≠v | ~0.010 |
| `avg_shortest_path_hr` | sampled mean travel time | ~8.0 hours |
| `avg_shortest_path_km` | sampled mean distance | ~800 km |
| `avg_clustering` | mean local clustering coeff. | ~0.058 |
| `density` | 2|E| / (|V|(|V|-1)) | ~0.00018 |
| `assortativity` | degree correlation | ~0.036 |
| `total_length_km` | sum of edge lengths | ~39,500 km |

**Global efficiency ≈ 0.010** is low because Pakistan's network is very sparse relative to its geographic extent — characteristic of developing-country infrastructure.

### 10.4 Trade Corridor Matrix

All pairwise shortest paths between the 42 facility nodes are computed:

```python
FOR (src, tgt) in combinations(facility_nodes, 2):
  travel_time_hr = shortest_path_length(G_main, src, tgt, weight='travel_time_hr')
  distance_km    = shortest_path_length(G_main, src, tgt, weight='length_km')
  path           = shortest_path(G_main, src, tgt, weight='travel_time_hr')
  modes_used     = {edge.mode for edge in path}
```

This produces `C(42, 2) = 861` corridor records. These form the **baseline trade flow matrix** — the reference against which hazard-disrupted networks are compared in the risk engine.

---

## 11. OUTPUTS

### 11.1 File Outputs

```
outputs/
├── nodes.gpkg                   ← import in ALL hazard scripts
│     Point layer, G_main nodes, full attribute set
│     Key: asset_id (port_1, dryport_3, station_12, road_45, rail_int_3)
│
├── edges.gpkg                   ← import in ALL hazard scripts
│     LineString layer, G_main edges, full attribute set
│     Key: asset_id (road_45, rail_7, access_6, bridge_2)
│
├── nodes_attributed.csv         ← node metrics table
├── baseline_metrics.csv         ← same as above (alias)
├── edges_attributed.csv         ← edge metrics table
├── baseline_edge_metrics.csv    ← same as above (alias)
├── baseline_global_metrics.csv  ← one-row global statistics
├── baseline_shortest_paths.csv  ← 861-row corridor matrix
└── graph_baseline.gpickle       ← import in risk engine and scenario scripts
```

### 11.2 PostGIS Tables

| Table | Rows | Contents |
|-------|------|---------|
| `ports` | 3 | Source port layer + asset_id |
| `dryports` | 9 | Source dryport layer + asset_id |
| `stations` | 30 | Source station layer + asset_id |
| `roads` | 27,973 | Source road layer + asset_id |
| `railways` | 36 | Source rail layer + asset_id |
| `access_links` | 48 | Source access link layer + asset_id |
| `network_nodes` | ~12,570 | Attributed G_main node layer |
| `network_edges` | ~14,100+ | Attributed G_main edge layer |
| `baseline_node_metrics` | ~12,570 | CSV node metrics as DB table |
| `baseline_edge_metrics` | ~14,100+ | CSV edge metrics as DB table |
| `baseline_global_metrics` | 1 | Global statistics row |
| `baseline_shortest_paths` | 861 | Corridor path matrix |

### 11.3 The asset_id Join Key

The `asset_id` field is the **primary key** used to join network outputs with hazard outputs in all downstream scripts:

```
Format examples:
  port_1, port_2, port_3
  dryport_1 ... dryport_9
  station_1 ... station_30
  road_1 ... road_27973
  rail_1 ... rail_36
  rail_int_1 ... rail_int_54
  access_1 ... access_48
  bridge_1 ... bridge_N
```

When a hazard script (flood, cyclone, strike, accident) computes an exposure score for an asset, it writes it to a table with `asset_id` as the key. The risk engine then joins on `asset_id` to combine hazard scores with network centrality scores.

---

## 12. WORKED EXAMPLE

### Shortest Path: Lahore Dryport → Karachi Port (Road Mode)

```
Nodes involved:
  dryport_5  = Lahore Dryport
  port_3     = Karachi Port

Path computed by Dijkstra's algorithm (weight=travel_time_hr):

  dryport_5 
  ──[access_8: road_access, 2.1 km, 30 km/h, 0.07 hr]──
  road_137 
  ──[road_137_to_...: motorway, ~1,150 km, 110 km/h, ~10.5 hr]──
  ... (many road_intersection nodes) ...
  ──[...motorway near Karachi...]──
  road_848
  ──[access_3: road_access, 3.5 km, 30 km/h, 0.12 hr]──
  port_3
  
  Total: ~1,150 km / 110 km/h + access times ≈ 10.7 hours
  modes_used: road + intermodal
```

### Shortest Path: Karachi Dryport → Lahore via Rail

```
  dryport_4 (Karachi Dryport)
  ──[access_15: rail_access, 1.2 km, 30 km/h, 0.04 hr]──
  rail_int_52
  ──[rail_35: rail, 5.6 km, 80 km/h, 0.07 hr]──
  station_3 (Karachi Cantt)
  ──[rail_1: rail, 165.6 km, 80 km/h, 2.07 hr]──
  station_15 (Kotri)
  ──[rail_2: rail, 60.4 km, 80 km/h, 0.76 hr]──
  rail_int_1
  ... (continuing along ML-1) ...
  rail_int_28
  ──[access_34: station_rail, 0.8 km, 30 km/h, 0.03 hr]──
  station_16 (Lahore)
  ──[access_8 reverse: road_access, 2.1 km, 30 km/h, 0.07 hr]──
  road_137
  ──[...road to dryport_5...]──
  dryport_5 (Lahore Dryport)
  
  Total rail distance: ~1,687 km / 80 km/h ≈ 21.1 hours
  modes_used: rail + intermodal
```

This shows the network correctly routing **road-only** and **rail-only** multimodal paths, and that mode crossing only occurs at designated facilities.

---

## 13. VALIDATION CHECKS

The script prints a full validation summary on completion. All checks must pass:

```
VALIDATION:
  edges with avg_speed_kmh  = 0 : 0   (should be 0)
  edges with travel_time_hr = 0 : 0   (should be 0)
  edges with capacity_index = 0 : 0   (should be 0)
  nodes with NULL betweenness    : 0   (should be 0)
  nodes with NULL handling_cap   : 0   (should be 0)
  road edges in G_main           : 20410+  (all road features)
  rail edges in G_main           : 36   (should equal 36)
  intermodal edges in G_main     : 65   (48 access + bridges)
  rail_intersection nodes        : ~54

FACILITY COVERAGE IN G_main:
  port           : 3/3   ✓
  dryport        : 9/9   ✓
  rail_station   : 30/30 ✓
  ALL FACILITIES PRESENT IN G_main ✓
```

**If any check fails:**

| Failure | Likely Cause |
|---------|-------------|
| `rail edges < 36` | MultiGraph not used, or duplicate-merge discarded rail edge |
| `port/dryport/station < expected` | Bridge phase failed; check PostGIS connection and node coordinates |
| `avg_speed_kmh = 0 on N edges` | road_type string not matching any SPEED_TABLE key |
| `NULL betweenness on N nodes` | G_main not copied after Step 5 attribute assignment |

---

## 14. CONFIGURATION REFERENCE

All parameters are defined in the `CONFIGURATION` block at the top of `network_model_v7.py`:

| Parameter | Default | Effect |
|-----------|---------|--------|
| `SNAP_TOLERANCE` | `0.001°` | Road intersection grid cell size (~111 m). Increase to merge more endpoints; decrease for finer resolution. |
| `STATION_SNAP_KM` | `0.5 km` | Max distance to snap a rail endpoint to a station. Do NOT increase beyond 1.0 km or phantom edges may reappear. |
| `WEIGHT` | `'travel_time_hr'` | Primary edge weight for all shortest-path and centrality computations. |
| `K_BC` | `500` | Betweenness centrality sample size. Increase for accuracy (slower); decrease for speed. 500 is good for a ~12,000 node graph. |
| `DB_HOST` | `'localhost'` | PostGIS server address. |
| `DB_PORT` | `5432` | PostGIS port. |
| `DB_NAME` | `'fyp_georesilience'` | Database name. |
| `DB_USER` | `'fyp_user'` | Database username. |
| `DB_PASS` | `'fyp_pass'` | Database password. |

---

## 15. POSITION IN FYP PIPELINE

Script 1 (Network Model) is the **foundation** — all other scripts depend on its outputs:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ SCRIPT 1: Network Model (THIS SCRIPT)                                  │
│ Output: graph_baseline.gpickle, nodes.gpkg, edges.gpkg, PostGIS tables │
└─────────────────────────────────────────────────────────────────────────┘
           ↓                    ↓                    ↓
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐
│ Live_Flood_Model │  │ Live_Cyclone     │  │ Live_Strikes / Accidents │
│ River distance   │  │ GDACS cyclone    │  │ GDELT + RSS news feeds   │
│ DEM elevation    │  │ 50km coastal     │  │ NLP location extraction  │
│ IMERG rainfall   │  │ buffer + EEZ     │  │ Distance probability     │
│ ↓                │  │ ↓                │  │ ↓                        │
│ flood_index per  │  │ cyclone_exposure │  │ strike/accident_risk per │
│ asset (node/edge)│  │ per asset        │  │ asset                    │
└──────────────────┘  └──────────────────┘  └──────────────────────────┘
           ↓                    ↓                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ AIS VESSEL ANALYSIS (Planned)                                           │
│ Real-time ship tracking → port stress, berth occupancy, ETA analysis   │
└─────────────────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ RISK ENGINE (Script 3)                                                  │
│ Exposure + Vulnerability + Hazard → composite risk per asset            │
│ UNDRR formula: Risk = H × E × V                                         │
│ Network criticality: risk × betweenness_centrality                      │
│ Risk tiers: CRITICAL / HIGH / MEDIUM / LOW                              │
└─────────────────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ SCENARIO ENGINE                                                         │
│ What-if simulations: node removal, edge closure, capacity reduction     │
│ Recomputes: efficiency, connectivity, corridor travel times             │
└─────────────────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ LLM CHATBOT                                                             │
│ Natural language interface over the full risk model                     │
│ "What happens if Lahore Dryport closes?"                                │
│ "Which rail corridor is most vulnerable to flooding?"                   │
└─────────────────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ WEB DASHBOARD                                                           │
│ Live hazard map layers  │  KPI tiles  │  Alert feeds                   │
│ Corridor analysis       │  Scenario simulator  │  LLM chat             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 16. TROUBLESHOOTING

### "rail edges in G_main: 35/36 — MISSING 1"

**Cause:** A rail edge and an intermodal access link share the exact same node pair (e.g. `station_3 ↔ rail_int_52`). If using `nx.Graph` (not `MultiGraph`), the shorter edge silently overwrites the longer one.

**Solution:** Confirm script uses `nx.MultiGraph()` at Step 4. The duplicate-merge key must be `(frozenset({u,v}), mode)` — not just `(u, v)`.

---

### "port 2/3 in G_main — MISSING 1" (or similar facility missing)

**Cause:** The facility's access link connects to a road node that is in a disconnected road spur, not the main component. The bridge phase should fix this but may have missed it.

**Debug:**
```python
# Check which facility is missing
for n in G.nodes:
    if G.nodes[n].get('node_type') == 'port':
        comp = nx.node_connected_component(G, n)
        print(f"{n}: component size = {len(comp)}")

# Check what it connects to
for u, v, d in G.edges(n, data=True, keys=False):
    print(f"  {n} → {v}  mode={d['mode']}  road_type={d['road_type']}")
```

---

### "Long straight phantom edges in QGIS"

**Cause:** `STATION_SNAP_KM` set too high (5 km or more). Both endpoints of a rail line snapped to the same station (`u == v`), and the old "fix" routed `v` to the nearest OTHER rail node — possibly hundreds of km away.

**Solution:** Confirm `STATION_SNAP_KM = 0.5` in config. Do not increase beyond 1.0 km.

---

### "Skipped: 30 access links" (or high skip count in Step 3C)

**Cause (v5 and earlier):** The code always treated `coords[0]` as the facility end. Many access links in the GeoPackage are digitised in the opposite direction.

**Solution (v7):** The orientation-agnostic detection (testing both ends) is implemented. If you still see skips, check that `from_type` values in `accesslinks.gpkg` exactly match one of: `seaport`, `port`, `dryport`, `station`, `railway`.

```python
import geopandas as gpd
al = gpd.read_file('data/accesslinks.gpkg')
print(al['from_type'].unique())
print(al['mode'].unique())
```

---

### "PostGIS: Could not write access_links: column not found"

**Cause:** `access_links.gpkg` has a column that conflicts with a PostGIS reserved word, or has inconsistent column types between rows.

**Solution:**
```python
# Check access_links columns
import geopandas as gpd
al = gpd.read_file('data/accesslinks.gpkg')
print(al.dtypes)
print(al.head())
```
Rename any column called `id`, `type`, or `order` before writing.

---

### "Betweenness centrality takes too long"

The closeness centrality step (Step 6C) is the most expensive — O(n²) computation. On a graph with ~12,500 nodes it takes ~600 seconds (10 minutes).

**Speed up options:**
```python
# Option 1: Reduce betweenness sample size
K_BC = 200  # from 500 — less accurate, ~40% of original time

# Option 2: Skip closeness centrality (comment out Step 6C)
# It is the most expensive and least used metric in the risk engine

# Option 3: Use approximate closeness
# Replace nx.closeness_centrality() with a sampled version
```

---

### "ERROR: No module named geopandas"

```bash
pip install geopandas networkx pandas numpy shapely sqlalchemy geoalchemy2 psycopg2-binary
```

On some systems:
```bash
pip install geopandas --no-binary fiona
# or
conda install -c conda-forge geopandas
```

---

### "CRS Warning: reprojecting to 4326"

This is expected behaviour, not an error. All six input layers are automatically reprojected from EPSG:3857 to EPSG:4326 at load time. No action needed.

---

## SUMMARY

The Network Model (Script 1) implements a **physically realistic multimodal freight graph** for Pakistan by:

1. **Modal separation** — road and rail are independent subnetworks; only access links legally cross the boundary at designated facilities
2. **Tight rail snapping** (0.5 km) — eliminates phantom long edges that plagued earlier versions
3. **MultiGraph** — preserves all edges between the same node pair when they have different modes
4. **Two-phase connectivity guarantee** — bridges all 42 facilities and all 36 rail lines into the main component
5. **Full geometry preservation** — all intermediate vertices retained in every edge, enabling accurate spatial analysis

All outputs use `asset_id` as the universal join key across the entire FYP pipeline.

**Next Steps After Running Script 1:**
1. Verify validation output — all checks should pass
2. Open `nodes.gpkg` and `edges.gpkg` in QGIS to visually confirm the network looks like `graph_correctlines.png`
3. Run hazard scripts (`Live_Flood_Model.ipynb`, `Live_Cyclone.ipynb`, etc.)
4. Pass `graph_baseline.gpickle` to the Risk Engine (Script 3)

---

**End of Methodology Document**
