# Codex CLI image inputs

The Notion-backed Codex provider accepts one or more local images on the
initial prompt or on a later turn:

```bash
codex --image screenshot.png -- "Explain this error and propose the smallest fix"
codex --image before.png,after.png -- "Compare these screenshots"
```

PNG, JPEG, GIF, and WebP data URLs are accepted by the local Responses bridge.
Each image is uploaded through Notion's assistant-chat attachment endpoint and
inserted into the same Fable 5 or GPT-5.6 Sol inference transcript as the user
message. Repeated historical images are deduplicated, and a genuinely new image
is attached to the existing Notion thread instead of forcing a new dialog.

Limits are 10 unique images, 20 MiB per image, and 50 MiB total per request.
Text-only continuation requests do not decode or upload historical images.
