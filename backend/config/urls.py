from django.urls import path, include, re_path
from rest_framework.routers import DefaultRouter

from config import api_views

# Legacy DRF viewsets (kept for backward compatibility)
from network.views import NetworkNodeViewSet, NetworkEdgeViewSet
from hazard.views import (
    HazardNodeViewSet,
    HazardEdgeViewSet,
    HazardKPIViewSet,
    HazardNodeLogViewSet,
    HazardEdgeLogViewSet,
)
from risk.views import (
    RiskNodeViewSet,
    RiskEdgeViewSet,
    RiskKPIViewSet,
    RiskNodeLogViewSet,
    RiskEdgeLogViewSet,
)

# DRF Router for viewsets
router = DefaultRouter()

# Network endpoints
router.register(r'api/v1/network/nodes', NetworkNodeViewSet, basename='network-node')
router.register(r'api/v1/network/edges', NetworkEdgeViewSet, basename='network-edge')

# Hazard endpoints
router.register(r'api/v1/hazard/nodes', HazardNodeViewSet, basename='hazard-node')
router.register(r'api/v1/hazard/nodes-log', HazardNodeLogViewSet, basename='hazard-node-log')
router.register(r'api/v1/hazard/edges', HazardEdgeViewSet, basename='hazard-edge')
router.register(r'api/v1/hazard/edges-log', HazardEdgeLogViewSet, basename='hazard-edge-log')
router.register(r'api/v1/hazard/kpi', HazardKPIViewSet, basename='hazard-kpi')

# Risk endpoints
router.register(r'api/v1/risk/nodes', RiskNodeViewSet, basename='risk-node')
router.register(r'api/v1/risk/nodes-log', RiskNodeLogViewSet, basename='risk-node-log')
router.register(r'api/v1/risk/edges', RiskEdgeViewSet, basename='risk-edge')
router.register(r'api/v1/risk/edges-log', RiskEdgeLogViewSet, basename='risk-edge-log')
router.register(r'api/v1/risk/kpi', RiskKPIViewSet, basename='risk-kpi')

urlpatterns = [
    # Requirement-aligned API (no version prefix)
    re_path(r'^api/network/nodes/?$', api_views.network_nodes),
    re_path(r'^api/network/edges/?$', api_views.network_edges),
    re_path(r'^api/network/metrics/?$', api_views.network_metrics),
    re_path(r'^api/network/criticality/?$', api_views.network_criticality),
    re_path(r'^api/network/corridor-times/?$', api_views.network_corridor_times),
    re_path(r'^api/network/shortest-path/?$', api_views.network_shortest_path),
    re_path(r'^api/network/alternate-routes/?$', api_views.network_alternate_routes),
    re_path(r'^api/network/advanced-routes/?$', api_views.network_advanced_routes),
    re_path(r'^api/network/disruption-impact/?$', api_views.network_disruption_impact),
    re_path(r'^api/network/pakistan-boundary/?$', api_views.pakistan_boundary),
    re_path(r'^api/network/rail-connectivity/?$', api_views.rail_connectivity),

    re_path(r'^api/hazard/nodes/?$', api_views.hazard_nodes),
    re_path(r'^api/hazard/edges/?$', api_views.hazard_edges),
    re_path(r'^api/hazard/summary/?$', api_views.hazard_summary),
    re_path(r'^api/hazard/alerts/?$', api_views.hazard_alerts),
    re_path(r'^api/hazard/kpi-history/?$', api_views.hazard_kpi_history),
    re_path(r'^api/hazard/run/?$', api_views.hazard_run),

    re_path(r'^api/risk/nodes/?$', api_views.risk_nodes),
    re_path(r'^api/risk/edges/?$', api_views.risk_edges),
    re_path(r'^api/risk/summary/?$', api_views.risk_summary),

    re_path(r'^api/kpis/latest/?$', api_views.kpis_latest),
    re_path(r'^api/kpis/history/?$', api_views.kpis_history),

    re_path(r'^api/history/nodes/?$', api_views.history_nodes),
    re_path(r'^api/history/edges/?$', api_views.history_edges),
    re_path(r'^api/history/timestamps/?$', api_views.history_timestamps),

    re_path(r'^api/scenario/run/?$', api_views.scenario_run),
    re_path(r'^api/scenario/pipeline-results/?$', api_views.scenario_pipeline_results),
    re_path(r'^api/scenario/corridors/?$', api_views.scenario_corridors),
    re_path(r'^api/scenario/montecarlo/?$', api_views.scenario_montecarlo),
    re_path(r'^api/scenario/recovery/?$', api_views.scenario_recovery),
    re_path(r'^api/scenario/economic/?$', api_views.scenario_economic),
    re_path(r'^api/chat/?$', api_views.chat_view),

    re_path(r'^api/assets/?$', api_views.assets_list),
    re_path(r'^api/assets/(?P<asset_id>[^/]+)/?$', api_views.asset_detail),
    re_path(r'^api/assets/(?P<asset_id>[^/]+)/reachability/?$', api_views.asset_reachability),

    # Combined (network + hazard + risk joined)
    re_path(r'^api/nodes/combined/?$', api_views.combined_nodes),
    re_path(r'^api/edges/combined/?$', api_views.combined_edges),

    # Risk analytics
    re_path(r'^api/risk/distribution/?$', api_views.risk_distribution),
    re_path(r'^api/risk/chokepoints/?$', api_views.top_chokepoints),
    re_path(r'^api/risk/kpi-history/?$', api_views.risk_kpi_history),

    # Legacy endpoints
    path('', include(router.urls)),
]
