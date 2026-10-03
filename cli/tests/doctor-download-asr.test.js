"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const { doctor } = require("../lib/doctor");
const { downloadFile, httpURL } = require("../lib/download");
const { AsrClient, runAsr, transcribeAudio, validateResult, metadata } = require("../lib/asr");
const RESULT = { rich_result: { duration: 1000, sentences: [{ begin_time: 0, end_time: 1000, text: "你好。", channel_id: 7,
  words: [{ begin_time: 0, end_time: 1000, word: "你好", punc: "。", channel_id: 2 }] }] }, channel: [7, 2] };
const BODY = JSON.stringify(RESULT, null, 2) + "\n";
function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tik asr test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function server(t, handler) {
  const service = http.createServer(handler);
  await new Promise(resolve => service.listen(0, "127.0.0.1", resolve));
  t.after(() => { service.closeAllConnections(); service.close(); });
  return `http://127.0.0.1:${service.address().port}`;
}
function cli(args, home, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, "../bin/tik-video-editor-cli.js"), ...args], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("doctor reports Node and executable versions, missing, failed and timed-out tools", () => {
  const good = () => ({ status: 0, stdout: "ffmpeg version test\nmore" });
  assert.equal(doctor({ nodeVersion: "18.0.0", run: good }).ok, true);
  assert.equal(doctor({ nodeVersion: "16.0.0", run: good }).checks.node.ok, false);
  for (const result of [{ status: null, error: { code: "ENOENT" } }, { status: 1 }, { status: null, error: { code: "ETIMEDOUT" } }]) {
    const checked = doctor({ run: (name, args, options) => {
      assert.deepEqual(args, ["-version"]); assert.equal(options.timeout, 10000); return result;
    } });
    assert.equal(checked.ok, false); assert.equal(checked.checks.ffmpeg.ok, false);
    assert.equal(checked.checks.ffprobe.ok, false);
  }
});

test("doctor CLI returns JSON and nonzero with empty PATH, without creating a workspace", async t => {
  const home = temp(t);
  const result = await cli(["doctor"], home, { PATH: "", TIK_API_KEY: "synthetic-secret" });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(result.stdout.includes("synthetic-secret"), false);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("download preserves binary bytes, follows redirects and never attaches authentication", async t => {
  const root = temp(t), bytes = Buffer.from([0, 255, 128, 42]);
  const base = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/binary" }); res.end(); }
    else res.end(bytes);
  });
  const target = path.join(root, "nested", "binary");
  assert.deepEqual(await downloadFile(base + "/redirect", target), { path: target });
  assert.deepEqual(fs.readFileSync(target), bytes);
  await assert.rejects(downloadFile(base + "/binary", target), /already exists/);
  const command = await cli(["download", "--url", base + "/binary", "--output", "relative/file.bin"], root);
  assert.equal(command.code, 0, command.stderr);
  assert.equal(JSON.parse(command.stdout).path, path.join(root, "relative/file.bin"));
  assert.equal(fs.existsSync(path.join(root, ".tik-video-editor-cli")), false);
});

test("generic download accepts non-ASR content and cleans HTTP, redirect, timeout and disconnected failures", async t => {
  const root = temp(t);
  const base = await server(t, (req, res) => {
    if (req.url === "/plain") return res.end("plain text");
    if (req.url === "/loop") { res.writeHead(302, { Location: "/loop" }); return res.end(); }
    if (req.url === "/bad-redirect") { res.writeHead(302, { Location: "file:///tmp/a" }); return res.end(); }
    if (req.url === "/slow") return;
    if (req.url === "/disconnect") { res.writeHead(200, { "Content-Length": 100 }); res.write("partial"); setImmediate(() => res.destroy()); return; }
    res.writeHead(403); res.end("expired");
  });
  const saved = path.join(root, "text");
  await downloadFile(base + "/plain", saved);
  assert.equal(fs.readFileSync(saved, "utf8"), "plain text");
  for (const name of ["loop", "bad-redirect", "slow", "disconnect", "expired"]) {
    await assert.rejects(downloadFile(base + "/" + name, path.join(root, name), { timeout: 100 }));
    assert.equal(fs.existsSync(path.join(root, name)), false);
    assert.equal(fs.readdirSync(root).some(file => file.includes(".part-")), false);
  }
  for (const url of ["file:///tmp/a", "/relative", "https://user:pass@example.com/a", "https://", "https://example.com/a b"]) assert.throws(() => httpURL(url));
});

