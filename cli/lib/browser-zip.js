"use strict";

// Chrome for Testing uses ordinary ZIP archives. Stream their entries with Node
// built-ins so installing the browser does not require unzip, PowerShell or npm.
const fs = require("fs");
const path = require("path");
const { Transform, Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { createInflateRaw } = require("zlib");

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buffer, crc = 0xffffffff) {
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

async function extractZip(archive, directory) {
  const file = await fs.promises.open(archive, "r");
  const root = path.resolve(directory), links = [], names = new Set();
  try {
    const { size } = await file.stat();
    async function read(position, length) {
      if (position < 0 || length < 0 || position + length > size) throw new Error("Truncated browser ZIP");
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
        if (!bytesRead) throw new Error("Truncated browser ZIP");
        offset += bytesRead;
      }
      return buffer;
    }
    const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = tail.length - 22;
    while (end >= 0 && (tail.readUInt32LE(end) !== 0x06054b50 || end + 22 + tail.readUInt16LE(end + 20) !== tail.length)) end--;
    if (end < 0) throw new Error("Invalid browser ZIP directory");
    const count = tail.readUInt16LE(end + 10), centralSize = tail.readUInt32LE(end + 12), centralOffset = tail.readUInt32LE(end + 16);
    if (tail.readUInt32LE(end + 4) || tail.readUInt16LE(end + 8) !== count || count === 65535 || centralSize > 16 * 1024 * 1024)
      throw new Error("Unsupported browser ZIP format");
    const central = await read(centralOffset, centralSize);
    let offset = 0, total = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid browser ZIP entry");
      const flags = central.readUInt16LE(offset + 8), method = central.readUInt16LE(offset + 10);
      const checksum = central.readUInt32LE(offset + 16), packed = central.readUInt32LE(offset + 20), unpacked = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28), extraLength = central.readUInt16LE(offset + 30), commentLength = central.readUInt16LE(offset + 32);
      const mode = central.readUInt32LE(offset + 38) >>> 16, localOffset = central.readUInt32LE(offset + 42);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (next > central.length || flags & 1 || ![0, 8].includes(method) || packed === 0xffffffff || localOffset === 0xffffffff)
        throw new Error("Unsupported browser ZIP entry");
      const name = central.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      offset = next;
      const target = path.resolve(root, name);
      if (!name || /[\\:\0]/.test(name) || name.split("/").some(part => part === "..") || !inside(root, target) || names.has(target))
        throw new Error("Unsafe browser ZIP path: " + name);
      names.add(target);
      total += unpacked;
      if (total > 3 * 1024 ** 3) throw new Error("Browser ZIP exceeds extraction limit");
      const type = mode & 0xf000;
      if (type && ![0x4000, 0x8000, 0xa000].includes(type)) throw new Error("Unsupported browser ZIP file type");
      if (name.endsWith("/")) {
        if (unpacked || (type && type !== 0x4000)) throw new Error("Invalid browser ZIP directory entry");
        await fs.promises.mkdir(target, { recursive: true });
        continue;
      }
      const local = await read(localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== method) throw new Error("Invalid browser ZIP local entry");
      const start = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + packed > centralOffset) throw new Error("Truncated browser ZIP payload");
      if (type === 0xa000 && unpacked > 4096) throw new Error("Invalid browser ZIP symlink");
      let length = 0, crc = 0xffffffff;
      const check = new Transform({ transform(chunk, _encoding, callback) {
        length += chunk.length;
        if (length > unpacked) return callback(new Error("Browser ZIP size mismatch"));
        crc = crc32(chunk, crc);
        callback(null, chunk);
      } });
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const input = packed ? fs.createReadStream(archive, { start, end: start + packed - 1 }) : Readable.from([]);
      const parts = [input];
      if (method === 8) parts.push(createInflateRaw());
      parts.push(check, fs.createWriteStream(target, { flags: "wx", mode: mode & 0o111 ? 0o755 : 0o644 }));
      await pipeline(...parts);
      if (length !== unpacked || ((crc ^ 0xffffffff) >>> 0) !== checksum) throw new Error("Browser ZIP checksum mismatch: " + name);
      if (type === 0xa000) {
        const link = await fs.promises.readFile(target, "utf8");
        if (!link || /[\\:\0]/.test(link) || path.isAbsolute(link) || !inside(root, path.resolve(path.dirname(target), link)))
          throw new Error("Unsafe browser ZIP symlink: " + name);
        links.push({ target, link });
      }
    }
    if (offset !== central.length) throw new Error("Invalid browser ZIP directory size");
    // Create links last: extraction can never write through an archive symlink.
    for (const { target, link } of links) {
      await fs.promises.unlink(target);
      await fs.promises.symlink(link, target);
    }
    // Also check resolved chains: a lexical in-root target can escape through
    // another symlink followed by "..". Dangling/cyclic links are invalid too.
    const realRoot = await fs.promises.realpath(root);
    for (const { target } of links) {
      if (!inside(realRoot, await fs.promises.realpath(target))) throw new Error("Unsafe browser ZIP symlink chain");
    }
  } finally { await file.close(); }
}

module.exports = { extractZip, crc32 };
