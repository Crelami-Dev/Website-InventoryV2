/**
 * DEVELOPMENT-ONLY FIXTURE — BUKAN DATA PRODUKSI.
 * Seluruh data di sini adalah fixture statis untuk kebutuhan interaksi UI Fase 3
 * sebelum migrasi database dan backend RPC diintegrasikan pada Fase 4.
 * Jangan pernah menggunakan data ini sebagai data produksi!
 */

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  address: string;
  isAssignedToCurrentUser?: boolean;
}

export interface StorageLocation {
  id: string;
  warehouseId: string;
  code: string;
  name: string;
  type: "RAK" | "RUANG" | "AREA" | "SUDUT";
}

export interface Product {
  id: string;
  warehouseId: string;
  name: string;
  sku: string;
  barcode?: string;
  category: string;
  tracking: "SERIAL" | "NON_SERIAL";
  unit: string;
  stock: number;
  minStock?: number;
  status: "ACTIVE" | "INACTIVE";
  description?: string;
  serialCount?: number;
}

export interface SerialNumberItem {
  id: string;
  productId: string;
  warehouseId: string;
  serialNumber: string;
  status: "AVAILABLE" | "RESERVED" | "OUT" | "QUARANTINE" | "GROUPED";
  location?: string;
  receivedAt: string;
  lastReference?: string;
}

export interface StockHistoryItem {
  id: string;
  productId: string;
  warehouseId: string;
  timestamp: string;
  type: "GOODS_IN" | "GOODS_OUT" | "OPNAME_ADJUSTMENT" | "RETURN";
  reference: string;
  changeQty: number;
  balanceQty: number;
  unit: string;
  actor: string;
  note?: string;
}

export interface Partner {
  id: string;
  ownerId: string;
  type: "CUSTOMER" | "SUPPLIER";
  name: string;
  code: string;
  ownerName?: string;
  picSales?: string;
  phone: string;
  email: string;
  address: string;
  status: "ACTIVE" | "INACTIVE";
  availablePoints?: number;
  pendingPoints?: number;
}

export interface GoodsInTransaction {
  id: string;
  reference: string;
  warehouseId: string;
  warehouseName: string;
  supplierId: string;
  supplierName: string;
  date: string;
  status: "DRAFT" | "PENDING" | "AWAITING_SN" | "POSTED";
  createdBy: string;
  notes?: string;
  items: {
    productId: string;
    productName: string;
    sku: string;
    tracking: "SERIAL" | "NON_SERIAL";
    qty: number;
    unit: string;
    serials?: string[];
  }[];
}

export interface GoodsOutTransaction {
  id: string;
  reference: string;
  poId?: string;
  poNumber?: string;
  warehouseId: string;
  warehouseName: string;
  recipientName: string;
  recipientAddress: string;
  date: string;
  status: "DRAFT" | "PENDING" | "COMPLETED" | "CANCELLED";
  createdBy: string;
  notes?: string;
  items: {
    productId: string;
    productName: string;
    sku: string;
    tracking: "SERIAL" | "NON_SERIAL";
    qty: number;
    unit: string;
    serials?: string[];
  }[];
}

export interface StockOpnameSession {
  id: string;
  sessionNumber: string;
  warehouseId: string;
  warehouseName: string;
  scope: "ALL" | "CATEGORY" | "LOCATION";
  scopeDetail?: string;
  status: "DRAFT" | "IN_PROGRESS" | "REVIEW" | "APPROVED" | "COMPLETED";
  createdAt: string;
  createdBy: string;
  snapshotFrozenAt?: string;
  notes?: string;
  itemCount: number;
  varianceCount: number;
}

export interface StockOpnameCountItem {
  id: string;
  sessionId: string;
  productId: string;
  productName: string;
  sku: string;
  tracking: "SERIAL" | "NON_SERIAL";
  snapshotQty: number;
  countedQty: number;
  variance: number;
  unit: string;
  scannedSerials: string[];
  unknownSerials: string[];
  status: "MATCH" | "SURPLUS" | "DEFICIT";
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  date: string;
  customerId: string;
  customerName: string;
  status: "DRAFT" | "CONFIRMED" | "PARTIALLY_FULFILLED" | "FULFILLED" | "CANCELLED";
  totalAmount: number;
  notes?: string;
  items: {
    productId: string;
    productName: string;
    sku: string;
    orderedQty: number;
    fulfilledQty: number;
    unit: string;
    unitPrice: number;
  }[];
}

