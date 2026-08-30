Static edge-case fixture notes (ADR-0019 §3 / DP-007).

Most of the frozen scenarios are exercised as SYNTHETIC scan/manifest/object inputs by
the vitest suites (scan.test.ts, restore.test.ts, object-store.test.ts, manifest.test.ts,
recovery.test.ts, object-codec.test.ts) because several violating classes cannot exist on
an NTFS checkout: reserved device names (CON, NUL, ...), trailing dots/spaces, hidden
segments, and same-fold path pairs (Å/å) are rejected or merged by the filesystem itself.

Only physically creatable artifacts live in vault/:

- vault/x.exe             → UNSUPPORTED_FILES_FOUND (extension allow-list)
- vault/LICENSE           → UNSUPPORTED_FILES_FOUND (no extension)
- vault/sample.c          → supported; baseline for the allowed classes
- vault/sample.py         → supported; baseline for the allowed classes
- vault/Å.md              → supported single file (the Å/å COLLISION pair is synthetic:
  NTFS folds Å and å into one directory entry, so both files cannot coexist on disk)
- vault/.obsidian/marker  → NOT committed: `.obsidian/` is the excluded configuration tree
  and hidden segments cannot be checked out on Windows; the scan exclusion is exercised by
  scan.test.ts with the placeholder-root validation from Phase 4-B review.

The case oracle is fixtures/edge-cases/case-oracle.json; every scenario id maps to one
frozen stable error code and is exercised by at least one committed test.
