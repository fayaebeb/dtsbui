var map = L.map('map', { minZoom: 9 }).setView([31.5, 132.5], 8);
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
});

let routeA; // MATSim route layer

const routeCheckbox = document.getElementById('data_root');


fetch("matsim_data/network_bus_and_rail.geojson")
	.then((response) => response.json())
	.then((data) => {
		console.log("✅ MATSim network loaded:", data.features.length, "features");
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

function routeCheckboxChange() {
	const stopElements = document.querySelectorAll('.leaflet-commentary-pane .stop');
	if (routeCheckbox.checked) {
		if (routeA) routeA.addTo(map);
	} else {
		if (routeA) routeA.remove();
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
	selectYear = 'PTN_' + selectYear;
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