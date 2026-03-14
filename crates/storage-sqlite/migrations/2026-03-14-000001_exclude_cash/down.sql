-- SQLite does not support DROP COLUMN directly in older versions.
-- Recreate the table without the exclude_cash column.
CREATE TABLE accounts_backup AS SELECT
    id, name, account_type, "group", currency, is_default, is_active,
    created_at, updated_at, platform_id, account_number, meta,
    provider, provider_account_id, is_archived, tracking_mode
FROM accounts;

DROP TABLE accounts;

ALTER TABLE accounts_backup RENAME TO accounts;
