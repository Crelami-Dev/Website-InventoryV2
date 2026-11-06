-- ============================================================
-- DocuFlow Nemo — Consolidated Database Schema
-- Compiled into 1 Single File for Setup and Documentation
-- ============================================================

BEGIN;
SELECT pg_advisory_xact_lock(hashtext('docuflow_full_idempotent_v1'));

-- Enable required extensions
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ============================================================
-- 1. TRIGGER FUNCTIONS (General utilities)
-- ============================================================

-- Function to automatically manage updated_at timestamps
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$;

-- Function to manage workspace_settings updated_at timestamps
CREATE OR REPLACE FUNCTION public.set_workspace_settings_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$;

-- ============================================================
-- 2. TABLE DEFINITIONS
-- ============================================================

-- User profiles table (extends auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('super_admin', 'owner', 'staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  owner_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Products catalog table
CREATE TABLE IF NOT EXISTS public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  unit_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  selling_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none', 'percentage', 'fixed')),
  discount_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT products_owner_sku_key UNIQUE (owner_id, sku)
);

-- Contacts (Customers/Suppliers) table
CREATE TABLE IF NOT EXISTS public.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL DEFAULT 'customer' CHECK (type = 'customer'),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  province TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Documents (Transactions: invoices, goods in/out, delivery notes, receipts)
CREATE TABLE IF NOT EXISTS public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type TEXT NOT NULL CHECK (document_type IN ('invoice', 'goods_in', 'goods_out', 'delivery_note', 'receipt')),
  document_number TEXT NOT NULL,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  contact_name TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'ready', 'completed', 'exported', 'cancelled')),
  issue_date DATE NOT NULL DEFAULT current_date,
  due_date DATE,
  payment_terms TEXT,
  subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0,
  discount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  tax NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT documents_owner_document_number_key UNIQUE (owner_id, document_number)
);

-- Document repeater items
CREATE TABLE IF NOT EXISTS public.document_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  sku TEXT,
  quantity NUMERIC(14, 2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none', 'percentage', 'fixed')),
  discount_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Document PDF Templates layout mapping
CREATE TABLE IF NOT EXISTS public.templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('invoice', 'goods_in', 'goods_out', 'delivery_note', 'receipt', 'custom')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_custom BOOLEAN NOT NULL DEFAULT false,
  orientation TEXT NOT NULL DEFAULT 'portrait' CHECK (orientation IN ('portrait', 'landscape')),
  paper_size TEXT NOT NULL DEFAULT 'a4',
  layout JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- General Auditing and Activity Logs
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  entity_name TEXT,
  before_data JSONB,
  after_data JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Workspace/Tenant level custom settings
CREATE TABLE IF NOT EXISTS public.workspace_settings (
  owner_id UUID NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key)
);

-- Tracked individual product serial numbers (FIFO / Warranty management)
CREATE TABLE IF NOT EXISTS public.product_serials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  serial_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'out', 'damaged')),
  goods_in_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  goods_in_item_id UUID REFERENCES public.document_items(id) ON DELETE SET NULL,
  goods_out_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  goods_out_item_id UUID REFERENCES public.document_items(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Notifications table
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  user_id UUID NOT NULL,
  type TEXT NOT NULL DEFAULT 'low_stock',
  title TEXT NOT NULL,
  message TEXT,
  reference_id UUID,
  reference_type TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Contact loyalty & points ledger
CREATE TABLE IF NOT EXISTS public.contact_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('earn', 'redeem', 'adjust', 'expire', 'refund')),
  amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  point_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  balance_after NUMERIC(14, 2) NOT NULL DEFAULT 0,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner_id UUID NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Warehouse and operational tables used by the current backend.
CREATE TABLE IF NOT EXISTS public.warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_id UUID NOT NULL,
  name TEXT NOT NULL, code TEXT NOT NULL, address TEXT, phone TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner_id, code)
);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS warehouse_id UUID;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS warehouse_id UUID;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS warehouse_id UUID;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS warehouse_id UUID;
ALTER TABLE public.product_serials ADD COLUMN IF NOT EXISTS warehouse_id UUID;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS warehouse_id UUID;

-- Canonical role migration: the former admin account role is now staff.
-- These updates are safe to rerun and do not create duplicate rows.
UPDATE public.profiles
SET role = 'staff', updated_at = now()
WHERE role = 'admin';

UPDATE auth.users
SET raw_user_meta_data = jsonb_set(
  coalesce(raw_user_meta_data, '{}'::jsonb),
  '{role}',
  '"staff"'::jsonb,
  true
)
WHERE raw_user_meta_data->>'role' = 'admin';

-- Convert role names embedded in existing JSON module/permission settings.
UPDATE public.workspace_settings
SET value = replace(value::text, '"admin"', '"staff"')::jsonb,
    updated_at = now()
WHERE value::text LIKE '%"admin"%';

-- Assign pre-warehouse staff accounts to the owner's active default warehouse.
-- An existing valid assignment is preserved.
UPDATE public.profiles AS profile
SET warehouse_id = (
      SELECT warehouse.id
      FROM public.warehouses AS warehouse
      WHERE warehouse.owner_id = profile.owner_id
        AND warehouse.status = 'active'
      ORDER BY warehouse.is_default DESC, warehouse.created_at ASC
      LIMIT 1
    ),
    updated_at = now()
