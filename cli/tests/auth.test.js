"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
// Keep tests independent of credentials in the invoking shell.
delete process.env.TIK_API_KEY;
delete process.env.TIK_BASE_URL;
const cliDir = process.env.FABLECUT_TEST_CLI_DIR || path.resolve(__dirname, "..");
const { OpenAPIAuth } = require(path.join(cliDir, "lib/auth"));

async function fixture(t, handler) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-auth-test-"));
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    res.setHeader("Content-Type", "application/json");
    handler(req, res, body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const apiURL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { auth: new OpenAPIAuth({ apiURL, home }), home, apiURL };
}
const ok = (res, data) => res.end(JSON.stringify({ status: 2000, data }));

for (const key of ["a".repeat(64), "sk-550e8400-e29b-41d4-a716-446655440000260929160530"]) {
test(`login polls, validates, persists, and reuses ${key.startsWith("sk-") ? "UUID" : "legacy"} key`, async t => {
  const device = "b".repeat(64), browser = "c".repeat(64);
  let polls = 0, created = 0, checked = 0;
  const f = await fixture(t, (req, res, body) => {
    if (req.url === "/open/api/v1/cli_auth") {
      assert.equal(req.method, "POST"); assert.equal(req.headers.authorization, undefined); created++;
      ok(res, { device_code: device, login_url: f.apiURL + "/h5/cli_auth#" + browser, expires_in: 5, interval: 0.001 });
    } else if (req.url === "/open/api/v1/cli_auth/exchage") {
      assert.deepEqual(body, { device_code: device }); assert.equal(req.headers.authorization, undefined);
      ok(res, ++polls === 1 ? { status: "pending" } : { status: "authorized", api_key: key });
    } else {
      assert.equal(req.url, "/open/api/v1/auth/status"); assert.equal(req.headers.authorization, "Bearer " + key); checked++;
      ok(res, { user_info: { uid: "test-user" } });
    }
  });
  assert.deepEqual(await f.auth.status(), { logged_in: false });
  const result = await f.auth.login({ openBrowser: false });
  assert.equal(result.logged_in, true); assert.equal(result.user_info.uid, "test-user");
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(fs.statSync(f.auth.file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(f.auth.file)).api_key, key);
  const loaded = new OpenAPIAuth({ home: f.home });
  assert.equal((await loaded.login({ openBrowser: false })).logged_in, true);
  assert.equal(polls, 2); assert.equal(created, 1); assert.equal(checked, 2);
  assert.equal((await new OpenAPIAuth({ home: f.home, apiURL: "https://example.com" }).status()).logged_in, false);
});

}

test("expired and invalid sessions never write credentials", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url.endsWith("exchage")) ok(res, { status: "expired" });
    else ok(res, { device_code: "b".repeat(64), login_url: f.apiURL + "/h5/cli_auth#" + "c".repeat(64), expires_in: 5, interval: 1 });
  });
  await assert.rejects(f.auth.login({ openBrowser: false }), /已过期/);
  assert.equal(fs.existsSync(f.auth.file), false);
});

test("rejected keys mean signed out, service failures remain errors", async t => {
  let status = 4011;
  const f = await fixture(t, (req, res) => res.end(JSON.stringify({ status, msg: "denied" })));
  f.auth.save("a".repeat(64));
  assert.deepEqual(await f.auth.status(), { logged_in: false });
  status = 5000;
  await assert.rejects(f.auth.status(), /denied/);
});

test("cross-origin login URLs are refused", async t => {
  const f = await fixture(t, (req, res) => ok(res, { device_code: "b".repeat(64), login_url: "https://example.com/h5/cli_auth#" + "c".repeat(64), expires_in: 5, interval: 1 }));
  await assert.rejects(f.auth.login({ openBrowser: false }), /unexpected login URL/);
  assert.equal(fs.existsSync(f.auth.file), false);
});

test("CLI status and logout work without runtime and logout resets corrupt credentials", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-auth-command-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = action => spawnSync(process.execPath, ["-e", 'require("os").homedir = () => process.argv[1]; require(process.argv[2]).main(["auth", process.argv[3]]).catch(error => { console.error(error.message); process.exitCode = 1; });', home, path.join(cliDir, "lib/cli.js"), action], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(run("status").stdout), { logged_in: false });
  fs.mkdirSync(path.join(home, ".tik-video-editor-cli"), { recursive: true });
  fs.writeFileSync(path.join(home, ".tik-video-editor-cli", "auth.json"), "broken");
  assert.equal(run("status").status, 1);
  assert.equal(run("logout").status, 0);
  assert.equal(run("logout").status, 0);
  assert.equal(fs.existsSync(path.join(home, ".tik-video-editor-cli", "auth.json")), false);
});


