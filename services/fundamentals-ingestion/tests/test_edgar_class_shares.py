"""Per-class share recovery from the XBRL instance (epic post-pit-coverage-bugs, Tasks 4/5).

`_parse_class_shares` is driven against inline-XBRL + classic-instance fixtures; the fetch path
(`EdgarClassSharesClient.fetch_class_shares`) is exercised through an httpx `MockTransport`
(index.json → instance), including the fail-soft empty paths.
"""
from __future__ import annotations

import pytest

from src.download.edgar_class_shares import (
    EdgarClassSharesClient,
    _parse_class_shares,
    _pick_instance,
)
from src.security_master.rate_limiter import RateLimiter
from tests.fakes import httpx_transport

_PERIOD_END = 1_711_843_200_000

# Two share classes (META-shaped) + a default-member float fact (no class dimension → must be ignored).
META_INSTANCE = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"
      xmlns:xbrli="http://www.xbrl.org/2003/instance"
      xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
<body>
<ix:header><ix:resources>
  <xbrli:context id="cA"><xbrli:entity><xbrli:segment>
    <xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">us-gaap:CommonClassAMember</xbrldi:explicitMember>
  </xbrli:segment></xbrli:entity></xbrli:context>
  <xbrli:context id="cB"><xbrli:entity><xbrli:segment>
    <xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">us-gaap:CommonClassBMember</xbrldi:explicitMember>
  </xbrli:segment></xbrli:entity></xbrli:context>
  <xbrli:context id="cDflt"><xbrli:entity></xbrli:entity></xbrli:context>
</ix:resources></ix:header>
<ix:nonFraction name="dei:EntityCommonStockSharesOutstanding" contextRef="cA" unitRef="shares" scale="0">2,196,045,588</ix:nonFraction>
<ix:nonFraction name="dei:EntityCommonStockSharesOutstanding" contextRef="cB" unitRef="shares" scale="0">342,377,716</ix:nonFraction>
<ix:nonFraction name="dei:EntityPublicFloat" contextRef="cDflt" unitRef="usd" scale="6">1000</ix:nonFraction>
</body></html>"""

# A Visa-shaped instance: per-class shares + a per-class conversion-ratio fact.
VISA_INSTANCE = """<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"
      xmlns:xbrli="http://www.xbrl.org/2003/instance"
      xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
<body>
<ix:resources>
  <xbrli:context id="cA"><xbrli:entity><xbrli:segment>
    <xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">us-gaap:CommonClassAMember</xbrldi:explicitMember>
  </xbrli:segment></xbrli:entity></xbrli:context>
  <xbrli:context id="cB"><xbrli:entity><xbrli:segment>
    <xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">v:CommonClassBMember</xbrldi:explicitMember>
  </xbrli:segment></xbrli:entity></xbrli:context>
</ix:resources>
<ix:nonFraction name="dei:EntityCommonStockSharesOutstanding" contextRef="cA" unitRef="shares" scale="0">1,659,709,932</ix:nonFraction>
<ix:nonFraction name="dei:EntityCommonStockSharesOutstanding" contextRef="cB" unitRef="shares" scale="0">245,000,000</ix:nonFraction>
<ix:nonFraction name="us-gaap:ConvertibleCommonStockConversionRatio" contextRef="cB" unitRef="pure">0.5</ix:nonFraction>
</body></html>"""

# Classic (pre-inline) XBRL instance: the dei element carries contextRef directly.
CLASSIC_INSTANCE = """<xbrl xmlns:dei="http://xbrl.sec.gov/dei"
      xmlns:xbrli="http://www.xbrl.org/2003/instance"
      xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
<xbrli:context id="cA"><xbrli:entity><xbrli:segment>
  <xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">us-gaap:CommonClassAMember</xbrldi:explicitMember>
</xbrli:segment></xbrli:entity></xbrli:context>
<dei:EntityCommonStockSharesOutstanding contextRef="cA" unitRef="shares">123456</dei:EntityCommonStockSharesOutstanding>
</xbrl>"""

# A consolidated-only doc: the shares fact's context has NO class member → nothing per-class to recover.
NO_CLASS_INSTANCE = """<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"
      xmlns:xbrli="http://www.xbrl.org/2003/instance">
