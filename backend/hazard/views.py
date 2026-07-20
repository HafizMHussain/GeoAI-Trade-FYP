from rest_framework import viewsets, filters
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.pagination import PageNumberPagination
from django.db.models import Count, Avg, Max, Q
from .models import HazardNode, HazardEdge, HazardKPI, HazardNodeLog, HazardEdgeLog
from .serializers import (
    HazardNodeSerializer, HazardEdgeSerializer, HazardKPISerializer,
    HazardNodeLogSerializer, HazardEdgeLogSerializer
)


class HazardNodeViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = HazardNode.objects.all()
    serializer_class = HazardNodeSerializer
    pagination_class = PageNumberPagination
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'asset_id']
    ordering_fields = ['composite_hazard', 'alert_level']
    ordering = ['-composite_hazard']
    
    def get_queryset(self):
        queryset = HazardNode.objects.all()
        alert_level = self.request.query_params.get('alert_level')
        if alert_level:
            levels = alert_level.split(',')
            queryset = queryset.filter(alert_level__in=levels)
        triggered = self.request.query_params.get('triggered')
        if triggered and triggered.lower() == 'true':
            queryset = queryset.filter(any_trigger=True)
        hazard_type = self.request.query_params.get('hazard_type')
        if hazard_type == 'flood':
            queryset = queryset.filter(trigger_flood=True)
        elif hazard_type == 'cyclone':
            queryset = queryset.filter(trigger_cyclone=True)
        elif hazard_type == 'strike':
            queryset = queryset.filter(trigger_strike=True)
        elif hazard_type == 'accident':
            queryset = queryset.filter(trigger_accident=True)
        return queryset
    
    @action(detail=False, methods=['get'])
    def summary(self, request):
        stats = HazardNode.objects.aggregate(
            total_nodes=Count('asset_id'),
            avg_composite_hazard=Avg('composite_hazard'),
            max_composite_hazard=Max('composite_hazard'),
            triggered_nodes=Count('asset_id', filter=Q(any_trigger=True)),
            critical_nodes=Count('asset_id', filter=Q(alert_level='CRITICAL')),
            high_nodes=Count('asset_id', filter=Q(alert_level='HIGH')),
        )
        return Response(stats)


class HazardNodeLogViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = HazardNodeLog.objects.all().order_by('timestamp')
    serializer_class = HazardNodeLogSerializer
    pagination_class = PageNumberPagination


class HazardEdgeViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = HazardEdge.objects.all()
    serializer_class = HazardEdgeSerializer
    pagination_class = PageNumberPagination
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['asset_id']
    ordering = ['-composite_hazard']


class HazardEdgeLogViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = HazardEdgeLog.objects.all().order_by('timestamp')
    serializer_class = HazardEdgeLogSerializer
    pagination_class = PageNumberPagination


class HazardKPIViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = HazardKPI.objects.all()
    serializer_class = HazardKPISerializer
    pagination_class = PageNumberPagination
    ordering = ['-created_at']
    
    @action(detail=False, methods=['get'])
    def latest(self, request):
        latest_kpi = HazardKPI.objects.latest('created_at')
        serializer = HazardKPISerializer(latest_kpi)
        return Response(serializer.data)
