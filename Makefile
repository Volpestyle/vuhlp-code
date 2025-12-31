SHELL := /bin/bash

BIN_DIR := ./bin

.PHONY: all build test fmt vet clean diagrams

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

clean:
	rm -rf $(BIN_DIR)
