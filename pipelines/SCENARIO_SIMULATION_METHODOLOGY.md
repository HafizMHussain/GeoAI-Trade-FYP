# Scenario Simulation Engine — Methodology

**Script:** `scenario_simulation.py` v2.0  
**Project:** Geo-Resilience for Ports and Supply Chains Risk Intelligence Platform (Pakistan)

---

## 1. Purpose

The Scenario Simulation Engine answers the central "what-if" question of resilience analysis: **what happens to Pakistan's trade network when one or more components fail?** It quantifies network disruption, estimates economic loss, and models recovery — all expressed in numbers and maps that the LLM assistant and dashboard can present to users.

---

## 2. Key Fixes in v2.0 (vs v1.0)

### 2.1 MultiGraph → SimpleGraph Conversion (Critical Fix)
`network_model.py` produces an `nx.MultiGraph` where the same node pair can have multiple edges of different transport modes (e.g., a road edge AND an intermodal access link between the same two nodes). This is physically correct — they represent different connections.

**The Problem:** When you do `G[u][v]["travel_time_hr"] = X` on a `MultiGraph`, `G[u][v]` returns a *dict-of-dicts* (keyed by edge key), not a single edge dict. Your assignment silently creates a new key instead of modifying the edge weight. All edge closures, capacity reductions, and accident degradations in v1.0 were therefore **doing nothing** to the graph.

**The Fix:** At load time, convert `MultiGraph → nx.Graph` by keeping the **minimum travel-time edge** per `(u, v)` pair. This is the correct operational semantics: any vehicle chooses the fastest available connection. The MultiGraph pickle is preserved unchanged; only the simulation working copy is a SimpleGraph.

```python
def multigraph_to_simple(G_multi):
    G_simple = nx.Graph()
    G_simple.add_nodes_from(G_multi.nodes(data=True))
    for u, v, key, data in G_multi.edges(data=True, keys=True):
        w = float(data.get("travel_time_hr", 1.0) or 1.0)
        if not G_simple.has_edge(u, v):
            G_simple.add_edge(u, v, **data)
        else:
            if w < G_simple[u][v].get("travel_time_hr", float("inf")):
                G_simple[u][v].update(data)
    return G_simple
```

### 2.2 Column Normalisation
The `node_id` / `asset_id` mismatch between DB tables and file outputs is handled by `_normalise_id_col()`, which ensures a consistent `node_id` column regardless of source.

### 2.3 Port Stress Integration
The AIS Port Stress Index (`port_stress_index`) from `ais_port_stress.py` is loaded and used to adjust the effective severity of the **strike scenario** — a port already at 80% congestion is more vulnerable to a strike than an empty one.

---

## 3. Network Efficiency Metric

All scenarios are measured using **Latora-Marchiori Global Efficiency** (2001):

$$E(G) = \frac{1}{n(n-1)} \sum_{i \neq j} \frac{1}{d_{ij}}$$

where $d_{ij}$ is the shortest travel-time path between nodes $i$ and $j$, and unreachable pairs contribute 0. The **efficiency drop** is:

$$\Delta E\% = 100 \times \left(1 - \frac{E(G_{scenario})}{E(G_{baseline})}\right)$$

This metric: (a) handles disconnected graphs gracefully, (b) is sensitive to both complete disconnections and travel-time degradations, and (c) has a clear physical interpretation (lower = worse network performance).

For large graphs (> 300 nodes), a random sample of 300 nodes is used for computational tractability. Results are statistically stable at this sample size for Pakistan's network scale.

---

## 4. Scenario Types

### Type 1: Node Removal
Permanently removes one or more nodes (ports, dryports, stations, intersections) from the working graph. Models: port closure, terminal shutdown, station destruction.

### Type 2: Edge Closure  
Sets `travel_time_hr = 9999` for specified edges. Models: road blockage, railway track closure, bridge failure. The edge remains in the graph (so rerouting is possible) but effectively has infinite cost.

