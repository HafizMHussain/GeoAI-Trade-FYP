from django.db import models

class RiskNode(models.Model):
    """
    Risk scores per node from SCRIPT 3 (risk_engine.py)
    LATEST state: replaced each run
    
    Formula: Risk = Hazard × Exposure × Vulnerability (UNDRR Framework)
    
    Database source: risk_nodes_latest table (PostGIS)
    Written by: risk_engine.py (recurring: every 2 hours after hazard)
    
    Components:
    - Hazard: from hazard_model.py (4 types)
    - Exposure: importance × connectivity
    - Vulnerability: asset-type specific susceptibility
    """
    asset_id = models.CharField(max_length=255, primary_key=True)
    name = models.CharField(max_length=255, null=True, blank=True)
    node_type = models.CharField(max_length=50, null=True, blank=True)
    lat = models.FloatField(default=0)
    lon = models.FloatField(default=0)
    
    # Hazard scores (from hazard_model.py)
    hazard_flood = models.FloatField(default=0)
    hazard_cyclone = models.FloatField(default=0)
    hazard_strike = models.FloatField(default=0)
    hazard_accident = models.FloatField(default=0)
    
    # Exposure (how much of asset is in hazard zone)
    exposure_flood = models.FloatField(default=0)
    exposure_cyclone = models.FloatField(default=0)
    exposure_strike = models.FloatField(default=0)
    exposure_accident = models.FloatField(default=0)
    
    # Vulnerability (susceptibility to damage)
    vulnerability_flood = models.FloatField(default=0)
    vulnerability_cyclone = models.FloatField(default=0)
    vulnerability_strike = models.FloatField(default=0)
    vulnerability_accident = models.FloatField(default=0)
    
    # Risk scores (H × E × V)
    risk_flood = models.FloatField(default=0)
    risk_cyclone = models.FloatField(default=0)
    risk_strike = models.FloatField(default=0)
    risk_accident = models.FloatField(default=0)
    
    # Composite risk (Noisy-OR: max natural + max human)
    composite_risk = models.FloatField(default=0, help_text="0-1, aggregated multi-hazard risk")
    
    # Network criticality (asset risk × centrality importance)
    network_risk = models.FloatField(default=0, help_text="Risk weighted by centrality")
    
    # Risk tiering
    risk_tier = models.CharField(
        max_length=20,
        default='LOW',
        choices=[
            ('CRITICAL', 'Critical - Immediate action required'),
            ('HIGH', 'High - Close monitoring'),
            ('MEDIUM', 'Medium - Watch list'),
            ('LOW', 'Low - Acceptable'),
        ]
    )
    
    # Chokepoint flag (critical + high centrality)
    is_chokepoint = models.BooleanField(default=False, help_text="High risk + high centrality")
    
    # Metadata
    timestamp = models.CharField(max_length=50, null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'risk_nodes_latest'
        managed = False  # Pipeline owns this table
        verbose_name = 'Risk Node (Latest)'
        verbose_name_plural = 'Risk Nodes (Latest)'
        indexes = [
            models.Index(fields=['composite_risk']),
            models.Index(fields=['risk_tier']),
            models.Index(fields=['is_chokepoint']),
        ]
    
    def __str__(self):
        return f"{self.asset_id} - {self.risk_tier}"


class RiskNodeLog(models.Model):
    """
    Historical risk scores per node - APPENDED each run
    Enables time-slider on dashboard for risk animation
    """
    asset_id = models.CharField(max_length=255)
    composite_risk = models.FloatField()
    network_risk = models.FloatField()
    risk_tier = models.CharField(max_length=20)
    timestamp = models.CharField(max_length=50)
    
    class Meta:
        db_table = 'risk_nodes_log'
        managed = False
        verbose_name = 'Risk Node Log'
        verbose_name_plural = 'Risk Node Logs'


class RiskEdge(models.Model):
    """
    Risk scores per edge from SCRIPT 3 (risk_engine.py)
    LATEST state: replaced each run
    
    Formula: Risk = Hazard × Exposure × Vulnerability (UNDRR Framework)
    
    Database source: risk_edges_latest table (PostGIS)
    Written by: risk_engine.py (recurring: every 2 hours after hazard)
    """
    asset_id = models.CharField(max_length=255, primary_key=True)
    from_node = models.CharField(max_length=255)
    to_node = models.CharField(max_length=255)
    mode = models.CharField(max_length=50, null=True, blank=True)
    length_km = models.FloatField(default=0)
    
    # Individual risk scores
    risk_flood = models.FloatField(default=0)
    risk_cyclone = models.FloatField(default=0)
    risk_strike = models.FloatField(default=0)
    risk_accident = models.FloatField(default=0)
    
    # Composite and tiering
    composite_risk = models.FloatField(default=0)
    network_risk = models.FloatField(default=0)
    
    risk_tier = models.CharField(
        max_length=20,
        default='LOW',
        choices=[
            ('CRITICAL', 'Critical'),
            ('HIGH', 'High'),
            ('MEDIUM', 'Medium'),
            ('LOW', 'Low'),
        ]
    )
    
    # Criticality (high-risk + high-betweenness)
    is_critical_link = models.BooleanField(default=False)
    
    # Metadata
    timestamp = models.CharField(max_length=50, null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'risk_edges_latest'
        managed = False  # Pipeline owns this table
        verbose_name = 'Risk Edge (Latest)'
        verbose_name_plural = 'Risk Edges (Latest)'
    
    def __str__(self):
        return f"{self.asset_id} - {self.risk_tier}"


class RiskEdgeLog(models.Model):
    """
    Historical risk scores per edge - APPENDED each run
    Enables time-slider on dashboard for risk animation
    """
    asset_id = models.CharField(max_length=255)
    composite_risk = models.FloatField()
    risk_tier = models.CharField(max_length=20)
    timestamp = models.CharField(max_length=50)
    
    class Meta:
        db_table = 'risk_edges_log'
        managed = False
        verbose_name = 'Risk Edge Log'
        verbose_name_plural = 'Risk Edge Logs'


class RiskKPI(models.Model):
    """
    KPI summary from SCRIPT 3 (risk_engine.py)
    One record per run - APPENDED to create time series
    
    Database source: risk_kpis_log table (PostGIS)
    Written by: risk_engine.py (recurring: every 2 hours)
    """
    timestamp = models.CharField(max_length=50)
    total_nodes = models.IntegerField(default=0)
    total_edges = models.IntegerField(default=0)
    
    # Risk distribution
    critical_nodes = models.IntegerField(default=0)
    high_nodes = models.IntegerField(default=0)
    medium_nodes = models.IntegerField(default=0)
    low_nodes = models.IntegerField(default=0)
    
    # Risk statistics
    max_composite_risk = models.FloatField(default=0)
    avg_composite_risk = models.FloatField(default=0)
    
    # Chokepoints
    num_chokepoints = models.IntegerField(default=0)
    top_chokepoint = models.CharField(max_length=255, null=True, blank=True)
    
    # Critical paths
    num_critical_links = models.IntegerField(default=0)
    
    # Scenario simulation capability
    scenario_sensitivity = models.FloatField(default=0, help_text="Sensitivity to network disruption")
    
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'risk_kpis_log'
        managed = False  # Pipeline owns this table
        verbose_name = 'Risk KPI'
        verbose_name_plural = 'Risk KPIs'
        ordering = ['-created_at']
    
    def __str__(self):
        return f"Risk KPI - {self.timestamp}"
