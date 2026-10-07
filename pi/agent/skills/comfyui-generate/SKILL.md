---
name: comfyui-generate
description: >
  Generate images through the comfy_gen.py CLI and a local or remote ComfyUI
  API. Covers FLUX.2 text-to-image and multi-reference generation, FLUX.1 LoRA
  compatibility, reference captioning and prompt expansion with Ollama, img2img,
  batch output, and generation replay. Use when image generation needs direct
  prompt control or local ComfyUI workflows.
---

# comfyui-generate — Image Generation via ComfyUI

`comfy_gen.py` is an agent-friendly CLI for generating images through a
ComfyUI API endpoint. It supports FLUX.2 text-to-image and multi-reference
workflows, FLUX.1 workflows with LoRAs, img2img, optional Ollama-assisted
reference descriptions and prompt expansion, multiple outputs, and replaying
saved generation records.

## When to use this skill

Load this skill when the agent needs to:

- Generate an image using a local or remote ComfyUI server
- Use one or more reference photos with FLUX.2
- Use a character configuration or FLUX.1 LoRA
- Transform an existing image with img2img
- Optionally caption reference photos or expand a scene brief using Ollama
- Generate several variations or replay a recorded run

## When NOT to use this skill

- When fal.ai or another hosted service is sufficient for the task
- When the ComfyUI endpoint is unavailable; use `--check-connection` to test it
- When video generation is needed; `comfy_gen.py` generates images only

## Script location

```text
C:\Users\iapet\code\own\comfyui-batch\comfy_gen.py
```

Run commands from the `comfyui-batch` directory so the script can import its
modules and find the bundled workflow and data files. The examples below use
that working directory.

## Quick start

```bash
# Check the ComfyUI endpoint
python comfy_gen.py --check-connection --host "$REMOTE_COMFYUI_HOST"

# Generate with FLUX.2 (the primary path)
python comfy_gen.py --model flux2-dev \
  -p "A turquoise vintage convertible on a sunny beach" \
  --host "$REMOTE_COMFYUI_HOST"

# Generate with several reference photos (repeat --ref; up to six are supported)
python comfy_gen.py --model flux2-dev \
  --ref references/jess/face.jpg \
  --ref references/jess/fullbody.jpg \
  -p "Jess beside a vintage convertible on a sunny beach" \
  --host "$REMOTE_COMFYUI_HOST" --seed 42

# Use a FLUX.1 LoRA with a chosen strength
python comfy_gen.py --model flux1-dev \
  -p "Jess in a cinematic studio portrait" \
  --host "$REMOTE_COMFYUI_HOST" --lora jess_v1.safetensors \
  --lora-strength 0.5 --seed 42

# Generate multiple variations; a supplied seed increments for each image
python comfy_gen.py -p "A portrait in soft window light" \
  --host "$REMOTE_COMFYUI_HOST" --count 4 --seed 42
```

`--model` accepts `flux2-dev` or `flux1-dev`. FLUX.2 is the primary default;
legacy configurations that supply character LoRAs may retain FLUX.1 behavior.
Specify `--model` when the workflow family matters. An explicit `--workflow`
selects a custom ComfyUI API-format workflow in place of model-based selection.

## Reference photos and Ollama

`--ref PATH` can be repeated to provide multiple reference photos. Explicit
references replace the reference list in the character configuration. The
bundled FLUX.2 reference workflow supports one to six photos, and their order
is preserved. References condition the generated image; they do not guarantee
exact likeness or measurements.

Reference photos can optionally be described by an Ollama vision model before
generation. This is useful when the captions should inform prompt expansion.
Inline captioning sends the reference images to the configured Ollama endpoint:

```bash
python comfy_gen.py --model flux2-dev --describe-references \
  --ref references/jess/face.jpg \
  --ref references/jess/fullbody.jpg \
  --expand-prompt --prompt-model llama3.2 \
  --preserve-detail "recognizable facial features" \
  -p "A studio portrait in a green silk dress, soft window light"
```

For repeated prompt experiments, create a local JSON description manifest once
and reuse it. The manifest records descriptions and image hashes, not image
bytes; supply the same image contents in the same order when reusing it.
Generation validates the ordered image hashes. `--describe-references` and
`--reference-descriptions` are mutually exclusive.

```bash
# Create the manifest
python scripts/describe_references.py \
  --ref references/jess/face.jpg \
  --ref references/jess/fullbody.jpg \
  --output references/jess/descriptions.json \
  --ollama-host 127.0.0.1:11434 --vision-model qwen2.5vl:7b

# Reuse it during generation and expand the scene brief
python comfy_gen.py --model flux2-dev \
  --ref references/jess/face.jpg \
  --ref references/jess/fullbody.jpg \
  --reference-descriptions references/jess/descriptions.json \
  --expand-prompt --prompt-model llama3.2 \
  --preserve-detail "long wavy blonde hair" \
  -p "A studio portrait in a green silk dress, soft window light"
```

Prompt expansion is opt-in. It uses Ollama to expand the scene brief; the
assembled prompt is printed before queueing, and the user's brief remains part
of the final prompt. `--preserve-detail TEXT` can be repeated to call out
subject details that should remain stable. Without inline descriptions or a
manifest, prompt expansion receives no reference captions. Ollama models are
not pulled automatically.

## Character configuration and LoRAs

`--character PATH` selects a character JSON file; a name resolves under
`data/characters/<name>.json`. The default character file is
`data/character.json`. Character configuration may provide references, LoRAs,
a LoRA trigger, and attributes. Use `--character-attributes` to inject
physical attributes into the prompt. Repeat `--attr KEY=VALUE` to override
configured values, for example:

