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

    const totalTasks = stepEls.length;
    const idleLabels = [
      '「比較する」で変更前後を集計',
      '駅周辺の人数差とピークを計算',
      '代表ユーザーの1日をAIで要約',
    ];
    const busyLabels = [
      '運航頻度変更前後を計算中',
      '西条駅周辺人数を計算中',
      'AIストーリーを生成中',
    ];
    const doneLabels = [
      '変更前後の集計が完了',
      '西条駅周辺人数の計算が完了',
      'AIストーリー生成が完了',
    ];
    const retryLabels = [
      '運航頻度変更前後を再実行してください',
      '西条駅周辺人数を再計算してください',
      'AIストーリーを再生成してください',
    ];
    const state = {
      statusByTask: ['idle', 'idle', 'idle'],
      mode: 'frequency',
      message: '3つのレビュー項目はどの順番でも確認できます。気になるものから試してください。',
    };

    function completedCount() {
      return state.statusByTask.filter((status) => status === 'done').length;
    }

    function labelForTask(index) {
      const status = state.statusByTask[index];
      if (status === 'done') return doneLabels[index];
      if (status === 'busy') return busyLabels[index];
      if (status === 'retry') return retryLabels[index];
      return idleLabels[index];
    }

    function setQuestView() {
      const doneCount = completedCount();
      const progress = (doneCount / totalTasks) * 100;
      const value = `${doneCount} / ${totalTasks} 完了`;

      valueEl.textContent = value;
      progressLabelEl.textContent = value;
      copyEl.textContent = state.message;
      progressEl.style.setProperty('--progress', `${progress}%`);

      stepEls.forEach((el, index) => {
        if (state.statusByTask[index] === 'done') el.dataset.state = 'done';
        else if (state.statusByTask[index] === 'busy' || state.statusByTask[index] === 'retry') el.dataset.state = 'current';
        else el.dataset.state = 'todo';
      });
      stepTextEls.forEach((el, index) => {
        el.textContent = labelForTask(index);
      });
    }

    function setError(task, message) {
      state.statusByTask[task - 1] = 'retry';
      state.message = message || '処理に失敗しました。';
      setQuestView();
    }

    setQuestView();

    window.addEventListener('dtsb:agg-compare-started', (ev) => {
      if (ev?.detail?.mode !== 'frequency') return;
      state.statusByTask[0] = 'busy';
      state.message = '運航頻度変更前後を集計しています。ほかの項目は後からでも確認できます。';
      setQuestView();
    });

    window.addEventListener('dtsb:agg-compare-completed', (ev) => {
      const detail = ev && ev.detail ? ev.detail : {};
      if (detail.mode !== 'frequency') return;
      state.statusByTask[0] = 'done';
      state.mode = String(detail.mode || 'frequency');
      state.message = '運航頻度変更前後の集計が完了しました。残りの項目はどちらからでも確認できます。';
      setQuestView();
    });

    window.addEventListener('dtsb:agg-compare-failed', (ev) => {
      if (ev?.detail?.mode !== 'frequency') return;
      setError(1, ev?.detail?.error || '運航頻度変更前後の集計に失敗しました。');
    });

    window.addEventListener('dtsb:station-compare-started', () => {
      state.statusByTask[1] = 'busy';
      state.message = '西条駅周辺人数を計算しています。';
      setQuestView();
    });

    window.addEventListener('dtsb:station-compare-completed', () => {
      state.statusByTask[1] = 'done';
      state.message = completedCount() === totalTasks
        ? '3つのレビュー項目が完了しました。'
        : '西条駅周辺人数の計算が完了しました。残りの項目はどの順番でも確認できます。';
      setQuestView();
    });

    window.addEventListener('dtsb:station-compare-failed', (ev) => {
      setError(2, ev?.detail?.error || '西条駅周辺人数の計算に失敗しました。');
    });

    window.addEventListener('dtsb:story-started', () => {
      state.statusByTask[2] = 'busy';
      state.message = 'AIストーリーを生成しています。';
      setQuestView();
    });

    window.addEventListener('dtsb:story-completed', () => {
      state.statusByTask[2] = 'done';
      state.message = completedCount() === totalTasks
        ? '3つのレビュー項目が完了しました。'
        : 'AIストーリー生成が完了しました。残りの項目も任意の順番で確認できます。';
      setQuestView();
    });

    window.addEventListener('dtsb:story-failed', (ev) => {
      setError(3, ev?.detail?.error || 'AIストーリー生成に失敗しました。');
    });
  });
})();
