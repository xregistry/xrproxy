terraform {
  required_version = ">= 1.8.0"

  backend "azurerm" {
    resource_group_name  = "rg-xrproxy-tfstate"
    storage_account_name = "stxrproxyweuprod"
    container_name       = "tfstate"
    key                  = "aks-prod.tfstate"
    use_azuread_auth     = true
  }
}
