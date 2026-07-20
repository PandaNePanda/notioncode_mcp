import { createHash } from "node:crypto";

import { ErrorCode, NotionAgentError } from "./errors.js";
import { invokeTransport } from "./transport.js";

export const MAX_IMAGE_COUNT = 10;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
export const IMAGE_UPLOAD_TIMEOUT_MS = 60_000;

const CONTENT_TYPES = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
});

function imageError(message, options = {}) {
  return new NotionAgentError(message, {
    code: options.code ?? ErrorCode.UNKNOWN,
    responseStatus: options.responseStatus,
    cause: options.cause,
  });
}

function normalizeContentType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function positiveDimensions(width, height, contentType) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw imageError(`Invalid ${contentType} image dimensions.`);
  }
  return { width, height };
}

function pngDimensions(bytes, contentType) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw imageError(`Image data does not match ${contentType}.`);
  }
  return positiveDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20), contentType);
}

function gifDimensions(bytes, contentType) {
  const signature = bytes.subarray(0, 6).toString("ascii");
  if (bytes.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) {
    throw imageError(`Image data does not match ${contentType}.`);
  }
  return positiveDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8), contentType);
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(bytes, contentType) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw imageError(`Image data does not match ${contentType}.`);
  }
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) break;
      return positiveDimensions(
        bytes.readUInt16BE(offset + 5),
        bytes.readUInt16BE(offset + 3),
        contentType,
      );
    }
    offset += length;
  }
  throw imageError(`Image data does not match ${contentType} or has no supported dimensions.`);
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function webpDimensions(bytes, contentType) {
  if (
    bytes.length < 20
    || bytes.subarray(0, 4).toString("ascii") !== "RIFF"
    || bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    throw imageError(`Image data does not match ${contentType}.`);
  }
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    if (bytes.length < 30) throw imageError(`Invalid ${contentType} VP8X image.`);
    return positiveDimensions(
      readUInt24LE(bytes, 24) + 1,
      readUInt24LE(bytes, 27) + 1,
      contentType,
    );
  }
  if (chunk === "VP8 ") {
    if (
      bytes.length < 30
      || bytes[23] !== 0x9d
      || bytes[24] !== 0x01
      || bytes[25] !== 0x2a
    ) {
      throw imageError(`Invalid ${contentType} VP8 image.`);
    }
    return positiveDimensions(
      bytes.readUInt16LE(26) & 0x3fff,
      bytes.readUInt16LE(28) & 0x3fff,
      contentType,
    );
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) {
      throw imageError(`Invalid ${contentType} VP8L image.`);
    }
    const bits = bytes.readUInt32LE(21);
    return positiveDimensions(
      (bits & 0x3fff) + 1,
      ((bits >> 14) & 0x3fff) + 1,
      contentType,
    );
  }
  throw imageError(`Unsupported ${contentType} encoding.`);
}

export function parseImageDimensions(input, rawContentType) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  const contentType = normalizeContentType(rawContentType);
  if (contentType === "image/png") return pngDimensions(bytes, contentType);
  if (contentType === "image/jpeg") return jpegDimensions(bytes, contentType);
  if (contentType === "image/gif") return gifDimensions(bytes, contentType);
  if (contentType === "image/webp") return webpDimensions(bytes, contentType);
  throw imageError(`Unsupported image content type: ${contentType || "unknown"}.`);
}

function strictBase64(value) {
  const compact = String(value ?? "").replace(/\s+/g, "");
  if (!compact) throw imageError("Image data is empty.");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw imageError("Image data contains invalid base64.");
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === 0) throw imageError("Image data is empty.");
  return bytes;
}

function parseDataUrl(value) {
  if (typeof value !== "string" || !value.startsWith("data:")) {
    throw imageError("Images must use a base64 data URL; remote image URLs are not supported.");
  }
  const comma = value.indexOf(",");
  if (comma < 0) throw imageError("Image must be a valid base64 data URL.");
  const header = value.slice(5, comma).split(";");
  const contentType = normalizeContentType(header.shift());
  if (!header.some((entry) => entry.trim().toLowerCase() === "base64")) {
    throw imageError("Image data URL must declare base64 encoding.");
  }
  if (!CONTENT_TYPES[contentType]) {
    throw imageError(`Unsupported image content type: ${contentType || "unknown"}.`);
  }
  return { contentType, bytes: strictBase64(value.slice(comma + 1)) };
}

function imageUrlFromPart(part) {
  const value = part?.image_url ?? part?.imageUrl ?? part?.url;
  if (value && typeof value === "object") return value.url;
  return value;
}

function isImagePart(part) {
  return part?.type === "input_image" || part?.type === "image_url" || part?.type === "image";
}

