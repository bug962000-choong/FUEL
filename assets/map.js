'use strict';

globalThis.FuelMap = class {
  constructor(canvas, all, onStation, onRegion) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.all = all;
    this.region = all;
    this.stations = [];
    this.visibleMarkers = [];
    this.aspect = Math.cos(37 * Math.PI / 180);
    this.width = canvas.clientWidth;
    this.height = canvas.clientHeight;
    this.fit();
    const size = new ResizeObserver(() => {
      if (this.width === canvas.clientWidth && this.height === canvas.clientHeight && this.painted) return;
      this.width = canvas.clientWidth;
      this.height = canvas.clientHeight;
      this.fit();
    });
    size.observe(canvas);
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      this.zoom(event.deltaY < 0 ? 1.22 : 1 / 1.22, event.offsetX, event.offsetY);
    }, { passive: false });
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      canvas.setPointerCapture(event.pointerId);
      this.pan = { x: event.offsetX, y: event.offsetY, lon: this.lon, lat: this.lat, moved: false };
    });
    canvas.addEventListener('pointermove', event => {
      if (!this.pan || !event.isPrimary) return;
      const dx = event.offsetX - this.pan.x, dy = event.offsetY - this.pan.y;
      if (!this.pan.moved && Math.hypot(dx, dy) < 4) return;
      this.pan.moved = true;
      this.lon = this.pan.lon - dx / (this.scale * this.aspect);
      this.lat = this.pan.lat + dy / this.scale;
      this.draw();
    });
    canvas.addEventListener('pointercancel', () => { this.pan = undefined; });
    canvas.addEventListener('pointerup', event => {
      if (!this.pan || !event.isPrimary) return;
      const click = !this.pan.moved;
      this.pan = undefined;
      if (!click) return;
      const x = event.offsetX, y = event.offsetY;
      let nearest, distance = 12;
      for (const [station, cx, cy] of this.visibleMarkers) {
        const hit = Math.hypot(x - cx, y - cy);
        if (hit < distance || hit === distance && station === this.selected) {
          nearest = station;
          distance = hit;
        }
      }
      if (nearest) { onStation(nearest); return; }
      const coordinate = this.unproject(x, y);
      const feature = this.all.features.find(item => FuelData.featureContains(item, ...coordinate));
      if (!feature) return;
      const { town } = feature, district = town.parent, province = district.parent;
      const parents = [province, district, town];
      const currentProvince = [this.region, this.region.parent, this.region.parent?.parent].find(region => region?.id.startsWith('p'));
      const level = currentProvince !== province ? 0 : this.region === district || this.region.parent === district ? 2 : 1;
      const next = parents[level];
      if (next !== this.region) onRegion(next);
    });
  }

  unproject(x, y) {
    return [this.lon + (x - this.width / 2) / (this.scale * this.aspect), this.lat - (y - this.height / 2) / this.scale];
  }

  project(lon, lat) {
    return [(lon - this.lon) * this.scale * this.aspect + this.width / 2, (this.lat - lat) * this.scale + this.height / 2];
  }

  fit() {
    if (!this.width || !this.height || !this.region.features.length) return;
    const extent = [Infinity, Infinity, -Infinity, -Infinity];
    for (const { bounds } of this.region.features) {
      extent[0] = Math.min(extent[0], bounds[0]);
      extent[1] = Math.min(extent[1], bounds[1]);
      extent[2] = Math.max(extent[2], bounds[2]);
      extent[3] = Math.max(extent[3], bounds[3]);
    }
    this.lon = (extent[0] + extent[2]) / 2;
    this.lat = (extent[1] + extent[3]) / 2;
    this.scale = Math.min(120000, (this.width - 46) / (this.aspect * (extent[2] - extent[0])), (this.height - 50) / (extent[3] - extent[1]));
    this.draw();
  }

  setRegion(region, stations) {
    const changed = this.region !== region;
    this.region = region;
    this.stations = stations;
    this.selected = undefined;
    if (changed) this.fit();
    else this.draw();
  }

  select(station, center) {
    this.selected = station;
    if (center && station.coordinates) {
      const [x, y] = this.project(...station.coordinates);
      if (x < 12 || y < 12 || x > this.width - 12 || y > this.height - 12) [this.lon, this.lat] = station.coordinates;
    }
    this.draw();
  }

  zoom(factor, x = this.width / 2, y = this.height / 2) {
    const [lon, lat] = this.unproject(x, y);
    this.scale = Math.min(240000, Math.max(12, this.scale * factor));
    const [afterLon, afterLat] = this.unproject(x, y);
    this.lon += lon - afterLon;
    this.lat += lat - afterLat;
    this.draw();
  }

  draw() {
    if (!this.width || !this.height || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.paint();
    });
  }

  paint() {
    const { context, width, height } = this, ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.painted = true;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#deedf7';
    context.fillRect(0, 0, width, height);
    const cache = [this.region, this.lon, this.lat, this.scale, width, height];
    if (!this.boundaryKey || cache.some((value, i) => value !== this.boundaryKey[i])) {
      this.boundaryKey = cache;
      this.backgroundPath = new Path2D();
      this.highlightPath = new Path2D();
      const [minX, maxY] = this.unproject(-5, -5), [maxX, minY] = this.unproject(width + 5, height + 5);
      const selectedFeatures = this.region === this.all ? null : new Set(this.region.features);
      for (const feature of this.all.features) {
        const [west, south, east, north] = feature.bounds;
        if (east < minX || west > maxX || north < minY || south > maxY) continue;
        const path = selectedFeatures?.has(feature) ? this.highlightPath : this.backgroundPath;
        for (const polygon of feature.polygons) for (const ring of polygon) {
          if (!ring.length) continue;
          let [lastX, lastY] = this.project(...ring[0]);
          path.moveTo(lastX, lastY);
          for (let i = 1; i < ring.length - 1; i++) {
            const [x, y] = this.project(...ring[i]);
            if (Math.abs(lastX - x) + Math.abs(lastY - y) < .65) continue;
            path.lineTo(x, y);
            lastX = x;
            lastY = y;
          }
          path.closePath();
        }
      }
    }
    context.fillStyle = '#f8fbfe';
    context.strokeStyle = '#b2c8d9';
    context.lineWidth = .65;
    context.fill(this.backgroundPath, 'evenodd');
    context.stroke(this.backgroundPath);
    context.fillStyle = '#90bfea';
    context.strokeStyle = '#20588c';
    context.lineWidth = 1.55;
    context.fill(this.highlightPath, 'evenodd');
    context.stroke(this.highlightPath);
    this.visibleMarkers = [];
    for (const station of this.stations) {
      if (!station.coordinates) continue;
      const [x, y] = this.project(...station.coordinates);
      if (x < -10 || x > width + 10 || y < -10 || y > height + 10) continue;
      const marker = [station, x, y];
      this.visibleMarkers.push(marker);
      if (station !== this.selected) this.paintMarker(marker, false);
    }
    const selected = this.visibleMarkers.find(([station]) => station === this.selected);
    if (selected) this.paintMarker(selected, true);
  }

  paintMarker([, x, y], selected) {
    const context = this.context;
    if (selected) {
      context.beginPath();
      context.arc(x, y, 12, 0, Math.PI * 2);
      context.fillStyle = '#f9b65590';
      context.fill();
    }
    context.beginPath();
    context.arc(x, y, selected ? 7 : this.stations.length > 800 ? 2.8 : 4.7, 0, Math.PI * 2);
    context.fillStyle = selected ? '#b85914' : '#0d6e72';
    context.strokeStyle = '#fff';
    context.lineWidth = selected ? 2 : 1;
    context.fill();
    context.stroke();
  }
};
