variable "namespace" {
  default = "trader"
}

variable "redis_password" {
  sensitive = true
  default   = "change-me-in-production"
}

variable "mongodb_password" {
  sensitive = true
  default   = "change-me-in-production"
}

// Postgres-with-TimescaleDB password. Same shape as mongodb_password; injected
// into the trader-secrets kube Secret as TIMESCALEDB_PASSWORD so any service that
// needs the live time-series store can build its connection string from
// {host, port, db, user, $TIMESCALEDB_PASSWORD}.
variable "timescaledb_password" {
  sensitive = true
  default   = "change-me-in-production"
}

variable "jwt_secret" {
  sensitive = true
  default   = "change-me-in-production"
}

variable "internal_secret" {
  sensitive = true
  default   = "change-me-in-production"
}

variable "t212_api_key" {
  sensitive = true
  default   = ""
}

variable "t212_api_key_id" {
  sensitive = true
  default   = ""
}

variable "t212_api_key_demo" {
  sensitive = true
  default   = ""
}

variable "t212_api_key_id_demo" {
  sensitive = true
  default   = ""
}

variable "resend_api_key" {
  sensitive = true
  default   = ""
}

// DeepSeek API key — powers per-cycle analysis email enrichment (company profiles +
// sector reasoning) in notification-service. Empty disables the analysis path; the
// per-signal quick emails keep firing regardless.
variable "deepseek_api_key" {
  sensitive = true
  default   = ""
}

variable "email_to" {
  default = "panxiaqi@gmail.com"
}

variable "seed_admin_email" {
  description = "Email of the admin account seeded on first auth-service startup. Leave empty to skip seeding."
  default     = ""
}

variable "seed_admin_password" {
  description = "Password for the seeded admin. Required if seed_admin_email is set."
  sensitive   = true
  default     = ""
}

variable "homeserver_ip" {
  default = "192.168.50.2"
}