export function extractImageInputs(parts, options = {}) {
  if (!Array.isArray(parts)) throw new TypeError("Image input parts must be an array.");
  const maxCount = options.maxCount ?? MAX_IMAGE_COUNT;
  const maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_IMAGE_BYTES;
  const retainedParts = [];
  const images = [];
  const hashes = new Set();
  let occurrences = 0;
  let totalBytes = 0;

  for (const part of parts) {
    if (!isImagePart(part)) {
      retainedParts.push(part);
      continue;
    }
    occurrences += 1;
    if (occurrences > maxCount) {
      throw imageError(`A request may contain at most ${maxCount} images.`);
    }
    const { contentType, bytes } = parseDataUrl(imageUrlFromPart(part));
    if (bytes.length > maxImageBytes) {
      throw imageError(`Image size exceeds the per-image limit of ${maxImageBytes} bytes.`);
    }
    const dimensions = parseImageDimensions(bytes, contentType);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hashes.has(hash)) continue;
    if (totalBytes + bytes.length > maxTotalBytes) {
      throw imageError(`Combined image data exceeds the total limit of ${maxTotalBytes} bytes.`);
    }
    hashes.add(hash);
    totalBytes += bytes.length;
    images.push({
      bytes,
      contentType,
      fileName: `codex-image-${images.length + 1}.${CONTENT_TYPES[contentType]}`,
      width: dimensions.width,
      height: dimensions.height,
      sha256: hash,
    });
  }
  return { parts: retainedParts, images, occurrences, totalBytes };
}

export function estimateImageTokens(width, height) {
  positiveDimensions(width, height, "image");
  let scaledWidth = width * (768 / Math.min(width, height));
  let scaledHeight = height * (768 / Math.min(width, height));
  if (Math.max(scaledWidth, scaledHeight) > 2048) {
    const fit = 2048 / Math.max(scaledWidth, scaledHeight);
    scaledWidth *= fit;
    scaledHeight *= fit;
  }
  const tiles = Math.ceil(scaledWidth / 512) * Math.ceil(scaledHeight / 512);
  return {
    openai: 85 + (170 * tiles),
    anthropic: (width * height) / 750,
  };
}

export function buildNotionAttachment(image, { id, fileUrl }) {
  if (!id || !fileUrl) throw new TypeError("Attachment id and fileUrl are required.");
  return {
    id,
    type: "attachment",
    contentType: image.contentType,
    fileName: image.fileName,
    fileUrl,
    metadata: {
      width: image.width,
      height: image.height,
      moderation: { status: "passed" },
      guardrail: {
        attachmentRisk: "skipped",
        inferenceId: id,
      },
      fileSizeBytes: image.bytes.length,
      aiTraceId: id,
      estimatedTokens: estimateImageTokens(image.width, image.height),
      attachmentSource: "user_upload",
    },
  };
}

export function normalizePostHeaders(value) {
  if (value == null) return {};
  if (!Array.isArray(value)) return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [String(key), String(entry)]),
  );
  const headers = {};
  for (const entry of value) {
    if (Array.isArray(entry) && entry.length >= 2) {
      headers[String(entry[0])] = String(entry[1]);
      continue;
    }
    if (entry && typeof entry === "object") {
      const name = entry.name ?? entry.key;
      if (name != null && entry.value != null) headers[String(name)] = String(entry.value);
    }
  }
  return headers;
}

function uploadExtension(image) {
  return CONTENT_TYPES[normalizeContentType(image.contentType)];
}

export async function uploadNotionImage({
  account,
  threadId,
  createThread,
  image,
  uuid,
  requestUploadDescriptor,
  transport,
}) {
  const id = uuid();
  const extension = uploadExtension(image);
  if (!extension) throw imageError(`Unsupported image content type: ${image.contentType}.`);
  const descriptor = await requestUploadDescriptor({
    name: `${id}.${extension}`,
    contentType: image.contentType,
    assistantChatTranscriptSessionPointer: {
      spaceId: account.space_id,
      table: "thread",
      id: threadId,
    },
    contentLength: image.bytes.length,
    createThread: Boolean(createThread),
  });
  if (
    !descriptor
    || typeof descriptor.signedUploadPostUrl !== "string"
    || typeof descriptor.url !== "string"
    || !descriptor.fields
    || typeof descriptor.fields !== "object"
  ) {
    throw imageError("Notion returned an invalid image upload descriptor.");
  }

  const form = new FormData();
  for (const [name, value] of Object.entries(descriptor.fields)) {
    form.append(name, String(value));
  }
  form.append("file", new Blob([image.bytes], { type: image.contentType }), `${id}.${extension}`);

  let response;
  try {
    response = await invokeTransport(transport, descriptor.signedUploadPostUrl, {
      method: "POST",
      headers: normalizePostHeaders(descriptor.postHeaders),
      body: form,
      timeout: IMAGE_UPLOAD_TIMEOUT_MS,
    });
  } catch (error) {
    throw imageError("Unable to upload image to Notion.", {
      code: ErrorCode.TRANSPORT,
      cause: error,
    });
  }
  if (![200, 201, 204].includes(Number(response?.status))) {
    throw imageError(`Notion image upload failed with HTTP ${Number(response?.status) || 0}.`, {
      code: ErrorCode.HTTP_ERROR,
      responseStatus: Number(response?.status) || null,
    });
  }
  return { id, fileUrl: descriptor.url };
}

export function insertAttachmentsBeforeUser(transcript, attachments) {
  const result = Array.isArray(transcript) ? [...transcript] : [];
  if (!Array.isArray(attachments) || attachments.length === 0) return result;
  const index = result.findIndex((entry) => entry?.type === "user");
  result.splice(index < 0 ? result.length : index, 0, ...attachments);
  return result;
}
