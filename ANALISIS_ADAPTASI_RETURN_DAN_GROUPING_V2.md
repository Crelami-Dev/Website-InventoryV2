# ANALISIS & SPESIFIKASI ADAPTASI FITUR RETURN DAN GROUPING SERIAL: DOCUFLOW V1 KE V2 (SQLITE + NEXT.JS)

**Dokumen Rujukan:** `reference-inventory` (DocuFlow V1 Express/Supabase)  
**Target Implementasi:** `DocuflowV2` (Next.js App Router + SQLite Development Database)  
**Tanggal:** 24 Oktober 2026  
**Penulis:** Hermes AI Command Center (Multi-Agent Team Orchestrator)

---

## 1. Ringkasan Eksekutif & Perbedaan Arsitektur

DocuFlow V1 dan V2 memiliki perbedaan fundamental dalam arsitektur penanganan stok dan data:

| Komponen | DocuFlow V1 (`reference-inventory`) | DocuFlow V2 (`DocuflowV2`) |
| :--- | :--- | :--- |
| **Framework & Engine** | Express.js (Node.js ESM) + React Vite | Next.js 15+ (App Router) + TypeScript |
| **Database** | PostgreSQL / Supabase Cloud (JSONB denormalized) | **SQLite Lokal (Dev)** $\to$ PostgreSQL/Supabase Ready |
| **Model Stok** | Kolom mutasi `products.stock` di-update langsung + RPC | **Immutable Inventory Ledger** (`inventory_ledger`) sebagai *Single Source of Truth* |
| **Pelacakan Retur** | Disimpan di dalam kolom JSON `documents.metadata->returns` | Tabel mandiri berelasi: `inventory_returns` & `inventory_return_lines` |
| **Siklus Retur Batal (Restore)** | RPC `restore_goods_out_return` / inline query | Reversal Ledger (`RETURN_CANCELLED`) & pemulihan reservasi/serial |
| **Serial Grouping** | Tabel `serial_groupings` + recursive JSON metadata | Tabel `serial_groupings` + komponen, ditopang Ledger mutasi internal |

---

## 2. Analisis Alur Return (Retur Barang) & Penyesuaian ke V2

Di V1, terdapat dua jenis retur: **Retur Barang Masuk (Goods In Return)** dan **Retur Barang Keluar (Goods Out Return)**, serta mekanisme **Pembatalan Retur (Restore/Reversal)** jika retur tidak jadi/salah input.

### A. Alur Retur Goods In (Pembalikan ke Pemasok)
1. **Kasus Bisnis:** Barang cacat dari pemasok saat diterima atau dikembalikan ke supplier setelah masuk gudang.
2. **Di V1:** Mengurangi stok produk di master `products.stock`, menghapus atau mengubah status serial menjadi `out` / `returned`.
3. **Adaptasi di V2 (Ledger-Based):**
   * **Stok Produk:** Dibuat baris baru di `inventory_ledger`:
     - `entry_type`: `GOODS_IN_RETURN_POSTED`
     - `quantity_delta_base`: Nilai negatif ($-\text{qty dasar}$).
   * **Serial Number:** Update status di `product_serials`:
     - Beralih dari `AVAILABLE` $\to$ `DECOMMISSIONED` atau `CONSUMED_OUT` (dengan catatan `reason: RETURN_TO_SUPPLIER`).
   * **Bagaimana jika Retur Goods In Dibatalkan (Restore)?**
     - Terbitkan baris pembalik di `inventory_ledger`: `entry_type: GOODS_IN_RETURN_RESTORED` dengan `quantity_delta_base` positif ($+\text{qty dasar}$).
     - Kembalikan status serial number dari `DECOMMISSIONED` $\to$ `AVAILABLE`.