### Type 3: Capacity Reduction
Multiplies travel time on all edges incident to a node by `(1 + severity × 3)`. Models: partial terminal operation (strikes at 70% capacity), flood damage (road passable but slow), port congestion.

### Type 4: Flood Scenario
Removes all nodes where `risk_flood > threshold / severity`. Threshold is 0.60 (configurable). At severity = 1.5 (extreme flood), the effective threshold drops to 0.40, removing more nodes. Dryports are immune (zero flood risk by design from hazard model).

### Type 5: Cyclone Scenario  
Two-tier response:
- **Remove** nodes with `risk_cyclone > 0.60` (direct cyclone hit)
- **Degrade** nodes with `risk_cyclone > 0.36` (multiply travel time by `1 + severity`)

Models the gradient of cyclone impact: assets directly in the path fail; assets in the periphery slow down but remain operational.

### Type 6: Strike Scenario
Ports and dryports with `risk_strike > 0.55` are either removed (full shutdown, severity ≥ 0.8) or degraded (partial operations). If AIS port stress data is available, the effective severity is boosted by `0.5 × PSI` — a heavily congested port is more disruptive to close.

### Type 7: Accident Scenario  
Road/rail edges with `risk_accident > 0.50` OR road type in {motorway, trunk} have their travel time multiplied by `(1 + risk × severity × 1.5)`. Models motorway pile-ups, container truck accidents, freight train derailments on high-importance routes.

