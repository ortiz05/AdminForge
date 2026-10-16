-- Published definitions keep their authored key order (form fields, datasource order): json keeps the text as written,
-- jsonb sorts object keys. The next `adminforge publish` restores the order of bodies stored while this was jsonb.
ALTER TABLE "definitions" ALTER COLUMN "body" SET DATA TYPE json USING "body"::json;
