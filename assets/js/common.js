//【共通】メニュー開閉
const menuToToggle = document.querySelectorAll('.js-menu-toggle');
let menu = localStorage.getItem('menuClose');
document.addEventListener('DOMContentLoaded', function () {
	if (menu) {
		menuToToggle.forEach(element => {
			element.classList.toggle('close');
		});
	}
	window.dispatchEvent(new Event('resize'));
});
document.querySelector('.js-menu-open').addEventListener('click', function () {
	menuToToggle.forEach(element => {
		element.classList.toggle('close');
	});
	if (!menu) {
		localStorage.setItem('menuClose', true);
	} else {
		localStorage.removeItem('menuClose');
	}
	window.dispatchEvent(new Event('resize'));
});

//【共通】ポップアップ
/* document.addEventListener('DOMContentLoaded', function () {
	const fixedOpen = document.querySelector('.js-fixed-open');
	const fixedElement = document.querySelector('.js-fixed');
	const fixedClose = document.querySelectorAll('.js-fixed-close');
	const fixedBox = document.querySelector('.js-fixed-box');
	if (fixedOpen && fixedElement && fixedBox) {
		fixedOpen.addEventListener('click', function () {
			fixedElement.classList.toggle('show');
			if (fixedElement.classList.contains('show')) {
				fixedBox.style.height = fixedBox.scrollHeight + 'px';
			} else {
				fixedBox.style.height = '';
			}
		});
	}
	if (fixedClose && fixedElement && fixedBox) {
		fixedClose.forEach(function (btn) {
			btn.addEventListener('click', function () {
				fixedElement.classList.remove('show');
				fixedBox.style.height = '';
			});
		});
	}
	if (fixedElement && fixedBox) {
		let resizeTimer;
		window.addEventListener('resize', function () {
			fixedBox.style.height = '';
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(function () {
				if (fixedElement.classList.contains('show')) {
					fixedBox.style.height = fixedBox.scrollHeight + 'px';
				}
			}, 250);
		});
	}
}); */
document.addEventListener('DOMContentLoaded', function () {
	const fixedOpenButtons = document.querySelectorAll('.js-fixed-open');
	const fixedElements = document.querySelectorAll('.js-fixed');
	const fixedCloseButtons = document.querySelectorAll('.js-fixed-close');
	fixedOpenButtons.forEach(function (openButton) {
		openButton.addEventListener('click', function () {
			const targetId = openButton.dataset.fixed;
			const targetElement = document.getElementById(targetId);
			const targetBox = targetElement ? targetElement.querySelector('.js-fixed-box') : null;

			if (targetElement && targetBox) {
				targetElement.classList.toggle('show');
				if (targetElement.classList.contains('show')) {
					targetBox.style.height = targetBox.scrollHeight + 'px';
				} else {
					targetBox.style.height = '';
				}
			}
		});
	});
	fixedCloseButtons.forEach(function (closeButton) {
		closeButton.addEventListener('click', function () {
			const parentFixed = closeButton.closest('.js-fixed');
			const targetBox = parentFixed ? parentFixed.querySelector('.js-fixed-box') : null;

			if (parentFixed && targetBox) {
				parentFixed.classList.remove('show');
				targetBox.style.height = '';
			}
		});
	});
	fixedElements.forEach(function (fixedElement) {
		const fixedBox = fixedElement.querySelector('.js-fixed-box');
		if (fixedBox) {
			let resizeTimer;
			window.addEventListener('resize', function () {
				fixedBox.style.height = '';
				clearTimeout(resizeTimer);
				resizeTimer = setTimeout(function () {
					if (fixedElement.classList.contains('show')) {
						fixedBox.style.height = fixedBox.scrollHeight + 'px';
					}
				}, 250);
			});
		}
	});
});

//【共通】ボタンエリア高さ固定
document.addEventListener('DOMContentLoaded', function () {
	setBtnsHeight();
});
window.addEventListener('resize', function () {
	setBtnsHeight();
});
function setBtnsHeight() {
	const btns = document.querySelectorAll('.js-btns');
	btns.forEach(btn => {
		btn.style.height = btn.offsetHeight + 'px';
	});
}

//【共通】シミュレーションへの遷移
document.addEventListener('DOMContentLoaded', function () {
	const simulationLink = document.querySelector('.js-menu-simulation');
	simulationLink.addEventListener('click', function (event) {
		event.preventDefault();
		const confirmation = window.confirm('結果を保存しますか？');
		if (confirmation) {
			console.log('結果を保存します。');
			window.location.href = this.getAttribute('href'); // ページ遷移を実行
		} else {
			console.log('結果を保存しません。');
			window.location.href = this.getAttribute('href'); // ページ遷移を実行（保存せずに）
		}
	});
});

//【入力／シミュレーション結果】凡例
document.addEventListener('DOMContentLoaded', function () {
	const legendsButton = document.querySelector('.js-legends');
	const legendsContents = document.querySelector('.js-legends-contents');
	const closeButton = document.querySelector('.js-legends-close');
	if (legendsButton && legendsContents && closeButton) {
		legendsButton.addEventListener('click', function () {
			legendsContents.style.display = 'block';
		});
		closeButton.addEventListener('click', function () {
			legendsContents.style.display = 'none';
		});
	}
});

//【シミュレーション結果／結果一覧】名称変更
const areaNames = document.querySelectorAll('.js-name');
areaNames.forEach(function (areaName) {
	const nameEdit = areaName.querySelector('.js-name-edit');
	const nameInput = areaName.querySelector('.js-name-input');
	if (nameEdit) {
		function editMode() {
			nameInput.removeAttribute('readonly');
			nameInput.focus();
			nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length);
			nameEdit.style.display = 'none';
		}
		nameEdit.addEventListener('click', function () {
			editMode();
		});
		nameInput.addEventListener('blur', function () {
			nameInput.setAttribute('readonly', true);
			nameEdit.style.display = 'block';
		});
		nameInput.addEventListener('focus', () => {
			editMode();
		});
	}
});