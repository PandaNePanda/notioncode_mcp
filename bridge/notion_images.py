from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import math
import struct
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
from notion_agent_cli.exceptions import ErrorCode, NotionAgentError
from notion_agent_cli.ndjson import NDJSONStreamParser
from notion_agent_cli.provider import NotionAgentClient
from notion_agent_cli.types import ChatResponse, TokenUsage


MAX_IMAGE_COUNT = 10
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024

_MIME_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
}


class ImageInputError(ValueError):
    """A malformed or unsupported OpenAI Responses image input."""


@dataclass(frozen=True, slots=True)
class ResponseImage:
    data: bytes
    content_type: str
    file_name: str
    width: int
    height: int

    @property
    def fingerprint(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


def _image_dimensions(data: bytes, content_type: str) -> tuple[int, int]:
    if content_type == "image/png":
        if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
            raise ImageInputError("image data does not match its image/png content type")
        width, height = struct.unpack(">II", data[16:24])
    elif content_type == "image/jpeg":
        if len(data) < 4 or not data.startswith(b"\xff\xd8\xff"):
            raise ImageInputError("image data does not match its image/jpeg content type")
        width, height = _jpeg_dimensions(data)
    elif content_type == "image/gif":
        if len(data) < 10 or data[:6] not in {b"GIF87a", b"GIF89a"}:
            raise ImageInputError("image data does not match its image/gif content type")
        width, height = struct.unpack("<HH", data[6:10])
    elif content_type == "image/webp":
        width, height = _webp_dimensions(data)
    else:  # guarded by decode_response_image
        raise ImageInputError(f"unsupported image content type: {content_type}")
    if width <= 0 or height <= 0:
        raise ImageInputError("image dimensions must be positive")
    return width, height


def _jpeg_dimensions(data: bytes) -> tuple[int, int]:
    sof_markers = {
        0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
        0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
    }
    offset = 2
    while offset + 3 < len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker in {0x01, 0xD8, 0xD9}:
            continue
        if offset + 2 > len(data):
            break
        segment_length = struct.unpack(">H", data[offset:offset + 2])[0]
        if segment_length < 2 or offset + segment_length > len(data):
            break
        if marker in sof_markers and segment_length >= 7:
            height, width = struct.unpack(">HH", data[offset + 3:offset + 7])
            return width, height
        offset += segment_length
    raise ImageInputError("could not read JPEG dimensions")


def _webp_dimensions(data: bytes) -> tuple[int, int]:
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ImageInputError("image data does not match its image/webp content type")
    chunk = data[12:16]
    if chunk == b"VP8X":
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
        return width, height
    if chunk == b"VP8 ":
        if len(data) < 30 or data[23:26] != b"\x9d\x01\x2a":
            raise ImageInputError("could not read WebP VP8 dimensions")
        width = int.from_bytes(data[26:28], "little") & 0x3FFF
        height = int.from_bytes(data[28:30], "little") & 0x3FFF
        return width, height
    if chunk == b"VP8L":
        if len(data) < 25 or data[20] != 0x2F:
            raise ImageInputError("could not read WebP VP8L dimensions")
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    raise ImageInputError("unsupported WebP encoding")


def decode_response_image(image_url: Any, index: int) -> ResponseImage:
    if not isinstance(image_url, str) or not image_url.startswith("data:"):
        raise ImageInputError(
            "input_image.image_url must be a base64 data URL; Codex CLI -i/--image uses this format"
        )
    try:
        header, payload = image_url.split(",", 1)
    except ValueError as exc:
        raise ImageInputError("malformed image data URL") from exc
    header_parts = header[5:].split(";")
    content_type = header_parts[0].lower().strip()
    if content_type == "image/jpg":
        content_type = "image/jpeg"
    if "base64" not in {part.lower().strip() for part in header_parts[1:]}:
        raise ImageInputError("image data URL must use base64 encoding")
    extension = _MIME_EXTENSIONS.get(content_type)
    if extension is None:
        allowed = ", ".join(sorted(_MIME_EXTENSIONS))
        raise ImageInputError(
            f"unsupported image content type {content_type or '<missing>'}; allowed: {allowed}"
        )
    try:
        data = base64.b64decode("".join(payload.split()), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImageInputError("image data URL contains invalid base64") from exc
    if not data:
        raise ImageInputError("image data URL is empty")
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageInputError(
            f"image {index} exceeds the {MAX_IMAGE_BYTES // (1024 * 1024)} MiB limit"
        )
    width, height = _image_dimensions(data, content_type)
    return ResponseImage(
        data=data,
        content_type=content_type,
        file_name=f"codex-image-{index}.{extension}",
        width=width,
        height=height,
    )


def extract_response_images(body: dict[str, Any]) -> list[ResponseImage]:
    images: list[ResponseImage] = []
    fingerprints: set[str] = set()
    request_input = body.get("input", [])
    if not isinstance(request_input, list):
        return images
    for item in request_input:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "input_image":
                continue
            if len(images) >= MAX_IMAGE_COUNT:
                raise ImageInputError(f"at most {MAX_IMAGE_COUNT} images are supported per request")
            image = decode_response_image(part.get("image_url"), len(images) + 1)
            if image.fingerprint in fingerprints:
                continue
            fingerprints.add(image.fingerprint)
            images.append(image)
    total = sum(len(image.data) for image in images)
    if total > MAX_TOTAL_IMAGE_BYTES:
        raise ImageInputError(
            f"combined image data exceeds the {MAX_TOTAL_IMAGE_BYTES // (1024 * 1024)} MiB limit"
        )
    return images


def _openai_image_tokens(width: int, height: int) -> int:
    # This mirrors the estimate emitted by Notion's web composer for a
    # high-detail attachment. It is metadata, not usage charged by the bridge.
    scale = 768 / min(width, height)
    scaled_width = width * scale
    scaled_height = height * scale
    if max(scaled_width, scaled_height) > 2048:
        fit = 2048 / max(scaled_width, scaled_height)
        scaled_width *= fit
        scaled_height *= fit
    tiles = math.ceil(scaled_width / 512) * math.ceil(scaled_height / 512)
    return 85 + 170 * tiles


def estimated_image_tokens(images: list[ResponseImage]) -> int:
    return sum(_openai_image_tokens(image.width, image.height) for image in images)


def build_attachment(image: ResponseImage, file_url: str) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "type": "attachment",
        "contentType": image.content_type,
        "fileName": image.file_name,
        "fileUrl": file_url,
        "metadata": {
            "width": image.width,
            "height": image.height,
            "moderation": {"status": "passed"},
            "guardrail": {
                "attachmentRisk": "skipped",
                "inferenceId": str(uuid.uuid4()),
            },
            "fileSizeBytes": len(image.data),
            "aiTraceId": str(uuid.uuid4()),
            "estimatedTokens": {
                "openai": _openai_image_tokens(image.width, image.height),
                "anthropic": image.width * image.height / 750,
            },
            "attachmentSource": "user_upload",
        },
    }


def _upload_headers(value: Any) -> dict[str, str]:
    if isinstance(value, dict):
        return {str(key): str(item) for key, item in value.items()}
    headers: dict[str, str] = {}
    if isinstance(value, list):
        for item in value:
            if isinstance(item, (list, tuple)) and len(item) == 2:
                headers[str(item[0])] = str(item[1])
            elif isinstance(item, dict):
                name = item.get("name") or item.get("key")
                header_value = item.get("value")
                if name is not None and header_value is not None:
                    headers[str(name)] = str(header_value)
    return headers


async def _upload_image(
    notion: NotionAgentClient,
    image: ResponseImage,
    *,
    thread_id: str,
    create_thread: bool,
) -> str:
    account = notion.load_account()
    upload_name = f"{uuid.uuid4()}.{_MIME_EXTENSIONS[image.content_type]}"
    upload = await notion._post_json(
        "getUploadFileUrlForAssistantChatTranscriptUpload",
        {
            "name": upload_name,
            "contentType": image.content_type,
            "assistantChatTranscriptSessionPointer": {
                "spaceId": account.space_id,
                "table": "thread",
                "id": thread_id,
            },
            "contentLength": len(image.data),
            "createThread": create_thread,
        },
    )
    signed_url = upload.get("signedUploadPostUrl")
    file_url = upload.get("url")
    fields = upload.get("fields")
    if (
        not isinstance(signed_url, str)
        or not isinstance(file_url, str)
        or not isinstance(fields, dict)
    ):
        raise RuntimeError("Notion returned an incomplete image upload descriptor")
    multipart: dict[str, tuple[None, str] | tuple[str, bytes, str]] = {
        str(key): (None, str(value)) for key, value in fields.items()
    }
    multipart["file"] = (upload_name, image.data, image.content_type)
    async with httpx.AsyncClient(timeout=60) as http:
        response = await http.post(
            signed_url,
            headers=_upload_headers(upload.get("postHeaders")),
            files=multipart,
        )
    if response.status_code not in {200, 201, 204}:
        raise RuntimeError(f"Notion image upload failed with HTTP {response.status_code}")
    return file_url


async def complete_with_images(
    notion: NotionAgentClient,
    *,
    prompt: str,
    images: list[ResponseImage],
    model: str,
    system: str | None = None,
    web_search: bool = False,
    workspace_search: bool = False,
    ask_mode: bool = True,
    thread_id: str | None = None,
) -> ChatResponse:
    """Complete a request using Notion's native attachment flow.

    Text-only callers intentionally continue to use NotionAgentClient.complete;
    this function is an isolated compatibility layer for Responses input_image.
    """
    if not images:
        return await notion.complete(
            prompt=prompt,
            system=system,
            model=model,
            web_search=web_search,
            workspace_search=workspace_search,
            ask_mode=ask_mode,
            thread_id=thread_id,
        )
    prep = notion._prepare_call(
        prompt=prompt,
        system=system,
        model=model,
        web_search=web_search,
        workspace_search=workspace_search,
        ask_mode=ask_mode,
        thread_id=thread_id,
        workflow_id=None,
    )
    attachments = [
        build_attachment(
            image,
            await _upload_image(
                notion,
                image,
                thread_id=prep.active_thread_id,
                create_thread=bool(prep.body.get("createThread", False)),
            ),
        )
        for image in images
    ]
    transcript = prep.body.get("transcript")
    if not isinstance(transcript, list):
        raise RuntimeError("Notion inference request has no transcript")
    user_index = next(
        (
            index
            for index, item in enumerate(transcript)
            if isinstance(item, dict) and item.get("type") == "user"
        ),
        len(transcript),
    )
    transcript[user_index:user_index] = attachments

    # The upload POST is complete before inference begins. A short yield also
    # lets the S3 object become visible to Notion's attachment fetcher without
    # imposing a noticeable delay on local Codex use.
    await asyncio.sleep(0.1)

    parser = NDJSONStreamParser()
    async with notion._inference_stream(prep.url, prep.body, prep.headers) as response:
        if response.status_code != 200:
            await notion._raise_for_http(response)
        async for line in response.aiter_lines():
            parser.feed_line(line)
    result = parser.finalize()
    if not result.text:
        raise NotionAgentError(
            f"notion returned empty text for an image request "
            f"(events={result.event_type_counts}, lines={result.line_count})",
            code=ErrorCode.EMPTY_TEXT,
        )
    prep.save_state()
    return ChatResponse(
        text=result.text,
        model=result.notion_model or prep.notion_model,
        thread_id=prep.active_thread_id,
        thinking=result.thinking,
        usage=TokenUsage(
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            cache_read=result.cache_read_tokens,
            cache_creation=result.cache_creation_tokens,
        ),
        raw={
            "notion_model": result.notion_model or prep.notion_model,
            "event_type_counts": result.event_type_counts,
            "line_count": result.line_count,
            "image_count": len(images),
        },
    )
