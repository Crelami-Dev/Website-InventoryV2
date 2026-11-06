import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { X, Plus, AlertCircle, Check, Search, ChevronDown, User, FileText, StickyNote, Receipt } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useUnits } from '../../hooks/useUnits.js';
import { api, buildDocumentNumber, countDocsForSeqReset, DEFAULT_RULES, getWorkspaceSettings, isWorkspaceModuleEnabled } from '../../utils/api.js';
import IndoDateInput from '../../components/IndoDateInput/IndoDateInput.jsx';
import './DocumentCreateModal.css';

const DOC_TYPES = [
  { key: 'invoice', labelKey: 'documents.type.invoice', enabled: true },
  { key: 'sample', labelKey: 'documents.type.sample', enabled: true },
  { key: 'delivery_note', labelKey: 'documents.type.deliveryNote', enabled: false },
  { key: 'receipt', labelKey: 'documents.type.receipt', enabled: false },
];

function makeEmptyItem() {
  return {
    id: crypto.randomUUID(),
    productId: null,
    productName: '',
    sku: '',
    unit: 'lusin',
    qty: 1,
    price: '',
    discountType: 'none',
    discountValue: '',
    note: '',
  };
}

function generateInvoiceNumber(settings, docType = 'invoice', dateStr = todayIso()) {
  if (settings) {
    return buildDocumentNumber(docType, dateStr, 0, settings);
  }
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `NOTA No: ${yyyy}${mm}${dd}0001`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function calcItemAmount(item) {
  const qty = Number(item.qty) || 0;
  const price = Number(item.price) || 0;
  let discount = 0;
  if (item.discountType === 'percentage') {
    discount = Math.round((qty * price * Number(item.discountValue || 0)) / 100);
  } else if (item.discountType === 'fixed') {
    discount = Number(item.discountValue) || 0;
  }
  return Math.max(qty * price - discount, 0);
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);
}

