var map = L.map('map', {minZoom: 9}).setView([31.5, 132.5], 8);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
	attribution: '© OpenStreetMap contributors',
}).addTo(map);

map.createPane('rectanglePane').style.zIndex = 430; 
map.createPane('populationPane').style.zIndex = 450; 
map.createPane('linePane').style.zIndex = 460; 
map.createPane('circles').style.zIndex = 470; 
map.createPane('commentaryPane').style.zIndex = 660; 
map.createPane('meshPane').style.zIndex = 500; 
document.addEventListener('DOMContentLoaded', function () {
	map.createPane('selectRosen').style.zIndex = 480; 
	map.createPane('selectStop').style.zIndex = 490; 
});

let routeA; // MATSim route layer

const routeCheckbox = document.getElementById('data_root');


fetch("/matsim_data/network_atlantis_reprojected.geojson")
  .then((response) => response.json())
  .then((data) => {
    console.log("MATSim network loaded:", data.features.length, "features");
    routeA = L.geoJSON(data, {
      pane: "linePane",
      style: {
        color: "#31599E",
        weight: 2,
        opacity: 0.8,
      },
      onEachFeature: function (feature, layer) {
        if (feature.properties && feature.properties.id) {
          layer.bindTooltip(`Link ID: ${feature.properties.id}`, {
            permanent: false,
            direction: "top",
            className: "l-contents__map-route",
          });
        }
      },
    });

    // Optional: zoom to bounds
    map.fitBounds(routeA.getBounds());

    // If checkbox is already checked, add the layer
    if (routeCheckbox.checked) {
      routeA.addTo(map);
    }
  });


let rectangle;
let rectanglePane;
function updateRectangle() {
  const bounds = map.getBounds();
  if (rectangle) {
    rectangle.setBounds(bounds);
  } else {
    rectangle = L.rectangle(bounds, {
      color: "#000",
      fillOpacity: 0.5,
      weight: 0,
      pane: 'rectanglePane'
    }).addTo(map);
  }
}
updateRectangle();
map.on('moveend zoomend', updateRectangle);
window.addEventListener('resize', updateRectangle);


const fileStopA = 'assets/data/BRT_stops_a.geojson';
const fileStopB = 'assets/data/BRT_stops_b.geojson';
const routeDefault = '#CCC';//'#B7D1FF';
const routSelect = '#FAC09D';
function stopDefault(feature, latlng) {
	const marker = L.circleMarker(latlng, {
		pane: "linePane",
		radius: 5,
		fillColor: '#FFF',
		color: '#AAA',
		weight: 1,
		fillOpacity: 1
	});
	marker.bindTooltip(feature.properties.stop_name, {
		permanent: true,
		direction: 'bottom',
		offset: [0, 0],
		className: 'l-contents__map-stop'
	});
	return marker;
}
function stopSelect(feature, latlng) {
	const icon = L.icon({
		iconUrl: 'assets/image/ico_pin_02.svg',
		iconSize: [24, 36],
		iconAnchor: [12, 36],
		popupAnchor: [1, -34]
	});
	const marker = L.marker(latlng, { pane: "linePane", icon: icon });
	marker.bindTooltip(feature.properties.stop_name, {
		permanent: true,
		direction: 'bottom',
		offset: [0, 0],
		className: 'l-contents__map-stop current'
	});
	return marker;
}

let routeAcolor;
let routeBcolor;
let stopAstyle;
let stopBstyle;
let currentA;
let currentB;
let routeOpen;
if(document.querySelector('.js-parameter-content')){
	routeOpen = document.querySelector('.js-parameter-content.current .js-route[open]').dataset.route;
} else {
	routeOpen = null;
}
if (routeOpen && routeOpen.includes('_a')) {
	routeAcolor = routSelect;
	stopAstyle = stopSelect;
	currentA = 'current';
} else {
	routeAcolor = routeDefault;
	stopAstyle = stopDefault;
	currentA = false;
}
if (routeOpen && routeOpen.includes('_b')) {
	routeBcolor = routSelect;
	stopBstyle = stopSelect;
	currentB = 'current';
} else {
	routeBcolor = routeDefault;
	stopBstyle = stopDefault;
	currentB = false;
}

let stopsA = L.geoJSON(null, { pane: "linePane", pointToLayer: stopAstyle }).addTo(map);
let stopsB = L.geoJSON(null, { pane: "linePane", pointToLayer: stopBstyle }).addTo(map);
/* fetch(fileStopA).then(response => response.json()).then(data => {
	L.geoJSON(data, { pointToLayer: stopAstyle }).eachLayer(layer => {
		stopsA.addLayer(layer);
	});
}); */
fetch(fileStopA)
  .then(response => response.json())
  .then(data => {
    L.geoJSON(data, {
      pointToLayer: stopAstyle,
      onEachFeature: function (feature, layer) {
        if (feature.properties && feature.properties.comment && window.location.href.includes("results")) {
          var commentaryMarker = L.marker(layer.getLatLng(), {
						icon: L.divIcon({
							className: `l-contents__map-hide`,
							html: `<div class="l-contents__map-comment stop ${feature.properties.icon}">${feature.properties.comment}</div>`,
							iconSize: [null, null], // 自動調整
							iconAnchor: [0, 0] // テキストの左上を基準に配置
						}),
						pane: 'commentaryPane'
					});
					commentaryLayerGroup.addLayer(commentaryMarker);
        }
        stopsA.addLayer(layer);
      }
    });
  });
