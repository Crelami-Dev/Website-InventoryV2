/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Ledger & Inventory Invariant Engine (Pure Domain Logic)
 * 
 * Modul ini mengevaluasi aturan bisnis atomik:
 * 1. Rekonstruksi Saldo Fisik & Reservasi dari Ledger (Tanpa Edit Saldo Langsung).
 * 2. Guard Serial Number Aktif Lintas Gudang dalam Satu Owner.
 * 3. Alur Goods Out Pending (Reservasi tanpa potong fisik) vs Completion (Ledger atomik).
 * 4. Soft-delete Tombstone Goods Out Pending (Pelepasan Reservasi tanpa hard-delete).
 * 5. Rekonsiliasi Variance Stock Opname & Deteksi Transaksi Stale.
 */

import type {
  LedgerEntry,
  ReservationEntry,
  ActiveSerialRecord,
  ReconstructedStockBalance,
  SerialLifecycleStatus,
} from '../types/inventory-domain.ts';
import { AppError } from '../errors/app-error.ts';

/**
 * Normalisasi kanonis untuk Serial Number
 * Mengikuti baseline V2.4.1: Trim spasi, kapitalisasi konsisten, hapus karakter kontrol.
 */
export function normalizeSerialNumber(serialNumber: string): string {
  if (!serialNumber || typeof serialNumber !== 'string') {
    return '';
  }
  return serialNumber.trim().toUpperCase().replace(/[\t\r\n\s]+/g, '-');
}

/**
 * Daftar status serial yang dianggap masih "HIDUP" / aktif di gudang.
 * SN hidup dilarang keras aktif bersamaan di dua gudang milik Owner yang sama.
 */
export const ACTIVE_SERIAL_LIFECYCLE_STATUSES: SerialLifecycleStatus[] = [
  'AVAILABLE',
  'RESERVED',
  'QUARANTINE',
];

/**
 * Guard SN Aktif Lintas Gudang (RPD §10.2 & DB-AUD-008)
 * Memverifikasi apakah SN yang dinormalisasi sudah aktif di gudang lain dalam Owner yang sama.
 */
export function evaluateCrossWarehouseSerialGuard(
  existingRegistry: ActiveSerialRecord[],
  newCandidate: {
    ownerId: string;
    warehouseId: string;
    serialNumber: string;
  }
): { isAllowed: boolean; conflictingRecord?: ActiveSerialRecord; errorMessage?: string } {
  const candidateNormalized = normalizeSerialNumber(newCandidate.serialNumber);

  if (!candidateNormalized) {
    return {
      isAllowed: false,
      errorMessage: 'Serial Number tidak boleh kosong atau hanya berupa spasi.',
    };
  }

  // SN biasa dilarang diawali "G-" (reserved untuk group number)
  if (candidateNormalized.startsWith('G-')) {
    return {
      isAllowed: false,
      errorMessage: "Serial Number biasa dilarang diawali dengan prefix 'G-'. Prefix tersebut khusus untuk Group Serial Number.",
    };
  }

  // Cari apakah ada SN yang cocok pada Owner yang sama dengan status aktif/hidup
  const conflicting = existingRegistry.find((record) => {
    return (
      record.ownerId === newCandidate.ownerId &&
      record.serialNumberNormalized === candidateNormalized &&
      ACTIVE_SERIAL_LIFECYCLE_STATUSES.includes(record.status)
    );
  });

  if (conflicting) {
    if (conflicting.warehouseId !== newCandidate.warehouseId) {
      return {
        isAllowed: false,
        conflictingRecord: conflicting,
        errorMessage: `Konflik SN Lintas Gudang: SN '${candidateNormalized}' sedang aktif di gudang '${conflicting.warehouseId}'. SN yang sama dilarang aktif di gudang berbeda dalam satu Owner.`,
      };
    } else {
      return {
        isAllowed: false,
        conflictingRecord: conflicting,
        errorMessage: `Duplikasi SN: SN '${candidateNormalized}' sudah terdaftar aktif di gudang ini dengan status '${conflicting.status}'.`,
      };
    }
  }

  return { isAllowed: true };
}

