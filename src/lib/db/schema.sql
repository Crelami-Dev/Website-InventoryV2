-- ====================================================================
-- DocuFlow Inventory Multi-Owner V2.4.1
-- Schema Relasional Portabel (SQLite Dev -> Supabase PostgreSQL Ready)
-- Mematuhi: Spesifikasi V2.4.1, Desain Database Tahap 3, & AUDIT_FINALISASI_DATABASE
-- ====================================================================

PRAGMA foreign_keys = ON;

-- 1. IDENTITAS & AUTENTIKASI PENGGUNA
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  is_super_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_super_admin IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. SESI LOGIN AKTIF (Server-Side Session Store)
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_owner_id TEXT,
  active_warehouse_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 3. TENANT / OWNER MULTI-TENANT
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4. MASTER GUDANG PER OWNER
CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  conversion_display_unit TEXT NOT NULL DEFAULT 'pcs' CHECK (conversion_display_unit IN ('pcs', 'lusin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, code)
);

-- 5. KEANGGOTAAN OWNER (Multi-Owner Memberships)
CREATE TABLE IF NOT EXISTS owner_memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'STAFF', 'SALES', 'SUPER_ADMIN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, owner_id)
);

-- 6. PENUGASAN GUDANG STAFF/SALES
CREATE TABLE IF NOT EXISTS warehouse_assignments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  assigned_at TEXT NOT NULL,
  UNIQUE(user_id, warehouse_id)
);

-- 7. GRANT OPERASIONAL SUPER ADMIN (Berbatas Waktu & Diaudit)
CREATE TABLE IF NOT EXISTS admin_access_grants (
  id TEXT PRIMARY KEY,
  super_admin_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL,
  granted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

-- 8. MASTER PEMASOK (Suppliers)
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, code)
);

-- 9. MASTER PELANGGAN (Customers)
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_name TEXT,
  pic_sales TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, code)
);

-- 10. KATALOG PRODUK (Per Owner & Warehouse)
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  barcode TEXT,
  category TEXT NOT NULL,
  tracking_mode TEXT NOT NULL CHECK (tracking_mode IN ('SERIAL', 'NON_SERIAL')),
  unit TEXT NOT NULL DEFAULT 'pcs',
  min_stock NUMERIC NOT NULL DEFAULT 0,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, warehouse_id, sku)
);

-- 11. UNIT SERIAL NUMBER (SERIAL TRACKING)
CREATE TABLE IF NOT EXISTS product_serials (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  serial_number TEXT NOT NULL,
  normalized_serial_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'RESERVED', 'QUARANTINE', 'CONSUMED_OUT', 'DECOMMISSIONED', 'GROUPED', 'RETURNED_TO_SUPPLIER')),
  unit TEXT NOT NULL DEFAULT 'pcs',
  unit_quantity NUMERIC NOT NULL DEFAULT 1,
  base_quantity NUMERIC NOT NULL DEFAULT 1,
  is_group INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1)),
  parent_group_id TEXT,
  source_goods_in_id TEXT REFERENCES goods_in(id),
  source_line_id TEXT REFERENCES goods_in_lines(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, warehouse_id, normalized_serial_number)
);

-- 12. BUKU BESAR MUTASI STOK (Inventory Ledger - Immutable Source of Truth)
CREATE TABLE IF NOT EXISTS inventory_ledger (
  id TEXT PRIMARY KEY,
  sequence_number INTEGER NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  location_id TEXT,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('GOODS_IN_POSTED', 'GOODS_OUT_COMPLETED', 'STOCK_ADJUSTMENT_POSTED', 'RETURN_IN_POSTED', 'RETURN_OUT_POSTED', 'RETURN_REVERSAL_POSTED')),
  source_doc_type TEXT NOT NULL CHECK (source_doc_type IN ('GOODS_IN', 'GOODS_OUT', 'STOCK_OPNAME_ADJUSTMENT', 'RETURN')),
  source_doc_id TEXT NOT NULL,
  source_line_id TEXT NOT NULL,
  quantity_delta_base NUMERIC NOT NULL,
  serial_ids_json TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 13. RESERVASI STOK PENDING (Goods Out Pending Reservations)
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  goods_out_id TEXT NOT NULL,
  goods_out_line_id TEXT NOT NULL,
  reserved_base_qty NUMERIC NOT NULL CHECK (reserved_base_qty > 0),
  serial_ids_json TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED_COMPLETED', 'RELEASED_CANCELLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 14. DOKUMEN BARANG MASUK (Goods In)
