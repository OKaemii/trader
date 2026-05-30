"""HS256 internal-JWT minting — the single Python source of truth.

Compatible with packages/shared-auth/src/internal-jwt.ts (mintInternalJwt): same header,
claims, and shared JWT_SECRET. strategy-engine's market_data_client and quant-core's
LiveBarsReader both import this — no duplicated minting logic.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

INTERNAL_TTL_SEC = 300  # match shared-auth/internal-jwt.ts


def _b64url(blob: bytes) -> str:
    return base64.urlsafe_b64encode(blob).rstrip(b"=").decode("ascii")


def mint_internal_jwt(
    caller: str, secret: str, ttl_sec: int = INTERNAL_TTL_SEC, now: float | None = None
) -> str:
    """HS256 JWT: {"sub":caller,"aud":"internal","iat":now,"exp":now+ttl}. `now` overridable for tests."""
    ts = int(now if now is not None else time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"sub": caller, "aud": "internal", "iat": ts, "exp": ts + ttl_sec}
    signing_input = (
        f"{_b64url(json.dumps(header, separators=(',', ':')).encode())}."
        f"{_b64url(json.dumps(payload, separators=(',', ':')).encode())}"
    )
    sig = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{_b64url(sig)}"
