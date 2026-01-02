#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import uvicorn

from internal.agent.model_service import ModelService
from internal.agent.runner import Runner
from internal.agent.session_runner import SessionRunner
from internal.agent.specgen import SpecGenerator
from internal.api.server import Server
from internal.config import default_config, expand_config_home, load_from_file
from internal.config.settings import load_settings
from internal.runstore import Store
from internal.util.env import load_env_file


def main() -> None:
    parser = argparse.ArgumentParser(prog="agentd")
    parser.add_argument("--listen", default="", help="listen address host:port")
    parser.add_argument("--data-dir", default="", help="data directory")
    parser.add_argument("--auth-token", default="", help="auth token")
    parser.add_argument("--config", default="", help="config file")
    args = parser.parse_args()

    load_env_file(".env.local")
    load_env_file(".env")

    cfg = default_config()

    config_path = args.config or os.environ.get("HARNESS_CONFIG", "")
    if config_path:
        try:
            cfg = load_from_file(config_path)
        except Exception as err:
            print("failed to load config file", {"path": config_path, "err": err})

    if os.environ.get("HARNESS_LISTEN") and not cfg.listen_addr:
        cfg.listen_addr = os.environ.get("HARNESS_LISTEN", "")
    if os.environ.get("HARNESS_DATA_DIR") and not cfg.data_dir:
        cfg.data_dir = os.environ.get("HARNESS_DATA_DIR", "")
    if os.environ.get("HARNESS_AUTH_TOKEN") and not cfg.auth_token:
        cfg.auth_token = os.environ.get("HARNESS_AUTH_TOKEN", "")

    if args.listen:
        cfg.listen_addr = args.listen
    if args.data_dir:
        cfg.data_dir = args.data_dir
    if args.auth_token:
        cfg.auth_token = args.auth_token

    cfg = expand_config_home(cfg)

    settings_path = str(Path(cfg.data_dir) / "settings.json")
    try:
        settings, exists = load_settings(settings_path)
        if exists:
            cfg.model_policy = settings.model_policy
    except Exception as err:
        print("failed to load settings", {"path": settings_path, "err": err})

    store = Store(cfg.data_dir)
    store.init()

    kit = create_kit_from_env()
    router = create_model_router()

    runner = Runner(store, kit, cfg.model_policy, router)
    session_runner = SessionRunner(store, kit, cfg.model_policy, router)
    model_service = ModelService(kit, cfg.model_policy, settings_path, runner, session_runner)
    spec_gen = SpecGenerator(kit, cfg.model_policy, router)

    server = Server(store, cfg.auth_token, runner, session_runner, spec_gen, model_service)
    host, port = parse_listen_addr(cfg.listen_addr)

    print("agentd listening", {"addr": cfg.listen_addr, "data_dir": cfg.data_dir})
    if cfg.auth_token:
        print("auth enabled", {"mode": "bearer"})

    uvicorn.run(server.handler(), host=host, port=port, log_level="info")


def parse_listen_addr(addr: str) -> tuple[str, int]:
    trimmed = addr.strip() or "127.0.0.1:8787"
    if ":" in trimmed:
        host, port_raw = trimmed.split(":", 1)
    else:
        host, port_raw = trimmed, "8787"
    try:
        port = int(port_raw)
    except ValueError:
        port = 8787
    return host or "127.0.0.1", port


def parse_key_list(value: str) -> list[str]:
    parts = [item.strip() for item in value.replace(";", ",").replace("\n", " ").split(",")]
    out = []
    for part in parts:
        for sub in part.split():
            if sub:
                out.append(sub)
    return out


def create_kit_from_env():
    try:
        from ai_kit import Kit, KitConfig
        from ai_kit.providers import (
            AnthropicConfig,
            GeminiConfig,
            OllamaConfig,
            OpenAIConfig,
            XAIConfig,
        )
    except Exception as err:
        print("ai-kit is not installed", err)
        sys.exit(1)

    providers: dict[str, object] = {}

    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    openai_keys = parse_key_list(os.environ.get("OPENAI_API_KEYS", ""))
    if openai_key or openai_keys:
        providers["openai"] = OpenAIConfig(api_key=openai_key or "", api_keys=openai_keys or None)

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    anthropic_keys = parse_key_list(os.environ.get("ANTHROPIC_API_KEYS", ""))
    if anthropic_key or anthropic_keys:
        providers["anthropic"] = AnthropicConfig(api_key=anthropic_key or "", api_keys=anthropic_keys or None)

    xai_key = os.environ.get("XAI_API_KEY", "").strip()
    xai_keys = parse_key_list(os.environ.get("XAI_API_KEYS", ""))
    if xai_key or xai_keys:
        providers["xai"] = XAIConfig(api_key=xai_key or "", api_keys=xai_keys or None)

    google_key = os.environ.get("GOOGLE_API_KEY", "").strip()
    google_keys = parse_key_list(os.environ.get("GOOGLE_API_KEYS", ""))
    if google_key or google_keys:
        providers["google"] = GeminiConfig(api_key=google_key or "", api_keys=google_keys or None)

    ollama_base = os.environ.get("OLLAMA_BASE_URL", "").strip()
    ollama_key = os.environ.get("OLLAMA_API_KEY", "").strip()
    if ollama_base or ollama_key:
        providers["ollama"] = OllamaConfig(base_url=ollama_base or "", api_key=ollama_key or "")

    if not providers:
        if not ollama_base:
            ollama_base = "http://localhost:11434"
        providers["ollama"] = OllamaConfig(base_url=ollama_base)
        print("ai-kit: no provider keys configured; defaulting to Ollama", {"base_url": ollama_base})

    return Kit(KitConfig(providers=providers, registry_ttl_seconds=15 * 60))


def create_model_router():
    try:
        from ai_kit import ModelRouter
    except Exception as err:
        print("ai-kit ModelRouter unavailable", err)
        sys.exit(1)
    return ModelRouter()


if __name__ == "__main__":
    main()
