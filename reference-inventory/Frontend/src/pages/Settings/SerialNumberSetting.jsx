import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, RotateCcw, Barcode, SlidersHorizontal, CheckCircle2, AlertCircle, AlertTriangle } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { api, getWorkspaceSettings } from '../../utils/api.js';
import { useUnits } from '../../hooks/useUnits.js';
import {
  DEFAULT_SERIAL_SETTINGS,
  DEFAULT_UNIT_SHORT_CODES,
  SERIAL_TOKENS,
  buildSerialNumber,
  resolveUnitShortCode,
} from '../../utils/serialGenerator.js';
import './SerialNumberSetting.css';

export default function SerialNumberSetting() {
  const { t, lang, activeWarehouse, activeWarehouseId } = useApp();
  const queryClient = useQueryClient();
  const { units } = useUnits();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['workspace-settings', activeWarehouseId || 'default'],
    queryFn: getWorkspaceSettings,
    staleTime: 60000,
  });

  const [template, setTemplate] = useState(DEFAULT_SERIAL_SETTINGS.template);
  const [seqLength, setSeqLength] = useState(DEFAULT_SERIAL_SETTINGS.seqLength);
  const [defaultMode, setDefaultMode] = useState(DEFAULT_SERIAL_SETTINGS.defaultMode);
  const [unitShortCodes, setUnitShortCodes] = useState(DEFAULT_UNIT_SHORT_CODES);
  const [allowUnrecorded, setAllowUnrecorded] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    if (settings) {
      if (typeof settings.allow_unrecorded_goods_out !== 'undefined') {
        setAllowUnrecorded(settings.allow_unrecorded_goods_out !== false);
      }
      if (settings?.serial_number_settings) {
        const s = settings.serial_number_settings;
        if (s.template) setTemplate(s.template);
        if (s.seqLength) setSeqLength(Number(s.seqLength));
        if (s.defaultMode) setDefaultMode(s.defaultMode);
        if (s.unitShortCodes && typeof s.unitShortCodes === 'object') {
          setUnitShortCodes({ ...DEFAULT_UNIT_SHORT_CODES, ...s.unitShortCodes });
        }
      }
    }
  }, [settings]);

  const showFeedback = (type, text) => {
    setFeedback({ type, text });
    setTimeout(() => setFeedback(null), 4000);
  };

  const handleUnitShortCodeChange = (unitKey, value) => {
    const clean = value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    setUnitShortCodes((prev) => ({
      ...prev,
      [unitKey]: clean,
    }));
  };

  const handleResetDefaults = () => {
    setTemplate(DEFAULT_SERIAL_SETTINGS.template);
    setSeqLength(DEFAULT_SERIAL_SETTINGS.seqLength);
    setDefaultMode(DEFAULT_SERIAL_SETTINGS.defaultMode);
    setUnitShortCodes(DEFAULT_UNIT_SHORT_CODES);
    setAllowUnrecorded(true);
    showFeedback('success', lang === 'id' ? 'Pengaturan dikembalikan ke standar bawaan.' : 'Settings restored to defaults.');
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        template: template.trim() || DEFAULT_SERIAL_SETTINGS.template,
        seqLength: Number(seqLength) || 4,
        defaultMode,
        unitShortCodes,
      };

      const res = await api.patch('/api/workspace/settings/serial_number_settings', {
        value: payload,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal menyimpan pengaturan.');
      }

      await api.patch('/api/workspace/settings/allow_unrecorded_goods_out', {
        value: allowUnrecorded,
      });

      await queryClient.invalidateQueries({ queryKey: ['workspace-settings'] });
      showFeedback('success', lang === 'id' ? 'Pengaturan nomor seri berhasil disimpan!' : 'Serial number settings saved successfully!');
    } catch (err) {
      console.error(err);
      showFeedback('error', err.message || (lang === 'id' ? 'Gagal menyimpan pengaturan.' : 'Failed to save settings.'));
    } finally {
      setSaving(false);
    }
  };

  // Preview serial number based on builder inputs
  const sampleSku = 'HS110';
  const sampleUnitCode = unitShortCodes['pack'] || 'PK';
  const previewExample = useMemo(() => {
    return buildSerialNumber({
      sku: sampleSku,
      unitCode: sampleUnitCode,
      dateStr: new Date(),
      seqNum: 1,
      settings: {
        template,
        seqLength,
      },
    });
  }, [template, seqLength, sampleUnitCode]);

  if (isLoading) return null;

  return (
    <div className="serial-setting-page settings-form">
      {/* Header */}
      <div className="settings-form__header-row">
        <div>
          <h2 className="settings-form__title">
            {lang === 'id' ? 'Penomoran Nomor Seri (Serial Number)' : 'Serial Number Configuration'}
          </h2>
          <p className="settings-form__desc">
            {lang === 'id'
              ? 'Konfigurasi template format otomatis dan singkatan satuan (unit short codes) untuk penomoran serial barang masuk.'
              : 'Configure automatic serial number templates and unit abbreviations for received goods.'}
          </p>
          {activeWarehouse && (
            <div style={{ marginTop: '8px', display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'var(--bg-secondary, #f1f5f9)', padding: '4px 10px', borderRadius: '6px', fontSize: '0.85rem', color: 'var(--text-secondary, #475569)' }}>
              <span>📍 {lang === 'id' ? 'Pengaturan khusus untuk:' : 'Settings for:'} <strong>{activeWarehouse.name}</strong></span>
            </div>
          )}
        </div>
        <button
          className="btn btn-primary btn-save"
          type="button"
          disabled={saving}
          onClick={handleSave}
        >
          <Save size={16} />
          <span>{saving ? t('settings.saving') : t('settings.save')}</span>
        </button>
      </div>

      {feedback && (
        <div className={`serial-setting__feedback serial-setting__feedback--${feedback.type}`}>
          {feedback.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Main Grid Layout */}
      <div className="serial-setting__layout">
        {/* Left Column: Template Builder */}
        <div className="serial-setting__card">
          <div className="serial-setting__card-header">
            <div className="serial-setting__card-title-group">
              <Barcode size={18} className="serial-setting__icon" />
              <h3 className="serial-setting__card-title">
                {lang === 'id' ? 'Format Template Serial Number' : 'Serial Number Template'}
              </h3>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleResetDefaults}
              title={lang === 'id' ? 'Kembalikan ke format bawaan' : 'Reset to defaults'}
            >
              <RotateCcw size={14} />
              <span>{lang === 'id' ? 'Reset Default' : 'Reset'}</span>
            </button>
          </div>

          <div className="serial-setting__card-body">
            {/* Input Template */}
            <div className="settings-form__group">
              <label className="settings-form__label">
                {lang === 'id' ? 'Pola Format Template' : 'Template Pattern'}
              </label>
              <input
                type="text"
                className="input serial-setting__template-input"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                placeholder="{SKU}-{UNIT}-{DDMMYYYY}{SEQ}"
              />
              <span className="serial-setting__hint">
                {lang === 'id'
                  ? 'Gunakan token di bawah ini untuk menyusun format nomor seri otomatis.'
                  : 'Use tokens below to customize your serial number pattern.'}
              </span>
            </div>

            {/* Token Chips */}
            <div className="serial-setting__tokens-wrap">
              <span className="serial-setting__tokens-label">
                {lang === 'id' ? 'Token Tersedia (Klik untuk Menambahkan):' : 'Available Tokens (Click to insert):'}
              </span>
              <div className="serial-setting__tokens-list">
                {SERIAL_TOKENS.map(({ token, label }) => {
                  const isActive = template.includes(token);
                  return (
                    <button
                      key={token}
                      type="button"
                      className={`serial-token-chip ${isActive ? 'serial-token-chip--active' : ''}`}
                      onClick={() => {
                        if (!template.includes(token)) {
                          setTemplate((prev) => (prev ? `${prev}-${token}` : token));
                        }
                      }}
                      title={label}
                    >
                      <code>{token}</code>
                      <span className="serial-token-chip__desc">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Options Row */}
            <div className="serial-setting__options-row">
              <div className="settings-form__group">
                <label className="settings-form__label">
                  {lang === 'id' ? 'Panjang Digit Sequence ({SEQ})' : 'Sequence Digits ({SEQ})'}
                </label>
                <select
                  className="input select"
                  value={seqLength}
                  onChange={(e) => setSeqLength(Number(e.target.value))}
                >
                  <option value={3}>3 Digit (001, 002, ...)</option>
                  <option value={4}>4 Digit (0001, 0002, ...)</option>
                  <option value={5}>5 Digit (00001, 00002, ...)</option>
                  <option value={6}>6 Digit (000001, 000002, ...)</option>
                </select>
              </div>

              <div className="settings-form__group">
                <label className="settings-form__label">
                  {lang === 'id' ? 'Mode Default di Goods In' : 'Default Mode in Goods In'}
                </label>
                <select
                  className="input select"
                  value={defaultMode}
                  onChange={(e) => setDefaultMode(e.target.value)}
                >
                  <option value="manual">
                    {lang === 'id' ? 'Manual (Input Baris demi Baris)' : 'Manual (Line by Line)'}
                  </option>
                  <option value="auto">
                    {lang === 'id' ? 'Auto Generate (Otomatis)' : 'Auto Generate (Automatic)'}
                  </option>
                </select>
              </div>
            </div>

            {/* Live Preview Box */}
            <div className="serial-setting__preview-box">
              <div className="serial-setting__preview-header">
                <span>{lang === 'id' ? 'Preview Output' : 'Output Preview'}</span>
              </div>
              <div className="serial-setting__preview-content">
                <code className="serial-setting__preview-code">{previewExample}</code>
              </div>
              <span className="serial-setting__preview-caption">
                {lang === 'id'
                  ? `Simulasi SKU "${sampleSku}", Satuan "${sampleUnitCode}".`
                  : `Simulated for SKU "${sampleSku}", Unit "${sampleUnitCode}".`}
              </span>
            </div>

            {/* Mode Transisi: Barang Keluar Belum Terdata (Non-SN) */}
            <div
              style={{
                marginTop: 'var(--space-2)',
                padding: 'var(--space-4)',
                background: allowUnrecorded ? 'rgba(245, 158, 11, 0.06)' : 'var(--color-surface-hover, #f8fafc)',
                border: allowUnrecorded ? '1px solid rgba(245, 158, 11, 0.3)' : '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    <AlertTriangle size={16} color={allowUnrecorded ? '#d97706' : 'var(--color-text-muted)'} />
                    <span>{lang === 'id' ? 'Barang Keluar Belum Terdata (Non-SN)' : 'Unrecorded Goods Out (Non-SN)'}</span>
                    <span className={`chip ${allowUnrecorded ? 'chip-success' : 'chip-secondary'} chip-sm`}>
                      {allowUnrecorded ? (lang === 'id' ? 'Aktif' : 'Active') : (lang === 'id' ? 'Nonaktif' : 'Disabled')}
                    </span>
                  </div>
                  <p style={{ margin: '6px 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                    {lang === 'id'
                      ? 'Mengizinkan staf memproses Barang Keluar cepat untuk barang fisik yang belum masuk stok/tidak ada serial number. Transaksi ini tidak memotong stok sistem & tidak membuat nomor seri palsu.'
                      : 'Allows staff to process Goods Out quickly for physical items not yet in stock/without serial numbers. Does not deduct stock or create fake serials.'}
                  </p>
                </div>
                <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', flexShrink: 0, marginTop: '2px' }}>
                  <input
                    type="checkbox"
                    checked={allowUnrecorded}
                    onChange={(e) => setAllowUnrecorded(e.target.checked)}
                    style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Unit Short Codes Table */}
        <div className="serial-setting__card">
          <div className="serial-setting__card-header">
            <div className="serial-setting__card-title-group">
              <SlidersHorizontal size={18} className="serial-setting__icon" />
              <h3 className="serial-setting__card-title">
                {lang === 'id' ? 'Singkatan Satuan (Unit Short Codes)' : 'Unit Short Codes'}
              </h3>
            </div>
          </div>

          <div className="serial-setting__card-body">
            <p className="serial-setting__table-intro">
              {lang === 'id'
                ? 'Kode singkatan ini yang akan disematkan pada token {UNIT} di nomor seri produk.'
                : 'These short abbreviations will replace the {UNIT} token in generated serial numbers.'}
            </p>

            <div className="serial-setting__table-wrap">
              <table className="serial-setting__table">
                <thead>
                  <tr>
                    <th>{lang === 'id' ? 'Satuan' : 'Unit'}</th>
                    <th>{lang === 'id' ? 'Keterangan' : 'Description'}</th>
                    <th style={{ width: '130px' }}>{lang === 'id' ? 'Singkatan (SN)' : 'Short Code'}</th>
                    <th>{lang === 'id' ? 'Contoh Serial' : 'Sample Serial'}</th>
                  </tr>
                </thead>
                <tbody>
                  {units.map((u) => {
                    const shortVal = unitShortCodes[u.key] ?? DEFAULT_UNIT_SHORT_CODES[u.key] ?? u.key.toUpperCase();
                    const sampleSN = buildSerialNumber({
                      sku: 'HS110',
                      unitCode: shortVal,
                      dateStr: new Date(),
                      seqNum: 1,
                      settings: { template, seqLength },
                    });

                    return (
                      <tr key={u.key}>
                        <td>
                          <span className="serial-setting__unit-key">
                            <code>{u.key}</code>
                          </span>
                        </td>
                        <td>
                          <span className="serial-setting__unit-name">
                            {u.name} {u.description ? `(${u.description})` : ''}
                          </span>
                        </td>
                        <td>
                          <input
                            type="text"
                            maxLength={10}
                            className="input serial-setting__shortcode-input"
                            value={shortVal}
                            placeholder={u.key.toUpperCase()}
                            onChange={(e) => handleUnitShortCodeChange(u.key, e.target.value)}
                          />
                        </td>
                        <td>
                          <span className="serial-setting__unit-sample">{sampleSN}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="serial-setting__legacy-note">
              <strong>💡 Catatan Kompatibilitas:</strong> Satuan Bal (seperti <code>bal10</code>, <code>bal15</code>, <code>bal20</code>, <code>bal25</code>) secara default disingkat menjadi <code>BL10</code>, <code>BL15</code>, <code>BL20</code>, <code>BL25</code> agar kompatibel penuh dengan pembaca otomatis nomor seri (Serial Parser).
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
