// Uploads belong to an authenticated socket, never to a filesystem path supplied by it.
const { randomUUID } = require("node:crypto");
const LIMITS = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  files: 8,
});
function createWorkspaceUploads(now = Date.now) {
  const uploads = new Map();
  function prune() {
    for (const [id, row] of uploads) if (row.until < now()) uploads.delete(id);
  }
  function own(owner, id) {
    prune();
    const row = uploads.get(id);
    if (!row || row.owner !== owner) throw Error("upload_not_found");
    return row;
  }
  return {
    limits: LIMITS,
    request(owner, method, p) {
      prune();
      if (method === "uploads.begin") {
        const rows = [...uploads.values()].filter((x) => x.owner === owner);
        if (
          !Number.isSafeInteger(p.size) ||
          p.size <= 0 ||
          p.size > LIMITS.fileBytes ||
          rows.length >= LIMITS.files ||
          [...uploads.values()].reduce((n, x) => n + x.size, 0) + p.size >
            LIMITS.totalBytes
        )
          throw Error("upload_limit");
        if (
          typeof p.fileName !== "string" ||
          !p.fileName.trim() ||
          p.fileName.length > 200 ||
          /[\x00-\x1f/\\]/.test(p.fileName) ||
          typeof p.mimeType !== "string" ||
          !/^[\w.+-]+\/[\w.+-]+$/.test(p.mimeType)
        )
          throw Error("invalid_attachment");
        const id = randomUUID();
        uploads.set(id, {
          owner,
          size: p.size,
          fileName: p.fileName,
          mimeType: p.mimeType,
          bytes: 0,
          parts: [],
          until: now() + 300000,
        });
        return { id, chunkBytes: LIMITS.chunkBytes };
      }
      const row = own(owner, p.id);
      if (method === "uploads.cancel") {
        uploads.delete(p.id);
        return { ok: true };
      }
      if (
        method !== "uploads.chunk" ||
        !Number.isSafeInteger(p.offset) ||
        p.offset !== row.bytes ||
        typeof p.content !== "string" ||
        p.content.length > Math.ceil(LIMITS.chunkBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          p.content,
        )
      )
        throw Error("invalid_upload_chunk");
      const bytes = Buffer.from(p.content, "base64");
      if (
        !bytes.length ||
        bytes.length > LIMITS.chunkBytes ||
        row.bytes + bytes.length > row.size
      )
        throw Error("invalid_upload_chunk");
      row.parts.push(bytes);
      row.bytes += bytes.length;
      row.until = now() + 300000;
      return { id: p.id, offset: row.bytes, complete: row.bytes === row.size };
    },
    descriptors(owner, ids) {
      if (
        !Array.isArray(ids) ||
        ids.length > LIMITS.files ||
        new Set(ids).size !== ids.length
      )
        throw Error("invalid_attachments");
      return ids.map((id) => {
        const row = own(owner, id);
        if (row.bytes !== row.size) throw Error("upload_incomplete");
        return {
          type: row.mimeType.startsWith("image/") ? "image" : "file",
          mimeType: row.mimeType,
          fileName: row.fileName,
          content: Buffer.concat(row.parts).toString("base64"),
        };
      });
    },
    release(owner) {
      for (const [id, row] of uploads)
        if (row.owner === owner) uploads.delete(id);
    },
    close() {
      uploads.clear();
    },
  };
}
module.exports = { createWorkspaceUploads };
