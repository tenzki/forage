## Purpose

Let users adjust how Forage and their outline look without changing document content or sharing device-specific presentation settings.

## ADDED Requirements

### Requirement: Persistent appearance preferences
General SHALL provide System, Light, and Dark theme choices, an outline font selector, and a bounded outline font-size selector. Valid changes SHALL apply immediately and persist automatically on the device across restarts, independently of workspace execution mode. Missing or invalid stored values SHALL use compatible defaults without changing outline content or agent configuration.

#### Scenario: Change outline typography
- **WHEN** a user selects a different supported font or font size
- **THEN** the outline and settings preview update together
- **AND** no document event, undo entry, or portable agent change is generated

#### Scenario: Follow the system theme
- **WHEN** System is selected and the operating system appearance changes
- **THEN** Forage updates its theme without requiring a restart
- **AND** explicit Light or Dark selection remains independent of system changes

#### Scenario: Reopen with saved preferences
- **WHEN** the app restarts or changes between local and server mode
- **THEN** valid device-local preferences remain applied
- **AND** unsupported stored values fall back without preventing Settings from opening

### Requirement: Representative preview and motion preference
General SHALL display a non-editable nested-outline preview reflecting the chosen typography and theme. It SHALL expose the system-motion preference shown in the design and honor reduced motion when that preference is enabled and the operating system requests it.

#### Scenario: Preview preferences without editing notes
- **WHEN** a user adjusts appearance with an outline already open
- **THEN** the preview changes without modifying, submitting, or selecting document content

#### Scenario: Reduced motion requested
- **WHEN** system-motion following is enabled and the system requests reduced motion
- **THEN** nonessential animated transitions are reduced without removing status or focus feedback

### Requirement: Actual application version
General SHALL display the running application's version from application metadata rather than a hard-coded mockup value.

#### Scenario: Install a newer build
- **WHEN** a user opens General after upgrading
- **THEN** the displayed version identifies the running build