export interface CommercialDocument {
  id: string;
  docNumber: string;
  type: "INVOICE" | "SAMPLE" | "SURAT_JALAN" | "RECEIPT" | "DELIVERY_NOTE" | "QUOTATION";
  date: string;
  dueDate?: string;
  poReference?: string;
  partnerName: string;
  customerId?: string;
  subtotal: number;
  itemDiscount: number;
  documentDiscount: number;
  pointsRedeemed: number;
  total: number;
  paidAmount: number;
  printCount: number;
  paymentStatus: "UNPAID" | "PARTIAL" | "PAID" | "OVERDUE" | "NOT_APPLICABLE";
  notes?: string;
  status?: string;
}

export interface ReturnItem {
  id: string;
  returnNumber: string;
  returnType?: "CUSTOMER_RETURN" | "SUPPLIER_RETURN";
  sourceReference: string;
  warehouseId: string;
  warehouseName: string;
  date: string;
  partnerName: string;
  reason: "SALAH_KIRIM" | "PEMBATALAN" | "SALAH_INPUT" | "CACAT" | "LAINNYA";
  reopenSourceQty: boolean;
  status: "DRAFT" | "RECEIVED" | "COMPLETED" | "CANCELLED" | "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  notes?: string;
  items: {
    productId: string;
    productName: string;
    qty: number;
    unit: string;
    serialNumbers?: string[];
    condition: "BAIK" | "RUSAK";
  }[];
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  reason?: string;
  details: string;
}

/* =========================================================================
   FIXTURE DATA REALISTIS (DEVELOPMENT ONLY)
   ========================================================================= */

export const FIXTURE_WAREHOUSES: Warehouse[] = [
  { id: "wh-01", code: "WH-UTAMA", name: "Gudang Utama", address: "Kawasan Industri Blok A-1, Jakarta", isAssignedToCurrentUser: true },
  { id: "wh-02", code: "WH-TRANSIT", name: "Gudang Transit Barat", address: "Sentra Logistik Barat Kav 4, Tangerang", isAssignedToCurrentUser: true },
];

export const FIXTURE_LOCATIONS: StorageLocation[] = [
  { id: "loc-01", warehouseId: "wh-01", code: "RAK-A1", name: "Rak Elektronik A1", type: "RAK" },
  { id: "loc-02", warehouseId: "wh-01", code: "RAK-A2", name: "Rak Kabel A2", type: "RAK" },
  { id: "loc-03", warehouseId: "wh-01", code: "AREA-BULK", name: "Area Kardus & Pallet", type: "AREA" },
  { id: "loc-04", warehouseId: "wh-02", code: "SUDUT-B1", name: "Sudut Transit Cepat", type: "SUDUT" },
];

export const FIXTURE_PRODUCTS: Product[] = [
  {
    id: "prod-01",
    warehouseId: "wh-01",
    name: "Kabel UTP Cat6 305m",
    sku: "CAB-CAT6-305",
    barcode: "899123456001",
    category: "Jaringan",
    tracking: "NON_SERIAL",
    unit: "roll",
    stock: 42,
    minStock: 10,
    status: "ACTIVE",
    description: "Kabel jaringan Cat6 unshielded twisted pair roll kayu.",
  },
  {
    id: "prod-02",
    warehouseId: "wh-01",
    name: "Mouse Optical USB B100",
    sku: "MSE-OPT-USB",
    barcode: "899123456002",
    category: "Aksesoris",
    tracking: "SERIAL",
    unit: "unit",
    stock: 18,
    minStock: 5,
    status: "ACTIVE",
    serialCount: 18,
    description: "Mouse kabel USB 3-tombol optical tracking presisi tinggi.",
  },
  {
    id: "prod-03",
    warehouseId: "wh-01",
    name: "Barcode Scanner 2D QR Wireless",
    sku: "SCN-2D-WRL",
    barcode: "899123456003",
    category: "Elektronik",
    tracking: "SERIAL",
    unit: "unit",
    stock: 4,
    minStock: 8,
    status: "ACTIVE",
    serialCount: 4,
    description: "Pemindai barcode nirkabel Bluetooth & 2.4GHz USB dongle.",
  },
  {
    id: "prod-04",
    warehouseId: "wh-01",
    name: "Konektor RJ45 Cat6 Passthrough",
    sku: "CON-RJ45-P50",
    barcode: "899123456004",
    category: "Jaringan",
    tracking: "NON_SERIAL",
    unit: "pack",
    stock: 120,
    minStock: 30,
    status: "ACTIVE",
    description: "Isi 50 pcs konektor RJ45 passthrough gold plated.",
  },
  {
    id: "prod-05",
    warehouseId: "wh-01",
    name: "Switch Gigabit 24-Port Rackmount",
    sku: "SWT-GB-24P",
    barcode: "899123456005",
    category: "Jaringan",
    tracking: "SERIAL",
    unit: "unit",
    stock: 6,
    minStock: 3,
    status: "ACTIVE",
    serialCount: 6,
    description: "Unmanaged switch 24-port Gigabit Ethernet 1U rackmount.",
  },
  {
    id: "prod-06",
    warehouseId: "wh-02",
    name: "Kabel UTP Cat6 305m (Transit)",
    sku: "CAB-CAT6-305",
    category: "Jaringan",
    tracking: "NON_SERIAL",
    unit: "roll",
    stock: 15,
    minStock: 5,
    status: "ACTIVE",
  },
];

