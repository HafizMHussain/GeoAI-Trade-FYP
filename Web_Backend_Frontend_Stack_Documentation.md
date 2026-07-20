# GeoResilience Platform Web Stack Documentation

## 1) Scope
This document summarizes the complete web technology stack for the current repository, covering:
- Backend web application stack
- Frontend web application stack
- API architecture and integration
- Data and infrastructure dependencies
- Environment and runtime configuration
- Libraries declared versus actively used

Source of truth is the current codebase under backend and frontend.

## 2) System Architecture (Web Layer)
The web application is split into two apps:
- Backend: Django + Django REST Framework API service exposing geospatial and analytics endpoints.
- Frontend: React SPA (Vite) consuming backend JSON endpoints and rendering operational dashboards and route planning maps.

High-level flow:
1. Frontend requests API endpoints under /api.
2. Django views read from PostgreSQL/PostGIS tables produced by data pipelines.
3. Backend returns JSON and GeoJSON (FeatureCollection) payloads.
4. Frontend renders statistics, charts, and map layers (MapLibre + MapTiler tiles).

## 3) Backend Stack (backend)

### 3.1 Core Frameworks and Runtime
- Python backend based on Django 4.2+.
- REST API layer via Django REST Framework.
- CORS support via django-cors-headers.
- Pagination/filtering enabled through DRF + django-filter backend setting.

Primary files:
- backend/manage.py
- backend/config/settings.py
- backend/config/urls.py
- backend/config/api_views.py

### 3.2 Backend Python Dependencies (Declared)
From backend/requirements.txt:
- Django>=4.2.0
- djangorestframework>=3.14.0
- django-cors-headers>=4.0.0
- psycopg2-binary>=2.9.6
- psycopg[binary]>=3.0.0
- networkx>=3.1
- python-dotenv>=1.0.0
- gunicorn>=21.2.0
- requests>=2.31.0

### 3.3 Backend Libraries Referenced in Code
In backend/config/api_views.py and app modules, code also references:
- networkx (routing, graph computations)
- pandas (used in optional rail connectivity path)
- geopandas (used in optional rail connectivity path)
- subprocess, pickle, threading, dataclasses, typing (Python stdlib and utilities)

Note:
- settings.py enables django_filters in INSTALLED_APPS and DRF filter backends.
- backend/requirements.txt does not currently include django-filter explicitly.

### 3.4 Data Layer and Persistence
- Database engine: PostgreSQL (configured in Django settings).
- Geospatial source tables are PostGIS-backed and read via SQL + GeoJSON conversion.
- Django models in network, hazard, and risk apps are mostly unmanaged (managed = False), meaning pipeline jobs own schema and writes.

Representative tables used by web API:
- network_nodes, network_edges
- hazard_nodes_latest, hazard_edges_latest
- risk_nodes_latest, risk_edges_latest
- hazard_nodes_log, hazard_edges_log
- risk_nodes_log, risk_edges_log
- hazard_kpi_log, risk_kpis_log
- kpis_log, baseline_* analytics tables

