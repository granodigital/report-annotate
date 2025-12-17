<!-- markdownlint-disable MD024 -->

# Changelog

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