CREATE TABLE IF NOT EXISTS goods_in (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,
  document_number TEXT NOT NULL,
  document_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'POSTED', 'CANCELLED')),
  return_status TEXT NOT NULL DEFAULT 'NONE' CHECK (return_status IN ('NONE', 'PARTIAL', 'FULL')),
  note TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  posted_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  posted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, document_number)
);

CREATE TABLE IF NOT EXISTS goods_in_lines (
  id TEXT PRIMARY KEY,
  goods_in_id TEXT NOT NULL REFERENCES goods_in(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL DEFAULT 'pcs',
  received_serials_json TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

-- 15. DOKUMEN BARANG KELUAR (Goods Out)
CREATE TABLE IF NOT EXISTS goods_out (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT,
  po_id TEXT REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  document_number TEXT NOT NULL,
  document_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED_TOMBSTONE')),
  return_status TEXT NOT NULL DEFAULT 'NONE' CHECK (return_status IN ('NONE', 'PARTIAL', 'FULL')),
  cancellation_reason TEXT,
  note TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  completed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  completed_at TEXT,
  cancelled_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, document_number)
);

CREATE TABLE IF NOT EXISTS goods_out_lines (
  id TEXT PRIMARY KEY,
  goods_out_id TEXT NOT NULL REFERENCES goods_out(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  po_line_id TEXT REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL DEFAULT 'pcs',
  allocated_serials_json TEXT,
  group_id TEXT,
  group_serials_snapshot_json TEXT,
  created_at TEXT NOT NULL
);

-- 16. SESI STOCK OPNAME
CREATE TABLE IF NOT EXISTS stock_opname_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  session_number TEXT NOT NULL,
  title TEXT,
  scope_config TEXT DEFAULT '{"type":"ALL"}',
  status TEXT NOT NULL DEFAULT 'COUNTING' CHECK (status IN ('DRAFT', 'COUNTING', 'REVIEW', 'ADJUSTED', 'COMPLETED', 'CANCELLED')),
  started_at TEXT NOT NULL,
  snapshot_at TEXT,
  reviewed_at TEXT,
  adjusted_at TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  finalized_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, session_number)
);

