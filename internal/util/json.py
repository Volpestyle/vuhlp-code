from __future__ import annotations

from fastapi.responses import JSONResponse


def json_response(value: object, status: int = 200) -> JSONResponse:
    return JSONResponse(content=value, status_code=status)


def error_response(message: str, status: int = 400) -> JSONResponse:
    return json_response({"error": message}, status)
