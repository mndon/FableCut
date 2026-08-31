"use strict";

const crypto = require("crypto");

const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_KINDS = new Set(["video", "audio", "image", "svg"]);
const CLIP_KINDS = new Set(["video", "audio", "image", "svg", "text", "adjust"]);

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.public = true;
  if (details) error.details = details;
  return error;
}

function assertProjectId(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId))
    throw codedError("INVALID_PROJECT_ID", "projectId must be a UUID v4 string");
  return projectId.toLowerCase();
}

function finiteNumber(value, label, { min = -Infinity, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value)))
    throw codedError("INVALID_PROJECT", `${label} must be ${integer ? "an integer" : "a finite number"}${min !== -Infinity ? ` >= ${min}` : ""}`);
}

function validateProject(doc, { mediaReference = "assetId" } = {}) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw codedError("INVALID_PROJECT", "project must be an object");
  if (doc.schemaVersion !== 1)
    throw codedError("UNSUPPORTED_SCHEMA", "project.schemaVersion must be 1");
  if (typeof doc.name !== "string" || !doc.name.trim())
    throw codedError("INVALID_PROJECT", "project.name must be a non-empty string");
  finiteNumber(doc.width, "project.width", { min: 1, integer: true });
  finiteNumber(doc.height, "project.height", { min: 1, integer: true });
  finiteNumber(doc.fps, "project.fps", { min: 1 });
  finiteNumber(doc.revision, "project.revision", { min: 0, integer: true });
  if (doc.background != null && typeof doc.background !== "string")
    throw codedError("INVALID_PROJECT", "project.background must be a string");
  if (!Array.isArray(doc.media) || !Array.isArray(doc.clips))
    throw codedError("INVALID_PROJECT", "project.media and project.clips must be arrays");
  if (doc.markers != null) {
    if (!Array.isArray(doc.markers)) throw codedError("INVALID_PROJECT", "project.markers must be an array");
    for (const [index, marker] of doc.markers.entries()) {
      if (!marker || typeof marker !== "object") throw codedError("INVALID_PROJECT", `marker ${index} must be an object`);
      finiteNumber(marker.t, `marker ${index}.t`, { min: 0 });
      if (marker.label != null && typeof marker.label !== "string") throw codedError("INVALID_PROJECT", `marker ${index}.label must be a string`);
    }
  }
  if (doc.inPoint != null) finiteNumber(doc.inPoint, "project.inPoint", { min: 0 });
  if (doc.outPoint != null) finiteNumber(doc.outPoint, "project.outPoint", { min: 0 });
  if (doc.inPoint != null && doc.outPoint != null && doc.outPoint <= doc.inPoint)
    throw codedError("INVALID_PROJECT", "project.outPoint must be greater than inPoint");
  if (doc.disabledTracks != null && (!Array.isArray(doc.disabledTracks) || doc.disabledTracks.some((track) => typeof track !== "string" || !/^[VA][1-9]\d*$/.test(track))))
    throw codedError("INVALID_PROJECT", "project.disabledTracks must contain valid track IDs");

  const folderIds = new Set();
  const folders = new Map();
  if (doc.folders != null) {
    if (!Array.isArray(doc.folders)) throw codedError("INVALID_PROJECT", "project.folders must be an array");
    for (const folder of doc.folders) {
      if (!folder || typeof folder.id !== "string" || !folder.id || typeof folder.name !== "string" || !folder.name.trim())
        throw codedError("INVALID_PROJECT", "every folder needs a non-empty id and name");
      if (folderIds.has(folder.id)) throw codedError("INVALID_PROJECT", `duplicate folder id ${folder.id}`);
      if (folder.parentId != null && (typeof folder.parentId !== "string" || !folder.parentId))
        throw codedError("INVALID_PROJECT", `folder ${folder.id}.parentId must be a string or null`);
      folderIds.add(folder.id); folders.set(folder.id, folder);
    }
    for (const folder of folders.values()) {
      if (folder.parentId && !folderIds.has(folder.parentId)) throw codedError("INVALID_PROJECT", `folder ${folder.id} has unknown parent ${folder.parentId}`);
      const seen = new Set([folder.id]); let parent = folder.parentId;
      while (parent) {
        if (seen.has(parent)) throw codedError("INVALID_PROJECT", `folder cycle includes ${folder.id}`);
        seen.add(parent); parent = folders.get(parent)?.parentId;
      }
    }
  }

  const mediaIds = new Set();
  const mediaReferences = new Set();
  for (const media of doc.media) {
    if (!media || typeof media !== "object" || typeof media.id !== "string" || !media.id)
      throw codedError("INVALID_PROJECT", "every media entry needs a non-empty id");
    if (mediaIds.has(media.id)) throw codedError("INVALID_PROJECT", `duplicate media id ${media.id}`);
    mediaIds.add(media.id);
    if (typeof media[mediaReference] !== "string" || !media[mediaReference].trim())
      throw codedError("INVALID_PROJECT", `media ${media.id} needs a non-empty ${mediaReference}`);
    if (typeof media.name !== "string" || !media.name.trim())
      throw codedError("INVALID_PROJECT", `media ${media.id} needs a non-empty name`);
    if (mediaReference === "assetId" && Object.hasOwn(media, "src"))
      throw codedError("INVALID_PROJECT", `media ${media.id} must not persist src; clients resolve assetId`);
    if (mediaReference === "src" && Object.hasOwn(media, "assetId"))
      throw codedError("INVALID_PROJECT", `media ${media.id} must not persist assetId; HTTP clients use src`);
    if (mediaReferences.has(media[mediaReference]))
      throw codedError("INVALID_PROJECT", `duplicate ${mediaReference} ${media[mediaReference]}`);
    mediaReferences.add(media[mediaReference]);
    if (!MEDIA_KINDS.has(media.kind)) throw codedError("INVALID_PROJECT", `media ${media.id} has invalid kind ${media.kind}`);
    if (media.folderId != null && !folderIds.has(media.folderId))
      throw codedError("INVALID_PROJECT", `media ${media.id} references unknown folderId ${media.folderId}`);
    if (media.duration != null) finiteNumber(media.duration, `media ${media.id}.duration`, { min: 0 });
    if (media.width != null) finiteNumber(media.width, `media ${media.id}.width`, { min: 1, integer: true });
    if (media.height != null) finiteNumber(media.height, `media ${media.id}.height`, { min: 1, integer: true });
  }

  const clipIds = new Set();
  for (const clip of doc.clips) {
    if (!clip || typeof clip !== "object" || typeof clip.id !== "string" || !clip.id)
      throw codedError("INVALID_PROJECT", "every clip needs a non-empty id");
    if (clipIds.has(clip.id)) throw codedError("INVALID_PROJECT", `duplicate clip id ${clip.id}`);
    clipIds.add(clip.id);
    if (!CLIP_KINDS.has(clip.kind)) throw codedError("INVALID_PROJECT", `clip ${clip.id} has invalid kind ${clip.kind}`);
    if (typeof clip.track !== "string" || !/^[VA][1-9]\d*$/.test(clip.track))
      throw codedError("INVALID_PROJECT", `clip ${clip.id} has invalid track ${clip.track}`);
    if ((clip.kind === "audio") !== clip.track.startsWith("A"))
      throw codedError("INVALID_PROJECT", `clip ${clip.id} kind ${clip.kind} is on incompatible track ${clip.track}`);
    finiteNumber(clip.start, `clip ${clip.id}.start`, { min: 0 });
    finiteNumber(clip.duration, `clip ${clip.id}.duration`, { min: 0 });
    if (clip.in != null) finiteNumber(clip.in, `clip ${clip.id}.in`, { min: 0 });
    if (clip.props != null && (!clip.props || typeof clip.props !== "object" || Array.isArray(clip.props)))
      throw codedError("INVALID_PROJECT", `clip ${clip.id}.props must be an object`);
    if (clip.keyframes != null) {
      if (!clip.keyframes || typeof clip.keyframes !== "object" || Array.isArray(clip.keyframes))
        throw codedError("INVALID_PROJECT", `clip ${clip.id}.keyframes must be an object`);
      for (const [channel, frames] of Object.entries(clip.keyframes)) {
        if (!Array.isArray(frames)) throw codedError("INVALID_PROJECT", `clip ${clip.id} keyframes.${channel} must be an array`);
        for (const [index, frame] of frames.entries()) {
          if (!frame || typeof frame !== "object") throw codedError("INVALID_PROJECT", `clip ${clip.id} keyframe ${channel}[${index}] must be an object`);
          finiteNumber(frame.t, `clip ${clip.id} keyframe ${channel}[${index}].t`, { min: 0 });
          finiteNumber(frame.v, `clip ${clip.id} keyframe ${channel}[${index}].v`);
        }
      }
    }
    for (const key of ["transitionIn", "transitionOut"]) if (clip[key] != null) {
      const transition = clip[key];
      if (!transition || typeof transition !== "object" || typeof transition.type !== "string")
        throw codedError("INVALID_PROJECT", `clip ${clip.id}.${key} must contain a type`);
      finiteNumber(transition.duration, `clip ${clip.id}.${key}.duration`, { min: 0 });
    }
    if (clip.kind === "text" || clip.kind === "adjust") {
      if (clip.mediaId != null) throw codedError("INVALID_PROJECT", `clip ${clip.id} must not reference media`);
    } else if (!mediaIds.has(clip.mediaId)) {
      throw codedError("INVALID_PROJECT", `clip ${clip.id} references unknown mediaId ${clip.mediaId}`);
    }
  }
  return doc;
}

function newProject(options = {}) {
  const width = options.width == null ? 1280 : options.width;
  const height = options.height == null ? 720 : options.height;
  const fps = options.fps == null ? 30 : options.fps;
  const doc = {
    schemaVersion: 1,
    name: typeof options.name === "string" && options.name.trim() ? options.name.trim() : "Untitled Project",
    width,
    height,
    fps,
    revision: 0,
    media: [],
    clips: [],
  };
  return validateProject(doc);
}

function newEntityId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

module.exports = {
  assertProjectId,
  codedError,
  newEntityId,
  newProject,
  validateProject,
};
