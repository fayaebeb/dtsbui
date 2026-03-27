(function () {
  function onReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  onReady(() => {
    const valueEl = document.getElementById('resultsQuestValue');
    const progressLabelEl = document.getElementById('resultsQuestProgressLabel');
    const progressEl = document.getElementById('resultsQuestProgress');
    const copyEl = document.getElementById('resultsQuestCopy');
    const stepEls = [
      document.getElementById('resultsQuestStep1'),
      document.getElementById('resultsQuestStep2'),
      document.getElementById('resultsQuestStep3'),
    ];
    const stepTextEls = [
      document.getElementById('resultsQuestStep1Text'),
      document.getElementById('resultsQuestStep2Text'),
      document.getElementById('resultsQuestStep3Text'),
    ];

    if (!valueEl || !progressLabelEl || !progressEl || !copyEl || stepEls.some((el) => !el) || stepTextEls.some((el) => !el)) {
      return;
    }

    const state = {
      done: [false, false, false],
      activeStep: 1,
      mode: 'frequency',
      message: '「比較する」を押して、運航頻度変更前後の集計から始めます。',
      labels: [
        '「比較する」で変更前後を集計',
        '駅周辺の人数差とピークを計算',
        '代表ユーザーの1日をAIで要約',
      ],
    };

    function setQuestView() {
      const progress = state.done[2] ? 100 : state.done[1] ? 68 : state.done[0] ? 34 : 0;
      const value = state.done[2] ? 'COMPLETE' : `STEP ${state.activeStep} / 3`;

      valueEl.textContent = value;
      progressLabelEl.textContent = value;
      copyEl.textContent = state.message;
      progressEl.style.setProperty('--progress', `${progress}%`);

      stepEls.forEach((el, index) => {
        if (state.done[index]) el.dataset.state = 'done';
        else if (state.activeStep === index + 1) el.dataset.state = 'current';
        else el.dataset.state = 'todo';
      });
      stepTextEls.forEach((el, index) => {
        el.textContent = state.labels[index];
      });
    }

    function setError(step, message) {
      state.activeStep = step;
      state.message = message || '処理に失敗しました。';
      if (step === 1) state.labels[0] = '運航頻度変更前後を再実行してください';
      if (step === 2) state.labels[1] = '西条駅周辺人数を再計算してください';
      if (step === 3) state.labels[2] = 'AIストーリーを再生成してください';
      setQuestView();
    }

    setQuestView();

    window.addEventListener('dtsb:agg-compare-started', () => {
      state.done[0] = false;
      state.done[1] = false;
      state.done[2] = false;
      state.activeStep = 1;
      state.message = '運航頻度変更前後を集計しています。';
      state.labels = [
        '運航頻度変更前後を計算中',
        '駅周辺の人数差とピークを計算',
        '代表ユーザーの1日をAIで要約',
      ];
      setQuestView();
    });

    window.addEventListener('dtsb:agg-compare-completed', (ev) => {
      const detail = ev && ev.detail ? ev.detail : {};
      state.done[0] = true;
      state.done[1] = false;
      state.done[2] = false;
      state.mode = String(detail.mode || 'frequency');
      state.labels[0] = '変更前後の集計が完了';
      state.labels[1] = '「計算する」で西条駅周辺人数を計算';
      state.labels[2] = 'AIストーリー生成を押して要約';
      if (state.mode !== 'frequency') {
        state.activeStep = 2;
        state.message = 'Results Quest は「運航頻度変更前後」モードで進行します。';
      } else {
        state.activeStep = 2;
        state.message = 'Step 1 完了。次に「計算する」で西条駅周辺人数を計算してください。';
      }
      setQuestView();
    });

    window.addEventListener('dtsb:agg-compare-failed', (ev) => {
      state.done[0] = false;
      state.done[1] = false;
      state.done[2] = false;
      state.labels[0] = '運航頻度変更前後を再実行してください';
      setError(1, ev?.detail?.error || '運航頻度変更前後の集計に失敗しました。');
    });

    window.addEventListener('dtsb:station-compare-started', () => {
      state.activeStep = 2;
      state.labels[1] = '西条駅周辺人数を計算中';
      state.message = '西条駅周辺人数を計算しています。';
      setQuestView();
    });

    window.addEventListener('dtsb:station-compare-completed', () => {
      state.done[1] = true;
      state.done[2] = false;
      state.activeStep = 3;
      state.labels[1] = '西条駅周辺人数の計算が完了';
      state.labels[2] = 'AIストーリー生成を押して要約';
      state.message = 'Step 2 完了。最後に AI ストーリー生成を押してください。';
      setQuestView();
    });

    window.addEventListener('dtsb:station-compare-failed', (ev) => {
      state.labels[1] = '西条駅周辺人数を再計算してください';
      setError(2, ev?.detail?.error || '西条駅周辺人数の計算に失敗しました。');
    });

    window.addEventListener('dtsb:story-started', () => {
      state.activeStep = 3;
      state.labels[2] = 'AIストーリーを生成中';
      state.message = 'AIストーリーを生成しています。';
      setQuestView();
    });

    window.addEventListener('dtsb:story-completed', () => {
      state.done[2] = true;
      state.activeStep = 3;
      state.labels[2] = 'AIストーリー生成が完了';
      state.message = '3ステップすべて完了しました。';
      setQuestView();
    });

    window.addEventListener('dtsb:story-failed', (ev) => {
      state.labels[2] = 'AIストーリーを再生成してください';
      setError(3, ev?.detail?.error || 'AIストーリー生成に失敗しました。');
    });
  });
})();
