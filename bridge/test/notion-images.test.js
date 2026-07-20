import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNotionAttachment,
  extractImageInputs,
  insertAttachmentsBeforeUser,
} from "../src/notion-images.js";
import { NotionProvider } from "../src/provider.js";

function pngDataUrl(width = 3, height = 2) {
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32BE(width, 0);
  dimensions.writeUInt32BE(height, 4);
  const bytes = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    dimensions,
  ]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

test("image extraction preserves text and decodes dimensions", () => {
  const text = { type: "input_text", text: "inspect this" };
  const result = extractImageInputs([
    text,
    { type: "input_image", image_url: pngDataUrl() },
  ]);
  assert.deepEqual(result.parts, [text]);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].width, 3);
  assert.equal(result.images[0].height, 2);
  assert.equal(result.images[0].contentType, "image/png");
  assert.equal(text.text, "inspect this");
});

test("image extraction deduplicates repeated historical images", () => {
  const image = { type: "input_image", image_url: pngDataUrl() };
  const result = extractImageInputs([image, image]);
  assert.equal(result.images.length, 1);
  assert.equal(result.occurrences, 2);
});

test("image extraction rejects remote URLs", () => {
  assert.throws(
    () => extractImageInputs([{
      type: "input_image",
      image_url: "https://example.test/image.png",
    }]),
    /base64 data URL/,
  );
});

test("image extraction rejects MIME and magic-byte mismatches", () => {
  const bad = `data:image/jpeg;base64,${Buffer.from("not-a-jpeg").toString("base64")}`;
  assert.throws(
    () => extractImageInputs([{ type: "input_image", image_url: bad }]),
    /image\/jpeg/,
  );
});

test("native Notion attachment metadata matches the Python bridge", () => {
  const { images } = extractImageInputs([{
    type: "input_image",
    image_url: pngDataUrl(385, 385),
  }]);
  const attachment = buildNotionAttachment(images[0], {
    id: "chat-id",
    fileUrl: "attachment:chat-id:image.png",
  });
  assert.equal(attachment.type, "attachment");
  assert.equal(attachment.fileUrl, "attachment:chat-id:image.png");
  assert.equal(attachment.metadata.fileSizeBytes, images[0].bytes.length);
  assert.equal(attachment.metadata.estimatedTokens.openai, 765);
  assert.equal(attachment.metadata.attachmentSource, "user_upload");
});

test("attachments are inserted immediately before the user transcript entry", () => {
  const transcript = [
    { type: "config" },
    { type: "context" },
    { type: "user", value: [["prompt"]] },
  ];
  const result = insertAttachmentsBeforeUser(transcript, [{ type: "attachment" }]);
  assert.deepEqual(result.map((entry) => entry.type), [
    "config",
    "context",
    "attachment",
    "user",
  ]);
});

function providerHarness({ createThread }) {
  const uploadedDescriptors = [];
  const savedStates = [];
  let inferenceRequest = null;
  const prepared = {
    account: {
      token_v2: "test-token",
      user_id: "test-user",
      space_id: "test-space",
      browser_id: "test-browser",
      device_id: "test-device",
      client_version: "23.13.20260528.1850",
      user_agent: "test-agent",
      timezone: "UTC",
      default_model: "opus-4.8",
    },
    requestedModel: "fable-5",
    notionModel: "acai-budino-high",
    threadId: createThread ? "new-thread" : "existing-thread",
    pendingState: { thread_id: createThread ? "new-thread" : "existing-thread" },
    request: {
      createThread,
      transcript: createThread
        ? [{ type: "config" }, { type: "context" }, { type: "user", value: [["prompt"]] }]
        : [{ type: "user", value: [["next prompt"]] }],
    },
  };
  const provider = new NotionProvider({
    account: prepared.account,
    modelAliases: {},
    uuid: () => "image-id",
    imageUploadDelayMs: 0,
    transport: async () => ({ status: 204 }),
    threadStore: {
      async save(state) { savedStates.push(state); },
    },
  });
  provider.prepare = async () => prepared;
  provider.postJson = async (_endpoint, body) => {
    uploadedDescriptors.push(body);
    return {
      signedUploadPostUrl: "https://uploads.example.test/",
      url: "attachment:chat:image.png",
      fields: { key: "value" },
      postHeaders: {},
    };
  };
  provider._postInference = async (value) => {
    inferenceRequest = value.request;
    return new Response(`${JSON.stringify({
      type: "agent-inference",
      value: [{ type: "text", content: createThread ? "image understood" : "continued" }],
      inputTokens: createThread ? 12 : 5,
      outputTokens: createThread ? 3 : 1,
      model: "acai-budino-high",
    })}\n`, { status: 200 });
  };
  return {
    provider,
    prepared,
    uploadedDescriptors,
    savedStates,
    inferenceRequest: () => inferenceRequest,
  };
}

test("provider uploads images, inserts attachments, and saves thread state", async () => {
  const harness = providerHarness({ createThread: true });
  const response = await harness.provider.complete({
    prompt: "prompt",
    model: "fable-5",
    images: [{ type: "input_image", image_url: pngDataUrl() }],
  });

  assert.equal(response.text, "image understood");
  assert.equal(response.usage.input_tokens, 12);
  assert.deepEqual(harness.inferenceRequest().transcript.map((entry) => entry.type), [
    "config",
    "context",
    "attachment",
    "user",
  ]);
  assert.equal(harness.savedStates.length, 1);
  assert.equal(harness.uploadedDescriptors[0].createThread, true);
});

test("provider continues an existing thread when uploading a new image", async () => {
  const harness = providerHarness({ createThread: false });
  const response = await harness.provider.complete({
    prompt: "next prompt",
    model: "fable-5",
    thread_id: "existing-thread",
    images: [{ type: "input_image", image_url: pngDataUrl() }],
  });

  assert.equal(response.text, "continued");
  assert.equal(harness.prepared.threadId, "existing-thread");
  assert.equal(harness.uploadedDescriptors[0].createThread, false);
  assert.deepEqual(harness.inferenceRequest().transcript.map((entry) => entry.type), [
    "attachment",
    "user",
  ]);
});
