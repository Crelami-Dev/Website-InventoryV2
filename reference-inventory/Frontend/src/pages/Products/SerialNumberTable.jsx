import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Barcode, History, Printer, Layers, PackageOpen } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useUnits } from '../../hooks/useUnits.js';
import { api } from '../../utils/api.js';
import AddSerialInline from './AddSerialInline.jsx';
import HistoryModal from './HistoryModal.jsx';
import SerialGroupModal from './SerialGroupModal.jsx';
import SerialCompositionModal from './SerialCompositionModal.jsx';
import UngroupConfirmModal from './UngroupConfirmModal.jsx';
import LabelSizePicker from '../../components/LabelSizePicker.jsx';
import { openLabelPrintWindow, DEFAULT_LABEL_SIZE } from '../../utils/labelPrint.js';
import { describeUnitQty } from '../../utils/reportUnits.js';
import { filterDisplaySerials } from '../../utils/stockCalculation.js';
import './SerialNumberTable.css';

const SERIAL_STATUS_CONFIG = {
  available: { label: 'productDetail.available', chip: 'chip-success-light' },
  reserved:  { label: 'productDetail.reserved',  chip: 'chip-warning-light' },
  out:       { label: 'productDetail.out',        chip: 'chip-danger-light' },
  damaged:   { label: 'productDetail.damaged',    chip: 'chip-danger-light' },
};

const EMPTY_ARRAY = [];

