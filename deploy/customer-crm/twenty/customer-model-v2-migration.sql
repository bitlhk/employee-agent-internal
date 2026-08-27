\set ON_ERROR_STOP on

DO $migration$
DECLARE
  object_name text;
  workspace_schema text;
  workspace_table text;
  migrated_count integer := 0;
BEGIN
  FOR object_name IN
    SELECT unnest(ARRAY[
      'customerSourceLink',
      'customerDomainProfile',
      'customerSuggestion',
      'customerInteraction',
      'customerFollowupTask'
    ])
  LOOP
    SELECT columns.table_schema, columns.table_name
      INTO workspace_schema, workspace_table
    FROM information_schema.columns AS columns
    WHERE columns.table_name = '_' || object_name
      AND columns.column_name = 'graceCustomerId';

    IF workspace_schema IS NULL THEN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns AS columns
        WHERE columns.table_name = '_' || object_name
          AND columns.column_name = 'globalCustomerId'
      ) THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'TWENTY_CUSTOMER_V2_COLUMN_NOT_FOUND:%', object_name;
    END IF;

    UPDATE core."fieldMetadata" AS field
    SET
      name = 'globalCustomerId',
      label = '全局客户编号',
      "updatedAt" = CURRENT_TIMESTAMP
    FROM core."objectMetadata" AS object
    WHERE field."objectMetadataId" = object.id
      AND object."nameSingular" = object_name
      AND field.name = 'graceCustomerId';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'TWENTY_CUSTOMER_V2_METADATA_NOT_FOUND:%', object_name;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.%I RENAME COLUMN %I TO %I',
      workspace_schema,
      workspace_table,
      'graceCustomerId',
      'globalCustomerId'
    );
    migrated_count := migrated_count + 1;
  END LOOP;

  IF migrated_count NOT IN (0, 5) THEN
    RAISE EXCEPTION 'TWENTY_CUSTOMER_V2_PARTIAL_MIGRATION:%', migrated_count;
  END IF;
END
$migration$;
