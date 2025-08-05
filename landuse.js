document.addEventListener("DOMContentLoaded", () => {
  let meshLayer;
  let selectedFeature = null;
  let labelLayer = L.layerGroup().addTo(map); // holds growth % labels

  const growthRates = {
    park: 0.5,
    school: 1.2,
    shopping: 1.8,
    hospital: 1.0
  };

  const baseYear = 2025;
  const selectedAndNearby = new Set();

  // Load mesh GeoJSON and add to map
  fetch("/assets/data/hh.geojson")
    .then(res => {
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      return res.json();
    })
    .then(meshData => {
      console.log("Mesh GeoJSON loaded:", meshData);

      meshLayer = L.geoJSON(meshData, {
        pane: 'meshPane',
        style: feature => getFeatureStyle(feature),
        onEachFeature: (feature, layer) => {
          layer.on('click', (e) => {
            selectedFeature = feature;

            const menu = document.getElementById("landUseMenu");
            const select = document.getElementById("landUseSelect");

            select.value = feature.properties.landUse || '';

            // Position menu near cursor
            const clickX = e.originalEvent.clientX;
            const clickY = e.originalEvent.clientY;
            menu.style.left = (clickX + 10) + 'px';
            menu.style.top = (clickY + 10) + 'px';
            menu.style.display = 'block';

            updateVisuals(); // update immediately on click
          });
        }
      }).addTo(map);

      if (meshLayer && meshLayer.getBounds().isValid()) {
        map.fitBounds(meshLayer.getBounds());
      }
    })
    .catch(err => console.error("Error loading mesh layer:", err));

  // Close menu
window.closeLandUseMenu = function () {
  document.getElementById("landUseMenu").style.display = 'none';
  document.getElementById("populationInfo").style.display = 'none';
};


  // Handle land use change
  document.getElementById("landUseSelect").addEventListener("change", function () {
    if (selectedFeature) {
      selectedFeature.properties.landUse = this.value;
      updateVisuals();
    }
  });

  // Handle year slider input
  const rangeYearInput = document.querySelector('.js-year');
  if (rangeYearInput) {
    rangeYearInput.addEventListener('input', () => {
      updateVisuals();
    });
  }

  function getFeatureStyle(feature) {
  const year = parseInt(document.querySelector('.js-year').value);
  const selected = selectedFeature && feature === selectedFeature;
  const nearby = selectedAndNearby.has(feature);

  let baseColor = "#007BFF";
  let fillOpacity = 0.2;

  const landUse = feature.properties.landUse;
  const growth = feature.properties._growth;

  if (landUse && (selected || nearby) && growth !== null && growth !== undefined) {
    baseColor = getColorByGrowth(growth);
    fillOpacity = 0.6;
  }

  return {
    color: selected ? '#000' : baseColor,
    weight: selected ? 3 : 1,
    fillColor: baseColor,
    fillOpacity: fillOpacity
  };
}

  function updateVisuals() {
  if (!meshLayer || !selectedFeature) return;

  selectedAndNearby.clear();
  labelLayer.clearLayers(); // remove old labels

  const selectedCenter = turf.center(selectedFeature);
  const year = parseInt(document.querySelector('.js-year').value);
  const landUse = selectedFeature.properties.landUse;

  if (!landUse) return;

  const baseGrowth = (year - baseYear) * (growthRates[landUse] || 0);

  meshLayer.eachLayer(layer => {
    const feature = layer.feature;
    const center = turf.center(feature);
    const distance = turf.distance(selectedCenter, center, { units: 'kilometers' });

    if (distance <= 1.0) {
      selectedAndNearby.add(feature);

      // Linearly reduce growth based on distance (0 km = 100%, 1 km = 0%)
      const decayFactor = 1 - (distance / 1.0); // 1.0 = max distance
      const growth = baseGrowth * decayFactor;

      feature.properties._growth = growth;

      const coords = center.geometry.coordinates;
      const growthText = `+${growth.toFixed(1)}%`;

      const label = L.marker([coords[1], coords[0]], {
        icon: L.divIcon({
          className: 'mesh-label',
          html: `<div style="font-size: 11px; font-weight: bold; color: #333;">${growthText}</div>`,
          iconSize: [50, 20],
          iconAnchor: [25, 10]
        }),
        interactive: false
      });

      labelLayer.addLayer(label);
    } else {
      feature.properties._growth = null;
    }
  });

  meshLayer.setStyle(f => getFeatureStyle(f));
}

  // Utility: map growth percent to color
  function getColorByGrowth(growth) {
    return growth > 30 ? '#800026' :
           growth > 20 ? '#BD0026' :
           growth > 15 ? '#E31A1C' :
           growth > 10 ? '#FC4E2A' :
           growth > 5  ? '#FD8D3C' :
           growth > 2  ? '#FEB24C' :
           growth > 0  ? '#FED976' : '#FFF3BE';
  }
});
