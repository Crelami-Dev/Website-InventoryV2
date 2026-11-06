-- Migration 018: Allow Goods Out for unrecorded / non-SN items without deducting registered stock
-- Idempotent updates to complete_inventory_document, reverse_inventory_document, and inventory_reconciliation

CREATE OR REPLACE FUNCTION public.complete_inventory_document(
  p_owner_id UUID,
  p_document_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc public.documents%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_item RECORD;
  v_qty NUMERIC;
  v_available NUMERIC;
  v_serial public.product_serials%ROWTYPE;
BEGIN
  SELECT * INTO v_doc FROM public.documents
  WHERE id = p_document_id AND owner_id = p_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF v_doc.status = 'completed' THEN
    RETURN to_jsonb(v_doc);
  END IF;
  IF v_doc.status = 'cancelled' THEN
    RAISE EXCEPTION 'CANCELLED_DOCUMENT_CANNOT_BE_COMPLETED' USING errcode = 'P0001';
  END IF;

  IF v_doc.document_type IN ('goods_in', 'goods_out') THEN
    FOR v_item IN
      SELECT di.product_id,
        SUM(
          COALESCE(NULLIF(di.metadata->>'qtyInput', '')::NUMERIC, di.quantity)
          * COALESCE(NULLIF(di.metadata->>'unitMultiplier', '')::NUMERIC,
              public.inventory_unit_multiplier(p_owner_id, v_doc.warehouse_id, di.metadata->>'qtyUnit'))
        ) AS base_qty
      FROM public.document_items di
      WHERE di.document_id = p_document_id
        AND di.product_id IS NOT NULL
        AND COALESCE((di.metadata->>'isSerial')::BOOLEAN, false) = false
        AND COALESCE((di.metadata->>'isUnrecorded')::BOOLEAN, false) = false
        AND COALESCE((di.metadata->>'isUnrecordedStock')::BOOLEAN, false) = false
      GROUP BY di.product_id
      ORDER BY di.product_id
    LOOP
      SELECT * INTO v_product FROM public.products
      WHERE id = v_item.product_id AND owner_id = p_owner_id
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND:%', v_item.product_id USING errcode = 'P0002'; END IF;

      v_qty := v_item.base_qty;
      v_available := COALESCE(NULLIF(v_product.metadata->>'stockNonSerial', '')::NUMERIC, v_product.stock, 0);
      IF v_doc.document_type = 'goods_out' AND v_available < v_qty THEN
        RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%', v_item.product_id, v_available, v_qty USING errcode = 'P0001';
      END IF;

      UPDATE public.products SET
        stock = stock + CASE WHEN v_doc.document_type = 'goods_in' THEN v_qty ELSE -v_qty END,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'stockNonSerial', v_available + CASE WHEN v_doc.document_type = 'goods_in' THEN v_qty ELSE -v_qty END
        )
      WHERE id = v_item.product_id AND owner_id = p_owner_id;
    END LOOP;

    IF v_doc.document_type = 'goods_out' THEN
      FOR v_item IN
        SELECT di.id, di.product_id, TRIM(di.metadata->>'serialNumber') AS serial_number
        FROM public.document_items di
        WHERE di.document_id = p_document_id
          AND COALESCE((di.metadata->>'isSerial')::BOOLEAN, false) = true
          AND COALESCE((di.metadata->>'isUnrecorded')::BOOLEAN, false) = false
      LOOP
        SELECT * INTO v_serial FROM public.product_serials
        WHERE owner_id = p_owner_id
          AND product_id = v_item.product_id
          AND LOWER(serial_number) = LOWER(v_item.serial_number)
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'SERIAL_NOT_FOUND:%', v_item.serial_number USING errcode = 'P0002'; END IF;
        IF v_serial.status <> 'available' AND v_serial.goods_out_document_id IS DISTINCT FROM p_document_id THEN
          RAISE EXCEPTION 'SERIAL_NOT_AVAILABLE:%', v_item.serial_number USING errcode = 'P0001';
        END IF;
        UPDATE public.product_serials SET status = 'out', goods_out_document_id = p_document_id,
          goods_out_item_id = v_item.id
        WHERE id = v_serial.id;
      END LOOP;
    END IF;
  END IF;

  UPDATE public.documents SET
    status = 'completed',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'inventoryPosted', true, 'inventoryPostedAt', NOW()
    )
  WHERE id = p_document_id AND owner_id = p_owner_id
  RETURNING * INTO v_doc;
  RETURN to_jsonb(v_doc);
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_inventory_document(
  p_owner_id UUID,
  p_document_id UUID,
  p_delete BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc public.documents%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_item RECORD;
  v_qty NUMERIC;
  v_available NUMERIC;
BEGIN
  SELECT * INTO v_doc FROM public.documents
  WHERE id = p_document_id AND owner_id = p_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_NOT_FOUND' USING errcode = 'P0002'; END IF;

  IF v_doc.status = 'completed' AND v_doc.document_type IN ('goods_in', 'goods_out') THEN
    IF v_doc.document_type = 'goods_in' AND EXISTS (
      SELECT 1 FROM public.product_serials
      WHERE owner_id = p_owner_id AND goods_in_document_id = p_document_id AND status = 'out'
    ) THEN
      RAISE EXCEPTION 'GOODS_IN_HAS_DISPATCHED_SERIALS' USING errcode = 'P0001';
    END IF;

    FOR v_item IN
      SELECT di.product_id,
        SUM(COALESCE(NULLIF(di.metadata->>'qtyInput', '')::NUMERIC, di.quantity)
          * COALESCE(NULLIF(di.metadata->>'unitMultiplier', '')::NUMERIC,
              public.inventory_unit_multiplier(p_owner_id, v_doc.warehouse_id, di.metadata->>'qtyUnit'))) AS base_qty
      FROM public.document_items di
      WHERE di.document_id = p_document_id AND di.product_id IS NOT NULL
        AND COALESCE((di.metadata->>'isSerial')::BOOLEAN, false) = false
        AND COALESCE((di.metadata->>'isUnrecorded')::BOOLEAN, false) = false
        AND COALESCE((di.metadata->>'isUnrecordedStock')::BOOLEAN, false) = false
      GROUP BY di.product_id ORDER BY di.product_id
    LOOP
      SELECT * INTO v_product FROM public.products
      WHERE id = v_item.product_id AND owner_id = p_owner_id FOR UPDATE;
      IF FOUND THEN
        v_qty := v_item.base_qty;
        v_available := COALESCE(NULLIF(v_product.metadata->>'stockNonSerial', '')::NUMERIC, v_product.stock, 0);
        IF v_doc.document_type = 'goods_in' AND v_available < v_qty THEN
          RAISE EXCEPTION 'CANNOT_REVERSE_GOODS_IN_STOCK:%', v_item.product_id USING errcode = 'P0001';
        END IF;
        UPDATE public.products SET
          stock = stock + CASE WHEN v_doc.document_type = 'goods_out' THEN v_qty ELSE -v_qty END,
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'stockNonSerial', v_available + CASE WHEN v_doc.document_type = 'goods_out' THEN v_qty ELSE -v_qty END
          )
        WHERE id = v_item.product_id AND owner_id = p_owner_id;
      END IF;
    END LOOP;

    IF v_doc.document_type = 'goods_out' THEN
      UPDATE public.product_serials SET status = 'available', goods_out_document_id = null, goods_out_item_id = null
      WHERE owner_id = p_owner_id AND goods_out_document_id = p_document_id;
    ELSE
      DELETE FROM public.product_serials
      WHERE owner_id = p_owner_id AND goods_in_document_id = p_document_id AND status <> 'out';
    END IF;
  END IF;

  IF p_delete THEN
    DELETE FROM public.documents WHERE id = p_document_id AND owner_id = p_owner_id;
  ELSE
    UPDATE public.documents SET status = 'cancelled',
      metadata = (COALESCE(metadata, '{}'::jsonb) - 'inventoryPosted') || jsonb_build_object('inventoryReversedAt', NOW())
    WHERE id = p_document_id AND owner_id = p_owner_id RETURNING * INTO v_doc;
  END IF;
  RETURN to_jsonb(v_doc);
