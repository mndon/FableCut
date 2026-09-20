/* Runs only in the isolated browser test page, after the normal editor scripts. */
(async () => {
  const checks = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Editor did not become ready');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const chooseLanguage = value => {
    $('setLanguage').value = value;
    $('setLanguage').dispatchEvent(new Event('change', { bubbles: true }));
  };
  const report = data => fetch('/__ui-test-result', { method: 'POST', body: JSON.stringify(data) });
  try {
    await waitFor(() => state.connected && project.name === 'Export');
    const phase = sessionStorage.getItem('ui-test-phase');
    if (!phase) {
      check(document.documentElement.lang === 'zh-CN', 'Chinese is the fresh default');
      check(state.trackSize === 's' && document.body.classList.contains('track-size-s'), 'S is the fresh layout');
      check($('trackSizeGroup').querySelector('[data-track-size=s]').classList.contains('on'), 'S button is active');
      check($('btnExport').textContent === '⬇ 导出' && $('btnSettings').title === '设置', 'toolbar text and tooltips are Chinese');
      check($('binList').textContent.includes('Settings'), 'user media names remain untouched');
      selectClip('title');
      check($('inspector').textContent.includes('变换'), 'dynamic inspector is Chinese');
      check($('inspector').querySelector('[data-k=transIn]').value === 'fade', 'transition values stay canonical');
      check($('inspector').querySelector('[data-k=textAnim]').value === 'word-pop', 'animation values stay canonical');
      check($('inspector').querySelector('[data-k=font]').value === 'Arial', 'font family stays canonical');
      check($('inspector').querySelector('[data-k=text]').value === 'Settings <b>Export</b> {count}', 'caption content is untouched');
      const snapshot = JSON.stringify(project);
      drawFrame(0.5);
      const pixels = els.preview.toDataURL();
      $('btnSettings').click();
      check(document.activeElement === $('setLanguage'), 'language control receives dialog focus');
      $('setLinkSelect').checked = true;
      $('setLinkSelect').dispatchEvent(new Event('change', { bubbles: true }));
      chooseLanguage('en');
      check(document.documentElement.lang === 'en' && $('settingsTitle').textContent === 'Settings', 'settings switches immediately to English');
      check($('btnExport').textContent === '⬇ Export' && $('btnSettings').getAttribute('aria-label') === 'Settings', 'toolbar and accessible label switch');
      check($('inspector').textContent.includes('Transform'), 'existing inspector switches immediately');
      check($('inspector').querySelector('[data-k=transIn]').value === 'fade', 'selected transition survives switching');
      check(JSON.stringify(project) === snapshot, 'language switching does not modify the project');
      drawFrame(0.5);
      check(els.preview.toDataURL() === pixels, 'language switching does not alter compositor pixels');
      $('btnCloseSettings').focus();
      $('btnCloseSettings').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      check(document.activeElement === $('setLanguage'), 'settings focus trap includes the language control');
      chooseLanguage('zh-CN');
      check($('settingsTitle').textContent === '设置' && $('inspector').textContent.includes('变换'), 'switching back restores Chinese');
      closeSettings();
      $('btnHelp').click();
      check($('helpOverlay').textContent.includes('键盘快捷键'), 'shortcut help is Chinese');
      $('btnCloseHelp').click();
      openExportSetup();
      check($('exportSetup').textContent.includes('快速（ffmpeg）'), 'export dialog is Chinese');
      $('btnCancelSetup').click();
      openSettings();
      chooseLanguage('en');
      setTrackSize('m');
      sessionStorage.setItem('ui-test-checks', JSON.stringify(checks));
      sessionStorage.setItem('ui-test-project', snapshot);
      sessionStorage.setItem('ui-test-phase', 'reload');
      location.reload();
      return;
    }
    checks.push(...JSON.parse(sessionStorage.getItem('ui-test-checks') || '[]'));
    if (phase === 'reload') {
      check(document.documentElement.lang === 'en', 'language preference survives reload');
      check(state.trackSize === 'm', 'saved layout is preserved');
      openSettings();
      check($('setLinkSelect').checked && $('setLanguage').value === 'en', 'existing selection preference survives language updates');
      closeSettings();
      $('btnLayoutReset').click();
      check(state.trackSize === 's' && localStorage.getItem('fablecut-track-size') === 's', 'Layout reset restores S');
      check(JSON.stringify(project) === sessionStorage.getItem('ui-test-project'), 'project remains unchanged after reload');
      localStorage.setItem('fablecut-settings', '{broken');
      sessionStorage.setItem('ui-test-checks', JSON.stringify(checks));
      sessionStorage.setItem('ui-test-phase', 'invalid');
      location.reload();
      return;
    }
    check(document.documentElement.lang === 'zh-CN' && !getSetting('linkSelect'), 'invalid preferences recover to defaults');
    await report({ ok: true, checks });
  } catch (error) { await report({ ok: false, error: error.stack, checks }); }
})();
