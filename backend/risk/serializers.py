from rest_framework import serializers
from .models import RiskNode, RiskEdge, RiskKPI, RiskNodeLog, RiskEdgeLog


class RiskNodeSerializer(serializers.ModelSerializer):
    """
    Serializer for current risk scores per node
    Used for: risk dashboard, chokepoint identification, scenario planning
    
    Formula: Risk = Hazard × Exposure × Vulnerability (UNDRR)
    """
    class Meta:
        model = RiskNode
        fields = [
            'asset_id', 'name', 'node_type', 'lat', 'lon',
            'hazard_flood', 'hazard_cyclone', 'hazard_strike', 'hazard_accident',
            'exposure_flood', 'exposure_cyclone', 'exposure_strike', 'exposure_accident',
            'vulnerability_flood', 'vulnerability_cyclone', 'vulnerability_strike', 'vulnerability_accident',
            'risk_flood', 'risk_cyclone', 'risk_strike', 'risk_accident',
            'composite_risk', 'network_risk', 'risk_tier',
            'is_chokepoint', 'timestamp', 'updated_at',
        ]


class RiskNodeLogSerializer(serializers.ModelSerializer):
    """
    Serializer for risk history - enables time-slider
    Used for: risk animation, trend analysis
    """
    class Meta:
        model = RiskNodeLog
        fields = ['asset_id', 'composite_risk', 'network_risk', 'risk_tier', 'timestamp']


class RiskEdgeSerializer(serializers.ModelSerializer):
    """Serializer for current risk scores per edge"""
    class Meta:
        model = RiskEdge
        fields = [
            'asset_id', 'from_node', 'to_node', 'mode', 'length_km',
            'risk_flood', 'risk_cyclone', 'risk_strike', 'risk_accident',
            'composite_risk', 'network_risk', 'risk_tier',
            'is_critical_link', 'timestamp', 'updated_at',
        ]


class RiskEdgeLogSerializer(serializers.ModelSerializer):
    """Serializer for risk edge history"""
    class Meta:
        model = RiskEdgeLog
        fields = ['asset_id', 'composite_risk', 'risk_tier', 'timestamp']


class RiskKPISerializer(serializers.ModelSerializer):
    """
    Serializer for risk KPI snapshots
    Used for: KPI dashboard, risk metrics, scenario sensitivity
    """
    class Meta:
        model = RiskKPI
        fields = [
            'timestamp',
            'total_nodes', 'total_edges',
            'critical_nodes', 'high_nodes', 'medium_nodes', 'low_nodes',
            'max_composite_risk', 'avg_composite_risk',
            'num_chokepoints', 'top_chokepoint',
            'num_critical_links',
            'scenario_sensitivity',
            'created_at',
        ]
