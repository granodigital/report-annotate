# Report Annotate

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
      max-annotations: 20 # Keep the clutter down.
      ignore: node_modules/**,dist/** # Ignore patterns for the report search (default).

   - name: Annotations created
      if: always()
      run: |
         echo "Total: ${{ steps.annotate.outputs.total }}"
         echo "Errors: ${{ steps.annotate.outputs.errors }}"
         echo "Warnings: ${{ steps.annotate.outputs.warnings }}"
         echo "Notices: ${{ steps.annotate.outputs.notices }}"
```

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

1. Format, test, and build the action

   ```bash
   npm run all
   ```

> [!WARNING]
>
> This step is important! It will run [`ncc`](https://github.com/vercel/ncc) to
> build the final JavaScript action code with all dependencies included. If you
> do not run this step, your action will not work correctly when it is used in a
> workflow. This step also includes the `--license` option for `ncc`, which will
> create a license file for all of the production node modules used in your
> project.

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
   recent release tag by looking at the local data available in your repository.
1. **Prompting for a new release tag:** The user is then prompted to enter a new
   release tag. To assist with this, the script displays the latest release tag
   and provides a regular expression to validate the format of the new tag.
1. **Tagging the new release:** Once a valid new tag is entered, the script tags
   the new release.
1. **Pushing the new tag to the remote:** Finally, the script pushes the new tag
   to the remote repository. From here, you will need to create a new release in
   GitHub and users can easily reference the new tag in their workflows.