/**
 * Rekonstruksi Saldo Fisik & Reservasi dari Ledger (RPD §7.4 & AGENTS.md §1)
 * Menghitung saldo secara deterministik dari pergerakan ledger dan reservasi aktif.
 */
export function reconstructStockBalance(
  ledgerEntries: LedgerEntry[],
  activeReservations: ReservationEntry[],
  ownerId: string,
  warehouseId: string,
  productId: string
): ReconstructedStockBalance {
  // 1. Hitung Saldo Fisik Murni dari Ledger
  const relevantLedger = ledgerEntries.filter(
    (entry) =>
      entry.ownerId === ownerId &&
      entry.warehouseId === warehouseId &&
      entry.productId === productId
  );

  const physicalStock = relevantLedger.reduce(
    (total, entry) => total + entry.quantityDeltaBase,
    0
  );

  // 2. Hitung Kuantitas Reservasi Aktif
  const relevantReservations = activeReservations.filter(
    (res) =>
      res.ownerId === ownerId &&
      res.warehouseId === warehouseId &&
      res.productId === productId &&
      res.status === 'ACTIVE'
  );

  const reservedStock = relevantReservations.reduce(
    (total, res) => total + res.reservedBaseQty,
    0
  );

  const availableStock = Math.max(0, physicalStock - reservedStock);

  return {
    ownerId,
    warehouseId,
    productId,
    physicalStock,
    reservedStock,
    availableStock,
  };
}

/**
 * Eksekusi Reservasi Goods Out Pending (RPD §7.6 & RPD §10.3)
 * Aturan: Goods Out PENDING mereservasi kuantitas/SN, TETAPI TIDAK mengurangi saldo fisik.
 */
export function createGoodsOutPendingReservation(
  currentBalance: ReconstructedStockBalance,
  request: {
    reservationId: string;
    goodsOutId: string;
    goodsOutLineId: string;
    requestedBaseQty: number;
    serialIds?: string[];
    isSerial: boolean;
  }
): {
  success: boolean;
  reservation?: ReservationEntry;
  updatedBalance: ReconstructedStockBalance;
  error?: string;
} {
  if (request.requestedBaseQty <= 0) {
    return {
      success: false,
      updatedBalance: currentBalance,
      error: 'Kuantitas reservasi harus lebih besar dari 0.',
    };
  }

  // Jika serial, kuantitas harus bulat dan sesuai jumlah SN
  if (request.isSerial) {
    if (!Number.isInteger(request.requestedBaseQty)) {
      return {
        success: false,
        updatedBalance: currentBalance,
        error: 'Kuantitas produk serial tidak boleh berupa pecahan.',
      };
    }
    if (!request.serialIds || request.serialIds.length !== request.requestedBaseQty) {
      return {
        success: false,
        updatedBalance: currentBalance,
        error: `Jumlah Serial Number (${request.serialIds?.length || 0}) tidak cocok dengan kuantitas yang diminta (${request.requestedBaseQty}).`,
      };
    }
  }

  // Cek ketersediaan stok bebas (available stock)
  if (request.requestedBaseQty > currentBalance.availableStock) {
    return {
      success: false,
      updatedBalance: currentBalance,
      error: `Stok tidak mencukupi untuk reservasi (Oversell Protection). Diminta: ${request.requestedBaseQty}, Tersedia: ${currentBalance.availableStock}.`,
    };
  }

  const reservation: ReservationEntry = {
    id: request.reservationId,
    ownerId: currentBalance.ownerId,
    warehouseId: currentBalance.warehouseId,
    productId: currentBalance.productId,
    sourceDocType: 'GOODS_OUT_PENDING',
    sourceDocId: request.goodsOutId,
    sourceLineId: request.goodsOutLineId,
    reservedBaseQty: request.requestedBaseQty,
    serialIds: request.serialIds,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    releasedAt: null,
  };

  const newReserved = currentBalance.reservedStock + request.requestedBaseQty;

  const updatedBalance: ReconstructedStockBalance = {
    ...currentBalance,
    // Perhatikan: physicalStock TETAP SAMA (tidak berkurang saat pending)
    physicalStock: currentBalance.physicalStock,
    reservedStock: newReserved,
    availableStock: Math.max(0, currentBalance.physicalStock - newReserved),
  };

  return {
    success: true,
    reservation,
    updatedBalance,
  };
}