export const FIXTURE_SERIALS: SerialNumberItem[] = [
  { id: "sn-01", productId: "prod-02", warehouseId: "wh-01", serialNumber: "WH01-MSE-20261001-001", status: "AVAILABLE", location: "RAK-A1", receivedAt: "2026-10-01" },
  { id: "sn-02", productId: "prod-02", warehouseId: "wh-01", serialNumber: "WH01-MSE-20261001-002", status: "AVAILABLE", location: "RAK-A1", receivedAt: "2026-10-01" },
  { id: "sn-03", productId: "prod-02", warehouseId: "wh-01", serialNumber: "WH01-MSE-20261001-003", status: "RESERVED", location: "RAK-A1", receivedAt: "2026-10-01", lastReference: "GI-202610-001" },
  { id: "sn-04", productId: "prod-03", warehouseId: "wh-01", serialNumber: "WH01-SCN-20260915-001", status: "AVAILABLE", location: "RAK-A1", receivedAt: "2026-09-15" },
  { id: "sn-05", productId: "prod-03", warehouseId: "wh-01", serialNumber: "WH01-SCN-20260915-002", status: "AVAILABLE", location: "RAK-A1", receivedAt: "2026-09-15" },
  { id: "sn-06", productId: "prod-05", warehouseId: "wh-01", serialNumber: "WH01-SWT-20260810-001", status: "AVAILABLE", location: "AREA-BULK", receivedAt: "2026-08-10" },
];

export const FIXTURE_STOCK_HISTORY: StockHistoryItem[] = [
  { id: "sh-01", productId: "prod-01", warehouseId: "wh-01", timestamp: "2026-10-12 09:30", type: "GOODS_IN", reference: "GI-202610-001", changeQty: 20, balanceQty: 42, unit: "roll", actor: "staff1@docuflow.id", note: "Penerimaan PO-2026-001" },
  { id: "sh-02", productId: "prod-01", warehouseId: "wh-01", timestamp: "2026-10-10 14:15", type: "GOODS_OUT", reference: "GO-202610-002", changeQty: -8, balanceQty: 22, unit: "roll", actor: "staff1@docuflow.id", note: "Pengiriman ke PT Solusi Prima" },
  { id: "sh-03", productId: "prod-02", warehouseId: "wh-01", timestamp: "2026-10-01 11:00", type: "GOODS_IN", reference: "GI-202610-002", changeQty: 18, balanceQty: 18, unit: "unit", actor: "owner@docuflow.id", note: "Barang masuk perdana" },
];

export const FIXTURE_PARTNERS: Partner[] = [
  { id: "part-01", ownerId: "demo-owner", type: "SUPPLIER", name: "PT Sumber Jaringan Nusantara", code: "SUP-SJN", phone: "021-5550192", email: "sales@sumberjaringan.id", address: "Gedung Cyber 2 Lt. 8, Kuningan, Jakarta Selatan", status: "ACTIVE" },
  { id: "part-02", ownerId: "demo-owner", type: "SUPPLIER", name: "CV Mitra Aksesoris Global", code: "SUP-MAG", phone: "031-8901234", email: "order@mitraaksesoris.com", address: "Jl. Rungkut Industri No. 45, Surabaya", status: "ACTIVE" },
  { id: "part-03", ownerId: "demo-owner", type: "CUSTOMER", name: "PT Solusi Prima Integrasi", code: "CUST-SPI", phone: "021-8899771", email: "procurement@solusiprima.co.id", address: "Jl. TB Simatupang No. 18, Jakarta Selatan", status: "ACTIVE" },
  { id: "part-04", ownerId: "demo-owner", type: "CUSTOMER", name: "Klinik Medika Digital Pratama", code: "CUST-KMD", phone: "022-7788990", email: "it@medikadigital.id", address: "Jl. Dago Asri No. 12, Bandung", status: "ACTIVE" },
];

