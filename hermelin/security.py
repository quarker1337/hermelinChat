from __future__ import annotations

import ipaddress
from typing import Mapping


def parse_allowlist(spec: str) -> list[ipaddress._BaseNetwork]:
    """Parse comma-separated IPs/CIDRs into ip_network objects.

    Supported entries:
      - single IP: "87.159.61.45"
      - CIDR:      "87.159.61.0/24"
      - IPv6:      "2001:db8::/32"
      - wildcard:  "*" (handled by ip_allowed)
    """
    nets: list[ipaddress._BaseNetwork] = []
    for raw in (spec or "").split(","):
        token = raw.strip()
        if not token or token == "*":
            continue

        try:
            if "/" in token:
                nets.append(ipaddress.ip_network(token, strict=False))
            else:
                ip = ipaddress.ip_address(token)
                if ip.version == 4:
                    nets.append(ipaddress.ip_network(f"{token}/32", strict=False))
                else:
                    nets.append(ipaddress.ip_network(f"{token}/128", strict=False))
        except ValueError:
            # Ignore bad entries; safer than accidentally allowing everything.
            continue

    return nets


def ip_allowed(ip: str, spec: str) -> bool:
    spec = (spec or "").strip()
    if spec == "*":
        return True

    nets = parse_allowlist(spec)
    if not nets:
        return False

    try:
        addr = ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return False

    return any(addr in n for n in nets)


def extract_client_ip(*, client_host: str, headers: Mapping[str, str], trust_xff: bool) -> str:
    """Return the best-effort client IP.

    If trust_xff=True, uses X-Forwarded-For / X-Real-IP (ONLY safe behind a trusted proxy).
    Otherwise uses the socket peer (request.client.host).
    """
    if trust_xff:
        xff = headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()

        xri = headers.get("x-real-ip")
        if xri:
            return xri.strip()

    return client_host
