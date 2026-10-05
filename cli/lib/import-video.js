"use strict";
// Import preparation is independent of the preview/export compositor.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const ORIGIN_TOLERANCE = 0.1;
function command(program, args, { timeout = 1800000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "", errors = "", pending = "", expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeout);
    child.stdout.on("data", chunk => {
      if (onLine) { pending += chunk; const lines = pending.split("\n"); pending = lines.pop(); lines.forEach(onLine); }
      else { output += chunk; if (output.length > 4 * 1024 * 1024) child.kill(); }
    });
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-16000); });
    child.on("error", error => { clearTimeout(timer); reject(new Error(error.code === "ENOENT" ? `${program} is required on PATH` : error.message)); });
    child.on("close", code => {
      clearTimeout(timer);
      if (onLine && pending) onLine(pending);
      code === 0 ? resolve({ output, errors }) : reject(new Error(`${program} ${expired ? "timed out" : "failed"}: ${errors}`));
    });
  });
}
function positive(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : undefined; }
function rate(value) { const [a, b = 1] = String(value).split("/").map(Number); return positive(a / b); }
async function inspect(file, run = command, { colors = true } = {}) {
  const { output } = await run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], { timeout: 60000 });
  let data;
  try { data = JSON.parse(output); } catch { throw new Error("Invalid video metadata"); }
  const video = data.streams?.find(s => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = data.streams?.filter(s => s.codec_type === "audio") || [];
  if (!video || !positive(video.width) || !positive(video.height) || !(rate(video.avg_frame_rate) || rate(video.r_frame_rate))) throw new Error("Input has no valid video stream");
  // Some demuxers expose HDR transfer/primaries only after decoding a frame.
  // This bounded probe prevents treating HDR as ordinary SDR based on missing tags.
  if (colors && ["color_transfer", "color_primaries"].some(key => !video[key] || video[key] === "unknown")) {
    const first = await run("ffprobe", ["-v", "error", "-select_streams", String(video.index), "-read_intervals", "%+#16", "-show_frames", "-show_entries", "frame=color_transfer,color_primaries,color_space,color_range,pix_fmt", "-of", "json", file], { timeout: 60000 });
    const frame = JSON.parse(first.output).frames?.[0];
    if (!frame) throw new Error("Input has no decodable video frame");
    if (frame) for (const key of ["color_transfer", "color_primaries", "color_space", "color_range", "pix_fmt"]) if (frame[key] && frame[key] !== "unknown") video[key] = frame[key];
  }
  let duration = positive(video.duration), start = video.start_time == null ? NaN : Number(video.start_time);
  if (!duration && Number.isFinite(start) && video.tags?.DURATION) {
    const parts = video.tags.DURATION.split(":").map(Number);
    if (parts.length === 3) duration = positive(parts[0] * 3600 + parts[1] * 60 + parts[2] - start);
  }
  if (!duration || !Number.isFinite(start)) {
    let first = Infinity, end = -Infinity;
    await run("ffprobe", ["-v", "error", "-select_streams", String(video.index), "-show_packets", "-show_entries", "packet=pts_time,duration_time", "-of", "compact=p=0", file], {
      onLine(line) {
        const fields = Object.fromEntries(line.split("|").filter(p => p.includes("=")).map(p => p.split("=")));
        const pts = Number(fields.pts_time), length = positive(fields.duration_time);
        if (Number.isFinite(pts) && length) { first = Math.min(first, pts); end = Math.max(end, pts + length); }
      },
    });
    if (!Number.isFinite(start)) start = first;
    duration ||= positive(end - start);
  }
  if (!duration || !Number.isFinite(start) || audio.some(s => !Number.isFinite(Number(s.start_time)))) throw new Error("Cannot determine reliable media timestamps");
  return { data, video, audio, duration, start, fps: (rate(video.avg_frame_rate) || rate(video.r_frame_rate)) };
}
function classify(info, filename) {
  const v = info.video;
  const hdr = ["smpte2084", "arib-std-b67"].includes(v.color_transfer);
  const compatible = !hdr && ["yuv420p", "yuvj420p"].includes(v.pix_fmt) && ["h264", "vp8", "vp9"].includes(v.codec_name);
  const normalize = Math.abs(info.start) > ORIGIN_TOLERANCE || info.audio.some(a => Math.max(Math.abs(Number(a.start_time)), Math.abs(Number(a.start_time) - info.start)) > ORIGIN_TOLERANCE);
  const webm = compatible && ["vp8", "vp9"].includes(v.codec_name);
  const ext = webm ? ".webm" : ".mp4";
  const audioCompatible = info.audio.every(a => (webm ? ["opus", "vorbis"] : ["aac", "mp3"]).includes(a.codec_name));
  const container = info.data?.format?.format_name || "";
  const containerCompatible = (webm ? container.includes("webm") : container.split(",").some(n => ["mp4", "mov"].includes(n))) && (webm ? [".webm"] : [".mp4", ".mov", ".m4v"]).includes(path.extname(filename).toLowerCase());
  const copy = compatible && audioCompatible && containerCompatible && !normalize;
  return { hdr, normalize, transcode: !compatible, webm, ext: copy ? path.extname(filename) : ext, audioEncode: !audioCompatible || normalize, method: copy ? "copy" : !compatible ? "transcode" : normalize ? "align" : !audioCompatible ? "audio" : "remux" };
}
const quality = {
  h264_nvenc: ["-rc", "vbr", "-cq", "18", "-b:v", "0", "-preset", "p4"],
  h264_qsv: ["-global_quality", "18", "-preset", "veryfast"],
  h264_amf: ["-rc", "cqp", "-qp_i", "18", "-qp_p", "18"],
  h264_videotoolbox: ["-q:v", "80", "-allow_sw", "0"],
  libx264: ["-crf", "18", "-preset", "veryfast"],
};
async function selectEncoder(run, platform = process.platform) {
  const candidates = platform === "darwin" ? ["h264_videotoolbox"] : platform === "win32" ? ["h264_nvenc", "h264_qsv", "h264_amf"] : ["h264_nvenc", "h264_qsv"];
  for (const encoder of candidates) {
    try {
      await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=s=640x480:r=30:d=0.1", "-c:v", encoder, ...quality[encoder], "-pix_fmt", "yuv420p", "-f", "null", "-"], { timeout: 15000 });
      return encoder;
    } catch {}
  }
  return "libx264";
}
function rotation(video) { return Number(video.side_data_list?.find(s => s.rotation !== undefined)?.rotation || video.tags?.rotate || 0); }
function metadata(info) {
  const angle = rotation(info.video), rotated = Math.abs(angle % 180) === 90;
  return { duration: info.duration, width: rotated ? info.video.height : info.video.width, height: rotated ? info.video.width : info.video.height, fps: info.fps,
    encoded_width: info.video.width, encoded_height: info.video.height, rotation: angle,
    ...(info.video.color_transfer ? { color_transfer: info.video.color_transfer } : {}),
    ...(info.video.color_primaries ? { color_primaries: info.video.color_primaries } : {}),
    ...(info.video.color_space ? { color_space: info.video.color_space } : {}),
    video_start: info.start, audio_starts: info.audio.map(a => Number(a.start_time)),
    video_codec: info.video.codec_name, audio_codecs: info.audio.map(a => a.codec_name), pixel_format: info.video.pix_fmt };
}
async function prepareVideo(source, directory, { existingAsr = false, run = command, platform, log = message => process.stderr.write(message + "\n") } = {}) {
  const started = performance.now(), info = await inspect(source, run), policy = classify(info, source);
  if (existingAsr && policy.normalize) throw new Error("Existing ASR is bound to the source timeline; origin alignment requires a new job and ASR");
  const target = path.join(directory, "prepared" + policy.ext);
  if (policy.hdr) {
    const filters = (await run("ffmpeg", ["-hide_banner", "-filters"], { timeout: 15000 })).output;
    if (!["zscale", "tonemap"].every(name => new RegExp("\\b" + name + "\\b").test(filters))) throw new Error("HDR conversion requires ffmpeg with zscale and tonemap filters");
  }
  let preparedInfo = info;
  let encoder = policy.transcode ? await selectEncoder(run, platform) : undefined;
  if (policy.method === "copy") fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  else {
    log(`Preparing video: ${policy.method}${encoder ? " (" + encoder + ")" : " (video stream copy)"}`);
    const args = ["-nostdin", "-hide_banner", "-v", "warning", "-xerror", "-n", "-copyts"];
    if (!policy.transcode) args.push("-noautorotate");
    if (policy.normalize) args.push("-itsoffset", String(-info.start));
    args.push("-i", source, "-map", `0:${info.video.index}`);
    for (const a of info.audio) args.push("-map", `0:${a.index}`);
    if (policy.transcode) {
      const filters = [];
      if (policy.hdr) filters.push("zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=limited");
      // Padding is necessary only for odd dimensions unsupported by 4:2:0.
      if (info.video.width % 2 || info.video.height % 2) filters.push("pad=ceil(iw/2)*2:ceil(ih/2)*2");
      filters.push("format=yuv420p");
      args.push("-vf", filters.join(","), "-fps_mode", "passthrough", "-enc_time_base:v", "demux");
      if (policy.hdr) args.push("-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0");
      args.push("-metadata:s:v:0", "rotate=0");
    } else args.push("-c:v", "copy");
    args.push("-c:a", policy.audioEncode ? (policy.webm ? "libopus" : "aac") : "copy");
    if (policy.audioEncode) args.push("-b:a", "192k");
    if (policy.normalize) for (let i = 0; i < info.audio.length; i++) args.push(`-filter:a:${i}`, `aresample=async=0:first_pts=0,apad,atrim=end=${info.duration}`);
    args.push("-map_chapters", "-1", "-avoid_negative_ts", "disabled");
    if (!policy.webm) args.push("-movflags", "+faststart");
    const encode = async selected => {
      const videoArgs = selected ? ["-c:v", selected, ...quality[selected], "-pix_fmt", "yuv420p"] : [];
      let lastProgress = 0;
      const result = await run("ffmpeg", [...args, ...videoArgs, "-progress", "pipe:1", "-nostats", target], {
        onLine(line) {
          if (!line.startsWith("out_time_us=")) return;
          const seconds = Number(line.slice(12)) / 1000000;
          if (Number.isFinite(seconds) && performance.now() - lastProgress >= 5000) {
            lastProgress = performance.now();
            log(`Preparing video: ${Math.min(100, Math.max(0, seconds / info.duration * 100)).toFixed(1)}%`);
          }
        },
      });
      if (/non[- ]monoton|discontinu|invalid/i.test(result.errors || "")) throw new Error("Unsafe timestamps reported during preparation: " + result.errors);
    };
    try { await encode(encoder); }
    catch (error) {
      if (!encoder || encoder === "libx264") throw error;
      fs.rmSync(target, { force: true });
      log(`Hardware encoding failed; retrying once with libx264: ${error.message}`);
      encoder = "libx264";
      await encode(encoder);
    }
    const after = preparedInfo = await inspect(target, run);
    const tolerance = Math.max(0.1, 1 / info.fps);
    if (Math.abs(after.duration - info.duration) > tolerance || after.audio.length !== info.audio.length || classify(after, target).transcode || (policy.normalize && classify(after, target).normalize)) throw new Error("Prepared media failed format/timeline verification");
    if (policy.transcode) {
      const angle = rotation(info.video);
      const rotated = Math.abs(angle % 180) === 90;
      const expected = rotated ? [info.video.height, info.video.width] : [info.video.width, info.video.height];
      if (after.video.width !== Math.ceil(expected[0] / 2) * 2 || after.video.height !== Math.ceil(expected[1] / 2) * 2) throw new Error("Prepared video dimensions changed unexpectedly");
      if (policy.hdr && [after.video.color_transfer, after.video.color_primaries, after.video.color_space].some(value => value !== "bt709")) throw new Error("HDR output did not verify as BT.709 SDR");
    }
    if (Math.abs(after.start - (policy.normalize ? 0 : info.start)) > tolerance) throw new Error("Prepared video origin changed unexpectedly");
    if (!policy.transcode && (after.video.width !== info.video.width || after.video.height !== info.video.height || after.video.codec_name !== info.video.codec_name || (info.video.nb_frames && after.video.nb_frames && info.video.nb_frames !== after.video.nb_frames))) throw new Error("Video stream changed during copy");
    if (policy.normalize && after.audio.some(a => positive(a.duration) && Math.abs(Number(a.duration) - after.duration) > Math.max(tolerance, 1024 / Number(a.sample_rate || 48000)))) throw new Error("Prepared audio does not cover the video timeline");
    for (const position of [0, info.duration / 2, Math.max(0, info.duration - 0.25)]) {
      const decoded = await run("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-ss", String(position), "-i", target, "-map", "0:v:0", "-frames:v", "1", "-f", "framecrc", "-"], { timeout: 60000 });
      if (!/^0,\s/m.test(decoded.output)) throw new Error("Prepared video has no decodable frame at " + position);
    }
  }
  const after = preparedInfo;
  return { path: target, original_path: source, normalized: policy.normalize, method: policy.method,
    ...(encoder ? { encoder } : {}), original: metadata(info), probe: metadata(after), elapsedSeconds: Math.round(performance.now() - started) / 1000 };
}
module.exports = { command, inspect, classify, prepareVideo, selectEncoder, ORIGIN_TOLERANCE };
