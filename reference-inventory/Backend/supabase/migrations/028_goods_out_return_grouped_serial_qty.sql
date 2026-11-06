-- ============================================================================
-- Migration 028: Grouped serial quantity for Goods Out return / restore
-- Re-defines public.process_goods_out_return and public.restore_goods_out_return
-- so grouped result serials return/restore targetQty x targetUnit instead of 1.
-- Safe to apply on databases that already ran migration 019.
-- ============================================================================

-- Function 1: public.process_goods_out_return
DROP FUNCTION IF EXISTS public.process_goods_out_return(UUID, JSONB, UUID, UUID);
CREATE OR REPLACE FUNCTION public.process_goods_out_return(
  p_document_id UUID,
  p_payload JSONB,
  p_owner_id UUID,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_doc RECORD;
  v_doc_item RECORD;
  v_serial RECORD;
  v_prod RECORD;
  v_returns JSONB;
  v_return_id UUID := gen_random_uuid();
  v_seq INT;
  v_return_number TEXT;
  v_reason TEXT;
  v_notes TEXT;
  v_tx_target_status TEXT;
  v_tx_is_damaged BOOLEAN := false;
  v_item JSONB;
  v_item_condition TEXT;
  v_item_is_damaged BOOLEAN;
  v_sn_clean TEXT;
  v_req_qty NUMERIC;
  v_multiplier NUMERIC;
  v_delta NUMERIC;
  v_orig_base_pcs NUMERIC;
  v_prev_returned_base_pcs NUMERIC;
  v_remaining_base_pcs NUMERIC;
  v_req_base_pcs NUMERIC;
  v_items_recorded JSONB := '[]'::jsonb;
  v_new_return_record JSONB;
  v_is_unrecorded BOOLEAN := false;
  v_payload_unrecorded BOOLEAN;
  v_unit TEXT;
  v_item_prod_id UUID;
  v_payload_item_id UUID;
  v_is_group BOOLEAN := false;
  v_group_qty NUMERIC;
  v_group_unit TEXT;
  v_group_total_pcs NUMERIC;
  v_seen_serials TEXT[] := ARRAY[]::TEXT[];
  v_seen_items UUID[] := ARRAY[]::UUID[];
  v_seen_item_conditions TEXT[] := ARRAY[]::TEXT[];
  v_current_tx_item_pcs NUMERIC := 0;
  
  -- Variabel kalkulasi saldo produk (Bebas SQL NULL Trap & Bebas Fallback Diam-diam)
  v_cur_serials BIGINT;
  v_cur_nonserial BIGINT;
  v_cur_damaged BIGINT;
  v_actual_physical_serials BIGINT;

  -- Variabel penguncian di muka (Upfront Deterministic Lock)
  v_all_sn TEXT[] := ARRAY[]::TEXT[];
  v_all_prod_ids UUID[] := ARRAY[]::UUID[];
  v_candidate_item_ids UUID[] := ARRAY[]::UUID[];
  v_item_is_serial BOOLEAN;
  v_existing_r JSONB;
  v_existing_item JSONB;
BEGIN
  -- 0. Validasi Hirarkis Kontainer Payload Dasar
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'MALFORMED_PAYLOAD: Payload harus berupa objek JSON valid' USING errcode = 'P0001';
  END IF;

  IF NOT (p_payload ? 'items') THEN
    RAISE EXCEPTION 'MALFORMED_PAYLOAD: Field items wajib ada pada payload' USING errcode = 'P0001';
  END IF;

  IF jsonb_typeof(p_payload->'items') <> 'array' THEN
    RAISE EXCEPTION 'MALFORMED_PAYLOAD: Field items wajib berupa array JSON' USING errcode = 'P0001';
  END IF;

  IF jsonb_array_length(p_payload->'items') = 0 THEN
    RAISE EXCEPTION 'EMPTY_RETURN_ITEMS: Daftar item yang diretur tidak boleh kosong' USING errcode = 'P0001';
  END IF;

  v_reason := NULLIF(TRIM(p_payload->>'reason'), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED: Alasan retur wajib diisi' USING errcode = 'P0001';
  END IF;

  v_notes := NULLIF(TRIM(p_payload->>'notes'), '');
  
  -- Validasi targetStatus Transaksi (Strict Enum: available | damaged)
  IF p_payload ? 'targetStatus' THEN
    IF jsonb_typeof(p_payload->'targetStatus') <> 'string' 
       OR TRIM(p_payload->>'targetStatus') NOT IN ('available', 'damaged') THEN
      RAISE EXCEPTION 'INVALID_TARGET_STATUS: targetStatus transaksi harus bernilai "available" atau "damaged"' USING errcode = 'P0001';
    END IF;
    v_tx_target_status := TRIM(p_payload->>'targetStatus');
    v_tx_is_damaged := (v_tx_target_status = 'damaged');
  ELSE
    v_tx_target_status := NULL;
  END IF;

  -- Validasi boolean markAsDamaged transaksi secara defensif
  IF p_payload ? 'markAsDamaged' THEN
    IF jsonb_typeof(p_payload->'markAsDamaged') = 'boolean' THEN
      IF (p_payload->'markAsDamaged')::BOOLEAN THEN
        v_tx_is_damaged := true;
      END IF;
    ELSIF jsonb_typeof(p_payload->'markAsDamaged') = 'string' AND (p_payload->>'markAsDamaged') IN ('true', 'false') THEN
      IF (p_payload->>'markAsDamaged') = 'true' THEN
        v_tx_is_damaged := true;
      END IF;
    ELSE
      RAISE EXCEPTION 'INVALID_BOOLEAN_FORMAT: Field markAsDamaged harus berupa boolean valid' USING errcode = 'P0001';
    END IF;
  END IF;

  IF v_reason = 'lainnya' AND (v_notes IS NULL OR length(v_notes) < 3) THEN
    RAISE EXCEPTION 'NOTES_REQUIRED_FOR_REASON_LAINNYA: Catatan wajib diisi minimal 3 karakter saat alasan "Lainnya"' USING errcode = 'P0001';
  END IF;

  -- 1. Kunci Baris Dokumen Goods Out (Lock Level 1)
  SELECT * INTO v_doc FROM public.documents
  WHERE id = p_document_id AND owner_id = p_owner_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_FOUND: Dokumen tidak ditemukan atau bukan milik workspace ini' USING errcode = 'P0002';
  END IF;

  IF v_doc.document_type <> 'goods_out' THEN
    RAISE EXCEPTION 'INVALID_DOC_TYPE: Hanya dokumen goods_out yang dapat diretur' USING errcode = 'P0001';
  END IF;

  IF v_doc.status <> 'completed' THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_COMPLETED: Hanya dokumen berstatus completed yang dapat diretur' USING errcode = 'P0001';
  END IF;

  -- Validasi integritas kontainer metadata.returns
  IF v_doc.metadata ? 'returns' THEN
    IF jsonb_typeof(v_doc.metadata->'returns') <> 'array' THEN
      RAISE EXCEPTION 'CORRUPTED_RETURNS_METADATA: Kolom metadata.returns pada dokumen bukan berupa array JSON valid' USING errcode = 'P0001';
    END IF;
    v_returns := v_doc.metadata->'returns';
  ELSE
    v_returns := '[]'::jsonb;
  END IF;

  -- 2. Kumpulkan Seluruh Serial & ID Dokumen Item untuk Penguncian di Muka
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items')
  LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'MALFORMED_ITEM_PAYLOAD: Elemen item harus berupa objek JSON valid' USING errcode = 'P0001';
    END IF;

    -- Validasi isSerial defensif
    IF v_item ? 'isSerial' THEN
      IF jsonb_typeof(v_item->'isSerial') = 'boolean' THEN
        v_item_is_serial := (v_item->'isSerial')::BOOLEAN;
      ELSIF jsonb_typeof(v_item->'isSerial') = 'string' AND (v_item->>'isSerial') IN ('true', 'false') THEN
        v_item_is_serial := ((v_item->>'isSerial') = 'true');
      ELSE
        RAISE EXCEPTION 'INVALID_BOOLEAN_FORMAT: Field isSerial harus bernilai boolean valid' USING errcode = 'P0001';
      END IF;
    ELSE
      v_item_is_serial := false;
    END IF;

    IF v_item_is_serial THEN
      v_sn_clean := TRIM(v_item->>'serialNumber');
      IF v_sn_clean IS NOT NULL AND v_sn_clean <> '' THEN
        v_all_sn := array_append(v_all_sn, LOWER(v_sn_clean));
      END IF;
    END IF;

    IF v_item ? 'itemId' AND v_item->>'itemId' IS NOT NULL AND TRIM(v_item->>'itemId') <> '' THEN
      IF NOT (TRIM(v_item->>'itemId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        RAISE EXCEPTION 'INVALID_ITEM_ID_FORMAT: itemId "%" tidak berformat UUID valid', v_item->>'itemId' USING errcode = 'P0001';
      END IF;
      v_candidate_item_ids := array_append(v_candidate_item_ids, (TRIM(v_item->>'itemId'))::UUID);
    END IF;
  END LOOP;

  -- Kunci seluruh serial terpengaruh secara terurut abjad (Lock Level 2)
  IF array_length(v_all_sn, 1) > 0 THEN
    PERFORM id FROM public.product_serials
    WHERE owner_id = p_owner_id AND LOWER(TRIM(serial_number)) = ANY(v_all_sn)
    ORDER BY serial_number ASC
    FOR UPDATE;
  END IF;

  -- Ekstraksi dan kunci seluruh produk terpengaruh secara terurut UUID (Lock Level 3)
  SELECT array_agg(DISTINCT prod_id ORDER BY prod_id ASC) INTO v_all_prod_ids
  FROM (
    SELECT ps.product_id AS prod_id
    FROM public.product_serials ps
    WHERE ps.owner_id = p_owner_id AND LOWER(TRIM(ps.serial_number)) = ANY(v_all_sn)
      AND ps.product_id IS NOT NULL
    UNION
    SELECT di.product_id AS prod_id
    FROM public.document_items di
    WHERE di.id = ANY(v_candidate_item_ids) 
      AND di.document_id = p_document_id
      AND di.product_id IS NOT NULL
  ) p_sub;

  IF v_all_prod_ids IS NOT NULL AND array_length(v_all_prod_ids, 1) > 0 THEN
    PERFORM id FROM public.products
    WHERE id = ANY(v_all_prod_ids) AND owner_id = p_owner_id
    ORDER BY id ASC
    FOR UPDATE;
  END IF;

  -- 3. Penomoran Dokumen Retur dengan Validasi Ketat (Anti Silent Fallback)
  IF v_doc.metadata ? 'returnSeq' THEN
    IF jsonb_typeof(v_doc.metadata->'returnSeq') = 'null'
       OR v_doc.metadata->>'returnSeq' IS NULL
       OR NOT ((v_doc.metadata->>'returnSeq') ~ '^[0-9]{1,8}$') THEN
      RAISE EXCEPTION 'CORRUPTED_RETURNS_METADATA: returnSeq pada metadata dokumen korup atau bernilai NULL' USING errcode = 'P0001';
    END IF;
    v_seq := (v_doc.metadata->>'returnSeq')::INT + 1;
  ELSE
    -- Record warisan tanpa returnSeq
    v_seq := jsonb_array_length(v_returns) + 1;
  END IF;

  LOOP
    v_return_number := 'RET-' || v_doc.document_number || '-R' || LPAD(v_seq::TEXT, 2, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_returns) r WHERE r->>'returnNumber' = v_return_number
    );
    v_seq := v_seq + 1;
  END LOOP;

  -- 4. Iterasi Pemrosesan Seluruh Item Retur
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items')
  LOOP
    -- Evaluasi kondisi per-item secara ketat tanpa fallback diam-diam
    IF v_item ? 'targetStatus' THEN
      IF jsonb_typeof(v_item->'targetStatus') <> 'string' 
         OR TRIM(v_item->>'targetStatus') NOT IN ('available', 'damaged') THEN
        RAISE EXCEPTION 'INVALID_ITEM_CONDITION: targetStatus item harus "available" atau "damaged"' USING errcode = 'P0001';
      END IF;
      v_item_condition := TRIM(v_item->>'targetStatus');
    ELSIF v_item ? 'markAsDamaged' THEN
      IF jsonb_typeof(v_item->'markAsDamaged') = 'boolean' THEN
        v_item_condition := CASE WHEN (v_item->'markAsDamaged')::BOOLEAN THEN 'damaged' ELSE 'available' END;
      ELSIF jsonb_typeof(v_item->'markAsDamaged') = 'string' AND (v_item->>'markAsDamaged') IN ('true', 'false') THEN
        v_item_condition := CASE WHEN (v_item->>'markAsDamaged') = 'true' THEN 'damaged' ELSE 'available' END;
      ELSE
        RAISE EXCEPTION 'INVALID_BOOLEAN_FORMAT: Field markAsDamaged pada item harus boolean valid' USING errcode = 'P0001';
      END IF;
    ELSIF v_tx_target_status IS NOT NULL THEN
      v_item_condition := v_tx_target_status;
    ELSIF v_tx_is_damaged THEN
      v_item_condition := 'damaged';
    ELSE
      v_item_condition := 'available';
    END IF;

    v_item_is_damaged := (v_item_condition = 'damaged');

    -- Validasi isSerial defensif
    IF v_item ? 'isSerial' THEN
      IF jsonb_typeof(v_item->'isSerial') = 'boolean' THEN
        v_item_is_serial := (v_item->'isSerial')::BOOLEAN;
      ELSIF jsonb_typeof(v_item->'isSerial') = 'string' AND (v_item->>'isSerial') IN ('true', 'false') THEN
        v_item_is_serial := ((v_item->>'isSerial') = 'true');
      ELSE
        RAISE EXCEPTION 'INVALID_BOOLEAN_FORMAT: Field isSerial harus bernilai boolean valid' USING errcode = 'P0001';
      END IF;
    ELSE
      v_item_is_serial := false;
    END IF;

    -- ========================================================================
    -- A. PEMROSESAN BARANG SERIAL
    -- ========================================================================
    IF v_item_is_serial THEN
      v_sn_clean := TRIM(v_item->>'serialNumber');

      IF v_sn_clean IS NULL OR v_sn_clean = '' THEN
        RAISE EXCEPTION 'SERIAL_NUMBER_REQUIRED: Baris serial wajib memiliki nomor seri yang valid' USING errcode = 'P0001';
      END IF;

      -- Proteksi serial duplikat di satu payload
      IF LOWER(v_sn_clean) = ANY(v_seen_serials) THEN
        RAISE EXCEPTION 'DUPLICATE_SERIAL_IN_PAYLOAD:%', v_sn_clean USING errcode = 'P0001';
      END IF;
      v_seen_serials := array_append(v_seen_serials, LOWER(v_sn_clean));

      -- Validasi Serial Belum Pernah Diretur pada Retur Aktif
      FOR v_existing_r IN SELECT * FROM jsonb_array_elements(v_returns)
      LOOP
        IF jsonb_typeof(v_existing_r) = 'object' AND COALESCE(v_existing_r->>'status', 'active') <> 'restored' THEN
          IF NOT (v_existing_r ? 'items') OR jsonb_typeof(v_existing_r->'items') <> 'array' THEN
            RAISE EXCEPTION 'CORRUPTED_RETURNS_METADATA: Record retur historis tidak memiliki array items yang valid' USING errcode = 'P0001';
          END IF;

          FOR v_existing_item IN SELECT * FROM jsonb_array_elements(v_existing_r->'items')
          LOOP
            IF jsonb_typeof(v_existing_item) = 'object' 
               AND (COALESCE(v_existing_item->>'isSerial', 'false') = 'true') 
               AND LOWER(TRIM(COALESCE(v_existing_item->>'serialNumber', ''))) = LOWER(v_sn_clean) THEN
              RAISE EXCEPTION 'SERIAL_ALREADY_RETURNED:% (Nomor seri sudah pernah diretur pada transaksi aktif)', v_sn_clean USING errcode = 'P0001';
            END IF;
          END LOOP;
        END IF;
      END LOOP;

      -- Ambil Data Serial
      SELECT * INTO v_serial FROM public.product_serials
      WHERE owner_id = p_owner_id
        AND LOWER(TRIM(serial_number)) = LOWER(v_sn_clean);

      IF NOT FOUND THEN
        RAISE EXCEPTION 'SERIAL_NOT_FOUND:% (Nomor seri tidak terdaftar di sistem)', v_sn_clean USING errcode = 'P0002';
      END IF;

      -- Validasi Kepemilikan Dokumen & Gudang
      IF v_serial.goods_out_document_id IS DISTINCT FROM p_document_id THEN
        RAISE EXCEPTION 'SERIAL_NOT_DISPATCHED_IN_THIS_DOC:% (Nomor seri tidak dikeluarkan oleh surat jalan ini)', v_sn_clean USING errcode = 'P0001';
      END IF;

      IF v_serial.status <> 'out' THEN
        RAISE EXCEPTION 'SERIAL_INVALID_STATUS:% (Status nomor seri saat ini: %, seharusnya "out")', v_sn_clean, v_serial.status USING errcode = 'P0001';
      END IF;

      IF v_doc.warehouse_id IS NOT NULL THEN
        IF v_serial.warehouse_id IS NULL OR v_serial.warehouse_id <> v_doc.warehouse_id THEN
          RAISE EXCEPTION 'SERIAL_WAREHOUSE_MISMATCH: Serial % berada di gudang %, surat jalan di gudang %',
            v_sn_clean, COALESCE(v_serial.warehouse_id::text, 'NULL'), v_doc.warehouse_id USING errcode = 'P0001';
        END IF;
      END IF;

      -- Validasi Format Item ID Payload jika Dikirim
      IF v_item ? 'itemId' AND v_item->>'itemId' IS NOT NULL AND TRIM(v_item->>'itemId') <> '' THEN
        IF NOT (TRIM(v_item->>'itemId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
          RAISE EXCEPTION 'INVALID_ITEM_ID_FORMAT: itemId serial tidak berformat UUID valid' USING errcode = 'P0001';
        END IF;
        v_payload_item_id := (v_item->>'itemId')::UUID;
      ELSE
        v_payload_item_id := NULL;
      END IF;

      -- Resolusi Baris Dokumen Item Sumber Secara Eksklusif (Termasuk Keputusan Owner: Serial Warisan Manual Selection)
      IF v_serial.goods_out_item_id IS NOT NULL THEN
        SELECT * INTO v_doc_item FROM public.document_items
        WHERE id = v_serial.goods_out_item_id AND document_id = p_document_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'SOURCE_ITEM_NOT_FOUND_FOR_SERIAL:% (Item dokumen asal % tidak ditemukan)', v_sn_clean, v_serial.goods_out_item_id USING errcode = 'P0002';
        END IF;

        IF v_payload_item_id IS NOT NULL AND v_payload_item_id <> v_serial.goods_out_item_id THEN
          RAISE EXCEPTION 'ITEM_PAYLOAD_MISMATCH_WITH_SERIAL_RECORD:% (itemId payload tidak cocok dengan serial)', v_sn_clean USING errcode = 'P0001';
        END IF;
      ELSE
        -- Keputusan Owner A: Operator memilih item dokumen secara manual jika serial lama belum memiliki goods_out_item_id
        IF v_payload_item_id IS NULL THEN
          RAISE EXCEPTION 'CANNOT_IDENTIFY_SOURCE_DOCUMENT_ITEM_FOR_SERIAL:% (itemId wajib disertakan pada serial warisan)', v_sn_clean USING errcode = 'P0001';
        END IF;

        SELECT * INTO v_doc_item FROM public.document_items
        WHERE id = v_payload_item_id AND document_id = p_document_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'SOURCE_ITEM_NOT_FOUND_FOR_SERIAL:% (Item dokumen asal tidak ditemukan)', v_sn_clean USING errcode = 'P0002';
        END IF;
      END IF;

      -- Sumber Kebenaran Status Unrecorded Berasal MURNI dari Dokumen Asal
      v_is_unrecorded := false;
      IF v_doc_item.metadata ? 'isUnrecorded' THEN
        IF jsonb_typeof(v_doc_item.metadata->'isUnrecorded') = 'boolean' THEN
          v_is_unrecorded := (v_doc_item.metadata->'isUnrecorded')::BOOLEAN;
        ELSIF (v_doc_item.metadata->>'isUnrecorded') IN ('true', 'false') THEN
          v_is_unrecorded := ((v_doc_item.metadata->>'isUnrecorded') = 'true');
        ELSE
          RAISE EXCEPTION 'CORRUPTED_DOCUMENT_ITEM_METADATA: isUnrecorded pada item dokumen korup' USING errcode = 'P0001';
        END IF;
      ELSIF v_doc_item.metadata ? 'isUnrecordedStock' THEN
        IF jsonb_typeof(v_doc_item.metadata->'isUnrecordedStock') = 'boolean' THEN
          v_is_unrecorded := (v_doc_item.metadata->'isUnrecordedStock')::BOOLEAN;
        ELSIF (v_doc_item.metadata->>'isUnrecordedStock') IN ('true', 'false') THEN
          v_is_unrecorded := ((v_doc_item.metadata->>'isUnrecordedStock') = 'true');
        ELSE
          RAISE EXCEPTION 'CORRUPTED_DOCUMENT_ITEM_METADATA: isUnrecordedStock pada item dokumen korup' USING errcode = 'P0001';
        END IF;
      END IF;

      IF v_item ? 'isUnrecorded' THEN
        IF jsonb_typeof(v_item->'isUnrecorded') = 'boolean' THEN
          v_payload_unrecorded := (v_item->'isUnrecorded')::BOOLEAN;
        ELSIF (v_item->>'isUnrecorded') IN ('true', 'false') THEN
          v_payload_unrecorded := ((v_item->>'isUnrecorded') = 'true');
        ELSE
          RAISE EXCEPTION 'INVALID_BOOLEAN_FORMAT: Field isUnrecorded harus bernilai boolean valid' USING errcode = 'P0001';
        END IF;
        IF v_payload_unrecorded <> v_is_unrecorded THEN
          RAISE EXCEPTION 'UNRECORDED_STATUS_CONFLICT: Status isUnrecorded pada payload bertentangan dengan surat jalan asal' USING errcode = 'P0001';
        END IF;
      END IF;

      -- Validasi Keselarasan Produk Secara Ketat (Fail-Closed)
      IF NOT v_is_unrecorded THEN
        IF v_serial.product_id IS NULL OR v_doc_item.product_id IS NULL OR v_serial.product_id <> v_doc_item.product_id THEN
          RAISE EXCEPTION 'SERIAL_PRODUCT_MISMATCH:% (Produk pada serial [%] tidak cocok dengan surat jalan [%])',
            v_sn_clean, COALESCE(v_serial.product_id::text, 'NULL'), COALESCE(v_doc_item.product_id::text, 'NULL') USING errcode = 'P0001';
        END IF;
        v_item_prod_id := v_doc_item.product_id;
      ELSE
        v_item_prod_id := NULL;
      END IF;

      v_is_group := LOWER(COALESCE(v_doc_item.metadata->>'isGroup', 'false')) = 'true'
        OR LOWER(COALESCE(v_serial.metadata->>'isGroup', 'false')) = 'true';

      IF v_is_group THEN
        v_group_qty := COALESCE(
          NULLIF(v_doc_item.metadata->>'targetQty', '')::NUMERIC,
          NULLIF(v_serial.metadata->>'targetQty', '')::NUMERIC,
          NULLIF(v_doc_item.metadata->>'qtyInput', '')::NUMERIC,
          1
        );
        IF v_group_qty IS NULL OR v_group_qty <= 0 THEN
          v_group_qty := 1;
        END IF;

        v_group_unit := COALESCE(
          NULLIF(v_doc_item.metadata->>'targetUnit', ''),
          NULLIF(v_serial.metadata->>'targetUnit', ''),
          NULLIF(v_serial.metadata->>'serialUnit', ''),
          NULLIF(v_doc_item.metadata->>'qtyUnit', ''),
          'pcs'
        );
        v_group_total_pcs := COALESCE(
          NULLIF(v_doc_item.metadata->>'totalPcs', '')::NUMERIC,
          NULLIF(v_serial.metadata->>'totalPcs', '')::NUMERIC
        );
        v_unit := v_group_unit;
      ELSE
        v_group_qty := 1;
        v_group_total_pcs := NULL;
        v_unit := COALESCE(v_serial.metadata->>'serialUnit', v_doc_item.metadata->>'qtyUnit', 'pcs');
      END IF;

      v_multiplier := public.inventory_unit_multiplier(p_owner_id, v_doc.warehouse_id, v_unit);
      IF v_multiplier IS NULL OR v_multiplier <= 0 THEN
        RAISE EXCEPTION 'INVALID_UNIT_MULTIPLIER: Satuan % menghasilkan multiplier tidak valid', v_unit USING errcode = 'P0001';
      END IF;
      v_delta := v_group_qty * v_multiplier;
      IF v_is_group AND (v_group_total_pcs IS NULL OR v_group_total_pcs <= 0) THEN
        v_group_total_pcs := v_delta;
      END IF;

      IF v_delta <> TRUNC(v_delta) THEN
        RAISE EXCEPTION 'FRACTIONAL_BASE_PCS_NOT_ALLOWED: Multiplier serial harus menghasilkan bilangan bulat utuh' USING errcode = 'P0001';
      END IF;

      -- Mutasi Status Serial & Simpan Relasi Buka Segel ke Metadata
      UPDATE public.product_serials SET
        status = CASE WHEN v_item_is_damaged THEN 'damaged' ELSE 'available' END,
        goods_out_document_id = NULL,
        goods_out_item_id = NULL,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'returnedAt', now(),
          'returnedFrom', v_doc.document_number,
          'returnedFromDocId', p_document_id,
          'returnedFromItemId', v_doc_item.id,
          'returnNumber', v_return_number,
          'returnReason', v_reason
        ),
        updated_at = now()
      WHERE id = v_serial.id;

      -- Mutasi Stok Produk Tanpa SQL NULL Trap & Tanpa Fallback Diam-diam
      IF NOT v_is_unrecorded THEN
        IF v_item_prod_id IS NULL THEN
          RAISE EXCEPTION 'RECORDED_SERIAL_MISSING_PRODUCT_ID:% (Barang tercatat wajib memiliki ID produk sah)', v_sn_clean USING errcode = 'P0001';
        END IF;

        SELECT * INTO v_prod FROM public.products
        WHERE id = v_item_prod_id AND owner_id = p_owner_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'PRODUCT_NOT_FOUND:% (Produk tidak ditemukan di sistem)', v_item_prod_id USING errcode = 'P0002';
        END IF;

        IF NOT v_item_is_damaged THEN
          -- Validasi stockSerials dengan membedakan 3 keadaan (Legacy vs NULL vs Invalid)
          IF NOT (v_prod.metadata ? 'stockSerials') THEN
            -- Keadaan 1: Legacy record sah tanpa key -> hitung dari fisik riil terisolasi warehouse
            -- Karena status serial saat ini sudah dimutasi menjadi available di baris atas,
            -- v_actual_physical_serials sudah mencakup v_delta, sehingga baseline adalah saldo sebelum ditambah v_delta
            SELECT COALESCE(SUM(public.inventory_unit_multiplier(p_owner_id, v_doc.warehouse_id, metadata->>'serialUnit')), 0)::BIGINT
            INTO v_actual_physical_serials
            FROM public.product_serials
            WHERE product_id = v_prod.id AND owner_id = p_owner_id AND warehouse_id = v_doc.warehouse_id AND status = 'available';
            v_cur_serials := v_actual_physical_serials - v_delta::BIGINT;
          ELSIF jsonb_typeof(v_prod.metadata->'stockSerials') = 'null' 
                OR v_prod.metadata->>'stockSerials' IS NULL 
                OR NOT ((v_prod.metadata->>'stockSerials') ~ '^[0-9]{1,10}$') THEN
            -- Keadaan 2 & 3: Korup (JSON null atau bukan format integer bulat non-negatif)
            RAISE EXCEPTION 'CORRUPTED_PRODUCT_METADATA: Field stockSerials pada produk % bernilai NULL atau korup ("%")', 
              v_prod.name, COALESCE(v_prod.metadata->>'stockSerials', 'null') USING errcode = 'P0001';
          ELSE
            v_cur_serials := (v_prod.metadata->>'stockSerials')::BIGINT;
          END IF;

          -- Proteksi integer overflow pada products.stock INTEGER
          IF (v_prod.stock::BIGINT + v_delta::BIGINT) > 2147483647 THEN
            RAISE EXCEPTION 'STOCK_INTEGER_OVERFLOW: Penambahan stok melebihi batas maksimum integer' USING errcode = 'P0001';
          END IF;

          UPDATE public.products SET
            stock = stock + v_delta::INT,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'stockSerials', (v_cur_serials + v_delta::BIGINT)
            ),
            updated_at = now()
          WHERE id = v_prod.id;
        ELSE
          -- Validasi stockDamaged dengan membedakan 3 keadaan
          IF NOT (v_prod.metadata ? 'stockDamaged') THEN
            v_cur_damaged := 0;
          ELSIF jsonb_typeof(v_prod.metadata->'stockDamaged') = 'null' 
                OR v_prod.metadata->>'stockDamaged' IS NULL 
                OR NOT ((v_prod.metadata->>'stockDamaged') ~ '^[0-9]{1,10}$') THEN
            RAISE EXCEPTION 'CORRUPTED_PRODUCT_METADATA: Field stockDamaged pada produk % bernilai NULL atau korup ("%")', 
              v_prod.name, COALESCE(v_prod.metadata->>'stockDamaged', 'null') USING errcode = 'P0001';
          ELSE
            v_cur_damaged := (v_prod.metadata->>'stockDamaged')::BIGINT;
          END IF;

          UPDATE public.products SET
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'stockDamaged', (v_cur_damaged + v_delta::BIGINT)
            ),
            updated_at = now()
          WHERE id = v_prod.id;
        END IF;
      END IF;

      -- Catat Item Serial ke Array Return
      v_items_recorded := v_items_recorded || jsonb_build_object(
        'itemId', v_doc_item.id::TEXT,
        'productId', v_item_prod_id::TEXT,
        'productName', COALESCE(v_doc_item.item_name, 'Produk Serial'),
        'sku', COALESCE(v_doc_item.sku, ''),
        'isSerial', true,
        'isGroup', v_is_group,
        'serialNumber', v_sn_clean,
        'returnedQty', v_group_qty,
        'qtyUnit', v_unit,
        'targetQty', v_group_qty,
        'targetUnit', v_unit,
        'totalPcs', v_group_total_pcs::INT,
        'baseQuantityPcs', v_delta::INT,
        'condition', v_item_condition,
        'isUnrecorded', v_is_unrecorded
      );

    -- ========================================================================
    -- B. PEMROSESAN BARANG NON-SERIAL
    -- ========================================================================
    ELSE
      -- Validasi Kuantitas & Batas Skala
      IF v_item->>'returnedQty' IS NULL OR NOT (TRIM(v_item->>'returnedQty') ~ '^[0-9]{1,10}(\.[0-9]{1,4})?$') THEN
        RAISE EXCEPTION 'INVALID_QTY_FORMAT: returnedQty harus berupa angka desimal positif (maks 10 digit, 4 desimal)' USING errcode = 'P0001';
      END IF;
      v_req_qty := (TRIM(v_item->>'returnedQty'))::NUMERIC;
      IF v_req_qty <= 0 THEN
        RAISE EXCEPTION 'ZERO_OR_NEGATIVE_QTY: returnedQty harus lebih besar dari 0' USING errcode = 'P0001';
      END IF;

      -- Validasi Item ID
      IF v_item->>'itemId' IS NULL OR NOT (TRIM(v_item->>'itemId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        RAISE EXCEPTION 'INVALID_ITEM_ID_FORMAT: Baris non-serial wajib menyertakan itemId format UUID valid' USING errcode = 'P0001';
      END IF;

      -- Ambil Baris Dokumen Item Asal
      SELECT * INTO v_doc_item FROM public.document_items
      WHERE id = (TRIM(v_item->>'itemId'))::UUID AND document_id = p_document_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'DOCUMENT_ITEM_NOT_FOUND:% (Item tidak ditemukan pada dokumen Goods Out ini)', v_item->>'itemId' USING errcode = 'P0002';
      END IF;

      -- Proteksi Item Serial Diretur sebagai Non-Serial
      IF (v_doc_item.metadata ? 'isSerial' AND (
            (jsonb_typeof(v_doc_item.metadata->'isSerial') = 'boolean' AND (v_doc_item.metadata->'isSerial')::BOOLEAN)
            OR (v_doc_item.metadata->>'isSerial') = 'true'
         )) THEN
        RAISE EXCEPTION 'ITEM_IS_SERIAL_USE_SERIAL_RETURN:% (Item ini bertipe serial, wajib diretur melalui pemindaian nomor seri)', v_doc_item.item_name USING errcode = 'P0001';
      END IF;

      -- Proteksi duplikasi itemId + kondisi yang sama di payload
      IF (v_doc_item.id::TEXT || '_' || v_item_condition) = ANY(v_seen_item_conditions) THEN
        RAISE EXCEPTION 'DUPLICATE_ITEM_CONDITION_IN_PAYLOAD:% (Item dengan kondisi % tidak boleh diinput berulang)', v_doc_item.item_name, v_item_condition USING errcode = 'P0001';
      END IF;
      v_seen_item_conditions := array_append(v_seen_item_conditions, (v_doc_item.id::TEXT || '_' || v_item_condition));

      -- Sumber Kebenaran Status Unrecorded Berasal MURNI dari Dokumen Asal
      v_is_unrecorded := false;
      IF v_doc_item.metadata ? 'isUnrecorded' THEN
        IF jsonb_typeof(v_doc_item.metadata->'isUnrecorded') = 'boolean' THEN
          v_is_unrecorded := (v_doc_item.metadata->'isUnrecorded')::BOOLEAN;
        ELSIF (v_doc_item.metadata->>'isUnrecorded') IN ('true', 'false') THEN
          v_is_unrecorded := ((v_doc_item.metadata->>'isUnrecorded') = 'true');
        ELSE
          RAISE EXCEPTION 'CORRUPTED_DOCUMENT_ITEM_METADATA: isUnrecorded pada item dokumen korup' USING errcode = 'P0001';
        END IF;
      ELSIF v_doc_item.metadata ? 'isUnrecordedStock' THEN
        IF jsonb_typeof(v_doc_item.metadata->'isUnrecordedStock') = 'boolean' THEN
          v_is_unrecorded := (v_doc_item.metadata->'isUnrecordedStock')::BOOLEAN;
        ELSIF (v_doc_item.metadata->>'isUnrecordedStock') IN ('true', 'false') THEN
          v_is_unrecorded := ((v_doc_item.metadata->>'isUnrecordedStock') = 'true');
        ELSE
          RAISE EXCEPTION 'CORRUPTED_DOCUMENT_ITEM_METADATA: isUnrecordedStock pada item dokumen korup' USING errcode = 'P0001';
        END IF;
      END IF;

      IF v_item ? 'isUnrecorded' THEN
        IF jsonb_typeof(v_item->'isUnrecorded') = 'boolean' THEN
          v_payload_unrecorded := (v_item->'isUnrecorded')::BOOLEAN;
        ELSIF (v_item->>'isUnrecorded') IN ('true', 'false') THEN
          v_payload_unrecorded := ((v_item->>'isUnrecorded') = 'true');
        ELSE
          RAISE EXCEPTION 'INVALID_BOOLEAN_FORMAT: Field isUnrecorded harus bernilai boolean valid' USING errcode = 'P0001';
        END IF;
        IF v_payload_unrecorded <> v_is_unrecorded THEN
          RAISE EXCEPTION 'UNRECORDED_STATUS_CONFLICT: Status isUnrecorded pada payload bertentangan dengan surat jalan asal' USING errcode = 'P0001';
        END IF;
      END IF;

      v_unit := COALESCE(v_doc_item.metadata->>'qtyUnit', v_item->>'qtyUnit', 'pcs');
      v_multiplier := public.inventory_unit_multiplier(p_owner_id, v_doc.warehouse_id, v_unit);
      IF v_multiplier IS NULL OR v_multiplier <= 0 THEN
        RAISE EXCEPTION 'INVALID_UNIT_MULTIPLIER: Satuan % menghasilkan multiplier tidak valid', v_unit USING errcode = 'P0001';
      END IF;
      v_delta := v_req_qty * v_multiplier;

      IF v_delta <> TRUNC(v_delta) THEN
        RAISE EXCEPTION 'FRACTIONAL_BASE_PCS_NOT_ALLOWED: Kuantitas retur dalam satuan dasar pcs menghasilkan pecahan (%). Gudang hanya menerima satuan utuh.', v_delta
          USING errcode = 'P0001';
      END IF;

      v_item_prod_id := v_doc_item.product_id;

      -- Hitung Kuantitas Asli (Base Pcs)
      v_orig_base_pcs := CASE 
        WHEN (v_doc_item.metadata->>'baseQuantity') ~ '^[0-9]{1,10}(\.[0-9]{1,4})?$' 
          THEN (v_doc_item.metadata->>'baseQuantity')::NUMERIC
        WHEN (v_doc_item.metadata->>'qtyInput') ~ '^[0-9]{1,10}(\.[0-9]{1,4})?$' 
          THEN (v_doc_item.metadata->>'qtyInput')::NUMERIC * v_multiplier
        ELSE COALESCE(v_doc_item.quantity, 0) * v_multiplier
      END;

      -- Hitung Total Retur Aktif Terdahulu untuk Item Ini
      v_prev_returned_base_pcs := 0;
      FOR v_existing_r IN SELECT * FROM jsonb_array_elements(v_returns)
      LOOP
        IF jsonb_typeof(v_existing_r) = 'object' AND COALESCE(v_existing_r->>'status', 'active') <> 'restored' THEN
          IF NOT (v_existing_r ? 'items') OR jsonb_typeof(v_existing_r->'items') <> 'array' THEN
            RAISE EXCEPTION 'CORRUPTED_RETURNS_METADATA: Record retur historis tidak memiliki array items yang valid' USING errcode = 'P0001';
          END IF;

          FOR v_existing_item IN SELECT * FROM jsonb_array_elements(v_existing_r->'items')
          LOOP
            IF jsonb_typeof(v_existing_item) = 'object' 
               AND (v_existing_item ? 'itemId')
               AND (v_existing_item->>'itemId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               AND (v_existing_item->>'itemId')::UUID = v_doc_item.id 
               AND NOT (COALESCE(v_existing_item->>'isSerial', 'false') = 'true') THEN
              IF (v_existing_item->>'returnedQty') ~ '^[0-9]{1,10}(\.[0-9]{1,4})?$' THEN
                v_prev_returned_base_pcs := v_prev_returned_base_pcs + 
                  ((v_existing_item->>'returnedQty')::NUMERIC * public.inventory_unit_multiplier(p_owner_id, v_doc.warehouse_id, v_existing_item->>'qtyUnit'));
              END IF;
            END IF;
          END LOOP;
        END IF;
      END LOOP;

      -- Validasi Integritas Historis (Bebas GREATEST)
      IF v_prev_returned_base_pcs > v_orig_base_pcs THEN
        RAISE EXCEPTION 'HISTORICAL_RETURN_EXCEEDS_ORIGINAL_QTY: Item % terdeteksi memiliki riwayat retur (% pcs) melebihi kuantitas kirim asal (% pcs). Diperlukan rekonsiliasi manual.',
          v_doc_item.item_name, v_prev_returned_base_pcs, v_orig_base_pcs USING errcode = 'P0001';
      END IF;

      -- Hitung akumulasi yang sudah diretur pada transaksi ini untuk item yang sama (misal kondisi lain)
      SELECT COALESCE(SUM((it->>'baseQuantityPcs')::NUMERIC), 0)
      INTO v_current_tx_item_pcs
      FROM jsonb_array_elements(v_items_recorded) it
      WHERE (it->>'itemId')::UUID = v_doc_item.id;

      v_remaining_base_pcs := v_orig_base_pcs - v_prev_returned_base_pcs - v_current_tx_item_pcs;
      v_req_base_pcs := v_delta;

      -- Validasi Kuantitas yang Diminta Tidak Melebihi Sisa
      IF v_req_base_pcs > v_remaining_base_pcs THEN
        RAISE EXCEPTION 'RETURN_QTY_EXCEEDS_REMAINING: Item % sisa % pcs, diminta % pcs', 
          v_doc_item.item_name, v_remaining_base_pcs, v_req_base_pcs USING errcode = 'P0001';
      END IF;

      -- Mutasi Stok Produk Tanpa SQL NULL Trap & Tanpa Fallback Diam-diam
      IF NOT v_is_unrecorded THEN
        IF v_item_prod_id IS NULL THEN
          RAISE EXCEPTION 'RECORDED_ITEM_MISSING_PRODUCT_ID:% (Item tercatat wajib memiliki ID produk sah)', v_doc_item.item_name USING errcode = 'P0001';
        END IF;

        SELECT * INTO v_prod FROM public.products
        WHERE id = v_item_prod_id AND owner_id = p_owner_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'PRODUCT_NOT_FOUND:% (Produk tidak ditemukan di sistem)', v_item_prod_id USING errcode = 'P0002';
        END IF;

        IF NOT v_item_is_damaged THEN
          IF NOT (v_prod.metadata ? 'stockNonSerial') THEN
            v_cur_nonserial := COALESCE(v_prod.stock, 0)::BIGINT;
          ELSIF jsonb_typeof(v_prod.metadata->'stockNonSerial') = 'null' 
                OR v_prod.metadata->>'stockNonSerial' IS NULL 
                OR NOT ((v_prod.metadata->>'stockNonSerial') ~ '^[0-9]{1,10}$') THEN
            RAISE EXCEPTION 'CORRUPTED_PRODUCT_METADATA: Field stockNonSerial pada produk % bernilai NULL atau korup ("%")', 
              v_prod.name, COALESCE(v_prod.metadata->>'stockNonSerial', 'null') USING errcode = 'P0001';
          ELSE
            v_cur_nonserial := (v_prod.metadata->>'stockNonSerial')::BIGINT;
          END IF;

          IF (v_prod.stock::BIGINT + v_delta::BIGINT) > 2147483647 THEN
            RAISE EXCEPTION 'STOCK_INTEGER_OVERFLOW: Penambahan stok melebihi batas maksimum integer' USING errcode = 'P0001';
          END IF;

          UPDATE public.products SET
            stock = stock + v_delta::INT,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'stockNonSerial', (v_cur_nonserial + v_delta::BIGINT)
            ),
            updated_at = now()
          WHERE id = v_prod.id;
        ELSE
          IF NOT (v_prod.metadata ? 'stockDamaged') THEN
            v_cur_damaged := 0;
          ELSIF jsonb_typeof(v_prod.metadata->'stockDamaged') = 'null' 
                OR v_prod.metadata->>'stockDamaged' IS NULL 
                OR NOT ((v_prod.metadata->>'stockDamaged') ~ '^[0-9]{1,10}$') THEN
            RAISE EXCEPTION 'CORRUPTED_PRODUCT_METADATA: Field stockDamaged pada produk % bernilai NULL atau korup ("%")', 
              v_prod.name, COALESCE(v_prod.metadata->>'stockDamaged', 'null') USING errcode = 'P0001';
          ELSE
            v_cur_damaged := (v_prod.metadata->>'stockDamaged')::BIGINT;
          END IF;

          UPDATE public.products SET
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'stockDamaged', (v_cur_damaged + v_delta::BIGINT)
            ),
            updated_at = now()
          WHERE id = v_prod.id;
        END IF;
      END IF;

      -- Catat Item Non-Serial ke Array Return
      v_items_recorded := v_items_recorded || jsonb_build_object(
        'itemId', v_doc_item.id::TEXT,
        'productId', v_item_prod_id::TEXT,
        'productName', v_doc_item.item_name,
        'sku', COALESCE(v_doc_item.sku, ''),
        'isSerial', false,
        'serialNumber', NULL,
        'returnedQty', v_req_qty,
        'qtyUnit', v_unit,
        'baseQuantityPcs', v_delta::INT,
        'condition', v_item_condition,
        'isUnrecorded', v_is_unrecorded
      );
    END IF;
  END LOOP;

  -- 5. Susun Objek Return Baru & Perbarui Metadata Dokumen
  v_new_return_record := jsonb_build_object(
    'id', v_return_id::TEXT,
    'returnNumber', v_return_number,
    'returnedAt', now(),
    'returnedBy', p_actor_id,
    'reason', v_reason,
    'notes', v_notes,
    'condition', CASE WHEN v_tx_is_damaged THEN 'damaged' ELSE 'available' END,
    'status', 'active',
    'items', v_items_recorded
  );

  UPDATE public.documents SET
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'returns', v_returns || v_new_return_record,
      'returnSeq', v_seq
    ),
    updated_at = now()
  WHERE id = p_document_id;

  -- 6. Catat Audit Log Atomik dengan Status State Akhir Lengkap
  INSERT INTO public.activity_logs (
    owner_id, actor_id, action, entity_type, entity_id, entity_name, before_data, after_data, created_at
  ) VALUES (
    p_owner_id, p_actor_id, 'goods_out_returned', 'Documents', p_document_id, v_doc.document_number,
    jsonb_build_object('returnsCount', jsonb_array_length(v_returns)),
    v_new_return_record,
    now()
  );

  RETURN jsonb_build_object(
    'success', true,
    'returnId', v_return_id,
    'returnNumber', v_return_number,
    'itemCount', jsonb_array_length(v_items_recorded)
  );
END;
$$;

-- Function 2: public.restore_goods_out_return
DROP FUNCTION IF EXISTS public.restore_goods_out_return(UUID, UUID, UUID, UUID, TEXT);
CREATE OR REPLACE FUNCTION public.restore_goods_out_return(
  p_document_id UUID,
  p_return_id UUID,
  p_owner_id UUID,
  p_actor_id UUID,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_doc RECORD;
  v_doc_item RECORD;
  v_serial RECORD;
  v_prod RECORD;
  v_returns JSONB;
  v_updated_returns JSONB := '[]'::jsonb;
  v_return_record JSONB := NULL;
  v_restored_record JSONB;
  v_elem JSONB;
  v_item JSONB;
  v_is_damaged BOOLEAN;
  v_sn_clean TEXT;
  v_unit TEXT;
  v_multiplier NUMERIC;
  v_delta NUMERIC;
  v_req_qty NUMERIC;
  v_found_count INT := 0;
  v_source_is_unrecorded BOOLEAN;
  v_history_is_unrecorded BOOLEAN;
  v_cur_serials BIGINT;
  v_cur_nonserial BIGINT;
  v_cur_damaged BIGINT;
  v_actual_serials_pcs BIGINT;
  v_item_is_serial BOOLEAN;
  v_is_group BOOLEAN := false;
  v_group_qty NUMERIC;
  v_group_unit TEXT;
  v_group_total_pcs NUMERIC;

  -- Variabel penguncian di muka (Upfront Deterministic Lock)
  v_all_sn TEXT[] := ARRAY[]::TEXT[];
  v_all_prod_ids UUID[] := ARRAY[]::UUID[];
  v_candidate_item_ids UUID[] := ARRAY[]::UUID[];
BEGIN
  -- 1. Kunci Baris Dokumen Goods Out (Lock Level 1)
  SELECT * INTO v_doc FROM public.documents
  WHERE id = p_document_id AND owner_id = p_owner_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_FOUND: Dokumen tidak ditemukan' USING errcode = 'P0002';
  END IF;

  IF NOT (v_doc.metadata ? 'returns') OR jsonb_typeof(v_doc.metadata->'returns') <> 'array' THEN
    RAISE EXCEPTION 'CORRUPTED_RETURNS_METADATA: metadata.returns bukan array JSON valid' USING errcode = 'P0001';
  END IF;

  v_returns := v_doc.metadata->'returns';

  -- 2. Cari Objek Retur yang Akan Di-restore dengan Proteksi ID Duplikat & Validasi Tipe Defensif
  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_returns)
  LOOP
    IF jsonb_typeof(v_elem) <> 'object' THEN
      RAISE EXCEPTION 'CORRUPTED_RETURNS_METADATA: Elemen array metadata.returns bukan objek JSON valid' USING errcode = 'P0001';
    END IF;

    IF v_elem ? 'id' 
       AND (v_elem->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
       AND (v_elem->>'id')::UUID = p_return_id THEN
      v_found_count := v_found_count + 1;
      v_return_record := v_elem;

      IF v_elem->>'status' = 'restored' THEN
        RAISE EXCEPTION 'RETURN_ALREADY_RESTORED: Transaksi retur ini sudah pernah dibatalkan sebelumnya' USING errcode = 'P0001';
      END IF;

      -- Bentuk objek record yang telah dipulihkan (State Akhir Terverifikasi)
      v_restored_record := v_elem || jsonb_build_object(
        'status', 'restored',
        'restoredAt', now(),
        'restoredBy', p_actor_id,
        'restoreNotes', p_notes
      );
      v_updated_returns := v_updated_returns || v_restored_record;
    ELSE
      v_updated_returns := v_updated_returns || v_elem;
    END IF;
  END LOOP;

  IF v_found_count = 0 THEN
    RAISE EXCEPTION 'RETURN_RECORD_NOT_FOUND: Data retur dengan ID tersebut tidak ditemukan' USING errcode = 'P0002';
  ELSIF v_found_count > 1 THEN
    RAISE EXCEPTION 'CORRUPTED_DUPLICATE_RETURN_ID: Terdeteksi lebih dari satu record retur dengan ID yang sama' USING errcode = 'P0001';
  END IF;

  IF NOT (v_return_record ? 'items') OR jsonb_typeof(v_return_record->'items') <> 'array' OR jsonb_array_length(v_return_record->'items') = 0 THEN
    RAISE EXCEPTION 'CORRUPTED_RETURN_RECORD: Record retur tidak memiliki daftar items yang valid' USING errcode = 'P0001';
  END IF;

  -- 3. Kumpulkan Serial & ID Dokumen Item untuk Penguncian di Muka
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_return_record->'items')
  LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'CORRUPTED_RETURN_RECORD: Elemen item retur bukan objek JSON valid' USING errcode = 'P0001';
    END IF;

    -- Validasi isSerial defensif
    IF v_item ? 'isSerial' THEN
      IF jsonb_typeof(v_item->'isSerial') = 'boolean' THEN
        v_item_is_serial := (v_item->'isSerial')::BOOLEAN;
      ELSIF jsonb_typeof(v_item->'isSerial') = 'string' AND (v_item->>'isSerial') IN ('true', 'false') THEN
        v_item_is_serial := ((v_item->>'isSerial') = 'true');
      ELSE
        RAISE EXCEPTION 'CORRUPTED_RETURN_RECORD: Field isSerial tidak berformat boolean valid' USING errcode = 'P0001';
      END IF;
    ELSE
      v_item_is_serial := false;
    END IF;

    IF v_item_is_serial THEN
      v_sn_clean := TRIM(v_item->>'serialNumber');
      IF v_sn_clean IS NOT NULL AND v_sn_clean <> '' THEN
        v_all_sn := array_append(v_all_sn, LOWER(v_sn_clean));
      END IF;
    END IF;

    IF v_item ? 'itemId' AND v_item->>'itemId' IS NOT NULL AND TRIM(v_item->>'itemId') <> '' THEN
      IF NOT (TRIM(v_item->>'itemId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        RAISE EXCEPTION 'CORRUPTED_RETURN_RECORD: itemId "%" tidak berformat UUID valid', v_item->>'itemId' USING errcode = 'P0001';
      END IF;
      v_candidate_item_ids := array_append(v_candidate_item_ids, (TRIM(v_item->>'itemId'))::UUID);
    END IF;
  END LOOP;

  IF array_length(v_all_sn, 1) > 0 THEN
    PERFORM id FROM public.product_serials
    WHERE owner_id = p_owner_id AND LOWER(TRIM(serial_number)) = ANY(v_all_sn)
    ORDER BY serial_number ASC
    FOR UPDATE;
  END IF;

  -- Ekstraksi dan kunci seluruh produk terpengaruh secara terurut UUID (Lock Level 3)
  SELECT array_agg(DISTINCT prod_id ORDER BY prod_id ASC) INTO v_all_prod_ids
  FROM (
    SELECT ps.product_id AS prod_id
    FROM public.product_serials ps
    WHERE ps.owner_id = p_owner_id AND LOWER(TRIM(ps.serial_number)) = ANY(v_all_sn)
      AND ps.product_id IS NOT NULL
    UNION
    SELECT di.product_id AS prod_id
    FROM public.document_items di
    WHERE di.id = ANY(v_candidate_item_ids)
      AND di.document_id = p_document_id
      AND di.product_id IS NOT NULL
  ) p_sub;

  IF v_all_prod_ids IS NOT NULL AND array_length(v_all_prod_ids, 1) > 0 THEN
    PERFORM id FROM public.products
    WHERE id = ANY(v_all_prod_ids) AND owner_id = p_owner_id
    ORDER BY id ASC
    FOR UPDATE;
  END IF;

  -- 4. Pembalikan Stok & Serial untuk Setiap Item pada Retur Ini
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_return_record->'items')
  LOOP
    -- Validasi returnedQty numerik murni & batas skala
    IF v_item->>'returnedQty' IS NULL OR NOT (TRIM(v_item->>'returnedQty') ~ '^[0-9]{1,10}(\.[0-9]{1,4})?$') THEN
      RAISE EXCEPTION 'CORRUPTED_RETURN_RECORD: returnedQty "%" tidak berformat numerik valid', v_item->>'returnedQty' USING errcode = 'P0001';
    END IF;
    v_req_qty := (TRIM(v_item->>'returnedQty'))::NUMERIC;
    IF v_req_qty <= 0 THEN
      RAISE EXCEPTION 'CORRUPTED_RETURN_RECORD: returnedQty harus lebih besar dari 0' USING errcode = 'P0001';
    END IF;

    v_is_damaged := (v_item->>'condition' = 'damaged');
    v_multiplier := public.inventory_unit_multiplier(p_owner_id, v_doc.warehouse_id, v_item->>'qtyUnit');
    IF v_multiplier IS NULL OR v_multiplier <= 0 THEN
      RAISE EXCEPTION 'INVALID_UNIT_MULTIPLIER_ON_RESTORE: Satuan unit % tidak valid', v_item->>'qtyUnit' USING errcode = 'P0001';
    END IF;
    v_delta := v_req_qty * v_multiplier;

    IF v_delta <> TRUNC(v_delta) THEN
      RAISE EXCEPTION 'FRACTIONAL_BASE_PCS_NOT_ALLOWED: Kuantitas restore dalam satuan dasar pcs menghasilkan pecahan' USING errcode = 'P0001';
    END IF;

    -- Validasi Format UUID Item ID
    IF v_item->>'itemId' IS NULL OR NOT (TRIM(v_item->>'itemId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'CORRUPTED_RETURN_RECORD: itemId "%" tidak valid', COALESCE(v_item->>'itemId', 'NULL') USING errcode = 'P0001';
    END IF;

    -- Kueri Baris Dokumen Item Sumber di Database Asli
    SELECT * INTO v_doc_item FROM public.document_items
    WHERE id = (TRIM(v_item->>'itemId'))::UUID AND document_id = p_document_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'RESTORE_SOURCE_ITEM_NOT_FOUND: Item surat jalan asal % tidak ditemukan', v_item->>'itemId' USING errcode = 'P0002';
    END IF;

    -- Validasi Status Unrecorded secara aman tanpa blind casting
    v_source_is_unrecorded := false;
    IF v_doc_item.metadata ? 'isUnrecorded' THEN
      IF jsonb_typeof(v_doc_item.metadata->'isUnrecorded') = 'boolean' THEN
        v_source_is_unrecorded := (v_doc_item.metadata->'isUnrecorded')::BOOLEAN;
      ELSIF (v_doc_item.metadata->>'isUnrecorded') IN ('true', 'false') THEN
        v_source_is_unrecorded := ((v_doc_item.metadata->>'isUnrecorded') = 'true');
      END IF;
    ELSIF v_doc_item.metadata ? 'isUnrecordedStock' THEN
      IF jsonb_typeof(v_doc_item.metadata->'isUnrecordedStock') = 'boolean' THEN
        v_source_is_unrecorded := (v_doc_item.metadata->'isUnrecordedStock')::BOOLEAN;
      ELSIF (v_doc_item.metadata->>'isUnrecordedStock') IN ('true', 'false') THEN
        v_source_is_unrecorded := ((v_doc_item.metadata->>'isUnrecordedStock') = 'true');
      END IF;
    END IF;

    v_history_is_unrecorded := false;
    IF v_item ? 'isUnrecorded' THEN
      IF jsonb_typeof(v_item->'isUnrecorded') = 'boolean' THEN
        v_history_is_unrecorded := (v_item->'isUnrecorded')::BOOLEAN;
      ELSIF (v_item->>'isUnrecorded') IN ('true', 'false') THEN
        v_history_is_unrecorded := ((v_item->>'isUnrecorded') = 'true');
      END IF;
    ELSIF v_item ? 'isUnrecordedStock' THEN
      IF jsonb_typeof(v_item->'isUnrecordedStock') = 'boolean' THEN
        v_history_is_unrecorded := (v_item->'isUnrecordedStock')::BOOLEAN;
      ELSIF (v_item->>'isUnrecordedStock') IN ('true', 'false') THEN
        v_history_is_unrecorded := ((v_item->>'isUnrecordedStock') = 'true');
      END IF;
    END IF;

    IF v_history_is_unrecorded <> v_source_is_unrecorded THEN
      RAISE EXCEPTION 'UNRECORDED_STATUS_CONFLICT: Status unrecorded pada histori retur bertentangan dengan baris surat jalan' USING errcode = 'P0001';
    END IF;

    -- Validasi isSerial defensif
    IF v_item ? 'isSerial' THEN
      IF jsonb_typeof(v_item->'isSerial') = 'boolean' THEN
        v_item_is_serial := (v_item->'isSerial')::BOOLEAN;
      ELSIF jsonb_typeof(v_item->'isSerial') = 'string' AND (v_item->>'isSerial') IN ('true', 'false') THEN
        v_item_is_serial := ((v_item->>'isSerial') = 'true');
      ELSE
        RAISE EXCEPTION 'CORRUPTED_RETURN_RECORD: Field isSerial tidak berupa boolean valid' USING errcode = 'P0001';
      END IF;
    ELSE
      v_item_is_serial := false;
    END IF;

    -- ========================================================================
    -- A. PEMBALIKAN ITEM SERIAL
    -- ========================================================================
    IF v_item_is_serial THEN
      v_sn_clean := TRIM(v_item->>'serialNumber');

      SELECT * INTO v_serial FROM public.product_serials
      WHERE owner_id = p_owner_id
        AND LOWER(TRIM(serial_number)) = LOWER(v_sn_clean);

      IF NOT FOUND THEN
        RAISE EXCEPTION 'SERIAL_NOT_FOUND_FOR_RESTORE:% (Nomor seri tidak ditemukan di sistem)', v_sn_clean USING errcode = 'P0002';
      END IF;

      -- Validasi status serial saat ini sesuai kondisi retur asal
      IF v_is_damaged THEN
        IF v_serial.status <> 'damaged' THEN
          RAISE EXCEPTION 'SERIAL_STATUS_CONFLICT_FOR_RESTORE: Serial % saat ini berstatus "%", seharusnya "damaged"',
            v_sn_clean, v_serial.status USING errcode = 'P0001';
        END IF;
      ELSE
        IF v_serial.status <> 'available' THEN
          RAISE EXCEPTION 'SERIAL_STATUS_CONFLICT_FOR_RESTORE: Serial % saat ini berstatus "%", seharusnya "available"',
            v_sn_clean, v_serial.status USING errcode = 'P0001';
        END IF;
      END IF;

      -- Serial belum boleh dikeluarkan oleh surat jalan lain
      IF v_serial.goods_out_document_id IS NOT NULL THEN
        RAISE EXCEPTION 'SERIAL_ALREADY_ATTACHED_TO_ANOTHER_DOC: Serial % telah terikat pada dokumen surat jalan lain',
          v_sn_clean USING errcode = 'P0001';
      END IF;

      IF v_doc.warehouse_id IS NOT NULL THEN
        IF v_serial.warehouse_id IS NULL OR v_serial.warehouse_id <> v_doc.warehouse_id THEN
          RAISE EXCEPTION 'SERIAL_WAREHOUSE_MISMATCH_FOR_RESTORE: Serial % terdaftar di gudang % bukan %',
            v_sn_clean, COALESCE(v_serial.warehouse_id::text, 'NULL'), v_doc.warehouse_id USING errcode = 'P0001';
        END IF;
      END IF;

      -- Validasi Relasi Retur Asal (Bebas False-Positive Null FK)
      IF v_serial.metadata ? 'returnedFromDocId' THEN
        IF (v_serial.metadata->>'returnedFromDocId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
           AND (v_serial.metadata->>'returnedFromDocId')::UUID <> p_document_id THEN
          RAISE EXCEPTION 'SERIAL_SOURCE_DOC_MISMATCH_FOR_RESTORE: Serial % tercatat diretur dari dokumen lain', v_sn_clean USING errcode = 'P0001';
        END IF;
      END IF;

      IF v_serial.metadata ? 'returnedFromItemId' THEN
        IF (v_serial.metadata->>'returnedFromItemId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           AND (v_serial.metadata->>'returnedFromItemId')::UUID <> v_doc_item.id THEN
          RAISE EXCEPTION 'SERIAL_SOURCE_ITEM_MISMATCH_FOR_RESTORE: Serial % tercatat diretur dari item dokumen lain', v_sn_clean USING errcode = 'P0001';
        END IF;
      END IF;

      -- Verifikasi Keselarasan Produk Secara Ketat (Fail-Closed)
      IF NOT v_source_is_unrecorded THEN
        IF v_serial.product_id IS NULL OR v_doc_item.product_id IS NULL OR v_serial.product_id <> v_doc_item.product_id THEN
          RAISE EXCEPTION 'SERIAL_PRODUCT_MISMATCH: ID produk pada serial (%) tidak cocok dengan baris surat jalan (%)',
            COALESCE(v_serial.product_id::text, 'NULL'), COALESCE(v_doc_item.product_id::text, 'NULL') USING errcode = 'P0001';
        END IF;
      END IF;

      -- Grouped serial is atomic: restore the full grouped quantity even for
      -- legacy return rows that stored returnedQty = 1.
      v_is_group := LOWER(COALESCE(v_item->>'isGroup', 'false')) = 'true'
        OR LOWER(COALESCE(v_doc_item.metadata->>'isGroup', 'false')) = 'true'
        OR LOWER(COALESCE(v_serial.metadata->>'isGroup', 'false')) = 'true';

      IF v_is_group THEN
        v_group_qty := COALESCE(
          NULLIF(v_doc_item.metadata->>'targetQty', '')::NUMERIC,
          NULLIF(v_serial.metadata->>'targetQty', '')::NUMERIC,
          NULLIF(v_item->>'targetQty', '')::NUMERIC,
          v_req_qty
        );
        IF v_group_qty IS NULL OR v_group_qty <= 0 THEN
          v_group_qty := v_req_qty;
        END IF;

        v_group_unit := COALESCE(
          NULLIF(v_doc_item.metadata->>'targetUnit', ''),
          NULLIF(v_serial.metadata->>'targetUnit', ''),
          NULLIF(v_serial.metadata->>'serialUnit', ''),
          NULLIF(v_doc_item.metadata->>'qtyUnit', ''),
          NULLIF(v_item->>'targetUnit', ''),
          NULLIF(v_item->>'qtyUnit', ''),
          'pcs'
        );

        v_unit := v_group_unit;
        v_req_qty := v_group_qty;
        v_multiplier := public.inventory_unit_multiplier(p_owner_id, v_doc.warehouse_id, v_unit);
        IF v_multiplier IS NULL OR v_multiplier <= 0 THEN
          RAISE EXCEPTION 'INVALID_UNIT_MULTIPLIER_ON_RESTORE: Satuan unit % tidak valid', v_unit USING errcode = 'P0001';
        END IF;
        v_delta := v_req_qty * v_multiplier;
        v_group_total_pcs := COALESCE(
          NULLIF(v_item->>'totalPcs', '')::NUMERIC,
          NULLIF(v_doc_item.metadata->>'totalPcs', '')::NUMERIC,
          NULLIF(v_serial.metadata->>'totalPcs', '')::NUMERIC,
          v_delta
        );

        IF v_delta <> TRUNC(v_delta) THEN
          RAISE EXCEPTION 'FRACTIONAL_BASE_PCS_NOT_ALLOWED: Kuantitas restore group dalam satuan dasar pcs menghasilkan pecahan' USING errcode = 'P0001';
        END IF;
      END IF;

      -- Re-link serial kembali ke Goods Out asal berstatus 'out'
      UPDATE public.product_serials SET
        status = 'out',
        goods_out_document_id = p_document_id,
        goods_out_item_id = v_doc_item.id,
        metadata = (COALESCE(metadata, '{}'::jsonb) - 'returnedAt' - 'returnedFrom' - 'returnedFromDocId' - 'returnedFromItemId' - 'returnNumber' - 'returnReason') || jsonb_build_object(
          'restoredAt', now(),
          'restoredFromReturnId', p_return_id
        ),
        updated_at = now()
      WHERE id = v_serial.id;

      -- Potong Kembali Stok Produk dengan Validasi Eksplisit (BEBAS GREATEST, Bebas SQL NULL Trap)
      IF NOT v_source_is_unrecorded THEN
        SELECT * INTO v_prod FROM public.products
        WHERE id = v_doc_item.product_id AND owner_id = p_owner_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'PRODUCT_NOT_FOUND_FOR_RESTORE:% (Produk tidak ditemukan)', v_doc_item.product_id USING errcode = 'P0002';
        END IF;

        IF NOT v_is_damaged THEN
          -- Validasi saldo fisik siap jual
          IF v_prod.stock IS NULL OR v_prod.stock < v_delta::INT THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK_FOR_RESTORE: Produk % stok saat ini (% pcs) tidak cukup untuk dipotong (% pcs)',
              v_prod.name, COALESCE(v_prod.stock, 0), v_delta::INT USING errcode = 'P0001';
          END IF;

          -- Validasi saldo serial metadata tanpa SQL NULL trap
          IF NOT (v_prod.metadata ? 'stockSerials') THEN
            -- Data warisan: hitung dari ketersediaan fisik riil terisolasi warehouse
            SELECT COALESCE(SUM(
              CASE 
                WHEN metadata ? 'unitQty' AND (metadata->>'unitQty') ~ '^[0-9]{1,10}$' 
                  THEN (metadata->>'unitQty')::BIGINT
                ELSE public.inventory_unit_multiplier(p_owner_id, v_doc.warehouse_id, metadata->>'serialUnit')
              END
            ), 0)::BIGINT
            INTO v_actual_serials_pcs
            FROM public.product_serials
            WHERE product_id = v_prod.id 
              AND owner_id = p_owner_id 
              AND warehouse_id = v_doc.warehouse_id 
              AND (status = 'available' OR id = v_serial.id);

            IF v_actual_serials_pcs < v_delta::BIGINT THEN
              RAISE EXCEPTION 'INSUFFICIENT_SERIAL_STOCK_FOR_RESTORE: Serial tersedia fisik pada gudang (% pcs) tidak mencukupi untuk dipotong (% pcs)',
                v_actual_serials_pcs, v_delta::BIGINT USING errcode = 'P0001';
            END IF;
            v_cur_serials := v_actual_serials_pcs;
          ELSIF jsonb_typeof(v_prod.metadata->'stockSerials') = 'null'
                OR v_prod.metadata->>'stockSerials' IS NULL
                OR NOT ((v_prod.metadata->>'stockSerials') ~ '^[0-9]{1,10}$') THEN
            RAISE EXCEPTION 'CORRUPTED_PRODUCT_METADATA: stockSerials pada produk % bernilai NULL atau korup ("%")',
              v_prod.name, COALESCE(v_prod.metadata->>'stockSerials', 'null') USING errcode = 'P0001';
          ELSE
            v_cur_serials := (v_prod.metadata->>'stockSerials')::BIGINT;
            IF v_cur_serials < v_delta::BIGINT THEN
              RAISE EXCEPTION 'INSUFFICIENT_SERIAL_STOCK_FOR_RESTORE: Produk % metadata stockSerials (% pcs) tidak cukup untuk dipotong (% pcs)',
                v_prod.name, v_cur_serials, v_delta::BIGINT USING errcode = 'P0001';
            END IF;
          END IF;

          -- Validasi Invarian Stok
          IF (v_prod.stock - v_delta::INT) < 0 THEN
            RAISE EXCEPTION 'STOCK_METADATA_INCONSISTENCY: Pemotongan serial menyebabkan saldo total minus' USING errcode = 'P0001';
          END IF;

          UPDATE public.products SET
            stock = stock - v_delta::INT,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'stockSerials', (v_cur_serials - v_delta::BIGINT)
            ),
            updated_at = now()
          WHERE id = v_prod.id;
        ELSE
          -- Validasi saldo karantina barang rusak tanpa SQL NULL trap
          IF NOT (v_prod.metadata ? 'stockDamaged') THEN
            RAISE EXCEPTION 'INSUFFICIENT_DAMAGED_STOCK_FOR_RESTORE: Produk % tidak memiliki saldo stockDamaged untuk dipotong', v_prod.name USING errcode = 'P0001';
          ELSIF jsonb_typeof(v_prod.metadata->'stockDamaged') = 'null'
                OR v_prod.metadata->>'stockDamaged' IS NULL
                OR NOT ((v_prod.metadata->>'stockDamaged') ~ '^[0-9]{1,10}$') THEN
            RAISE EXCEPTION 'CORRUPTED_PRODUCT_METADATA: stockDamaged pada produk % bernilai NULL atau korup ("%")',
              v_prod.name, COALESCE(v_prod.metadata->>'stockDamaged', 'null') USING errcode = 'P0001';
          ELSE
            v_cur_damaged := (v_prod.metadata->>'stockDamaged')::BIGINT;
          END IF;

          IF v_cur_damaged < v_delta::BIGINT THEN
            RAISE EXCEPTION 'INSUFFICIENT_DAMAGED_STOCK_FOR_RESTORE: Produk % stok rusak saat ini (% pcs) tidak cukup untuk dipotong (% pcs)',
              v_prod.name, v_cur_damaged, v_delta::BIGINT USING errcode = 'P0001';
          END IF;

          UPDATE public.products SET
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'stockDamaged', (v_cur_damaged - v_delta::BIGINT)
            ),
            updated_at = now()
          WHERE id = v_prod.id;
        END IF;
      END IF;

    -- ========================================================================
    -- B. PEMBALIKAN ITEM NON-SERIAL
    -- ========================================================================
    ELSE
      IF NOT v_source_is_unrecorded THEN
        IF v_doc_item.product_id IS NULL THEN
          RAISE EXCEPTION 'RECORDED_ITEM_MISSING_PRODUCT_ID: Item non-serial tercatat wajib memiliki ID produk' USING errcode = 'P0001';
        END IF;

        SELECT * INTO v_prod FROM public.products
        WHERE id = v_doc_item.product_id AND owner_id = p_owner_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'PRODUCT_NOT_FOUND_FOR_RESTORE:% (Produk tidak ditemukan)', v_doc_item.product_id USING errcode = 'P0002';
        END IF;

        IF NOT v_is_damaged THEN
          IF v_prod.stock IS NULL OR v_prod.stock < v_delta::INT THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK_FOR_RESTORE: Produk % stok saat ini (% pcs) tidak cukup untuk dipotong (% pcs)',
              v_prod.name, COALESCE(v_prod.stock, 0), v_delta::INT USING errcode = 'P0001';
          END IF;

          IF NOT (v_prod.metadata ? 'stockNonSerial') THEN
            v_cur_nonserial := v_prod.stock::BIGINT;
            IF v_cur_nonserial < v_delta::BIGINT THEN
              RAISE EXCEPTION 'INSUFFICIENT_NON_SERIAL_STOCK_FOR_RESTORE: Produk % saldo non-serial warisan (% pcs) tidak cukup untuk dipotong (% pcs)',
                v_prod.name, v_cur_nonserial, v_delta::BIGINT USING errcode = 'P0001';
            END IF;
          ELSIF jsonb_typeof(v_prod.metadata->'stockNonSerial') = 'null'
                OR v_prod.metadata->>'stockNonSerial' IS NULL
                OR NOT ((v_prod.metadata->>'stockNonSerial') ~ '^[0-9]{1,10}$') THEN
            RAISE EXCEPTION 'CORRUPTED_PRODUCT_METADATA: stockNonSerial pada produk % bernilai NULL atau korup ("%")',
              v_prod.name, COALESCE(v_prod.metadata->>'stockNonSerial', 'null') USING errcode = 'P0001';
          ELSE
            v_cur_nonserial := (v_prod.metadata->>'stockNonSerial')::BIGINT;
            IF v_cur_nonserial < v_delta::BIGINT THEN
              RAISE EXCEPTION 'INSUFFICIENT_NON_SERIAL_STOCK_FOR_RESTORE: Produk % metadata stockNonSerial (% pcs) tidak cukup untuk dipotong (% pcs)',
                v_prod.name, v_cur_nonserial, v_delta::BIGINT USING errcode = 'P0001';
            END IF;
          END IF;

          UPDATE public.products SET
            stock = stock - v_delta::INT,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'stockNonSerial', (v_cur_nonserial - v_delta::BIGINT)
            ),
            updated_at = now()
          WHERE id = v_prod.id;
        ELSE
          IF NOT (v_prod.metadata ? 'stockDamaged') THEN
            RAISE EXCEPTION 'INSUFFICIENT_DAMAGED_STOCK_FOR_RESTORE: Produk % tidak memiliki saldo stockDamaged untuk dipotong', v_prod.name USING errcode = 'P0001';
          ELSIF jsonb_typeof(v_prod.metadata->'stockDamaged') = 'null'
                OR v_prod.metadata->>'stockDamaged' IS NULL
                OR NOT ((v_prod.metadata->>'stockDamaged') ~ '^[0-9]{1,10}$') THEN
            RAISE EXCEPTION 'CORRUPTED_PRODUCT_METADATA: stockDamaged pada produk % bernilai NULL atau korup ("%")',
              v_prod.name, COALESCE(v_prod.metadata->>'stockDamaged', 'null') USING errcode = 'P0001';
          ELSE
            v_cur_damaged := (v_prod.metadata->>'stockDamaged')::BIGINT;
          END IF;

          IF v_cur_damaged < v_delta::BIGINT THEN
            RAISE EXCEPTION 'INSUFFICIENT_DAMAGED_STOCK_FOR_RESTORE: Produk % stok rusak saat ini (% pcs) tidak cukup untuk dipotong (% pcs)',
              v_prod.name, v_cur_damaged, v_delta::BIGINT USING errcode = 'P0001';
          END IF;

          UPDATE public.products SET
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'stockDamaged', (v_cur_damaged - v_delta::BIGINT)
            ),
            updated_at = now()
          WHERE id = v_prod.id;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- 5. Perbarui Array Retur pada Dokumen
  UPDATE public.documents SET
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'returns', v_updated_returns
    ),
    updated_at = now()
  WHERE id = p_document_id;

  -- 6. Catat Audit Log Atomik dengan Status Akhir Terverifikasi
  INSERT INTO public.activity_logs (
    owner_id, actor_id, action, entity_type, entity_id, entity_name, before_data, after_data, created_at
  ) VALUES (
    p_owner_id, p_actor_id, 'goods_out_return_restored', 'Documents', p_document_id, v_doc.document_number,
    v_return_record,
    v_restored_record,
    now()
  );

  RETURN jsonb_build_object(
    'success', true,
    'restoredReturnId', p_return_id
  );
END;
$$;

-- Hak Akses & Keamanan Eksekusi RPC
REVOKE ALL ON FUNCTION public.process_goods_out_return(UUID, JSONB, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_goods_out_return(UUID, JSONB, UUID, UUID) TO service_role, postgres;

REVOKE ALL ON FUNCTION public.restore_goods_out_return(UUID, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_goods_out_return(UUID, UUID, UUID, UUID, TEXT) TO service_role, postgres;
