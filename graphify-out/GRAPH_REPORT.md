# Graph Report - DocuflowV2  (2026-10-24)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 2145 nodes · 7340 edges · 93 communities (74 shown, 19 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 300 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0c62000f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 80
- Community 81

## God Nodes (most connected - your core abstractions)
1. `InventoryRepository` - 197 edges
2. `useApp()` - 166 edges
3. `ActiveSecurityContext` - 113 edges
4. `getServerSessionContext()` - 99 edges
5. `AppError` - 88 edges
6. `lucide-react` - 79 edges
7. `Button()` - 77 edges
8. `api` - 65 edges
9. `@tanstack/react-query` - 63 edges
10. `getWorkspaceSettings()` - 59 edges

## Surprising Connections (you probably didn't know these)
- `resetActiveSessions()` --calls--> `seedSyntheticData()`  [EXTRACTED]
  test/stock-opname-phase6.test.ts → src/lib/db/seed.ts
- `@types/react@^18.2.0` --declares--> `@types/react`  [EXTRACTED]
  reference-inventory/Frontend/package.json → package.json
- `ProductDetailPage()` --indirect_call--> `getWorkspaceSettings()`  [INFERRED]
  reference-inventory/Frontend/src/pages/Products/ProductDetailPage.jsx → reference-inventory/Frontend/src/utils/api.js
- `ProductsPage()` --indirect_call--> `getWorkspaceSettings()`  [INFERRED]
  reference-inventory/Frontend/src/pages/Products/ProductsPage.jsx → reference-inventory/Frontend/src/utils/api.js
- `AppProvider()` --indirect_call--> `getWorkspaceSettings()`  [INFERRED]
  reference-inventory/Frontend/src/context/AppContext.jsx → reference-inventory/Frontend/src/utils/api.js

## Import Cycles
- None detected.

## Communities (93 total, 19 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.07
Nodes (82): AuditLogView(), DEMO_DOCS, DEMO_PRODUCTS, DemoDoc, DemoProduct, DesignSystemDemo(), DOC_STATUS, DocumentListSection() (+74 more)