<body><ix:resources><xbrli:context id="c0"><xbrli:entity></xbrli:entity></xbrli:context></ix:resources>
<ix:nonFraction name="dei:EntityCommonStockSharesOutstanding" contextRef="c0" unitRef="shares">99</ix:nonFraction>
</body></html>"""


def _members(facts):
    return {f.dim_signature: f.value for f in facts if f.unit == "shares"}


def test_parse_two_classes_with_values() -> None:
    facts = _parse_class_shares(META_INSTANCE, cik="0001326801", accession="x", period_end_ms=_PERIOD_END)
    shares = _members(facts)
    assert shares == {
        "us-gaap:StatementClassOfStockAxis=us-gaap:CommonClassAMember": 2_196_045_588,
        "us-gaap:StatementClassOfStockAxis=us-gaap:CommonClassBMember": 342_377_716,
    }
    assert all(f.unit == "shares" and f.tag == "EntityCommonStockSharesOutstanding"
               and f.period_end == _PERIOD_END for f in facts)


def test_parse_captures_conversion_ratio_as_pure_fact() -> None:
    facts = _parse_class_shares(VISA_INSTANCE, cik="0001403161", accession="x", period_end_ms=_PERIOD_END)
    ratios = {f.dim_signature: f.value for f in facts if f.unit == "pure"}
    assert ratios == {"us-gaap:StatementClassOfStockAxis=v:CommonClassBMember": 0.5}
    # the real reported tag is preserved on the ratio fact (honest provenance)
    ratio_fact = next(f for f in facts if f.unit == "pure")
    assert ratio_fact.tag == "ConvertibleCommonStockConversionRatio" and ratio_fact.taxonomy == "us-gaap"


def test_parse_classic_instance_element() -> None:
    facts = _parse_class_shares(CLASSIC_INSTANCE, cik="x", accession="x", period_end_ms=_PERIOD_END)
    assert _members(facts) == {"us-gaap:StatementClassOfStockAxis=us-gaap:CommonClassAMember": 123456}


def test_parse_no_class_member_yields_nothing() -> None:
    assert _parse_class_shares(NO_CLASS_INSTANCE, cik="x", accession="x", period_end_ms=_PERIOD_END) == []


def test_parse_total_on_garbage() -> None:
    assert _parse_class_shares("<not xbrl>", cik="x", accession="x", period_end_ms=_PERIOD_END) == []


def test_pick_instance_prefers_dated_stem() -> None:
    index = {"directory": {"item": [
        {"name": "R1.htm"}, {"name": "FilingSummary.xml"},
        {"name": "0001628280-26-028526-index.htm"}, {"name": "meta-20260331.htm", "type": "10-Q"},
    ]}}
    assert _pick_instance(index) == "meta-20260331.htm"


def test_pick_instance_none_when_no_instance() -> None:
    assert _pick_instance({"directory": {"item": [{"name": "R1.htm"}]}}) is None
    assert _pick_instance({}) is None


def test_pick_instance_excludes_exhibit_picks_real_instance() -> None:
    # Mastercard's filings list `exb101-MMDDYYYY.htm` exhibits alongside the real `ma-YYYYMMDD.htm`
    # instance. The exhibit (digit-laden prefix + MMDDYYYY date) must NOT be picked -- it carries no
    # per-class share facts, which silently nulled MA's shares before this fix.
    index = {"directory": {"item": [
        {"name": "exb101-03312024.htm"}, {"name": "R1.htm"}, {"name": "ma-20240331.htm"},
    ]}}
    assert _pick_instance(index) == "ma-20240331.htm"


def test_pick_instance_does_not_fall_back_onto_an_exhibit() -> None:
    # Only an exhibit present (no dated instance stem) -> None, never the exhibit.
    index = {"directory": {"item": [{"name": "exb101-12312019.htm"}, {"name": "R1.htm"}]}}
    assert _pick_instance(index) is None


@pytest.mark.asyncio
async def test_fetch_class_shares_through_mock_transport() -> None:
    import httpx

    index = {"directory": {"item": [{"name": "meta-20260331.htm", "type": "10-Q"}]}}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        assert request.headers.get("User-Agent")  # SEC requires a descriptive UA
        if url.endswith("/index.json"):
            return httpx.Response(200, json=index)
        if url.endswith("/meta-20260331.htm"):
            return httpx.Response(200, text=META_INSTANCE)
        return httpx.Response(404)

    client = EdgarClassSharesClient(user_agent="trader-test contact@example.com",
                                    transport=httpx_transport(handler), limiter=RateLimiter(1000, 1.0))
    facts = await client.fetch_class_shares(1326801, "0001628280-26-028526", _PERIOD_END)
    assert _members(facts) == {
        "us-gaap:StatementClassOfStockAxis=us-gaap:CommonClassAMember": 2_196_045_588,
        "us-gaap:StatementClassOfStockAxis=us-gaap:CommonClassBMember": 342_377_716,
    }


@pytest.mark.asyncio
async def test_fetch_degrades_to_empty_on_404() -> None:
    import httpx

    client = EdgarClassSharesClient(user_agent="ua", limiter=RateLimiter(1000, 1.0),
                                    transport=httpx_transport(lambda r: httpx.Response(404)))
    assert await client.fetch_class_shares(1326801, "0001-26-1", _PERIOD_END) == []


@pytest.mark.asyncio
async def test_fetch_refuses_without_user_agent() -> None:
    # Empty UA ⇒ never send an anonymous request SEC would 403 / IP-block.
    client = EdgarClassSharesClient(user_agent="", limiter=RateLimiter(1000, 1.0))
    assert await client.fetch_class_shares(1326801, "0001-26-1", _PERIOD_END) == []
