# GeoAI Trade — Trade-Network Resilience Platform

**Live demo:** https://geo-ai-trade-fyp.vercel.app

When a flood takes out a stretch of the N-5, what actually happens to the goods moving between Karachi and Lahore? Which routes still work, which hubs become choke points, and how much slower does everything get? This platform is my attempt to answer those questions on a live map instead of a spreadsheet.

It pulls hazard signals (floods, cyclones, strikes, accidents), lays them over Pakistan's trade and logistics network, scores the risk on every node and edge, and then lets you play out "what if this link goes down" scenarios to see how freight would reroute.

This is my final year project.

---

## What it does

- **Live risk map** — every hub and road segment is coloured by a composite risk score, so critical points jump out at a glance.
- **Hazard overlays** — flood, cyclone, strike, and accident signals are aggregated into a single alert picture.
- **Choke-point detection** — flags the handful of nodes that, if they fail, hurt the network most (Sukkur, for example, sitting on the main north–south corridor).
- **Scenario simulation** — knock out a route or a hub and watch the network recompute the safest alternative path and the delay it costs.
- **Route planning** — compares the primary corridor (N-5) against the safer-but-longer alternative (N-55) when the main line is disrupted.
- **3D globe view** — a Cesium-based globe for a wider geographic picture.

## Tech stack

**Frontend**
- React 18 + Vite
- MapLibre GL + deck.gl for the 2D maps, Resium/Cesium for the 3D globe
- Recharts for the dashboards, Zustand for state, Tailwind for styling

**Backend / data**
- Django + Django REST Framework, PostgreSQL + PostGIS
- Python data pipelines (`pipelines/`) that fetch live hazard data (GDACS, Open-Meteo) and compute UNDRR-style risk = hazard × exposure × vulnerability
- A lightweight Express mock backend for demos and for the hosted deployment

## How it's deployed

The live site runs entirely on **Vercel**: the Vite frontend is served as a static build, and the API is a small **serverless function** (`frontend/api/index.js`) that returns the same shape of data the Django backend produces. That keeps the demo fully self-contained — there's no separate server to keep running.

The full Django + PostGIS backend is meant for a proper host (AWS EC2/RDS, Render, or similar) when you want the live pipelines running. See [`deployment_guide.md`](./deployment_guide.md) for that path.

---

## Running it locally

You'll need **Node.js** and (for the real backend) **Python 3.11+** with PostgreSQL/PostGIS.

### Quick way — frontend + mock backend

This is all you need to click around the whole app with realistic data.

```bash
# 1. Start the mock API (serves on port 8000 by default)
cd mock-backend
npm install
node server.js

# 2. In another terminal, start the frontend
cd frontend
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

> If port 8000 is taken, run the mock backend on another port with
> `PORT=8123 node server.js` and set `VITE_API_URL=http://localhost:8123/api`
> in `frontend/.env`.

### Full backend (Django + PostGIS)

```bash
cd backend
python -m venv venv
# Windows:  venv\Scripts\activate
# macOS/Linux:  source venv/bin/activate
pip install -r requirements.txt

# copy the example env and fill in your values
cp ../.env.example .env

python manage.py migrate
python manage.py runserver
```

The data pipelines live in `pipelines/` and can run on a schedule (every 15 minutes) to refresh hazard and risk data — details in the deployment guide.

## Environment variables

Copy `.env.example` to `.env` and fill in what you need. The important ones:

| Variable | What it's for |
|----------|---------------|
| `VITE_API_URL` | Where the frontend looks for the API (`/api` in production) |
| `VITE_MAPTILER_KEY` | MapTiler map tiles (client-side, restrict by domain) |
| `VITE_CESIUM_TOKEN` | Cesium Ion token for the 3D globe |
| `SECRET_KEY` | Django secret |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` / `DB_HOST` | PostgreSQL connection |
| `GROQ_API_KEY` | LLM API key (server-side only) |

The `VITE_`-prefixed keys get baked into the browser build, so treat them as public and lock them down by domain in their dashboards. Never put real secrets there.

## Project layout

```
.
├── frontend/         # React + Vite app (and the Vercel serverless API in /api)
├── backend/          # Django REST API
├── pipelines/        # Hazard + risk data pipelines
├── mock-backend/     # Express mock API for local demos
├── deployment_guide.md
└── docker-compose.yml
```

---

Built as a final year project. Feedback and questions are welcome.
