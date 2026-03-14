from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, Iterator, List

import requests
from flask import Flask, Response, jsonify, render_template, request, stream_with_context

app = Flask(__name__)

DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434"
DEFAULT_OLLAMA_MODEL = "llama3.1"
DEFAULT_API_BASE_URL = "https://api.openai.com/v1"
DEFAULT_API_MODEL = "gpt-4o-mini"
SETTINGS_FILE = Path(app.root_path) / ".story_writer_settings.json"


def default_settings() -> Dict[str, str]:
    return {
        "provider": "ollama",
        "ollamaEndpoint": DEFAULT_OLLAMA_ENDPOINT,
        "ollamaModel": DEFAULT_OLLAMA_MODEL,
        "apiBaseUrl": DEFAULT_API_BASE_URL,
        "apiModel": DEFAULT_API_MODEL,
        "apiKey": "",
    }


def normalize_settings_payload(raw: Any) -> Dict[str, str]:
    defaults = default_settings()
    source = raw if isinstance(raw, dict) else {}

    provider = str(source.get("provider") or defaults["provider"]).strip().lower()
    if provider not in {"ollama", "openai_compatible"}:
        provider = defaults["provider"]

    return {
        "provider": provider,
        "ollamaEndpoint": str(source.get("ollamaEndpoint") or defaults["ollamaEndpoint"]).strip(),
        "ollamaModel": str(source.get("ollamaModel") or defaults["ollamaModel"]).strip(),
        "apiBaseUrl": str(source.get("apiBaseUrl") or defaults["apiBaseUrl"]).strip(),
        "apiModel": str(source.get("apiModel") or defaults["apiModel"]).strip(),
        "apiKey": str(source.get("apiKey") or "").strip(),
    }


def load_persisted_settings() -> Dict[str, str]:
    defaults = default_settings()
    try:
        raw = SETTINGS_FILE.read_text(encoding="utf-8")
    except FileNotFoundError:
        return defaults
    except OSError:
        return defaults

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return defaults

    return normalize_settings_payload({**defaults, **(parsed if isinstance(parsed, dict) else {})})


def save_persisted_settings(settings: Dict[str, str]) -> None:
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    try:
        SETTINGS_FILE.chmod(0o600)
    except OSError:
        pass


def resolve_settings(raw: Any) -> Dict[str, str]:
    persisted = load_persisted_settings()
    if not isinstance(raw, dict):
        return persisted

    resolved = normalize_settings_payload({**persisted, **raw})
    if not resolved.get("apiKey"):
        resolved["apiKey"] = persisted.get("apiKey", "")
    return resolved


def split_sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p.strip() for p in parts if p.strip()]


def split_paragraphs(text: str) -> List[str]:
    text = text.strip()
    if not text:
        return []

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n+", text) if p.strip()]
    if len(paragraphs) > 1:
        return paragraphs

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) > 1:
        return lines

    return paragraphs


def force_paragraph_count(paragraphs: List[str], count: int) -> List[str]:
    if count <= 0:
        return paragraphs

    while len(paragraphs) > count:
        head = paragraphs[: count - 1]
        tail = " ".join(paragraphs[count - 1 :]).strip()
        paragraphs = head + ([tail] if tail else [])

    while len(paragraphs) < count:
        candidates = [i for i, p in enumerate(paragraphs) if len(split_sentences(p)) >= 2]
        if not candidates:
            break
        idx = max(candidates, key=lambda i: len(paragraphs[i]))
        sentences = split_sentences(paragraphs[idx])
        midpoint = len(sentences) // 2
        left = " ".join(sentences[:midpoint]).strip()
        right = " ".join(sentences[midpoint:]).strip()
        new_parts = [p for p in [left, right] if p]
        if len(new_parts) < 2:
            break
        paragraphs = paragraphs[:idx] + new_parts + paragraphs[idx + 1 :]

    return paragraphs


def normalize_story_part(text: str, paragraph_limit: int) -> List[str]:
    paragraphs = split_paragraphs(text)
    paragraphs = force_paragraph_count(paragraphs, paragraph_limit)
    return [p for p in paragraphs if p.strip()]