test("TIK_BASE_URL overrides saved origin without reusing another environment's key", async t => {
  const previous = process.env.TIK_BASE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.TIK_BASE_URL;
    else process.env.TIK_BASE_URL = previous;
  });
  let checked = 0;
  const f = await fixture(t, (req, res) => {
    assert.equal(req.url, "/open/api/v1/auth/status");
    assert.equal(req.headers.authorization, "Bearer " + "b".repeat(64));
    checked++;
    ok(res, { user_info: { uid: "debug-user" } });
  });
  new OpenAPIAuth({ apiURL: "https://example.com", home: f.home }).save("a".repeat(64));
  process.env.TIK_BASE_URL = f.apiURL + "/";
  const auth = new OpenAPIAuth({ home: f.home });
  assert.equal(auth.baseURL, f.apiURL);
  assert.deepEqual(await auth.status(), { logged_in: false });
  assert.equal(checked, 0);
  assert.equal(new OpenAPIAuth({ apiURL: "https://explicit.example", home: f.home }).baseURL, "https://explicit.example");
  auth.save("b".repeat(64));
  assert.equal((await new OpenAPIAuth({ home: f.home }).status()).user_info.uid, "debug-user");
  assert.equal(checked, 1);
  process.env.TIK_BASE_URL = "https://example.com/invalid-path";
  assert.throws(() => new OpenAPIAuth({ home: f.home }), /OpenAPI base URL/);
  process.env.TIK_BASE_URL = "";
  assert.equal(new OpenAPIAuth({ home: f.home }).baseURL, f.apiURL);
});

for (const key of ["", "sk-invalid", "sk-550e8400-e29b-11d4-a716-446655440000260929160530", "sk-550e8400-e29b-41d4-7716-446655440000260929160530", "sk-550e8400-e29b-41d4-a716-446655440000", "a".repeat(63)]) {
  test(`login rejects malformed API Key (${key.length} characters)`, async t => {
    const f = await fixture(t, (req, res) => {
      if (req.url.endsWith("exchage")) ok(res, { status: "authorized", api_key: key });
      else ok(res, { device_code: "b".repeat(64), login_url: f.apiURL + "/h5/cli_auth#" + "c".repeat(64), expires_in: 5, interval: 1 });
    });
    await assert.rejects(f.auth.login({ openBrowser: false }), /invalid API Key/);
    assert.equal(fs.existsSync(f.auth.file), false);
  });
}


test("environment key overrides saved credentials without persisting and blank values fall back", async t => {
  t.after(() => { delete process.env.TIK_API_KEY; });
  let expected = "environment-key";
  const f = await fixture(t, (req, res) => {
    assert.equal(req.url, "/open/api/v1/auth/status");
    assert.equal(req.headers.authorization, "Bearer " + expected);
    ok(res, { user_info: { uid: "environment-user" } });
  });
  process.env.TIK_API_KEY = "  environment-key ";
  const fresh = new OpenAPIAuth({ apiURL: f.apiURL, home: f.home });
  assert.equal((await fresh.login({ openBrowser: false })).logged_in, true);
  assert.equal(fs.existsSync(fresh.file), false);
  f.auth.save("saved-key");
  const original = fs.readFileSync(f.auth.file, "utf8");
  assert.equal((await new OpenAPIAuth({ apiURL: f.apiURL, home: f.home }).login()).logged_in, true);
  assert.equal(fs.readFileSync(f.auth.file, "utf8"), original);
  assert.equal(new OpenAPIAuth({ apiURL: "https://other.example", home: f.home }).apiKey, expected);
  expected = "saved-key";
  for (const value of ["", "  "]) {
    process.env.TIK_API_KEY = value;
    assert.equal((await new OpenAPIAuth({ home: f.home }).status()).logged_in, true);
  }
  delete process.env.TIK_API_KEY;
  assert.equal(new OpenAPIAuth({ home: f.home }).apiKey, "saved-key");
});

test("rejected environment key never falls back or starts browser login and errors redact the key", async t => {
  t.after(() => { delete process.env.TIK_API_KEY; });
  let status = 4011;
  const f = await fixture(t, (req, res) => {
    assert.equal(req.url, "/open/api/v1/auth/status");
    assert.equal(req.headers.authorization, "Bearer rejected-environment-key");
    res.end(JSON.stringify({ status, msg: "denied rejected-environment-key" }));
  });
  f.auth.save("saved-key");
  process.env.TIK_API_KEY = "rejected-environment-key";
  const auth = new OpenAPIAuth({ home: f.home });
  assert.deepEqual(await auth.status(), { logged_in: false });
  await assert.rejects(auth.login(), /TIK_API_KEY was rejected/);
  status = 5000;
  await assert.rejects(auth.status(), error => error.message === "denied [redacted]");
  assert.equal(JSON.parse(fs.readFileSync(auth.file)).api_key, "saved-key");
});
