# Partner catalog private UI QA

This local-only harness imports the actual public catalog and management components. All fixture APIs and illustrations live under this tools directory. The application does not import this directory. Bind only to 127.0.0.1; do not deploy the harness.

Run `node next-preview.mjs dev --port 3127` with the existing preview dependencies available. Visit `/share/inventory/demo`, `/share/inventory/empty`, `/share/inventory/expired`, `/share/inventory/error`, and `/manage`. The header clearly marks fixture data as private QA. In management, the label `error` simulates a failed create. This harness does not prove authentication, storage, or staging behavior.

Check widths 320, 390, 1280, full product names, stage counts, SKU/name search and reset, no-photo fallback, gallery arrow/Escape/close/focus restoration/swipe, refresh, load failure/retry, expired access, create/copy/preview, confirmed renewal and confirmed disable. Browser QA is conducted with the computer-use tool.

Selection QA starts with one existing link and no selected products. Use `/manage` to select/save/reload, then `/share/inventory/selecteddemo` to verify the corresponding selected-only list. The private controls can fail the next save or simulate a competing revision; check that unsaved selections remain and no silent overwrite happens. Fixtures are in memory and are reset on server restart. These scenarios never write production catalog or inventory data.