def build_story_part_messages(
    story_overview: str, story_so_far: str, what_happens_next: str, story_arc_instruction: str, paragraph_limit: int
) -> List[Dict[str, str]]:
    system_prompt = (
        "You are a creative fiction writer. Produce story prose only, with no markdown, no headings, "
        "and no explanations."
    )
    user_prompt = f"""
Story overview:
{story_overview.strip() if story_overview.strip() else "(Not provided.)"}

Story so far:
{story_so_far.strip() if story_so_far.strip() else "(No previous parts yet.)"}

How the next part should unfold:
{what_happens_next.strip()}

Story arc instruction:
{story_arc_instruction.strip() if story_arc_instruction.strip() else "(Not provided.)"}

Write the next story part in exactly {paragraph_limit} paragraphs.
Each paragraph should be meaningful and continue naturally from the prior story.
Do not include labels like "Paragraph 1" or "Part 2".
""".strip()
    return [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}]


def call_ollama_chat(endpoint: str, model: str, messages: List[Dict[str, str]], timeout: int = 120) -> str:
    url = endpoint.rstrip("/") + "/api/chat"
    response = requests.post(
        url,
        json={"model": model, "messages": messages, "stream": False},
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    return payload.get("message", {}).get("content", "").strip()


def resolve_chat_completions_url(base_url: str) -> str:
    cleaned = base_url.rstrip("/")
    if cleaned.endswith("/chat/completions"):
        return cleaned
    if cleaned.endswith("/v1"):
        return cleaned + "/chat/completions"
    return cleaned + "/v1/chat/completions"


def call_openai_compatible_chat(
    base_url: str, model: str, api_key: str, messages: List[Dict[str, str]], timeout: int = 120
) -> str:
    url = resolve_chat_completions_url(base_url)
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    response = requests.post(
        url,
        headers=headers,
        json={"model": model, "messages": messages},
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    choices = payload.get("choices") or []
    if not choices:
        return ""
    return (choices[0].get("message", {}) or {}).get("content", "").strip()


def iter_ollama_chat_chunks(
    endpoint: str, model: str, messages: List[Dict[str, str]], timeout: int = 300
) -> Iterator[str]:
    url = endpoint.rstrip("/") + "/api/chat"
    with requests.post(
        url,
        json={"model": model, "messages": messages, "stream": True},
        timeout=timeout,
        stream=True,
    ) as response:
        response.raise_for_status()
        for line in response.iter_lines(decode_unicode=True):
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue

            piece = (payload.get("message") or {}).get("content") or ""
            if piece:
                yield str(piece)


def iter_openai_compatible_chat_chunks(
    base_url: str, model: str, api_key: str, messages: List[Dict[str, str]], timeout: int = 300
) -> Iterator[str]:
    url = resolve_chat_completions_url(base_url)
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    with requests.post(
        url,
        headers=headers,
        json={"model": model, "messages": messages, "stream": True},
        timeout=timeout,
        stream=True,
    ) as response:
        response.raise_for_status()
        for raw_line in response.iter_lines(decode_unicode=True):
            if not raw_line:
                continue
            line = raw_line.strip()
            if not line.startswith("data:"):
                continue

            payload_text = line[5:].strip()
            if payload_text == "[DONE]":
                break

            try:
                payload = json.loads(payload_text)
            except json.JSONDecodeError:
                continue

            choices = payload.get("choices") or []
            if not choices:
                continue

            delta = choices[0].get("delta") or {}
            content = delta.get("content")
            if isinstance(content, str):
                if content:
                    yield content
                continue

            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        text = part.get("text") or ""
                        if text:
                            yield str(text)


def call_chat_model(settings: Dict[str, Any], messages: List[Dict[str, str]]) -> str:
    provider = str(settings.get("provider") or "ollama").strip().lower()

    if provider == "openai_compatible":
        base_url = str(settings.get("apiBaseUrl") or DEFAULT_API_BASE_URL).strip()
        model = str(settings.get("apiModel") or DEFAULT_API_MODEL).strip()
        api_key = str(settings.get("apiKey") or "").strip()
        return call_openai_compatible_chat(base_url, model, api_key, messages)

    endpoint = str(settings.get("ollamaEndpoint") or DEFAULT_OLLAMA_ENDPOINT).strip()
    model = str(settings.get("ollamaModel") or DEFAULT_OLLAMA_MODEL).strip()
    return call_ollama_chat(endpoint, model, messages)


def iter_chat_model_chunks(settings: Dict[str, Any], messages: List[Dict[str, str]]) -> Iterator[str]:
    provider = str(settings.get("provider") or "ollama").strip().lower()

    if provider == "openai_compatible":
        base_url = str(settings.get("apiBaseUrl") or DEFAULT_API_BASE_URL).strip()
        model = str(settings.get("apiModel") or DEFAULT_API_MODEL).strip()
        api_key = str(settings.get("apiKey") or "").strip()
        yield from iter_openai_compatible_chat_chunks(base_url, model, api_key, messages)
        return

    endpoint = str(settings.get("ollamaEndpoint") or DEFAULT_OLLAMA_ENDPOINT).strip()
    model = str(settings.get("ollamaModel") or DEFAULT_OLLAMA_MODEL).strip()
    yield from iter_ollama_chat_chunks(endpoint, model, messages)


def sse_event(event: str, payload: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload)}\n\n"


def normalize_single_line(text: str) -> str:
    cleaned = " ".join(text.strip().splitlines()).strip()
    return cleaned.strip("\"' ").strip()


def generate_title(settings: Dict[str, Any], story_overview: str, story_so_far: str, what_happens_next: str) -> str:
    system_prompt = "You are a fiction writing assistant. Return only the requested output with no labels."
    user_prompt = f"""
Create one compelling title for this story.

Story overview:
{story_overview.strip() if story_overview.strip() else "(Not provided.)"}

Story so far:
{story_so_far.strip() if story_so_far.strip() else "(Not provided.)"}

What happens next:
{what_happens_next.strip() if what_happens_next.strip() else "(Not provided.)"}

Requirements:
- Return only one title.
- Keep it concise (2 to 8 words).
- Do not add quotes, bullets, numbering, or explanations.
""".strip()

    messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}]
    return normalize_single_line(call_chat_model(settings, messages))


