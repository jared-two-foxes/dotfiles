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

Token usage: every response's "usage" field (prompt_tokens,
completion_tokens) is accumulated per-model into the module-level
`usage` UsageTracker instance for the lifetime of the process. Callers
print `ai_client.usage` whenever they want a running or final total,
including an estimated $ cost if the model's rate is in
bin/model-pricing.toml - models with no entry there show token counts
with no fabricated cost.
"""

import json
import os
import tomllib
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


class AIError(RuntimeError):
    """Raised for any invocation failure. Let it propagate to die()."""


@dataclass
class AIResult:
    text: str


@dataclass
class ModelUsage:
    """Prompt/completion token total for a single model id."""
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def add(self, usage: dict) -> None:
        self.prompt_tokens += usage.get("prompt_tokens", 0) or 0
        self.completion_tokens += usage.get("completion_tokens", 0) or 0


@dataclass
class UsageTracker:
    """
    Running per-model token totals for the lifetime of the process -
    accumulated across every request a script makes (each
    run_with_tools turn is its own request, since the full message
    history is resent every turn), not per-call. Read via
    ai_client.usage from the calling script to report a final total.

    Tracked per model (not just one running total) because a single
    script run could in principle call more than one model, and
    pricing is looked up per model id.
    """
    by_model: dict[str, ModelUsage] = field(default_factory=dict)

    def add(self, model: str, response_usage: dict) -> None:
        self.by_model.setdefault(model, ModelUsage()).add(response_usage)

    @property
    def total_tokens(self) -> int:
        return sum(m.total_tokens for m in self.by_model.values())

    @property
    def prompt_tokens(self) -> int:
        return sum(m.prompt_tokens for m in self.by_model.values())

    @property
    def completion_tokens(self) -> int:
        return sum(m.completion_tokens for m in self.by_model.values())

    def total_cost_usd(self) -> tuple[float, list[str]]:
        """
        Returns (known_cost_so_far, [model ids with no pricing entry]).
        known_cost_so_far only sums models that have a pricing entry -
        it is a lower bound, not a total, whenever the second element
        is non-empty.
        """
        pricing = load_pricing()
        total = 0.0
        unpriced: list[str] = []
        for model, model_usage in self.by_model.items():
            rate = pricing.get(model)
            if rate is None:
                unpriced.append(model)
                continue
            total += (model_usage.prompt_tokens / 1_000_000) * rate["input_per_1m"]
            total += (model_usage.completion_tokens / 1_000_000) * rate["output_per_1m"]
        return total, unpriced

    def __str__(self) -> str:
        base = (
            f"{self.total_tokens} tokens total "
            f"({self.prompt_tokens} in / {self.completion_tokens} out)"
        )
        if not self.by_model:
            return base
        cost, unpriced = self.total_cost_usd()
        if not unpriced:
            return f"{base}, ~${cost:.4f}"
        if cost:
            return f"{base}, ~${cost:.4f}+ (no pricing for: {', '.join(unpriced)})"
        return f"{base}, cost unknown (no pricing for: {', '.join(unpriced)})"


# Process-lifetime accumulator. _post_chat_completion updates this on
# every response that includes a "usage" field; callers read it back
# (e.g. `print(ai_client.usage)`) whenever they want a running or final
# total - there's no per-call return value to thread through every
# run_prompt/run_with_tools call site for this.
usage = UsageTracker()

PRICING_FILE = Path(__file__).resolve().parent / "model-pricing.toml"
_pricing_cache: dict | None = None


def load_pricing() -> dict:
    """
    Loads bin/model-pricing.toml: a [models."<model id>"] table per
    model with input_per_1m / output_per_1m USD rates. Missing file or
    missing model entries are not errors - cost just can't be computed
    for that model, which UsageTracker reports explicitly rather than
    guessing. Cached after first load since the file doesn't change
    mid-run.
    """
    global _pricing_cache
    if _pricing_cache is not None:
        return _pricing_cache
    if not PRICING_FILE.exists():
        _pricing_cache = {}
        return _pricing_cache
    with PRICING_FILE.open("rb") as f:
        data = tomllib.load(f)
    _pricing_cache = data.get("models", {})
    return _pricing_cache


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
            parsed = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise AIError(f"{label} request failed: HTTP {e.code}: {e.read().decode()}") from e
    except urllib.error.URLError as e:
        raise AIError(f"{label} request failed: {e.reason}") from e

    response_usage = parsed.get("usage")
    if response_usage:
        usage.add(payload["model"], response_usage)
    return parsed


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
