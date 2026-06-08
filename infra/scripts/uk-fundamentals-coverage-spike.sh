#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# UK fundamentals coverage spike — Companies House iXBRL vs PDF (PIT warehouse).
#
# Reproducible sampling harness for the PIT Fundamentals Warehouse epic's UK
# coverage spike (plan Task 16). It quantifies, with live evidence, how much of
# the FTSE-100 large-cap universe files MACHINE-READABLE iXBRL consolidated
# accounts at Companies House vs PDF-only group accounts — the gate on whether
# the planned Companies-House → Arelle → fundamentals pipeline is worth building
# for that universe.
#
# Findings + the scope decision are written up in (gitignored, local-only):
#   agent-docs/research/pit-fundamentals-warehouse.md
#     → "## UK Coverage Spike (Task 16 findings)"
# This script is the version-controlled evidence trail behind that addendum. It
# is read-only research tooling — it is NOT wired into any service and is safe
# to re-run or delete.
#
# It uses only PUBLIC, unauthenticated Companies House surfaces:
#   - Free Accounts Data Product (daily iXBRL bulk ZIPs)
#       https://download.companieshouse.gov.uk/en_accountsdata.html
#   - The public find-and-update web service (filing history; no API key)
#       https://find-and-update.company-information.service.gov.uk/
# The authenticated REST API (api.company-information.service.gov.uk) returns
# 401 without a CH API key, so it is intentionally NOT used here — confirming
# per-filing document content-types via the REST API is the operator follow-up
# noted in the addendum (set CH_API_KEY and extend this script if desired).
#
# Usage:  bash infra/scripts/uk-fundamentals-coverage-spike.sh
# Deps:   curl, unzip, standard coreutils. ~250 MB transient downloads to a tmpdir.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

UA="${CH_USER_AGENT:-Trader Research spike contact@example.com}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A sector-diverse FTSE-100 PARENT plc sample, resolved to Companies House
# registered numbers via the public search (re-resolve if these drift):
#   AstraZeneca, Shell, BP, HSBC, Unilever, Rio Tinto, GSK, Diageo,
#   National Grid, Barclays, Vodafone, Tesco, RELX, BAE Systems.
PARENTS=(02723534 04366849 10041931 00617987 00041424 00719885 12215835 \
         00023307 04031152 00048839 01833679 00445790 00077536 01470151)

echo "### 1. Public filing-history scrape — iXBRL(xhtml) vs PDF per parent"
echo "company | accts_filings | ixbrl_xhtml_links | pdf_links"
base="https://find-and-update.company-information.service.gov.uk/company"
for cn in "${PARENTS[@]}"; do
  page="$(curl -sS -A "$UA" "${base}/${cn}/filing-history?category=accounts" 2>/dev/null)"
  acct="$(printf '%s' "$page" | grep -oicE 'Accounts (made up to|for the (period|year))')"
  xhtml="$(printf '%s' "$page" | grep -oicE 'format=xhtml|iXBRL')"
  pdf="$(printf '%s' "$page" | grep -oicE 'format=pdf')"
  printf '%s | %s | %s | %s\n' "$cn" "$acct" "$xhtml" "$pdf"
done

echo
echo "### 2. Bulk iXBRL data product — do any parents appear in the filing season?"
echo "Scans daily Accounts_Bulk_Data ZIPs (the authoritative iXBRL CH actually holds)."
dl="https://download.companieshouse.gov.uk/Accounts_Bulk_Data"
for d in 2026-03-17 2026-03-24 2026-03-31 2026-04-07 2026-04-14 2026-04-21 2026-05-05; do
  if curl -sS -A "$UA" -o "$TMP/day.zip" "${dl}-${d}.zip" 2>/dev/null; then
    lst="$(unzip -l "$TMP/day.zip" 2>/dev/null | grep -oE '_[0-9A-Z]{8}_' | tr -d '_' | sort -u)"
    n="$(printf '%s' "$lst" | grep -c .)"
    hits=""
    for p in "${PARENTS[@]}"; do printf '%s' "$lst" | grep -q "^${p}$" && hits="$hits $p"; done
    printf '%s: %6s filings; FTSE-parent hits:%s\n' "$d" "$n" "${hits:- none}"
    rm -f "$TMP/day.zip"
  else
    printf '%s: (no ZIP published — business-day gap)\n' "$d"
  fi
done

echo
echo "### 3. Regime / taxonomy mix inside one bulk ZIP (sample of 60 docs)"
if curl -sS -A "$UA" -o "$TMP/one.zip" "${dl}-2026-05-08.zip" 2>/dev/null; then
  mkdir -p "$TMP/x"
  unzip -l "$TMP/one.zip" 2>/dev/null | grep -oE 'Prod223_[0-9]+_[0-9A-Z]{8}_[0-9]+\.html' \
    | shuf | head -60 > "$TMP/s.txt"
  while read -r f; do unzip -o -q "$TMP/one.zip" "$f" -d "$TMP/x" 2>/dev/null; done < "$TMP/s.txt"
  echo "FRC taxonomy entry points (the namespaces UK normalization must map):"
  grep -rhoE 'https?://xbrl\.frc\.org\.uk/[A-Za-z0-9/._-]+\.xsd' "$TMP/x" 2>/dev/null \
    | sort | uniq -c | sort -rn | head -10
  echo "Size-regime split (general UK population is micro/small dominated):"
  f105=0; f102=0; fifrs=0
  for f in "$TMP/x"/*.html; do
    if   grep -qiE 'FRS-105|micro-entit' "$f"; then f105=$((f105+1))
    elif grep -qiE 'uk-ifrs|IFRS'        "$f"; then fifrs=$((fifrs+1))
    elif grep -qiE 'FRS-102'             "$f"; then f102=$((f102+1)); fi
  done
  echo "  FRS 105 micro=$f105  FRS 102 small/full=$f102  UK-IFRS=$fifrs  (of 60)"
fi

echo
echo "Done. See agent-docs/research/pit-fundamentals-warehouse.md for the verdict."
