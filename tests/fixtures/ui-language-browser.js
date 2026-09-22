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
    $('btnTitle').click();
    const text = getClip(state.selId);
    check(text.props.text === 'Enter Text' && text.name === 'Enter Text', 'new text uses Enter Text');
    check(!els.inspector.querySelector('[data-k=name]'), 'text inspector has no name field');
    check($('btnTitle').textContent.trim() === '+ 文字'
      && $('btnTitle').title === '在播放头处添加文字', 'add text button and tooltip use 文字');
    for (const start of [0, 2]) {
      for (let i = 0; i < STYLE_CYCLE.length; i++) {
        state.time = start;
        runtime.titleStyleIdx = i - 1;
        $('btnTitle').click();
        const added = getClip(state.selId);
        check(added.start === start && added.props.textAnim === 'none',
          'manual ' + STYLE_CYCLE[i] + ' text has no entrance animation at ' + start);
        ctx2d.clearRect(0, 0, els.preview.width, els.preview.height);
        drawClip(added, els.preview.width, els.preview.height, start);
        const rgba = ctx2d.getImageData(0, 0, els.preview.width, els.preview.height).data;
        check(rgba.some((v, index) => index % 4 === 3 && v > 0),
          'manual ' + STYLE_CYCLE[i] + ' text paints visible first-frame pixels at ' + start);
        project.clips = project.clips.filter(c => c.id !== added.id);
      }
    }
    state.time = 0;
    selectClip(text.id);
    focusTextContent();

    const contentSelected = () => {
      const field = els.inspector.querySelector('[data-k=text]');
      return field && document.activeElement === field
        && field.selectionStart === 0 && field.selectionEnd === field.value.length;
    };
    check(contentSelected(), 'adding text focuses and selects its content');
    rebuildClips();
    const timelinePointer = (type, modifiers = {}, target = window) => target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, button: 0,
        pointerId: 2, clientX: 200, clientY: 800, ...modifiers }));
    const clickTimelineText = (modifiers = {}) => {
      const clip = els.tracks.querySelector(`[data-id="${text.id}"]`);
      timelinePointer('pointerdown', modifiers, clip);
      timelinePointer('pointerup', modifiers);
    };
    selectClip(null);
    clickTimelineText();
    check(state.selId === text.id && !contentSelected(), 'timeline text click selects clip without focusing content');
    focusTextContent();
    clickTimelineText();
    check(!isTypingTarget(document.activeElement), 'already-selected timeline text releases content focus');
    selectClip(null);
    clickTimelineText({ ctrlKey: true });
    check(!contentSelected(), 'modifier selection does not focus text content');
    clickTimelineText();
    const clip = els.tracks.querySelector(`[data-id="${text.id}"]`);
    timelinePointer('pointerdown', {}, clip);
    timelinePointer('pointermove', { clientX: 215 });
    timelinePointer('pointerup', { clientX: 215 });
    check(!contentSelected(), 'timeline dragging does not focus text content');
    text.start = 0;
    Object.assign(text.props, { font: 'Arial', textAnim: 'none', fontSize: 24, x: 0, y: 0, rotation: 0 });
    const background = { id: 'background', kind: 'svg', mediaId: 'media', name: 'Background',
      track: 'V1', start: 0, in: 0, duration: 4, props: { ...DEFAULT_PROPS, fit: 'stretch' } };
    project.clips.unshift(background);
    state.time = 1;
    selectClip(background.id);
    check(!!els.inspector.querySelector('[data-k=name]'), 'media inspector retains name field');
    drawFrame(state.time);
    const bounds = clipBounds(text, evalProps(text, state.time), els.preview.width, els.preview.height);
    const rect = els.preview.getBoundingClientRect();
    const x = rect.left + bounds.cx * rect.width / els.preview.width;
    const y = rect.top + bounds.cy * rect.height / els.preview.height;
    // Synthetic pointer events cannot acquire native capture; all events target the canvas directly.
    const capture = els.preview.setPointerCapture;
    els.preview.setPointerCapture = () => {};
    const pointer = (type, dx = 0) => els.preview.dispatchEvent(new PointerEvent(type,
      { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x + dx, clientY: y }));
    pointer('pointerdown'); pointer('pointermove', 1); pointer('pointerup', 1);
    let input = els.inspector.querySelector('[data-k=text]');
    check(state.selId === text.id, 'preview text wins over selected background');
    check(document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length,
      'paused text click focuses and selects content despite slight pointer jitter');
    input.value = 'Edited caption';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    check(text.props.text === 'Edited caption' && text.name === 'Edited caption', 'content edits update clip name');
    input.blur();
    pointer('pointerdown'); pointer('pointerup');
    input = els.inspector.querySelector('[data-k=text]');
    check(document.activeElement === input, 'already-selected text can be clicked to edit again');
    input.blur();
    pointer('pointerdown'); pointer('pointercancel');
    check(document.activeElement !== els.inspector.querySelector('[data-k=text]'), 'cancelled pointer does not focus editor');
    state.playing = true;
    pointer('pointerdown'); pointer('pointerup');
    check(document.activeElement !== els.inspector.querySelector('[data-k=text]'), 'playing text click does not focus editor');
    state.playing = false;
    const originalX = text.props.x;
    pointer('pointerdown'); pointer('pointermove', 15); pointer('pointerup', 15);
    check(text.props.x !== originalX && document.activeElement !== els.inspector.querySelector('[data-k=text]'),
      'drag still moves text without focusing editor');
    els.preview.setPointerCapture = capture;
    rebuildClips();
    focusTextContent();
    clickTimelineText();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    check(!getClip(text.id), 'Delete removes timeline text after leaving content editor');
    await report({ ok: true, checks });
  } catch (error) { await report({ ok: false, error: error.stack, checks }); }
})();
