# v4 commands (build spec §4). Seats on the fleet Mac get Go and Bun from the v4-only
# toolchain prefix; CI installs them with setup-go and setup-bun.
export PATH := $(HOME)/.commonly/toolchains/v4/bin:$(PATH)

.PHONY: gen check-gen test test-ts test-go preflight

node_modules: package.json bun.lock
	bun install --frozen-lockfile
	@touch node_modules

# Regenerate every contract from schema/. Never hand-edit gen/ or protocol/gen.go.
gen: node_modules
	bun scripts/gen.mjs
	gofmt -w daemon/internal/protocol/gen.go

# Fails if schema/ changed without `make gen`, or gen/ was edited by hand.
check-gen: gen
	git diff --exit-code -- gen daemon/internal/protocol/gen.go
	@test -z "$$(git ls-files --others --exclude-standard gen daemon/internal/protocol)" || (echo "untracked generated files; commit them"; exit 1)

test-ts: node_modules
	bun scripts/check-fixtures.mjs
	bun run check:types

test-go:
	go vet ./...
	go test -race ./...

test: test-ts test-go

preflight: check-gen test
