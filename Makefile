SHELL := /bin/bash

BIN_DIR := ./bin
PYTHON := python

ifneq (,$(wildcard .venv/bin/python))
PYTHON := .venv/bin/python
endif

.PHONY: all build test fmt vet clean diagrams ui dev-dashboard dev-d

all: build

build:
	mkdir -p $(BIN_DIR)
	printf '%s\n' \
		'#!/usr/bin/env bash' \
		'set -euo pipefail' \
		'ROOT="$$(cd "$$(dirname "$${BASH_SOURCE[0]}")/.." && pwd)"' \
		'PYTHONPATH="$$ROOT" exec python3 -m cmd.agentd.main "$$@"' \
		> $(BIN_DIR)/agentd
	printf '%s\n' \
		'#!/usr/bin/env bash' \
		'set -euo pipefail' \
		'ROOT="$$(cd "$$(dirname "$${BASH_SOURCE[0]}")/.." && pwd)"' \
		'PYTHONPATH="$$ROOT" exec python3 -m cmd.agentctl.main "$$@"' \
		> $(BIN_DIR)/agentctl
	chmod +x $(BIN_DIR)/agentd $(BIN_DIR)/agentctl

test:
	$(PYTHON) -m pytest

fmt:
	$(PYTHON) -m ruff format .

vet:
	$(PYTHON) -m ruff check .

diagrams:
	./scripts/render-mermaid.sh
	./scripts/render-awsdac.sh

ui:
	cd ui && npm install && npm run build

dev-dashboard:
	./scripts/dev-dashboard.sh

dev-d: dev-dashboard

clean:
	rm -rf $(BIN_DIR)