CREATE TABLE IF NOT EXISTS stock_opname_lines (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES stock_opname_sessions(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  snapshot_qty NUMERIC NOT NULL,
  dynamic_book_qty NUMERIC,
  counted_qty NUMERIC NOT NULL,
  variance_qty NUMERIC NOT NULL,
  reconciliation_status TEXT,
  discrepancy_reason TEXT,
  investigation_notes TEXT,
  scanned_serials_json TEXT,
  adjustment_posted INTEGER NOT NULL DEFAULT 0 CHECK (adjustment_posted IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_opname_areas (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES stock_opname_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location_code TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, name)
);

CREATE TABLE IF NOT EXISTS stock_opname_area_counts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES stock_opname_sessions(id) ON DELETE CASCADE,
  area_id TEXT NOT NULL REFERENCES stock_opname_areas(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  counted_qty_base NUMERIC NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'pcs',
  unit_quantity NUMERIC NOT NULL DEFAULT 1,
  scanned_serials_json TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(area_id, product_id)
);

CREATE TABLE IF NOT EXISTS stock_opname_serial_snapshots (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES stock_opname_sessions(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  serial_number TEXT NOT NULL,
  normalized_serial_number TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  unit_quantity NUMERIC NOT NULL DEFAULT 1,
  base_quantity NUMERIC NOT NULL DEFAULT 1,
  status_at_snapshot TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  UNIQUE(session_id, normalized_serial_number)
);

CREATE TABLE IF NOT EXISTS stock_opname_scan_errors (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES stock_opname_sessions(id) ON DELETE CASCADE,
  area_id TEXT NOT NULL REFERENCES stock_opname_areas(id) ON DELETE CASCADE,
  scanned_value TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at TEXT NOT NULL
);

-- 17. AUDIT LOGS (Append-Only Event Trail)
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT REFERENCES warehouses(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload_json TEXT,
  occurred_at TEXT NOT NULL
);

-- 18. PURCHASE ORDERS (Pesanan Penjualan Komersial Pelanggan)
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT REFERENCES warehouses(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  po_number TEXT NOT NULL,
  order_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED', 'REJECTED')),
  total_amount NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  sales_pic TEXT,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TEXT,
  rejected_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  rejected_at TEXT,
  rejection_reason TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, po_number)
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE RESTRICT,
  raw_product_name TEXT NOT NULL,
  ordered_qty NUMERIC NOT NULL DEFAULT 1 CHECK (ordered_qty > 0),
  ordered_unit TEXT NOT NULL DEFAULT 'PCS' CHECK (ordered_unit IN ('PCS', 'Lusin', 'pcs', 'lusin', 'unit')),
  conversion_factor NUMERIC NOT NULL DEFAULT 1 CHECK (conversion_factor > 0),
  mapping_status TEXT NOT NULL DEFAULT 'UNMAPPED' CHECK (mapping_status IN ('UNMAPPED', 'CATALOG_MATCHED', 'MAPPED', 'CONVERTED_TO_CATALOG')),
  target_qty NUMERIC NOT NULL DEFAULT 0,
  fulfilled_qty NUMERIC NOT NULL DEFAULT 0 CHECK (fulfilled_qty >= 0),
  unit_price NUMERIC NOT NULL DEFAULT 0,
  discount_amount NUMERIC NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 19. DOKUMEN KOMERSIAL / INVOICE (Commercial Documents)
CREATE TABLE IF NOT EXISTS commercial_documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT REFERENCES warehouses(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  po_id TEXT REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  document_number TEXT NOT NULL,
  document_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  document_type TEXT NOT NULL DEFAULT 'INVOICE' CHECK (document_type IN ('INVOICE', 'SAMPLE', 'SURAT_JALAN', 'RECEIPT')),
  status TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED')),
  subtotal NUMERIC NOT NULL DEFAULT 0,
  item_discount NUMERIC NOT NULL DEFAULT 0,
  doc_nominal_discount NUMERIC NOT NULL DEFAULT 0,
  doc_percentage_discount NUMERIC NOT NULL DEFAULT 0,
  shop_discount_note TEXT,
  points_redeemed NUMERIC NOT NULL DEFAULT 0,
  cashback_type TEXT NOT NULL DEFAULT 'NONE' CHECK (cashback_type IN ('PERCENTAGE', 'NOMINAL', 'NONE')),
  cashback_value NUMERIC NOT NULL DEFAULT 0,
  cashback_amount NUMERIC NOT NULL DEFAULT 0,
  total_amount NUMERIC NOT NULL DEFAULT 0,
  paid_amount NUMERIC NOT NULL DEFAULT 0,
  print_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, document_number)
);

-- 19B. BUKU BESAR POIN PELANGGAN (Customer Point Ledger)
CREATE TABLE IF NOT EXISTS customer_point_ledger (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  document_id TEXT REFERENCES commercial_documents(id) ON DELETE SET NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('EARNED_PENDING', 'EARNED_AVAILABLE', 'REDEEMED', 'REVERSED', 'ADJUSTED')),
  points NUMERIC NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commercial_document_lines (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES commercial_documents(id) ON DELETE CASCADE,
  source_order_item_id TEXT REFERENCES purchase_order_lines(id) ON DELETE SET NULL,
  product_id TEXT REFERENCES products(id) ON DELETE RESTRICT,
  product_name TEXT,
  description_snapshot TEXT,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL DEFAULT 'PCS',
  unit_price NUMERIC NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'NOMINAL' CHECK (discount_type IN ('NOMINAL', 'PERCENTAGE', 'NONE')),
  discount_value NUMERIC NOT NULL DEFAULT 0,
  line_total NUMERIC NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_payments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES commercial_documents(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  payment_number TEXT NOT NULL,
  payment_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('TRANSFER', 'TUNAI', 'GIRO', 'KARTU_KREDIT', 'LAINNYA')),
  reference_number TEXT,
  notes TEXT,
  received_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  proof_mime_type TEXT,
  proof_base64 TEXT,
  proof_file_name TEXT,
  proof_file_size INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, payment_number)
);

-- 20. RETUR BARANG (Inventory Returns)
CREATE TABLE IF NOT EXISTS inventory_returns (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  return_type TEXT NOT NULL DEFAULT 'CUSTOMER_RETURN' CHECK (return_type IN ('CUSTOMER_RETURN', 'SUPPLIER_RETURN')),
  customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,
  goods_out_id TEXT REFERENCES goods_out(id) ON DELETE RESTRICT,
  goods_in_id TEXT REFERENCES goods_in(id) ON DELETE RESTRICT,
  return_number TEXT NOT NULL,
  return_date TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('SALAH_KIRIM', 'PEMBATALAN', 'SALAH_INPUT', 'CACAT', 'LAINNYA')),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'RECEIVED', 'REJECTED', 'CANCELLED')),
  reopen_source_qty INTEGER NOT NULL DEFAULT 0 CHECK (reopen_source_qty IN (0, 1)),
  notes TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  received_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  received_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, return_number)
);

