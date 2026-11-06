-- ============================================================================
-- Migration 025: Serial Grouping Runtime & Database Hardening (Phase 7C)
--
-- PROBLEM SOLVED
--   Phase 7B wrote the assembly ledger from Node.js AFTER the RPC claim, using a
--   payload that did not match the real schema (top-level `movement_type`,
--   `serial_groupings.status = 'completed'` against a CHECK that only allows
--   'active'/'dissolved'/'cancelled', document status 'approved' against a CHECK
--   that does not allow it). Errors were swallowed, so a group could exist with
--   no ledger and with member locks applied.
--
-- THIS MIGRATION
--   1. Re-asserts the additive document_type CHECK including internal ledger types.
--   2. Adds public.create_serial_group_full_atomic_v1:
--        one transaction = result serial + goods_assembly document + document_items
--        + serial_groupings + serial_grouping_components + member locks.
--        Idempotency key + payload hash replay protection, row locks on members,
--        duplicate/status/warehouse validation.
--   3. Adds public.ungroup_serial_full_atomic_v1:
--        one transaction = member release + goods_disassembly document + items
--        + serial_groupings dissolved.
--
-- STRICT PRESERVATION
--   - Additive-only. No historical row is updated or deleted.
--   - Legacy RPCs from 022 remain untouched for backward compatibility.
--   - Application falls back to the legacy RPC + compensating ledger if this
--     migration has not been applied yet.
--
-- DEPLOYMENT ORDER: apply after 024. Not auto-applied by the application.
-- ============================================================================