### B. Alur Retur Goods Out (Pengembalian dari Pelanggan)
1. **Kasus Bisnis:** Pelanggan mengembalikan barang (salah kirim, cacat, batal beli).
2. **Di V1:** 
   - Dilakukan lewat RPC `process_goods_out_return`.
   - Mengembalikan status serial menjadi `available` (atau `damaged` jika cacat).
   - Menambahkan kembali kuantitas fisik ke `products.stock` sesuai multiplier satuan.
3. **Adaptasi di V2:**
   * Masuk ke tabel `inventory_returns` dengan status `RECEIVED`.
   * **Stok Produk:** Terbitkan baris ledger `RETURN_IN_POSTED` pada `inventory_ledger`:
     - `quantity_delta_base`: Nilai positif ($+\text{qty dasar}$) jika kondisi barang `BAIK`.
     - Jika kondisi `RUSAK`, dicatat ke area karantina (`QUARANTINE`) tanpa menambah stok siap jual.
   * **Serial Number:** 
     - Update record `product_serials` yang tadinya `CONSUMED_OUT` kembali ke `AVAILABLE` (atau `QUARANTINE`).
   * **Bagaimana jika Retur Goods Out Dibatalkan ("Tidak Jadi / Salah Retur")?**
     - Di V1 ada endpoint `/documents/:id/returns/:returnId/restore`.
     - Di V2: Status `inventory_returns` diubah menjadi `CANCELLED`.
     - Terbitkan baris pembalik di `inventory_ledger`: `entry_type: RETURN_IN_CANCELLED` dengan `quantity_delta_base` negatif ($-\text{qty dasar}$).
     - Status serial dikembalikan lagi menjadi `CONSUMED_OUT` (karena barang aslinya tetap berada di tangan customer).

---

## 3. Analisis Alur Grouping Serial Number & Penyesuaian ke V2

Grouping serial number memungkinkan penggabungan beberapa box/pack kecil menjadi 1 karton/pallet besar, baik **produk sejenis (single-product)** maupun **lintas produk (cross-product bundling)**.

### A. Pengaruh Grouping terhadap Stok di Bagian Produk
1. **Di V1 (Masalah Klasik):** Grouping hanya memanipulasi kolom metadata serial (`isGrouped = true`), sehingga stok buku besar produk tidak bergerak resmi.
2. **Solusi Standar V2:**
   * **Komponen yang digabung:**
     - Status serial anggota diubah menjadi `RESERVED` / `CONSUMED_OUT` dengan `metadata.parent_group_id`.
     - Dibuat mutasi ledger internal:
       `entry_type`: `ASSEMBLY_COMPONENT_OUT` (stok produk-produk asal berkurang sejumlah kuantitas dasar).
   * **Produk Hasil Grouping:**
     - Dibuatkan serial number induk baru di `product_serials` dengan status `AVAILABLE` dan flag `is_group = 1`.
     - Dibuat mutasi ledger internal:
       `entry_type`: `ASSEMBLY_RESULT_IN` (stok produk target/paket bertambah sejumlah target kuantitas).
   * **HPP / Costing:** Nilai HPP produk paket hasil akumulasi dari `unit_cost` produk-produk penyusunnya.

### B. Pengaruh Grouping terhadap Goods Out (Surat Jalan / Pengeluaran)
1. **Saat Group Serial Dikeluarkan:**
   * Operator gudang cukup menembak/scan **1 Barcode Group** (misal `GRP-20261024-XXXX`).
   * Sistem otomatis memotong stok produk paket (`GOODS_OUT_COMPLETED`).
   * **Cascade Status:** Serial induk berubah menjadi `CONSUMED_OUT`, dan seluruh *leaf serials* (anggota di dalamnya) otomatis ikut terkunci menjadi `CONSUMED_OUT`.
   * Dokumen Surat Jalan mencetak serial group dan rincian breakdown komponennya.

### C. Bagaimana Jika Serial Group di-Return (Retur Barang Keluar)?
1. **Skenario Retur Group:**
   * Jika pelanggan mengembalikan 1 box group utuh:
     - Serial group statusnya kembali menjadi `AVAILABLE`.
     - Seluruh serial anggota di dalamnya otomatis di-restore statusnya menjadi bagian dari group tersebut.
     - Terbitkan ledger `RETURN_IN_POSTED` untuk produk group.
