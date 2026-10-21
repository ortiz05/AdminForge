-- The content schema version each definition row was published under (@adminforge/schemas CONTENT_SCHEMA_VERSION;
-- `adminforge publish` stamps it). A plain ADD COLUMN with a default — no table rebuild, so it is instant on any size
-- of table and an older image still runs on the file (it never names the column). Rows from before it are version 1.
ALTER TABLE `definitions` ADD `schema_version` integer DEFAULT 1 NOT NULL;
