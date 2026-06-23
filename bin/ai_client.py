"""
ai_client - shared AI invocation library for scripted (non-chat) prompts.

Talks to opencode zen's OpenAI-compatible chat-completions endpoint.

Two invocation modes:
  run_prompt()      - single request, plain text response. No tools.
  run_with_tools()  - multi-turn round trip using the OpenAI "tools"
                      (function-calling) param. The caller supplies a
                      tool schema list and an executor; this function
                      loops sending the executor's results back to the
                      model until it returns a plain text answer with no
                      further tool calls. No turn limit - a model doing
                      real exploration (reading several files, searching,
                      writing several outputs) can legitimately need many
                      turns; the pseudo-tools (ask_user_prompt,
                      run_command) are the actual stuck/wrong-direction
                      signals to watch for, not turn count.

Auth: the API key is read from ~/.secrets/opencode-key (same convention
as fetch_ticket.py's Linear key), falling back to $OPENCODE_ZEN_API_KEY
if that file doesn't exist.

Model selection is a parameter to these functions, not an env var -
callers decide which model to request per call.
"""

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


class AIError(RuntimeError):
    """Raised for any invocation failure. Let it propagate to die()."""


@dataclass
class AIResult:
    text: str


BASE_URL = os.environ.get("OPENCODE_ZEN_BASE_URL", "https://opencode.ai/zen/v1")
API_KEY_FILE = Path.home() / ".secrets" / "opencode-key"
API_KEY_ENV = "OPENCODE_ZEN_API_KEY"
DEFAULT_MODEL = "default"

# urllib's default User-Agent ("Python-urllib/3.x") trips Cloudflare's
# bot-fingerprint check (error 1010) on some endpoints - a normal-looking
# UA avoids that.
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


def _load_api_key() -> str:
    if API_KEY_FILE.exists():
        return API_KEY_FILE.read_text().strip()
    api_key = os.environ.get(API_KEY_ENV)
    if not api_key:
        raise AIError(f"No key at {API_KEY_FILE} and ${API_KEY_ENV} is not set.")
    return api_key


def _post_chat_completion(payload: dict, label: str) -> dict:
    api_key = _load_api_key()
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": _USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise AIError(f"{label} request failed: HTTP {e.code}: {e.read().decode()}") from e
    except urllib.error.URLError as e:
        raise AIError(f"{label} request failed: {e.reason}") from e


def run_prompt(prompt: str, label: str, model: str = DEFAULT_MODEL) -> AIResult:
    """Send `prompt` to opencode zen using `model`. Raises AIError on failure."""
    print(f"\n-- Running '{label}' via {BASE_URL} (model={model}) ...", flush=True)
    parsed = _post_chat_completion(
        {"model": model, "messages": [{"role": "user", "content": prompt}]}, label
    )
    try:
        text = parsed["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as e:
        raise AIError(f"{label}: unexpected response shape: {parsed}") from e
    return AIResult(text=text)


def _default_summarize_call(name: str, args: dict) -> str:
    return f"{name}({args})"


def run_with_tools(
    prompt: str,
    tools: list[dict],
    executor: Callable[[str, dict], str],
    label: str,
    model: str = DEFAULT_MODEL,
    summarize_call: Callable[[str, dict], str] = _default_summarize_call,
) -> AIResult:
    """
    Send `prompt` to opencode zen with `tools` available. Whenever the
    model's response includes tool_calls, run each through `executor`
    (signature: executor(tool_name, arguments_dict) -> str) and feed the
    result back as a tool message, then send another request - repeating
    until a response comes back with no tool_calls, which is treated as
    the final answer.

    `summarize_call` turns (name, args) into the one-line console log
    shown for each call - defaults to the raw name(args) form, but
    callers using tools.py should pass tools.summarize_tool_call so the
    log reads "Read foo.rs" instead of "read_file({'path': 'foo.rs'})".

    No turn cap: this is turn-taking inherent to function-calling, not a
    retry loop - each turn is the model reacting to real tool output, not
    the same request repeated hoping for a different answer, so there's
    no fixed budget that's "enough." If a model is well and truly stuck,
    the ask_user_prompt/run_command pseudo-tools (see tools.py) are the
    actual signal to watch for - they raise immediately rather than
    relying on a turn count to eventually notice something's wrong.
    """
    messages = [{"role": "user", "content": prompt}]
    turn = 0

    while True:
        turn += 1
        print(f"\n-- Running '{label}' via {BASE_URL} (model={model}, turn {turn}) ...", flush=True)
        parsed = _post_chat_completion(
            {"model": model, "messages": messages, "tools": tools}, label
        )
        try:
            message = parsed["choices"][0]["message"]
        except (KeyError, IndexError) as e:
            raise AIError(f"{label}: unexpected response shape: {parsed}") from e

        messages.append(message)
        tool_calls = message.get("tool_calls")
        if not tool_calls:
            return AIResult(text=message.get("content") or "")

        for call in tool_calls:
            function = call.get("function", {})
            name = function.get("name", "")
            try:
                args = json.loads(function.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            print(f"   {summarize_call(name, args)}", flush=True)
            result_text = executor(name, args)
            messages.append({
                "role": "tool",
                "tool_call_id": call.get("id", ""),
                "content": result_text,
            })