export const FIXTURE_GOODS_IN: GoodsInTransaction[] = [
  {
    id: "gi-01",
    reference: "GI-202610-001",
    warehouseId: "wh-01",
    warehouseName: "Gudang Utama",
    supplierId: "part-01",
    supplierName: "PT Sumber Jaringan Nusantara",
    date: "2026-10-14",
    status: "PENDING",
    createdBy: "staff1@docuflow.id",
    notes: "Pengiriman batch 1 kabel dan konektor.",
    items: [
      { productId: "prod-01", productName: "Kabel UTP Cat6 305m", sku: "CAB-CAT6-305", tracking: "NON_SERIAL", qty: 10, unit: "roll" },
      { productId: "prod-04", productName: "Konektor RJ45 Cat6 Passthrough", sku: "CON-RJ45-P50", tracking: "NON_SERIAL", qty: 20, unit: "pack" },
    ],
  },
  {
    id: "gi-02",
    reference: "GI-202610-002",
    warehouseId: "wh-01",
    warehouseName: "Gudang Utama",
    supplierId: "part-02",
    supplierName: "CV Mitra Aksesoris Global",
    date: "2026-10-13",
    status: "AWAITING_SN",
    createdBy: "staff1@docuflow.id",
    notes: "Barang serial belum selesai scan nomor seri.",
    items: [
      { productId: "prod-02", productName: "Mouse Optical USB B100", sku: "MSE-OPT-USB", tracking: "SERIAL", qty: 5, unit: "unit", serials: ["WH01-MSE-20261001-001", "WH01-MSE-20261001-002"] },
    ],
  },
  {
    id: "gi-03",
    reference: "GI-202609-089",
    warehouseId: "wh-01",
    warehouseName: "Gudang Utama",
    supplierId: "part-01",
    supplierName: "PT Sumber Jaringan Nusantara",
    date: "2026-09-28",
    status: "POSTED",
    createdBy: "owner@docuflow.id",
    notes: "Penerimaan lengkap dan stok terposting.",
    items: [
      { productId: "prod-05", productName: "Switch Gigabit 24-Port Rackmount", sku: "SWT-GB-24P", tracking: "SERIAL", qty: 2, unit: "unit", serials: ["WH01-SWT-20260810-001", "WH01-SWT-20260810-002"] },
    ],
  },
];

export const FIXTURE_GOODS_OUT: GoodsOutTransaction[] = [
  {
    id: "go-01",
    reference: "GO-202610-001",
    warehouseId: "wh-01",
    warehouseName: "Gudang Utama",
    recipientName: "PT Solusi Prima Integrasi",
    recipientAddress: "Jl. TB Simatupang No. 18, Jakarta Selatan",
    date: "2026-10-14",
    status: "PENDING",
    createdBy: "staff1@docuflow.id",
    notes: "Merestok site instalasi. Stok ter-reservasi di sistem.",
    items: [
      { productId: "prod-01", productName: "Kabel UTP Cat6 305m", sku: "CAB-CAT6-305", tracking: "NON_SERIAL", qty: 4, unit: "roll" },
      { productId: "prod-02", productName: "Mouse Optical USB B100", sku: "MSE-OPT-USB", tracking: "SERIAL", qty: 1, unit: "unit", serials: ["WH01-MSE-20261001-003"] },
    ],
  },
  {
    id: "go-02",
    reference: "GO-202610-002",
    warehouseId: "wh-01",
    warehouseName: "Gudang Utama",
    recipientName: "Klinik Medika Digital Pratama",
    recipientAddress: "Jl. Dago Asri No. 12, Bandung",
    date: "2026-10-11",
    status: "COMPLETED",
    createdBy: "staff1@docuflow.id",
    notes: "Barang telah keluar fisik dan ledger terpotong atomik.",
    items: [
      { productId: "prod-04", productName: "Konektor RJ45 Cat6 Passthrough", sku: "CON-RJ45-P50", tracking: "NON_SERIAL", qty: 5, unit: "pack" },
    ],
  },
];

