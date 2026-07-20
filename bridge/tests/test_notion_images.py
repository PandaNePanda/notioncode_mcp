from __future__ import annotations

import base64
import json
import struct
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from notion_images import (
    ImageInputError,
    build_attachment,
    complete_with_images,
    decode_response_image,
    extract_response_images,
)


def png_data_url(width: int = 3, height: int = 2) -> str:
    # The bridge only needs the PNG signature + IHDR dimensions to validate
    # an already-decoded Codex payload; network/image decoding is Notion's job.
    data = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + struct.pack(">II", width, height)
    return "data:image/png;base64," + base64.b64encode(data).decode()


class ImageInputTests(unittest.TestCase):
    def test_extracts_image_without_changing_text_parts(self) -> None:
        body = {
            "input": [{
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "inspect this"},
                    {"type": "input_image", "image_url": png_data_url()},
                ],
            }],
        }
        images = extract_response_images(body)
        self.assertEqual(len(images), 1)
        self.assertEqual((images[0].width, images[0].height), (3, 2))
        self.assertEqual(images[0].content_type, "image/png")
        self.assertEqual(body["input"][0]["content"][0]["text"], "inspect this")

    def test_deduplicates_repeated_historical_images(self) -> None:
        image = {"type": "input_image", "image_url": png_data_url()}
        body = {"input": [
            {"type": "message", "role": "user", "content": [image]},
            {"type": "message", "role": "user", "content": [image]},
        ]}
        self.assertEqual(len(extract_response_images(body)), 1)

    def test_rejects_remote_urls(self) -> None:
        with self.assertRaisesRegex(ImageInputError, "base64 data URL"):
            decode_response_image("https://example.test/image.png", 1)

    def test_rejects_mime_magic_mismatch(self) -> None:
        bad = "data:image/jpeg;base64," + base64.b64encode(b"not-a-jpeg").decode()
        with self.assertRaisesRegex(ImageInputError, "image/jpeg"):
            decode_response_image(bad, 1)

    def test_builds_native_notion_attachment_metadata(self) -> None:
        image = decode_response_image(png_data_url(385, 385), 1)
        attachment = build_attachment(image, "attachment:chat-id:image.png")
        self.assertEqual(attachment["type"], "attachment")
        self.assertEqual(attachment["fileUrl"], "attachment:chat-id:image.png")
        self.assertEqual(attachment["metadata"]["fileSizeBytes"], len(image.data))
        self.assertEqual(attachment["metadata"]["estimatedTokens"]["openai"], 765)
        self.assertEqual(attachment["metadata"]["attachmentSource"], "user_upload")


class CompleteWithImagesTests(unittest.IsolatedAsyncioTestCase):
    async def test_inserts_attachment_before_user_and_saves_state(self) -> None:
        saved: list[bool] = []
        prep = SimpleNamespace(
            url="https://example.test/inference",
            body={"transcript": [
                {"type": "config"},
                {"type": "context"},
                {"type": "user", "value": [["prompt"]]},
            ]},
            headers={},
            active_thread_id="thread-id",
            notion_model="acai-budino-high",
            save_state=lambda: saved.append(True),
        )

        class Response:
            status_code = 200

            async def aiter_lines(self):
                yield json.dumps({
                    "type": "agent-inference",
                    "value": [{"type": "text", "content": "image understood"}],
                    "inputTokens": 12,
                    "outputTokens": 3,
                    "model": "acai-budino-high",
                })

        @asynccontextmanager
        async def inference_stream(*_args):
            yield Response()

        notion = SimpleNamespace(
            _prepare_call=lambda **_kwargs: prep,
            _inference_stream=inference_stream,
            _raise_for_http=AsyncMock(),
        )
        image = decode_response_image(png_data_url(), 1)
        with patch(
            "notion_images._upload_image",
            AsyncMock(return_value="attachment:chat:image.png"),
        ):
            response = await complete_with_images(
                notion,
                prompt="prompt",
                images=[image],
                model="fable-5",
            )

        self.assertEqual(response.text, "image understood")
        self.assertEqual(response.usage.input_tokens, 12)
        self.assertEqual([item["type"] for item in prep.body["transcript"]], [
            "config", "context", "attachment", "user",
        ])
        self.assertEqual(saved, [True])

    async def test_continues_existing_thread_with_a_new_image(self) -> None:
        prepared: list[dict] = []
        prep = SimpleNamespace(
            url="https://example.test/inference",
            body={"createThread": False, "transcript": [
                {"type": "user", "value": [["next prompt"]]},
            ]},
            headers={},
            active_thread_id="existing-thread",
            notion_model="acai-budino-high",
            save_state=lambda: None,
        )

        def prepare(**kwargs):
            prepared.append(kwargs)
            return prep

        class Response:
            status_code = 200

            async def aiter_lines(self):
                yield json.dumps({
                    "type": "agent-inference",
                    "value": [{"type": "text", "content": "continued"}],
                    "inputTokens": 5,
                    "outputTokens": 1,
                })

        @asynccontextmanager
        async def inference_stream(*_args):
            yield Response()

        notion = SimpleNamespace(
            _prepare_call=prepare,
            _inference_stream=inference_stream,
            _raise_for_http=AsyncMock(),
        )
        with patch("notion_images._upload_image", AsyncMock(return_value="attachment:url")) as upload:
            await complete_with_images(
                notion,
                prompt="next prompt",
                images=[decode_response_image(png_data_url(), 1)],
                model="fable-5",
                thread_id="existing-thread",
            )
        self.assertEqual(prepared[0]["thread_id"], "existing-thread")
        self.assertFalse(upload.await_args.kwargs["create_thread"])


if __name__ == "__main__":
    unittest.main()
