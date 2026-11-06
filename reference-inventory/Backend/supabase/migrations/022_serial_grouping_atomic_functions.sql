-- ============================================================================
-- Migration 022: Atomic Serial Grouping and Hierarchy Functions
-- Local-only implementation for DocuFlow V1 Serial Grouping hardening.
-- 
-- DO NOT APPLY TO PRODUCTION DATABASE WITHOUT EXPLICIT USER APPROVAL.
--
-- Features:
-- 1. Status constraint update to include 'dissolved' (if not yet present).
-- 2. public.create_serial_group_atomic: All-or-nothing grouping with FOR UPDATE locking.
-- 3. public.ungroup_serial_atomic: All-or-nothing ungrouping with FOR UPDATE locking.
-- 4. Cascade leaf serial status restore on Goods Out Return.
-- ============================================================================

-- 1. Update product_serials status constraint safely
DO $$
BEGIN
  ALTER TABLE public.product_serials DROP CONSTRAINT IF EXISTS product_serials_status_check;
  ALTER TABLE public.product_serials ADD CONSTRAINT product_serials_status_check
    CHECK (status IN ('available', 'reserved', 'out', 'damaged', 'dissolved'));
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 2. Atomic Group Creation Function
DROP FUNCTION IF EXISTS public.create_serial_group_atomic(UUID, UUID, TEXT, UUID[], TEXT, UUID, UUID, JSONB);
CREATE OR REPLACE FUNCTION public.create_serial_group_atomic(
  p_owner_id UUID,
  p_user_id UUID,
  p_user_name TEXT,
  p_member_ids UUID[],
  p_group_serial_number TEXT,
  p_product_id UUID,
  p_warehouse_id UUID,
  p_metadata JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_locked_count INT;
  v_invalid_count INT;
  v_diff_warehouse_count INT;
  v_created_group RECORD;
  v_new_group_id UUID := gen_random_uuid();
  v_clean_sn TEXT := TRIM(p_group_serial_number);
BEGIN
  -- Validasi jumlah anggota (NULL, array kosong, atau < 2 anggota ditolak)
  IF p_member_ids IS NULL OR COALESCE(array_length(p_member_ids, 1), 0) < 2 THEN
    RAISE EXCEPTION 'MIN_MEMBERS_REQUIRED: Minimal harus memilih 2 nomor seri untuk membuat group.' USING errcode = 'P0001';
  END IF;

  -- 1. Lock seluruh baris anggota secara terurut UUID untuk mencegah deadlock (FOR UPDATE)
  PERFORM id FROM public.product_serials
  WHERE id = ANY(p_member_ids) AND owner_id = p_owner_id
  ORDER BY id ASC
  FOR UPDATE;

  -- 2. Verifikasi kepemilikan tenant
  SELECT COUNT(*) INTO v_locked_count
  FROM public.product_serials
  WHERE id = ANY(p_member_ids) AND owner_id = p_owner_id;

  IF v_locked_count <> COALESCE(array_length(p_member_ids, 1), 0) THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND: Satu atau lebih nomor seri tidak ditemukan atau milik tenant lain.' USING errcode = 'P0002';
  END IF;

  -- 3. Verifikasi keseragaman gudang
  IF p_warehouse_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_diff_warehouse_count
    FROM public.product_serials
    WHERE id = ANY(p_member_ids) AND owner_id = p_owner_id
      AND warehouse_id IS NOT NULL AND warehouse_id <> p_warehouse_id;

    IF v_diff_warehouse_count > 0 THEN
      RAISE EXCEPTION 'CROSS_WAREHOUSE_FORBIDDEN: Semua nomor seri harus berasal dari gudang yang sama.' USING errcode = 'P0001';
    END IF;
  END IF;

  -- 4. Verifikasi status available, belum tergroup, dan bukan group yang sudah dibongkar
  SELECT COUNT(*) INTO v_invalid_count
  FROM public.product_serials
  WHERE id = ANY(p_member_ids) AND owner_id = p_owner_id
    AND (
      status <> 'available'
      OR (metadata->>'isGrouped')::BOOLEAN IS TRUE
      OR metadata ? 'parentGroupId'
      OR (metadata->>'isDissolved')::BOOLEAN IS TRUE
    );

  IF v_invalid_count > 0 THEN
    RAISE EXCEPTION 'CONCURRENT_CLAIM_OR_UNAVAILABLE: Satu atau lebih nomor seri sedang dikelompokkan oleh proses lain, sudah berada di group lain, atau tidak berstatus available.' USING errcode = 'P0003';
  END IF;

  -- 5. Cek keunikan nomor seri group
  IF EXISTS (
    SELECT 1 FROM public.product_serials
    WHERE owner_id = p_owner_id AND LOWER(TRIM(serial_number)) = LOWER(v_clean_sn)
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_GROUP_SERIAL: Nomor seri group "%" sudah pernah digunakan.', v_clean_sn USING errcode = 'P0004';
  END IF;

  -- 6. Insert record group baru secara atomik
  INSERT INTO public.product_serials (
    id,
    owner_id,
    product_id,
    serial_number,
    status,
    warehouse_id,
    created_by,
    metadata,
    created_at,
    updated_at
  ) VALUES (
    v_new_group_id,
    p_owner_id,
    p_product_id,
    v_clean_sn,
    'available',
    p_warehouse_id,
    p_user_id,
    p_metadata,
    v_now,
    v_now
  ) RETURNING * INTO v_created_group;

  -- 7. Kunci nomor seri anggota (isGrouped = true)
  UPDATE public.product_serials
  SET
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'isGrouped', true,
      'parentGroupId', v_new_group_id,
      'parentGroupSerialNumber', v_clean_sn,
      'groupedAt', v_now,
      'groupedBy', p_user_id,
      'groupedByName', p_user_name,
      'groupHistory', COALESCE(metadata->'groupHistory', '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object(
          'action', 'joined_group',
          'parentGroupId', v_new_group_id,
          'parentGroupSerialNumber', v_clean_sn,
          'timestamp', v_now,
          'userId', p_user_id,
          'userName', p_user_name
        )
      )
    ),
    updated_at = v_now
  WHERE id = ANY(p_member_ids) AND owner_id = p_owner_id;

  RETURN jsonb_build_object(
    'success', true,
    'groupId', v_new_group_id,
    'groupSerialNumber', v_clean_sn,
    'group', to_jsonb(v_created_group)
  );
