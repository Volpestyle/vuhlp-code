from __future__ import annotations

import threading
from typing import Optional


class CanceledError(RuntimeError):
    pass


class CancelToken:
    def __init__(self) -> None:
        self._event = threading.Event()
        self._reason: Optional[Exception] = None

    def cancel(self, reason: Exception | str | None = None) -> None:
        if self._event.is_set():
            return
        if reason is None:
            reason = CanceledError("canceled")
        elif isinstance(reason, str):
            reason = CanceledError(reason)
        self._reason = reason
        self._event.set()

    def is_cancelled(self) -> bool:
        return self._event.is_set()

    def wait(self, timeout: float | None = None) -> bool:
        return self._event.wait(timeout)

    @property
    def reason(self) -> Optional[Exception]:
        return self._reason