def generate_story_arc_instruction(
    settings: Dict[str, Any], story_overview: str, story_so_far: str, what_happens_next: str
) -> str:
    system_prompt = "You are a fiction writing assistant. Return only the requested output with no labels."
    user_prompt = f"""
Create one story arc instruction to guide future parts of this story.

Story overview:
{story_overview.strip() if story_overview.strip() else "(Not provided.)"}

Story so far:
{story_so_far.strip() if story_so_far.strip() else "(Not provided.)"}

What happens next:
{what_happens_next.strip() if what_happens_next.strip() else "(Not provided.)"}

Requirements:
- Return only the instruction text.
- Use 1 to 2 sentences.
- Keep it actionable and focused on long-term character and plot progression.
- Do not add headings, bullets, or explanations.
""".strip()

    messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}]
    return call_chat_model(settings, messages).strip()


def generate_story_part(
    settings: Dict[str, Any],
    story_overview: str,
    story_so_far: str,
    what_happens_next: str,
    story_arc_instruction: str,
    paragraph_limit: int,
) -> List[str]:
    messages = build_story_part_messages(
        story_overview=story_overview,
        story_so_far=story_so_far,
        what_happens_next=what_happens_next,
        story_arc_instruction=story_arc_instruction,
        paragraph_limit=paragraph_limit,
    )
    first_output = call_chat_model(settings, messages)
    paragraphs = split_paragraphs(first_output)

    if len(paragraphs) != paragraph_limit:
        system_prompt = (
            "You are a creative fiction writer. Produce story prose only, with no markdown, no headings, "
            "and no explanations."
        )
        repair_prompt = f"""
Rewrite the following text into exactly {paragraph_limit} paragraphs while preserving the same events, tone, and details.
Return only the rewritten story text.

Text to rewrite:
{first_output}
""".strip()
        repair_messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": repair_prompt},
        ]
        repaired = call_chat_model(settings, repair_messages)
        paragraphs = split_paragraphs(repaired)

    paragraphs = force_paragraph_count(paragraphs, paragraph_limit)
    return [p for p in paragraphs if p.strip()]


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/settings")
def settings():
    return render_template("settings.html")


@app.get("/api/settings")
def api_get_settings():
    return jsonify(load_persisted_settings())


@app.post("/api/settings")
def api_save_settings():
    data = request.get_json(silent=True) or {}
    settings = normalize_settings_payload(data)

    if settings["provider"] == "ollama":
        if not settings["ollamaEndpoint"] or not settings["ollamaModel"]:
            return jsonify({"error": "Ollama endpoint and model are required."}), 400
    else:
        if not settings["apiBaseUrl"] or not settings["apiModel"]:
            return jsonify({"error": "API base URL and model are required."}), 400

    try:
        save_persisted_settings(settings)
    except OSError as exc:
        return jsonify({"error": f"Failed to save settings: {exc}"}), 500

    return jsonify({"settings": settings})