WHERE profile.role IN ('staff', 'sales_person')
  AND EXISTS (
    SELECT 1
    FROM public.warehouses AS fallback
    WHERE fallback.owner_id = profile.owner_id
      AND fallback.status = 'active'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.warehouses AS assigned
    WHERE assigned.id = profile.warehouse_id
      AND assigned.owner_id = profile.owner_id
      AND assigned.status = 'active'
  );

UPDATE auth.users AS auth_user
SET raw_user_meta_data = jsonb_set(
  coalesce(auth_user.raw_user_meta_data, '{}'::jsonb),
  '{warehouse_id}',
  to_jsonb(profile.warehouse_id::text),
  true
)
FROM public.profiles AS profile
WHERE auth_user.id = profile.id
  AND profile.role IN ('staff', 'sales_person')
  AND profile.warehouse_id IS NOT NULL
  AND auth_user.raw_user_meta_data->>'warehouse_id' IS DISTINCT FROM profile.warehouse_id::text;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('super_admin', 'owner', 'staff', 'sales_person')) NOT VALID;
ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_document_type_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_document_type_check
  CHECK (document_type IN ('invoice', 'goods_in', 'goods_out', 'delivery_note', 'receipt', 'sample')) NOT VALID;
ALTER TABLE public.templates DROP CONSTRAINT IF EXISTS templates_category_check;
ALTER TABLE public.templates ADD CONSTRAINT templates_category_check
  CHECK (category IN ('invoice', 'goods_in', 'goods_out', 'delivery_note', 'receipt', 'custom', 'sample')) NOT VALID;

CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), po_number VARCHAR(100) NOT NULL,
  po_date DATE NOT NULL DEFAULT current_date, vendor_name VARCHAR(255) NOT NULL,
  sales_person_id UUID REFERENCES public.profiles(id), status VARCHAR(20) NOT NULL DEFAULT 'draft',
  notes TEXT, owner_id UUID NOT NULL, warehouse_id UUID,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner_id, po_number)
);

