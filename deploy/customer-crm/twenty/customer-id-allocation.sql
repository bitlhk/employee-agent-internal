\set ON_ERROR_STOP on

DO $migration$
DECLARE
  target_schema text;
  target_table text;
  current_max bigint;
  sequence_value bigint;
  qualified_sequence text;
  metadata_rows integer;
BEGIN
  SELECT table_schema, table_name
    INTO target_schema, target_table
  FROM information_schema.columns
  WHERE column_name = 'globalCustomerId'
    AND table_name = '_enterpriseCustomer';

  IF target_schema IS NULL OR target_table IS NULL THEN
    RAISE EXCEPTION 'TWENTY_CUSTOMER_TABLE_NOT_FOUND';
  END IF;

  UPDATE core."fieldMetadata" AS field
  SET
    "isNullable" = true,
    "isUIEditable" = false,
    "isUIReadOnly" = true,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM core."objectMetadata" AS object
  WHERE field."objectMetadataId" = object.id
    AND object."nameSingular" = 'enterpriseCustomer'
    AND field.name = 'globalCustomerId';
  GET DIAGNOSTICS metadata_rows = ROW_COUNT;
  IF metadata_rows <> 1 THEN
    RAISE EXCEPTION 'TWENTY_CUSTOMER_GLOBAL_ID_METADATA_AMBIGUOUS:%', metadata_rows;
  END IF;

  EXECUTE format(
    'ALTER TABLE %I.%I ALTER COLUMN %I DROP NOT NULL',
    target_schema,
    target_table,
    'globalCustomerId'
  );

  EXECUTE format(
    'CREATE SEQUENCE IF NOT EXISTS %I.%I AS bigint MINVALUE 1',
    target_schema,
    'linggan_customer_global_id_seq'
  );

  EXECUTE format(
    'SELECT COALESCE(MAX(substring(%I from ''^CUST-([0-9]+)$'')::bigint), 0) FROM %I.%I WHERE %I ~ ''^CUST-[0-9]+$''',
    'globalCustomerId',
    target_schema,
    target_table,
    'globalCustomerId'
  ) INTO current_max;

  EXECUTE format(
    'SELECT last_value FROM %I.%I',
    target_schema,
    'linggan_customer_global_id_seq'
  ) INTO sequence_value;

  qualified_sequence := format(
    '%I.%I',
    target_schema,
    'linggan_customer_global_id_seq'
  );
  PERFORM setval(
    qualified_sequence::regclass,
    GREATEST(current_max, sequence_value, 900000),
    true
  );

  EXECUTE format(
    $function_definition$
      CREATE OR REPLACE FUNCTION %I.assign_linggan_customer_defaults()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $trigger$
      BEGIN
        IF NEW."globalCustomerId" IS NULL OR btrim(NEW."globalCustomerId") = '' THEN
          NEW."globalCustomerId" := 'CUST-' || lpad(nextval('%s')::text, 6, '0');
        END IF;
        IF NEW."customerStatus" IS NULL OR btrim(NEW."customerStatus") = '' THEN
          NEW."customerStatus" := 'draft';
        END IF;
        IF NEW."visibilityScope" IS NULL OR btrim(NEW."visibilityScope") = '' THEN
          NEW."visibilityScope" := 'restricted';
        END IF;
        IF NEW."tenantId" IS NULL OR btrim(NEW."tenantId") = '' THEN
          NEW."tenantId" := 'tn_linggan_finance';
        END IF;
        IF NEW."businessAsOf" IS NULL THEN
          NEW."businessAsOf" := CURRENT_TIMESTAMP;
        END IF;
        RETURN NEW;
      END
      $trigger$
    $function_definition$,
    target_schema,
    qualified_sequence
  );

  EXECUTE format(
    'DROP TRIGGER IF EXISTS assign_linggan_customer_defaults_before_insert ON %I.%I',
    target_schema,
    target_table
  );
  EXECUTE format(
    'CREATE TRIGGER assign_linggan_customer_defaults_before_insert BEFORE INSERT ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.assign_linggan_customer_defaults()',
    target_schema,
    target_table,
    target_schema
  );
END
$migration$;
