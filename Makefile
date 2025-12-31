SHELL := /bin/bash

BIN_DIR := ./bin

.PHONY: all build test fmt vet clean diagrams ui dev-dashboard dev-d

all: build

build:
	mkdir -p $(BIN_DIR)
	go build -o $(BIN_DIR)/agentd ./cmd/agentd
	go build -o $(BIN_DIR)/agentctl ./cmd/agentctl

test:
	go test ./...

fmt:
	gofmt -w .

vet:
	go vet ./...

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
