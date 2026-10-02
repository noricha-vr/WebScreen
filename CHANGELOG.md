# Changelog

Changes are recorded in the Keep a Changelog format.

## 2026-10-02

### Fixed

- Purge cached videos after storage cleanup even when a later database operation fails.
- Purge cached upload copies when upload finalization rejects them and storage cleanup succeeds.

### Security

- Update the PDF renderer, Astro, and their supporting dependencies to patched versions.
