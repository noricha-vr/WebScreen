# Changelog

Changes are recorded in the Keep a Changelog format.

## 2026-10-06

### Changed

- Introduce Choicast (VRChat screen sharing) as a full section on the top page and in the related links of every use-case page.
- Point Choicast links and the legacy screen-sharing redirects at `choicast.com` directly, removing an extra redirect hop.

## 2026-10-02

### Fixed

- Purge cached videos after storage cleanup even when a later database operation fails.
- Purge cached upload copies when upload finalization rejects them and storage cleanup succeeds.

### Security

- Update the PDF renderer, Astro, and their supporting dependencies to patched versions.