2. **Skenario Retur Parsial (Hanya 1 isi di dalam group yang rusak):**
   * Serial group wajib di-**Dissolve / Ungroup** terlebih dahulu.
   * Komponen yang rusak dicatat retur dengan kondisi `RUSAK`, komponen lainnya kembali menjadi serial mandiri `AVAILABLE`.

---

## 4. Skema Database SQLite untuk Mendukung Fitur di V2

Untuk fase pengembangan SQLite di V2, tabel berikut ditambahkan/diselaraskan ke `src/lib/db/schema.sql`:

```sql
-- 1. HEADER TRANSAKSI GROUPING SERIAL
CREATE TABLE IF NOT EXISTS serial_groupings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  grouping_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISSOLVED', 'CANCELLED')),
  group_type TEXT NOT NULL DEFAULT 'MIXED' CHECK (group_type IN ('SINGLE_PRODUCT', 'MIXED')),
  result_product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  result_serial_id TEXT REFERENCES product_serials(id) ON DELETE RESTRICT,
  result_serial_number TEXT NOT NULL,
  target_unit TEXT NOT NULL DEFAULT 'pcs',
  target_qty NUMERIC NOT NULL DEFAULT 1,
  total_base_qty_pcs NUMERIC NOT NULL,
  total_cost NUMERIC NOT NULL DEFAULT 0,
  result_unit_cost NUMERIC NOT NULL DEFAULT 0,
  source_doc_id TEXT,
  reverse_doc_id TEXT,
  notes TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  dissolved_by_user_id TEXT REFERENCES users(id),
  dissolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. DETAIL KOMPONEN GROUPING SERIAL
CREATE TABLE IF NOT EXISTS serial_grouping_components (
  id TEXT PRIMARY KEY,
  grouping_id TEXT NOT NULL REFERENCES serial_groupings(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  component_serial_id TEXT NOT NULL REFERENCES product_serials(id) ON DELETE RESTRICT,
  component_serial_number TEXT NOT NULL,
  component_product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  snapshot_product_name TEXT NOT NULL,
  snapshot_sku TEXT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  unit_qty NUMERIC NOT NULL DEFAULT 1,
  base_qty_pcs NUMERIC NOT NULL,
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  total_cost NUMERIC NOT NULL DEFAULT 0,
  is_sub_group INTEGER NOT NULL DEFAULT 0,
  nested_depth INTEGER NOT NULL DEFAULT 1 CHECK (nested_depth BETWEEN 1 AND 3),
  created_at TEXT NOT NULL
);
```

---

## 5. Matriks Pengujian & Validasi SQLite (Dev Verification Plan)

Sebelum dinaikkan ke Supabase/Production, pengujian berikut wajib lolos pada SQLite repo DocuflowV2:

1. **Uji Reversal Retur (Tidak Jadi Retur):**
   - Transaksi Goods Out $\to$ Retur $\to$ Batal Retur.
   - Verifikasi saldo akhir stok kembali sama persis dengan saat barang pertama keluar.
2. **Uji Grouping Satuan & Pecahan:**
   - Coba gabung serial dengan jumlah pcs tidak bulat terhadap satuan target $\to$ sistem wajib melempar `UNIT_MISMATCH`.
3. **Uji Goods Out Serial Group:**
   - Pastikan serial group yang sudah keluar tidak bisa dipakai transaksi lain atau di-group ulang.
4. **Uji Reconstruct Stock Balance:**
   - Fungsi `reconstructStockBalance` di `src/lib/inventory/ledger-engine.ts` harus menghasilkan angka yang konsisten dari kalkulasi seluruh baris `inventory_ledger`.

---

*Laporan ini disimpan di root `DocuflowV2` dan siap dijadikan acuan implementasi.*
