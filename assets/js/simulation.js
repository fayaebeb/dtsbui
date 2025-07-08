const fileRouteA = 'assets/data/BRT_route_a.geojson';
const fileRouteB = 'assets/data/BRT_route_b.geojson';
const fileStopA = 'assets/data/BRT_stops_a.geojson';
const fileStopB = 'assets/data/BRT_stops_b.geojson';

const routeDefault = '#aaa';     // Example default color
const routSelect = '#f00';       // Example selected color
const stopDefault = (feature, latlng) => L.circleMarker(latlng, { color: '#666' });
const stopSelect = (feature, latlng) => L.circleMarker(latlng, { color: '#f00' });

let simulationRouteA = L.layerGroup().addTo(map);
let routeB = L.layerGroup().addTo(map);
let stopsA = L.layerGroup().addTo(map);
let stopsB = L.layerGroup().addTo(map);

document.addEventListener('DOMContentLoaded', function () {
        // バス停データの取得と表示
        function fetchAndDisplayStops(file, layer, pointToLayerFunc) {
                fetch(file).then(response => response.json()).then(data => {
                        L.geoJSON(data, { pointToLayer: pointToLayerFunc }).eachLayer(l => layer.addLayer(l));
                });
        }
        // 路線の色切り替え
        function routeChange() {
                setTimeout(() => {
                        const currentRoute = document.querySelector('.js-parameter-content.current .js-route[open]');
                        const routeData = currentRoute ? currentRoute.dataset.route : null;
                        stopsA.clearLayers();
                        stopsB.clearLayers();
                        if (routeData) {
                                let issimulationRouteA = routeData.includes('_a');
                                let isRouteB = routeData.includes('_b');
                                simulationRouteA.setStyle({ pane: "linePane", color: issimulationRouteA ? routSelect : routeDefault });
                                routeB.setStyle({ pane: "linePane", color: isRouteB ? routSelect : routeDefault });
                                simulationRouteA.getTooltip().getElement().classList.toggle('current', issimulationRouteA);
                                routeB.getTooltip().getElement().classList.toggle('current', isRouteB);
                                fetchAndDisplayStops(fileStopA, stopsA, issimulationRouteA ? stopSelect : stopDefault);
                                fetchAndDisplayStops(fileStopB, stopsB, isRouteB ? stopSelect : stopDefault);
                        } else {
                                simulationRouteA.setStyle({ pane: "linePane", color: routeDefault });
                                routeB.setStyle({ pane: "linePane", color: routeDefault });
                                simulationRouteA.getTooltip().getElement().classList.remove('current');
                                routeB.getTooltip().getElement().classList.remove('current');
                                fetchAndDisplayStops(fileStopA, stopsA, stopDefault);
                                fetchAndDisplayStops(fileStopB, stopsB, stopDefault);
                        }
                }, 500);
        }

        //パラメーター切り替え
        const navLinks = document.querySelectorAll('.js-parameter');
        const tabContents = document.querySelectorAll('.js-parameter-content');
        navLinks.forEach((link, index) => {
                link.addEventListener('click', function () {
                        navLinks.forEach(navLink => navLink.classList.remove('current'));
                        this.classList.add('current');
                        tabContents.forEach((content, contentIndex) => content.classList.toggle('current', contentIndex === index));
                        routeChange();
                        laneCheck();
                });
        });

        //路線のアコーディオン制御
        document.querySelectorAll('.js-parameter-content').forEach(route => {
                const accordions = route.querySelectorAll('.js-route');
                accordions.forEach(accordion => {
                        accordion.addEventListener('toggle', () => {
                                if (accordion.open) {
                                        accordions.forEach(otherAccordion => {
                                                if (otherAccordion !== accordion) {
                                                        otherAccordion.open = false;
                                                }
                                        });
                                        accordion.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                }
                                routeChange();
                                laneCheck();
                        });
                });
        });

        // 専用レーン
        function laneCheck() {
                const rosenPane = document.querySelector('.leaflet-selectRosen-pane');
                const stopPane = document.querySelector('.leaflet-selectStop-pane');
                const selectedValue = document.querySelector('.js-parameter-content.current .js-route[open] .js-route-lanes:checked')?.value;

                if (selectedValue === '1') {
                        document.querySelector('.js-route-mode').style.display = 'block';
                        const markerImages = document.querySelectorAll('.leaflet-marker-pane img, .leaflet-shadow-pane img');
                        markerImages.forEach(img => img.remove());
                        document.querySelector('.leaflet-line-pane').style.opacity = '0.2';
                        if (rosenPane) rosenPane.style.display = 'block';
                        if (stopPane) stopPane.style.display = 'block';

                        // Show popup
                        const popup = document.getElementById('lane-popup');
                        if (popup) {
                                popup.style.display = 'block';
                                setTimeout(() => {
                                        popup.style.display = 'none';
                                }, 3000); // hide after 3 seconds
                        }

                } else {
                        document.querySelector('.js-route-mode').style.display = 'none';
                        document.querySelector('.leaflet-line-pane').style.opacity = '1';
                        if (rosenPane) rosenPane.style.display = 'none';
                        if (stopPane) stopPane.style.display = 'none';
                }
        }
        laneCheck();
        document.querySelectorAll('.js-route-lanes').forEach(input => {
                input.addEventListener('click', laneCheck);
        });
        const lineStyle3 = {
                //専用レーン選択済み
                pane: "selectRosen",
                weight: 8,
                opacity: 1,
                color: '#F5813C',
                dashArray: [5, 5]
        }
        const lineStyle4 = {
                //専用レーン
                pane: "selectRosen",
                weight: 8,
                opacity: 1,
                color: '#FAC09D',
                dashArray: "0",
        }
        const busstop_active = {
                //専用レーンバス停
                pane: "selectStop",
                radius: 6,
                fillColor: "#fff",
                color: "#F5813C",
                weight: 1,
                opacity: 1,
                fillOpacity: 0.8
        }
        let clickedLayers = []; // クリックされたレイヤーを記憶する配列
        function highlightFeature(e) {
                let layer = e.target;
                const layerIndex = clickedLayers.indexOf(layer);
                // 既にクリックされているレイヤーであれば、配列から削除して元のスタイルに戻す
                if (layerIndex > -1) {
                        layer.setStyle(lineStyle4);
                        clickedLayers.splice(layerIndex, 1); // 配列から削除
                } else {
                        // 新しくクリックされたレイヤーであれば、スタイルを変更して配列に追加
                        layer.setStyle(lineStyle3);
                        layer.bringToFront();
                        clickedLayers.push(layer); // 配列に追加
                }
        }
        fetch(fileRouteA)
                .then(response => response.json())
                .then(data => {
                        aRosen = L.geoJSON(data, {
                                style: lineStyle4,
                                pane: "selectRosen", // 明示的に pane を指定
                                onEachFeature: function (features, layer) {
                                        layer.on('click', function (ele) {
                                                highlightFeature(ele);
                                        });
                                        //▼マウスオンでツールチップ
                                        //layer.bindTooltip('<p class="tooltip">名称:' + data['name'], tooltipRosen);
                                        //ダメっぽいlayer.bindPopup('<p class="tooltip">名称:'+data['name'],{ sticky: 'true', direction: 'top', opacity: 0.9 }).openPopup();
                                }
                        }).addTo(map);
                        //aRosen.bindTooltip('<p class="tooltip">' + data['name'], tooltipRosen);
                });
        fetch(fileStopA)
                .then(response => response.json())
                .then(data => {
                        bStops = L.geoJSON(data, {
                                pointToLayer: function (feature, cordinate) {
                                        return L.circleMarker(cordinate, busstop_active)
                                },
                                pane: "selectStop" // 明示的に pane を指定
                        }).addTo(map);
                });
        // Route クリックイベント共通処理
        function handleRouteClick(routeId) {
                const currentContent = document.querySelector('.js-parameter-content.current');
                if (currentContent) {
                        const detailsElements = currentContent.querySelectorAll('details');
                        detailsElements.forEach(details => details.open = details.dataset.route && details.dataset.route.includes(routeId));
                }
        }
        // 初期クリックイベントリスナーを設定
        simulationRouteA.on('click', () => handleRouteClick('_a'));
        routeB.on('click', () => handleRouteClick('_b'));
});
//リセットボタン
document.querySelectorAll('.js-reset').forEach(button => {
        button.addEventListener('click', function () {
                const resetValue = this.dataset.reset;
                const targetElement = document.getElementById(resetValue);
                if (targetElement) {
                        const currentElements = targetElement.querySelectorAll('[data-saved]');
                        currentElements.forEach(element => {
                                const currentValue = element.dataset.saved;
                                if (element.tagName === 'INPUT') {
                                        element.value = currentValue;
                                } else {
                                        element.textContent = currentValue;
                                }
                        });
                        targetElement.querySelectorAll('.js-range-slider').forEach(range => {
                                range.dispatchEvent(new Event('input'));
                        });
                }
        });
});
// 数値入力
document.querySelectorAll('.js-number').forEach(function (numberElement) {
        const numberInput = numberElement.querySelectorAll('.js-number-input');
        const numberButtons = numberElement.querySelectorAll('.js-number-up, .js-number-down');
        // ページ読み込み時に data-saved の値を value に設定
        numberInput.forEach((input) => {
                const savedValue = input.dataset.saved;
                if (savedValue !== undefined) {
                        input.value = savedValue;
                        formatNumber(input);
                        input.dispatchEvent(new Event('input'));
                }
                input.addEventListener("input", (event) => {
                        formatNumber(event.target);
                });
                input.addEventListener("keydown", (event) => {
                        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                                event.preventDefault();
                                let value = parseInt(input.value) || 0;
                                if (event.key === "ArrowUp") {
                                        //value++;
                                        value += 10;
                                } else {
                                        //value--;
                                        value -= 10;
                                }
                                input.value = value;
                                formatNumber(input);
                                input.dispatchEvent(new Event('input'));
                        }
                });
        });
        numberButtons.forEach((button) => {
                button.addEventListener("click", (event) => {
                        const inputId = event.target.dataset.inputId;
                        const input = document.getElementById(inputId);
                        let value = parseInt(input.value) || 0;
                        if (event.target.classList.contains("js-number-up")) {
                                //value++;
                                value += 10;
                        } else {
                                //value--;
                                value -= 10;
                        }
                        input.value = value;
                        formatNumber(input);
                        input.dispatchEvent(new Event('input'));
                });
        });
        function formatNumber(input) {
                let value = input.value;
                if (value.startsWith("+")) {
                        value = value.substring(1);
                }
                let num = parseInt(value) || 0;
                input.value = num >= 0 ? (num === 0 ? "0" : "+" + num) : num;
        }
});
// 運賃の増減
document.querySelectorAll('.js-fare').forEach(function (fareElement) {
        const minInput = fareElement.querySelector('.js-fare-minInput');
        const maxInput = fareElement.querySelector('.js-fare-maxInput');
        const fareInput = fareElement.querySelector('.js-fare-input');
        const minTxt = fareElement.querySelector('.js-fare-minTxt');
        const maxTxt = fareElement.querySelector('.js-fare-maxTxt');
        function updateFareValues() {
                const fareValue = parseInt(fareInput.value) || 0;
                const minDefault = parseInt(minInput.dataset.default) || 0;
                const maxDefault = parseInt(maxInput.dataset.default) || 0;
                const newMinValue = minDefault + fareValue;
                const newMaxValue = maxDefault + fareValue;
                minInput.value = newMinValue;
                maxInput.value = newMaxValue;
                minTxt.textContent = newMinValue;
                maxTxt.textContent = newMaxValue;
        }
        // 読み込み時に実行
        updateFareValues();
        // js-fare-input の値が変化したときに実行
        fareInput.addEventListener('input', updateFareValues);
});
// range入力
document.querySelectorAll('.js-range').forEach(function (rangeElement) {
        const range = rangeElement.querySelector('.js-range-slider');
        const rangeMin = rangeElement.querySelector('.js-range-min');
        const rangeMax = rangeElement.querySelector('.js-range-max');
        const rangeMark = rangeElement.querySelector('.js-range-mark');
        const rangeSavedValue = rangeElement.querySelector('.js-range-saved');
        const rangeChange = rangeElement.querySelector('.js-range-change');
        const rangeChangeValue = rangeElement.querySelector('.js-range-value');
        const rangeChangeDiff = rangeElement.querySelector('.js-range-diff');
        // デフォルト値の表示
        rangeSavedValue.textContent = range.dataset.default;
        // デフォルト値の位置に印を配置
        const halfPosition = range.max / 2;
        const defaultPosition = (range.dataset.default - range.min) / (range.max - range.min) * 100;
        // デフォルト値の印の位置調整
        const markWidth = rangeMark.offsetWidth;
        let defaultAdjust = 0;
        if (range.dataset.default == range.min) {
                if (range.dataset.saved == range.min) {
                        defaultAdjust = 7 - (markWidth / 2);
                } else {
                        defaultAdjust = 0;
                }
        } else if (range.dataset.default < halfPosition) {
                defaultAdjust = halfPosition - range.dataset.default;
        } else if (range.dataset.default == halfPosition) {
                defaultAdjust = 0 - (markWidth / 2);
        } else if (range.dataset.default == range.max) {
                if (range.dataset.saved == range.max) {
                        defaultAdjust = 0 - 7 - (markWidth / 2);
                } else {
                        defaultAdjust = 0 - (markWidth / 2);
                }
        } else {
                defaultAdjust = 0 - range.dataset.default + halfPosition - markWidth;
        }
        rangeMark.style.left = `calc(${defaultPosition}% + ${defaultAdjust}px)`;
        rangeSavedValue.style.left = `calc(${defaultPosition}% + ${defaultAdjust}px)`;
        function rangeSlider(rangeValue) {
                // デフォルト値＝初期値の場合classにequal追加
                if (range.dataset.default == rangeValue) {
                        rangeMark.classList.add('equal');
                } else {
                        rangeMark.classList.remove('equal');
                }
        }
        // デフォルト値＝初期値の場合classにequal追加
        if (range.dataset.default == range.dataset.saved) {
                rangeMark.classList.add('equal');
        } else {
                rangeMark.classList.remove('equal');
        }
        // 初期値
        range.value = range.dataset.saved;
        // 初期値の吹き出し位置調整
        const currentPosition = (range.dataset.saved - range.min) / (range.max - range.min) * 100;
        let currentAdjust = 0;
        if (range.dataset.saved == range.min) {
                currentAdjust = 7 - (markWidth / 2);
        } else if (range.dataset.saved < halfPosition) {
                currentAdjust = halfPosition - range.dataset.saved;
        } else if (range.dataset.saved == halfPosition) {
                currentAdjust = 0 - (markWidth / 2);
        } else if (range.dataset.saved == range.max) {
                currentAdjust = 0 - 7 - (markWidth / 2);
        } else {
                currentAdjust = 0 - range.dataset.saved + halfPosition - markWidth;
        }
        rangeChange.style.left = `calc(${currentPosition}% + ${currentAdjust}px)`;
        // 初期値＝最小値のとき目盛りの値を隠す
        if (range.dataset.saved == range.min) {
                rangeMin.classList.add('hide');
        } else {
                rangeMin.classList.remove('hide');
        }
        // 初期値＝最大値のとき目盛りの値を隠す
        if (range.dataset.saved == range.max) {
                rangeMax.classList.add('hide');
        } else {
                rangeMax.classList.remove('hide');
        }
        // 入力値の変化を監視
        range.addEventListener('input', function () {
                // デフォルト値の印の位置調整
                if (range.dataset.default == range.min) {
                        if (this.value == range.min) {
                                defaultAdjust = 7 - (markWidth / 2);
                        } else {
                                defaultAdjust = 0;
                        }
                } else if (range.dataset.default < halfPosition) {
                        defaultAdjust = halfPosition - range.dataset.default;
                } else if (range.dataset.default == halfPosition) {
                        defaultAdjust = 0 - (markWidth / 2);
                } else if (range.dataset.default == range.max) {
                        if (this.value == range.max) {
                                defaultAdjust = 0 - 7 - (markWidth / 2);
                        } else {
                                defaultAdjust = 0 - (markWidth / 2);
                        }
                } else {
                        defaultAdjust = 0 - range.dataset.default + halfPosition - markWidth;
                }
                rangeMark.style.left = `calc(${defaultPosition}% + ${defaultAdjust}px)`;
                // 入力値＝デフォルト値の場合classにequal追加
                if (this.value == range.dataset.default) {
                        rangeMark.classList.add('equal');
                } else {
                        rangeMark.classList.remove('equal');
                }
                // 入力値の吹き出し位置調整
                const currentPosition = (this.value - range.min) / (range.max - range.min) * 100;
                let currentAdjust = 0;
                if (this.value == range.min) {
                        currentAdjust = 7 - (markWidth / 2);
                } else if (this.value < halfPosition) {
                        currentAdjust = halfPosition - this.value;
                } else if (this.value == halfPosition) {
                        currentAdjust = 0 - (markWidth / 2);
                } else if (this.value == range.max) {
                        currentAdjust = 0 - 7 - (markWidth / 2);
                } else {
                        currentAdjust = 0 - this.value + halfPosition - markWidth;
                }
                rangeChange.style.left = `calc(${currentPosition}% + ${currentAdjust}px)`;
                // 入力値＝最小値のとき目盛りの値を隠す
                if (this.value == range.min) {
                        rangeMin.classList.add('hide');
                } else {
                        rangeMin.classList.remove('hide');
                }
                // 入力値＝最大値のとき目盛りの値を隠す
                if (this.value == range.max) {
                        rangeMax.classList.add('hide');
                } else {
                        rangeMax.classList.remove('hide');
                }
                // 入力値の吹き出しの更新
                let diff = this.value - range.dataset.default;
                rangeChangeValue.textContent = this.value;
                rangeChangeDiff.textContent = `(${diff >= 0 ? '+' : ''}${diff})`;
        });
});