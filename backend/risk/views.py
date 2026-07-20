from rest_framework import viewsets, filters
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.pagination import PageNumberPagination
from django.db.models import Q, Count, Avg, Max
from .models import RiskNode, RiskEdge, RiskKPI, RiskNodeLog, RiskEdgeLog
from .serializers import (
    RiskNodeSerializer, RiskEdgeSerializer, RiskKPISerializer,
    RiskNodeLogSerializer, RiskEdgeLogSerializer
)


class RiskNodeViewSet(viewsets.ReadOnlyModelViewSet):
    """
    API endpoint for CURRENT risk scores per node
    
    From SCRIPT 3 (risk_engine.py) - refreshed every 2 hours
    Formula: Risk = Hazard × Exposure × Vulnerability (UNDRR Framework)
    
    Features:
    - Filter by risk tier: ?risk_tier=CRITICAL,HIGH
    - Find chokepoints: ?is_chokepoint=true
    - Search by name/asset_id: ?search=karachi
    - Order by network_risk: ?ordering=-network_risk
    
    Used for: Risk dashboard, chokepoint identification, scenario planning
    """
    queryset = RiskNode.objects.all()
    serializer_class = RiskNodeSerializer
    pagination_class = PageNumberPagination
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'asset_id']
    ordering_fields = ['composite_risk', 'network_risk', 'risk_tier']
    ordering = ['-network_risk']
    
    def get_queryset(self):
        queryset = RiskNode.objects.all()
        
        # Filter by risk tier
        risk_tier = self.request.query_params.get('risk_tier')
        if risk_tier:
            tiers = risk_tier.split(',')
            queryset = queryset.filter(risk_tier__in=tiers)
        
        # Find chokepoints
        chokepoint = self.request.query_params.get('chokepoint')
        if chokepoint and chokepoint.lower() == 'true':
            queryset = queryset.filter(is_chokepoint=True)
        
        return queryset
    
    @action(detail=False, methods=['get'])
    def summary(self, request):
        """Risk statistics across all nodes"""
        stats = RiskNode.objects.aggregate(
            total_nodes=Count('asset_id'),
            avg_composite_risk=Avg('composite_risk'),
            max_composite_risk=Max('composite_risk'),
            avg_network_risk=Avg('network_risk'),
            critical_nodes=Count('asset_id', filter=Q(risk_tier='CRITICAL')),
            high_nodes=Count('asset_id', filter=Q(risk_tier='HIGH')),
            medium_nodes=Count('asset_id', filter=Q(risk_tier='MEDIUM')),
            low_nodes=Count('asset_id', filter=Q(risk_tier='LOW')),
            chokepoints=Count('asset_id', filter=Q(is_chokepoint=True)),
        )
        return Response(stats)
    
    @action(detail=False, methods=['get'])
    def chokepoints(self, request):
        """Get all identified chokepoints"""
        chokepoints = RiskNode.objects.filter(is_chokepoint=True).order_by('-network_risk')
        serializer = RiskNodeSerializer(chokepoints, many=True)
        return Response(serializer.data)
    
    @action(detail=False, methods=['get'])
    def timeline(self, request):
        """Historical risk data for time-slider"""
        asset_id = request.query_params.get('asset_id')
        if not asset_id:
            return Response({'error': 'asset_id required'}, status=400)
        
        logs = RiskNodeLog.objects.filter(asset_id=asset_id).order_by('timestamp')
        serializer = RiskNodeLogSerializer(logs, many=True)
        return Response(serializer.data)


class RiskNodeLogViewSet(viewsets.ReadOnlyModelViewSet):
    """Historical risk data - enables time-slider animations"""
    queryset = RiskNodeLog.objects.all().order_by('timestamp')
    serializer_class = RiskNodeLogSerializer
    pagination_class = PageNumberPagination


class RiskEdgeViewSet(viewsets.ReadOnlyModelViewSet):
    """
    API endpoint for CURRENT risk scores per edge
    From SCRIPT 3 - refreshed every 2 hours
    """
    queryset = RiskEdge.objects.all()
    serializer_class = RiskEdgeSerializer
    pagination_class = PageNumberPagination
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['asset_id']
    ordering = ['-composite_risk']
    
    def get_queryset(self):
        queryset = RiskEdge.objects.all()
        
        # Filter by risk tier
        risk_tier = self.request.query_params.get('risk_tier')
        if risk_tier:
            tiers = risk_tier.split(',')
            queryset = queryset.filter(risk_tier__in=tiers)
        
        # Critical links only
        critical = self.request.query_params.get('critical')
        if critical and critical.lower() == 'true':
            queryset = queryset.filter(is_critical_link=True)
        
        return queryset


class RiskEdgeLogViewSet(viewsets.ReadOnlyModelViewSet):
    """Historical risk edge data"""
    queryset = RiskEdgeLog.objects.all().order_by('timestamp')
    serializer_class = RiskEdgeLogSerializer
    pagination_class = PageNumberPagination


class RiskKPIViewSet(viewsets.ReadOnlyModelViewSet):
    """
    KPI time series from all SCRIPT 3 runs
    Each record = one risk engine execution snapshot
    Tracks: critical nodes, chokepoints, risk distribution
    Used for: Risk metrics, trend analysis, scenario sensitivity
    """
    queryset = RiskKPI.objects.all()
    serializer_class = RiskKPISerializer
    pagination_class = PageNumberPagination
    ordering = ['-created_at']
    
    @action(detail=False, methods=['get'])
    def latest(self, request):
        """Get most recent KPI snapshot"""
        latest_kpi = RiskKPI.objects.latest('created_at')
        serializer = RiskKPISerializer(latest_kpi)
        return Response(serializer.data)
