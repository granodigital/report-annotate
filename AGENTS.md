# Project Guidelines

## Overview

This is **Report Annotate**, a GitHub Action (TypeScript) that adds annotations
to pull requests based on test/lint reports (JUnit XML, etc.). It parses XML
reports using XPath-based matchers and creates GitHub annotations.

## Architecture

- `src/` — TypeScript source: action entry point, config parsing, XML report
  matching, and annotation creation via `@actions/core`
- `src/matchers/` — Report format matchers (JUnit, ESLint, Jest) using XPath
  selectors against `ReportMatcher` interface
- `dist/` — **Generated** JavaScript bundle. Never edit directly; always
  regenerate with `npm run bundle`
- `__tests__/` — Jest unit tests
- `fixtures/` — Test fixture files (XML reports, YAML configs)

## Build and Test

```bash
npm install          # Install dependencies
npm run test         # Run Jest tests (requires Node >=24)
npm run bundle       # Format + bundle TypeScript → dist/
npm run all          # Format, lint, test, bundle, and generate coverage badge
```

After any change to `src/`, run `npm run bundle` to keep `dist/` in sync — CI
checks this.

## Conventions

- Use `@actions/core` for logging, never `console`
- Matchers implement the `ReportMatcher` interface from `src/main.ts`
- Fixtures go in `fixtures/`, tests in `__tests__/`
- Follow Semantic Versioning for `package.json` version
- Do not review or manually edit files in `dist/`
- JSDoc for functions and complex logic; skip obvious "what" comments — explain
  "why"
