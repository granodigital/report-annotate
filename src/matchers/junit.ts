import { type ReportMatcher } from 'src/main';

/**
 * Generic matcher for reports in JUnit format.
 * @see example ./fixtures/junit.xml
 */
export const junitMatcher = {
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
				normalize(concat(failure/@message, " \n ", failure/text()))
			)
		)`,
	title: 'concat(@classname, " - ", @name)',
	file: '@file',
	startLine: '@line',
} satisfies ReportMatcher;