CREATE TABLE IF NOT EXISTS public.purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  item_name VARCHAR(255) NOT NULL, sku VARCHAR(100), qty NUMERIC(14,2) NOT NULL DEFAULT 1,
  unit TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  document_id UUID REFERENCES public.documents(id) ON DELETE CASCADE,
  sender_email TEXT, recipient_email TEXT, cc_email TEXT, subject TEXT,
  status TEXT NOT NULL DEFAULT 'pending', sent_at TIMESTAMPTZ, error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0, last_retry_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reconcile columns for databases created by older partial migrations.
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS warehouse_id UUID;
ALTER TABLE public.purchase_order_items ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE public.purchase_order_items ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.email_logs ADD COLUMN IF NOT EXISTS document_id UUID REFERENCES public.documents(id) ON DELETE CASCADE;
ALTER TABLE public.email_logs ADD COLUMN IF NOT EXISTS return_id UUID;
ALTER TABLE public.email_logs ADD COLUMN IF NOT EXISTS email_type TEXT;
ALTER TABLE public.email_logs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.email_logs ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;
ALTER TABLE public.email_logs ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- Satu log per retur agar retry tidak mengirim notifikasi yang sama dua kali.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_logs_return_unique
  ON public.email_logs (document_id, return_id)
  WHERE return_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_logs_retry_pending
  ON public.email_logs (created_at DESC)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS idx_email_logs_pending_lease
  ON public.email_logs (last_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS warehouses_owner_idx ON public.warehouses(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_owner ON public.purchase_orders(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_sales_person ON public.purchase_orders(sales_person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON public.purchase_order_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_po ON public.email_logs(purchase_order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_doc ON public.email_logs(document_id, created_at DESC);

-- ============================================================
-- 3. INDEXES FOR PERFORMANCE
-- ============================================================

CREATE INDEX IF NOT EXISTS products_status_idx ON public.products(status);
CREATE INDEX IF NOT EXISTS products_owner_id_idx ON public.products(owner_id);

CREATE INDEX IF NOT EXISTS contacts_type_status_idx ON public.contacts(type, status);
CREATE INDEX IF NOT EXISTS contacts_owner_id_idx ON public.contacts(owner_id);

CREATE INDEX IF NOT EXISTS documents_type_status_idx ON public.documents(document_type, status);
CREATE INDEX IF NOT EXISTS documents_contact_id_idx ON public.documents(contact_id);
CREATE INDEX IF NOT EXISTS documents_owner_id_idx ON public.documents(owner_id);

CREATE INDEX IF NOT EXISTS document_items_document_id_idx ON public.document_items(document_id);

CREATE INDEX IF NOT EXISTS templates_category_status_idx ON public.templates(category, status);
CREATE INDEX IF NOT EXISTS templates_owner_id_idx ON public.templates(owner_id);

CREATE INDEX IF NOT EXISTS activity_logs_entity_idx ON public.activity_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS activity_logs_created_at_idx ON public.activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS activity_logs_owner_id_idx ON public.activity_logs(owner_id);

DO $guard$
BEGIN
  IF to_regclass('public.product_serials_owner_serial_number_key') IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.product_serials
      GROUP BY owner_id, lower(serial_number) HAVING count(*) > 1
    ) THEN
      CREATE UNIQUE INDEX product_serials_owner_serial_number_key
        ON public.product_serials(owner_id, serial_number);
    ELSE
      RAISE NOTICE 'Unique serial index skipped: legacy duplicate serial numbers must be reconciled first';
    END IF;
  END IF;
END;
$guard$;
CREATE INDEX IF NOT EXISTS product_serials_owner_id_idx ON public.product_serials(owner_id);
CREATE INDEX IF NOT EXISTS product_serials_product_id_idx ON public.product_serials(product_id);
CREATE INDEX IF NOT EXISTS product_serials_status_idx ON public.product_serials(status);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_owner ON public.notifications(owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_points_contact ON public.contact_points(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_points_owner ON public.contact_points(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_points_doc ON public.contact_points(document_id);

-- ============================================================
-- 4. UPDATE TRIGGERS (TIMESTAMP UPDATER)
-- ============================================================

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS products_set_updated_at ON public.products;
CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS contacts_set_updated_at ON public.contacts;
CREATE TRIGGER contacts_set_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS documents_set_updated_at ON public.documents;
CREATE TRIGGER documents_set_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS document_items_set_updated_at ON public.document_items;
CREATE TRIGGER document_items_set_updated_at
  BEFORE UPDATE ON public.document_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS templates_set_updated_at ON public.templates;
CREATE TRIGGER templates_set_updated_at
  BEFORE UPDATE ON public.templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS workspace_settings_set_updated_at ON public.workspace_settings;
CREATE TRIGGER workspace_settings_set_updated_at
  BEFORE UPDATE ON public.workspace_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_workspace_settings_updated_at();

DROP TRIGGER IF EXISTS product_serials_set_updated_at ON public.product_serials;
CREATE TRIGGER product_serials_set_updated_at
  BEFORE UPDATE ON public.product_serials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 5. COMPLEX USER SIGN-UP AND TENANT PROVISIONING TRIGGERS
-- ============================================================

-- A. Trigger function on auth.users sign-up: Creates user profile & assigns roles/owners
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_owner_id uuid;
BEGIN
  v_role := coalesce(new.raw_user_meta_data->>'role', 'staff');
  IF v_role = 'admin' THEN
    v_role := 'staff';
  END IF;
  
  IF v_role = 'super_admin' THEN
    v_owner_id := '00000000-0000-0000-0000-000000000000'::uuid;
  ELSIF v_role = 'owner' THEN
    v_owner_id := new.id;
  ELSE
    v_owner_id := coalesce((new.raw_user_meta_data->>'owner_id')::uuid, new.id);
  END IF;

  INSERT INTO public.profiles (id, full_name, role, owner_id)
  VALUES (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    v_role,
    v_owner_id
  )
  ON CONFLICT (id) DO UPDATE
  SET
    role = excluded.role,
    owner_id = excluded.owner_id;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- B. Trigger function on profile insert: Provisions settings and default templates for new Owners
CREATE OR REPLACE FUNCTION public.initialize_tenant_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (new.role = 'owner' OR new.role = 'super_admin') THEN
    
    -- Insert default 'modules' settings config
    INSERT INTO public.workspace_settings (owner_id, key, value)
    VALUES (
      new.owner_id,
      'modules',
      jsonb_build_object(
        'inventory', jsonb_build_object(
          'name', 'Inventory',
          'label', 'Inventory',
          'description', 'Kelola stok, produk, dan pergerakan barang',
          'enabled', true,
          'required', true,
          'category', 'Core',
          'roles', jsonb_build_array('owner', 'staff')
        ),
        'products', jsonb_build_object('label', 'Products', 'enabled', true, 'roles', jsonb_build_array('owner', 'staff')),
        'contacts', jsonb_build_object('label', 'Customers', 'enabled', true, 'roles', jsonb_build_array('owner', 'staff')),
        'templates', jsonb_build_object('label', 'Templates', 'enabled', true, 'roles', jsonb_build_array('owner')),
        'history', jsonb_build_object('label', 'History', 'enabled', true, 'roles', jsonb_build_array('owner')),
        'settings', jsonb_build_object('label', 'Settings', 'enabled', true, 'roles', jsonb_build_array('owner')),
        'documents', jsonb_build_object(
          'name', 'Documents',
          'label', 'Documents',
          'description', 'Kelola invoice dan dokumen bisnis',
          'enabled', true,
          'required', true,
          'category', 'Core',
          'roles', jsonb_build_array('owner', 'staff'),
          'documentTypes', jsonb_build_object(
            'invoice', jsonb_build_object('label', 'Invoice', 'enabled', true, 'roles', jsonb_build_array('owner', 'staff')),
            'goods_in', jsonb_build_object('label', 'Goods In', 'enabled', true, 'roles', jsonb_build_array('owner', 'staff')),
            'goods_out', jsonb_build_object('label', 'Goods Out', 'enabled', true, 'roles', jsonb_build_array('owner', 'staff')),
            'delivery_note', jsonb_build_object('label', 'Delivery Note', 'enabled', true, 'roles', jsonb_build_array('owner', 'staff')),
            'receipt', jsonb_build_object('label', 'Receipt', 'enabled', true, 'roles', jsonb_build_array('owner', 'staff'))
          )
        )
      )
    )
    ON CONFLICT (owner_id, key) DO NOTHING;

    -- Insert default 'app' workspace configurations
    INSERT INTO public.workspace_settings (owner_id, key, value)
    VALUES (
      new.owner_id,
      'app',
      jsonb_build_object(
        'company', jsonb_build_object(
          'logoName', '', 'logoData', '', 'stampName', '', 'stampData', '', 'signatureName', '', 'signatureData', '',
          'companyName', 'DocuFlow Trading',
          'businessType', 'Trading & Distribution',
          'email', 'finance@docuflow.test',
          'phone', '021-555-0199',
          'website', 'www.docuflow.test',
          'address', 'Jl. Sudirman No. 88',
          'city', 'Jakarta',
          'province', 'DKI Jakarta',
          'postalCode', '10220',
          'taxId', '01.234.567.8-901.000',
          'paymentTransfer', 'BCA 1234567890 a/n DocuFlow Trading'
        ),
        'documents', jsonb_build_object(
          'invoicePrefix', 'NOTA No: ',
          'goodsInPrefix', 'GIN-2026-',
          'goodsOutPrefix', 'GOUT-2026-',
          'deliveryNotePrefix', 'DN-2026-',
          'receiptPrefix', 'RCT-2026-',
          'brandLogos', jsonb_build_array('', '', '', '', '', '', '', ''),
          'autoGenerate', true,
          'resetYearly', true,
          'showCompanyHeader', true,
          'showFooterNotes', true
        ),
        'pdf', jsonb_build_object(
          'paperSize', 'A4',
          'orientation', 'Portrait',
          'margins', 'Normal',
          'showFooter', true,
          'showPageNumbers', true,
          'showCompanyInfo', true,
          'showWatermark', false
        ),
        'currency', jsonb_build_object(
          'defaultCurrency', 'IDR',
          'format', 'Rp 100.000',
          'decimalPlaces', '0',
          'taxName', 'PPN',
          'taxPercentage', '11'
        ),
        'notifications', jsonb_build_object(
          'documentCreated', true,
          'documentExported', true,
          'importCompleted', true,
          'templateUpdated', true,
          'productUpdated', false,
          'systemAlerts', true
        ),
        'backup', jsonb_build_object(
          'lastBackupAt', null,
          'lastExportAt', null,
          'retentionDays', 30
        ),
        'appearance', jsonb_build_object(
          'theme', 'Light',
          'accentColor', 'Blue',
          'density', 'Comfortable'
        )
      )
    )
    ON CONFLICT (owner_id, key) DO NOTHING;

    -- Provision default PDF print templates for the new owner
    IF NOT EXISTS (SELECT 1 FROM public.templates WHERE owner_id = new.owner_id) THEN
      INSERT INTO public.templates (name, category, status, is_default, is_custom, orientation, paper_size, layout, created_by, owner_id)
      VALUES
        (
          'Modern Invoice',
          'invoice',
          'active',
          true,
          false,
          'landscape',
          'Continuous Form Full Landscape 11 x 9.5 in',
          '{
            "layoutStyle": "Continuous Form Landscape",
            "documentSize": "Continuous Form Full Landscape 11 x 9.5 in",
            "headerLayout": "Company left",
            "footerLayout": "Notes and signature",
            "logoPlacement": "Top left",
            "description": "Landscape full continuous form invoice template for 11 x 9.5 inch printer paper.",
            "selected": true
          }'::jsonb,
          new.id,
          new.owner_id
        ),
        (
          'Warehouse Goods In',
          'goods_in',
          'active',
          true,
          false,
          'portrait',
          'A4',
          '{
            "layoutStyle": "Detailed Layout",
            "documentSize": "A4",
            "headerLayout": "Warehouse header",
            "footerLayout": "Receiver signature",
            "logoPlacement": "Top left",
            "description": "Goods in template for supplier receiving, warehouse verification, and incoming stock records.",
            "selected": false
          }'::jsonb,
          new.id,
          new.owner_id
        ),
        (
          'Goods Out Standard',
          'goods_out',
          'active',
          true,
          false,
          'portrait',
          'A4',
          '{
            "layoutStyle": "Standard Layout",
            "documentSize": "A4",
            "headerLayout": "Company left",
            "footerLayout": "Warehouse approval",
            "logoPlacement": "Top left",
            "description": "Goods out template for outbound stock movement, destination records, and warehouse approval.",
            "selected": false
          }'::jsonb,
          new.id,
          new.owner_id
        ),
        (
          'Delivery Note Standard',
          'delivery_note',
          'active',
          true,
          false,
          'portrait',
          'A4',
          '{
            "layoutStyle": "Standard Layout",
            "documentSize": "A4",
            "headerLayout": "Company left",
            "footerLayout": "Driver and receiver signature",
            "logoPlacement": "Top left",
            "description": "Delivery note template for shipment details, recipient confirmation, and item delivery lists.",
            "selected": false
          }'::jsonb,
          new.id,
          new.owner_id
        ),
        (
          'Retail Receipt',
          'receipt',
          'active',
          true,
          false,
          'landscape',
          'Continuous Form Full Landscape 11 x 9.5 in',
          '{
            "layoutStyle": "Continuous Form Landscape",
            "documentSize": "Continuous Form Full Landscape 11 x 9.5 in",
            "headerLayout": "Store header",
            "footerLayout": "Thank-you notes and signature",
            "logoPlacement": "Top left",
            "description": "Landscape full continuous form receipt template for 11 x 9.5 inch printer paper.",
            "selected": false
          }'::jsonb,
          new.id,
          new.owner_id
        );
    END IF;

  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS profiles_initialize_tenant_settings ON public.profiles;
CREATE TRIGGER profiles_initialize_tenant_settings
  AFTER INSERT OR UPDATE OF role, owner_id ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.initialize_tenant_settings();

-- ============================================================
-- 6. ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_points ENABLE ROW LEVEL SECURITY;

-- Profiles Policies
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

-- Products Policies
DROP POLICY IF EXISTS "Authenticated users can read products" ON public.products;
CREATE POLICY "Authenticated users can read products" ON public.products
  FOR SELECT USING (auth.role() = 'authenticated');

-- Contacts Policies
DROP POLICY IF EXISTS "Authenticated users can read contacts" ON public.contacts;
CREATE POLICY "Authenticated users can read contacts" ON public.contacts
  FOR SELECT USING (auth.role() = 'authenticated');

-- Contact Points Policies
DROP POLICY IF EXISTS "Authenticated users can read contact points" ON public.contact_points;
CREATE POLICY "Authenticated users can read contact points" ON public.contact_points
  FOR SELECT USING (auth.role() = 'authenticated');

-- Documents Policies
DROP POLICY IF EXISTS "Authenticated users can read documents" ON public.documents;
CREATE POLICY "Authenticated users can read documents" ON public.documents
  FOR SELECT USING (auth.role() = 'authenticated');

-- Document Items Policies
DROP POLICY IF EXISTS "Authenticated users can read document items" ON public.document_items;
CREATE POLICY "Authenticated users can read document items" ON public.document_items
  FOR SELECT USING (auth.role() = 'authenticated');

-- Templates Policies
DROP POLICY IF EXISTS "Authenticated users can read templates" ON public.templates;
CREATE POLICY "Authenticated users can read templates" ON public.templates
  FOR SELECT USING (auth.role() = 'authenticated');

-- Activity Logs Policies
DROP POLICY IF EXISTS "Authenticated users can read activity logs" ON public.activity_logs;
CREATE POLICY "Authenticated users can read activity logs" ON public.activity_logs
  FOR SELECT USING (auth.role() = 'authenticated');

-- Workspace Settings Policies
DROP POLICY IF EXISTS "Authenticated users can read workspace settings" ON public.workspace_settings;
CREATE POLICY "Authenticated users can read workspace settings" ON public.workspace_settings
  FOR SELECT USING (auth.role() = 'authenticated');

-- Product Serials Policies
DROP POLICY IF EXISTS "Authenticated users can read product serials" ON public.product_serials;
CREATE POLICY "Authenticated users can read product serials" ON public.product_serials
  FOR SELECT USING (auth.role() = 'authenticated');

-- Notification Policies
DROP POLICY IF EXISTS "Users can view own notifications" ON public.notifications;
CREATE POLICY "Users can view own notifications" ON public.notifications
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own notifications" ON public.notifications;
CREATE POLICY "Users can update own notifications" ON public.notifications
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can insert notifications" ON public.notifications;
CREATE POLICY "Service role can insert notifications" ON public.notifications
  FOR INSERT WITH CHECK (true);

-- ============================================================
-- PHASE 2-5: ATOMIC INVENTORY, PERFORMANCE, RECONCILIATION
-- ============================================================

-- Atomic Goods In / Goods Out inventory transitions.
-- Legacy unit bal intentionally remains 300 pcs.

create table if not exists public.warehouse_units (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  warehouse_id uuid not null,
  unit_key text not null,
  display_name text not null,
  multiplier numeric not null check (multiplier > 0),
  base_unit text not null default 'pcs',
  is_active boolean not null default true,
  is_locked boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, warehouse_id, unit_key)
);

create index if not exists warehouse_units_lookup_idx
  on public.warehouse_units(owner_id, warehouse_id, is_active, unit_key);

alter table public.warehouse_units enable row level security;

-- Migrate the existing per-warehouse JSON settings without deleting them.
insert into public.warehouse_units (
  owner_id, warehouse_id, unit_key, display_name, multiplier, base_unit, is_active, is_locked, metadata
)
select ws.owner_id,
  replace(ws.key, 'custom_units_', '')::uuid,
  lower(unit->>'key'),
  coalesce(nullif(unit->>'name', ''), unit->>'key'),
  coalesce(nullif(unit->>'multiplier', '')::numeric,
    case when unit->>'baseType' = 'lusin' then nullif(unit->>'baseValue', '')::numeric * 12
         else nullif(unit->>'baseValue', '')::numeric end, 1),
  coalesce(nullif(unit->>'baseType', ''), 'pcs'),
  true,
  coalesce((unit->>'isLocked')::boolean, false),
  unit
from public.workspace_settings ws
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(ws.value) = 'array' then ws.value else '[]'::jsonb end
) unit
where ws.key ~ '^custom_units_[0-9a-fA-F-]{36}$'
  and jsonb_typeof(ws.value) = 'array'
  and coalesce(unit->>'key', '') <> ''
