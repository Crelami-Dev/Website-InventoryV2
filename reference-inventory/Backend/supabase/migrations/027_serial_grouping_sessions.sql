-- ============================================================================
-- Migration 027 (Draft): Serial Grouping Sessions Header and Pending Workflow
-- 
-- Phase 7K implementation for DocuFlow:
-- 1. Creates public.serial_grouping_sessions:
--    Header transaction representing a multi-batch grouping session.
-- 2. Supports Pending -> Confirmed (Completed) -> Cancelled lifecycle.
-- 3. Associates multiple serial_groupings batches with a single session header.
-- 4. Ensures tenant isolation, RLS, and uniqueness constraints.
--
-- DRAFT ONLY: Do not execute directly against production without approval.
-- ============================================================================

-- 1. Create public.serial_grouping_sessions table
CREATE TABLE IF NOT EXISTS public.serial_grouping_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  warehouse_id UUID,
  session_number TEXT NOT NULL,
  session_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled', 'partial')),
  total_batches INTEGER NOT NULL DEFAULT 0 CHECK (total_batches >= 0),
  total_serials INTEGER NOT NULL DEFAULT 0 CHECK (total_serials >= 0),
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  confirmed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  CONSTRAINT uq_serial_grouping_sessions_owner_number UNIQUE (owner_id, session_number)
);

-- 2. Add session_id foreign key column to public.serial_groupings
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'serial_groupings' 
      AND column_name = 'session_id'
  ) THEN
    ALTER TABLE public.serial_groupings
      ADD COLUMN session_id UUID REFERENCES public.serial_grouping_sessions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Indexes for performance and lookup
CREATE INDEX IF NOT EXISTS idx_grouping_sessions_owner_status
  ON public.serial_grouping_sessions (owner_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_grouping_sessions_owner_wh
  ON public.serial_grouping_sessions (owner_id, warehouse_id);

CREATE INDEX IF NOT EXISTS idx_serial_groupings_session_id
  ON public.serial_groupings (session_id)
  WHERE session_id IS NOT NULL;

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.serial_grouping_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
      AND tablename = 'serial_grouping_sessions' 
      AND policyname = 'serial_grouping_sessions_owner_isolation'
  ) THEN
    CREATE POLICY serial_grouping_sessions_owner_isolation ON public.serial_grouping_sessions
      FOR ALL
      USING (owner_id = (SELECT auth.uid()))
      WITH CHECK (owner_id = (SELECT auth.uid()));
  END IF;
END $$;

-- 5. Updated_at trigger
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'serial_grouping_sessions_set_updated_at'
  ) THEN
    CREATE TRIGGER serial_grouping_sessions_set_updated_at
      BEFORE UPDATE ON public.serial_grouping_sessions
      FOR EACH ROW
      EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ============================================================================
