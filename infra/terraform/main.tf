module "k8s_bootstrap" {
  source    = "./modules/k8s-bootstrap"
  namespace = var.namespace

  jwt_secret           = var.jwt_secret
  internal_secret      = var.internal_secret
  redis_password       = var.redis_password
  mongodb_password     = var.mongodb_password
  timescaledb_password = var.timescaledb_password
  t212_api_key         = var.t212_api_key
  t212_api_key_id      = var.t212_api_key_id
  t212_api_key_demo    = var.t212_api_key_demo
  t212_api_key_id_demo = var.t212_api_key_id_demo
  twelvedata_api_key   = var.twelvedata_api_key
  eodhd_api_key        = var.eodhd_api_key
  resend_api_key       = var.resend_api_key
  deepseek_api_key     = var.deepseek_api_key
  email_to             = var.email_to
  alert_webhook_url    = var.alert_webhook_url
  alert_email_to       = var.alert_email_to
  seed_admin_email     = var.seed_admin_email
  seed_admin_password  = var.seed_admin_password
  ghcr_username        = var.ghcr_username
  ghcr_token           = var.ghcr_token
}

module "nginx_ingress" {
  source     = "./modules/nginx-ingress"
  depends_on = [module.k8s_bootstrap]
}

// KEDA must land before the trader chart so the ScaledObject CRDs exist when the
// strategy-engine subchart tries to render its scaledobject.yaml — otherwise helm
// install fails with "no matches for kind \"ScaledObject\" in version \"keda.sh/v1alpha1\""
// against a fresh cluster.
module "keda" {
  source     = "./modules/keda"
  depends_on = [module.k8s_bootstrap]
}

module "monitoring" {
  source     = "./modules/monitoring"
  namespace  = var.namespace
  depends_on = [module.k8s_bootstrap]
}

module "trader_app" {
  source     = "./modules/trader-app"
  namespace  = var.namespace
  depends_on = [module.k8s_bootstrap, module.nginx_ingress, module.keda]

  redis_password       = var.redis_password
  mongodb_password     = var.mongodb_password
  timescaledb_password = var.timescaledb_password
}
