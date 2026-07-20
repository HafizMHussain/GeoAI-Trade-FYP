from rest_framework import serializers
from .models import NetworkNode, NetworkEdge


class NetworkNodeSerializer(serializers.ModelSerializer):
    """
    Serializer for network nodes with all centrality metrics
    Used for: map visualization, network analysis, asset detail views
    """
    class Meta:
        model = NetworkNode
        fields = [
            'asset_id', 'node_id', 'node_type', 'name', 'lon', 'lat',
            'rail_intersection',
            'betweenness_centrality', 'degree_centrality',
            'closeness_centrality',
            'importance_index', 'handling_capacity_index', 'redundancy_index',
        ]


class NetworkEdgeSerializer(serializers.ModelSerializer):
    """
    Serializer for network edges with travel time and capacity
    Used for: route planning, network visualization
    """
    class Meta:
        model = NetworkEdge
        fields = [
            'asset_id', 'edge_id', 'from_node', 'to_node', 'mode', 'road_type',
            'length_km', 'avg_speed_kmh', 'travel_time_hr', 'capacity_index',
            'edge_betweenness', 'name',
        ]

