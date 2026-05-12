module "k8s_bootstrap" {
  source    = "./modules/k8s-bootstrap"
  namespace = var.namespace

  jwt_secret          = var.jwt_secret
  internal_secret     = var.internal_secret
  redis_password      = var.redis_password
  mongodb_password    = var.mongodb_password
  t212_api_key        = var.t212_api_key
  resend_api_key      = var.resend_api_key
  notify_email        = var.notify_email
  seed_admin_email    = var.seed_admin_email
  seed_admin_password = var.seed_admin_password
}

module "nginx_ingress" {
  source     = "./modules/nginx-ingress"
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
  depends_on = [module.k8s_bootstrap, module.nginx_ingress]

  redis_password   = var.redis_password
  mongodb_password = var.mongodb_password
}
