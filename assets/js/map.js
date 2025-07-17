var map = L.map('map', { minZoom: 9 }).setView([31.5, 132.5], 8);

const baseLayers = {
	"標準地図": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'),
	"ダークモード": L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png')
};
baseLayers["標準地図"].addTo(map);

const overlayLayers = {};
L.control.layers(baseLayers, overlayLayers, { collapsed: false }).addTo(map);

const panes = [
	'rectanglePane', 'populationPane', 'linePane', 'circles',
	'commentaryPane', 'meshPane', 'selectRosen', 'selectStop'
];
panes.forEach((pane, index) => {
	const p = map.createPane(pane);
	p.style.zIndex = 430 + index * 10;
});

let routeA;
const routeCheckbox = document.getElementById('data_root');

fetch("matsim_data/network_bus_and_rail_up.geojson")
	.then(res => res.json())
	.then(data => {
		console.log("MATSim network loaded:", data.features.length);
		routeA = L.geoJSON(data, {
			pane: "linePane",
			style: {
				color: "#31599E",
				weight: 2,
				opacity: 0.8,
			},
			onEachFeature: (feature, layer) => {
				const info = feature.properties?.id || "Unknown";
				layer.bindTooltip(`Link ID: ${info}`, {
					permanent: false,
					direction: "top",
					className: "l-contents__map-route",
				});
				layer.on('mouseover', () => layer.setStyle({ weight: 4, color: "#1C3D6E" }));
				layer.on('mouseout', () => layer.setStyle({ weight: 2, color: "#31599E" }));
			}
		});
		map.fitBounds(routeA.getBounds());
		if (routeCheckbox.checked) routeA.addTo(map);
	});

function routeCheckboxChange() {
	if (routeCheckbox.checked) {
		routeA?.addTo(map);
	} else {
		routeA?.remove();
	}
}
routeCheckboxChange();
routeCheckbox.addEventListener('change', routeCheckboxChange);

let rectangle;
function updateRectangle() {
	const bounds = map.getBounds();
	if (!rectangle) {
		rectangle = L.rectangle(bounds, {
			color: "#333",
			fillColor: "#000",
			fillOpacity: 0.15,
			dashArray: '5, 5',
			weight: 1,
			pane: 'rectanglePane'
		}).addTo(map);
	} else {
		rectangle.setBounds(bounds);
	}
}
updateRectangle();
map.on('moveend zoomend', updateRectangle);
window.addEventListener('resize', updateRectangle);

const populationCheckbox = document.querySelector('.js-population');
let populationLayer = null;

function getColor(d) {
	return d > 7000 ? "#800026" :
		d > 5000 ? "#BD0026" :
		d > 2000 ? "#E31A1C" :
		d > 1000 ? "#FC4E2A" :
		d > 600 ? "#FD8D3C" :
		d > 300 ? "#FE9E43" :
		d > 200 ? "#FEB24C" :
		d > 100 ? "#FEC560" :
		d > 50 ? "#FED976" :
		d > 10 ? "#FEE086" : "#FFF3BE";
}

function geoJsonStyle(feature) {
	const selectYear = 'PTN_' + document.querySelector('.l-contents__map-year .range').value;
	return {
		fillColor: getColor(feature.properties[selectYear]),
		weight: 0.5,
		opacity: 0.5,
		color: "white",
		dashArray: "2",
		fillOpacity: 0.4,
	};
}

function showPopulationData() {
	fetch("assets/data/jinnkousuikei_v3.zip")
		.then(res => res.arrayBuffer())
		.then(buffer => JSZip.loadAsync(buffer))
		.then(zip => zip.file("jinnkousuikei_v3.geojson").async("string"))
		.then(geojsonStr => {
			const data = JSON.parse(geojsonStr);
			if (populationLayer) map.removeLayer(populationLayer);
			populationLayer = L.geoJSON(data, {
				style: geoJsonStyle,
				pane: 'populationPane',
			}).addTo(map);
		});
}

function removePopulationData() {
	if (populationLayer) {
		map.removeLayer(populationLayer);
		populationLayer = null;
	}
}

populationCheckbox.addEventListener('change', () => {
	populationCheckbox.checked ? showPopulationData() : removePopulationData();
});

const rangeYearInput = document.querySelector('.js-year');
const currentYearValue = document.querySelector('.js-year-current');
const minYearValue = parseInt(rangeYearInput.min);
const maxYearValue = parseInt(rangeYearInput.max);
const minYearTxt = document.querySelector('.js-year-min');
const maxYearTxt = document.querySelector('.js-year-max');

function yearRange(year) {
	currentYearValue.textContent = year;
	const percent = (year - minYearValue) / (maxYearValue - minYearValue);
	currentYearValue.style.left = `${percent * rangeYearInput.offsetWidth}px`;
	minYearTxt.classList.toggle('hide', year === minYearValue);
	maxYearTxt.classList.toggle('hide', year === maxYearValue);
}
rangeYearInput.addEventListener('input', () => {
	const year = parseInt(rangeYearInput.value);
	yearRange(year);
	if (populationCheckbox.checked) showPopulationData();
});
yearRange(parseInt(rangeYearInput.value));