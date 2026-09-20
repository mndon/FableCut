"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deflateRawSync } = require("node:zlib");
const { extractZip, crc32 } = require("../cli/lib/browser-zip");
const { ensureBrowser, platformKey, executable, downloadArchive, verifyBrowser, VERSION } = require("../cli/lib/browser");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut browser 测试-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function zip(entries) {
  const payloads = [], records = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), content = Buffer.from(entry.content || "");
    const method = entry.stored ? 0 : 8, packed = method ? deflateRawSync(content) : content;
    const checksum = entry.checksum ?? ((crc32(content) ^ 0xffffffff) >>> 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(method, 10); record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    payloads.push(local, name, packed); records.push(record, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...payloads, directory, end]);
}
function installOptions(root, overrides = {}) {
  return { cacheRoot: root, platform: "linux", arch: "x64", candidates: [], env: {}, log() {},
    async download(_url, target) {
      fs.writeFileSync(target, zip([{ name: "chrome-linux64/chrome", content: "fixture browser", mode: 0o100755 }]));
    }, verify() {}, ...overrides };
}

test("ZIP extraction streams stored/deflated files, checks CRC and preserves executables and links", async t => {
  const root = fixture(t), archive = path.join(root, "fixture.zip"), out = path.join(root, "out");
  const entries = [
    { name: "chrome/", mode: 0o40755 },
    { name: "chrome/executable", mode: 0o100755, content: "abc".repeat(100000) },
    { name: "chrome/resources/中文.txt", content: "resources", stored: true },
  ];
  if (process.platform !== "win32") entries.push({ name: "chrome/link", mode: 0o120777, content: "resources/中文.txt" });
  fs.writeFileSync(archive, zip(entries));
  await extractZip(archive, out);
  assert.equal(fs.readFileSync(path.join(out, "chrome/executable"), "utf8"), "abc".repeat(100000));
  if (process.platform !== "win32") {
    assert.ok(fs.statSync(path.join(out, "chrome/executable")).mode & 0o111);
    assert.equal(fs.readFileSync(path.join(out, "chrome/link"), "utf8"), "resources");
  }
  assert.equal(((crc32(Buffer.from("123456789")) ^ 0xffffffff) >>> 0).toString(16), "cbf43926");
});

test("ZIP extraction rejects traversal, symlink escape, corrupt payloads and truncation", async t => {
  for (const entry of [
    { name: "../outside", content: "bad" }, { name: "/outside", content: "bad" },
    { name: "C:\\outside", content: "bad" }, { name: "chrome/link", mode: 0o120777, content: "../../outside" },
    { name: "chrome/data", content: "corrupt", checksum: 0 },
  ]) {
    const root = fixture(t), archive = path.join(root, "fixture.zip");
    fs.writeFileSync(archive, zip([entry]));
    await assert.rejects(extractZip(archive, path.join(root, "out")), /Unsafe|checksum/);
    assert.ok(!fs.existsSync(path.join(root, "outside")));
  }
  const root = fixture(t), archive = path.join(root, "fixture.zip");
  fs.writeFileSync(archive, zip([{ name: "chrome", content: "bad" }]).subarray(0, -1));
  await assert.rejects(extractZip(archive, path.join(root, "out")), /ZIP/);
});

test("ZIP symlink chains cannot escape through a shallower linked directory", { skip: process.platform === "win32" }, async t => {
  const root = fixture(t), archive = path.join(root, "fixture.zip");
  fs.writeFileSync(path.join(root, "outside"), "must stay outside");
  fs.writeFileSync(archive, zip([
    { name: "a/", mode: 0o40755 }, { name: "d/", mode: 0o40755 },
    { name: "a/b", mode: 0o120777, content: "../d" },
    { name: "link", mode: 0o120777, content: "a/b/../../outside" },
  ]));
  await assert.rejects(extractZip(archive, path.join(root, "out")), /symlink chain/);
});