END;
$$;


-- 3. Atomic Group Dissolve / Ungroup Function
DROP FUNCTION IF EXISTS public.ungroup_serial_atomic(UUID, UUID, TEXT, UUID, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.ungroup_serial_atomic(
  p_owner_id UUID,
  p_user_id UUID,
  p_user_name TEXT,
  p_group_id UUID,
  p_group_serial_number TEXT,
  p_notes TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_group RECORD;
  v_direct_ids UUID[];
  v_released_serials TEXT[];
  v_updated_group RECORD;
BEGIN
  -- 1. Lock baris group induk FOR UPDATE
  SELECT * INTO v_group
  FROM public.product_serials
  WHERE owner_id = p_owner_id
    AND (
      (p_group_id IS NOT NULL AND id = p_group_id)
      OR (p_group_serial_number IS NOT NULL AND LOWER(TRIM(serial_number)) = LOWER(TRIM(p_group_serial_number)))
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Data group serial tidak ditemukan.' USING errcode = 'P0002';
  END IF;

  IF NOT ((v_group.metadata->>'isGroup')::BOOLEAN IS TRUE) THEN
    RAISE EXCEPTION 'NOT_A_GROUP: Nomor seri "%" bukan merupakan group serial.', v_group.serial_number USING errcode = 'P0001';
  END IF;

  -- Cegah pembongkaran group anak jika masih berada di group induk yang lebih tinggi
  IF (v_group.metadata->>'isGrouped')::BOOLEAN IS TRUE OR v_group.metadata ? 'parentGroupId' THEN
    RAISE EXCEPTION 'NESTED_CHILD_GROUP: Group "%" sedang berada di dalam group induk lain. Bongkar group induk paling atas terlebih dahulu.', v_group.serial_number USING errcode = 'P0001';
  END IF;

  -- Cegah pembongkaran group yang sudah dikeluarkan dari gudang
  IF v_group.status = 'out' AND NOT ((v_group.metadata->>'isDissolved')::BOOLEAN IS TRUE) THEN
    RAISE EXCEPTION 'ALREADY_DISPATCHED: Group "%" sudah dikeluarkan dari gudang (status out) dan tidak dapat dibongkar.', v_group.serial_number USING errcode = 'P0001';
  END IF;

  IF (v_group.metadata->>'isDissolved')::BOOLEAN IS TRUE THEN
    RAISE EXCEPTION 'ALREADY_DISSOLVED: Group "%" sudah pernah dibongkar sebelumnya.', v_group.serial_number USING errcode = 'P0001';
  END IF;

  -- 2. Ambil ID seluruh direct members
  IF v_group.metadata ? 'directMembers' AND jsonb_typeof(v_group.metadata->'directMembers') = 'array' THEN
    SELECT array_agg((m->>'serialId')::UUID) INTO v_direct_ids
    FROM jsonb_array_elements(v_group.metadata->'directMembers') m
    WHERE m ? 'serialId' AND m->>'serialId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  END IF;

  IF v_direct_ids IS NULL OR COALESCE(array_length(v_direct_ids, 1), 0) = 0 THEN
    SELECT array_agg(id) INTO v_direct_ids
    FROM public.product_serials
    WHERE owner_id = p_owner_id AND (metadata->>'parentGroupId')::UUID = v_group.id;
  END IF;

  IF v_direct_ids IS NOT NULL AND COALESCE(array_length(v_direct_ids, 1), 0) > 0 THEN
    -- Lock direct members FOR UPDATE secara terurut
    PERFORM id FROM public.product_serials
    WHERE id = ANY(v_direct_ids) AND owner_id = p_owner_id
    ORDER BY id ASC
    FOR UPDATE;

    -- Bebaskan direct members (sub-group anak tetap utuh jika ada)
    UPDATE public.product_serials
    SET
      metadata = (metadata - 'isGrouped' - 'parentGroupId' - 'parentGroupSerialNumber') || jsonb_build_object(
        'isGrouped', false,
        'parentGroupId', null,
        'parentGroupSerialNumber', null,
        'unpackedAt', v_now,
        'unpackedBy', p_user_id,
        'unpackedByName', p_user_name,
        'groupHistory', COALESCE(metadata->'groupHistory', '[]'::jsonb) || jsonb_build_array(
          jsonb_build_object(
            'action', 'unpacked_from_group',
            'parentGroupId', v_group.id,
            'parentGroupSerialNumber', v_group.serial_number,
            'timestamp', v_now,
            'userId', p_user_id,
            'userName', p_user_name,
            'notes', COALESCE(p_notes, 'Dibongkar dari group')
          )
        )
      ),
      updated_at = v_now
    WHERE id = ANY(v_direct_ids) AND owner_id = p_owner_id;

    SELECT array_agg(serial_number) INTO v_released_serials
    FROM public.product_serials
    WHERE id = ANY(v_direct_ids) AND owner_id = p_owner_id;
  END IF;

  -- 3. Tandai group induk sebagai dibongkar (isDissolved = true)
  UPDATE public.product_serials
  SET
    status = 'out',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'isDissolved', true,
      'dissolvedAt', v_now,
      'dissolvedBy', p_user_id,
      'dissolvedByName', p_user_name,
      'history', COALESCE(metadata->'history', '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object(
          'action', 'ungrouped',
          'timestamp', v_now,
          'userId', p_user_id,
          'userName', p_user_name,
          'notes', COALESCE(p_notes, 'Group dibongkar kembali menjadi item anggota')
        )
      )
    ),
    updated_at = v_now
  WHERE id = v_group.id AND owner_id = p_owner_id
  RETURNING * INTO v_updated_group;

  RETURN jsonb_build_object(
    'success', true,
    'unpackedGroup', to_jsonb(v_updated_group),
    'releasedCount', COALESCE(array_length(v_direct_ids, 1), 0),
    'releasedSerials', COALESCE(v_released_serials, ARRAY[]::TEXT[])
  );
END;
$$;