### Type 8: Compound Multi-Hazard
Simultaneously applies any combination of flood, cyclone, strike, and accident scenarios with independent per-hazard severities. Used for worst-case planning (e.g., monsoon flood + port workers' strike).

### Type 9: Cascading Failure
Progressive failure propagating from a seed node:

1. **Depth 0:** Remove seed nodes.
2. **Depth 1–N:** Compute approximate betweenness centrality (sampled). Nodes whose betweenness increased by more than `cascade_threshold × severity` (relative to their baseline) are deemed overloaded and also fail.
3. Repeat until no new failures or max depth reached.

**Why betweenness?** When a node fails, traffic re-routes through alternative paths. Nodes on those alternative paths see increased load (higher betweenness). If a node's load exceeds its capacity, it too fails. This models real infrastructure cascade patterns (e.g., when the M-2 motorway is blocked, traffic floods onto the GT Road, which then congests beyond capacity).

---

## 5. Monte Carlo Probabilistic Simulation

Addresses epistemic uncertainty in hazard severity. For each of 500 iterations:

1. For each node with composite risk score $r$, sample intensity from $\text{Beta}(\alpha, \beta)$ where:
   - $\alpha = r \cdot C$ (concentration parameter C = 5.0 by default)
   - $\beta = (1-r) \cdot C$
   - This gives $E[\text{sample}] = r$ with variance $r(1-r)/(C+1)$
2. If sampled intensity > 0.65 (failure threshold), remove the node.
3. Compute efficiency drop of remaining network.

**Output statistics:**
- P10 / P50 (median) / P90 / P99 efficiency drops
- Probability of > 10%, 25%, 50% efficiency drop
- Average nodes failed per iteration
- Average corridors unreachable

The P90 figure is the most operationally meaningful: "there is a 90% chance the network performs at or better than this level under current hazard conditions."

---

## 6. Time-Stepped Recovery Simulation

Models post-disaster restoration using a **logistic (sigmoid) recovery curve**:

$$RF(t) = \frac{1}{1 + e^{-k(t - t_{1/2})}}$$

where:
- $t_{1/2} = 24$ hours (50% recovery time, configurable)  
- $k = \ln(9) / t_{1/2}$ (ensures exactly 50% at $t = t_{1/2}$)
- $RF(0) = 0$ (full damage at time of event)
- $RF(\infty) \to 1$ (full recovery eventually)

The logistic curve captures the empirical reality that recovery is initially slow (emergency response, assessment), accelerates in the middle phase (repair crews mobilised), then slows as only residual damage remains.

Recovery is applied proportionally to all impact metrics (efficiency drop, unreachable corridors, residual delay).

---

## 7. Critical Corridor Analysis

For each of the top-25 facility-to-facility corridors:

1. **Baseline path:** Dijkstra shortest path by travel time.
2. **Average path risk:** Mean composite risk across all nodes on the path.
3. **Detour test:** Remove all edges on the primary path; rerun Dijkstra. If no path exists → **CRITICAL** (no alternative route). If detour adds > 25% time → **HIGH**.
4. **Vulnerability classification:**
   - CRITICAL: No detour exists (only route)
   - HIGH: avg_path_risk > 0.6
   - MEDIUM: avg_path_risk > 0.35
   - LOW: otherwise

---

## 8. Economic Impact Model

Based on UNCTAD trade disruption cost methodology, adapted for Pakistan:

| Parameter | Value |
|-----------|-------|
| Pakistan daily trade value | USD 164 million/day (~$60B/year) |
| Karachi Port share | 60% |
| Port Qasim share | 30% |
| Gwadar share | 10% |
| Cargo value per TEU | USD 30,000 |
| Delay cost per TEU per hour | USD 800 |
| PKR/USD exchange rate | 278 |

**Trade disruption fraction** scales super-linearly with efficiency drop (×1.5 multiplier) reflecting JIT logistics amplification. A supply chain ripple multiplier of 1.3× is applied when a seaport is directly closed.

---

## 9. Spatial Outputs for Maps

| File | Type | Use in Dashboard |
|------|------|-----------------|
| `scenario_hotspots_latest.gpkg` | Points | Red/amber hotspot markers per affected node |
| `corridor_risk_lines.gpkg` | Lines | Color-coded corridors (CRITICAL=red, HIGH=orange) |
| `voronoi_risk_zones.gpkg` | Polygons | Risk catchment zones per facility (Voronoi tessellation clipped to Pakistan) |
| `recovery_stages.gpkg` | Points | Port/dryport recovery timeline per facility |

**Voronoi Method:** Scipy Voronoi tessellation of facility nodes, clipped to Pakistan bounding box `[60.5°E, 23°N, 77.5°E, 37.5°N]`. Mirror points at ±10° ensure bounded regions. Each polygon inherits the composite risk of its generating facility.

---

## 10. Pipeline Position

```
network_model.py    →  graph_baseline.gpickle
                        network_nodes / network_edges  (PostGIS)
                        baseline_shortest_paths        (PostGIS)
        ↓
hazard_model.py     →  hazard_nodes_latest            (PostGIS)
                        hazard_edges_latest            (PostGIS)
        ↓
risk_engine.py      →  risk_nodes_latest              (PostGIS)
                        risk_edges_latest              (PostGIS)
                        scenario_engine.pkl
        ↓
ais_port_stress.py  →  port_stress_latest             (PostGIS)
                        port_stress_index ↩ risk_nodes_latest
        ↓
scenario_simulation.py → scenario_results_latest      (PostGIS)
                           montecarlo_distribution
                           economic_impact_latest
                           corridor_analysis_latest
                           recovery_timeline_latest
                           scenario_hotspots_latest.gpkg
                           corridor_risk_lines.gpkg
                           voronoi_risk_zones.gpkg
```

---

## 11. Running the Script

```bash
# Prerequisites: run in order
python network_model.py      # Script 1 — network graph
python hazard_model.py       # Script 2 — live hazards
python risk_engine.py        # Script 3 — H×E×V risk scores
python ais_port_stress.py    # Script 5 — port stress (optional but recommended)
python scenario_simulation.py # Script 4 — run last
```

Key configuration constants (top of file):

```python
MONTE_CARLO_N          = 500      # ↑ for more stable P99; ↓ for speed
MC_FAILURE_THRESHOLD   = 0.65     # node fails if sampled intensity > this
FLOOD_REMOVAL_THRESHOLD = 0.60    # flood risk above which node is removed
TIME_STEPS_HOURS = [0,3,6,12,24,48,72,120,168]  # recovery timeline
```
