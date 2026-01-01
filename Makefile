SHELL := /bin/bash

BIN_DIR := ./bin

.PHONY: all build test fmt vet lint clean diagrams ui dev-dashboard dev-d

all: build

build:
	mkdir -p $(BIN_DIR)
	bun run build

test:
	bun test

fmt:
	bun run fmt

vet:
	bun run lint

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
