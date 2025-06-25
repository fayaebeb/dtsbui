//ローディング
const urlParams = new URLSearchParams(window.location.search);
const loading = urlParams.get('loading');
const loadingElement = document.querySelector('.js-loading');
const loadingContents = document.querySelector('.js-loading-container');
if (loadingElement && loading !== 'true') {
	loadingContents.classList.remove('hide');
} else if(loadingElement && loading === 'true'){
	loadingElement.classList.add('show');
	window.addEventListener('load', function () {
		loadingContents.classList.remove('hide');
		setTimeout(function () {
			loadingElement.classList.add('fade');
			setTimeout(function () {
				loadingElement.classList.remove('show');
			}, 500);
		}, 1000);
	});
}
//棒グラフ基本設定
const barLabels = ["現在", "入力"];
const barBgColor = ["#31599E", "#F5813C"];
const barX = {
	beginAtZero: true,
	grid: {
		display: false
	}
};

//グラフ切り替え
function toggleOptions(selectElement, optionElement) {
	selectElement.classList.toggle('open');
	if (optionElement) {
		optionElement.style.display = optionElement.style.display === 'none' || optionElement.style.display === '' ? 'block' : 'none';
	}
}
function updateSelectedOption(labelElement) {
	const inputElement = labelElement.querySelector('.js-chart-radio');
	const selectOption = inputElement ? inputElement.dataset.option : null;
	const optionElement = labelElement.parentElement;
	const selectElement = optionElement.previousElementSibling;
	if (optionElement) {
		optionElement.style.display = 'none';
	}
	if (selectElement && selectElement.classList.contains('js-chart-select')) {
		selectElement.classList.remove('open');
	}
	const h2Element = selectElement ? selectElement.querySelector('.js-chart-tit') : null;
	if (h2Element && selectOption) {
		h2Element.textContent = selectOption;
	}
}
const selectElements = document.querySelectorAll('.js-chart-select');
selectElements.forEach(selectElement => {
	const optionElement = selectElement.nextElementSibling;
	selectElement.addEventListener('click', () => toggleOptions(selectElement, optionElement));
});
const labelElements = document.querySelectorAll('.js-chart-item');
labelElements.forEach(labelElement => {
	labelElement.addEventListener('click', () => updateSelectedOption(labelElement));
});

// 賑わいの表示
let nigiwaiLayer; // レイヤーを格納する変数
let commentaryLayerGroup = L.layerGroup();
fetch('assets/data/nigiwai.geojson') // GeoJSONファイルのパス
	.then(response => response.json())
	.then(data => {
		nigiwaiLayer = L.geoJSON(data, {
			pointToLayer: function (feature, latlng) {
				// 賑わい度合いを画面上の半径の基本値に反映
				var baseRadius = feature.properties.nigiwai * 25; // 基本となる半径（調整が必要）
				var circleMarker = L.circle(latlng, {
					radius: baseRadius, // ピクセル単位の半径
					fillColor: "#F5813C",
					color: false,
					weight: 1,
					opacity: 1,
					fillOpacity: 0.5,
					pane: 'circles' // 作成したレイヤーを指定
				});
				// コメントが存在する場合、Popupを追加
				if (feature.properties.comment) {
					circleMarker.bindPopup(feature.properties.comment);
				}
				return circleMarker;
			},
			onEachFeature: function (feature, layer) {
				// 各フィーチャーに対してコメントレイヤーを作成
				if (feature.properties.comment) {
					var commentaryMarker = L.marker(layer.getLatLng(), {
						icon: L.divIcon({
							className: `l-contents__map-hide`,
							html: `<div class="l-contents__map-comment nigiwai ${feature.properties.icon}">${feature.properties.comment}</div>`,
							iconSize: [null, null], // 自動調整
							iconAnchor: [0, 0] // テキストの左上を基準に配置
						}),
						pane: 'commentaryPane'
					});
					commentaryLayerGroup.addLayer(commentaryMarker);
				}
			}
		});
		const bustleCheckbox = document.getElementById('data_bustle');
		const commentaryCheckbox = document.getElementById('data_commentary');
		// 初期表示
		if (bustleCheckbox.checked && commentaryCheckbox.checked) {
			nigiwaiLayer.addTo(map);
			commentaryLayerGroup.addTo(map);
		} else if (bustleCheckbox.checked) {
			nigiwaiLayer.addTo(map);
		} else if (commentaryCheckbox.checked) {
			commentaryLayerGroup.addTo(map);
		}
		bustleCheckbox.addEventListener('change', function () {
			const nigiwaiElements = document.querySelectorAll('.leaflet-commentary-pane .nigiwai');
			// 賑わいレイヤーの表示/非表示
			if (this.checked) {
				if (!map.hasLayer(nigiwaiLayer)) {
					map.addLayer(nigiwaiLayer);
					nigiwaiElements.forEach(element => {
						element.style.display = 'block';
					});
				}
			} else {
				if (map.hasLayer(nigiwaiLayer)) {
					map.removeLayer(nigiwaiLayer);
					nigiwaiElements.forEach(element => {
						element.style.display = 'none';
					});
				}
			}
		});
		commentaryCheckbox.addEventListener('change', function () {
			if (this.checked) {
				if (!map.hasLayer(commentaryLayerGroup)) {
					map.addLayer(commentaryLayerGroup);
				}
			} else {
				if (map.hasLayer(commentaryLayerGroup)) {
					map.removeLayer(commentaryLayerGroup);
				}
			}
		});
	});

