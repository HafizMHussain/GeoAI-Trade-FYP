from rest_framework import viewsets, filters
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.pagination import PageNumberPagination
from django.db.models import Q, Count, Avg, Max, Min
from .models import NetworkNode, NetworkEdge
from .serializers import NetworkNodeSerializer, NetworkEdgeSerializer


class NetworkNodeViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = NetworkNode.objects.all()
    serializer_class = NetworkNodeSerializer
    pagination_class = PageNumberPagination
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'asset_id']
    ordering_fields = ['betweenness_centrality', 'degree_centrality', 'importance_index']
    ordering = ['-betweenness_centrality']
    
    def get_queryset(self):
        queryset = NetworkNode.objects.all()
        node_type = self.request.query_params.get('node_type')
        if node_type:
            types = node_type.split(',')
            queryset = queryset.filter(node_type__in=types)
        return queryset
    
    @action(detail=False, methods=['get'])
    def summary(self, request):
        stats = NetworkNode.objects.aggregate(
            total=Count('asset_id'),
            avg_betweenness=Avg('betweenness_centrality'),
            max_betweenness=Max('betweenness_centrality'),
            avg_degree=Avg('degree_centrality'),
        )
        return Response(stats)


class NetworkEdgeViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = NetworkEdge.objects.all()
    serializer_class = NetworkEdgeSerializer
    pagination_class = PageNumberPagination
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['asset_id', 'from_node', 'to_node', 'name']
    ordering_fields = ['travel_time_hr', 'edge_betweenness', 'length_km']
    ordering = ['-edge_betweenness']
    
    def get_queryset(self):
        queryset = NetworkEdge.objects.all()
        mode = self.request.query_params.get('mode')
        if mode:
            modes = mode.split(',')
            queryset = queryset.filter(mode__in=modes)
        from_node = self.request.query_params.get('from_node')
        to_node = self.request.query_params.get('to_node')
        if from_node:
            queryset = queryset.filter(from_node=from_node)
        if to_node:
            queryset = queryset.filter(to_node=to_node)
        return queryset

