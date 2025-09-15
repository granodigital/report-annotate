# Report Annotate

[![GitHub Super-Linter](https://github.com/actions/typescript-action/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/actions/typescript-action/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/actions/typescript-action/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/codeql-analysis.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

Easily add annotations to your GitHub pull requests based on reports from your
tests, linters, etc.

## Usage Example

```yml
steps:
  - name: Checkout
    id: checkout
    uses: actions/checkout@v4

  - name: Run Tests & Lint etc.
    run: npm install && npm run test:lint:etc

  - name: Report Annotate
    id: annotate
    if: always() # Run with test/lint failures.
    uses: granodigital/report-annotate@v1
    with:
      reports: |
        junit|reports/junit-generic.xml
        junit-eslint|reports/*-eslint.xml
        junit-jest|reports/junit-jest.xml
      max-annotations: 20 # Keep the clutter down (50 is max by GitHub)
      ignore: node_modules/**,dist/** # Ignore patterns for the report search (default).

   - name: Annotations created
      if: always()
      run: |
         echo "Total: ${{ steps.annotate.outputs.total }}"
         echo "Errors: ${{ steps.annotate.outputs.errors }}"
         echo "Warnings: ${{ steps.annotate.outputs.warnings }}"
         echo "Notices: ${{ steps.annotate.outputs.notices }}"
```

> [!NOTE]
>
> You'll need to have a reasonably modern version of
> [Node.js](https://nodejs.org) handy (20.x or later should work!). If you are
> using a version manager like [`nodenv`](https://github.com/nodenv/nodenv) or
> [`fnm`](https://github.com/Schniz/fnm), this template has a `.node-version`
> file at the root of the repository that can be used to automatically switch to
> the correct version when you `cd` into the repository. Additionally, this
> `.node-version` file is used by GitHub Actions in any `actions/setup-node`
> actions.

## Custom Matchers

You can define custom matchers to parse your reports and create annotations.
Currently only XML reports are supported using XPath selectors.

Feel free to open a PR to add support for new report formats or matchers.

[See matchers folder for examples](./src/matchers).

```yml
---
- name: Report Annotate
  id: annotate
  if: always() # Run with test/lint failures.
  uses: granodigital/report-annotate@v1
  with:
    reports: my-matcher|reports/*.xml
    custom-matchers: |
      {
       "my-matcher": {
          "format": "xml",
          "item": "//testCase",
          "title": "oopsie-daisy/@message",
          "message": "oopsie-daisy/text()",
          "file": "parent::testFile/@filePath",
          "startLine": "oopsie-daisy/@line"
        }
      }
```

## Development

1. Install the dependencies

   ```bash
   npm install
   ```

1. :building_construction: Package the TypeScript for distribution

   ```bash
   npm run bundle
   ```

1. :white_check_mark: Run the tests

   ```bash
   $ npm test

   PASS  ./index.test.js
     ✓ throws invalid number (3ms)
     ✓ wait 500 ms (504ms)
     ✓ test runs (95ms)

   ...
   ```

## Update the Action Metadata

The [`action.yml`](action.yml) file defines metadata about your action, such as
input(s) and output(s). For details about this file, see
[Metadata syntax for GitHub Actions](https://docs.github.com/en/actions/creating-actions/metadata-syntax-for-github-actions).

When you copy this repository, update `action.yml` with the name, description,
inputs, and outputs for your action.

## Update the Action Code

The [`src/`](./src/) directory is the heart of your action! This contains the
source code that will be run when your action is invoked. You can replace the
contents of this directory with your own code.

There are a few things to keep in mind when writing your action code:

1. Create a new branch

   ```bash
   git checkout -b releases/v1
   ```

1. Replace the contents of `src/` with your action code
1. Add tests to `__tests__/` for your source code
1. Format, test, and build the action

   ```bash
   npm run all
   ```

For information about versioning your action, see
[Versioning](https://github.com/actions/toolkit/blob/master/docs/action-versioning.md)
in the GitHub Actions toolkit.

## Publishing a New Release

This project includes a helper script, [`script/release`](./script/release)
designed to streamline the process of tagging and pushing new releases for
GitHub Actions.

GitHub Actions allows users to select a specific version of the action to use,
based on release tags. This script simplifies this process by performing the
following steps:

1. **Retrieving the latest release tag:** The script starts by fetching the most
   recent SemVer release tag of the current branch, by looking at the local data
   available in your repository.
1. **Prompting for a new release tag:** The user is then prompted to enter a new
   release tag. To assist with this, the script displays the tag retrieved in
   the previous step, and validates the format of the inputted tag (vX.X.X). The
   user is also reminded to update the version field in package.json.
1. **Tagging the new release:** The script then tags a new release and syncs the
   separate major tag (e.g. v1, v2) with the new release tag (e.g. v1.0.0,
   v2.1.2). When the user is creating a new major release, the script
   auto-detects this and creates a `releases/v#` branch for the previous major
   version.
1. **Pushing changes to remote:** Finally, the script pushes the necessary
   commits, tags and branches to the remote repository. From here, you will need
   to create a new release in GitHub so users can easily reference the new tags
   in their workflows.
