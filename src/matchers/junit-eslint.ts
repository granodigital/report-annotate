import { type ReportMatcher } from '../main';

/**
 * @see example ./fixtures/junit-eslint.xml
 */
export const junitEslintMatcher = {
	format: 'xml',
	item: '//testcase',
	level: {
		warning: 'contains(failure/text(), "Warning - ")',
	},
	message: 'failure/@message',
	title: `replace(@name, 'org\\.eslint\\.', '')`,
	file: 'parent::testsuite/@name',
	startLine: `match(failure, 'line (\\d+)')`,
	startColumn: `match(failure, 'col (\\d+)')`,
} satisfies ReportMatcher;
