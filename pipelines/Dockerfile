FROM python:3.11-slim

# Install GDAL, GEOS, PROJ and other geospatial/scientific system deps
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    libpq-dev \
    gdal-bin \
    libgdal-dev \
    libgeos-dev \
    libproj-dev \
    libhdf5-dev \
    libxml2-dev \
    libxslt-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create outputs directory for pipeline artefacts
RUN mkdir -p /app/outputs

# Default: run scenario simulation. Override CMD in docker-compose for other scripts.
CMD ["python", "scenario_simulation.py"]