-- 6. Atomic multi-batch session confirmation RPC (DRAFT)
--
-- Confirms every batch of a Pending session inside one database transaction.
-- Requires migration 025 (create_serial_group_full_atomic_v1).
-- Any batch failure rolls back all batches and leaves the session Pending.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.confirm_serial_grouping_session_atomic_v1(
  p_owner_id uuid,
  p_session_id uuid,
  p_user_id uuid,
  p_user_name text,
  p_batches jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.serial_grouping_sessions%ROWTYPE;
  v_updated_session public.serial_grouping_sessions%ROWTYPE;
  v_batch jsonb;
  v_member_ids uuid[];
  v_product_id uuid;
  v_new_product jsonb;
  v_meta jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_total integer;
  v_summary jsonb;
  v_grouping_id uuid;
BEGIN
  IF p_owner_id IS NULL THEN
    RAISE EXCEPTION 'OWNER_REQUIRED: ownerId wajib disertakan.' USING errcode = 'P0001';
  END IF;
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'SESSION_ID_REQUIRED: sessionId wajib disertakan.' USING errcode = 'P0001';
  END IF;
  IF p_batches IS NULL OR jsonb_typeof(p_batches) <> 'array' OR jsonb_array_length(p_batches) = 0 THEN
    RAISE EXCEPTION 'SESSION_BATCH_REQUIRED: Sesi grouping tidak memiliki batch.' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_session
  FROM public.serial_grouping_sessions
  WHERE owner_id = p_owner_id AND id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUPING_SESSION_NOT_FOUND: Sesi grouping tidak ditemukan.' USING errcode = 'P0002';
  END IF;

  IF v_session.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'alreadyConfirmed', true,
      'session', to_jsonb(v_session),
      'results', COALESCE(v_session.metadata->'processResult'->'results', '[]'::jsonb),
      'summary', COALESCE(v_session.metadata->'processResult'->'summary', '{}'::jsonb)
    );
  END IF;

  IF v_session.status <> 'pending' THEN
    RAISE EXCEPTION 'GROUPING_SESSION_NOT_PENDING: Sesi berstatus "%" tidak dapat dikonfirmasi.', v_session.status USING errcode = 'P0001';
  END IF;

  v_total := jsonb_array_length(p_batches);

  FOR v_batch IN SELECT value FROM jsonb_array_elements(p_batches) LOOP
    SELECT COALESCE(array_agg(value::uuid), ARRAY[]::uuid[])
    INTO v_member_ids
    FROM jsonb_array_elements_text(COALESCE(v_batch->'member_ids', '[]'::jsonb));

    IF array_length(v_member_ids, 1) IS NULL OR array_length(v_member_ids, 1) < 2 THEN
      RAISE EXCEPTION 'SESSION_BATCH_INVALID: Setiap batch memerlukan minimal 2 nomor seri.' USING errcode = 'P0001';
    END IF;
    IF NULLIF(btrim(COALESCE(v_batch->>'group_serial_number', '')), '') IS NULL THEN
      RAISE EXCEPTION 'GROUP_SERIAL_REQUIRED: Nomor seri group wajib ditentukan.' USING errcode = 'P0001';
    END IF;

    v_product_id := NULLIF(v_batch->>'product_id', '')::uuid;
    v_new_product := v_batch->'new_product';
    v_meta := COALESCE(v_batch->'metadata', '{}'::jsonb);

    IF v_product_id IS NULL AND v_new_product IS NOT NULL AND jsonb_typeof(v_new_product) = 'object' THEN
      INSERT INTO public.products (
        owner_id, name, sku, category, tracking_mode, status, unit_cost, metadata, created_by
      )
      VALUES (
        p_owner_id,
        v_new_product->>'name',
        v_new_product->>'sku',
        'Grouping',
        'serial',
        'active',
        COALESCE((v_new_product->>'unit_cost')::numeric, 0),
        jsonb_build_object(
          'isGroupResultProduct', true,
          'createdVia', 'serial_grouping',
          'unit', COALESCE(v_new_product->>'unit', 'pcs')
        ),
        p_user_id
      )
      RETURNING id INTO v_product_id;

      v_meta := v_meta || jsonb_build_object(
        'resultProductId', v_product_id,
        'resultProductName', v_new_product->>'name',
        'resultProductSku', v_new_product->>'sku'
      );
    END IF;

    IF v_product_id IS NULL THEN
      RAISE EXCEPTION 'RESULT_PRODUCT_REQUIRED: Produk hasil grouping wajib ditentukan.' USING errcode = 'P0001';
    END IF;

    v_result := public.create_serial_group_full_atomic_v1(
      p_owner_id,
      p_user_id,
      p_user_name,
      v_member_ids,
      btrim(v_batch->>'group_serial_number'),
      v_product_id,
      v_session.warehouse_id,
      v_meta,
      COALESCE(v_batch->>'target_unit', 'pcs'),
      COALESCE((v_batch->>'target_qty')::numeric, 1),
      COALESCE((v_batch->>'total_base_qty_pcs')::numeric, 1),
      COALESCE((v_batch->>'total_cost')::numeric, 0),
      COALESCE((v_batch->>'result_unit_cost')::numeric, 0),
      COALESCE((v_batch->>'is_cross_product')::boolean, false),
      v_batch->>'idempotency_key',
      v_batch->>'payload_hash',
      v_batch->>'notes',
      COALESCE(v_batch->'components', '[]'::jsonb)
    );

    v_grouping_id := NULLIF(v_result->'grouping'->>'id', '')::uuid;
    UPDATE public.serial_groupings
    SET session_id = p_session_id
    WHERE owner_id = p_owner_id AND id = v_grouping_id;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'batchId', v_batch->>'batch_id',
      'batchName', v_batch->>'batch_name',
      'success', true,
      'isReplay', COALESCE((v_result->>'isReplay')::boolean, false),
      'groupingId', v_grouping_id,
      'groupingNumber', v_result->'grouping'->>'grouping_number',
      'resultSerialId', v_result->'group'->>'id',
      'resultSerialNumber', v_result->'group'->>'serial_number'
    ));
  END LOOP;

  v_summary := jsonb_build_object(
    'total', v_total,
    'succeeded', v_total,
    'failed', 0,
    'allSucceeded', true,
    'partial', false,
    'status', 'success'
  );

  UPDATE public.serial_grouping_sessions
  SET status = 'completed',
      confirmed_at = now(),
      confirmed_by = p_user_id,
      updated_at = now(),
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'processResult', jsonb_build_object(
          'results', v_results,
          'summary', v_summary
        )
      )
  WHERE owner_id = p_owner_id AND id = p_session_id
  RETURNING * INTO v_updated_session;

  RETURN jsonb_build_object(
    'success', true,
    'alreadyConfirmed', false,
    'session', to_jsonb(v_updated_session),
    'results', v_results,
    'summary', v_summary
  );
END;
$$;

-- 7. Execute privileges: service role only
REVOKE ALL ON FUNCTION public.confirm_serial_grouping_session_atomic_v1(
  uuid, uuid, uuid, text, jsonb
) FROM PUBLIC;

DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION public.confirm_serial_grouping_session_atomic_v1(
    uuid, uuid, uuid, text, jsonb
  ) TO service_role;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