/* fetch(fileStopB).then(response => response.json()).then(data => {
	L.geoJSON(data, { pointToLayer: stopBstyle }).eachLayer(layer => {
		stopsB.addLayer(layer);
	});
}); */
fetch(fileStopB)
  .then(response => response.json())
  .then(data => {
    L.geoJSON(data, {
      pointToLayer: stopBstyle,
      onEachFeature: function (feature, layer) {
        if (feature.properties && feature.properties.comment && window.location.href.includes("results")) {
          var commentaryMarker = L.marker(layer.getLatLng(), {
						icon: L.divIcon({
							className: `l-contents__map-hide`,
							html: `<div class="l-contents__map-comment stop ${feature.properties.icon}">${feature.properties.comment}</div>`,
							iconSize: [null, null], // 自動調整
							iconAnchor: [0, 0] // テキストの左上を基準に配置
						}),
						pane: 'commentaryPane'
					});
					commentaryLayerGroup.addLayer(commentaryMarker);
        }
        stopsB.addLayer(layer);
      }
    });
  });

function routeCheckboxChange() {
  const stopElements = document.querySelectorAll('.leaflet-commentary-pane .stop');
  if (routeCheckbox.checked) {
    if (routeA) routeA.addTo(map);
    stopsA.addTo(map);
    stopsB.addTo(map);
    stopElements.forEach(element => {
      element.style.display = 'block';
    });
  } else {
    if (routeA) routeA.remove();
    stopsA.remove();
    stopsB.remove();
    stopElements.forEach(element => {
      element.style.display = 'none';
    });
  }
}

routeCheckboxChange();
routeCheckbox.addEventListener('change', routeCheckboxChange);

// 人口推計の表示
const populationCheckbox = document.querySelector('.js-population');
populationCheckbox.checked = false;
function getColor(d) {
	return d > 7000
		? "#800026"
		: d > 5000
		? "#BD0026"
		: d > 2000
		? "#E31A1C"
		: d > 1000
		? "#FC4E2A"
		: d > 600
		? "#FD8D3C"
		: d > 300
		? "#FE9E43"
		: d > 200
		? "#FEB24C"
		: d > 100
		? "#FEC560"
		: d > 50
		? "#FED976"
		: d > 10
		? "#FEE086"
		: "#FFF3BE";
}
function geoJsonStyle(feature) {
	let selectYear = document.querySelector('.l-contents__map-year .range').value;
	selectYear = 'PTN_'+selectYear;
	return {
		fillColor: getColor(feature.properties[selectYear]),
		weight: 0,
		opacity: 1,
		color: "white",
		dashArray: "3",
		fillOpacity: 0.4,
	};
}
let populationLayer = null;
function showPopulationData() {
	fetch("assets/data/jinnkousuikei_v3.zip")
		.then(response => response.arrayBuffer())
		.then(buffer => JSZip.loadAsync(buffer))
		.then(zip => {
			return zip.file("jinnkousuikei_v3.geojson").async("string");
		})
		.then(geojsonString => {
			const data = JSON.parse(geojsonString);
			if (populationLayer) {
				map.removeLayer(populationLayer);
			}
			populationLayer = L.geoJSON(data, {
				style: geoJsonStyle,
				pane: 'populationPane',
				zIndexOffset: 0,
			}).addTo(map);
			//populationCheckbox.nextElementSibling.textContent = '表示中';
		});
}
function removePopulationData() {
	if (populationLayer) {
		map.removeLayer(populationLayer);
		populationLayer = null;
		//populationCheckbox.nextElementSibling.textContent = '読み込み中';
	}
}
populationCheckbox.addEventListener('change', () => {
	if (populationCheckbox.checked) {
		showPopulationData();
	} else {
		removePopulationData();
	}
});

//年代スライダー
const rangeYearInput = document.querySelector('.js-year');
const currentYearValue = document.querySelector('.js-year-current');
const minYearValue = parseInt(rangeYearInput.min);
const maxYearValue = parseInt(rangeYearInput.max);
const minYearTxt = document.querySelector('.js-year-min');
const maxYearTxt = document.querySelector('.js-year-max');
function yearRange(yearValue) {
	currentYearValue.textContent = yearValue;
	rangeYearInput.classList.remove('min', 'max');
	minYearTxt.classList.toggle('hide', yearValue === minYearValue);
	maxYearTxt.classList.toggle('hide', yearValue === maxYearValue);
	const thumbYearPosition = (yearValue - minYearValue) / (maxYearValue - minYearValue);
	const trackYearWidth = rangeYearInput.offsetWidth;
	currentYearValue.style.left = `${thumbYearPosition * trackYearWidth}px`;
}
yearRange(parseInt(rangeYearInput.value));
if (parseInt(rangeYearInput.value) === minYearValue) {
	rangeYearInput.classList.add('min');
} else if (parseInt(rangeYearInput.value) === maxYearValue) {
	rangeYearInput.classList.add('max');
}
rangeYearInput.addEventListener('input', function () {
	yearRange(parseInt(this.value));
	if (populationCheckbox && populationCheckbox.checked) {
		showPopulationData();
	}
});