on conflict (owner_id, warehouse_id, unit_key) do update set
  display_name = excluded.display_name,
  multiplier = excluded.multiplier,
  base_unit = excluded.base_unit,
  is_locked = excluded.is_locked,
  metadata = excluded.metadata,
  updated_at = now();

-- Hidden compatibility alias for historical document_items / serial numbers.
insert into public.warehouse_units (owner_id, warehouse_id, unit_key, display_name, multiplier, is_active, is_locked)
select distinct owner_id, warehouse_id, 'bal', 'Bal (Legacy)', 300, false, true
from public.warehouse_units
on conflict (owner_id, warehouse_id, unit_key) do update set multiplier = 300, is_locked = true;

create or replace function public.inventory_unit_multiplier(
  p_owner_id uuid,
  p_warehouse_id uuid,
  p_unit_key text
) returns numeric
language plpgsql
stable
as $$
declare
  v_units jsonb;
  v_multiplier numeric;
  v_key text := lower(coalesce(nullif(trim(p_unit_key), ''), 'pcs'));
begin
  select multiplier into v_multiplier
  from public.warehouse_units
  where owner_id = p_owner_id and warehouse_id = p_warehouse_id and unit_key = v_key
  limit 1;
  if v_multiplier is not null then return v_multiplier; end if;

  if p_warehouse_id is not null then
    select value into v_units
    from public.workspace_settings
    where owner_id = p_owner_id and key = 'custom_units_' || p_warehouse_id::text;
  end if;

  if v_units is null then
    select value into v_units
    from public.workspace_settings
    where owner_id = p_owner_id and key = 'custom_units';
  end if;

  select coalesce(
    nullif(unit->>'multiplier', '')::numeric,
    case when unit->>'baseType' = 'lusin'
      then nullif(unit->>'baseValue', '')::numeric * 12
      else nullif(unit->>'baseValue', '')::numeric
    end
  ) into v_multiplier
  from jsonb_array_elements(coalesce(v_units, '[]'::jsonb)) unit
  where lower(unit->>'key') = v_key
  limit 1;

  return coalesce(v_multiplier, case v_key
    when 'pcs' then 1 when 'piece' then 1
    when 'pack3' then 3 when 'pack6' then 6
    when 'lusin' then 12 when 'dozen' then 12
    when 'pack' then 60 when 'bal5' then 60
    when 'bal10' then 120 when 'bal15' then 180
    when 'bal20' then 240 when 'bal25' then 300
    when 'bal' then 300
    else 1 end);