export const FIXTURE_OPNAME_SESSIONS: StockOpnameSession[] = [
  {
    id: "so-01",
    sessionNumber: "SO-202610-WH01",
    warehouseId: "wh-01",
    warehouseName: "Gudang Utama",
    scope: "CATEGORY",
    scopeDetail: "Jaringan",
    status: "IN_PROGRESS",
    createdAt: "2026-10-14 08:00",
    createdBy: "owner@docuflow.id",
    snapshotFrozenAt: "2026-10-14 08:00:00",
    notes: "Opname bulanan kategori jaringan.",
    itemCount: 3,
    varianceCount: 1,
  },
  {
    id: "so-02",
    sessionNumber: "SO-202609-WH01",
    warehouseId: "wh-01",
    warehouseName: "Gudang Utama",
    scope: "ALL",
    status: "COMPLETED",
    createdAt: "2026-09-30 09:00",
    createdBy: "owner@docuflow.id",
    snapshotFrozenAt: "2026-09-30 09:00:00",
    itemCount: 5,
    varianceCount: 0,
  },
];

export const FIXTURE_OPNAME_ITEMS: StockOpnameCountItem[] = [
  {
    id: "so-item-01",
    sessionId: "so-01",
    productId: "prod-01",
    productName: "Kabel UTP Cat6 305m",
    sku: "CAB-CAT6-305",
    tracking: "NON_SERIAL",
    snapshotQty: 42,
    countedQty: 40,
    variance: -2,
    unit: "roll",
    scannedSerials: [],
    unknownSerials: [],
    status: "DEFICIT",
  },
  {
    id: "so-item-02",
    sessionId: "so-01",
    productId: "prod-04",
    productName: "Konektor RJ45 Cat6 Passthrough",
    sku: "CON-RJ45-P50",
    tracking: "NON_SERIAL",
    snapshotQty: 120,
    countedQty: 120,
    variance: 0,
    unit: "pack",
    scannedSerials: [],
    unknownSerials: [],
    status: "MATCH",
  },
  {
    id: "so-item-03",
    sessionId: "so-01",
    productId: "prod-05",
    productName: "Switch Gigabit 24-Port Rackmount",
    sku: "SWT-GB-24P",
    tracking: "SERIAL",
    snapshotQty: 6,
    countedQty: 6,
    variance: 0,
    unit: "unit",
    scannedSerials: ["WH01-SWT-20260810-001"],
    unknownSerials: [],
    status: "MATCH",
  },
];

export const FIXTURE_PURCHASE_ORDERS: PurchaseOrder[] = [
  {
    id: "po-01",
    poNumber: "PO-2026-001",
    date: "2026-10-10",
    customerId: "part-03",
    customerName: "PT Solusi Prima Integrasi",
    status: "PARTIALLY_FULFILLED",
    totalAmount: 18500000,
    notes: "Fulfillment terbagi dalam 2 Goods Out terpisah.",
    items: [
      { productId: "prod-01", productName: "Kabel UTP Cat6 305m", sku: "CAB-CAT6-305", orderedQty: 10, fulfilledQty: 4, unit: "roll", unitPrice: 1250000 },
      { productId: "prod-05", productName: "Switch Gigabit 24-Port Rackmount", sku: "SWT-GB-24P", orderedQty: 2, fulfilledQty: 2, unit: "unit", unitPrice: 3000000 },
    ],
  },
  {
    id: "po-02",
    poNumber: "PO-2026-002",
    date: "2026-10-13",
    customerId: "part-04",
    customerName: "Klinik Medika Digital Pratama",
    status: "CONFIRMED",
    totalAmount: 4200000,
    notes: "Menunggu jadwal pengiriman dari Gudang Utama.",
    items: [
      { productId: "prod-03", productName: "Barcode Scanner 2D QR Wireless", sku: "SCN-2D-WRL", orderedQty: 2, fulfilledQty: 0, unit: "unit", unitPrice: 2100000 },
    ],
  },
];

