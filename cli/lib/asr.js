"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { spawn } = require("child_process");
const { OpenAPIAuth } = require("./auth");
const { withDeadline } = require("./operation");
const { downloadFile, httpURL, outputPath } = require("./download");
const API_BASE = "https://skgw-tik.tttci.com/open";
const AUDIO = new Set([".mp3", ".wav", ".m4a", ".aac"]);
const VIDEO = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".ts", ".mts", ".m2ts", ".wmv"]);

function validateResult(value) {
  const invalid = () => { throw new Error("ASR result must contain valid rich_result and channel fields"); };
  if (!value || typeof value !== "object" || Array.isArray(value) || !("rich_result" in value)) invalid();
  const channels = value.channel, rich = value.rich_result;
  if (!Array.isArray(channels) || channels.some(c => !Number.isInteger(c)) || new Set(channels).size !== channels.length) invalid();
  const numeric = v => typeof v === "number" && Number.isFinite(v);
  if (rich !== null) {
    if (!rich || !numeric(rich.duration) || rich.duration < 0 || !Array.isArray(rich.sentences)) invalid();
    for (const sentence of rich.sentences) {
      if (!sentence || !numeric(sentence.begin_time) || !numeric(sentence.end_time) || typeof sentence.text !== "string" || !Number.isInteger(sentence.channel_id) || !channels.includes(sentence.channel_id) || !Array.isArray(sentence.words)) invalid();
      for (const word of sentence.words) {
        if (!word || !numeric(word.begin_time) || !numeric(word.end_time) || typeof word.word !== "string" || typeof word.punc !== "string" || !Number.isInteger(word.channel_id)) invalid();
      }
    }
  }
  return value;
}
function mediaCommand(command, args, timeout = 60000, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("ASR cancelled"));
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    let output = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", data => { output += data; if (output.length > 1024 * 1024) child.kill("SIGKILL"); });
    child.on("error", error => { cleanup(); reject(new Error(error.code === "ENOENT" ? `${command} is required on PATH` : `${command} failed to start`)); });
    child.on("close", code => { cleanup(); if (signal?.aborted) return reject(new Error("ASR cancelled")); code === 0 ? resolve(output) : reject(new Error(`${command} ${timedOut ? "timed out" : "failed; check that the media contains a readable audio stream"}`)); });
  });
}
async function metadata(file, signal) {
  const raw = await mediaCommand("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file], 60000, signal);
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("ASR audio metadata is invalid"); }
  const duration = Number(data.format?.duration);
  if (!data.streams?.length || !Number.isFinite(duration) || duration <= 0) throw new Error("ASR audio metadata is invalid");
  const hash = createHash("md5");
  for await (const chunk of fs.createReadStream(file)) { if (signal?.aborted) throw new Error("ASR cancelled"); hash.update(chunk); }
  return { duration, size: fs.statSync(file).size, md5: hash.digest("hex"), extension: path.extname(file).slice(1).toLowerCase() };
}
class AsrClient {
  constructor(apiKey, { baseURL = API_BASE, signal } = {}) { this.apiKey = apiKey; this.baseURL = baseURL; this.signal = signal; }
  async request(method, endpoint, body, timeout = 60000) {
    return withDeadline(timeout, this.signal, async signal => {
      let response;
      try {
        response = await fetch(this.baseURL + endpoint, { method, redirect: "error", signal,
          headers: { Accept: "application/json", "Content-Type": "application/json", "Client-ID": "10104", Authorization: "Bearer " + this.apiKey },
          body: body === undefined ? undefined : JSON.stringify(body) });
      } catch { throw new Error(this.signal?.aborted ? "ASR cancelled" : "ASR OpenAPI request failed or timed out; check the network"); }
      let result;
      try { result = await response.json(); }
      catch { throw new Error(signal.aborted ? (this.signal?.aborted ? "ASR cancelled" : "ASR OpenAPI request timed out") : "ASR OpenAPI returned invalid JSON"); }
      if (response.status === 401 || [4010, 4011].includes(result?.status)) throw new Error("ASR API Key is invalid or expired; run tik-editvideo-cli auth login");
      if (!result || !Number.isInteger(result.status)) throw new Error("ASR OpenAPI returned an invalid response");
      if (!response.ok || result.status !== 2000) {
        const detail = String(result.remark || result.msg || result.message || "Request failed").split(this.apiKey).join("[redacted]");
        throw new Error(`ASR OpenAPI failed (HTTP ${response.status}, status ${result.status}): ${detail}`);
      }
      return result.data;
    });
  }
  async upload(url, file) {
    const target = httpURL(url);
    const stream = fs.createReadStream(file);
    return withDeadline(60000, this.signal, async signal => {
      try {
        const response = await fetch(target, { method: "PUT", redirect: "error", signal,
          headers: { "Content-Length": String(fs.statSync(file).size) }, body: stream, duplex: "half" });
        await response.body?.cancel();
        if (!response.ok) throw new Error("Upload failed");
      } catch { throw new Error(this.signal?.aborted ? "ASR cancelled" : "ASR audio upload failed"); }
      finally { stream.destroy(); }
    });
  }
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("ASR cancelled"));
    const abort = () => { clearTimeout(timer); reject(new Error("ASR cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
async function transcribeAudio(file, client, {
  timeout = 1800000, pollInterval = 3000, readMetadata = metadata, signal, sleep = delay,
} = {}) {
  const info = await readMetadata(file, signal);
  const task = await client.request("POST", "/api/v2/toolExtract", { title: path.basename(file), origin_type: "AUDIO",
    client_meta: { desktop_size: info.size, desktop_time: String(info.duration), desktop_timeLength: info.duration, desktop_file_name: path.basename(file) }, without_merge_word: true });
  const id = task?.Id ?? task?.id;
  if (!Number.isInteger(id) || id <= 0) throw new Error("ASR returned an invalid task ID");
  const upload = await client.request("POST", `/api/v2/toolExtract/${id}/applyAudioUploadAddresses`, {
    duration: info.duration, file_size: info.size, file_md5: info.md5, file_format: info.extension, split_part: 1 });
  if (!upload || typeof upload.exist !== "boolean" || (!upload.exist && (!Array.isArray(upload.urls) || !upload.urls[0])) || (upload.urls != null && !Array.isArray(upload.urls)))
    throw new Error("ASR returned invalid upload addresses");
  if (!upload.exist) await client.upload(upload.urls[0], file);
  await client.request("POST", `/api/v2/toolExtract/${id}/audioTask`, { split: true, for_editor: 1 });
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const detail = await client.request("GET", `/api/v2/toolExtract/${id}`, undefined, Math.min(60000, deadline - performance.now()));
    if (detail?.parse_status === 3) { httpURL(detail.result_url); return { json_url: detail.result_url }; }
    if (detail?.parse_status === 4) throw new Error("ASR transcription failed");
    if (![1, 2].includes(detail?.parse_status)) throw new Error("ASR returned an unknown parsing status");
    await sleep(Math.min(pollInterval, Math.max(0, deadline - performance.now())), signal);
  }
  throw new Error("ASR transcription timed out after 30 minutes");
}
async function runAsr(options, { auth = new OpenAPIAuth({ apiURL: options["api-url"] }), client, transcribe = transcribeAudio, command = mediaCommand, signal } = {}) {
  const source = options.path;
  if (typeof source !== "string" || !path.isAbsolute(source)) throw new Error("ASR --path must be an absolute local audio or video path");
  const extension = path.extname(source).toLowerCase();
  if (!AUDIO.has(extension) && !VIDEO.has(extension)) throw new Error("ASR unsupported audio or video extension");
  const stat = fs.statSync(source, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size <= 0) throw new Error("ASR input must be a nonempty media file");
  if (options.output !== undefined) outputPath(options.output);
  if (!auth.apiKey) throw new Error("Not logged in; run tik-editvideo-cli auth login");
  client ||= new AsrClient(auth.apiKey, { signal });
  let temporary, result;
  try {
    let audio = source;
    if (VIDEO.has(extension)) {
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tik-editvideo-cli-asr-"));
      audio = path.join(temporary, path.parse(source).name + ".mp3");
      await command("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", source, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-q:a", "4", audio], 1800000, signal);
    }
    result = await transcribe(audio, client, { signal });
  } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
  if (options.output !== undefined) {
    try {
      const saved = await downloadFile(result.json_url, options.output, { signal, validate: file => {
        let value;
        try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("ASR result is not valid JSON"); }
        validateResult(value);
      } });
      return { ...result, ...saved };
    } catch (error) { throw new Error(`${error.message}; transcription completed, json_url=${result.json_url}; retry with tik-editvideo-cli download`); }
  }
  return result;
}
module.exports = { AsrClient, runAsr, transcribeAudio, metadata, validateResult, mediaCommand };
