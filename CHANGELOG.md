<!-- markdownlint-disable MD024 -->

# Changelog

## [3.1.3] - 2026-01-14

### Fixed

- Fixed PR file links to use proper diff anchors instead of file path URLs,
  keeping users in PR context navigation

## [3.1.2] - 2026-01-14

### Fixed

- Changed error Markdown panel from `[!ERROR]` to `[!CAUTION]` as ERROR is not a
  supported GitHub alert type
- Fixed duplicate `@mention` escaping in PR comments if already escaped
- Fixed file being relative to runner root instead of repository root in PR
  comments
- Fixed PR comments to be minimized when the latest run has no skipped
  annotations, ensuring old comments are cleared when they're no longer relevant

### Improved

- Truncate long file paths in PR comments for better readability

## [3.1.1] - 2025-12-30

### Fixed

- Fixed PR comments to escape words starting with @ to prevent GitHub user
  mention triggers for decorators

## [3.1.0] - 2025-12-30

### Added

- Added PR comment minimization functionality to hide previous bot comments
  before creating new ones
- Added comprehensive GraphQL support for PR comment management with pagination
- Enhanced release script to automatically create GitHub releases with
  auto-generated notes
- Added repository detection from Git remote URL in release script

### Fixed

- Fixed linting errors by allowing 'any' types in test files
- Added comprehensive test coverage for edge cases including pagination failures
  and API errors
- Improved error handling in PR comment operations

## [3.0.1] - 2025-12-30

### Fixed

- Improved PR comment formatting with clickable file links when annotations are
  skipped
- Added validation for invalid report format configuration
- Added error handling for malformed YAML config files
- Added error handling for invalid custom-matchers JSON input
- Skip annotations with empty messages to avoid creating blank annotations
- Improved error messages and handling in XML report parsing
- Ensure all annotations have a start line for proper GitHub display
- Added test coverage for invalid YAML config parsing error handling
- Excluded untestable xpath fallback code from coverage reporting

## [3.0.0] - 2025-12-17

### Breaking Changes

- Changed `max-annotations` to apply per annotation type (error/warning/notice)
  instead of globally. Default reduced from 50 to 10.
- Added new `token` input for GitHub API access (required for PR comments).
- Support for creating PR comments when annotations are skipped due to limits.

## [2.0.0]

- Prioritize error annotations over warnings and notices when limits are
  reached.

## [1.0.0]

### Added

- Initial release of the report annotation action.
