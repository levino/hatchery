.PHONY: build clean vet

BINDIR := bin

build: $(BINDIR)/hatchery $(BINDIR)/hatchery-creds

$(BINDIR)/hatchery: cmd/hatchery/main.go internal/**/*.go
	@mkdir -p $(BINDIR)
	go build -o $@ ./cmd/hatchery

$(BINDIR)/hatchery-creds: cmd/hatchery-creds/main.go internal/**/*.go
	@mkdir -p $(BINDIR)
	go build -o $@ ./cmd/hatchery-creds

vet:
	go vet ./...

clean:
	rm -rf $(BINDIR)
