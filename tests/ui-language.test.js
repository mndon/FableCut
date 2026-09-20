"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const i18n = require('../i18n');
const root = path.resolve(__dirname, '..');

const placeholders = message => [...message.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
test('translation catalog covers marked UI, dynamic labels and preserves placeholders', () => {
  for (const [key, value] of Object.entries(i18n.messages)) {
    assert.ok(value, key);
    assert.deepEqual(placeholders(value), placeholders(key), key);
  }
  const decode = s => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const needed = [...html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)].map(m => decode(m[1]));
  for (const file of ['app.js', 'optimized-export.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    needed.push(...[...source.matchAll(/(?:uiText|uiAttr|row|sel|check|fontGroup)\(("(?:[^"\\]|\\.)*")/g)].map(m => JSON.parse(m[1])));
    needed.push(...[...source.matchAll(/slider\("([^"]+)"/g)].map(m => m[1][0].toUpperCase() + m[1].slice(1)));
    for (const name of ['TRANSITIONS', 'TEXT_ANIMS', 'BLEND_MODES']) {
      const array = source.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`));
      if (array) needed.push(...vm.runInNewContext(array[1]));
    }
  }
  for (const key of needed) assert.ok(Object.hasOwn(i18n.messages, key), `Missing Chinese translation: ${key}`);
  i18n.setLanguage('en');
  assert.equal(i18n.text('Settings'), 'Settings');
  i18n.setLanguage('zh-CN');
  assert.equal(i18n.text('Settings'), '设置');
  assert.equal(i18n.text('Loading Google font "{name}"…', { name: 'Settings {count}' }), '正在加载 Google 字体“Settings {count}”…');
  assert.equal(i18n.text('Unknown text'), 'Unknown text');
  assert.equal(i18n.normalize('invalid'), 'zh-CN');
});

test('browser switches and persists UI language without changing project data or pixels', { skip: process.env.FABLECUT_BROWSER_TEST !== '1', timeout: 90000 }, async t => {
  const browser = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(browser)) { t.skip('Requires Chrome/Chromium; set CHROME_PATH'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fablecut-ui-language-'));
  const projectDir = path.join(directory, 'data/projects/check');
  fs.mkdirSync(path.join(projectDir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'media/shape.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({ name: 'Export', revision: 1, width: 320, height: 180, fps: 25,
    media: [{ id: 'media', name: 'Settings', kind: 'svg', src: '/projects/check/media/shape.svg', width: 10, height: 10, duration: 4 }],
    clips: [{ id: 'title', name: 'Settings', kind: 'text', track: 'V1', start: 0, in: 0, duration: 2,
      transitionIn: { type: 'fade', duration: 0.2 }, props: { text: 'Settings <b>Export</b> {count}', font: 'Arial', fontSize: 24, textAnim: 'word-pop' } }] }));
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const reserve = http.createServer(); await listen(reserve);
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const server = spawn(process.execPath, [path.join(root, 'cli/runtime/server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), FABLECUT_DATA_DIR: path.join(directory, 'data') }, stdio: ['ignore', 'ignore', 'pipe'] });
  const children = [server];
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(resolve => child.once('close', resolve)); child.kill();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await closed; clearTimeout(timer);
  }
  t.after(async () => { for (const child of children.reverse()) await stop(child); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/status')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const proxy = http.createServer(async (request, response) => {
    if (request.url === '/__ui-test-result') {
      let body = ''; for await (const chunk of request) body += chunk;
      response.end('ok'); finish(JSON.parse(body)); return;
    }
    if (request.url === '/__ui-test.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(fs.readFileSync(path.join(__dirname, 'fixtures/ui-language-browser.js'))); return;
    }
    if (request.url.startsWith('/?')) {
      const html = await (await fetch(base + request.url)).text();
      response.setHeader('Content-Type', 'text/html');
      response.end(html.replace('</body>', '<script src="/__ui-test.js"></script></body>')); return;
    }
    const upstream = http.request(base + request.url, { method: request.method, headers: { ...request.headers, host: `127.0.0.1:${port}` } }, remote => {
      response.writeHead(remote.statusCode, remote.headers); remote.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(upstream); response.on('close', () => upstream.destroy());
  });
  await listen(proxy);
  t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const chrome = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []), '--window-size=1440,1000',
    '--user-data-dir=' + path.join(directory, 'profile'), `http://127.0.0.1:${proxy.address().port}/?project=check`], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(chrome);
  let stderr = ''; chrome.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
  let timer;
  try {
    const report = await Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('UI test timed out: ' + stderr)), 45000); })]);
    assert.equal(report.ok, true, report.error);
    assert.ok(report.checks.length >= 25, JSON.stringify(report));
    console.log(`Verified ${report.checks.length} browser UI checks`);
  } finally { clearTimeout(timer); }
});
