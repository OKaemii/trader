"""Canonical ticker identity — the Python twin of the TS `@trader/ticker-identity` adapter.

The platform's single source of truth for "which instrument" is the BARE exchange symbol plus its
listing market — never the broker's concatenated form. A US Alphabet share is
`TickerIdentity('GOOGL', 'US')`; a London Shell share is `TickerIdentity('SHEL', 'LSE')`. Storage
(Mongo fields, Timescale columns, Redis keys) carries `symbol` + `market` separately; the Trading212
`_US_EQ` / `l_EQ` form is produced ONLY by the adapter below, at the broker boundary.

WHY a Python mirror (not a single TS definition): the harvester, fundamentals-api, and the
strategy/backtest hosts are Python and never call the TS package. This module is the byte-for-byte
twin of `packages/ticker-identity/src/adapter.ts` so the two languages cannot drift on the suffix
rules, the currency map, or the FB→META rename. Any change to the broker representation must edit
BOTH adapters (the parity test pins identical fixtures → identical outputs).

`Market` excludes `'OTHER'` deliberately: only US + LSE listings are tradable on the platform, so an
unrecognised suffix is a parse failure (the caller's problem), not a third enum member that would
silently flow into storage and ranking. The legacy `'UK'/'OTHER'` vocabulary of
`quant_core.fundamentals.contract.market_of` is preserved by a thin shim there, which routes through
this adapter and maps `'LSE'→'UK'` / a parse failure → `'OTHER'` (so every existing caller keeps its
byte-identical value).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# The quote currency vocabulary, mirroring the TS `Currency = 'GBP' | 'USD'`. The account base is
# GBP; the only two tradable markets quote in GBP (LSE) or USD (US).
Currency = Literal["GBP", "USD"]

# `market ∈ {'US','LSE'}` mirrors `instrument_registry.market`; `OTHER` is rejected from the
# tradable universe (an unrecognised suffix throws rather than becoming a third member).
Market = Literal["US", "LSE"]

# T212 represents a listing by appending an exchange tag to the bare symbol:
#   US  →  `<symbol>_US_EQ`   (e.g. GOOGL → GOOGL_US_EQ)
#   LSE →  `<symbol>l_EQ`     (lowercase 'l' joined to the symbol, e.g. SHEL → SHELl_EQ)
# These two literals are the entire knowledge of the broker representation in the Python codebase —
# every other call site routes through `to_t212` / `from_t212`.
_US_SUFFIX = "_US_EQ"
_LSE_SUFFIX = "l_EQ"

# Legacy-rename table: a symbol the broker's catalog still lists under its pre-rebrand name maps to
# the canonical post-rebrand symbol. Seeded from the scattered `SYMBOL_RENAMES` maps — Facebook →
# Meta. Keyed by `(market, from_symbol)` because a rebrand is listing-specific: FB→META is a US
# event, so it must not silently rewrite a same-named symbol on another market.
_RENAMES: dict[Market, dict[str, str]] = {
    "US": {"FB": "META"},
    "LSE": {},
}

# Currency is a pure function of the listing market — this replaces the duplicated
# `currencyOfTicker` / `inferCurrency` suffix sniffers so a single rule governs every side.
_CURRENCY_BY_MARKET: dict[Market, Currency] = {
    "US": "USD",
    "LSE": "GBP",
}


@dataclass(frozen=True)
class TickerIdentity:
    """The bare exchange symbol (`GOOGL`, `SHEL`) plus its listing market — the source of truth.

    `frozen` so an identity is a value object (hashable, usable as a dict key) and cannot be mutated
    after the adapter constructs it; the TS interface is `readonly` for the same reason.
    """

    symbol: str
    market: Market


def _require_symbol(symbol: str) -> str:
    """A bare symbol must be a non-empty token with no broker suffix already attached — guards
    against `to_t212(TickerIdentity('', …))` emitting a suffix-only string and against
    double-encoding an already-T212 value back through the adapter."""
    s = (symbol or "").strip()
    if len(s) == 0:
        raise ValueError("[ticker-identity] empty symbol")
    return s


class Trading212TickerAdapter:
    """The only code in the Python services that produces or parses the Trading212 `_US_EQ` /
    `l_EQ` form, derives currency from a listing, or owns the legacy symbol rename. Everything
    upstream works in `TickerIdentity` and converts at the broker boundary alone.
    """

    def to_t212(self, ident: TickerIdentity) -> str:
        """Identity → the broker's ticker string. `{GOOGL, US} → 'GOOGL_US_EQ'`;
        `{SHEL, LSE} → 'SHELl_EQ'`. Inverse of :meth:`from_t212`.

        Throws on a market outside `US|LSE` (symmetric with :meth:`from_t212`'s rejection): a
        `market` hydrated from storage can smuggle an out-of-type value, so fail loudly rather than
        broker-sending a malformed string.
        """
        symbol = _require_symbol(ident.symbol)
        if ident.market == "US":
            return f"{symbol}{_US_SUFFIX}"
        if ident.market == "LSE":
            return f"{symbol}{_LSE_SUFFIX}"
        raise ValueError(f"[ticker-identity] unsupported market: {ident.market!r}")

    def from_t212(self, t212: str) -> TickerIdentity:
        """The broker's ticker string → identity. The ONLY suffix parser in the Python codebase,
        and a strict inverse of :meth:`to_t212`: `'GOOGL_US_EQ' → {GOOGL, US}`,
        `'SHELl_EQ' → {SHEL, LSE}`. A string that is not a recognised US/LSE equity form (an
        unsupported market, CFD, or malformed input) throws — it is not silently coerced to a third
        market, because only US + LSE are tradable here.
        """
        raw = (t212 or "").strip()
        # US is unambiguous: the explicit `_US_EQ` tail. Strip it for the bare symbol.
        if raw.endswith(_US_SUFFIX):
            symbol = raw[: -len(_US_SUFFIX)]
            if len(symbol) == 0:
                raise ValueError(f"[ticker-identity] malformed T212 ticker (empty symbol): {t212}")
            return TickerIdentity(symbol=symbol, market="US")
        # LSE is `<symbol>l_EQ`: the `l` belongs to the suffix, so the bare symbol is what precedes
        # `l_EQ` (and must be non-empty — `l_EQ` alone has no symbol).
        if raw.endswith(_LSE_SUFFIX):
            symbol = raw[: -len(_LSE_SUFFIX)]
            if len(symbol) == 0:
                raise ValueError(f"[ticker-identity] malformed T212 ticker (empty symbol): {t212}")
            return TickerIdentity(symbol=symbol, market="LSE")
        raise ValueError(f"[ticker-identity] unrecognised T212 ticker (not a US/LSE equity): {t212}")

    def currency_of(self, ident: TickerIdentity) -> Currency:
        """Listing market → quote currency. `US → 'USD'`, `LSE → 'GBP'`."""
        return _CURRENCY_BY_MARKET[ident.market]

    def apply_rename(self, ident: TickerIdentity) -> TickerIdentity:
        """Apply a legacy symbol rename (e.g. US `FB → META`) market-aware. Returns a new identity
        with the canonical symbol when a rename applies, otherwise the input unchanged. Replaces the
        scattered `SYMBOL_RENAMES` lookups.
        """
        symbol = _require_symbol(ident.symbol)
        renamed = _RENAMES[ident.market].get(symbol)
        if renamed is None or renamed == symbol:
            return ident
        return TickerIdentity(symbol=renamed, market=ident.market)