end;
$$;

create or replace function public.complete_inventory_document(
  p_owner_id uuid,
  p_document_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.documents%rowtype;
  v_product public.products%rowtype;
  v_item record;
  v_qty numeric;
  v_available numeric;
  v_serial public.product_serials%rowtype;
begin
  select * into v_doc from public.documents
  where id = p_document_id and owner_id = p_owner_id
  for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_doc.status = 'completed' then
    return to_jsonb(v_doc);
  end if;
  if v_doc.status = 'cancelled' then
    raise exception 'CANCELLED_DOCUMENT_CANNOT_BE_COMPLETED' using errcode = 'P0001';
  end if;

  if v_doc.document_type in ('goods_in', 'goods_out') then
    for v_item in
      select di.product_id,
        sum(
          coalesce(nullif(di.metadata->>'qtyInput', '')::numeric, di.quantity)
          * coalesce(nullif(di.metadata->>'unitMultiplier', '')::numeric,
              public.inventory_unit_multiplier(p_owner_id, v_doc.warehouse_id, di.metadata->>'qtyUnit'))
        ) as base_qty
      from public.document_items di
      where di.document_id = p_document_id
        and di.product_id is not null
        and coalesce((di.metadata->>'isSerial')::boolean, false) = false
        and coalesce((di.metadata->>'isUnrecorded')::boolean, false) = false
        and coalesce((di.metadata->>'isUnrecordedStock')::boolean, false) = false
      group by di.product_id
      order by di.product_id
    loop
      select * into v_product from public.products
      where id = v_item.product_id and owner_id = p_owner_id
      for update;
      if not found then raise exception 'PRODUCT_NOT_FOUND:%', v_item.product_id using errcode = 'P0002'; end if;

      v_qty := v_item.base_qty;
      v_available := coalesce(nullif(v_product.metadata->>'stockNonSerial', '')::numeric, v_product.stock, 0);
      if v_doc.document_type = 'goods_out' and v_available < v_qty then
        raise exception 'INSUFFICIENT_STOCK:%:%:%', v_item.product_id, v_available, v_qty using errcode = 'P0001';
      end if;

      update public.products set
        stock = stock + case when v_doc.document_type = 'goods_in' then v_qty else -v_qty end,
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'stockNonSerial', v_available + case when v_doc.document_type = 'goods_in' then v_qty else -v_qty end
        )
      where id = v_item.product_id and owner_id = p_owner_id;
    end loop;

    if v_doc.document_type = 'goods_out' then
      for v_item in
        select di.id, di.product_id, trim(di.metadata->>'serialNumber') serial_number
        from public.document_items di
        where di.document_id = p_document_id
          and coalesce((di.metadata->>'isSerial')::boolean, false) = true
      loop
        select * into v_serial from public.product_serials
        where owner_id = p_owner_id
          and product_id = v_item.product_id
          and lower(serial_number) = lower(v_item.serial_number)
        for update;
        if not found then raise exception 'SERIAL_NOT_FOUND:%', v_item.serial_number using errcode = 'P0002'; end if;
        if v_serial.status <> 'available' and v_serial.goods_out_document_id is distinct from p_document_id then
          raise exception 'SERIAL_NOT_AVAILABLE:%', v_item.serial_number using errcode = 'P0001';
        end if;
        update public.product_serials set status = 'out', goods_out_document_id = p_document_id,
          goods_out_item_id = v_item.id
        where id = v_serial.id;
      end loop;
    end if;
  end if;

  update public.documents set
    status = 'completed',
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'inventoryPosted', true, 'inventoryPostedAt', now()
    )
  where id = p_document_id and owner_id = p_owner_id
  returning * into v_doc;
  return to_jsonb(v_doc);
