import os
import sys
import psycopg2
from datetime import datetime, timedelta

# Database credentials
DB_NAME = 'dummy_dashboard'
DB_USER = 'postgres'
DB_PASSWORD = 'admin1234'
DB_HOST = 'localhost'
DB_PORT = '5432'

print(f"Connecting to Database: {DB_NAME} at {DB_HOST}:{DB_PORT} as {DB_USER}")

try:
    conn = psycopg2.connect(dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD, host=DB_HOST, port=DB_PORT)
    conn.autocommit = True
    cursor = conn.cursor()
except Exception as e:
    print(f"ERROR: Could not connect to database.\n{e}")
    sys.exit(1)

def create_tables():
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS network_nodes (
            node_id VARCHAR(255) PRIMARY KEY, asset_id VARCHAR(255) UNIQUE, node_type VARCHAR(50), name VARCHAR(255),
            lon FLOAT, lat FLOAT, rail_intersection INTEGER DEFAULT 0, betweenness_centrality FLOAT DEFAULT 0,
            degree_centrality FLOAT DEFAULT 0, closeness_centrality FLOAT DEFAULT 0, importance_index INTEGER DEFAULT 1,
            handling_capacity_index INTEGER DEFAULT 1, redundancy_index INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS network_edges (
            edge_id VARCHAR(255) PRIMARY KEY, asset_id VARCHAR(255) UNIQUE, from_node VARCHAR(255), to_node VARCHAR(255),
            mode VARCHAR(50), road_type VARCHAR(50), length_km FLOAT, avg_speed_kmh INTEGER, travel_time_hr FLOAT,
            capacity_index INTEGER DEFAULT 3, edge_betweenness FLOAT DEFAULT 0, name VARCHAR(255)
        );
        CREATE TABLE IF NOT EXISTS hazard_nodes_latest (
            asset_id VARCHAR(255) PRIMARY KEY, name VARCHAR(255), node_type VARCHAR(50), lat FLOAT, lon FLOAT,
            hazard_flood FLOAT DEFAULT 0, hazard_cyclone FLOAT DEFAULT 0, hazard_strike FLOAT DEFAULT 0, hazard_accident FLOAT DEFAULT 0,
            composite_hazard FLOAT DEFAULT 0, alert_level VARCHAR(20) DEFAULT 'LOW', any_trigger BOOLEAN DEFAULT FALSE,
            trigger_flood BOOLEAN DEFAULT FALSE, trigger_cyclone BOOLEAN DEFAULT FALSE, trigger_strike BOOLEAN DEFAULT FALSE,
            trigger_accident BOOLEAN DEFAULT FALSE, timestamp VARCHAR(50), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS hazard_nodes_log (
            id SERIAL PRIMARY KEY, asset_id VARCHAR(255), composite_hazard FLOAT, alert_level VARCHAR(20), timestamp VARCHAR(50)
        );
        CREATE TABLE IF NOT EXISTS risk_nodes_latest (
            asset_id VARCHAR(255) PRIMARY KEY, name VARCHAR(255), node_type VARCHAR(50), lat FLOAT, lon FLOAT,
            hazard_flood FLOAT DEFAULT 0, hazard_cyclone FLOAT DEFAULT 0, hazard_strike FLOAT DEFAULT 0, hazard_accident FLOAT DEFAULT 0,
            exposure_flood FLOAT DEFAULT 0, exposure_cyclone FLOAT DEFAULT 0, exposure_strike FLOAT DEFAULT 0, exposure_accident FLOAT DEFAULT 0,
            vulnerability_flood FLOAT DEFAULT 0, vulnerability_cyclone FLOAT DEFAULT 0, vulnerability_strike FLOAT DEFAULT 0, vulnerability_accident FLOAT DEFAULT 0,
            risk_flood FLOAT DEFAULT 0, risk_cyclone FLOAT DEFAULT 0, risk_strike FLOAT DEFAULT 0, risk_accident FLOAT DEFAULT 0,
            composite_risk FLOAT DEFAULT 0, network_risk FLOAT DEFAULT 0, risk_tier VARCHAR(20) DEFAULT 'LOW', is_chokepoint BOOLEAN DEFAULT FALSE,
            timestamp VARCHAR(50), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS risk_nodes_log (
            id SERIAL PRIMARY KEY, asset_id VARCHAR(255), composite_risk FLOAT, network_risk FLOAT, risk_tier VARCHAR(20), timestamp VARCHAR(50)
        );
        CREATE TABLE IF NOT EXISTS risk_edges_latest (
            asset_id VARCHAR(255) PRIMARY KEY, from_node VARCHAR(255), to_node VARCHAR(255), mode VARCHAR(50), length_km FLOAT DEFAULT 0,
            risk_flood FLOAT DEFAULT 0, risk_cyclone FLOAT DEFAULT 0, risk_strike FLOAT DEFAULT 0, risk_accident FLOAT DEFAULT 0,
            composite_risk FLOAT DEFAULT 0, network_risk FLOAT DEFAULT 0, risk_tier VARCHAR(20) DEFAULT 'LOW', is_critical_link BOOLEAN DEFAULT FALSE,
            timestamp VARCHAR(50), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS risk_edges_log (
            id SERIAL PRIMARY KEY, asset_id VARCHAR(255), composite_risk FLOAT, risk_tier VARCHAR(20), timestamp VARCHAR(50)
        );
        CREATE TABLE IF NOT EXISTS hazard_kpi_log (
            id SERIAL PRIMARY KEY, timestamp VARCHAR(50), total_nodes INTEGER, total_edges INTEGER, triggered_nodes INTEGER, triggered_edges INTEGER,
            critical_nodes INTEGER, high_nodes INTEGER, flood_triggered_nodes INTEGER, cyclone_triggered_nodes INTEGER, strike_triggered_nodes INTEGER,
            accident_triggered_nodes INTEGER, max_composite_hazard FLOAT, avg_composite_hazard FLOAT, top_risk_asset VARCHAR(255),
            hazard_flood_status VARCHAR(100), hazard_cyclone_status VARCHAR(100), hazard_strike_status VARCHAR(100), hazard_accident_status VARCHAR(100),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS risk_kpis_log (
            id SERIAL PRIMARY KEY, timestamp VARCHAR(50), total_nodes INTEGER, total_edges INTEGER, critical_nodes INTEGER, high_nodes INTEGER,
            medium_nodes INTEGER, low_nodes INTEGER, max_composite_risk FLOAT, avg_composite_risk FLOAT, num_chokepoints INTEGER,
            top_chokepoint VARCHAR(255), num_critical_links INTEGER, scenario_sensitivity FLOAT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)

def clear_tables():
    cursor.execute("""
        TRUNCATE TABLE network_nodes, network_edges, 
        hazard_nodes_latest, hazard_nodes_log, risk_nodes_latest, risk_nodes_log, 
        risk_edges_latest, risk_edges_log, hazard_kpi_log, risk_kpis_log RESTART IDENTITY CASCADE;
    """)

def inject_data():
    # Full Pakistan Dummy Network
    nodes = [
        ('node_khi_port', 'Karachi Seaport', 'port', 66.975, 24.83, 5, 5, 0.9),
        ('node_hyd', 'Hyderabad Junction', 'road_intersection', 68.36, 25.39, 4, 4, 0.8),
        ('node_sukkur', 'Sukkur Logistics Hub', 'dryport', 68.85, 27.70, 5, 4, 0.95),
        ('node_multan', 'Multan Dryport', 'dryport', 71.43, 30.19, 4, 4, 0.7),
        ('node_dadu', 'Dadu Checkpoint', 'road_intersection', 67.77, 26.73, 2, 2, 0.4),
        ('node_larkana', 'Larkana Depot', 'station', 68.21, 27.55, 3, 3, 0.5),
        ('node_dgkhan', 'D.G. Khan Transit', 'road_intersection', 70.63, 30.05, 3, 2, 0.5),
        ('node_lahore', 'Lahore Dryport', 'dryport', 74.35, 31.52, 5, 5, 0.85),
        ('node_isb', 'Islamabad Terminal', 'dryport', 73.04, 33.68, 5, 4, 0.8),
        ('node_pesh', 'Peshawar Hub', 'dryport', 71.52, 34.01, 4, 4, 0.7),
        ('node_quetta', 'Quetta Station', 'station', 66.97, 30.17, 4, 3, 0.6),
        ('node_gwadar', 'Gwadar Port', 'port', 62.33, 25.12, 5, 4, 0.6),
        ('node_chaman', 'Chaman Border', 'border', 66.45, 30.92, 3, 2, 0.4),
        ('node_torkham', 'Torkham Border', 'border', 71.09, 34.12, 3, 3, 0.5),
        ('node_gilgit', 'Gilgit Checkpoint', 'road_intersection', 74.30, 35.92, 2, 1, 0.3),
        ('node_faisalabad', 'Faisalabad Industrial', 'dryport', 73.09, 31.41, 4, 4, 0.7),
        ('node_sialkot', 'Sialkot Export Hub', 'dryport', 74.53, 32.49, 4, 4, 0.6),
        ('node_nawabshah', 'Nawabshah', 'station', 68.39, 26.24, 3, 3, 0.5),
        ('node_sadiqabad', 'Sadiqabad', 'road_intersection', 70.13, 28.30, 3, 3, 0.6),
        ('node_bahawalpur', 'Bahawalpur', 'station', 71.68, 29.39, 3, 3, 0.5)
    ]
    
    edges = [
        ('edge_khi_hyd', 'node_khi_port', 'node_hyd', 160.0),
        ('edge_hyd_nawab', 'node_hyd', 'node_nawabshah', 120.0),
        ('edge_nawab_suk', 'node_nawabshah', 'node_sukkur', 180.0),
        ('edge_suk_sadq', 'node_sukkur', 'node_sadiqabad', 150.0),
        ('edge_sadq_bwp', 'node_sadiqabad', 'node_bahawalpur', 160.0),
        ('edge_bwp_mul', 'node_bahawalpur', 'node_multan', 90.0),
        ('edge_mul_fsd', 'node_multan', 'node_faisalabad', 240.0),
        ('edge_fsd_lhr', 'node_faisalabad', 'node_lahore', 140.0),
        ('edge_lhr_skt', 'node_lahore', 'node_sialkot', 130.0),
        ('edge_lhr_isb', 'node_lahore', 'node_isb', 380.0),
        ('edge_isb_pesh', 'node_isb', 'node_pesh', 180.0),
        ('edge_pesh_torkham', 'node_pesh', 'node_torkham', 50.0),
        ('edge_isb_gilgit', 'node_isb', 'node_gilgit', 500.0),
        ('edge_hyd_dad', 'node_hyd', 'node_dadu', 150.0),
        ('edge_dad_lar', 'node_dadu', 'node_larkana', 110.0),
        ('edge_lar_dgk', 'node_larkana', 'node_dgkhan', 380.0),
        ('edge_dgk_mul', 'node_dgkhan', 'node_multan', 90.0),
        ('edge_khi_gwd', 'node_khi_port', 'node_gwadar', 630.0),
        ('edge_suk_qta', 'node_sukkur', 'node_quetta', 390.0),
        ('edge_qta_chm', 'node_quetta', 'node_chaman', 120.0)
    ]

    for n in nodes:
        cursor.execute(f"INSERT INTO network_nodes (node_id, asset_id, name, node_type, lon, lat, importance_index, handling_capacity_index, betweenness_centrality) VALUES ('{n[0]}', '{n[0]}', '{n[1]}', '{n[2]}', {n[3]}, {n[4]}, {n[5]}, {n[6]}, {n[7]})")
    for e in edges:
        cursor.execute(f"INSERT INTO network_edges (edge_id, asset_id, from_node, to_node, mode, road_type, length_km, travel_time_hr) VALUES ('{e[0]}', '{e[0]}', '{e[1]}', '{e[2]}', 'road', 'primary', {e[3]}, {e[3]/80})")

    # Time-Series Scenarios
    now = datetime.utcnow()
    scenarios = [
        {"time": now - timedelta(hours=6), "suk_haz": 0.10, "tier": "LOW", "status": "Baseline - All Clear"},
        {"time": now - timedelta(hours=4), "suk_haz": 0.45, "tier": "MEDIUM", "status": "Mild - Heavy Rains"},
        {"time": now - timedelta(hours=2), "suk_haz": 0.98, "tier": "CRITICAL", "status": "Extreme - N-5 Flooded"},
        {"time": now,                        "suk_haz": 0.98, "tier": "CRITICAL", "status": "Extreme - Active Rerouting"}
    ]

    for i, s in enumerate(scenarios):
        ts = int(s["time"].timestamp())
        is_latest = (i == len(scenarios) - 1)
        
        c_nodes, h_nodes, m_nodes = 0, 0, 0
        
        for n in nodes:
            a_id = n[0]
            # Sukkur is the epicenter, Hyderabad/Nawabshah are adjacent
            if a_id == 'node_sukkur':
                haz = s["suk_haz"]
                tier = s["tier"]
            elif a_id in ['node_nawabshah', 'node_sadiqabad']:
                haz = s["suk_haz"] * 0.6
                tier = "HIGH" if haz > 0.7 else "MEDIUM" if haz > 0.4 else "LOW"
            else:
                haz = 0.05
                tier = "LOW"
                
            if tier == "CRITICAL": c_nodes += 1
            elif tier == "HIGH": h_nodes += 1
            elif tier == "MEDIUM": m_nodes += 1
            
            choke = (tier == "CRITICAL" and a_id == 'node_sukkur')

            # Log tables
            cursor.execute(f"INSERT INTO hazard_nodes_log (asset_id, composite_hazard, alert_level, timestamp) VALUES ('{a_id}', {haz}, '{tier}', '{ts}')")
            cursor.execute(f"INSERT INTO risk_nodes_log (asset_id, composite_risk, network_risk, risk_tier, timestamp) VALUES ('{a_id}', {haz}, {haz*0.9}, '{tier}', '{ts}')")
            
            if is_latest:
                cursor.execute(f"INSERT INTO hazard_nodes_latest (asset_id, name, node_type, lon, lat, hazard_flood, composite_hazard, alert_level, any_trigger, trigger_flood, timestamp) VALUES ('{a_id}', '{n[1]}', '{n[2]}', {n[3]}, {n[4]}, {haz}, {haz}, '{tier}', {'TRUE' if haz>0.5 else 'FALSE'}, {'TRUE' if haz>0.5 else 'FALSE'}, '{ts}')")
                cursor.execute(f"INSERT INTO risk_nodes_latest (asset_id, name, node_type, lon, lat, composite_risk, risk_tier, is_chokepoint, timestamp) VALUES ('{a_id}', '{n[1]}', '{n[2]}', {n[3]}, {n[4]}, {haz}, '{tier}', {'TRUE' if choke else 'FALSE'}, '{ts}')")

        # Edges
        for e in edges:
            a_id = e[0]
            if a_id in ['edge_nawab_suk', 'edge_suk_sadq']:
                haz = s["suk_haz"]
                tier = s["tier"]
            else:
                haz = 0.05
                tier = "LOW"
                
            cursor.execute(f"INSERT INTO risk_edges_log (asset_id, composite_risk, risk_tier, timestamp) VALUES ('{a_id}', {haz}, '{tier}', '{ts}')")
            if is_latest:
                cursor.execute(f"INSERT INTO risk_edges_latest (asset_id, from_node, to_node, mode, length_km, composite_risk, risk_tier, is_critical_link, timestamp) VALUES ('{a_id}', '{e[1]}', '{e[2]}', 'road', {e[3]}, {haz}, '{tier}', {'TRUE' if tier=='CRITICAL' else 'FALSE'}, '{ts}')")

        # KPIs
        cursor.execute(f"INSERT INTO hazard_kpi_log (timestamp, total_nodes, total_edges, triggered_nodes, critical_nodes, high_nodes, max_composite_hazard) VALUES ('{ts}', {len(nodes)}, {len(edges)}, {c_nodes+h_nodes+m_nodes}, {c_nodes}, {h_nodes}, {s['suk_haz']})")
        cursor.execute(f"INSERT INTO risk_kpis_log (timestamp, total_nodes, total_edges, critical_nodes, high_nodes, medium_nodes, low_nodes, num_chokepoints) VALUES ('{ts}', {len(nodes)}, {len(edges)}, {c_nodes}, {h_nodes}, {m_nodes}, {len(nodes)-c_nodes-h_nodes-m_nodes}, {1 if c_nodes>0 else 0})")

create_tables()
clear_tables()
inject_data()
print("SUCCESS: 20 strategic nodes & 20 routes injected with rich historical time-series data!")