test("download refuses targets created during transfer and removes invalid ASR output", async t => {
  const root = temp(t), output = path.join(root, "result");
  const base = await server(t, (_, res) => res.end(BODY));
  await assert.rejects(downloadFile(base, output, { validate: () => fs.writeFileSync(output, "existing") }));
  assert.equal(fs.readFileSync(output, "utf8"), "existing");
  fs.unlinkSync(output);
  await assert.rejects(downloadFile(base, output, { validate: () => { throw new Error("ASR invalid"); } }), /ASR invalid/);
  assert.deepEqual(fs.readdirSync(root), []);
});

function fakeClient(details = [{ parse_status: 3, result_url: "https://example.com/asr.json" }], exist = true) {
  const calls = [];
  return { calls,
    async request(method, endpoint, body) {
      calls.push({ method, endpoint, body });
      if (endpoint === "/api/v2/toolExtract") return { Id: 12 };
      if (endpoint.endsWith("applyAudioUploadAddresses")) return { exist, urls: exist ? null : ["https://example.com/upload"] };
      if (method === "GET") return details.length > 1 ? details.shift() : details[0];
      return {};
    },
    async upload(url, file) { calls.push({ upload: url, file }); },
  };
}
const fakeInfo = async () => ({ duration: 1, size: 10, md5: "test-md5", extension: "mp3" });
test("ASR keeps task contracts, uploads only when needed and polls pending tasks", async () => {
  for (const exist of [true, false]) {
    const client = fakeClient([{ parse_status: 1 }, { parse_status: 2 }, { parse_status: 3, result_url: "https://example.com/result.json" }], exist);
    let sleeps = 0;
    const result = await transcribeAudio("/tmp/audio.mp3", client, { readMetadata: fakeInfo, sleep: async ms => { assert.equal(ms, 3000); sleeps++; } });
    assert.deepEqual(result, { json_url: "https://example.com/result.json" });
    assert.equal(sleeps, 2);
    assert.deepEqual(client.calls[0].body, { title: "audio.mp3", origin_type: "AUDIO", client_meta: {
      desktop_size: 10, desktop_time: "1", desktop_timeLength: 1, desktop_file_name: "audio.mp3" }, without_merge_word: true });
    assert.deepEqual(client.calls.find(c => c.endpoint?.endsWith("audioTask")).body, { split: true, for_editor: 1 });
    assert.equal(client.calls.some(c => c.upload), !exist);
  }
});

test("ASR rejects failure, unknown status, invalid URLs, invalid task/upload responses and timeouts", async () => {
  for (const detail of [{ parse_status: 4 }, { parse_status: true }, {}, { parse_status: 3, result_url: "file:///tmp/a" }]) {
    await assert.rejects(transcribeAudio("/tmp/audio.mp3", fakeClient([detail]), { readMetadata: fakeInfo }));
  }
  for (const value of [{ Id: true }, { Id: 0 }, { Id: "12" }]) {
    await assert.rejects(transcribeAudio("/tmp/a.mp3", { request: async () => value }, { readMetadata: fakeInfo }), /task ID/);
  }
  const invalid = fakeClient();
  const original = invalid.request;
  invalid.request = async (...args) => args[1].endsWith("applyAudioUploadAddresses") ? { exist: false, urls: [] } : original(...args);
  await assert.rejects(transcribeAudio("/tmp/a.mp3", invalid, { readMetadata: fakeInfo }), /upload addresses/);
  await assert.rejects(transcribeAudio("/tmp/audio.mp3", fakeClient([{ parse_status: 1 }]), { readMetadata: fakeInfo, timeout: 1, pollInterval: 1 }), /timed out/);
});

test("ASR HTTP client uses saved-key headers, validates envelopes and streams upload without bearer key", async t => {
  const root = temp(t), file = path.join(root, "audio.mp3"); fs.writeFileSync(file, "audio");
  const requests = [];
  const base = await server(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url === "/upload") return res.end();
    if (req.url === "/unauthorized") { res.writeHead(401); return res.end(JSON.stringify({ status: 4011 })); }
    if (req.url === "/broken") return res.end("bad json");
    if (req.url === "/fail") return res.end(JSON.stringify({ status: 5000, msg: "synthetic-key denied" }));
    res.end(JSON.stringify({ status: 2000, data: { Id: 12 } }));
  });
  const client = new AsrClient("synthetic-key", { baseURL: base });
  assert.deepEqual(await client.request("POST", "/task", { for_editor: 1 }), { Id: 12 });
  assert.equal(requests[0].headers.authorization, "Bearer synthetic-key");
  assert.equal(requests[0].headers["client-id"], "10104");
  assert.deepEqual(JSON.parse(requests[0].body), { for_editor: 1 });
  await client.upload(base + "/upload", file);
  assert.equal(requests[1].headers.authorization, undefined);
  assert.equal(requests[1].body, "audio");
  await assert.rejects(client.request("GET", "/unauthorized"), /auth login/);
  await assert.rejects(client.request("GET", "/broken"), /invalid JSON/);
  await assert.rejects(client.request("GET", "/fail"), error => error.message.includes("[redacted]") && !error.message.includes("synthetic-key"));
});

