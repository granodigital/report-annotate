<!-- markdownlint-disable MD024 -->

# Changelog

## [3.0.1] - 2025-12-30

### Fixed

- Improved PR comment formatting with clickable file links when annotations are skipped
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
