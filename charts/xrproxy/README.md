# xrproxy Helm chart

This chart deploys the active xRegistry package proxies and bridge as independent, provider-neutral Kubernetes workloads. It creates only standard Kubernetes resources by default.

## Prerequisites

- Kubernetes 1.27 or newer
- Helm 3
- A CNI that enforces `NetworkPolicy` when network isolation is required
- Optional: Gateway API CRDs and a Gateway controller
- Optional: cert-manager when `certificate.enabled=true`

## Install

```bash
helm upgrade --install xrproxy ./charts/xrproxy \
  --namespace xrproxy \
  --create-namespace \
  --set image.tag=<git-commit-sha>
```

Production deployments should pin each `services.<id>.image.digest`. Tags remain available for development.

## Architecture

The chart creates one Deployment and ClusterIP Service for each active entry in `config/services.json`. Only the bridge should be exposed externally. Its unauthenticated downstream configuration is generated as a ConfigMap using Kubernetes service DNS.

The default cache is an `emptyDir`. This matches the applications' rebuildable local-cache behavior and avoids implying that their cache files are safe for concurrent shared-volume access.

## Gateway API

To create a Gateway and HTTPRoute:

```yaml
gateway:
  enabled: true
  create: true
  className: example
  listener:
    protocol: HTTPS
    port: 443
    hostname: packages.example.com
    tls:
      enabled: true
      certificateSecretName: packages-tls
  httpRoute:
    hostnames:
      - packages.example.com
```

Set `gateway.create=false` and `gateway.parentRef.name` to attach the HTTPRoute to a platform-managed Gateway. The chart does not install Gateway API CRDs or a controller.

## TLS and DNS extension points

`certificate.enabled` optionally creates a standard cert-manager `Certificate`. Gateway and HTTPRoute annotation maps are empty by default so operators can integrate ExternalDNS without embedding provider-specific configuration in the chart.

## Scaling and availability

PDBs and HPAs are disabled by default. Enable a PDB only after configuring
at least two replicas or an HPA minimum of two; `minAvailable: 1` on a
singleton prevents voluntary node drains. Scaling proxy replicas duplicates
cache warming and upstream traffic, so validate it for the target workload
first.

## Service catalog synchronization

The generated service block in `values.yaml` is derived from `config/services.json`:

```bash
npm run helm:services:check
npm run helm:services:generate
```