-- 1. Re-assert document_type CHECK (idempotent, additive)
DO $$
BEGIN
  ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_document_type_check;
  ALTER TABLE public.documents ADD CONSTRAINT documents_document_type_check
    CHECK (document_type IN (
      'invoice',
      'goods_in',
      'goods_out',
      'delivery_note',
      'receipt',
      'sample',
      'goods_assembly',
      'goods_disassembly',
      'stock_adjustment'
    ));
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 2. Full atomic grouping RPC
CREATE OR REPLACE FUNCTION public.create_serial_group_full_atomic_v1(
  p_owner_id uuid,
  p_user_id uuid,
  p_user_name text,
  p_member_ids uuid[],
  p_group_serial_number text,
  p_product_id uuid,
  p_warehouse_id uuid,
  p_metadata jsonb,
  p_target_unit text,
  p_target_qty numeric,
  p_total_base_qty_pcs numeric,
  p_total_cost numeric,
  p_result_unit_cost numeric,
  p_is_cross_product boolean,
  p_idempotency_key text,
  p_payload_hash text,
  p_notes text,
  p_components jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.serial_groupings%ROWTYPE;
  v_group public.product_serials%ROWTYPE;
  v_doc public.documents%ROWTYPE;
  v_grouping public.serial_groupings%ROWTYPE;
  v_member_ids uuid[];
  v_locked_count integer;
  v_expected_count integer;
  v_distinct_source_products integer;
  v_source_product_id uuid;
  v_date_code text;
  v_doc_number text;
  v_meta jsonb;
  v_component jsonb;
  v_component_count integer;
BEGIN
  IF p_owner_id IS NULL THEN
    RAISE EXCEPTION 'OWNER_REQUIRED: ownerId wajib disertakan.' USING errcode = 'P0001';
  END IF;

  v_member_ids := COALESCE(p_member_ids, ARRAY[]::uuid[]);
  v_expected_count := array_length(v_member_ids, 1);

  IF v_expected_count IS NULL OR v_expected_count < 2 THEN
    RAISE EXCEPTION 'MIN_MEMBERS_REQUIRED: Minimal harus memilih 2 nomor seri untuk membuat group.' USING errcode = 'P0001';
  END IF;

  -- Idempotency replay / payload conflict check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.serial_groupings
    WHERE owner_id = p_owner_id
      AND idempotency_key = p_idempotency_key
      AND status <> 'cancelled'
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      IF p_payload_hash IS NOT NULL
         AND v_existing.metadata->>'idempotencyHash' IS NOT NULL
         AND v_existing.metadata->>'idempotencyHash' <> p_payload_hash THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH: Idempotency key yang sama digunakan dengan payload grouping yang berbeda.'
          USING errcode = 'P0005';
      END IF;

      SELECT * INTO v_group FROM public.product_serials WHERE id = v_existing.result_serial_id AND owner_id = p_owner_id;
      SELECT * INTO v_doc FROM public.documents WHERE id = v_existing.source_document_id AND owner_id = p_owner_id;

      RETURN jsonb_build_object(
        'success', true,
        'isReplay', true,
        'group', to_jsonb(v_group),
        'grouping', to_jsonb(v_existing),
        'document', to_jsonb(v_doc),
        'groupSerialNumber', v_existing.grouping_number
      );
    END IF;
  END IF;

  -- Lock members (row-level) and validate count
  -- Deterministic lock order prevents deadlocks when two grouping requests
  -- share members but receive them in a different order.
  PERFORM id
  FROM public.product_serials
  WHERE owner_id = p_owner_id AND id = ANY(v_member_ids)
  ORDER BY id ASC
  FOR UPDATE;
  GET DIAGNOSTICS v_locked_count = ROW_COUNT;

  IF v_locked_count <> v_expected_count THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND: Satu atau lebih nomor seri tidak ditemukan atau milik tenant lain.' USING errcode = 'P0002';
  END IF;

  -- Availability / grouped / dissolved validation
  IF EXISTS (
    SELECT 1 FROM public.product_serials
    WHERE owner_id = p_owner_id AND id = ANY(v_member_ids)
      AND (
        status <> 'available'
        OR goods_out_document_id IS NOT NULL
        OR COALESCE((metadata->>'isGrouped')::boolean, false)
        OR (metadata->>'parentGroupId') IS NOT NULL
        OR COALESCE((metadata->>'isDissolved')::boolean, false)
      )
  ) THEN
    RAISE EXCEPTION 'CONCURRENT_CLAIM_OR_UNAVAILABLE: Nomor seri sudah tidak tersedia atau berada di group lain.' USING errcode = 'P0003';
  END IF;

  -- Warehouse isolation (legacy serials without warehouse_id remain allowed)
  IF p_warehouse_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.product_serials
      WHERE owner_id = p_owner_id AND id = ANY(v_member_ids)
        AND warehouse_id IS NOT NULL AND warehouse_id <> p_warehouse_id
    ) THEN
      RAISE EXCEPTION 'CROSS_WAREHOUSE_FORBIDDEN: Semua nomor seri harus berasal dari gudang yang sama.' USING errcode = 'P0001';
    END IF;
  END IF;

  -- Duplicate group serial number (case-insensitive, owner-scoped)
  IF EXISTS (
    SELECT 1 FROM public.product_serials
    WHERE owner_id = p_owner_id
      AND lower(btrim(serial_number)) = lower(btrim(p_group_serial_number))
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_GROUP_SERIAL: Nomor seri group "%" sudah pernah digunakan.', p_group_serial_number USING errcode = 'P0004';
  END IF;

  IF p_product_id IS NULL THEN
    RAISE EXCEPTION 'RESULT_PRODUCT_REQUIRED: Produk hasil grouping wajib ditentukan.' USING errcode = 'P0001';
  END IF;

  -- PHASE 7G — Product lock defense-in-depth.
  -- The service already enforces this, but a direct RPC call (service_role)
  -- must not be able to bypass the single-source business rule. Source
  -- products are derived from the locked rows in the database, never from
  -- the caller payload.
  SELECT count(DISTINCT product_id), (array_agg(DISTINCT product_id))[1]
  INTO v_distinct_source_products, v_source_product_id
  FROM public.product_serials
  WHERE owner_id = p_owner_id AND id = ANY(v_member_ids);

  IF v_distinct_source_products = 1
     AND p_product_id IS DISTINCT FROM v_source_product_id THEN
    RAISE EXCEPTION 'PRODUCT_LOCKED_SINGLE_SOURCE: Semua serial berasal dari satu produk sumber; produk hasil wajib mengikuti produk sumber.' USING errcode = 'P0006';
  END IF;

  v_meta := COALESCE(p_metadata, '{}'::jsonb);
  v_component_count := COALESCE(jsonb_array_length(COALESCE(p_components, '[]'::jsonb)), 0);

  -- Result serial
  INSERT INTO public.product_serials (owner_id, product_id, serial_number, status, warehouse_id, created_by, metadata)
  VALUES (p_owner_id, p_product_id, p_group_serial_number, 'available', p_warehouse_id, p_user_id, v_meta)
  RETURNING * INTO v_group;

  -- Deterministic document number (unique per owner because group SN is unique per owner)
  v_date_code := to_char((now() AT TIME ZONE 'Asia/Jakarta')::date, 'YYYYMMDD');
  v_doc_number := 'ASM-' || v_date_code || '-' || upper(regexp_replace(p_group_serial_number, '[^A-Za-z0-9_-]', '', 'g'));

  INSERT INTO public.documents (
    owner_id, warehouse_id, document_type, document_number, status, issue_date,
    subtotal, total, created_by, notes, metadata
  )
  VALUES (
    p_owner_id,
    p_warehouse_id,
    'goods_assembly',
    v_doc_number,
    'completed',
    (now() AT TIME ZONE 'Asia/Jakarta')::date,
    COALESCE(p_total_cost, 0),
    COALESCE(p_total_cost, 0),
    p_user_id,
    COALESCE(p_notes, CASE WHEN p_is_cross_product THEN 'Assembly penggabungan serial lintas produk' ELSE 'Assembly serial group produk sejenis' END),
    jsonb_build_object(
      'groupingNumber', p_group_serial_number,
      'resultProductId', p_product_id,
      'resultSerialId', v_group.id,
      'targetUnit', p_target_unit,
      'targetQty', p_target_qty,
      'totalBaseQtyPcs', p_total_base_qty_pcs,
      'totalCost', p_total_cost,
      'resultUnitCost', p_result_unit_cost,
      'isCrossProduct', p_is_cross_product,
      'idempotencyKey', p_idempotency_key
    )
  )
  RETURNING * INTO v_doc;

  -- Component OUT items
  FOR v_component IN SELECT * FROM jsonb_array_elements(COALESCE(p_components, '[]'::jsonb)) LOOP
    INSERT INTO public.document_items (
      document_id, product_id, item_name, sku, quantity, unit_price, amount, sort_order, metadata
    )
    VALUES (
      v_doc.id,
      NULLIF(v_component->>'component_product_id', '')::uuid,
      COALESCE(v_component->>'snapshot_product_name', 'Komponen Group'),
      COALESCE(v_component->>'snapshot_sku', ''),
      COALESCE((v_component->>'unit_qty')::numeric, 1),
      COALESCE((v_component->>'unit_cost')::numeric, 0),
      COALESCE((v_component->>'total_cost')::numeric, 0),
      COALESCE((v_component->>'sort_order')::int, 0),
      jsonb_build_object(
        'assemblyRole', 'component',
        'movementType', 'out',
        'serialId', v_component->>'component_serial_id',
        'serialNumber', v_component->>'component_serial_number',
        'unit', COALESCE(v_component->>'unit', 'pcs'),
        'qtyUnit', COALESCE(v_component->>'unit', 'pcs'),
        'qtyInput', COALESCE((v_component->>'unit_qty')::numeric, 1),
        'baseQtyPcs', COALESCE((v_component->>'base_qty_pcs')::numeric, 1),
        'isGroup', COALESCE((v_component->>'is_sub_group')::boolean, false)
      )
    );
  END LOOP;

  -- Result IN item
  INSERT INTO public.document_items (
    document_id, product_id, item_name, sku, quantity, unit_price, amount, sort_order, metadata
  )
  VALUES (
    v_doc.id,
    p_product_id,
    COALESCE(v_meta->>'resultProductName', 'Produk Hasil Grouping'),
    COALESCE(v_meta->>'resultProductSku', ''),
    COALESCE(p_target_qty, 1),
    COALESCE(p_result_unit_cost, 0),
    COALESCE(p_total_cost, 0),
    v_component_count + 1,
    jsonb_build_object(
      'assemblyRole', 'result',
      'movementType', 'in',
      'serialId', v_group.id,
      'serialNumber', p_group_serial_number,
      'unit', COALESCE(p_target_unit, 'pcs'),
      'qtyUnit', COALESCE(p_target_unit, 'pcs'),
      'qtyInput', COALESCE(p_target_qty, 1),
      'baseQtyPcs', COALESCE(p_total_base_qty_pcs, 1)
    )
  );

  -- Grouping header
  INSERT INTO public.serial_groupings (
    owner_id, grouping_number, warehouse_id, status, group_type,
    result_product_id, result_serial_id, result_serial_number,
    target_unit, target_qty, total_base_qty_pcs, total_cost, result_unit_cost,
    source_document_id, idempotency_key, notes, metadata, created_by
  )
  VALUES (
    p_owner_id,
    p_group_serial_number,
    p_warehouse_id,
    'active',
    CASE WHEN p_is_cross_product THEN 'mixed' ELSE 'single_product' END,
    p_product_id,
    v_group.id,
    p_group_serial_number,
    COALESCE(p_target_unit, 'pcs'),
    COALESCE(p_target_qty, 1),
    COALESCE(p_total_base_qty_pcs, 1),
    COALESCE(p_total_cost, 0),
    COALESCE(p_result_unit_cost, 0),
    v_doc.id,
    p_idempotency_key,
    p_notes,
    v_meta,
    p_user_id
  )
  RETURNING * INTO v_grouping;

  -- Component snapshot rows
  FOR v_component IN SELECT * FROM jsonb_array_elements(COALESCE(p_components, '[]'::jsonb)) LOOP
    INSERT INTO public.serial_grouping_components (
      grouping_id, owner_id, component_serial_id, component_serial_number, component_product_id,
      snapshot_product_name, snapshot_sku, unit, unit_qty, base_qty_pcs, unit_cost, total_cost,
      is_sub_group, nested_depth, sort_order, metadata
    )
    VALUES (
      v_grouping.id,
      p_owner_id,
      NULLIF(v_component->>'component_serial_id', '')::uuid,
      v_component->>'component_serial_number',
      NULLIF(v_component->>'component_product_id', '')::uuid,
      COALESCE(v_component->>'snapshot_product_name', 'Produk'),
      COALESCE(v_component->>'snapshot_sku', ''),
      COALESCE(v_component->>'unit', 'pcs'),
      COALESCE((v_component->>'unit_qty')::numeric, 1),
      COALESCE((v_component->>'base_qty_pcs')::numeric, 1),
      COALESCE((v_component->>'unit_cost')::numeric, 0),
      COALESCE((v_component->>'total_cost')::numeric, 0),
      COALESCE((v_component->>'is_sub_group')::boolean, false),
      COALESCE((v_component->>'nested_depth')::int, 1),
      COALESCE((v_component->>'sort_order')::int, 0),
      jsonb_build_object(
        'batchNumber', v_component->'metadata'->>'batchNumber',
        'preGroupStatus', COALESCE(v_component->'metadata'->>'preGroupStatus', 'available')
      )
    );
  END LOOP;

  -- Lock members to the created group (same transaction).
  -- `preGroupStatus` snapshots the availability state so ungroup can restore it.
  UPDATE public.product_serials
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'isGrouped', true,
        'parentGroupId', v_group.id,
        'parentGroupSerialNumber', p_group_serial_number,
        'groupedAt', now(),
        'groupedBy', p_user_id,
        'groupedByName', p_user_name,
        'preGroupStatus', COALESCE(NULLIF(status, 'available'), 'available')
      ),
      updated_at = now()
  WHERE owner_id = p_owner_id AND id = ANY(v_member_ids);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_CLAIM_OR_UNAVAILABLE: Gagal mengunci anggota group.' USING errcode = 'P0003';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'isReplay', false,
    'group', to_jsonb(v_group),
    'grouping', to_jsonb(v_grouping),
    'document', to_jsonb(v_doc),
    'groupSerialNumber', v_group.serial_number
  );
