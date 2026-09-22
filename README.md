# Boxoffice

Boxoffice is a small seat-hold application for tutorials about agentic development and runtime
verification. Each lesson changes one service while the remaining services run on the baseline.

| Service | Responsibility | Dependency |
| --- | --- | --- |
| storefront | Validate a request, acquire a hold, return a quote | inventory, pricing |
| inventory | Own seats, enforce idempotency, expire holds | PostgreSQL |
| pricing | Calculate integer minor-unit amounts and cache quotes | Redis |

## Run the application

Use a disposable Kubernetes cluster with the
[Signadot Operator](https://www.signadot.com/docs/installation/signadot-operator) and DevMesh,
Docker, `kubectl`, `make`, and the Signadot CLI. For a running minikube profile named `minikube`:

```bash
make images
make deploy KUBE_CONTEXT=minikube
kubectl --context minikube -n boxoffice get pods
```

The image target builds and loads all three services into minikube. Deployment seeds `show-1`
with 36 seats and waits for all five deployments. Storefront, inventory and pricing should
show `2/2` containers ready; PostgreSQL and Redis should each show `1/1`.

For a registry-backed test cluster, use a registry and Kubernetes context you control:

```bash
make images REGISTRY=ghcr.io/YOUR_OWNER LOAD="docker push"
make deploy REGISTRY=ghcr.io/YOUR_OWNER KUBE_CONTEXT=YOUR_TEST_CONTEXT
```

Configure image visibility or pull credentials so the cluster can pull the packages. Use a new
`TAG` when changing the baseline to avoid reusing a cached mutable image.

## Reservation contract

`POST /reservations` takes a show, seats, currency and idempotency key. It should return a held
reservation and a quote including fees, reuse an active hold for the same request, and return
`409` when another request tries to reserve those seats.

The hosted Smart Test in `smart-tests/reservations/create-reservation.star` checks five parts of
that contract. Configure it in Signadot with a workload trigger to run on sandbox creation or
updates. The `.star` file alone does not configure a hosted trigger. The CodeRabbit tutorial
contains the complete connection, trigger, PR-build and review steps.

Keep B11/B12 free for the Smart Test and C11/C12 free for the conventional Job guard. These tests
write to the shared demo database. Active holds expire after 15 minutes by default; acquiring a
new hold after expiry changes its expiration time.

## Source layout

| Path | Contents |
| --- | --- |
| `pkg/` | The three application services and locked Node dependencies |
| `db/`, `k8s/`, `docker/` | Schema, seed data, deployment manifests and container builds |
| `lessons/` | Narrow service changes with expected outcomes |
| `smart-tests/` | The reservation contract as a Smart Test |
| `signadot/` | PR and lesson sandbox templates, plus a conventional test Job and runner |
| `.github/workflows/` | Baseline image publishing and builds of the actual PR revision |
| `.coderabbit.yaml` | MCP review settings and runtime-evidence guidance |
| `scripts/`, `tests/` | Build identity helpers and local regression tests |

For PR workflows, copy the example, including dotfiles, to the root of your own repository.
GitHub does not discover workflows nested inside an examples directory. Commit the baseline to
the default branch before opening lesson PRs.

## Lessons and extension

The [lesson catalogue](lessons/README.md) includes a reservation regression, a safe refactor and
a pricing regression. A lesson replaces one service's `app.js` and preserves its deployment
interface. Build a convenience lesson image with `make lesson LESSON=swallow-errors`. For a PR
review, build the actual PR head with `build-pr-image.yml` and use its immutable image digest.

Add future lessons with a specific behavioral expectation and test both baseline and the change.
Storefront forwards routing headers; the sandbox templates provide a separate pricing cache
namespace. These conventions let the same application support other coding agents and tutorials.

## Local tests

Install Node.js 22, PostgreSQL 16 command-line tools and Redis, then run:

```bash
make test
```

The harness installs locked dependencies and starts disposable databases on ports 15432 and
16379, with application ports 18080–18088. Keep those ports free. It cleans up its own processes
and data. The tests cover reservation concurrency, retries, expiry, invalid input, dependency
failures, routing headers, cache separation, lesson outcomes and runtime-evidence validation.

## Demo boundaries and cleanup

The application holds seats; it does not charge customers or confirm purchases. A pricing failure
after inventory succeeds leaves the hold until expiry. PostgreSQL and Redis are disposable in
these manifests. Sandbox request routing does not isolate stored data. Inventory serializes
mutations per show, a deliberately simple choice for the 36-seat example.

Delete the sandboxes you created by their recorded names, and remove hosted triggers and any
runner dedicated to this example when finished. This command deletes the entire application
namespace and its database contents:

```bash
make clean KUBE_CONTEXT=minikube
```
