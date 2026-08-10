"""Chat-completions client for the explanation endpoint.

One client, two providers. Ollama (local, development) and Groq (hosted, demo)
both expose the OpenAI chat-completions wire format, so switching between them
is a base-URL and model-name change in the environment rather than a second
code path to keep in sync. Anything genuinely provider-specific would have to
live behind this interface, and so far nothing does.

Deliberately not using an official SDK. The surface actually needed here is one
POST returning one string; a vendor SDK would add a dependency whose version
policy and auth model differ per provider, which is precisely the coupling this
module exists to avoid.

Failures are typed (LLMError) rather than leaked as raw httpx exceptions, so the
route layer can map them onto HTTP status codes without knowing what transport
is underneath.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

log = logging.getLogger(__name__)


class LLMError(RuntimeError):
    """Any failure to obtain a completion.

    ``retryable`` distinguishes "the provider is busy or unreachable, trying
    again may work" from "this request is malformed or unauthorised, trying
    again will fail identically" -- the difference between a 503 and a 502 at
    the route layer, and between showing the user a retry control or not.
    """

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class LLMConfig:
    base_url: str
    model: str
    api_key: str
    timeout: float
    max_tokens: int
    temperature: float


class ChatClient:
    """Minimal OpenAI-compatible chat-completions client."""

    def __init__(self, config: LLMConfig, *, client: httpx.AsyncClient | None = None) -> None:
        self._config = config
        # An injected client is what makes this testable without a live
        # provider: tests pass an httpx.AsyncClient wired to a MockTransport.
        self._client = client or httpx.AsyncClient(timeout=config.timeout)
        self._owns_client = client is None

    @property
    def model(self) -> str:
        return self._config.model

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def complete(self, *, system: str, user: str) -> str:
        """Single-turn completion. Returns the assistant's message content."""
        url = f"{self._config.base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": self._config.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": self._config.max_tokens,
            "temperature": self._config.temperature,
            "stream": False,
        }

        try:
            response = await self._client.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {self._config.api_key}"},
                timeout=self._config.timeout,
            )
        except httpx.TimeoutException as exc:
            raise LLMError(
                f"the model did not respond within {self._config.timeout:.0f}s",
                retryable=True,
            ) from exc
        except httpx.RequestError as exc:
            # Ollama not running is by far the most common form of this during
            # development, so the message names it rather than surfacing a bare
            # connection error.
            raise LLMError(
                f"could not reach the model provider at {self._config.base_url} "
                f"({exc.__class__.__name__}). Is it running?",
                retryable=True,
            ) from exc

        if response.status_code == 429:
            raise LLMError("the model provider is rate limiting requests", retryable=True)
        if response.status_code in (401, 403):
            # Not retryable, and specifically flagged: on Groq this means the
            # key is wrong or missing, which is otherwise easy to misread as a
            # model or network problem.
            raise LLMError(
                "the model provider rejected the API key "
                f"(HTTP {response.status_code}). Check DP_LLM_API_KEY.",
            )
        if response.status_code >= 500:
            raise LLMError(
                f"the model provider returned HTTP {response.status_code}", retryable=True
            )
        if response.status_code != 200:
            raise LLMError(
                f"the model provider returned HTTP {response.status_code}: "
                f"{response.text[:200]}"
            )

        try:
            data = response.json()
            content = data["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            # A provider that answered 200 with a shape we don't recognise is a
            # configuration problem (wrong base URL pointing at some other
            # service), not a transient one.
            raise LLMError(
                "the model provider returned an unrecognised response shape; "
                f"check DP_LLM_BASE_URL points at an OpenAI-compatible endpoint ({exc})"
            ) from exc

        if not isinstance(content, str) or not content.strip():
            raise LLMError("the model returned an empty completion", retryable=True)

        return content.strip()


__all__ = ["ChatClient", "LLMConfig", "LLMError"]