export const FIXTURE_DOCUMENTS: CommercialDocument[] = [
  {
    id: "doc-01",
    docNumber: "INV-202610-001",
    type: "INVOICE",
    date: "2026-10-11",
    dueDate: "2026-10-25",
    poReference: "PO-2026-001",
    partnerName: "PT Solusi Prima Integrasi",
    subtotal: 18500000,
    itemDiscount: 500000,
    documentDiscount: 200000,
    pointsRedeemed: 0,
    total: 17800000,
    paidAmount: 5000000,
    printCount: 1,
    paymentStatus: "PARTIAL",
    notes: "Invoice parsial pertama untuk PO-2026-001. Pembuatan invoice tidak memotong stok fisik.",
  },
  {
    id: "doc-02",
    docNumber: "INV-202610-002",
    type: "INVOICE",
    date: "2026-10-14",
    dueDate: "2026-10-28",
    poReference: "PO-2026-002",
    partnerName: "Klinik Medika Digital Pratama",
    subtotal: 4200000,
    itemDiscount: 0,
    documentDiscount: 0,
    pointsRedeemed: 100000,
    total: 4100000,
    paidAmount: 0,
    printCount: 0,
    paymentStatus: "UNPAID",
    notes: "Penukaran poin diterapkan pada urutan terakhir sesuai keputusan bisnis.",
  },
];

export const FIXTURE_RETURNS: ReturnItem[] = [
  {
    id: "ret-01",
    returnNumber: "RET-202610-001",
    sourceReference: "GO-202610-002",
    warehouseId: "wh-01",
    warehouseName: "Gudang Utama",
    date: "2026-10-13",
    partnerName: "Klinik Medika Digital Pratama",
    reason: "SALAH_KIRIM",
    reopenSourceQty: true,
    status: "APPROVED",
    notes: "Salah varian warna konektor, kuantitas sumber dibuka kembali (reopen=true).",
    items: [
      { productId: "prod-04", productName: "Konektor RJ45 Cat6 Passthrough", qty: 2, unit: "pack", condition: "BAIK" },
    ],
  },
  {
    id: "ret-02",
    returnNumber: "RET-202610-002",
    sourceReference: "GO-202609-012",
    warehouseId: "wh-01",
    warehouseName: "Gudang Utama",
    date: "2026-10-14",
    partnerName: "PT Solusi Prima Integrasi",
    reason: "CACAT",
    reopenSourceQty: false,
    status: "PENDING_REVIEW",
    notes: "Port scanner tidak mengisi daya (cacat pabrik). Kuantitas sumber tidak dibuka (reopen=false).",
    items: [
      { productId: "prod-03", productName: "Barcode Scanner 2D QR Wireless", qty: 1, unit: "unit", serialNumbers: ["WH01-SCN-20260915-002"], condition: "RUSAK" },
    ],
  },
];

export const FIXTURE_AUDIT_LOGS: AuditLogEntry[] = [
  {
    id: "aud-01",
    timestamp: "2026-10-14 11:20:05",
    actorEmail: "staff1@docuflow.id",
    actorRole: "STAFF",
    action: "CREATE_GOODS_OUT_PENDING",
    targetType: "GOODS_OUT",
    targetId: "GO-202610-001",
    reason: "Pengiriman instalasi site",
    details: "Mereservasi 4 roll CAB-CAT6-305 dan 1 SN WH01-MSE-20261001-003 pada Gudang Utama.",
  },
  {
    id: "aud-02",
    timestamp: "2026-10-14 08:00:12",
    actorEmail: "owner@docuflow.id",
    actorRole: "OWNER",
    action: "CREATE_OPNAME_SESSION",
    targetType: "STOCK_OPNAME",
    targetId: "SO-202610-WH01",
    details: "Membekukan snapshot stok kategori Jaringan tanpa mutasi saldo fisik.",
  },
  {
    id: "aud-03",
    timestamp: "2026-10-13 16:45:00",
    actorEmail: "owner@docuflow.id",
    actorRole: "OWNER",
    action: "APPROVE_RETURN",
    targetType: "RETURN",
    targetId: "RET-202610-001",
    reason: "SALAH_KIRIM",
    details: "Menyetujui retur 2 pack konektor RJ45 dan membuka kembali kuantitas sumber.",
  },
  {
    id: "aud-04",
    timestamp: "2026-10-12 14:30:22",
    actorEmail: "superadmin@docuflow.id",
    actorRole: "SUPER_ADMIN",
    action: "ACTIVE_GRANT_ACCESS",
    targetType: "SUPER_ADMIN_GRANT",
    targetId: "grant-001",
    reason: "Pemeriksaan integritas snapshot",
    details: "Mengakses tenant demo-owner atas nama Owner dengan active grant berdurasi terbatas.",
  },
];
