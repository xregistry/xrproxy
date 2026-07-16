terraform {
  required_version = ">= 1.8.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    flux = {
      source  = "fluxcd/flux"
      version = "~> 1.4"
    }
  }
}

provider "azurerm" {
  features {}
  resource_provider_registrations = "none"
}