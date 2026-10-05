"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomBytes } = require("crypto");
const { spawn } = require("child_process");

const DEFAULT_API_URL = "https://app.tttci.com";

class OpenAPIAuth {
  constructor({ apiURL, home = os.homedir() } = {}) {
    this.file = path.join(home, ".tik-video-editor-cli", "auth.json");
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot read CLI credentials; run auth logout to reset them"); }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid CLI credentials; run auth logout to reset them");
    let base;
    try { base = new URL(apiURL || process.env.TIK_BASE_URL || saved.base_url || DEFAULT_API_URL); }
    catch { throw new Error("OpenAPI base URL must be an absolute HTTP(S) URL"); }
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/")
      throw new Error("OpenAPI base URL must be an HTTP(S) origin without credentials, path, query, or fragment");
    this.baseURL = base.origin;
    this.environmentKey = (process.env.TIK_API_KEY || "").trim();
    this.apiKey = this.environmentKey || (saved.base_url === this.baseURL && typeof saved.api_key === "string" ? saved.api_key : "");
  }

  async request(method, endpoint, { body, authenticated = true, timeout = 30000 } = {}) {
    const headers = { Accept: "application/json" };
    if (authenticated) {
      if (!this.apiKey) throw new Error("Not logged in; run tik-video-editor-cli auth login");
      headers.Authorization = "Bearer " + this.apiKey;
    }
    if (body) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(this.baseURL + endpoint, {
        method, headers, redirect: "error", signal: AbortSignal.timeout(Math.max(1, timeout)),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new Error("OpenAPI request failed or timed out; check the network and --api-url"); }
    let result;
    try { result = await response.json(); }
    catch { throw new Error("OpenAPI returned an invalid JSON response"); }
    if (!response.ok || !result || result.status !== 2000) {
      const message = String(result?.msg || result?.message || result?.remark || `HTTP ${response.status}`);
      const error = new Error(this.apiKey ? message.split(this.apiKey).join("[redacted]") : message);
      error.unauthorized = response.status === 401 || [4010, 4011].includes(result?.status);
      throw error;
    }
    return result.data;
  }

  async status() {
    if (!this.apiKey) return { logged_in: false };
    try {
      const data = await this.request("GET", "/open/api/v1/auth/status");
      if (!data?.user_info?.uid) throw new Error("OpenAPI returned invalid user information");
      return { logged_in: true, user_info: data.user_info };
    } catch (error) {
      if (error.unauthorized) return { logged_in: false };
      throw error;
    }
  }

  save(apiKey) {
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify({ base_url: this.baseURL, api_key: apiKey }) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.file);
      this.apiKey = apiKey;
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  async login({ openBrowser = true } = {}) {
    const current = await this.status();
    if (current.logged_in) return current;
    if (this.environmentKey) throw new Error("TIK_API_KEY was rejected; update or unset it before running auth login");
    const session = await this.request("POST", "/open/api/v1/cli_auth", { authenticated: false });
    if (!/^[a-f0-9]{64}$/.test(session?.device_code) || !Number.isFinite(session?.expires_in) || session.expires_in <= 0 || !Number.isFinite(session?.interval) || session.interval <= 0)
      throw new Error("OpenAPI returned an invalid login session");
    let loginURL;
    try { loginURL = new URL(session.login_url); } catch { throw new Error("OpenAPI returned an invalid login URL"); }
    if (loginURL.origin !== this.baseURL || loginURL.pathname !== "/h5/cli_auth" || loginURL.username || loginURL.password || !/^#[a-f0-9]{64}$/.test(loginURL.hash))
      throw new Error("OpenAPI returned an unexpected login URL");
    const deadline = Date.now() + session.expires_in * 1000;
    console.error("请打开以下链接，登录并授权，然后返回终端：\n" + loginURL.href);
    if (openBrowser) {
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
      const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", loginURL.href] : [loginURL.href];
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => console.error("无法自动打开浏览器，请手动打开上面的链接。"));
      child.unref();
    }
    while (Date.now() < deadline) {
      const result = await this.request("POST", "/open/api/v1/cli_auth/exchage", {
        authenticated: false, body: { device_code: session.device_code }, timeout: Math.min(30000, deadline - Date.now()),
      });
      if (result?.status === "authorized") {
        if (typeof result.api_key !== "string" || !/^(?:[a-f0-9]{64}|sk-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}[0-9]{12})$/.test(result.api_key)) throw new Error("OpenAPI returned an invalid API Key");
        this.apiKey = result.api_key;
        const status = await this.status();
        if (!status.logged_in) throw new Error("CLI authorization failed validation; run auth login again");
        this.save(result.api_key);
        return status;
      }
      if (result?.status === "expired") break;
      if (result?.status !== "pending") throw new Error("OpenAPI returned an unexpected authorization status");
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(session.interval * 1000, remaining)));
    }
    throw new Error("CLI 登录已过期，请重新运行 tik-video-editor-cli auth login");
  }
}

async function runAuth(action, options = {}) {
  if (!["status", "login", "logout"].includes(action)) throw new Error("Use: tik-video-editor-cli auth status|login|logout [--api-url <origin>] [--no-browser]");
  if (action === "logout") {
    fs.rmSync(path.join(os.homedir(), ".tik-video-editor-cli", "auth.json"), { force: true });
    return { logged_in: false, logged_out: true };
  }
  if (options["api-url"] !== undefined && (typeof options["api-url"] !== "string" || !options["api-url"])) throw new Error("--api-url requires a URL");
  const auth = new OpenAPIAuth({ apiURL: options["api-url"] });
  return action === "status" ? auth.status() : auth.login({ openBrowser: !options["no-browser"] });
}

module.exports = { OpenAPIAuth, runAuth };