@app.post("/api/generate-part")
def api_generate_part():
    data = request.get_json(silent=True) or {}

    story_overview = (data.get("storyOverview") or "").strip()
    story_so_far = (data.get("storySoFar") or "").strip()
    what_happens_next = (data.get("whatHappensNext") or "").strip()
    story_arc_instruction = (data.get("storyArcInstruction") or "").strip()
    settings = resolve_settings(data.get("settings"))

    try:
        paragraph_limit = int(data.get("paragraphLimit", 2))
    except (TypeError, ValueError):
        paragraph_limit = 2

    if not what_happens_next:
        return jsonify({"error": "Description for how the next part unfolds is required."}), 400
    if paragraph_limit < 1:
        return jsonify({"error": "Paragraph limit must be at least 1."}), 400

    try:
        paragraphs = generate_story_part(
            settings=settings,
            story_overview=story_overview,
            story_so_far=story_so_far,
            what_happens_next=what_happens_next,
            story_arc_instruction=story_arc_instruction,
            paragraph_limit=paragraph_limit,
        )
    except requests.exceptions.RequestException as exc:
        return jsonify({"error": f"Could not reach selected model API: {exc}"}), 502
    except Exception as exc:
        return jsonify({"error": f"Failed to generate story part: {exc}"}), 500

    if not paragraphs:
        return jsonify({"error": "The model returned empty content. Try again."}), 500

    return jsonify({"paragraphs": paragraphs})


@app.post("/api/generate-part-stream")
def api_generate_part_stream():
    data = request.get_json(silent=True) or {}

    story_overview = (data.get("storyOverview") or "").strip()
    story_so_far = (data.get("storySoFar") or "").strip()
    what_happens_next = (data.get("whatHappensNext") or "").strip()
    story_arc_instruction = (data.get("storyArcInstruction") or "").strip()
    settings = resolve_settings(data.get("settings"))

    try:
        paragraph_limit = int(data.get("paragraphLimit", 2))
    except (TypeError, ValueError):
        paragraph_limit = 2

    if not what_happens_next:
        return jsonify({"error": "Description for how the next part unfolds is required."}), 400
    if paragraph_limit < 1:
        return jsonify({"error": "Paragraph limit must be at least 1."}), 400

    messages = build_story_part_messages(
        story_overview=story_overview,
        story_so_far=story_so_far,
        what_happens_next=what_happens_next,
        story_arc_instruction=story_arc_instruction,
        paragraph_limit=paragraph_limit,
    )

    @stream_with_context
    def generate() -> Iterator[str]:
        chunks: List[str] = []
        try:
            for piece in iter_chat_model_chunks(settings=settings, messages=messages):
                if not piece:
                    continue
                chunks.append(piece)
                yield sse_event("chunk", {"text": piece})

            full_text = "".join(chunks).strip()
            paragraphs = normalize_story_part(full_text, paragraph_limit)
            part_text = "\n\n".join(paragraphs).strip()

            if not part_text and full_text:
                part_text = full_text

            if not part_text:
                yield sse_event("error", {"error": "The model returned empty content. Try again."})
                return

            yield sse_event("done", {"partText": part_text, "paragraphs": paragraphs})
        except requests.exceptions.RequestException as exc:
            yield sse_event("error", {"error": f"Could not reach selected model API: {exc}"})
        except Exception as exc:
            yield sse_event("error", {"error": f"Failed to stream story part: {exc}"})

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return Response(generate(), mimetype="text/event-stream", headers=headers)


@app.post("/api/generate-metadata")
def api_generate_metadata():
    data = request.get_json(silent=True) or {}
    field = str(data.get("field") or "").strip()

    story_overview = (data.get("storyOverview") or "").strip()
    story_so_far = (data.get("storySoFar") or "").strip()
    what_happens_next = (data.get("whatHappensNext") or "").strip()
    settings = resolve_settings(data.get("settings"))

    if field not in {"title", "storyArcInstruction"}:
        return jsonify({"error": "Field must be title or storyArcInstruction."}), 400
    if not (story_overview or story_so_far or what_happens_next):
        return jsonify({"error": "Provide storyOverview, storySoFar, or whatHappensNext first."}), 400

    try:
        if field == "title":
            value = generate_title(settings, story_overview, story_so_far, what_happens_next)
        else:
            value = generate_story_arc_instruction(settings, story_overview, story_so_far, what_happens_next)
    except requests.exceptions.RequestException as exc:
        return jsonify({"error": f"Could not reach selected model API: {exc}"}), 502
    except Exception as exc:
        return jsonify({"error": f"Failed to generate {field}: {exc}"}), 500

    if not value:
        return jsonify({"error": "Model returned empty content. Try again."}), 500

    return jsonify({"value": value})


if __name__ == "__main__":
    app.run(debug=True)