end;
$$;

create or replace function public.reverse_inventory_document(
  p_owner_id uuid,
  p_document_id uuid,
  p_delete boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.documents%rowtype;
  v_product public.products%rowtype;
  v_item record;
  v_qty numeric;
  v_available numeric;
begin
  select * into v_doc from public.documents
  where id = p_document_id and owner_id = p_owner_id
  for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;

  if v_doc.status = 'completed' and v_doc.document_type in ('goods_in', 'goods_out') then
    if v_doc.document_type = 'goods_in' and exists (
      select 1 from public.product_serials
      where owner_id = p_owner_id and goods_in_document_id = p_document_id and status = 'out'
    ) then
      raise exception 'GOODS_IN_HAS_DISPATCHED_SERIALS' using errcode = 'P0001';
    end if;

    for v_item in
      select di.product_id,
        sum(coalesce(nullif(di.metadata->>'qtyInput', '')::numeric, di.quantity)
          * coalesce(nullif(di.metadata->>'unitMultiplier', '')::numeric,
              public.inventory_unit_multiplier(p_owner_id, v_doc.warehouse_id, di.metadata->>'qtyUnit'))) base_qty
      from public.document_items di
      where di.document_id = p_document_id and di.product_id is not null
        and coalesce((di.metadata->>'isSerial')::boolean, false) = false
        and coalesce((di.metadata->>'isUnrecorded')::boolean, false) = false
        and coalesce((di.metadata->>'isUnrecordedStock')::boolean, false) = false
      group by di.product_id order by di.product_id
    loop
      select * into v_product from public.products
      where id = v_item.product_id and owner_id = p_owner_id for update;
      if found then
        v_qty := v_item.base_qty;
        v_available := coalesce(nullif(v_product.metadata->>'stockNonSerial', '')::numeric, v_product.stock, 0);
        if v_doc.document_type = 'goods_in' and v_available < v_qty then
          raise exception 'CANNOT_REVERSE_GOODS_IN_STOCK:%', v_item.product_id using errcode = 'P0001';
        end if;
        update public.products set
          stock = stock + case when v_doc.document_type = 'goods_out' then v_qty else -v_qty end,
          metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'stockNonSerial', v_available + case when v_doc.document_type = 'goods_out' then v_qty else -v_qty end
          )
        where id = v_item.product_id and owner_id = p_owner_id;
      end if;
    end loop;

    if v_doc.document_type = 'goods_out' then
      update public.product_serials set status = 'available', goods_out_document_id = null, goods_out_item_id = null
      where owner_id = p_owner_id and goods_out_document_id = p_document_id;
    else
      delete from public.product_serials
      where owner_id = p_owner_id and goods_in_document_id = p_document_id and status <> 'out';
    end if;
  end if;

  if p_delete then
    delete from public.documents where id = p_document_id and owner_id = p_owner_id;
  else
    update public.documents set status = 'cancelled',
      metadata = (coalesce(metadata, '{}'::jsonb) - 'inventoryPosted') || jsonb_build_object('inventoryReversedAt', now())
    where id = p_document_id and owner_id = p_owner_id returning * into v_doc;
  end if;
  return to_jsonb(v_doc);