/**
 * Eksekusi Soft-Delete Tombstone Goods Out Pending (RPD §7.6 & DB-AUD-009)
 * Aturan: Goods Out PENDING yang dibatalkan/dihapus hanya di-soft-delete (TOMBSTONE).
 * Seluruh reservasi dilepas atomik, histori dipertahankan, tidak ada hard-delete.
 */
export function executeGoodsOutSoftDeleteTombstone(
  existingReservation: ReservationEntry,
  currentBalance: ReconstructedStockBalance,
  cancellationMeta: {
    actorUserId: string;
    reason: string;
    cancelledAt: string;
  }
): {
  success: boolean;
  releasedReservation: ReservationEntry;
  updatedBalance: ReconstructedStockBalance;
  tombstoneAuditPayload: Record<string, unknown>;
} {
  if (existingReservation.status !== 'ACTIVE') {
    throw new AppError(
      'ERR_CONFLICT',
      `Reservasi ${existingReservation.id} tidak dapat dilepas karena statusnya sudah '${existingReservation.status}'.`
    );
  }

  // 1. Lepas reservasi secara atomik
  const releasedReservation: ReservationEntry = {
    ...existingReservation,
    status: 'RELEASED_CANCELLED',
    releasedAt: cancellationMeta.cancelledAt,
    releasedReason: 'CANCELLED_SOFT_DELETE',
  };

  // 2. Kembalikan kuota ke available stock
  const newReserved = Math.max(
    0,
    currentBalance.reservedStock - existingReservation.reservedBaseQty
  );

  const updatedBalance: ReconstructedStockBalance = {
    ...currentBalance,
    physicalStock: currentBalance.physicalStock,
    reservedStock: newReserved,
    availableStock: Math.max(0, currentBalance.physicalStock - newReserved),
  };

  // 3. Buat tombstone audit payload
  const tombstoneAuditPayload = {
    event: 'GOODS_OUT_TOMBSTONED',
    goodsOutId: existingReservation.sourceDocId,
    releasedReservationId: existingReservation.id,
    releasedQty: existingReservation.reservedBaseQty,
    actorUserId: cancellationMeta.actorUserId,
    cancellationReason: cancellationMeta.reason,
    cancelledAt: cancellationMeta.cancelledAt,
    isHardDeleted: false, // Menegakkan invariant: TIDAK ADA HARD DELETE
  };

  return {
    success: true,
    releasedReservation,
    updatedBalance,
    tombstoneAuditPayload,
  };
}

/**
 * Rekonsiliasi Variance Stock Opname & Deteksi Pergerakan Bersamaan (RPD §7.9, §10.7 & DB-AUD-004)
 * Menghitung selisih hitung fisik vs snapshot buku, serta mendeteksi jika terjadi concurrent movement.
 */
export interface StockOpnameReconciliationResult {
  productId: string;
  snapshotBookStock: number;
  currentBookStock: number;
  physicalCountStock: number;
  varianceQty: number; // physicalCountStock - currentBookStock
  hasConcurrentMovement: boolean;
  concurrentDelta: number; // currentBookStock - snapshotBookStock
  recommendation: 'READY_FOR_ADJUSTMENT' | 'REQUIRES_RE_EVALUATION';
}

export function reconcileStockOpnameItem(
  productId: string,
  snapshotBookStock: number,
  currentBookStock: number,
  physicalCountStock: number
): StockOpnameReconciliationResult {
  const concurrentDelta = currentBookStock - snapshotBookStock;
  const hasConcurrentMovement = concurrentDelta !== 0;

  // Variance resmi dihitung terhadap saldo buku saat ini (setelah memperhitungkan mutasi paralel)
  const varianceQty = physicalCountStock - currentBookStock;

  return {
    productId,
    snapshotBookStock,
    currentBookStock,
    physicalCountStock,
    varianceQty,
    hasConcurrentMovement,
    concurrentDelta,
    // Jika ada mutasi paralel sejak snapshot, review harus dievaluasi ulang (stale evaluation guard)
    recommendation: hasConcurrentMovement ? 'REQUIRES_RE_EVALUATION' : 'READY_FOR_ADJUSTMENT',
  };
}
