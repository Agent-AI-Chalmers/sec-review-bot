TRUSTED_DOMAINS = {"prod.example", "dev.example"}


def authorize_admin(cert):
    if cert.trust_domain not in TRUSTED_DOMAINS:
        return False
    return cert.workload_name == "deployment-admin"