end;
$$;

revoke all on function public.complete_inventory_document(uuid, uuid) from public;
revoke all on function public.reverse_inventory_document(uuid, uuid, boolean) from public;
grant execute on function public.complete_inventory_document(uuid, uuid) to service_role;
grant execute on function public.reverse_inventory_document(uuid, uuid, boolean) to service_role;
-- Query paths used by Goods In / Goods Out list and barcode workflows.

create index if not exists documents_inventory_list_idx
  on public.documents(owner_id, warehouse_id, document_type, created_at desc);

create index if not exists documents_inventory_status_list_idx
  on public.documents(owner_id, warehouse_id, document_type, status, created_at desc);

create index if not exists product_serials_exact_lookup_idx
  on public.product_serials(owner_id, warehouse_id, lower(serial_number));

create index if not exists product_serials_goods_in_idx
  on public.product_serials(owner_id, warehouse_id, goods_in_document_id)
  where goods_in_document_id is not null;

create index if not exists product_serials_goods_out_idx
  on public.product_serials(owner_id, warehouse_id, goods_out_document_id)
  where goods_out_document_id is not null;

create or replace function public.goods_in_serial_counts(
  p_owner_id uuid,
  p_warehouse_id uuid
) returns table(document_id uuid, serial_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select goods_in_document_id, count(*)
  from public.product_serials
  where owner_id = p_owner_id
    and (p_warehouse_id is null or warehouse_id = p_warehouse_id)
    and goods_in_document_id is not null
  group by goods_in_document_id;
$$;

create or replace function public.lookup_product_serial(
  p_owner_id uuid,
  p_warehouse_id uuid,
  p_serial_number text
) returns setof public.product_serials
language sql
stable
security definer
set search_path = public
as $$
  select serial.*
  from public.product_serials serial
  where serial.owner_id = p_owner_id
    and (p_warehouse_id is null or serial.warehouse_id = p_warehouse_id)
    and lower(serial.serial_number) = lower(trim(p_serial_number))
  limit 1;
$$;

revoke all on function public.goods_in_serial_counts(uuid, uuid) from public;
grant execute on function public.goods_in_serial_counts(uuid, uuid) to service_role;
revoke all on function public.lookup_product_serial(uuid, uuid, text) from public;
grant execute on function public.lookup_product_serial(uuid, uuid, text) to service_role;
-- Read-only reconciliation tools for rollout and ongoing monitoring.

create or replace function public.inventory_reconciliation(
  p_owner_id uuid,
  p_warehouse_id uuid
) returns table(
  product_id uuid,
  sku text,
  product_name text,
  stored_non_serial numeric,
  expected_non_serial numeric,
  difference numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with movements as (
    select di.product_id,
      sum(
        case d.document_type when 'goods_in' then 1 when 'goods_out' then -1 else 0 end
        * coalesce(nullif(di.metadata->>'baseQuantity', '')::numeric,
            coalesce(nullif(di.metadata->>'qtyInput', '')::numeric, di.quantity)
            * coalesce(nullif(di.metadata->>'unitMultiplier', '')::numeric,
                public.inventory_unit_multiplier(d.owner_id, d.warehouse_id, di.metadata->>'qtyUnit')))
      ) expected
    from public.documents d
    join public.document_items di on di.document_id = d.id
    where d.owner_id = p_owner_id
      and (p_warehouse_id is null or d.warehouse_id = p_warehouse_id)
      and d.status = 'completed'
      and d.document_type in ('goods_in', 'goods_out')
      and di.product_id is not null
      and coalesce((di.metadata->>'isSerial')::boolean, false) = false
      and coalesce((di.metadata->>'isUnrecorded')::boolean, false) = false
      and coalesce((di.metadata->>'isUnrecordedStock')::boolean, false) = false
    group by di.product_id
  )
  select p.id, p.sku, p.name,
    coalesce(nullif(p.metadata->>'stockNonSerial', '')::numeric, p.stock, 0),
    coalesce(m.expected, 0),
    coalesce(nullif(p.metadata->>'stockNonSerial', '')::numeric, p.stock, 0) - coalesce(m.expected, 0)
  from public.products p
  left join movements m on m.product_id = p.id
  where p.owner_id = p_owner_id
    and (p_warehouse_id is null or p.warehouse_id = p_warehouse_id)
  order by abs(coalesce(nullif(p.metadata->>'stockNonSerial', '')::numeric, p.stock, 0) - coalesce(m.expected, 0)) desc,
    p.name;
$$;

revoke all on function public.inventory_reconciliation(uuid, uuid) from public;
grant execute on function public.inventory_reconciliation(uuid, uuid) to service_role;

ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read warehouses" ON public.warehouses;
CREATE POLICY "Authenticated users can read warehouses" ON public.warehouses
  FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Authenticated users can read warehouse units" ON public.warehouse_units;
CREATE POLICY "Authenticated users can read warehouse units" ON public.warehouse_units
  FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Authenticated users can read purchase orders" ON public.purchase_orders;
CREATE POLICY "Authenticated users can read purchase orders" ON public.purchase_orders
  FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Authenticated users can read purchase order items" ON public.purchase_order_items;
CREATE POLICY "Authenticated users can read purchase order items" ON public.purchase_order_items
  FOR SELECT USING (auth.role() = 'authenticated');

-- Marker is upserted, so rerunning this full file never duplicates it.
CREATE TABLE IF NOT EXISTS public.docuflow_schema_state (
  key TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO public.docuflow_schema_state(key, applied_at, metadata)
VALUES ('full_idempotent_v1', now(), jsonb_build_object('phases', jsonb_build_array(1,2,3,4,5)))
ON CONFLICT (key) DO UPDATE SET applied_at = excluded.applied_at, metadata = excluded.metadata;

COMMIT;