CREATE TABLE IF NOT EXISTS inventory_return_lines (
  id TEXT PRIMARY KEY,
  return_id TEXT NOT NULL REFERENCES inventory_returns(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL DEFAULT 'pcs',
  condition TEXT NOT NULL DEFAULT 'BAIK' CHECK (condition IN ('BAIK', 'RUSAK')),
  returned_serials_json TEXT,
  group_id TEXT,
  group_return_mode TEXT CHECK (group_return_mode IN ('WHOLE_GROUP', 'ECERAN_DISSOLVE')),
  created_at TEXT NOT NULL
);

-- 33. HEADER TRANSAKSI GROUPING SERIAL (Wadah SN, Bukan Produk Baru, Tanpa Kolom Harga)
CREATE TABLE IF NOT EXISTS serial_groupings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  group_number TEXT NOT NULL UNIQUE,
  group_name TEXT,
  product_id TEXT REFERENCES products(id) ON DELETE RESTRICT,
  unit TEXT NOT NULL CHECK (unit IN ('pcs', 'lusin')),
  unit_qty NUMERIC NOT NULL DEFAULT 1 CHECK (unit_qty > 0),
  total_base_qty_pcs NUMERIC NOT NULL CHECK (total_base_qty_pcs > 0),
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'RESERVED', 'CONSUMED_OUT', 'DISSOLVED')),
  notes TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  dissolved_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  dissolved_at TEXT,
  UNIQUE(owner_id, warehouse_id, group_number)
);

-- 34. DETAIL KOMPONEN SERIAL GROUPING
CREATE TABLE IF NOT EXISTS serial_grouping_components (
  id TEXT PRIMARY KEY,
  grouping_id TEXT NOT NULL REFERENCES serial_groupings(id) ON DELETE CASCADE,
  serial_id TEXT NOT NULL REFERENCES product_serials(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  snapshot_product_name TEXT NOT NULL,
  snapshot_sku TEXT NOT NULL,
  base_qty_pcs NUMERIC NOT NULL CHECK (base_qty_pcs > 0),
  created_at TEXT NOT NULL,
  UNIQUE(grouping_id, serial_id)
);

-- INDEKS OPTIMASI PERFORMA & ISOLASI
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_warehouses_owner ON warehouses(owner_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON owner_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_owner ON owner_memberships(owner_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_assignments_user ON warehouse_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_products_owner_wh ON products(owner_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_product_serials_product ON product_serials(product_id);
CREATE INDEX IF NOT EXISTS idx_product_serials_status ON product_serials(owner_id, warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_ledger_product ON inventory_ledger(owner_id, warehouse_id, product_id);
CREATE INDEX IF NOT EXISTS idx_reservations_product ON reservations(owner_id, warehouse_id, product_id, status);
CREATE INDEX IF NOT EXISTS idx_goods_in_owner ON goods_in(owner_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_goods_out_owner ON goods_out(owner_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_opname_owner ON stock_opname_sessions(owner_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit_logs(owner_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_po_owner ON purchase_orders(owner_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_comm_docs_owner ON commercial_documents(owner_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_comm_docs_owner_wh ON commercial_documents(owner_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_comm_doc_lines_doc ON commercial_document_lines(owner_id, document_id);
CREATE INDEX IF NOT EXISTS idx_point_ledger_customer ON customer_point_ledger(owner_id, customer_id, entry_type);
CREATE INDEX IF NOT EXISTS idx_returns_owner ON inventory_returns(owner_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_serial_groupings_owner_wh ON serial_groupings(owner_id, warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_serial_groupings_number ON serial_groupings(group_number);
CREATE INDEX IF NOT EXISTS idx_sg_components_grouping ON serial_grouping_components(grouping_id);
CREATE INDEX IF NOT EXISTS idx_sg_components_serial ON serial_grouping_components(serial_id);
CREATE INDEX IF NOT EXISTS idx_product_serials_group ON product_serials(parent_group_id);

