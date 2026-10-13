# Changelog

## Version 1.0.1 — 2026-10-13

### Added
- Regression coverage for unlinked started encounters, mode switching, and recovery of pending persistent deck state.

### Changed
- A sole eligible encounter deck migrates automatically when Cross-Encounter is enabled; multiple eligible decks still require a GM choice.
- Cross-Encounter setting changes stage the previous mode until conversion completes, then publish the new mode.

### Fixed
- Ace HUD recognizes the current started unlinked encounter without requiring manual Scene linking.
- Previously interrupted persistent-deck migrations can recover on launch instead of remaining blocked by the retired migration interface.

### Known Issues
- None documented.

### Migration Notes
- No schema migration is required from 1.0.0. Existing Actor deck and custom art data are retained.
- Existing pending persistent migrations with one saved encounter deck recover automatically. Multiple saved encounter decks require a GM choice; cancellation preserves the original data.

## Version 1.0.0 — 2026-10-13

### Added
- Initial release of **Ace of Cards** for Foundry Virtual Tabletop V13 with ProjectFU integration.

### Changed
- Configured public GitHub release, manifest, and package download links for the first 1.0.0 publication.

### Fixed
- None — initial release.

### Known Issues
- Live multi-client Foundry V13 GM/player acceptance testing has not been independently performed as part of this packaging pass.
- Foundry V14 compatibility has not been verified.

### Migration Notes
- Updating from 0.1.0-alpha.119 requires no data or schema migration; saved decks, artwork, and user style selections are preserved.
- Prior installations using the separate `ace-of-cards-class-fu` module ID are not automatically migrated.