```bash
python comfy_gen.py --model flux2-dev --character jess \
  --character-attributes --attr height="5'8" --attr hair_colour=blonde \
  -p "A portrait in a garden" --host "$REMOTE_COMFYUI_HOST"
```

For FLUX.1, `--lora FILE [FILE ...]` selects LoRA files and overrides the
character's configured LoRAs. `--lora-strength WEIGHT` sets their strength
(0.0–2.0; automatic by default). FLUX.2 uses reference photos rather than the
legacy character LoRA mechanism. Use `--list-loras` to see available LoRAs.

## Img2img

Pass `--input-image PATH` to transform an existing source image. When no
reference photos or explicit `--workflow` are supplied, the CLI selects the
bundled img2img workflow. An explicit `--workflow` takes precedence.
`--denoise` controls transformation strength from 0.0 (closest to the source)
to 1.0 (more transformation); the default is 0.5.

```bash
python comfy_gen.py \
  -p "Photorealistic version, natural lighting" \
  --host "$REMOTE_COMFYUI_HOST" \
  --input-image ./output/painted_portrait.png --denoise 0.5
```

## Run records and replay

Each generated image has a `.run.json` sidecar containing the final prompt,
seed, queued workflow, settings, and source-image paths and hashes. The record
contains paths and hashes rather than image bytes. Keep it with private output
data when appropriate. Replay reuses the saved workflow, prompt, seed, and
references; it checks that recorded source images have not changed before
contacting ComfyUI. Replay is an attempt to reproduce a run, not a guarantee of
bit-identical output.

```bash
python comfy_gen.py \
  --replay-record output/session/image.png.run.json \
  --host "$REMOTE_COMFYUI_HOST" --output-dir output/replay
```

`--replay-record` is a separate mode: do not combine it with generation
options such as `--prompt`, `--model`, `--ref`, `--seed`, `--count`, or
`--input-image`. The host, output directory, and polling interval can still be
set for replay.

## CLI reference

Run `python comfy_gen.py --help` for the live reference. All currently
available options are listed here.

```text
General:
  -h, --help                    Show help and exit
  -p, --prompt TEXT             Text prompt for image generation
  --replay-record PATH          Replay workflow, prompt, seed, and references

Connection and workflow:
  --host HOST                   ComfyUI host:port (or COMFYUI_HOST)
  --auth AUTH                   HTTP Basic auth user:pass
  --workflow PATH               Explicit ComfyUI API workflow
  --model {flux2-dev,flux1-dev} Select image model

References and Ollama:
  --ref PATH                    Reference photo; repeat for multiple photos
  --describe-references         Caption references inline with Ollama
  --reference-descriptions PATH Reuse a saved description manifest
  --ollama-host HOST            Ollama host:port
  --vision-model MODEL          Ollama vision model
  --expand-prompt               Expand the scene brief with Ollama
  --prompt-model MODEL          Ollama prompt-expansion model
  --preserve-detail TEXT        Preserve a subject detail; repeatable

Character and LoRA:
  --character PATH_OR_NAME      Character JSON path or configured name
  --character-attributes       Add configured physical attributes to prompt
  --attr KEY=VALUE              Override a character attribute; repeatable
  --lora FILE [FILE ...]        LoRA file(s), overriding character config
  --lora-strength WEIGHT        LoRA strength, from 0.0 to 2.0

Image generation:
  --input-image PATH            Source image for img2img
  --denoise VALUE               Img2img denoise strength, from 0.0 to 1.0
  --negative-prompt TEXT        Negative prompt
  --seed INT                    Reproducible seed
  --count COUNT                 Images to generate; default 1
  --width INT                   Image width
  --height INT                  Image height
  --filename-prefix TEXT        Output filename prefix
  --output-dir PATH             Output directory
  --poll-interval SECONDS       Seconds between ComfyUI status polls

Utilities:
  --list-loras                  List available LoRA files and exit
  --list-workflows              List available workflows and exit
  --check-connection            Test ComfyUI connectivity and exit
```

## Environment variables and defaults

| Variable | Default | Purpose |
|---|---|---|
| `COMFYUI_HOST` | `127.0.0.1:8188` | ComfyUI endpoint; overridden by `--host` |
| `COMFYUI_AUTH` | none | HTTP Basic auth; overridden by `--auth` |
| `COMFYUI_REQUEST_TIMEOUT` | `10` seconds | Per-request ComfyUI timeout |
| `COMFYUI_WORKFLOW_SOURCE` | bundled legacy workflow path | Optional workflow source for legacy no-model use |
| `OLLAMA_HOST` | `127.0.0.1:11434` | Ollama endpoint for vision and prompt expansion |
| `OLLAMA_VISION_MODEL` | `qwen2.5vl:7b` | Default reference-caption model |
| `OLLAMA_PROMPT_MODEL` | `OLLAMA_MODEL`, then `llama3.2` | Default prompt-expansion model |

The default output directory is the `output/` directory in the
`comfyui-batch` repository; set `--output-dir` to use a different location.
`COMFYUI_OUTPUT_DIR` is not a `comfy_gen.py` option/environment default.

## Prompt construction guidelines

When constructing a prompt:

1. Use a configured trigger word when the selected character/LoRA requires it.
2. Include relevant character attributes only when useful to the scene.
3. State the desired outfit, setting, pose, framing, lighting, and style clearly.
4. For references, describe the new scene and requested changes; do not assume
   the reference pose, clothing, or background should be copied.
5. Use `--preserve-detail` for important details when using prompt expansion.

## Limitations

- Image generation only; this CLI does not generate video.
- A reachable ComfyUI server and compatible models/workflows are required.
- Ollama captioning and prompt expansion are optional and require a reachable
  Ollama endpoint and installed models.
- Output consistency depends on the model, workflow, references, seed, and
  ComfyUI runtime; identity and replay results are not guaranteed.
