from django.db import models

class NetworkNode(models.Model):
    """
    Network node from SCRIPT 1 (network_model.py)
    Represents: road intersections, rail nodes, ports, dryports, stations
    
    Database source: network_nodes table (PostGIS)
    Written by: network_model.py (one-time)
    """
    node_id = models.CharField(max_length=255, primary_key=True)
    asset_id = models.CharField(max_length=255, unique=True)
    node_type = models.CharField(
        max_length=50,
        choices=[
            ('port', 'Seaport'),
            ('dryport', 'Inland Container Terminal'),
            ('station', 'Railway Station'),
            ('road_intersection', 'Road Intersection'),
            ('rail_intersection', 'Rail Intersection'),
        ]
    )
    name = models.CharField(max_length=255, null=True, blank=True)
    lon = models.FloatField()
    lat = models.FloatField()
    rail_intersection = models.IntegerField(default=0)
    
    # Centrality metrics from baseline analysis
    betweenness_centrality = models.FloatField(default=0, help_text="0-1, higher = critical")
    degree_centrality = models.FloatField(default=0, help_text="0-1, connectivity")
    closeness_centrality = models.FloatField(default=0, help_text="0-1, distance centrality")
    
    # Asset characteristics
    importance_index = models.IntegerField(default=1, choices=[(1, '1'), (2, '2'), (3, '3'), (4, '4'), (5, '5')])
    handling_capacity_index = models.IntegerField(default=1, choices=[(1, '1'), (2, '2'), (3, '3'), (4, '4'), (5, '5')])
    redundancy_index = models.IntegerField(default=0, choices=[(0, '0'), (1, '1'), (2, '2'), (3, '3')])

    class Meta:
        db_table = 'network_nodes'
        managed = False  # Pipeline owns this table
        verbose_name = 'Network Node'
        verbose_name_plural = 'Network Nodes'
    
    def __str__(self):
        return f"{self.asset_id} ({self.node_type})"


class NetworkEdge(models.Model):
    """
    Network edge from SCRIPT 1 (network_model.py)
    Represents: road segments, railway lines, access links
    
    Database source: network_edges table (PostGIS)
    Written by: network_model.py (one-time)
    """
    edge_id = models.CharField(max_length=255, primary_key=True)
    asset_id = models.CharField(max_length=255, unique=True)
    from_node = models.CharField(max_length=255)
    to_node = models.CharField(max_length=255)
    
    # Mode classification
    mode = models.CharField(
        max_length=50,
        choices=[
            ('road', 'Road'),
            ('rail', 'Railway'),
            ('intermodal', 'Intermodal Access'),
        ]
    )
    road_type = models.CharField(
        max_length=50,
        null=True,
        blank=True,
        choices=[
            ('motorway', 'Motorway'),
            ('trunk', 'Trunk Road'),
            ('primary', 'Primary Road'),
            ('secondary', 'Secondary Road'),
            ('rail_line', 'Railway Line'),
            ('access_link', 'Access Link'),
            ('bridge_access', 'Bridge Access'),
        ]
    )
    
    # Physical characteristics
    length_km = models.FloatField()
    avg_speed_kmh = models.IntegerField()
    travel_time_hr = models.FloatField(help_text="length_km / avg_speed_kmh")
    
    # Network characteristics
    capacity_index = models.IntegerField(default=3, choices=[(i, str(i)) for i in range(1, 6)])
    edge_betweenness = models.FloatField(default=0, help_text="0-1, criticality in routes")
    
    name = models.CharField(max_length=255, null=True, blank=True)

    class Meta:
        db_table = 'network_edges'
        managed = False  # Pipeline owns this table
        verbose_name = 'Network Edge'
        verbose_name_plural = 'Network Edges'
    
    def __str__(self):
        return f"{self.asset_id} ({self.mode})"

