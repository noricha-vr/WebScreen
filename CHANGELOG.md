# Changelog

Changes are recorded in the Keep a Changelog format.

## 2026-10-07

### Removed

- Remove the previous FastAPI implementation (Python app, Dockerfile, Cloud Build config) from the repository. The site has been served by the Cloudflare Workers version in `web/` since 2026-08; nothing in `web/` depended on it.
- Remove the "WebScreen has been rebuilt" announcement from the top of the home page in every language.

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