END;
$$;

-- 3. Full atomic ungroup RPC
CREATE OR REPLACE FUNCTION public.ungroup_serial_full_atomic_v1(
  p_owner_id uuid,
  p_user_id uuid,
  p_user_name text,
  p_group_id uuid,
  p_group_serial_number text,
  p_notes text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group public.product_serials%ROWTYPE;
  v_grouping public.serial_groupings%ROWTYPE;
  v_doc public.documents%ROWTYPE;
  v_member_ids uuid[];
  v_member public.product_serials%ROWTYPE;
  v_comp public.serial_grouping_components%ROWTYPE;
  v_replay_doc public.documents%ROWTYPE;
  v_released text[] := ARRAY[]::text[];
  v_date_code text;
  v_doc_number text;
  v_result_unit text;
  v_result_qty numeric;
  v_result_base numeric;
BEGIN
  IF p_owner_id IS NULL THEN
    RAISE EXCEPTION 'OWNER_REQUIRED: ownerId wajib disertakan.' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_group
  FROM public.product_serials
  WHERE owner_id = p_owner_id
    AND ((p_group_id IS NOT NULL AND id = p_group_id)
      OR (p_group_serial_number IS NOT NULL AND lower(btrim(serial_number)) = lower(btrim(p_group_serial_number))))
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Data group serial tidak ditemukan.' USING errcode = 'P0002';
  END IF;

  IF COALESCE((v_group.metadata->>'isGroup')::boolean, false) = false THEN
    RAISE EXCEPTION 'NOT_A_GROUP: Bukan group serial.' USING errcode = 'P0001';
  END IF;

  IF COALESCE((v_group.metadata->>'isGrouped')::boolean, false) OR (v_group.metadata->>'parentGroupId') IS NOT NULL THEN
    RAISE EXCEPTION 'NESTED_CHILD_GROUP: Bongkar group induk paling atas terlebih dahulu.' USING errcode = 'P0001';
  END IF;

  IF v_group.status = 'out' AND COALESCE((v_group.metadata->>'isDissolved')::boolean, false) = false THEN
    RAISE EXCEPTION 'ALREADY_DISPATCHED: Group sudah dikeluarkan dari gudang.' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_grouping
  FROM public.serial_groupings
  WHERE owner_id = p_owner_id
    AND (result_serial_id = v_group.id OR lower(btrim(grouping_number)) = lower(btrim(v_group.serial_number)))
  LIMIT 1
  FOR UPDATE;

  -- Idempotent replay: already reversed -> return the existing reversal document.
  IF FOUND AND v_grouping.status IN ('dissolved', 'cancelled') THEN
    SELECT * INTO v_replay_doc FROM public.documents
    WHERE id = v_grouping.reverse_document_id AND owner_id = p_owner_id;
    RETURN jsonb_build_object(
      'success', true,
      'isReplay', true,
      'unpackedGroup', to_jsonb(v_group),
      'grouping', to_jsonb(v_grouping),
      'document', to_jsonb(v_replay_doc),
      'documentId', v_grouping.reverse_document_id,
      'releasedCount', 0,
      'releasedSerials', '[]'::jsonb
    );
  END IF;

  -- Legacy group dissolved without a grouping header: idempotent replay too.
  IF COALESCE((v_group.metadata->>'isDissolved')::boolean, false) THEN
    RETURN jsonb_build_object(
      'success', true,
      'isReplay', true,
      'unpackedGroup', to_jsonb(v_group),
      'grouping', NULL,
      'document', NULL,
      'documentId', NULL,
      'releasedCount', 0,
      'releasedSerials', '[]'::jsonb
    );
  END IF;

  -- Resolve member ids: persistent component relation FIRST, metadata fallback.
  IF v_grouping.id IS NOT NULL THEN
    SELECT COALESCE(array_agg(component_serial_id ORDER BY sort_order), ARRAY[]::uuid[])
    INTO v_member_ids
    FROM public.serial_grouping_components
    WHERE owner_id = p_owner_id AND grouping_id = v_grouping.id;
  END IF;

  IF v_member_ids IS NULL OR array_length(v_member_ids, 1) IS NULL THEN
    SELECT COALESCE(array_agg((m->>'serialId')::uuid), ARRAY[]::uuid[])
    INTO v_member_ids
    FROM jsonb_array_elements(COALESCE(v_group.metadata->'directMembers', '[]'::jsonb)) AS m
    WHERE m->>'serialId' IS NOT NULL
      AND (m->>'serialId') ~* '^[0-9a-f-]{36}$';
  END IF;

  IF v_member_ids IS NULL OR array_length(v_member_ids, 1) IS NULL THEN
    SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_member_ids
    FROM public.product_serials
    WHERE owner_id = p_owner_id AND metadata->>'parentGroupId' = v_group.id::text;
  END IF;

  v_result_unit := COALESCE(v_grouping.target_unit, v_group.metadata->>'targetUnit', v_group.metadata->>'unit', 'pcs');
  v_result_qty := COALESCE(v_grouping.target_qty, (v_group.metadata->>'targetQty')::numeric, 1);
  v_result_base := COALESCE(v_grouping.total_base_qty_pcs, (v_group.metadata->>'totalPcs')::numeric, v_result_qty);

  v_date_code := to_char((now() AT TIME ZONE 'Asia/Jakarta')::date, 'YYYYMMDD');
  v_doc_number := 'GD-' || v_date_code || '-' || upper(regexp_replace(v_group.serial_number, '[^A-Za-z0-9_-]', '', 'g'))
    || '-' || left(replace(v_group.id::text, '-', ''), 8);

  INSERT INTO public.documents (
    owner_id, warehouse_id, document_type, document_number, status, issue_date,
    subtotal, total, created_by, notes, metadata
  )
  VALUES (
    p_owner_id,
    v_group.warehouse_id,
    'goods_disassembly',
    v_doc_number,
    'completed',
    (now() AT TIME ZONE 'Asia/Jakarta')::date,
    COALESCE(v_grouping.total_cost, 0),
    COALESCE(v_grouping.total_cost, 0),
    p_user_id,
    COALESCE(p_notes, 'Pembongkaran serial grouping ' || v_group.serial_number),
    jsonb_build_object(
      'originalGroupingId', v_grouping.id,
      'originalGroupingNumber', v_group.serial_number,
      'originalAssemblyDocumentId', v_grouping.source_document_id,
      'originalResultSerialId', v_group.id,
      'unpackedBy', p_user_id,
      'unpackedByName', p_user_name
    )
  )
  RETURNING * INTO v_doc;

  -- Result product OUT
  INSERT INTO public.document_items (
    document_id, product_id, item_name, sku, quantity, unit_price, amount, sort_order, metadata
  )
  VALUES (
    v_doc.id,
    v_group.product_id,
    COALESCE(v_group.metadata->>'resultProductName', 'Produk Jadi (Dibongkar)'),
    COALESCE(v_group.metadata->>'resultProductSku', ''),
    v_result_qty,
    COALESCE(v_grouping.result_unit_cost, 0),
    COALESCE(v_grouping.total_cost, 0),
    1,
    jsonb_build_object(
      'assemblyRole', 'result',
      'movementType', 'out',
      'serialNumber', v_group.serial_number,
      'unit', v_result_unit,
      'qtyUnit', v_result_unit,
      'qtyInput', v_result_qty,
      'baseQtyPcs', v_result_base
    )
  );

  -- Components IN + restore member to ORIGINAL product identity/status.
  FOR v_member IN
    SELECT * FROM public.product_serials
    WHERE owner_id = p_owner_id AND id = ANY(v_member_ids)
    ORDER BY id ASC
    FOR UPDATE
  LOOP
    -- Immutable component snapshot captured at grouping time (authoritative).
    IF v_grouping.id IS NOT NULL THEN
      SELECT * INTO v_comp FROM public.serial_grouping_components
      WHERE grouping_id = v_grouping.id AND component_serial_id = v_member.id AND owner_id = p_owner_id
      LIMIT 1;
    ELSE
      v_comp := NULL;
    END IF;

    INSERT INTO public.document_items (
      document_id, product_id, item_name, sku, quantity, unit_price, amount, sort_order, metadata
    )
    VALUES (
      v_doc.id,
      COALESCE(v_comp.component_product_id, v_member.product_id),
      COALESCE(v_comp.snapshot_product_name, v_member.metadata->>'productName', 'Komponen Dikembalikan'),
      COALESCE(v_comp.snapshot_sku, v_member.metadata->>'sku', ''),
      COALESCE(v_comp.unit_qty, (v_member.metadata->>'unitQty')::numeric, 1),
      COALESCE(v_comp.unit_cost, (v_member.metadata->>'unitCost')::numeric, 0),
      COALESCE(v_comp.total_cost, (v_member.metadata->>'totalCost')::numeric, 0),
      COALESCE(array_length(v_released, 1), 0) + 2,
      jsonb_build_object(
        'assemblyRole', 'component',
        'movementType', 'in',
        'serialId', v_member.id,
        'serialNumber', v_member.serial_number,
        'productId', COALESCE(v_comp.component_product_id, v_member.product_id),
        'unit', COALESCE(v_comp.unit, v_member.metadata->>'unit', 'pcs'),
        'qtyUnit', COALESCE(v_comp.unit, v_member.metadata->>'unit', 'pcs'),
        'qtyInput', COALESCE(v_comp.unit_qty, (v_member.metadata->>'unitQty')::numeric, 1),
        'baseQtyPcs', COALESCE(v_comp.base_qty_pcs, (v_member.metadata->>'totalPcs')::numeric, (v_member.metadata->>'pcs')::numeric, 1),
        'preGroupStatus', COALESCE(v_comp.metadata->>'preGroupStatus', v_member.metadata->>'preGroupStatus', 'available')
      )
    );

    UPDATE public.product_serials
    SET status = COALESCE(v_comp.metadata->>'preGroupStatus', v_member.metadata->>'preGroupStatus', 'available'),
        metadata = (COALESCE(metadata, '{}'::jsonb) - 'isGrouped' - 'parentGroupId' - 'parentGroupSerialNumber')
          || jsonb_build_object(
               'isGrouped', false,
               'parentGroupId', NULL,
               'parentGroupSerialNumber', NULL,
               'unpackedAt', now(),
               'unpackedBy', p_user_id,
               'unpackedByName', p_user_name
             ),
        updated_at = now()
    WHERE id = v_member.id AND owner_id = p_owner_id;

    v_released := array_append(v_released, v_member.serial_number);
  END LOOP;

  -- Deactivate the result serial with a terminal, auditable status.
  UPDATE public.product_serials
  SET status = 'dissolved',
      metadata = (COALESCE(metadata, '{}'::jsonb) - 'isGrouped' - 'parentGroupId')
        || jsonb_build_object(
             'isGrouped', false,
             'isDissolved', true,
             'dissolvedAt', now(),
             'dissolvedBy', p_user_id,
             'dissolvedByName', p_user_name
           ),
      updated_at = now()
  WHERE id = v_group.id AND owner_id = p_owner_id
  RETURNING * INTO v_group;

  IF v_grouping.id IS NOT NULL THEN
    UPDATE public.serial_groupings
    SET status = 'dissolved',
        reverse_document_id = v_doc.id,
        dissolved_at = now(),
        dissolved_by = p_user_id,
        updated_at = now()
    WHERE id = v_grouping.id AND owner_id = p_owner_id;
    v_grouping.status := 'dissolved';
    v_grouping.reverse_document_id := v_doc.id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'unpackedGroup', to_jsonb(v_group),
    'grouping', to_jsonb(v_grouping),
    'document', to_jsonb(v_doc),
    'documentId', v_doc.id,
    'releasedCount', COALESCE(array_length(v_released, 1), 0),
    'releasedSerials', to_jsonb(v_released)
  );
END;
$$;

-- 4. Execute privileges: service role only
REVOKE ALL ON FUNCTION public.create_serial_group_full_atomic_v1(
  uuid, uuid, text, uuid[], text, uuid, uuid, jsonb, text, numeric, numeric, numeric, numeric, boolean, text, text, text, jsonb
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.ungroup_serial_full_atomic_v1(
  uuid, uuid, text, uuid, text, text
) FROM PUBLIC;

DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION public.create_serial_group_full_atomic_v1(
    uuid, uuid, text, uuid[], text, uuid, uuid, jsonb, text, numeric, numeric, numeric, numeric, boolean, text, text, text, jsonb
  ) TO service_role;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION public.ungroup_serial_full_atomic_v1(
    uuid, uuid, text, uuid, text, text
  ) TO service_role;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