test("ASR output preserves bytes and URL, skips tasks for existing output and retains URL on saving failures", async t => {
  const root = temp(t), file = path.join(root, "audio.wav"); fs.writeFileSync(file, "audio");
  const base = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    if (req.url === "/invalid") return res.end("not ASR");
    if (req.url === "/null") return res.end('{"rich_result":null,"channel":[]}\n');
    res.end(BODY);
  });
  let tasks = 0;
  const deps = { auth: { apiKey: "synthetic-key" }, transcribe: async () => { tasks++; return { json_url: base + "/result" }; } };
  assert.deepEqual(await runAsr({ path: file }, deps), { json_url: base + "/result" });
  const target = path.join(root, "nested/audio.json");
  assert.deepEqual(await runAsr({ path: file, output: target }, deps), { json_url: base + "/result", path: target });
  assert.equal(fs.readFileSync(target, "utf8"), BODY);
  await assert.rejects(runAsr({ path: file, output: target }, deps), /already exists/);
  assert.equal(tasks, 2);
  for (const suffix of ["invalid", "null"]) {
    const output = path.join(root, suffix);
    const transcribe = async () => ({ json_url: base + "/" + suffix });
    if (suffix === "invalid") {
      await assert.rejects(runAsr({ path: file, output }, { ...deps, transcribe }), error => error.message.includes(base + "/invalid") && error.message.includes("retry"));
      assert.equal(fs.existsSync(output), false);
    } else {
      await runAsr({ path: file, output }, { ...deps, transcribe });
      assert.equal(fs.readFileSync(output, "utf8"), '{"rich_result":null,"channel":[]}\n');
    }
  }
  await assert.rejects(runAsr({ path: file }, { auth: { apiKey: "" } }), /auth login/);
  await assert.rejects(runAsr({ path: "relative.wav" }, deps), /absolute/);
});

test("ASR video temp directory is cleaned after success, extraction failure and service failure", async t => {
  const root = temp(t), file = path.join(root, "video.MP4"); fs.writeFileSync(file, "video");
  for (const failure of ["none", "extract", "service"]) {
    let extracted;
    const deps = { auth: { apiKey: "synthetic-key" }, command: async (_, args) => {
      extracted = args.at(-1); fs.writeFileSync(extracted, "audio");
      if (failure === "extract") throw new Error("no audio stream");
    }, transcribe: async audio => {
      assert.equal(audio, extracted); assert.equal(fs.existsSync(audio), true);
      if (failure === "service") throw new Error("service failed");
      return { json_url: "https://example.com/result.json" };
    } };
    if (failure === "none") await runAsr({ path: file }, deps);
    else await assert.rejects(runAsr({ path: file }, deps));
    assert.equal(fs.existsSync(path.dirname(extracted)), false);
  }
});

test("ASR result validation preserves null, channel order and word-only speakers and rejects legacy formats", () => {
  assert.deepEqual(validateResult(RESULT), RESULT);
  assert.deepEqual(validateResult({ rich_result: null, channel: [] }), { rich_result: null, channel: [] });
  for (const channel of [undefined, {}, [true], ["7"], [7, 7], []]) assert.throws(() => validateResult({ ...RESULT, channel }));
  assert.throws(() => validateResult({ rich_result: RESULT.rich_result, speaker_mapping: {} }));
  assert.throws(() => validateResult({ rich_result: { duration: Infinity, sentences: [] }, channel: [] }));
});

test("real video extraction and ffprobe metadata work, and silent video fails before creating an ASR task", async t => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0 || spawnSync("ffprobe", ["-version"]).status !== 0) return t.skip("requires ffmpeg and ffprobe");
  const root = temp(t), video = path.join(root, "video with spaces.mp4"), silent = path.join(root, "silent.mp4");
  const created = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=size=16x16:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "1", "-c:v", "mpeg4", "-c:a", "aac", video]);
  assert.equal(created.status, 0, created.stderr?.toString());
  const result = await runAsr({ path: video }, { auth: { apiKey: "synthetic-key" }, transcribe: async file => {
    const info = await metadata(file); assert.ok(info.duration > 0.9 && info.duration < 1.3); assert.match(info.md5, /^[a-f0-9]{32}$/);
    return { json_url: "https://example.com/result.json" };
  } });
  assert.ok(result.json_url);
  assert.equal(spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-i", video, "-an", "-c:v", "copy", silent]).status, 0);
  let submitted = false;
  await assert.rejects(runAsr({ path: silent }, { auth: { apiKey: "synthetic-key" }, transcribe: async () => { submitted = true; } }), /audio stream/);
  assert.equal(submitted, false);
});