export default function SerialNumberTable({
  serials,
  product,
  productId,
  onSerialAdded,
  rawDocuments,
  trackingMode,
  stock,
  sku
}) {
  const { t } = useApp();
  const { multipliers, customUnits } = useUnits();
  const navigate = useNavigate();
  const [showAddForm, setShowAddForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyModalType, setHistoryModalType] = useState('goods_in');
  const [selectedSerialIds, setSelectedSerialIds] = useState(new Set());
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [compositionModalOpen, setCompositionModalOpen] = useState(false);
  const [selectedCompositionSerial, setSelectedCompositionSerial] = useState(null);
  const [ungroupModalOpen, setUngroupModalOpen] = useState(false);
  const [ungroupTarget, setUngroupTarget] = useState(null);
  const [labelSize, setLabelSize] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_LABEL_SIZE;
    return window.localStorage.getItem('docuflow_label_size') || DEFAULT_LABEL_SIZE;
  });

  const activeSerials = useMemo(() => {
    return filterDisplaySerials(serials, rawDocuments);
  }, [serials, rawDocuments]);

  const isSerial = trackingMode === 'serial' || activeSerials.length > 0 || stock > 0;

  const handleSuccess = () => {
    setShowAddForm(false);
    onSerialAdded();
  };

  /* Helper to match document references */
  const getDocumentRef = (docId) => {
    if (!docId) return 'â€”';
    const doc = rawDocuments?.find((d) => d.id === docId);
    const num = doc ? doc.document_number : 'â€”';
    return num.replace(/undefined/g, '/');
  };

  const detectSerialUnit = (serial) => {
    const metaUnit = serial.serialUnit || serial.metadata?.serialUnit || serial.unit;
    if (metaUnit && metaUnit !== 'piece' && metaUnit !== 'pcs') return metaUnit;

    const sn = String(serial.serialNumber ?? serial.serial_number ?? '').toLowerCase();

    // Check customUnits first
    if (customUnits && Array.isArray(customUnits)) {
      const sortedUnits = [...customUnits].sort((a, b) => b.key.length - a.key.length);
      for (const u of sortedUnits) {
        const key = u.key.toLowerCase();
        if (key !== 'pcs' && key !== 'piece' && (sn.includes(key) || (u.short_code && sn.includes(u.short_code.toLowerCase())))) {
          return key;
        }
      }
    }

    if (sn.includes('10bl') || sn.includes('bal10')) return 'bal10';
    if (sn.includes('15bl') || sn.includes('bal15')) return 'bal15';
    if (sn.includes('20bl') || sn.includes('bal20')) return 'bal20';
    if (sn.includes('25bl') || sn.includes('bal25')) return 'bal25';
    if (sn.includes('5bl') || sn.includes('bal5')) return 'bal5';
    if (sn.includes('bal') || sn.includes('bl')) return 'bal';
    if (sn.includes('pack3') || sn.includes('pk3')) return 'pack3';
    if (sn.includes('pack6') || sn.includes('pk6')) return 'pack6';
    if (sn.includes('pack5') || sn.includes('pk5')) return 'pack';
    if (sn.includes('pack') || sn.includes('pk')) return 'pack';
    if (sn.includes('lusin') || sn.includes('doz') || sn.includes('dozen')) return 'lusin';

    // Look up Goods In document receiving unit
    const docId = serial.goodsInDocumentId || serial.goods_in_document_id;
    if (docId && rawDocuments) {
      const doc = rawDocuments.find((d) => d.id === docId);
      if (doc && doc.items) {
        const sDocItemId = serial.goodsInItemId || serial.goods_in_item_id;
        const sProdId = serial.productId || serial.product_id;
        const item = doc.items.find((it) => {
          if (sDocItemId) return it.id === sDocItemId || it.itemId === sDocItemId;
          return sProdId && (it.productId === sProdId || it.product_id === sProdId);
        });
        if (item) {
          const itemUnit = item.metadata?.qtyUnit || item.qtyUnit || item.unit || 'pcs';
          const cleanItemUnit = String(itemUnit).toLowerCase();
          if (multipliers[cleanItemUnit]) return cleanItemUnit;
        }
      }
    }

    return 'pcs';
  };

  const getQtyDisplay = (serial) => {
    if (serial.isNonSerialPlaceholder) {
      return `${serial.qty} pcs`;
    }
    const unit = detectSerialUnit(serial);
    const cleanUnit = String(unit).toLowerCase();
    const displayName = cleanUnit === 'piece' ? 'pcs' : (cleanUnit === 'dozen' ? 'lusin' : cleanUnit);
    return `1 ${displayName}`;
  };

  const handleLabelSizeChange = (nextSize) => {
    setLabelSize(nextSize);
    try {
      window.localStorage.setItem('docuflow_label_size', nextSize);
    } catch {
      // storage tidak tersedia, abaikan
    }
  };

  const handlePrint = async () => {
    if (activeSerials.length === 0) return;

    const productName = product?.name || product?.item_name || sku || '';
    const items = activeSerials.map((s) => ({
      serial: String(s.serialNumber || s.serial_number || '').trim(),
      productName,
      unitText: describeUnitQty(detectSerialUnit(s), { multipliers, customUnits }).text,
    }));

    const opened = await openLabelPrintWindow({
      items,
      title: t('productDetail.printLabelsTitle'),
      sizeKey: labelSize,
    });

    if (!opened) {
      alert(t('productDetail.printPopupWarning'));
    }
  };

  const filteredSerials = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return activeSerials;

    return activeSerials.filter((s) => {
      const selfSn = String(s.serialNumber || s.serial_number || '').toLowerCase();
      if (selfSn.includes(query)) return true;

      // Jika serial adalah Group, cari juga apakah ada anggota / serial anak di dalamnya yang cocok dengan query
      if (s.metadata?.isGroup) {
        const composition = Array.isArray(s.metadata?.composition) ? s.metadata.composition : [];
        const directMembers = Array.isArray(s.metadata?.directMembers) ? s.metadata.directMembers : [];
        const hasMemberMatch =
          composition.some((c) => String(c.serialNumber || '').toLowerCase().includes(query)) ||
          directMembers.some((m) => String(m.serialNumber || '').toLowerCase().includes(query));
        if (hasMemberMatch) return true;
      }

      return false;
    });
  }, [activeSerials, searchQuery]);

  const displayRows = useMemo(() => {
    const list = [...filteredSerials];

    // Calculate non-serial stock using dynamic multipliers
    const serialsPieces = activeSerials.reduce((sum, s) => {
      if (s.metadata?.isGroup) {
        return sum + (Number(s.metadata?.totalPcs) || 0);
      }
      const unit = detectSerialUnit(s);
      const cleanUnit = String(unit).toLowerCase();
      const qty = multipliers[cleanUnit] || 1;
      return sum + qty;
    }, 0);

    const nonSerialStock = Math.max(0, stock - serialsPieces);
    if (nonSerialStock > 0) {
      list.push({
        id: 'non-serial-placeholder',
        serialNumber: '—',
        status: 'available',
        isNonSerialPlaceholder: true,
        qty: nonSerialStock,
        goodsInDocumentId: null,
        goodsOutDocumentId: null,
      });
    }
    return list;
  }, [filteredSerials, activeSerials, stock, multipliers]);

  /* Calculate stock breakdown by unit */
  const unitSummary = useMemo(() => {
    if (!activeSerials || activeSerials.length === 0) return [];
    const map = {};

    activeSerials.forEach((s) => {
      if (s.status !== 'available') return;
      // Jangan hitung nomor seri yang sedang terbungkus dalam group untuk mencegah double-counting
      if (s.metadata?.isGrouped || s.metadata?.parentGroupId) return;

      if (s.metadata?.isGroup) {
        const u = 'group';
        if (!map[u]) {
          map[u] = { unit: u, count: 0, pcs: 0, mult: 1 };
        }
        map[u].count += 1;
        map[u].pcs += Number(s.metadata?.totalPcs) || 0;
        return;
      }

      const detected = detectSerialUnit(s);
      let unit = String(detected || 'pcs').toLowerCase();
      if (unit === 'piece') unit = 'pcs';
      if (unit === 'dozen') unit = 'lusin';

      const mult = multipliers[unit] || 1;

      if (!map[unit]) {
        map[unit] = { unit, count: 0, pcs: 0, mult };
      }
      map[unit].count += 1;
      map[unit].pcs += mult;
    });

    return Object.values(map);
  }, [activeSerials, rawDocuments, multipliers]);

  /* Selectable serials for grouping (available & not currently packed in a group) */
  const availableSelectableSerials = useMemo(() => {
    return displayRows.filter(
      (s) => !s.isNonSerialPlaceholder && !s.metadata?.isGrouped && s.status === 'available'
    );
  }, [displayRows]);

  const isAllSelected =
    availableSelectableSerials.length > 0 &&
    availableSelectableSerials.every((s) => selectedSerialIds.has(s.id));

  const handleToggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedSerialIds(new Set());
    } else {
      setSelectedSerialIds(new Set(availableSelectableSerials.map((s) => s.id)));
    }
  };

  const handleToggleSelect = (id) => {
    setSelectedSerialIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleClearSelection = () => {
    setSelectedSerialIds(new Set());
  };

  const selectedSerialObjects = useMemo(() => {
    if (selectedSerialIds.size === 0) return EMPTY_ARRAY;
    return activeSerials.filter((s) => selectedSerialIds.has(s.id));
  }, [activeSerials, selectedSerialIds]);

  const handleViewComposition = (sn) => {
    if (!sn) return;
    setSelectedCompositionSerial(sn);
    setCompositionModalOpen(true);
  };

  const handleOpenUngroup = (groupSerial) => {
    if (!groupSerial) return;
    setUngroupTarget(groupSerial);
    setUngroupModalOpen(true);
  };

  return (
    <div className="serial-panel">
      {/* Panel Header */}
      <div className="serial-panel__header">
        <div className="serial-panel__title-area">
          <Barcode size={18} className="serial-panel__title-icon" />
          <h3 className="serial-panel__title">
            {t('productDetail.serialNumbers')}
          </h3>
          <span className="serial-panel__count-badge">
            {stock}
          </span>
        </div>

        {/* Action Buttons */}
        <div className="serial-panel__actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm interactive serial-panel__btn"
            onClick={() => setGroupModalOpen(true)}
            title="Kelompokkan nomor seri menjadi satu group"
          >
            <Layers size={14} />
            <span className="serial-panel__btn-text">Grouping Serial</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm interactive serial-panel__btn"
            onClick={() => { setHistoryModalType('goods_in'); setHistoryModalOpen(true); }}
          >
            <History size={14} />
            <span className="serial-panel__btn-text">{t('productDetail.goodsInHistory')}</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm interactive serial-panel__btn"
            onClick={() => { setHistoryModalType('goods_out'); setHistoryModalOpen(true); }}
          >
            <History size={14} />
            <span className="serial-panel__btn-text">{t('productDetail.goodsOutHistory')}</span>
          </button>
          <LabelSizePicker
            value={labelSize}
            onChange={handleLabelSizeChange}
            disabled={!isSerial || activeSerials.length === 0}
            ariaLabel={t('productDetail.printLabelsTitle')}
            className="serial-panel__label-size"
          />
          <button
            type="button"
            disabled={!isSerial || activeSerials.length === 0}
            className="btn btn-primary btn-sm interactive serial-panel__btn"
            onClick={handlePrint}
          >
            <Printer size={14} />
            <span className="serial-panel__btn-text">{t('productDetail.printAllLabels')}</span>
          </button>
        </div>
      </div>

      {/* Stock Breakdown Bar by Unit */}
      {unitSummary.length > 0 && (
        <div className="serial-panel__summary-bar">
          <div className="serial-panel__summary-title">
            <span>Rincian Stok:</span>
          </div>
          <div className="serial-panel__summary-pills">
            {unitSummary.map((item) => {
              let label = item.unit;
              if (item.unit === 'dozen' || item.unit === 'lusin') label = 'lusin';
              else if (item.unit === 'bal10') label = 'bal10';
              else if (item.unit === 'bal15') label = 'bal15';
              else if (item.unit === 'bal20') label = 'bal20';
              else if (item.unit === 'bal25') label = 'bal25';
              else if (item.unit === 'pack') label = 'pack';
              else if (item.unit === 'bal') label = 'bal';
              else if (item.unit === 'group') label = 'group';
              else label = 'pcs';

              const subDetail = item.unit === 'bal10'
                ? `${item.count * 10} lusin`
                : item.unit === 'bal15'
                ? `${item.count * 15} lusin`
                : item.unit === 'bal20'
                ? `${item.count * 20} lusin`
                : (item.unit === 'bal25' || item.unit === 'bal')
                ? `${item.count * 25} lusin`
                : (item.unit === 'group' ? `${item.pcs} pcs` : null);

              return (
                <div key={item.unit} className="serial-panel__unit-chip">
                  <span className="serial-panel__unit-count">{item.count} {label}</span>
                  {subDetail && <span className="serial-panel__unit-sub">({subDetail})</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Floating Selection Bar for Grouping */}
      {selectedSerialIds.size > 0 && (
        <div className="serial-panel__selection-bar">
          <div className="serial-panel__selection-info">
            <Layers size={16} />
            <span>
              <strong>{selectedSerialIds.size}</strong> nomor seri dipilih
            </span>
          </div>
          <div className="serial-panel__selection-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm interactive"
              onClick={() => setGroupModalOpen(true)}
            >
              <Layers size={14} />
              <span>Group {selectedSerialIds.size} Serial</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm interactive"
              onClick={handleClearSelection}
            >
              Batal
            </button>
          </div>
        </div>
      )}

      {/* Search Bar */}
      {isSerial && activeSerials.length > 0 && (
        <div className="serial-panel__search-bar">
          <input
            type="text"
            className="serial-panel__search-input"
            placeholder={t('productDetail.serialSearchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      )}

      {/* Inline add form */}
      {showAddForm && (
        <div className="serial-panel__form-container">
          <AddSerialInline
            productId={productId}
            existingSerials={serials}
            onSuccess={handleSuccess}
            onCancel={() => setShowAddForm(false)}
          />
        </div>
      )}

      {/* Table Area or Non-Serial Card */}
      {isSerial ? (
        <div className="serial-panel__table-wrapper">
          <table className="serial-panel__table">
            <thead>
              <tr>
                <th style={{ width: '42px', textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    onChange={handleToggleSelectAll}
                    disabled={availableSelectableSerials.length === 0}
                    aria-label="Pilih semua nomor seri"
                  />
                </th>
                <th>{t('productDetail.no')}</th>
                <th>{t('productDetail.serialNumber')}</th>
                <th>{t('productDetail.serialStatus')}</th>
                <th>{t('productDetail.reference')}</th>
                <th className="serial-panel__th--right">{t('productDetail.qty')}</th>
                <th style={{ textAlign: 'center', width: '130px' }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 ? (
                /* Fallback if no serials exist or search yields no matches */
                <tr className="serial-panel__tr--empty">
                  <td className="serial-panel__td--empty" colSpan="7">
                    <div className="serial-panel__empty-state">
                      <p className="serial-panel__empty-title">
                        {serials.length === 0 
                          ? t('productDetail.noSerials') 
                          : t('productDetail.noSerialsFound')}
                      </p>
                      {serials.length === 0 && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm interactive mt-2"
                          onClick={() => setShowAddForm(true)}
                        >
                          <Plus size={14} />
                          <span>{t('productDetail.addSerial')}</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                displayRows.map((serial, idx) => {
                  const isDissolved = Boolean(serial.metadata?.isDissolved || serial.status === 'dissolved');
                  const cfg = isDissolved
                    ? { label: 'Dibongkar', chip: 'chip-muted' }
                    : (SERIAL_STATUS_CONFIG[serial.status] ?? SERIAL_STATUS_CONFIG.available);
                  const idxStr = String(idx + 1).padStart(2, '0');
                  const docRef = isDissolved ? '—' : getDocumentRef(serial.goodsOutDocumentId || serial.goodsInDocumentId);
                  const isSelected = selectedSerialIds.has(serial.id);
                  const isGroup = Boolean(serial.metadata?.isGroup);
                  const isGrouped = Boolean(serial.metadata?.isGrouped);
                  const parentSn = serial.metadata?.parentGroupSerialNumber;

                  return (
                    <tr
                      key={serial.id}
                      className={`serial-panel__tr ${isSelected ? 'serial-panel__tr--selected' : ''} ${isDissolved ? 'serial-panel__tr--dissolved' : ''}`}
                    >
                      <td style={{ textAlign: 'center' }}>
                        {serial.isNonSerialPlaceholder || isDissolved ? null : (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => handleToggleSelect(serial.id)}
                            aria-label={`Pilih serial ${serial.serialNumber || serial.serial_number}`}
                          />
                        )}
                      </td>
                      <td className="serial-panel__td--num">{idxStr}</td>
                      <td className="serial-panel__td--sn">
                        {serial.isNonSerialPlaceholder ? (
                          <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                            {t('productDetail.nonSerial')}
                          </span>
                        ) : (
                          <div className="serial-panel__sn-cell">
                            <span className="serial-panel__sn-badge">
                              {serial.serialNumber || serial.serial_number || '—'}
                            </span>

                            {isGroup && (
                              <span
                                className={`badge-group-tag ${isDissolved ? 'badge-group-tag--dissolved' : ''}`}
                                title={isDissolved ? "Group telah dibongkar" : "Nomor seri hasil penggabungan (Group)"}
                              >
                                <Layers size={11} />
                                <span>GROUP {isDissolved ? '• DIBONGKAR' : `• ${serial.metadata.totalPcs || 0} pcs`}</span>
                              </span>
                            )}

                          </div>
                        )}
                      </td>
                      <td className="serial-panel__td--status">
                        <span className={`chip-status ${cfg.chip}`}>
                          {String(cfg.label).startsWith('productDetail.') ? t(cfg.label) : cfg.label}
                        </span>
                      </td>
                      <td className="serial-panel__td--ref">{docRef}</td>
                      <td className="serial-panel__td--qty">
                        {serial.isNonSerialPlaceholder
                          ? `${serial.qty} pcs`
                          : (isGroup ? `${serial.metadata?.totalPcs || 1} pcs` : getQtyDisplay(serial))}
                      </td>
                      <td className="serial-panel__td--action">
                        {isGroup && (
                          <div className="serial-panel__action-btns">
                            <button
                              type="button"
                              className="btn btn-secondary btn-xs interactive"
                              onClick={() => handleViewComposition(serial.serialNumber || serial.serial_number)}
                              title="Lihat komposisi hierarki serial group ini"
                            >
                              <Layers size={12} />
                              <span>Komposisi</span>
                            </button>
                            {serial.status === 'available' && !serial.metadata?.parentGroupId && (
                              <button
                                type="button"
                                className="btn btn-secondary btn-xs text-danger interactive"
                                onClick={() => handleOpenUngroup(serial)}
                                title="Bongkar group serial ini kembali ke item anggota"
                              >
                                <PackageOpen size={12} />
                                <span>Bongkar</span>
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="serial-panel__non-serial">
          <div className="serial-panel__ns-body">
            <div className="serial-panel__ns-icon-box">
              <Barcode size={24} />
            </div>
            <div className="serial-panel__ns-text">
              <h4 className="serial-panel__ns-title">{t('productDetail.nonSerialStock')}</h4>
              <p className="serial-panel__ns-desc">{t('productDetail.nonSerialDesc')}</p>
            </div>
            <div className="serial-panel__ns-metric">
              <span className="serial-panel__ns-metric-label">{t('productDetail.totalStock')}</span>
              <span className="serial-panel__ns-metric-value">
                {stock} <span className="serial-panel__ns-metric-unit">{t('productDetail.unit')}</span>
              </span>
            </div>
          </div>
          <div className="serial-panel__ns-footer">
            {!showAddForm && (
              <button
                type="button"
                className="btn btn-primary btn-sm interactive"
                onClick={() => setShowAddForm(true)}
              >
                <Plus size={14} />
                <span>{t('productDetail.convertOrAddSerials')}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* History Modal */}
      <HistoryModal
        isOpen={historyModalOpen}
        onClose={() => setHistoryModalOpen(false)}
        type={historyModalType}
        product={product}
        documents={rawDocuments}
        serials={serials}
      />

      {/* Serial Grouping Modal */}
      <SerialGroupModal
        isOpen={groupModalOpen}
        onClose={() => {
          setGroupModalOpen(false);
          setSelectedSerialIds(new Set());
        }}
        product={product}
        productId={productId || product?.id}
        warehouseId={serials?.[0]?.warehouseId || serials?.[0]?.warehouse_id || product?.warehouseId || product?.warehouse_id || null}
        initialSelectedSerials={selectedSerialObjects}
        onSuccess={() => {
          setSelectedSerialIds(new Set());
          onSerialAdded();
        }}
      />

      {/* Serial Composition Modal */}
      <SerialCompositionModal
        isOpen={compositionModalOpen}
        onClose={() => {
          setCompositionModalOpen(false);
          setSelectedCompositionSerial(null);
        }}
        serialNumber={selectedCompositionSerial}
        onUngroupSuccess={() => {
          onSerialAdded();
        }}
      />

      {/* Ungroup Confirmation Modal */}
      <UngroupConfirmModal
        isOpen={ungroupModalOpen}
        onClose={() => {
          setUngroupModalOpen(false);
          setUngroupTarget(null);
        }}
        groupSerial={ungroupTarget ? {
          ...ungroupTarget,
          productName: product?.name || ungroupTarget.productName,
        } : null}
        onSuccess={() => {
          onSerialAdded();
        }}
      />
    </div>
  );
}