//メッシュ表示・ターゲット選択
document.addEventListener('DOMContentLoaded', function () {
	//メッシュ表示
	let meshLayer = null; // 表示範囲内のメッシュレイヤーを保持する変数
	let outOfBoundsLayer = null; // 範囲外のメッシュレイヤーを保持する変数
	// 選択中のメッシュレイヤーを保持する変数
	let selectedLayer = null;
	window.currentMesh = null;
	const meshStyle = { color: '#CCC', weight: 1, fillOpacity: 0.3, fillColor: '#49A7D1' };
	const meshStyleCurrent = { color: '#F5813C', weight: 2, fillOpacity: 0.3, fillColor: '#F5813C' };
	const meshStyleDisabled = { color: '#CCC', weight: 1, fillOpacity: 0.3, fillColor: '#DDD' };
	const requiredProperties = [
		"dataTotalAA" , "dataTotalAB" , "dataTotalAC" , "dataTotalAD" , "dataTotalAE" , "dataTotalAF" ,"dataTotalBA" , "dataTotalBB" , "dataTotalBC" , "dataTotalBD" , "dataTotalBE" , "dataTotalBF" , "dataTimeA" , "dataTimeB" , "dataAccidentA" , "dataAccidentB" , "dataPassengersA" , "dataPassengersB" , "dataExchangeA" , "dataExchangeB" , "dataTripA" , "dataTripB" , "dataTrafficjamA" , "dataTrafficjamB" , "dataCostA" , "dataCostB" , "dataBCA" , "dataBCB"
	];
	const initialData = {
		dataTotalAA: initialTotalDataA[0], //総合評価：平均所要時間：入力
		dataTotalAB: initialTotalDataA[1], //総合評価：交通事故発生率：入力
		dataTotalAC: initialTotalDataA[2], //総合評価：平均乗客数：入力
		dataTotalAD: initialTotalDataA[3], //総合評価：交流発生効果：入力
		dataTotalAE: initialTotalDataA[4], //総合評価：渋滞発生頻度：入力
		dataTotalAF: initialTotalDataA[5], //総合評価：運行コスト：入力
		dataTotalBA: initialTotalDataB[0], //総合評価：平均所要時間：現在
		dataTotalBB: initialTotalDataB[1], //総合評価：交通事故発生率：現在
		dataTotalBC: initialTotalDataB[2], //総合評価：平均乗客数：現在
		dataTotalBD: initialTotalDataB[3], //総合評価：交流発生効果：現在
		dataTotalBE: initialTotalDataB[4], //総合評価：渋滞発生頻度：現在
		dataTotalBF: initialTotalDataB[5], //総合評価：運行コスト：現在
		dataTimeA: initialTimeData[0], //平均所要時間：現在
		dataTimeB: initialTimeData[1], //平均所要時間：入力
		dataAccidentA: initialAccidentData[0], //交通事故発生率：現在
		dataAccidentB: initialAccidentData[1], //交通事故発生率：入力
		dataPassengersA: initialPassengersData[0], //平均乗客数：現在
		dataPassengersB: initialPassengersData[1], //平均乗客数：入力
		dataExchangeA: initialExchangeData[0], //交流発生効果：現在
		dataExchangeB: initialExchangeData[1], //交流発生効果：入力
		dataTripA: initialTripData[0], //誘発トリップ数：現在
		dataTripB: initialTripData[1], //誘発トリップ数：入力
		dataTrafficjamA: initialTrafficjamData[0], //渋滞発生頻度：現在
		dataTrafficjamB: initialTrafficjamData[1], //渋滞発生頻度：入力
		dataCostA: initialCostData[0], //運用コスト：現在
		dataCostB: initialCostData[1], //運用コスト：入力
		dataBCA: initialBCData[0], //B/C：現在
		dataBCB: initialBCData[1], //B/C：入力
	};
	function addDataToGeoJSON(data) {
		data.features.forEach(feature => {
			if (feature.properties && feature.properties.KEY_CODE) {
				feature.properties.dataTotalAA = Math.floor(Math.random() * 5) + 1;
				feature.properties.dataTotalAB = Math.floor(Math.random() * 5) + 1;
				feature.properties.dataTotalAC = Math.floor(Math.random() * 5) + 1;
				feature.properties.dataTotalAD = Math.floor(Math.random() * 5) + 1;
				feature.properties.dataTotalAE = Math.floor(Math.random() * 5) + 1;
				feature.properties.dataTotalAF = Math.floor(Math.random() * 5) + 1;
				feature.properties.dataTotalBA = Math.floor(Math.random() * 5) + 1;
				feature.properties.dataTotalBB = Math.floor(Math.random() * 5) + 1;
				feature.properties.dataTotalBC = Math.floor(Math.random() * 5) + 1;
				feature.properties.dataTotalBD = Math.floor(Math.random() * 5) + 1;
				feature.properties.dataTotalBE = Math.floor(Math.random() * 5) + 1;
				feature.properties.dataTotalBF = Math.floor(Math.random() * 5) + 1;
				feature.properties.dataTimeA = Math.floor(Math.random() * 30) + 1;
				feature.properties.dataTimeB = Math.floor(Math.random() * 30) + 1;
				feature.properties.dataAccidentA = Math.floor(Math.random() * 100);
				feature.properties.dataAccidentB = Math.floor(Math.random() * 100);
				feature.properties.dataPassengersA = Math.floor(Math.random() * 40) + 1;
				feature.properties.dataPassengersB = Math.floor(Math.random() * 40) + 1;
				feature.properties.dataExchangeA = Math.floor(Math.random() * 100);
				feature.properties.dataExchangeB = Math.floor(Math.random() * 100);
				feature.properties.dataTripA = Math.floor(Math.random() * 100);
				feature.properties.dataTripB = Math.floor(Math.random() * 100);
				feature.properties.dataTrafficjamA = Math.floor(Math.random() * 100);
				feature.properties.dataTrafficjamB = Math.floor(Math.random() * 100);
				feature.properties.dataCostA = Math.floor(Math.random() * 600) + 1;
				feature.properties.dataCostB = Math.floor(Math.random() * 600) + 1;
				feature.properties.dataBCA = Math.floor(Math.random() * 600);
				feature.properties.dataBCB = Math.floor(Math.random() * 600);
			}
		});
		return data;
	}
	function displayMesh() {
		//meshLoding.classList.remove('hidden');
		fetch('assets/data/nighttime_population_v3.zip')
			.then(response => response.arrayBuffer())
			.then(buffer => JSZip.loadAsync(buffer))
			.then(zip => zip.file('nighttime_population_v3.geojson').async('string'))
			.then(geojsonString => {
				let data = JSON.parse(geojsonString);
				// データを追加
				data = addDataToGeoJSON(data);
				const bounds = map.getBounds();
				const inBounds = [];
				const outOfBounds = [];
				data.features.forEach(feature => {
					if (feature.geometry && feature.geometry.coordinates) {
						let polygonCoords = feature.geometry.coordinates;
						if (feature.geometry.type === 'MultiPolygon') {
							polygonCoords = polygonCoords[0];
						}
						const isWithinBounds = polygonCoords[0].some(coord => {
							const latlng = L.latLng(coord[1], coord[0]);
							return bounds.contains(latlng);
						});
						if (isWithinBounds) {
							inBounds.push(feature);
						} else {
							outOfBounds.push(feature);
						}
					}
				});
				// 既存のメッシュレイヤーを削除
				if (meshLayer) {
					map.removeLayer(meshLayer);
				}
				if (outOfBoundsLayer) {
					map.removeLayer(outOfBoundsLayer);
				}
				let meshDetail = {
					pane: 'meshPane',
					style: function (feature) {
						if (requiredProperties.some(prop => feature.properties[prop] === undefined || feature.properties[prop] === null)) {
							return meshStyleDisabled;
						}
						return meshStyle;
					},
					onEachFeature: function (feature, layer) {
						if (requiredProperties.some(prop => feature.properties[prop] === undefined || feature.properties[prop] === null)) {
							return;
						}
						layer.on('click', function (e) {
							if (selectedLayer) {
								selectedLayer.setStyle(meshStyle);
							}
							if (selectedLayer === layer) {
								selectedLayer = null;
								updateCharts(initialData);
							} else {
								selectedLayer = layer;
								layer.setStyle(meshStyleCurrent);
								currentMesh = feature.properties;
								updateCharts(currentMesh);
								// クリックされたメッシュの情報をポップアップで表示
								let popupContent = `平均所要時間：${currentMesh.dataTimeB}分<br>交通事故発生率：${currentMesh.dataAccidentB}％<br>	平均乗客数：${currentMesh.dataPassengersB}人<br>交流発生効果：${currentMesh.dataExchangeB}％<br>渋滞発生頻度：${currentMesh.dataTrafficjamB}％<br>運用コスト：${currentMesh.dataCostB}円`;
								L.popup()
									.setLatLng(e.latlng)
									.setContent(popupContent)
									.openOn(map);
							}
						});
					}
				}
				// 表示範囲内のメッシュを優先して描画
				meshLayer = L.geoJSON(inBounds, meshDetail).addTo(map);
				// 範囲外のメッシュを遅延して描画
				setTimeout(() => {
					outOfBoundsLayer = L.geoJSON(outOfBounds, meshDetail).addTo(map);
				}, 1000);
				//meshLoding.classList.add('hidden');
			});
	}
	function removeMesh() {
		if (meshLayer) {
			map.removeLayer(meshLayer);
			meshLayer = null;
		}
		if (outOfBoundsLayer) {
			map.removeLayer(outOfBoundsLayer);
			outOfBoundsLayer = null;
		}
		map.closePopup();
		updateCharts(initialData);
	}
	displayMesh();
	//ターゲット選択
	const targetButtons = document.querySelectorAll('.js-target');
	const targetItems = document.querySelectorAll('.js-target-item');
	const targetChecked = document.querySelector('.js-target:checked');
	if (targetChecked) {
		const target = targetChecked.value;
		targetItems.forEach(item => {
			item.classList.remove('current');
			if (item.dataset.target === target) {
				item.classList.add('current');
			}
		});
	}
	targetButtons.forEach(radio => {
		radio.addEventListener('change', function () {
			const target = this.value;
			targetItems.forEach(item => {
				item.classList.remove('current');
				if (item.dataset.target === target) {
					item.classList.add('current');
				}
			});
		});
	});
});