### 3.5 Backend API Surface
Main endpoint groups in backend/config/urls.py:
- /api/network/*
- /api/hazard/*
- /api/risk/*
- /api/kpis/*
- /api/history/*
- /api/scenario/*
- /api/assets/*
- /api/nodes/combined and /api/edges/combined

There are two API styles present:
- Requirement-aligned function endpoints in config/api_views.py (primary path currently used by frontend).
- Legacy DRF router viewsets under /api/v1/* for backward compatibility.

### 3.6 Backend Apps and Domain Responsibilities
- network app: topology, nodes/edges, graph and criticality context.
- hazard app: multi-hazard latest scores, alerts, logs, and hazard KPI history.
- risk app: computed risk layer (H × E × V), chokepoints, logs, risk KPI history.

## 4) Frontend Stack (frontend)

### 4.1 Core Frameworks and Build Tooling
- React 18 SPA.
- Vite 4 build/dev server.
- React Router v6 for page routing.
- TanStack React Query for server-state fetching and caching.
- Axios for HTTP client abstraction.

Primary files:
- frontend/package.json
- frontend/src/main.jsx
- frontend/src/App.jsx
- frontend/src/api/networkApi.js
- frontend/vite.config.js

### 4.2 Frontend Dependencies (Declared)
From frontend/package.json:
- react, react-dom
- react-router-dom
- @tanstack/react-query
- axios
- recharts
- maplibre-gl
- react-map-gl
- @deck.gl/react
- @deck.gl/layers
- resium
- cesium
- zustand
- tailwindcss

Dev dependencies:
- vite
- @vitejs/plugin-react
- postcss
- autoprefixer

### 4.3 Frontend Libraries Actively Used in Source
Actively used in frontend/src:
- react, react-dom
- react-router-dom
- @tanstack/react-query
- axios
- maplibre-gl
- recharts
- tailwindcss classes and custom tokens

Declared but not currently imported in frontend/src (current scan):
- zustand
- react-map-gl
- @deck.gl/react
- @deck.gl/layers
- resium
- cesium

Note:
- frontend/.env contains a VITE_CESIUM_TOKEN, but Cesium/Resium imports are not currently active in source files.

### 4.4 Frontend UI and Map Stack
- Styling: Tailwind CSS + project tokens/colors.
- Charts: Recharts in dashboard and analytics pages.
- Mapping: MapLibre GL rendering with MapTiler style URL tiles.
- Route Planner, Dashboard, Network Analysis, Scenario Simulator, and Asset Profile include map-driven UI.

### 4.5 Frontend Routes
Defined pages in App routing:
- /
- /map
- /dashboard
- /routes
- /scenario
- /asset/:asset_id

## 5) Frontend-Backend Integration

### 5.1 API Base URL and Proxy
- Frontend client base URL: VITE_API_URL, default http://localhost:8000/api.
- Vite dev proxy forwards /api to http://localhost:8000.

### 5.2 API Client Organization
frontend/src/api/networkApi.js provides grouped clients:
- networkApi
- combinedApi
- hazardApi
- riskApi
- assetApi
- kpiApi
- historyApi
- scenarioApi

This gives a clear modular boundary between UI pages and backend endpoint groups.

## 6) Environment and Configuration Variables

### 6.1 Backend Environment Variables (from backend/.env + settings.py)
- SECRET_KEY
- DEBUG
- DB_NAME
- DB_USER
- DB_PASSWORD
- DB_HOST
- DB_PORT
- DB_ENGINE
- USE_POSTGIS
- FRONTEND_URL

### 6.2 Frontend Environment Variables (from frontend/.env + source usage)
- VITE_API_URL
- VITE_MAPTILER_KEY
- VITE_CESIUM_TOKEN

Security note:
- Repository-local .env files currently contain real-looking credentials/tokens. For production and secure collaboration, move secrets to untracked secret management and rotate exposed keys.

## 7) Operational Commands

### 7.1 Frontend
Defined scripts in package.json:
- npm run dev
- npm run build
- npm run preview

### 7.2 Backend
Django entrypoint:
- python manage.py runserver

Production serving dependency present:
- gunicorn is declared in backend requirements.

## 8) Data Pipeline Coupling
The web apps are tightly integrated with pipeline-produced data:
- Network baseline outputs feed topology and travel-time endpoints.
- Hazard pipeline outputs feed live hazard scores and alerts.
- Risk engine outputs feed risk tiers, chokepoints, and risk KPIs.

Django models are intentionally unmanaged for these tables, indicating the pipeline layer is the schema owner.

## 9) Quick Inventory Summary
- Backend framework: Django + DRF
- Backend database: PostgreSQL/PostGIS
- Backend analytics core: NetworkX graph routing + SQL-driven aggregation
- Frontend framework: React + Vite
- Frontend data layer: Axios + React Query
- Frontend mapping: MapLibre GL + MapTiler
- Frontend charting: Recharts
- Styling: Tailwind CSS + custom design tokens
- Domain modules: Network, Hazard, Risk, Scenario, Assets, KPI History

## 10) Recommended Cleanup Backlog (Optional)
- Add django-filter to backend/requirements.txt for environment parity with settings.
- Confirm whether Cesium, Deck.gl, react-map-gl, and Zustand are planned; remove unused packages if not needed.
- Move sensitive values from committed/local .env usage to secure secrets handling and rotate any leaked tokens.
- Add a short README section linking this document for onboarding.