test("download cancellation removes partial files and ASR polling cancellation stops promptly", async t => {
  const root = temp(t), output = path.join(root, "cancelled");
  const controller = new AbortController();
  const base = await server(t, (_, res) => { res.write("partial"); controller.abort(); });
  await assert.rejects(downloadFile(base, output, { signal: controller.signal }), /cancelled/);
  assert.deepEqual(fs.readdirSync(root), []);
  const polling = new AbortController();
  const client = fakeClient([{ parse_status: 1 }]);
  const request = client.request;
  client.request = async (...args) => {
    const result = await request(...args);
    if (args[0] === "GET") polling.abort();
    return result;
  };
  await assert.rejects(transcribeAudio("/tmp/audio.mp3", client, { readMetadata: fakeInfo, signal: polling.signal }), /cancelled/);
});

test("ASR subprocess timeout, missing dependency and cancellation stop the media operation", async () => {
  const { mediaCommand } = require("../lib/asr");
  await assert.rejects(mediaCommand("tik-nonexistent-command-for-test", []), /required on PATH/);
  await assert.rejects(mediaCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 20), /timed out/);
  const controller = new AbortController();
  const pending = mediaCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 10000, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test("CLI ASR uses persisted credentials, runs the full gateway protocol and saves original result bytes", async t => {
  if (spawnSync("ffprobe", ["-version"]).status !== 0) return t.skip("requires ffprobe");
  const root = temp(t), file = path.join(root, "speech.wav"), output = path.join(root, "result.json");
  // One second of 16 kHz, 16-bit mono PCM, no external encoder required.
  const wav = Buffer.alloc(44 + 32000);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(32000, 40);
  fs.writeFileSync(file, wav);
  const requests = [];
  let base;
  base = await server(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    requests.push(req.url);
    if (req.url === "/upload" || req.url === "/result") {
      assert.equal(req.headers.authorization, undefined);
      if (req.url === "/upload") { assert.deepEqual(bytes, wav); return res.end(); }
      return res.end(BODY);
    }
    assert.equal(req.headers.authorization, "Bearer synthetic-persisted-key");
    const body = bytes.length ? JSON.parse(bytes) : undefined;
    let data;
    if (req.url === "/open/api/v2/toolExtract") {
      assert.equal(body.without_merge_word, true); assert.equal(body.origin_type, "AUDIO"); data = { Id: 12 };
    } else if (req.url.endsWith("applyAudioUploadAddresses")) {
      assert.equal(body.file_format, "wav"); assert.equal(body.file_size, wav.length);
      assert.match(body.file_md5, /^[a-f0-9]{32}$/); data = { exist: false, urls: [base + "/upload"] };
    } else if (req.url.endsWith("audioTask")) {
      assert.deepEqual(body, { split: true, for_editor: 1 }); data = {};
    } else data = { parse_status: 3, result_url: base + "/result" };
    res.end(JSON.stringify({ status: 2000, data }));
  });
  const script = `
    require("os").homedir = () => process.argv[1];
    const cliPath = process.argv[2], base = process.argv[3];
    const { OpenAPIAuth } = require(require("path").join(require("path").dirname(cliPath), "auth.js"));
    new OpenAPIAuth().save("synthetic-persisted-key");
    const fetchOriginal = global.fetch;
    global.fetch = (url, options) => fetchOriginal(String(url).replace("https://skgw-tik.tttci.com", base), options);
    require(cliPath).main(["asr", "--path", process.argv[4], "--output", process.argv[5]])
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, root, path.resolve(__dirname, "../lib/cli.js"), base, file, output],
      { env: { ...process.env, TIK_BASE_URL: "", TIK_API_KEY: "obsolete-key-must-not-be-used" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { json_url: base + "/result", path: output });
  assert.equal(result.stdout.includes("synthetic-persisted-key"), false);
  assert.equal(fs.readFileSync(output, "utf8"), BODY);
  assert.deepEqual(requests, ["/open/api/v2/toolExtract", "/open/api/v2/toolExtract/12/applyAudioUploadAddresses",
    "/upload", "/open/api/v2/toolExtract/12/audioTask", "/open/api/v2/toolExtract/12", "/result"]);
  assert.deepEqual(fs.readdirSync(path.join(root, ".tik-video-editor-cli")), ["auth.json"]);
});