END;
$$;

DROP FUNCTION IF EXISTS public.inventory_reconciliation(UUID, UUID);

CREATE OR REPLACE FUNCTION public.inventory_reconciliation(
  p_owner_id UUID,
  p_warehouse_id UUID DEFAULT NULL
) RETURNS TABLE (
  product_id UUID,
  sku TEXT,
  name TEXT,
  current_stock NUMERIC,
  expected_stock NUMERIC,
  discrepancy NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH movements AS (
    SELECT di.product_id,
      SUM(
        CASE d.document_type WHEN 'goods_in' THEN 1 WHEN 'goods_out' THEN -1 ELSE 0 END
        * COALESCE(NULLIF(di.metadata->>'baseQuantity', '')::NUMERIC,
            COALESCE(NULLIF(di.metadata->>'qtyInput', '')::NUMERIC, di.quantity)
            * COALESCE(NULLIF(di.metadata->>'unitMultiplier', '')::NUMERIC,
                public.inventory_unit_multiplier(d.owner_id, d.warehouse_id, di.metadata->>'qtyUnit')))
      ) AS expected
    FROM public.documents d
    JOIN public.document_items di ON di.document_id = d.id
    WHERE d.owner_id = p_owner_id
      AND (p_warehouse_id IS NULL OR d.warehouse_id = p_warehouse_id)
      AND d.status = 'completed'
      AND d.document_type IN ('goods_in', 'goods_out')
      AND di.product_id IS NOT NULL
      AND COALESCE((di.metadata->>'isSerial')::BOOLEAN, false) = false
      AND COALESCE((di.metadata->>'isUnrecorded')::BOOLEAN, false) = false
      AND COALESCE((di.metadata->>'isUnrecordedStock')::BOOLEAN, false) = false
    GROUP BY di.product_id
  )
  SELECT p.id, p.sku, p.name,
    COALESCE(NULLIF(p.metadata->>'stockNonSerial', '')::NUMERIC, p.stock, 0),
    COALESCE(m.expected, 0),
    COALESCE(NULLIF(p.metadata->>'stockNonSerial', '')::NUMERIC, p.stock, 0) - COALESCE(m.expected, 0)
  FROM public.products p
  LEFT JOIN movements m ON m.product_id = p.id
  WHERE p.owner_id = p_owner_id
    AND (p_warehouse_id IS NULL OR p.warehouse_id = p_warehouse_id)
  ORDER BY ABS(COALESCE(NULLIF(p.metadata->>'stockNonSerial', '')::NUMERIC, p.stock, 0) - COALESCE(m.expected, 0)) DESC,
    p.name;
$$;

REVOKE ALL ON FUNCTION public.complete_inventory_document(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_inventory_document(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.reverse_inventory_document(UUID, UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_inventory_document(UUID, UUID, BOOLEAN) TO service_role;

REVOKE ALL ON FUNCTION public.inventory_reconciliation(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inventory_reconciliation(UUID, UUID) TO authenticated, service_role;
