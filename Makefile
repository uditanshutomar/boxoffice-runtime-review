# Use KUBE_CONTEXT explicitly when deploying. No target switches your context.
SHELL := /bin/bash
# macOS ships make 3.81, which ignores .SHELLFLAGS; set flags in each recipe.
SERVICES := storefront inventory pricing
REGISTRY ?= signadot
TAG ?= baseline
LOAD ?= minikube image load
KUBE_CONTEXT ?= minikube
KUBECTL := kubectl --context $(KUBE_CONTEXT)

.PHONY: images deploy lesson clean test
images:
	@set -euo pipefail; for s in $(SERVICES); do \
	  docker build -t "$(REGISTRY)/boxoffice-demo-$$s:$(TAG)" -f "docker/$$s.Dockerfile" .; \
	  $(LOAD) "$(REGISTRY)/boxoffice-demo-$$s:$(TAG)"; \
	done

deploy:
	$(KUBECTL) apply -f k8s/namespace.yaml
	set -euo pipefail; $(KUBECTL) -n boxoffice create configmap boxoffice-db-init \
	  --from-file=01-schema.sql=db/schema.sql --from-file=02-seed.sql=db/seed.sql \
	  --dry-run=client -o yaml | $(KUBECTL) apply -f -
	@set -euo pipefail; for f in k8s/*.yaml; do \
	  sed -e 's|image: signadot/boxoffice-demo-|image: $(REGISTRY)/boxoffice-demo-|' \
	      -e 's|:baseline$$|:$(TAG)|' "$$f"; printf '\n---\n'; \
	done | $(KUBECTL) apply -f -
	@set -euo pipefail; for s in postgres redis $(SERVICES); do \
	  $(KUBECTL) -n boxoffice rollout status "deploy/$$s" --timeout=180s; \
	done

lesson:
	@set -euo pipefail; case "$(LESSON)" in \
	  swallow-errors|safe-refactor) svc=storefront ;; \
	  drop-fees) svc=pricing ;; \
	  *) echo 'LESSON must be swallow-errors, safe-refactor or drop-fees' >&2; exit 1 ;; \
	esac; \
	tmp=$$(mktemp -d); trap 'rm -rf "$$tmp"' EXIT; \
	mkdir -p "$$tmp/pkg/$$svc" "$$tmp/docker"; \
	cp "pkg/$$svc/package.json" "pkg/$$svc/package-lock.json" "$$tmp/pkg/$$svc/"; \
	cp "docker/$$svc.Dockerfile" "$$tmp/docker/"; \
	cp "lessons/$(LESSON)/$$svc/app.js" "$$tmp/pkg/$$svc/app.js"; \
	docker build -t "$(REGISTRY)/boxoffice-demo-$$svc:$(LESSON)" -f "$$tmp/docker/$$svc.Dockerfile" "$$tmp"; \
	$(LOAD) "$(REGISTRY)/boxoffice-demo-$$svc:$(LESSON)"

test:
	./scripts/test-local.sh

clean:
	$(KUBECTL) delete namespace boxoffice --ignore-not-found
