from django.db import models

class HazardNode(models.Model):
    """
    Hazard scores per node from SCRIPT 2 (hazard_model.py)
    LATEST state: replaced each run
    
    Database source: hazard_nodes_latest table (PostGIS)
    Written by: hazard_model.py (recurring: hourly/daily)
    
    Hazard types:
    - Flood: static terrain + rainfall + GDACS alerts
    - Cyclone: GDACS events + coastal exposure
    - Strike: RSS feeds + NLP classification
    - Accident: RSS feeds + weather + NLP classification
    """
    asset_id = models.CharField(max_length=255, primary_key=True)
    name = models.CharField(max_length=255, null=True, blank=True)
    node_type = models.CharField(max_length=50, null=True, blank=True)
    lat = models.FloatField(default=0)
    lon = models.FloatField(default=0)
    
    # Four individual hazard scores (0.0-1.0)
    hazard_flood = models.FloatField(default=0, help_text="Flood probability 0-1")
    hazard_cyclone = models.FloatField(default=0, help_text="Cyclone probability 0-1")
    hazard_strike = models.FloatField(default=0, help_text="Strike probability 0-1")
    hazard_accident = models.FloatField(default=0, help_text="Accident probability 0-1")
    
    # Composite hazard (Noisy-OR aggregation)
    composite_hazard = models.FloatField(default=0, help_text="0-1, highest of natural + human")
    alert_level = models.CharField(
        max_length=20,
        default='LOW',
        choices=[
            ('CRITICAL', 'Critical'),
            ('HIGH', 'High'),
            ('MEDIUM', 'Medium'),
            ('LOW', 'Low'),
        ]
    )
    
    # Trigger flags (binary: is this hazard active?)
    any_trigger = models.BooleanField(default=False, help_text="Any hazard triggered?")
    trigger_flood = models.BooleanField(default=False)
    trigger_cyclone = models.BooleanField(default=False)
    trigger_strike = models.BooleanField(default=False)
    trigger_accident = models.BooleanField(default=False)
    
    # Metadata
    timestamp = models.CharField(max_length=50, null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'hazard_nodes_latest'
        managed = False  # Pipeline owns this table
        verbose_name = 'Hazard Node (Latest)'
        verbose_name_plural = 'Hazard Nodes (Latest)'
        indexes = [
            models.Index(fields=['composite_hazard']),
            models.Index(fields=['alert_level']),
            models.Index(fields=['any_trigger']),
        ]
    
    def __str__(self):
        return f"{self.asset_id} - {self.alert_level}"


class HazardNodeLog(models.Model):
    """
    Historical hazard scores per node - APPENDED each run
    Enables time-slider on dashboard for hazard animation
    """
    asset_id = models.CharField(max_length=255)
    composite_hazard = models.FloatField()
    alert_level = models.CharField(max_length=20)
    timestamp = models.CharField(max_length=50)
    
    class Meta:
        db_table = 'hazard_nodes_log'
        managed = False
        verbose_name = 'Hazard Node Log'
        verbose_name_plural = 'Hazard Node Logs'


class HazardEdge(models.Model):
    """
    Hazard scores per edge from SCRIPT 2 (hazard_model.py)
    LATEST state: replaced each run
    
    Database source: hazard_edges_latest table (PostGIS)
    Written by: hazard_model.py (recurring: hourly/daily)
    """
    asset_id = models.CharField(max_length=255, primary_key=True)
    mode = models.CharField(max_length=50, null=True, blank=True)
    
    # Individual hazard scores
    hazard_flood = models.FloatField(default=0)
    hazard_cyclone = models.FloatField(default=0)
    hazard_strike = models.FloatField(default=0)
    hazard_accident = models.FloatField(default=0)
    
    # Composite and alert
    composite_hazard = models.FloatField(default=0)
    alert_level = models.CharField(
        max_length=20,
        default='LOW',
        choices=[
            ('CRITICAL', 'Critical'),
            ('HIGH', 'High'),
            ('MEDIUM', 'Medium'),
            ('LOW', 'Low'),
        ]
    )
    
    # Triggers and metadata
    any_trigger = models.BooleanField(default=False)
    strike_index = models.FloatField(default=0)
    timestamp = models.CharField(max_length=50, null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'hazard_edges_latest'
        managed = False  # Pipeline owns this table
        verbose_name = 'Hazard Edge (Latest)'
        verbose_name_plural = 'Hazard Edges (Latest)'
    
    def __str__(self):
        return f"{self.asset_id} - {self.alert_level}"


class HazardEdgeLog(models.Model):
    """
    Historical hazard scores per edge - APPENDED each run
    Enables time-slider on dashboard for hazard animation
    """
    asset_id = models.CharField(max_length=255)
    composite_hazard = models.FloatField()
    alert_level = models.CharField(max_length=20)
    timestamp = models.CharField(max_length=50)
    
    class Meta:
        db_table = 'hazard_edges_log'
        managed = False
        verbose_name = 'Hazard Edge Log'
        verbose_name_plural = 'Hazard Edge Logs'


class HazardKPI(models.Model):
    """
    KPI summary from SCRIPT 2 (hazard_model.py)
    One record per run - APPENDED to create time series
    
    Database source: kpis_log / hazard_kpi_log tables (PostGIS)
    Written by: hazard_model.py (recurring: hourly/daily)
    """
    timestamp = models.CharField(max_length=50)
    total_nodes = models.IntegerField(default=0)
    total_edges = models.IntegerField(default=0)
    triggered_nodes = models.IntegerField(default=0)
    triggered_edges = models.IntegerField(default=0)
    critical_nodes = models.IntegerField(default=0)
    high_nodes = models.IntegerField(default=0)
    
    # Per-hazard triggering counts
    flood_triggered_nodes = models.IntegerField(default=0)
    cyclone_triggered_nodes = models.IntegerField(default=0)
    strike_triggered_nodes = models.IntegerField(default=0)
    accident_triggered_nodes = models.IntegerField(default=0)
    
    # Statistics
    max_composite_hazard = models.FloatField(default=0)
    avg_composite_hazard = models.FloatField(default=0)
    top_risk_asset = models.CharField(max_length=255, null=True, blank=True)
    
    # Pipeline execution status
    hazard_flood_status = models.CharField(max_length=100, default='NOT_RUN')
    hazard_cyclone_status = models.CharField(max_length=100, default='NOT_RUN')
    hazard_strike_status = models.CharField(max_length=100, default='NOT_RUN')
    hazard_accident_status = models.CharField(max_length=100, default='NOT_RUN')
    
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'hazard_kpi_log'
        managed = False  # Pipeline owns this table
        verbose_name = 'Hazard KPI'
        verbose_name_plural = 'Hazard KPIs'
        ordering = ['-created_at']
    
    def __str__(self):
        return f"Hazard KPI - {self.timestamp}"