test("first install publishes only a verified browser; cached reuse is offline", async t => {
  const root = fixture(t), messages = [];
  let downloads = 0, verified = 0;
  const options = installOptions(root, {
    env: { FABLECUT_BROWSER_DOWNLOAD_BASE_URL: "https://mirror.example/chrome/" },
    log: message => messages.push(message),
    async download(url, target) {
      downloads++;
      assert.equal(url, `https://mirror.example/chrome/${VERSION}/linux64/chrome-linux64.zip`);
      await installOptions(root).download(url, target);
    },
    verify(file) {
      verified++;
      assert.ok(file.includes(".install-"));
      assert.ok(!fs.existsSync(path.join(root, VERSION, "linux64")));
    },
  });
  const browser = await ensureBrowser(undefined, options);
  assert.equal(browser, path.join(root, VERSION, "linux64", executable("linux64")));
  assert.equal(await ensureBrowser(undefined, options), browser);
  assert.equal(downloads, 1); assert.equal(verified, 1);
  assert.ok(messages.some(message => message.includes("Browser ready")));
  assert.deepEqual(fs.readdirSync(path.join(root, VERSION)), ["linux64"]);
});

test("explicit browser wins; missing overrides do not silently download; system browser is reused", async t => {
  const root = fixture(t), browser = path.join(root, "custom browser");
  fs.writeFileSync(browser, "fixture", { mode: 0o755 });
  const options = installOptions(root, { download() { assert.fail("should not download"); } });
  assert.equal(await ensureBrowser(browser, options), browser);
  assert.equal(await ensureBrowser(undefined, { ...options, env: { CHROME_PATH: browser } }), browser);
  assert.equal(await ensureBrowser(undefined, { ...options, candidates: [browser] }), browser);
  await assert.rejects(ensureBrowser(path.join(root, "missing"), options), /not executable/);
  await assert.rejects(ensureBrowser(undefined, { ...options, env: { CHROME_PATH: root } }), /not executable/);
  await assert.rejects(ensureBrowser(undefined, { ...options, platform: "freebsd" }), /unavailable on freebsd/);
});

test("failed download, corrupt ZIP, missing executable and failed launch are cleaned and retryable", async t => {
  for (const override of [
    { async download(_url, file) { fs.writeFileSync(file, "partial"); throw new Error("network interrupted"); } },
    { async download(_url, file) { fs.writeFileSync(file, "invalid ZIP"); } },
    { async download(_url, file) { fs.writeFileSync(file, zip([{ name: "wrong", content: "wrong browser" }])); } },
    { verify() { throw new Error("cannot launch"); } },
  ]) {
    const root = fixture(t);
    await assert.rejects(ensureBrowser(undefined, installOptions(root, override)), /Automatic browser setup failed/);
    assert.deepEqual(fs.readdirSync(path.join(root, VERSION)), []);
    assert.ok(fs.existsSync(await ensureBrowser(undefined, installOptions(root))));
  }
});

test("concurrent installers publish one complete cache without leftover partial installs", async t => {
  const root = fixture(t);
  const browsers = await Promise.all(Array.from({ length: 3 }, () => ensureBrowser(undefined, installOptions(root))));
  assert.equal(new Set(browsers).size, 1);
  assert.ok(fs.existsSync(browsers[0]));
  assert.deepEqual(fs.readdirSync(path.join(root, VERSION)), ["linux64"]);
});

test("download requires HTTPS and platform mapping matches CfT archives", async t => {
  const root = fixture(t);
  await assert.rejects(downloadArchive("http://example.com/archive.zip", path.join(root, "zip"), () => {}), /HTTPS/);
  await assert.rejects(downloadArchive("https://user:secret@example.com/archive.zip", path.join(root, "zip"), () => {}), /credentials/);
  for (const [platform, arch, expected] of [["darwin", "x64", "mac-x64"], ["darwin", "arm64", "mac-arm64"],
    ["linux", "x64", "linux64"], ["linux", "arm64", "linux-arm64"], ["win32", "x64", "win64"], ["win32", "ia32", "win32"]])
    assert.equal(platformKey(platform, arch), expected);
  assert.equal(platformKey("win32", "arm64"), undefined);
});

test("startup verification reports process launch failure without hanging", async t => {
  const root = fixture(t);
  await assert.rejects(verifyBrowser(path.join(root, "missing-browser")), /Downloaded Chrome could not run.*ENOENT/);
});
