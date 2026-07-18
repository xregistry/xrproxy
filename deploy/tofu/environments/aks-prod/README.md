# xrproxy production AKS

This root module provisions the first production Kubernetes environment for
xrproxy in Azure West Europe.

## State

OpenTofu state is stored with Microsoft Entra authentication:

- Resource group: `rg-xrproxy-tfstate`
- Storage account: `stxrproxyweuprod`
- Container: `tfstate`
- Key: `aks-prod.tfstate`

The backend was bootstrapped separately because a backend must exist before
OpenTofu can initialize this root module. Shared-key access and public blob
access are disabled.

## Deployment sequence

```powershell
$env:AZURE_CONFIG_DIR = "$env:USERPROFILE\.azure"
tofu init
tofu plan -out=aks-prod.tfplan
tofu apply aks-prod.tfplan
```

Flux, DNS, and certificate automation remain disabled. The environment creates
a zone-redundant Premium ACR, wires the AKS managed Prometheus collector to its
Azure Monitor workspace, and enables the AKS-managed Gateway API CRDs with the
application-routing Istio implementation. The application chart creates the
public Gateway and HTTPRoute; downstream registry services remain private.

The initial public endpoint is the managed Gateway IP over HTTP. Attach an
owned DNS name and TLS certificate before moving production clients from the
parallel Azure Container Apps deployment.

Because the API server is private, use Azure AKS run-command for initial
validation when the operator is outside the VNet:

```powershell
az aks command invoke `
  --resource-group rg-xrproxy-prod `
  --name aks-xrproxy-prod `
  --command "kubectl get nodes -o wide"
```

## Capacity

The minimum node footprint is 18 vCPUs:

- Three `Standard_D2ds_v5` system nodes
- Three `Standard_D4ds_v5` workload nodes

West Europe quota validation on 2026-07-17 showed 100 available regional vCPUs
and 100 available DDSv5-family vCPUs.
