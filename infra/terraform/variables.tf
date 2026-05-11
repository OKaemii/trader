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

variable "resend_api_key" {
  sensitive = true
  default   = ""
}

variable "notify_email" {
  default = "panxiaqi@gmail.com"
}

variable "homeserver_ip" {
  default = "192.168.50.2"
}
