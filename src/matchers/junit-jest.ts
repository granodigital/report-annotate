import { type ReportMatcher } from 'src/main';

/**
 * Generic matcher for Jest reports in JUnit format.
 * @see example ./fixtures/junit-jest.xml
 */
export const junitJestMatcher = {
	format: 'xml',
	item: '//testcase',
	level: {
		// Ignore testcase elements that are successful.
		ignore: 'not(failure) and not(skipped) and not(error)',
		notice: 'skipped',
	},
	// Select message based on the result type.
	message: `
		if(error, normalize(concat(error/@message, " \n ", error/text())),
			if(skipped, skipped/@message,
				normalize(failure/text())
			)
		)`,
	title: '@name',
	file: '@file',
	// Stack trace usually contains line and column: xxx.spec.yy:line:column
	startLine: `match(failure, '.*.spec.\\w{2,3}:(\\d+):.*')`,
	startColumn: `match(failure, '.*.spec.\\w{2,3}:\\d+:(\\d+).*')`,
} satisfies ReportMatcher;
