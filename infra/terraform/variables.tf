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

variable "notify_email" {
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
