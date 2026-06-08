-- 0010_companies_sector_update_grant.sql — column-level UPDATE(sector) for secmaster_writer.
--
-- `security_master.companies.sector` carries the SIC→QA template
-- (general/bank/insurance/reit/utility — a coarse routing bucket, NOT a GICS sector)
-- so the quarantine `by_sector` JOIN buckets a filer's findings instead of reading
-- `(unknown)`. Sector is a MUTABLE classification (unlike the effective-dated
-- identifier history, which stays strictly append-only), so the ingest writer
-- backfills/refreshes it in place on the find-or-insert FOUND path
-- (`upsert_company`, writers.py): `UPDATE companies SET sector=$1 WHERE company_id=$2
-- AND sector IS DISTINCT FROM $1`, non-null only. The ~21 rows ingested before sector
-- was populated thus gain a sector on their next re-ingest.
--
-- 0008 granted secmaster_writer INSERT+SELECT only (no UPDATE), so that statement
-- would fail at the wire layer without this column-level grant. This is the ONE
-- column secmaster_writer may UPDATE — every other security-master mutation stays
-- append-only. Mirrors the column-level supersede grants
-- (bars_writer UPDATE(is_superseded), 0002; fundamentals_writer, 0009).
--
-- A SEPARATE migration file (not an edit to 0008) because the SQL-file runner records
-- each filename in schema_migrations and never re-applies an already-recorded file —
-- 0008 has already run in deployed environments, so the new grant must arrive as a
-- new migration. GRANT is naturally idempotent; the role-exists guard keeps this safe
-- even if applied before 0008 in a from-scratch bring-up.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'secmaster_writer') THEN
    CREATE ROLE secmaster_writer NOLOGIN;
  END IF;
END
$$;

GRANT UPDATE (sector) ON security_master.companies TO secmaster_writer;
