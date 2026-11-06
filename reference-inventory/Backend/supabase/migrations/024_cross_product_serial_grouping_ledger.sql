-- ============================================================================
-- Migration 024: Cross-Product Serial Grouping and Ledger Foundation
-- 
-- Phase 2 implementation for DocuFlow:
-- 1. Expands documents table check constraint to support internal ledger types:
--    'goods_assembly', 'goods_disassembly', 'stock_adjustment'
-- 2. Creates public.serial_groupings: Header transaction for serial grouping
-- 3. Creates public.serial_grouping_components: Item components forming each group
-- 4. Establishes integrity constraints, idempotency index, and relational indexes
-- 5. Enables RLS and updated_at triggers
--
-- STRICT PRESERVATION:
-- - Additive-only. Zero modification to historical stock numbers or product_serials.
-- - Fully backward compatible with legacy groups created via 022 migration.
-- ============================================================================

-- 1. Extend document_type constraint in public.documents safely
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
      'goods_assembly',
      'goods_disassembly',
      'stock_adjustment'
    ));
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 2. Create Header Table: public.serial_groupings
CREATE TABLE IF NOT EXISTS public.serial_groupings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  grouping_number TEXT NOT NULL,
  warehouse_id UUID,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dissolved', 'cancelled')),
  group_type TEXT NOT NULL DEFAULT 'mixed' CHECK (group_type IN ('single_product', 'mixed')),
  
  -- Result Target Product & Serial Reference
  result_product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  result_serial_id UUID REFERENCES public.product_serials(id) ON DELETE RESTRICT,
  result_serial_number TEXT NOT NULL,
  
  -- Unit & Quantity Conversion
  target_unit TEXT NOT NULL DEFAULT 'pcs',
  target_qty NUMERIC(14, 2) NOT NULL DEFAULT 1 CHECK (target_qty > 0),
  total_base_qty_pcs NUMERIC(14, 2) NOT NULL CHECK (total_base_qty_pcs > 0),
  
  -- Financial & COGS (HPP) Valuation
  total_cost NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  result_unit_cost NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (result_unit_cost >= 0),
  
  -- Ledger Document Linkage (Official movement tracking)
  source_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  reverse_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  
  -- Concurrency & Idempotency Protection
  idempotency_key TEXT,
  
  -- Audit & Metadata Snapshot
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dissolved_at TIMESTAMPTZ,
  dissolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  CONSTRAINT uq_serial_groupings_owner_number UNIQUE (owner_id, grouping_number),
  CONSTRAINT chk_serial_groupings_reverse_doc_status CHECK (reverse_document_id IS NULL OR status IN ('dissolved', 'cancelled'))
);

-- 3. Create Component Table: public.serial_grouping_components
CREATE TABLE IF NOT EXISTS public.serial_grouping_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grouping_id UUID NOT NULL REFERENCES public.serial_groupings(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL,
  
  -- Component Source References
  component_serial_id UUID NOT NULL REFERENCES public.product_serials(id) ON DELETE RESTRICT,
  component_serial_number TEXT NOT NULL,
  component_product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  
  -- Historical Product Snapshots (immutable across master changes)
  snapshot_product_name TEXT NOT NULL,
  snapshot_sku TEXT,
  
  -- Quantities & Base Conversion
  unit TEXT NOT NULL DEFAULT 'pcs',
  unit_qty NUMERIC(14, 2) NOT NULL DEFAULT 1 CHECK (unit_qty > 0),
  base_qty_pcs NUMERIC(14, 2) NOT NULL CHECK (base_qty_pcs > 0),
  
  -- Cost Snapshots (HPP Component)
  unit_cost NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  total_cost NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  
  -- Hierarchy & Nesting Integrity
  is_sub_group BOOLEAN NOT NULL DEFAULT false,
  nested_depth INTEGER NOT NULL DEFAULT 1 CHECK (nested_depth BETWEEN 1 AND 3),
  sort_order INTEGER NOT NULL DEFAULT 0,
  
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  CONSTRAINT uq_grouping_component_unique_in_group UNIQUE (grouping_id, component_serial_id)
);

-- 4. Create Performance, Search, and Idempotency Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_serial_groupings_idempotency 
  ON public.serial_groupings (owner_id, idempotency_key) 
  WHERE idempotency_key IS NOT NULL AND status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_serial_groupings_owner_wh 
  ON public.serial_groupings (owner_id, warehouse_id, status);

CREATE INDEX IF NOT EXISTS idx_serial_groupings_res_prod 
  ON public.serial_groupings (owner_id, result_product_id, status);

CREATE INDEX IF NOT EXISTS idx_serial_groupings_res_serial 
  ON public.serial_groupings (owner_id, result_serial_id);

CREATE INDEX IF NOT EXISTS idx_serial_groupings_created_at 
  ON public.serial_groupings (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_serial_groupings_src_doc 
  ON public.serial_groupings (source_document_id);

CREATE INDEX IF NOT EXISTS idx_serial_groupings_rev_doc 
  ON public.serial_groupings (reverse_document_id);

CREATE INDEX IF NOT EXISTS idx_sg_comp_grouping_id 
  ON public.serial_grouping_components (grouping_id);

CREATE INDEX IF NOT EXISTS idx_sg_comp_serial_id 
  ON public.serial_grouping_components (owner_id, component_serial_id);

CREATE INDEX IF NOT EXISTS idx_sg_comp_product_id 
  ON public.serial_grouping_components (owner_id, component_product_id);

-- 5. Row Level Security (RLS)
ALTER TABLE public.serial_groupings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.serial_grouping_components ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS "Authenticated users can read serial groupings" ON public.serial_groupings;
  CREATE POLICY "Authenticated users can read serial groupings" ON public.serial_groupings
    FOR SELECT USING (auth.role() = 'authenticated');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS "Authenticated users can read serial grouping components" ON public.serial_grouping_components;
  CREATE POLICY "Authenticated users can read serial grouping components" ON public.serial_grouping_components
    FOR SELECT USING (auth.role() = 'authenticated');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 6. Trigger for updated_at
DO $$
BEGIN
  DROP TRIGGER IF EXISTS serial_groupings_set_updated_at ON public.serial_groupings;
  CREATE TRIGGER serial_groupings_set_updated_at
    BEFORE UPDATE ON public.serial_groupings
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