### Community 1 - "Community 1"
Cohesion: 0.07
Nodes (85): CreateBody(), DocumentCreateCustomerOption, DocumentCreateDialog(), DocumentCreatePoLineOption, DocumentCreatePoOption, DocumentCreateProductOption, formatNumber(), formatRupiah() (+77 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (57): nextConfig, next, metadata, DocumentCreateDialogProps, DocumentsViewProps, DocumentsPage(), metadata, GoodsInViewProps (+49 more)

### Community 3 - "Community 3"
Cohesion: 0.13
Nodes (7): ActiveContextProviderProps, AppError, evaluateCrossWarehouseSerialGuard(), normalizeSerialNumber(), getUnitMultiplier(), resolveSerialUnitRepresentation(), ActiveSecurityContext

### Community 4 - "Community 4"
Cohesion: 0.07
Nodes (68): AuditLogPage(), DashboardPage(), metadata, ProductDetailContent(), handleSaveEdit(), ProductsPage(), handleCreateProduct(), StockOpnameDetailContent() (+60 more)

### Community 5 - "Community 5"
Cohesion: 0.08
Nodes (54): DashboardSummaryData, DashboardView(), ScanErrorItem, StockOpnameErrorDrawerProps, StockOpnameScannerPanel(), handleScanSubmit(), StockOpnameScannerPanelProps, AppShell() (+46 more)

### Community 6 - "Community 6"
Cohesion: 0.13
Nodes (28): applied, db, seeded, MigrationResult, runMigrations(), UpdateCommercialDocumentInput, SeedResult, seedSyntheticData() (+20 more)

### Community 7 - "Community 7"
Cohesion: 0.12
Nodes (53): admin_access_grants, audit_logs, auth_sessions, commercial_document_lines, commercial_documents, customer_point_ledger, customers, document_payments (+45 more)

### Community 8 - "Community 8"
Cohesion: 0.05
Nodes (34): adjustPointSchema, applyListFilters(), buildGoodsInEmailContext(), buildGoodsOutEmailContext(), contactSchema, crudRouter(), DEFAULT_CUSTOM_UNITS, documentItemSchema (+26 more)

### Community 9 - "Community 9"
Cohesion: 0.07
Nodes (25): App(), getFallbackRoute(), ModuleRoute(), PlaceholderPage(), AppShell(), SecretAIOcrModal(), NAV_GROUPS, Sidebar() (+17 more)

### Community 10 - "Community 10"
Cohesion: 0.05
Nodes (46): LineDraft, LineDraft, StockOpnameInvestigationDialogProps, ApproveAndPostStockOpnameAdjustmentInput, ApproveAndPostStockOpnameAdjustmentResult, CommercialDocumentLineRecord, CreateCommercialDocumentInput, CreateCommercialDocumentLineInput (+38 more)

### Community 11 - "Community 11"
Cohesion: 0.07
Nodes (30): idx_contact_points_contact, idx_contact_points_doc, idx_contact_points_owner, public.contact_points, activity_logs_owner_id_idx, contacts_owner_id_idx, documents_owner_id_idx, products_owner_id_idx (+22 more)

### Community 12 - "Community 12"
Cohesion: 0.10
Nodes (31): html5-qrcode, lucide-react, react-router-dom, name, private, type, version, LabelSizePicker() (+23 more)

### Community 13 - "Community 13"
Cohesion: 0.11
Nodes (40): AppContext, AppProvider(), _cachedSortedProds, detectSerialInfo(), getAudioContext(), getSortedProducts(), playBeep(), StockOpname() (+32 more)

### Community 14 - "Community 14"
Cohesion: 0.10
Nodes (32): StockOpnameAreaNavProps, StockOpnameDetailView(), StockOpnameDetailViewProps, StockOpnameErrorDrawer(), StockOpnameFinalizeDialog(), StockOpnameFinalizeDialogProps, DISCREPANCY_REASONS, StockOpnameInvestigationDialog() (+24 more)

### Community 15 - "Community 15"
Cohesion: 0.10
Nodes (33): robots(), EvaluateContextParams, evaluateSecurityContext(), assertAuthorized(), GuardOptions, ServerSessionData, DEMO_CONTEXT, DEMO_IDENTITY (+25 more)

### Community 16 - "Community 16"
Cohesion: 0.09
Nodes (31): supabase, supabaseAdmin, loadTenant(), TENANT_CACHE, AUTH_CACHE, readBearerToken(), requireAuth(), accountCreateSchema (+23 more)

### Community 17 - "Community 17"
Cohesion: 0.10
Nodes (31): SecretEmailButton(), CANCEL_REASONS, DocumentCancelModal(), DocumentDetailModal(), formatCurrency(), formatDate(), TYPE_META, CANCEL_REASONS (+23 more)

### Community 18 - "Community 18"
Cohesion: 0.06
Nodes (14): dotenv, supabase, supabase, supabase, supabase, supabase, supabase, supabase (+6 more)

### Community 19 - "Community 19"
Cohesion: 0.12
Nodes (28): @tanstack/react-query, ConfirmModal(), DEFAULT_UNITS, getDefaultUnitsForWarehouse(), ONLINE_UNITS, AddProductModal(), processProductImage(), EditProductModal() (+20 more)

### Community 20 - "Community 20"
Cohesion: 0.11
Nodes (30): buildGoodsInDocumentHtml(), detectPreferredUnit(), formatDate(), formatDocumentQty(), getCompanyInfo(), getGoodsInGroupedProducts(), GoodsInDetailModal(), LUSIN_UNITS (+22 more)

### Community 21 - "Community 21"
Cohesion: 0.08
Nodes (31): createEmptyGoodsInLine(), generateBatchSerials(), generateRowSerials(), generateSequenceRef(), getTodayIso(), GoodsInView(), getFirstAvailableItem(), handleAddDraftRow() (+23 more)

### Community 22 - "Community 22"
Cohesion: 0.12
Nodes (35): document_items_document_id_idx, document_items_set_updated_at, documents_contact_id_idx, documents_inventory_list_idx, documents_inventory_status_list_idx, documents_owner_id_idx, documents_set_updated_at, documents_type_status_idx (+27 more)

### Community 23 - "Community 23"
Cohesion: 0.10
Nodes (31): buildCalendar(), DAYS_ID, IndoDateInput(), isoToparts(), MONTHS_ID, partsToIso(), calcItemAmount(), DOC_TYPES (+23 more)

### Community 24 - "Community 24"
Cohesion: 0.07
Nodes (34): @supabase/supabase-js@^2.117.3, @supabase/supabase-js, axios, cors, express, helmet, jspdf, morgan (+26 more)

### Community 25 - "Community 25"
Cohesion: 0.16
Nodes (24): getCameraStartError(), hideLibraryViewfinder(), INVENTORY_BARCODE_FORMATS, resolveCameraConstraint(), useCameraScanner(), useClickOutside(), isDigit8(), useDesktopScanShortcut() (+16 more)

### Community 26 - "Community 26"
Cohesion: 0.09
Nodes (16): activity, auditLog, auth, customers, documents, general, goodsIn, goodsOut (+8 more)

### Community 27 - "Community 27"
Cohesion: 0.09
Nodes (16): activity, auditLog, auth, customers, documents, general, goodsIn, goodsOut (+8 more)

### Community 28 - "Community 28"
Cohesion: 0.09
Nodes (22): createEmptyGoodsOutLine(), formatDetailGrandTotal(), formatDocumentGrandTotal(), formatLineTotalKeluar(), GoodsOutView(), handleAddLine(), handleBarcodeSubmit(), handleCloseModal() (+14 more)

### Community 29 - "Community 29"
Cohesion: 0.13
Nodes (27): env, envSchema, parsed, app, server, shutdown(), buildTransporter(), closeTransporter() (+19 more)

### Community 30 - "Community 30"
Cohesion: 0.15
Nodes (21): useApp(), DashboardPage(), InventoryFlowChart(), formatCurrency(), KpiCards(), ensureCtx(), getNotifiedIds(), OverdueBubble() (+13 more)

### Community 31 - "Community 31"
Cohesion: 0.12
Nodes (23): GET(), GET(), buildStylesXml(), buildWorksheetXml(), buildZipArchive(), columnToLetter(), escapeXml(), ExcelColumn (+15 more)

### Community 32 - "Community 32"
Cohesion: 0.13
Nodes (23): calculateInvoiceTotals(), evaluateReopenSourceQty(), InvoiceCalculationInput, InvoiceCalculationResult, InvoiceLineItem, POFulfillmentValidationResult, ReturnReasonCode, validatePOFulfillmentAllocation() (+15 more)

### Community 33 - "Community 33"
Cohesion: 0.18
Nodes (24): formatDocumentQty(), KpiStrip(), formatDate(), MovementLedger(), thirtyDaysAgoIso(), todayIso(), ReportsPage(), buildStockRow() (+16 more)

### Community 34 - "Community 34"
Cohesion: 0.17
Nodes (26): brandLogosHtml(), chunkItems(), chunkWeightedItems(), continuedHeaderHtml(), escapeHtml(), formatDate(), formatDocumentQty(), getGroupedProductItems() (+18 more)

### Community 35 - "Community 35"
Cohesion: 0.15
Nodes (24): on_auth_user_created, public.handle_new_user(), activity_logs_created_at_idx, activity_logs_entity_idx, contacts_set_updated_at, contacts_type_status_idx, document_items_document_id_idx, document_items_set_updated_at (+16 more)

### Community 36 - "Community 36"
Cohesion: 0.11
Nodes (13): CustomerDetailModal(), formatCurrency(), STATUS_CLASS, CustomerFilters(), FILTERS, CustomerFormModal(), handleSubmit(), validate() (+5 more)

### Community 37 - "Community 37"
Cohesion: 0.10
Nodes (11): DocumentsContent(), GoodsInPage(), GoodsOutViewProps, GoodsOutContent(), GoodsOutPage(), metadata, ReportsPage(), ReturnsPage() (+3 more)

### Community 38 - "Community 38"
Cohesion: 0.13
Nodes (12): STATUS_CLASS, SupplierDetailModal(), FILTERS, SupplierFilters(), SupplierFormModal(), handleSubmit(), validate(), STATUS_CLASS (+4 more)

### Community 39 - "Community 39"
Cohesion: 0.13
Nodes (19): eslintConfig, devDependencies, eslint@^9, eslint-config-next@16.4.0, tailwindcss@^4, @tailwindcss/turbopack@^4, @types/node@^20, @types/react@^19 (+11 more)

### Community 40 - "Community 40"
Cohesion: 0.24
Nodes (14): AuthActionResult, signInAction(), signOutAction(), validateSignInInput(), createLocalSession(), destroyLocalSession(), hashPassword(), resolveSecurityContextFromSession() (+6 more)

### Community 41 - "Community 41"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib (+11 more)

### Community 42 - "Community 42"
Cohesion: 0.11
Nodes (14): db, ownerAlphaWhNorthContext, ownerAlphaWhSouthContext, ownerBetaWh1Context, repo, staffAlphaWhNorthContext, db, ownerAlphaWhNorthContext (+6 more)

### Community 43 - "Community 43"
Cohesion: 0.32
Nodes (15): formatDate(), formatDocumentQty(), generateDocumentPdf(), generateGoodsInPdf(), generateGoodsInPdfCompact(), generateGoodsOutPdf(), generateGoodsOutPdfCompact(), generatePOPdf() (+7 more)

### Community 44 - "Community 44"
Cohesion: 0.20
Nodes (12): CANCEL_REASONS, GiCancelModal(), formatDate(), GoodsInList(), addDaysYMD(), formatDateYMD(), formatDisplayDate(), GoodsInPage() (+4 more)

### Community 45 - "Community 45"
Cohesion: 0.15
Nodes (13): EXTRA_ROUTE_TITLES, NAV_ITEMS, NAV_SECTIONS, NavIconName, NavItem, NavSection, contrast(), GLOBALS (+5 more)

### Community 46 - "Community 46"
Cohesion: 0.13
Nodes (11): idx_email_logs_doc, idx_email_logs_retry_pending, idx_email_logs_doc, idx_email_logs_po, idx_purchase_order_items_po, idx_purchase_orders_owner, idx_purchase_orders_sales_person, public.email_logs (+3 more)

### Community 47 - "Community 47"
Cohesion: 0.32
Nodes (8): RFC-5322, validatePasswordResetInput(), ValidationResult, createAdminClient(), createClient(), getSupabasePublicEnv(), getSupabaseServiceRoleKey(), SupabasePublicEnv

### Community 48 - "Community 48"
Cohesion: 0.33
Nodes (11): cleanVendorName(), formatDate(), formatPOStatusLabel(), isPrivileged(), POCreateView(), PODetailView(), POEditView(), POListView() (+3 more)

### Community 49 - "Community 49"
Cohesion: 0.27
Nodes (9): ocrSchema, router, extractJsonFromText(), mapItemsArray(), normalizeOutputJson(), parseInventoryWithNemotron(), performNemotronOCR(), runDualAgentOcrPipeline() (+1 more)

### Community 50 - "Community 50"
Cohesion: 0.18
Nodes (11): jsbarcode, qrcode, dependencies, html5-qrcode@^2.3.8, jsbarcode@^3.12.3, lucide-react@^1.21.0, qrcode@^1.5.4, react@^18.2.0 (+3 more)

### Community 51 - "Community 51"
Cohesion: 0.29
Nodes (9): AppLayout(), AuthenticatedShell(), metadata, AppShellClient(), switchContextAction(), updateSessionContext(), ActiveContextProvider(), switchRole() (+1 more)

### Community 53 - "Community 53"
Cohesion: 0.18
Nodes (3): DatabaseSync, node:sqlite, StatementSync

### Community 54 - "Community 54"
Cohesion: 0.22
Nodes (9): @types/react-dom@^19, @types/react-dom, vite, @vitejs/plugin-react, devDependencies, @types/react@^18.2.0, @types/react-dom@^18.2.0, vite@^8.1.1 (+1 more)

### Community 55 - "Community 55"
Cohesion: 0.22
Nodes (8): app, allowedOrigins, corsOptions, createApp(), router, router, router, router

### Community 56 - "Community 56"
Cohesion: 0.38
Nodes (9): fetchRetryBatch(), getDocumentRowSafe(), getPOByIdForOwnerSafe(), handleRetryEmails(), isMissingColumnError(), persistRetryOutcome(), readBearerToken(), requireCronSecret() (+1 more)

### Community 57 - "Community 57"
Cohesion: 0.20
Nodes (8): db, matchDefaultSerials(), ownerAlphaContext, ownerBetaContext, repo, resetActiveSessions(), salesAlphaContext, staffAlphaContext

### Community 58 - "Community 58"
Cohesion: 0.39
Nodes (7): email_logs, idx_email_logs_po, idx_purchase_order_items_po, idx_purchase_orders_owner, idx_purchase_orders_sales_person, purchase_order_items, purchase_orders

### Community 59 - "Community 59"
Cohesion: 0.25
Nodes (8): contacts_owner_id_idx, contacts_set_updated_at, contacts_type_status_idx, idx_contact_points_contact, idx_contact_points_doc, idx_contact_points_owner, public.contact_points, public.contacts

### Community 60 - "Community 60"
Cohesion: 0.25
Nodes (8): profiles_initialize_tenant_settings, profiles_set_updated_at, public.initialize_tenant_settings(), public.profiles, public.templates, templates_category_status_idx, templates_owner_id_idx, templates_set_updated_at

### Community 61 - "Community 61"
Cohesion: 0.46
Nodes (7): buildLabelHtml(), escapeHtml(), getLabelSize(), LABEL_SIZES, renderCompactLabel(), renderStandardLabel(), serialTextClass()

### Community 62 - "Community 62"
Cohesion: 0.29
Nodes (7): dependencies, next@16.4.0, react@19.3.0, react-dom@19.3.0, react, react-dom, react-dom@^18.2.0

### Community 63 - "Community 63"
Cohesion: 0.29
Nodes (7): scripts, build, dev, lint, start, test, typecheck

### Community 64 - "Community 64"
Cohesion: 0.29
Nodes (6): public.inventory_unit_multiplier(), public.set_workspace_settings_updated_at(), public.warehouse_units, public.workspace_settings, warehouse_units_lookup_idx, workspace_settings_set_updated_at

### Community 65 - "Community 65"
Cohesion: 0.47
Nodes (4): @supabase/ssr@^0.12.7, @supabase/ssr, GET(), createClient()

### Community 66 - "Community 66"
Cohesion: 0.33
Nodes (4): failures, fullPath, required, root

### Community 67 - "Community 67"
Cohesion: 0.53
Nodes (5): on_auth_user_created, profiles_set_updated_at, public.handle_new_user(), public.profiles, public.set_updated_at()

### Community 69 - "Community 69"
Cohesion: 0.33
Nodes (5): buildCommand, cleanUrls, framework, headers, $schema

### Community 70 - "Community 70"
Cohesion: 0.50
Nodes (3): DocumentDetailPage(), DocumentDetailSkeleton(), PageProps

### Community 72 - "Community 72"
Cohesion: 0.83
Nodes (3): idx_notifications_owner, idx_notifications_user, notifications

### Community 73 - "Community 73"
Cohesion: 0.50
Nodes (4): activity_logs_created_at_idx, activity_logs_entity_idx, activity_logs_owner_id_idx, public.activity_logs

### Community 74 - "Community 74"
Cohesion: 0.50
Nodes (3): regions, rewrites, version

### Community 75 - "Community 75"
Cohesion: 0.50
Nodes (4): scripts, build, dev, preview

### Community 76 - "Community 76"
Cohesion: 0.50
Nodes (3): en, id, translations

## Knowledge Gaps
- **1 isolated node(s):** `RFC-5322`
  These have ≤1 connection - possible missing edges. (Counts symbols only; 508 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **19 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `InventoryRepository` connect `Community 4` to `Community 1`, `Community 2`, `Community 3`, `Community 37`, `Community 70`, `Community 71`, `Community 40`, `Community 6`, `Community 10`, `Community 42`, `Community 15`, `Community 80`, `Community 21`, `Community 57`, `Community 28`, `Community 31`?**
  _High betweenness centrality (0.099) - this node is a cross-community bridge._
- **What connects `RFC-5322` to the rest of the system?**
  _1 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.07422852376980818 - nodes in this community are weakly interconnected._
- **Why does `next` connect `Community 2` to `Community 0`, `Community 1`, `Community 65`, `Community 4`, `Community 5`, `Community 70`, `Community 39`, `Community 37`, `Community 40`, `Community 77`, `Community 14`, `Community 15`, `Community 51`, `Community 62`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.06732589943193773 - nodes in this community are weakly interconnected._
- **Why does `ActiveSecurityContext` connect `Community 3` to `Community 2`, `Community 4`, `Community 37`, `Community 5`, `Community 71`, `Community 40`, `Community 6`, `Community 10`, `Community 42`, `Community 15`, `Community 80`, `Community 57`, `Community 31`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.05569620253164557 - nodes in this community are weakly interconnected._