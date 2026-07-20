from rest_framework import serializers
from .models import HazardNode, HazardEdge, HazardKPI, HazardNodeLog, HazardEdgeLog


class HazardNodeSerializer(serializers.ModelSerializer):
    """
    Serializer for current hazard scores per node
    Used for: hazard dashboard, alert map, asset detail views
    """
    class Meta:
        model = HazardNode
        fields = [
            'asset_id', 'name', 'node_type', 'lat', 'lon',
            'hazard_flood', 'hazard_cyclone', 'hazard_strike', 'hazard_accident',
            'composite_hazard', 'alert_level',
            'any_trigger', 'trigger_flood', 'trigger_cyclone',
            'trigger_strike', 'trigger_accident',
            'timestamp', 'updated_at',
        ]


class HazardNodeLogSerializer(serializers.ModelSerializer):
    """
    Serializer for hazard history - enables time-slider
    Used for: hazard animation, trend analysis
    """
    class Meta:
        model = HazardNodeLog
        fields = ['asset_id', 'composite_hazard', 'alert_level', 'timestamp']


class HazardEdgeSerializer(serializers.ModelSerializer):
    """Serializer for current hazard scores per edge"""
    class Meta:
        model = HazardEdge
        fields = [
            'asset_id', 'mode',
            'hazard_flood', 'hazard_cyclone', 'hazard_strike', 'hazard_accident',
            'composite_hazard', 'alert_level', 'any_trigger', 'strike_index',
            'timestamp', 'updated_at',
        ]


class HazardEdgeLogSerializer(serializers.ModelSerializer):
    """Serializer for hazard edge history"""
    class Meta:
        model = HazardEdgeLog
        fields = ['asset_id', 'composite_hazard', 'alert_level', 'timestamp']


class HazardKPISerializer(serializers.ModelSerializer):
    """
    Serializer for hazard KPI snapshots
    Used for: KPI dashboard, trend analysis, statistics
    """
    class Meta:
        model = HazardKPI
        fields = [
            'timestamp',
            'total_nodes', 'total_edges',
            'triggered_nodes', 'triggered_edges',
            'critical_nodes', 'high_nodes',
            'flood_triggered_nodes', 'cyclone_triggered_nodes',
            'strike_triggered_nodes', 'accident_triggered_nodes',
            'max_composite_hazard', 'avg_composite_hazard',
            'top_risk_asset',
            'hazard_flood_status', 'hazard_cyclone_status',
            'hazard_strike_status', 'hazard_accident_status',
            'created_at',
        ]
