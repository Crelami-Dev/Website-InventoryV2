/**
 * Sitemap navigasi utama - sumber kebenaran: RPD.md 6.1 dan WIREFRAME.md 1.3.
 * Tidak ada menu Serial Number terpisah; SN berada di detail produk (tab Unit & SN).
 * Label masih berbahasa Indonesia; i18n BLOCKED (TASK-018 / TASK-006).
 *
 * Catatan permission: visibilitas menu per role belum ditentukan karena matriks
 * permission (TASK-005) BLOCKED. Seluruh menu sitemap ditampilkan; penegakan akses
 * tetap di server/guard (src/lib/auth/guard.ts), bukan di navigasi.
 */
export type NavIconName =
  | "dashboard"
  | "document"
  | "order"
  | "box"
  | "in"
  | "out"
  | "clipboard"
  | "chart"
  | "users"
  | "truck"
  | "settings"
  | "audit";

export type NavItem = {
  label: string;
  href: string;
  icon: NavIconName;
};

export type NavSection = {
  id: string;
  label: string;
  items: NavItem[];
};

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: "main",
    label: "UTAMA",
    items: [
      { label: "Dasbor", href: "/dashboard", icon: "dashboard" },
      { label: "Dokumen", href: "/documents", icon: "document" },
    ],
  },
  {
    id: "transactions",
    label: "TRANSAKSI",
    items: [{ label: "Purchase Orders", href: "/purchase-orders", icon: "order" }],
  },
  {
    id: "inventory",
    label: "INVENTORY",
    items: [
      { label: "Produk", href: "/inventory/products", icon: "box" },
      { label: "Barang Masuk", href: "/inventory/goods-in", icon: "in" },
      { label: "Barang Keluar", href: "/inventory/goods-out", icon: "out" },
      { label: "Stock Opname", href: "/inventory/stock-opname", icon: "clipboard" },
      { label: "Laporan", href: "/inventory/reports", icon: "chart" },
    ],
  },
  {
    id: "partners",
    label: "PELANGGAN & PEMASOK",
    items: [
      { label: "Pelanggan", href: "/partners/customers", icon: "users" },
      { label: "Pemasok", href: "/partners/suppliers", icon: "truck" },
    ],
  },
  {
    id: "system",
    label: "SISTEM",
    items: [
      { label: "Pengaturan", href: "/settings", icon: "settings" },
      { label: "Log Audit", href: "/audit-log", icon: "audit" },
    ],
  },
] as const;

export const NAV_ITEMS: readonly NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

/** Judul breadcrumb untuk route internal yang sengaja tidak masuk sitemap. */
export const EXTRA_ROUTE_TITLES: Readonly<Record<string, string>> = {
  "/design-system": "Demo Design System (internal)",
  "/inventory/grouping": "Grouping Serial Number",
};

/** Item aktif untuk pathname (cocok persis atau sebagai prefix segmen). */
export function findNavItem(pathname: string): { section: NavSection; item: NavItem } | null {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
        return { section, item };
      }
    }
  }
  return null;
}