export default function DocumentCreateModal({ onClose, onSuccess }) {
  const { t, user } = useApp();
  const queryClient = useQueryClient();
  const { units, formatUnitOption } = useUnits();
  const navigate = useNavigate();

  const { data: settings } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: getWorkspaceSettings,
    staleTime: 5 * 60 * 1000,
  });

  const contactsEnabled = user?.role?.toLowerCase() === 'super_admin' ||
    (settings ? isWorkspaceModuleEnabled(settings, 'contacts', user) : false);

  const { data: rawContacts = [] } = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/contacts?limit=500');
      if (res.status === 403) return [];
      if (!res.ok) throw new Error('Failed to load contacts');
      const json = await res.json();
      return json.data ?? [];
    },
    enabled: contactsEnabled,
    staleTime: 60000,
  });

  const { data: rawProducts = [] } = useQuery({
    queryKey: ['products'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/products?limit=1000');
      if (!res.ok) throw new Error('Failed to load products');
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: documents = [] } = useQuery({
    queryKey: ['documents'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/documents?limit=1000');
      if (!res.ok) return [];
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 30000,
  });

  const [docType, setDocType] = useState('invoice');
  const [customer, setCustomer] = useState('');
  const [contactId, setContactId] = useState(null);
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  const [creatingContact, setCreatingContact] = useState(false);
  const customerRef = useRef(null);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [date, setDate] = useState(todayIso());
  const [address, setAddress] = useState('');
  const [picSales, setPicSales] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('unpaid');
  const [dueDate, setDueDate] = useState(todayIso() + 'T00:00');
  const dueDateRef = useRef(null);

  const countThisMonth = useCallback((type, dateStr) => {
    if (!documents || !Array.isArray(documents)) return 0;
    const rules = settings?.numbering?.rules || (Array.isArray(settings?.numbering) ? settings.numbering : null);
    const rule = rules?.find((r) => r.type === type) || DEFAULT_RULES.find((r) => r.type === type) || { type, seqReset: 'monthly' };
    return countDocsForSeqReset(documents, rule, dateStr);
  }, [documents, settings]);

  useEffect(() => {
    if (settings && documents) {
      const count = countThisMonth(docType, date);
      const num = buildDocumentNumber(docType, date, count, settings);
      setInvoiceNumber(num);
    } else if (settings) {
      setInvoiceNumber(buildDocumentNumber(docType, date, 0, settings));
    } else {
      setInvoiceNumber(generateInvoiceNumber(null, docType, date));
    }
  }, [settings, documents, docType, date, countThisMonth]);
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([makeEmptyItem()]);
  const [hasOverallDiscount, setHasOverallDiscount] = useState(false);
  const [overallDiscountType, setOverallDiscountType] = useState('percentage');
  const [overallDiscountValue, setOverallDiscountValue] = useState('');

  const [hasPointRedeem, setHasPointRedeem] = useState(false);
  const [pointRedeemValue, setPointRedeemValue] = useState('');

  const [hasCashbackDiscount, setHasCashbackDiscount] = useState(false);
  const [cashbackDiscountType, setCashbackDiscountType] = useState('percentage');
  const [cashbackDiscountValue, setCashbackDiscountValue] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [isProductSearching, setIsProductSearching] = useState(null);

  const contacts = rawContacts ?? [];
  const products = rawProducts ?? [];

  // Fetch available loyalty points for selected customer
  const { data: customerPointData } = useQuery({
    queryKey: ['contact-point-balance', contactId],
    queryFn: async () => {
      if (!contactId) return { balance: 0 };
      const res = await api.get(`/api/workspace/contacts/${contactId}/points/balance`);
      if (!res.ok) return { balance: 0 };
      const json = await res.json();
      return json.data ?? { balance: 0 };
    },
    enabled: !!contactId,
    staleTime: 10000,
  });

  const availablePoints = customerPointData?.balance || 0;

  // Customer autocomplete
  const filteredContacts = useMemo(() => {
    if (!customer.trim()) return [];
    const q = customer.toLowerCase();
    return contacts.filter((c) => {
      const nameMatch = (c.name ?? '').toLowerCase().includes(q);
      const storeNameMatch = (c.metadata?.storeName ?? '').toLowerCase().includes(q);
      return nameMatch || storeNameMatch;
    });
  }, [contacts, customer]);

  const isExistingContact = useMemo(() => {
    if (!customer.trim() || !filteredContacts.length) return null;
    return filteredContacts.some((c) => {
      const nameMatch = (c.name ?? '').toLowerCase() === customer.trim().toLowerCase();
      const storeNameMatch = (c.metadata?.storeName ?? '').toLowerCase() === customer.trim().toLowerCase();
      return nameMatch || storeNameMatch;
    });
  }, [filteredContacts, customer]);

  useClickOutside(customerRef, () => setCustomerDropdownOpen(false));

  const subtotal = useMemo(() => {
    return items.reduce((sum, item) => {
      const qty = Number(item.qty) || 0;
      const price = Number(item.price) || 0;
      return sum + qty * price;
    }, 0);
  }, [items]);

  const itemsDiscountTotal = useMemo(() => {
    return items.reduce((sum, item) => {
      const qty = Number(item.qty) || 0;
      const price = Number(item.price) || 0;
      if (item.discountType === 'percentage') {
        return sum + Math.round((qty * price * Number(item.discountValue || 0)) / 100);
      }
      if (item.discountType === 'fixed') {
        return sum + (Number(item.discountValue) || 0);
      }
      return sum;
    }, 0);
  }, [items]);

  const itemsNetSubtotal = useMemo(() => {
    return Math.max(subtotal - itemsDiscountTotal, 0);
  }, [subtotal, itemsDiscountTotal]);

  const overallDiscountAmount = useMemo(() => {
    if (!hasOverallDiscount) return 0;
    const val = Number(overallDiscountValue) || 0;
    if (overallDiscountType === 'percentage') {
      return Math.round((itemsNetSubtotal * val) / 100);
    }
    if (overallDiscountType === 'fixed') {
      return val;
    }
    return 0;
  }, [hasOverallDiscount, overallDiscountType, overallDiscountValue, itemsNetSubtotal]);

  const priceAfterShopDiscount = useMemo(() => {
    return Math.max(itemsNetSubtotal - overallDiscountAmount, 0);
  }, [itemsNetSubtotal, overallDiscountAmount]);

  const pointRedeemAmount = useMemo(() => {
    if (!hasPointRedeem || availablePoints <= 0) return 0;
    const requested = Number(pointRedeemValue) || 0;
    return Math.min(requested, availablePoints, priceAfterShopDiscount);
  }, [hasPointRedeem, availablePoints, pointRedeemValue, priceAfterShopDiscount]);

  // Cashback will be earned as points for future transactions, not deducted directly from current invoice total
  const cashbackDiscountAmount = useMemo(() => {
    if (!hasCashbackDiscount) return 0;
    const val = Number(cashbackDiscountValue) || 0;
    const basePrice = Math.max(priceAfterShopDiscount - pointRedeemAmount, 0);
    if (cashbackDiscountType === 'percentage') {
      return Math.round((basePrice * val) / 100);
    }
    if (cashbackDiscountType === 'fixed') {
      return val;
    }
    return 0;
  }, [hasCashbackDiscount, cashbackDiscountType, cashbackDiscountValue, priceAfterShopDiscount, pointRedeemAmount]);

  const totalDiscount = useMemo(() => {
    return itemsDiscountTotal + overallDiscountAmount + pointRedeemAmount;
  }, [itemsDiscountTotal, overallDiscountAmount, pointRedeemAmount]);

  const total = useMemo(() => {
    return Math.max(priceAfterShopDiscount - pointRedeemAmount, 0);
  }, [priceAfterShopDiscount, pointRedeemAmount]);

  const canAddItem = useMemo(() => {
    if (items.length === 0) return true;
    const lastItem = items[items.length - 1];
    return !!lastItem.productName?.trim();
  }, [items]);

  const [lastAddedId, setLastAddedId] = useState(null);

  const handleItemChange = useCallback((itemId, fields) => {
    setItems((prev) =>
      prev.map((it) => (it.id === itemId ? { ...it, ...fields } : it))
    );
  }, []);

  const handleAddItem = () => {
    if (items.length > 0) {
      const lastItem = items[items.length - 1];
      if (!lastItem.productName?.trim()) {
        return;
      }
    }
    const newItem = makeEmptyItem();
    setLastAddedId(newItem.id);
    setItems((prev) => [...prev, newItem]);
  };

  const handleRemoveItem = (itemId) => {
    setItems((prev) => prev.filter((it) => it.id !== itemId));
  };

  const handleProductSelect = (itemId, product) => {
    setIsProductSearching(null);
    setItems((prev) =>
      prev.map((it) =>
        it.id === itemId
          ? {
            ...it,
            productId: product.id,
            productName: product.name,
            sku: product.sku || '',
            price: Number(product.sellingPrice ?? product.price ?? 0),
            unit: 'lusin',
          }
          : it
      )
    );
  };

  const validate = () => {
    if (!customer.trim()) return t('documents.error.customerRequired');
    if (items.length === 0) return t('documents.error.itemsRequired');
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.productName.trim()) return t('documents.error.itemInvalid', { index: i + 1 });
      if (!item.sku.trim()) return t('documents.error.itemInvalid', { index: i + 1 });
      if (docType !== 'sample' && (item.price === '' || Number(item.price) <= 0)) {
        return t('documents.error.itemInvalid', { index: i + 1 });
      }
    }
    return null;
  };

  const handleCreateNewContact = async (mode = 'customer') => {
    const nameVal = customer.trim();
    if (!nameVal) return null;
    if (creatingContact) return null;
    if (!contactsEnabled) {
      setCustomerDropdownOpen(false);
      return { id: null, name: mode === 'store' ? nameVal : '-', metadata: { storeName: mode === 'customer' ? nameVal : '' } };
    }
    setCreatingContact(true);
    try {
      const contactName = mode === 'store' ? nameVal : '-';
      const storeNameVal = mode === 'customer' ? nameVal : '';
      const res = await api.post('/api/workspace/contacts', {
        name: contactName,
        type: 'customer',
        metadata: {
          storeName: storeNameVal || null,
          picSales: picSales.trim() || null,
        }
      });
      if (!res.ok) throw new Error(t('documents.error.contactCreateFailed'));
      const json = await res.json();
      const newContact = json.data ?? json;
      setCustomer(newContact.name ?? contactName);
      setOwnerName(newContact.metadata?.storeName ?? storeNameVal);
      setContactId(newContact.id);
      setCustomerDropdownOpen(false);
      return newContact;
    } catch (err) {
      setError(err.message || t('documents.error.contactCreateFailed'));
      return null;
    } finally {
      setCreatingContact(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      // Resolve contact
      let resolvedContactId = contactId;
      let resolvedContactName = customer.trim();
      if (!resolvedContactId) {
        const existing = contacts.find((c) => {
          const nameMatch = (c.name ?? '').toLowerCase() === customer.trim().toLowerCase();
          const storeNameMatch = (c.metadata?.storeName ?? '').toLowerCase() === customer.trim().toLowerCase();
          return nameMatch || storeNameMatch;
        });
        if (existing) {
          resolvedContactId = existing.id;
        } else {
          const created = await handleCreateNewContact('store');
          if (!created) return;
          resolvedContactId = created.id;
        }
      }

      if (resolvedContactId) {
        // Use the user-edited values (customer = storeName, ownerName = owner)
        const store = customer.trim();
        const owner = ownerName.trim();
        if (store && store !== '-' && owner && owner !== '-') {
          resolvedContactName = `${store} (${owner})`;
        } else {
          resolvedContactName = (store && store !== '-') ? store : owner || '-';
        }
      }

      // Save and update contact details in the database if edited
      if (resolvedContactId) {
        const existingContact = contacts.find((c) => c.id === resolvedContactId);
        const hasChanges = existingContact && (
          (existingContact.name || '') !== customer.trim() ||
          (existingContact.metadata?.storeName || '') !== ownerName.trim() ||
          (existingContact.phone || '') !== phone.trim() ||
          (existingContact.email || '') !== email.trim() ||
          (existingContact.address || '') !== address.trim() ||
          (existingContact.metadata?.picSales || '') !== picSales.trim()
        );
        if (hasChanges) {
          api.patch(`/api/workspace/contacts/${resolvedContactId}`, {
            name: customer.trim(),
            phone: phone.trim() || null,
            email: email.trim() || null,
            address: address.trim() || null,
            metadata: {
              ...existingContact.metadata,
              storeName: ownerName.trim() || null,
              picSales: picSales.trim() || null
            },
          }).catch((err) => console.error('Failed to update contact:', err));
        }
      }

      // Resolve inline products in 1 atomic batch
      const createdCache = {};
      const resolvedItems = [];
      const newProductsToBatch = [];
      const seenBatchKeys = new Set();

      for (const item of items) {
        if (item.productId && item.productId !== '__new__') continue;

        const skuKey = (item.sku || '').trim().toLowerCase();
        const nameKey = (item.productName || '').trim().toLowerCase();

        const existing = (products || []).find(
          (p) =>
            (skuKey && p.sku && p.sku.trim().toLowerCase() === skuKey) ||
            (nameKey && p.name && p.name.trim().toLowerCase() === nameKey)
        );
        if (existing) continue;

        const dedupKey = skuKey || nameKey;
        if (!dedupKey || seenBatchKeys.has(dedupKey)) continue;
        seenBatchKeys.add(dedupKey);

        newProductsToBatch.push({
          name: item.productName.trim(),
          sku: item.sku?.trim() || '',
          status: 'active',
          stock: 0,
          unitCost: 0,
          sellingPrice: Number(item.price) || 0,
          discountType: 'none',
          discountValue: 0,
        });
      }

      if (newProductsToBatch.length > 0) {
        const batchRes = await api.post('/api/workspace/products/batch', {
          products: newProductsToBatch,
        });
        if (!batchRes.ok) throw new Error(t('documents.error.productCreateFailed'));
        const batchJson = await batchRes.json();
        const createdList = Array.isArray(batchJson.data) ? batchJson.data : [];

        for (const prod of createdList) {
          const sKey = (prod.sku || '').trim().toLowerCase();
          const nKey = (prod.name || '').trim().toLowerCase();
          if (sKey) createdCache[sKey] = prod;
          if (nKey) createdCache[nKey] = prod;
        }

        queryClient.setQueryData(['products'], (prev) => {
          if (!prev || !Array.isArray(prev)) return createdList;
          const existingIds = new Set(prev.map((p) => p.id));
          const additions = createdList.filter((p) => !existingIds.has(p.id));
          return [...additions, ...prev];
        });
      }

      for (const item of items) {
        if (item.productId && item.productId !== '__new__') {
          resolvedItems.push(item);
          continue;
        }

        const skuKey = (item.sku || '').trim().toLowerCase();
        const nameKey = (item.productName || '').trim().toLowerCase();

        const existing = (products || []).find(
          (p) =>
            (skuKey && p.sku && p.sku.trim().toLowerCase() === skuKey) ||
            (nameKey && p.name && p.name.trim().toLowerCase() === nameKey)
        );
        if (existing) {
          resolvedItems.push({ ...item, productId: existing.id, productName: existing.name, sku: existing.sku });
          continue;
        }

        const cached = (skuKey && createdCache[skuKey]) || (nameKey && createdCache[nameKey]);
        if (cached) {
          resolvedItems.push({ ...item, productId: cached.id, productName: cached.name, sku: cached.sku });
          continue;
        }

        const res = await api.post('/api/workspace/products', {
          name: item.productName.trim(),
          sku: item.sku.trim(),
          status: 'active',
          stock: 0, unitCost: 0, sellingPrice: Number(item.price) || 0,
          discountType: 'none', discountValue: 0,
        });
        if (!res.ok) throw new Error(t('documents.error.productCreateFailed'));
        const json = await res.json();
        const newProd = json.data;
        if (skuKey) createdCache[skuKey] = newProd;
        if (nameKey) createdCache[nameKey] = newProd;
        resolvedItems.push({ ...item, productId: newProd.id, productName: newProd.name, sku: newProd.sku });
      }

      // Build payload
      const isSample = docType === 'sample';
      const payloadItems = resolvedItems.map((item, idx) => {
        const qty = Number(item.qty) || 1;
        const price = isSample ? 0 : (Number(item.price) || 0);
        const rawDiscount = isSample ? 0 : (item.discountType === 'percentage'
          ? Math.round((qty * price * Number(item.discountValue || 0)) / 100)
          : item.discountType === 'fixed'
            ? Number(item.discountValue) || 0
            : 0);
        const amount = isSample ? 0 : Math.max(qty * price - rawDiscount, 0);
        return {
          productId: item.productId,
          itemName: item.productName,
          sku: item.sku || '',
          quantity: qty,
          unitPrice: price,
          discountType: isSample ? 'none' : item.discountType,
          discountValue: isSample ? 0 : (Number(item.discountValue) || 0),
          amount,
          sortOrder: idx,
          metadata: { note: item.note || '', unit: item.unit || 'pcs' },
        };
      });

      const payload = {
        documentType: docType,
        documentNumber: invoiceNumber,
        contactId: resolvedContactId || null,
        contactName: resolvedContactName || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        address: address.trim() || null,
        status: 'completed',
        issueDate: date,
        notes: notes.trim() || null,
        subtotal: isSample ? 0 : subtotal,
        discount: isSample ? 0 : totalDiscount,
        tax: 0,
        total: isSample ? 0 : total,
        items: payloadItems,
        paymentTerms: isSample ? 'unpaid:0' : paymentStatus,
        dueDate: isSample ? null : (dueDate || null),
        metadata: {
          phone: phone.trim() || null,
          email: email.trim() || null,
          address: address.trim() || null,
          points: isSample ? null : {
            earned: hasCashbackDiscount && cashbackDiscountAmount > 0 ? {
              amount: cashbackDiscountAmount,
              pointValue: cashbackDiscountAmount,
              type: cashbackDiscountType,
              value: Number(cashbackDiscountValue) || 0,
            } : null,
            redeemed: hasPointRedeem && pointRedeemAmount > 0 ? {
              amount: pointRedeemAmount,
              pointValue: pointRedeemAmount,
            } : null,
          },
          overallDiscounts: isSample ? [] : [
            ...(hasOverallDiscount && (Number(overallDiscountValue) || 0) !== 0
              ? [{
                  name: 'Diskon Toko',
                  type: overallDiscountType,
                  value: Number(overallDiscountValue) || 0,
                  amount: overallDiscountAmount
                }]
              : []),
            ...(hasPointRedeem && pointRedeemAmount > 0
              ? [{
                  name: 'Potongan Point',
                  type: 'fixed',
                  value: pointRedeemAmount,
                  amount: pointRedeemAmount
                }]
              : []),
            ...(hasCashbackDiscount && (Number(cashbackDiscountValue) || 0) !== 0
              ? [{
                  name: 'Cashback Point',
                  type: cashbackDiscountType,
                  value: Number(cashbackDiscountValue) || 0,
                  amount: cashbackDiscountAmount,
                  isPointEarned: true
                }]
              : [])
          ]
        }
      };

      const res = await api.post('/api/workspace/documents', payload);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.message || t('documents.error.createFailed'));
      }

      const json = await res.json();
      onSuccess(json.data);
      navigate('/document/' + json.data.id);
    } catch (err) {
      setError(err.message || t('documents.error.createFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="doc-modal-overlay">
      <section className="doc-modal" role="dialog" aria-modal="true" aria-labelledby="doc-modal-title">
        <div className="doc-modal__header">
          <div>
            <h2 id="doc-modal-title" className="doc-modal__title">{t('documents.modal.createTitle')}</h2>
            <p className="doc-modal__subtitle">{t('documents.modal.createSubtitle')}</p>
          </div>
          <button type="button" className="doc-modal__close-btn" onClick={onClose} aria-label={t('documents.modal.cancel')}>
            <X size={20} />
          </button>
        </div>

        <div className="doc-modal__body">
          <form id="doc-create-form" onSubmit={handleSubmit} noValidate>

            {/* ── Bento form layout ─────────────────────────── */}
            <div className="doc-modal__bento">

              {/* Customer card — the big tile */}
              <div className="doc-modal__bento-card doc-modal__bento-card--customer" ref={customerRef}>
                <div className="doc-modal__bento-card-head">
                  <span className="doc-modal__bento-card-icon"><User size={15} /></span>
                  <h3 className="doc-modal__bento-card-title">{t('documents.modal.customer')}</h3>
                </div>

                <div className="doc-modal__field">
                  <div className="doc-modal__customer-wrap">
                    {contactId ? (
                      <div className="doc-modal__selected-customer-wrap">
                        <div className="doc-modal__bento-card-row">
                          <div className="doc-modal__field">
                            <label className="doc-modal__field-label">
                              {t('documents.modal.storeName')} <span className="doc-modal__required">*</span>
                            </label>
                            <input type="text" className="input doc-modal__readonly" value={customer} disabled readOnly />
                          </div>
                          <div className="doc-modal__field">
                            <label className="doc-modal__field-label">{t('documents.modal.ownerName')}</label>
                            <input type="text" className="input" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
                          </div>
                        </div>
                        <button
                          type="button"
                          className="doc-modal__change-contact-btn"
                          onClick={() => {
                            setContactId(null);
                            setCustomerDropdownOpen(true);
                          }}
                        >
                          {t('documents.modal.changeCustomer')}
                        </button>
                          <div className="doc-modal__field" style={{ marginTop: 8 }}>
                            <label className="doc-modal__field-label">{t('documents.modal.picSales')}</label>
                            <input type="text" className="input doc-modal__readonly" value={picSales} disabled readOnly />
                          </div>
                      </div>
                    ) : (
                      <>
                        <div className="doc-modal__customer-input-wrap">
                          <Search size={14} className="doc-modal__search-icon" />
                          <input
                            type="text"
                            className="input doc-modal__customer-input"
                            placeholder={t('documents.modal.customerPlaceholder')}
                            value={customer}
                            onChange={(e) => {
                              setCustomer(e.target.value);
                              setContactId(null);
                              if (e.target.value.trim()) setCustomerDropdownOpen(true);
                              else setCustomerDropdownOpen(false);
                            }}
                            onFocus={() => { if (customer.trim()) setCustomerDropdownOpen(true); }}
                          />
                          <ChevronDown size={14} className="doc-modal__chevron" />
                        </div>
                        {customerDropdownOpen && (
                          <div className="doc-modal__customer-dropdown">
                            {filteredContacts.length > 0 ? (
                              filteredContacts.map((c) => {
                                 const storeName = c.name || '';
                                 const ownerName = c.metadata?.storeName || '';
                                 const displayName = (storeName.trim() && storeName !== '-') ? storeName : ownerName;
                                 const subName = (displayName === storeName && ownerName.trim() && ownerName !== '-')
                                   ? t('documents.modal.owner', { name: ownerName })
                                   : '';
                                 const picSalesLabel = c.metadata?.picSales ? t('documents.modal.picSalesLabel', { name: c.metadata.picSales }) : '';
                                 const details = [c.phone, c.email, c.address].filter(Boolean).join(' \u00b7 ');
                                 return (
                                   <button
                                     key={c.id}
                                     type="button"
                                     className="doc-modal__customer-dropdown-item"
                                     onMouseDown={(e) => {
                                       e.preventDefault();
                                       setCustomer(displayName);
                                       setContactId(c.id);
                                       setCustomerDropdownOpen(false);
                                       setOwnerName(ownerName !== '-' ? ownerName : '');
                                       setPhone(c.phone || '');
                                       setEmail(c.email || '');
                                       setAddress(c.address || '');
                                       setPicSales(c.metadata?.picSales || '');
                                     }}
                                   >
                                     <span className="doc-modal__customer-dropdown-name">
                                       {displayName} {subName && <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)', fontWeight: 'normal' }}>({subName})</span>}
                                     </span>
                                     {(details || picSalesLabel) && (
                                       <span className="doc-modal__customer-dropdown-meta">
                                         {details}{picSalesLabel ? `${details ? ' \u00b7 ' : ''}${picSalesLabel}` : ''}
                                       </span>
                                     )}
                                   </button>
                                 );
                               })
                             ) : null}
                            {contactsEnabled && customer.trim() && !isExistingContact && (
                              <>
                                <button
                                  type="button"
                                  className="doc-modal__customer-dropdown-create"
                                  onMouseDown={(e) => { e.preventDefault(); handleCreateNewContact('store'); }}
                                  style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
                                  disabled={creatingContact}
                                >
                                  <Plus size={14} />
                                  <span>{creatingContact ? t('documents.modal.submitting') : t('documents.modal.createStoreContact', { name: customer.trim() })}</span>
                                </button>
                                <button
                                  type="button"
                                  className="doc-modal__customer-dropdown-create"
                                  onMouseDown={(e) => { e.preventDefault(); handleCreateNewContact('customer'); }}
                                  disabled={creatingContact}
                                >
                                  <Plus size={14} />
                                  <span>{creatingContact ? t('documents.modal.submitting') : t('documents.modal.createCustomerContact', { name: customer.trim() })}</span>
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="doc-modal__bento-card-row">
                  <div className="doc-modal__field">
                    <label className="doc-modal__field-label">{t('documents.modal.phone')}</label>
                    <input
                      type="text"
                      className="input"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </div>
                  <div className="doc-modal__field">
                    <label className="doc-modal__field-label">{t('documents.modal.email')}</label>
                    <input
                      type="email"
                      className="input"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                </div>

                <div className="doc-modal__field">
                  <label className="doc-modal__field-label">{t('documents.modal.address')}</label>
                  <input
                    type="text"
                    className="input"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                </div>
              </div>

              {/* Notes card — small tile */}
              <div className="doc-modal__bento-card doc-modal__bento-card--notes">
                <div className="doc-modal__bento-card-head">
                  <span className="doc-modal__bento-card-icon"><StickyNote size={15} /></span>
                  <h3 className="doc-modal__bento-card-title">{t('documents.modal.notes')}</h3>
                </div>
                <textarea
                  className="input doc-modal__notes"
                  placeholder={t('documents.modal.notesPlaceholder')}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              {/* Document detail card — small tile */}
              <div className="doc-modal__bento-card doc-modal__bento-card--doc">
                <div className="doc-modal__bento-card-head">
                  <span className="doc-modal__bento-card-icon"><FileText size={15} /></span>
                  <h3 className="doc-modal__bento-card-title">{t('documents.modal.typeLabel')}</h3>
                </div>

                <div className="doc-modal__field">
                  <select
                    className="input"
                    value={docType}
                    onChange={(e) => setDocType(e.target.value)}
                  >
                    {DOC_TYPES.map((dt) => (
                      <option key={dt.key} value={dt.key} disabled={!dt.enabled}>
                        {t(dt.labelKey)}{!dt.enabled ? ` (${t('documents.modal.typeComingSoon')})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="doc-modal__bento-card-row">
                  <div className="doc-modal__field">
                    <label className="doc-modal__field-label">{t('documents.modal.date')}</label>
                    <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} required />
                  </div>
                  <div className="doc-modal__field">
                    <label className="doc-modal__field-label">{t('documents.modal.invoiceNumber')}</label>
                    <input type="text" className="input doc-modal__readonly" value={invoiceNumber} disabled readOnly />
                  </div>
                </div>

                {docType !== 'sample' && (
                  <>
                    <div className="doc-modal__field">
                      <label className="doc-modal__field-label">{t('documents.modal.paymentStatusLabel')}</label>
                      <select
                        className="input"
                        value={paymentStatus}
                        onChange={(e) => setPaymentStatus(e.target.value)}
                      >
                        <option value="unpaid">{t('documents.paymentStatus.unpaid')}</option>
                        <option value="paid">{t('documents.paymentStatus.paid')}</option>
                      </select>
                    </div>

                    {paymentStatus === 'unpaid' && (
                      <div className="doc-modal__field">
                        <label className="doc-modal__field-label">{t('documents.modal.dueDate')}</label>
                        <IndoDateInput
                          value={dueDate ? dueDate.slice(0, 10) : ''}
                          onChange={(iso) => {
                            if (!iso) {
                              setDueDate('');
                            } else {
                              setDueDate(`${iso}T00:00`);
                            }
                          }}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* ── Items ─────────────────────────────────────── */}
            <div className="doc-modal__items-section">
              <div className="doc-modal__items-header">
                <h4 className="doc-modal__items-title">{t('documents.modal.items')}</h4>
                <button
                  type="button"
                  className="doc-modal__add-item-btn"
                  onClick={handleAddItem}
                  disabled={!canAddItem}
                  title={!canAddItem ? t('documents.modal.selectProductFirst') : ''}
                >
                  <Plus size={14} />
                  <span>{t('documents.modal.addRow')}</span>
                </button>
              </div>

              {items.map((item, idx) => (
                <div
                  key={item.id}
                  className="doc-modal__item-row"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (e.target.tagName === 'BUTTON' || isProductSearching === item.id) {
                        return;
                      }
                      e.preventDefault();
                      if (canAddItem) {
                        handleAddItem();
                      }
                    }
                  }}
                >
                  {/* Top: badge + product name + remove */}
                  <div className="doc-modal__item-row-top">
                    <span className="doc-modal__item-badge">{idx + 1}</span>
                    <div className="doc-modal__item-field doc-modal__item-field--name">
                      <label className="doc-modal__item-label">{t('documents.modal.product')}</label>
                      <div className="doc-modal__product-search-wrap">
                        <input
                          type="text"
                          className="input"
                          autoFocus={item.id === lastAddedId}
                          placeholder={t('documents.modal.productPlaceholder')}
                          value={item.productName}
                          onChange={(e) => {
                            handleItemChange(item.id, { productName: e.target.value, productId: null, sku: '', price: '' });
                            setIsProductSearching(item.id);
                          }}
                          onFocus={() => {
                            if (item.productName.trim()) setIsProductSearching(item.id);
                          }}
                        />
                        {isProductSearching === item.id && item.productName.trim() && (
                          <div className="doc-modal__product-dropdown">
                            {products
                              .filter((p) => (p.name ?? '').toLowerCase().includes(item.productName.toLowerCase()))
                              .slice(0, 8)
                              .map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  className="doc-modal__product-dropdown-item"
                                  onMouseDown={(e) => { e.preventDefault(); handleProductSelect(item.id, p); }}
                                >
                                  <span className="doc-modal__product-dropdown-name">{p.name}</span>
                                  <span className="doc-modal__product-dropdown-sku">{p.sku}</span>
                                </button>
                              ))}
                            <button
                              type="button"
                              className="doc-modal__product-dropdown-create"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                handleItemChange(item.id, { productId: '__new__' });
                                setIsProductSearching(null);
                              }}
                            >
                              <Plus size={13} />
                              <span>{t('documents.modal.newProduct')}: {item.productName}</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="doc-modal__remove-item-btn"
                      onClick={() => handleRemoveItem(item.id)}
                      aria-label={t('documents.modal.removeItem')}
                      disabled={items.length === 1}
                    >
                      <X size={14} />
                    </button>
                  </div>

                  {/* Specs row: SKU, unit, qty, price */}
                  <div className="doc-modal__item-row-specs">
                    <div className="doc-modal__item-field doc-modal__item-field--sku">
                      <label className="doc-modal__item-label">{t('documents.modal.sku')}</label>
                      <input
                        type="text"
                        className="input"
                        value={item.sku}
                        onChange={(e) => handleItemChange(item.id, { sku: e.target.value })}
                        placeholder={t('documents.modal.sku')}
                      />
                    </div>
                    <div className="doc-modal__item-field doc-modal__item-field--unit">
                      <label className="doc-modal__item-label">{t('documents.modal.unit')}</label>
                      <select
                        className="input"
                        value={item.unit}
                        onChange={(e) => handleItemChange(item.id, { unit: e.target.value })}
                      >
                        {units.map((u) => (
                          <option key={u.key} value={u.key}>
                            {formatUnitOption(u.key)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="doc-modal__item-field doc-modal__item-field--qty">
                      <label className="doc-modal__item-label">{t('documents.modal.qty')}</label>
                      <input
                        type="number"
                        className="input"
                        step="any"
                        min="0.01"
                        value={item.qty === 0 || item.qty === '' ? '' : item.qty}
                        placeholder="1"
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (raw === '') {
                            handleItemChange(item.id, { qty: '' });
                          } else {
                            const num = parseFloat(raw.replace(',', '.'));
                            handleItemChange(item.id, { qty: isNaN(num) ? raw : num });
                          }
                        }}
                        onBlur={(e) => {
                          const raw = e.target.value;
                          const num = parseFloat(String(raw).replace(',', '.'));
                          if (isNaN(num) || num <= 0) {
                            handleItemChange(item.id, { qty: 1 });
                          } else {
                            handleItemChange(item.id, { qty: Number(num.toFixed(2)) });
                          }
                        }}
                      />
                    </div>
                    {docType !== 'sample' && (
                      <div className="doc-modal__item-field doc-modal__item-field--price">
                        <label className="doc-modal__item-label">{t('documents.modal.price')}</label>
                        <div className="doc-modal__price-wrap">
                          <span className="doc-modal__price-prefix">Rp</span>
                          <input
                            type="number"
                            className="input doc-modal__price-input"
                            min="0"
                            value={item.price || ''}
                            placeholder="0"
                            onChange={(e) => handleItemChange(item.id, { price: e.target.value === '' ? '' : Number(e.target.value) || 0 })}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Bottom row: discount + total */}
                  {docType !== 'sample' && (
                    <div className="doc-modal__item-row-bottom">
                      <div className="doc-modal__item-disc-group">
                        <div className="doc-modal__item-field doc-modal__item-field--disc-type">
                          <label className="doc-modal__item-label">{t('documents.modal.discountType')}</label>
                          <select
                            className="input"
                            value={item.discountType}
                            onChange={(e) => handleItemChange(item.id, { discountType: e.target.value, discountValue: e.target.value === 'none' ? '' : item.discountValue })}
                          >
                            <option value="none">{t('documents.modal.discountNone')}</option>
                            <option value="percentage">%</option>
                            <option value="fixed">Rp</option>
                          </select>
                         </div>
                        <div className="doc-modal__item-field doc-modal__item-field--disc-val">
                          <label className="doc-modal__item-label">{t('documents.modal.discountValue')}</label>
                          <input
                            type="text"
                            className="input"
                            disabled={item.discountType === 'none'}
                            value={item.discountValue}
                            onChange={(e) => handleItemChange(item.id, { discountValue: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="doc-modal__item-field doc-modal__item-field--amount">
                        <label className="doc-modal__item-label">{t('documents.modal.total')}</label>
                        <span className="doc-modal__item-amount">{formatCurrency(calcItemAmount(item))}</span>
                      </div>
                    </div>
                  )}

                  {/* Note */}
                  <div className="doc-modal__item-note">
                    <label className="doc-modal__item-label">{t('documents.modal.note')}</label>
                    <input
                      type="text"
                      className="input"
                      value={item.note}
                      onChange={(e) => handleItemChange(item.id, { note: e.target.value })}
                      placeholder={t('documents.modal.notePlaceholder')}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* ── Overall discounts editor ──────────────────── */}
            {docType !== 'sample' && (
              <div className="doc-modal__overall-discount-section">
                <div className="doc-modal__switchers-row">
                  <div className="doc-modal__switchers-group">
                    <label className="doc-modal__switcher-wrap">
                      <span className="doc-modal__switch">
                        <input
                          type="checkbox"
                          checked={hasOverallDiscount}
                          onChange={(e) => {
                            setHasOverallDiscount(e.target.checked);
                            if (!e.target.checked) {
                              setOverallDiscountValue('');
                            }
                          }}
                        />
                        <span className="doc-modal__switch-slider"></span>
                      </span>
                      <span className="doc-modal__switcher-label">{t('documents.modal.discountStoreAdditional')}</span>
                    </label>

                    {availablePoints > 0 && (
                      <label className="doc-modal__switcher-wrap">
                        <span className="doc-modal__switch">
                          <input
                            type="checkbox"
                            checked={hasPointRedeem}
                            onChange={(e) => {
                              setHasPointRedeem(e.target.checked);
                              if (!e.target.checked) {
                                setPointRedeemValue('');
                              } else {
                                setPointRedeemValue(Math.min(availablePoints, priceAfterShopDiscount));
                              }
                            }}
                          />
                          <span className="doc-modal__switch-slider"></span>
                        </span>
                        <span className="doc-modal__switcher-label">
                          {t('documents.modal.usePoints')}
                        </span>
                      </label>
                    )}

                    <label className="doc-modal__switcher-wrap">
                      <span className="doc-modal__switch">
                        <input
                          type="checkbox"
                          checked={hasCashbackDiscount}
                          onChange={(e) => {
                            setHasCashbackDiscount(e.target.checked);
                            if (!e.target.checked) {
                              setCashbackDiscountValue('');
                            }
                          }}
                        />
                        <span className="doc-modal__switch-slider"></span>
                      </span>
                      <span className="doc-modal__switcher-label">{t('documents.modal.discountCashback')}</span>
                    </label>
                  </div>

                  {contactId && availablePoints > 0 && (
                    <div className="doc-modal__balance-info">
                      <span>{t('documents.modal.storeBalance') || 'Saldo yang dimiliki'} : <strong>{formatCurrency(availablePoints)}</strong></span>
                    </div>
                  )}
                </div>

                {hasOverallDiscount && (
                  <div className="doc-modal__discount-row">
                    <div className="doc-modal__discount-field doc-modal__discount-field--name">
                      <label className="doc-modal__discount-label">{t('documents.modal.discountNote')}</label>
                      <span className="doc-modal__discount-static-label" style={{ fontWeight: 600, fontSize: 'var(--text-small)', padding: 'var(--space-2) 0', color: 'var(--color-text-primary)' }}>
                        {t('documents.modal.discountStore')}
                      </span>
                    </div>

                    <div className="doc-modal__discount-field doc-modal__discount-field--type">
                      <label className="doc-modal__discount-label">{t('documents.modal.discountType')}</label>
                      <select
                        className="input"
                        value={overallDiscountType}
                        onChange={(e) => setOverallDiscountType(e.target.value)}
                      >
                        <option value="percentage">%</option>
                        <option value="fixed">Rp</option>
                      </select>
                    </div>

                    <div className="doc-modal__discount-field doc-modal__discount-field--val">
                      <label className="doc-modal__discount-label">{t('documents.modal.discount')}</label>
                      <div className="doc-modal__discount-val-wrap">
                        {overallDiscountType === 'fixed' && <span className="doc-modal__discount-prefix">Rp</span>}
                        <input
                          type="number"
                          className={`input ${overallDiscountType === 'fixed' ? 'doc-modal__discount-val-input--fixed' : ''}`}
                          min="0"
                          placeholder="0"
                          value={overallDiscountValue}
                          onChange={(e) => setOverallDiscountValue(e.target.value === '' ? '' : Number(e.target.value) || 0)}
                        />
                        {overallDiscountType === 'percentage' && <span className="doc-modal__discount-suffix">%</span>}
                      </div>
                    </div>

                    <div className="doc-modal__discount-field doc-modal__discount-field--amount">
                      <label className="doc-modal__discount-label">{t('documents.modal.total')}</label>
                      <span className="doc-modal__discount-amount">
                        {formatCurrency(overallDiscountAmount)}
                      </span>
                    </div>
                  </div>
                )}

                {hasPointRedeem && (
                  <div className="doc-modal__discount-row" style={{ marginTop: 'var(--space-2)' }}>
                    <div className="doc-modal__discount-field doc-modal__discount-field--name">
                      <label className="doc-modal__discount-label">{t('documents.modal.discountNote')}</label>
                      <span className="doc-modal__discount-static-label" style={{ fontWeight: 600, fontSize: 'var(--text-small)', padding: 'var(--space-2) 0', color: 'var(--color-primary)' }}>
                        {t('documents.modal.discountPoints')} (Maks: {formatCurrency(availablePoints)})
                      </span>
                    </div>

                    <div className="doc-modal__discount-field doc-modal__discount-field--val" style={{ flex: 2 }}>
                      <label className="doc-modal__discount-label">{t('documents.modal.redeemPoints')}</label>
                      <div className="doc-modal__discount-val-wrap">
                        <span className="doc-modal__discount-prefix">Rp</span>
                        <input
                          type="number"
                          className="input doc-modal__discount-val-input--fixed"
                          min="0"
                          max={availablePoints}
                          placeholder="0"
                          value={pointRedeemValue}
                          onChange={(e) => setPointRedeemValue(e.target.value === '' ? '' : Number(e.target.value) || 0)}
                        />
                      </div>
                    </div>

                    <div className="doc-modal__discount-field doc-modal__discount-field--amount">
                      <label className="doc-modal__discount-label">{t('documents.modal.total')}</label>
                      <span className="doc-modal__discount-amount" style={{ color: 'var(--color-danger)' }}>
                        -{formatCurrency(pointRedeemAmount)}
                      </span>
                    </div>
                  </div>
                )}

                {hasCashbackDiscount && (
                  <div className="doc-modal__discount-row" style={{ marginTop: 'var(--space-2)' }}>
                    <div className="doc-modal__discount-field doc-modal__discount-field--name">
                      <label className="doc-modal__discount-label">{t('documents.modal.discountNote')}</label>
                      <span className="doc-modal__discount-static-label" style={{ fontWeight: 600, fontSize: 'var(--text-small)', padding: 'var(--space-2) 0', color: 'var(--color-text-primary)' }}>
                        {t('documents.modal.discountCashback')}
                      </span>
                    </div>

                    <div className="doc-modal__discount-field doc-modal__discount-field--type">
                      <label className="doc-modal__discount-label">{t('documents.modal.discountType')}</label>
                      <select
                        className="input"
                        value={cashbackDiscountType}
                        onChange={(e) => setCashbackDiscountType(e.target.value)}
                      >
                        <option value="percentage">%</option>
                        <option value="fixed">Rp</option>
                      </select>
                    </div>

                    <div className="doc-modal__discount-field doc-modal__discount-field--val">
                      <label className="doc-modal__discount-label">{t('documents.modal.discount')}</label>
                      <div className="doc-modal__discount-val-wrap">
                        {cashbackDiscountType === 'fixed' && <span className="doc-modal__discount-prefix">Rp</span>}
                        <input
                          type="number"
                          className={`input ${cashbackDiscountType === 'fixed' ? 'doc-modal__discount-val-input--fixed' : ''}`}
                          min="0"
                          placeholder="0"
                          value={cashbackDiscountValue}
                          onChange={(e) => setCashbackDiscountValue(e.target.value === '' ? '' : Number(e.target.value) || 0)}
                        />
                        {cashbackDiscountType === 'percentage' && <span className="doc-modal__discount-suffix">%</span>}
                      </div>
                    </div>

                    <div className="doc-modal__discount-field doc-modal__discount-field--amount">
                      <label className="doc-modal__discount-label">{t('documents.modal.cashbackPointInfo')}</label>
                      <span className="doc-modal__discount-amount" style={{ color: 'var(--color-success, #10B981)', fontWeight: 600 }}>
                        +{formatCurrency(cashbackDiscountAmount)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Totals summary card ──────────────────────── */}
            {docType !== 'sample' && (
              <div className="doc-modal__summary-card">
                <div className="doc-modal__summary-icon"><Receipt size={16} /></div>
                <div className="doc-modal__summary-rows">
                  <div className="doc-modal__summary-row">
                    <span>{t('documents.modal.subtotal')}</span>
                    <span>{formatCurrency(subtotal)}</span>
                  </div>
                  {itemsDiscountTotal > 0 && (
                    <div className="doc-modal__summary-row">
                      <span>{t('documents.modal.discountProduct')}</span>
                      <span style={{ color: 'var(--color-danger)' }}>-{formatCurrency(itemsDiscountTotal)}</span>
                    </div>
                  )}
                  {hasOverallDiscount && overallDiscountAmount > 0 && (
                    <div className="doc-modal__summary-row">
                      <span>{t('documents.modal.discountStore')}{overallDiscountType === 'percentage' ? ` (${overallDiscountValue}%)` : ''}</span>
                      <span style={{ color: 'var(--color-danger)' }}>-{formatCurrency(overallDiscountAmount)}</span>
                    </div>
                  )}
                  {hasPointRedeem && pointRedeemAmount > 0 && (
                    <div className="doc-modal__summary-row">
                      <span>{t('documents.modal.discountPoints')}</span>
                      <span style={{ color: 'var(--color-danger)' }}>-{formatCurrency(pointRedeemAmount)}</span>
                    </div>
                  )}
                  <div className="doc-modal__summary-row doc-modal__summary-row--total">
                    <span>{t('documents.modal.grandTotal')}</span>
                    <span>{formatCurrency(total)}</span>
                  </div>
                  {hasCashbackDiscount && cashbackDiscountAmount > 0 && (
                    <div className="doc-modal__summary-row" style={{ marginTop: 'var(--space-2)', paddingTop: 'var(--space-2)', borderTop: '1px dashed var(--color-border)' }}>
                      <span style={{ color: 'var(--color-success, #10B981)', fontWeight: 500 }}>
                        {t('documents.modal.cashbackPointInfo')}{cashbackDiscountType === 'percentage' ? ` (${cashbackDiscountValue}%)` : ''}
                      </span>
                      <span style={{ color: 'var(--color-success, #10B981)', fontWeight: 700 }}>
                        +{formatCurrency(cashbackDiscountAmount)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="doc-modal__error" role="alert">
                <AlertCircle size={14} />
                <span>{error}</span>
              </div>
            )}
          </form>
        </div>

        {/* Footer */}
        <div className="doc-modal__footer">
          {docType !== 'sample' && (
            <span className="doc-modal__footer-total">
              <span className="doc-modal__footer-total-label">{t('documents.modal.grandTotal')}</span>
              <span className="doc-modal__footer-total-value">{formatCurrency(total)}</span>
            </span>
          )}
          <div className="doc-modal__footer-actions">
            <button type="button" className="btn btn-secondary btn-md" onClick={onClose} disabled={submitting}>
              {t('documents.modal.cancel')}
            </button>
            <button type="submit" form="doc-create-form" className="btn btn-primary btn-md" disabled={submitting}>
              {submitting ? t('documents.modal.submitting') : (
                <><Check size={16} /><span>{t('documents.modal.submit')}</span></>
              )}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
