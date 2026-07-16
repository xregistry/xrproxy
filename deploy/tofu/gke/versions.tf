terraform {
  required_version = ">= 1.8.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    flux = {
      source  = "fluxcd/flux"
      version = "~> 1.4"
    }
  }
}

provider "google" {
  project = var.gcp_project_id
  region  = var.region
}
