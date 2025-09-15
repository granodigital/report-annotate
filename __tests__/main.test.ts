import { jest } from '@jest/globals';

// In Jest 30 with ESM, directly spying on re-exported ESM bindings of '@actions/core'
// and assigning implementations (jest.spyOn(core, 'debug').mockImplementation(...))
// can throw "Cannot assign to read only property" because the ESM named exports are
// read-only live bindings. We instead mock the entire module before importing the
// system under test using `jest.unstable_mockModule`, then obtain the mocked module
// via dynamic import. This preserves type information and avoids mutation of the
// read-only export objects.

const coreMocks: Record<string, jest.Mock> = {};

await jest.unstable_mockModule('@actions/core', async () => {
	const original =
		await jest.requireActual<typeof import('@actions/core')>('@actions/core');
	const make = <T extends keyof typeof original>(key: T) => {
		const fn = jest.fn();
		coreMocks[key as string] = fn;
		return fn;
	};
	return {
		...original,
		debug: make('debug'),
		info: make('info'),
		error: make('error'),
		warning: make('warning'),
		notice: make('notice'),
		startGroup: make('startGroup'),
		endGroup: make('endGroup'),
		getInput: make('getInput'),
		getMultilineInput: make('getMultilineInput'),
		setFailed: make('setFailed'),
		setOutput: make('setOutput'),
	} as typeof import('@actions/core');
});

// Dynamically import after mocking so the SUT picks up mocked module.
const main = await import('../src/main');

// Mock the GitHub Actions core library
// Logs & Annotations.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let infoMock: jest.Mock;
let errorMock: jest.Mock;
let warningMock: jest.Mock;
let noticeMock: jest.Mock;
// Inputs
let testInputs: Record<string, string | string[]>;
// Outputs
let setFailedMock: jest.Mock;
let setOutputMock: jest.Mock;

describe('action', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		// Simple logging mock (can redirect to stdout for debugging if desired)
		const logMock = jest.fn();
		coreMocks.debug.mockImplementation(logMock);
		infoMock = coreMocks.info.mockImplementation(logMock);
		errorMock = coreMocks.error.mockImplementation(logMock);
		warningMock = coreMocks.warning.mockImplementation(logMock);
		noticeMock = coreMocks.notice.mockImplementation(logMock);
		coreMocks.startGroup.mockImplementation(logMock);
		coreMocks.endGroup.mockImplementation(logMock);
		// Inputs
		testInputs = {
			reports: ['junit-eslint|fixtures/junit-eslint.xml'],
		};
		const inputValue = (name: string) =>
			testInputs[name as keyof typeof testInputs];
		const getInputMock = jest.fn((...args: unknown[]) => {
			const name = String(args[0]);
			const value = inputValue(name);
			// For getInput always coerce arrays to first element
			return Array.isArray(value) ? value[0] : (value as string);
		});
		const getMultilineInputMock = jest.fn((...args: unknown[]) => {
			const name = String(args[0]);
			const value = inputValue(name);
			if (value == null) return [];
			return (Array.isArray(value) ? value : [value])
				.filter(v => v != null)
				.map(v => String(v));
		});
		coreMocks.getInput.mockImplementation(
			getInputMock as unknown as (...args: unknown[]) => unknown,
		);
		coreMocks.getMultilineInput.mockImplementation(
			getMultilineInputMock as unknown as (...args: unknown[]) => unknown,
		);
		// Outputs
		setFailedMock = coreMocks.setFailed;
		setOutputMock = coreMocks.setOutput;
	});

	it('should parse report correctly', async () => {
		await main.run();
		expect(errorMock).toHaveBeenCalledWith(
			'["Bucket"] is better written in dot notation.',
			{
				endColumn: undefined,
				endLine: undefined,
				file: '/home/runner/work/repo-name/repo-name/cypress/plugins/s3-email-client/s3-utils.ts',
				startColumn: 28,
				startLine: 7,
				title: '@typescript-eslint/dot-notation',
			},
		);
		expect(warningMock).toHaveBeenCalledWith('Missing JSDoc comment.', {
			endColumn: undefined,
			endLine: undefined,
			file: '/home/runner/work/repo-name/repo-name/cypress/plugins/s3-email-client/s3-utils.ts',
			startColumn: 18,
			startLine: 2,
			title: 'jsdoc/require-jsdoc',
		});
		expect(setOutputMock).toHaveBeenCalledWith('errors', 1);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 1);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 0);
		expect(setOutputMock).toHaveBeenCalledWith('total', 2);
	});

	it('should log a warning if no reports are found', async () => {
		testInputs.reports = ['junit-eslint|fixtures/does-not-exist.xml'];
		await main.run();
		expect(warningMock).toHaveBeenCalledWith(
			'No reports found for junit-eslint using patterns fixtures/does-not-exist.xml',
		);
		expect(errorMock).not.toHaveBeenCalled();
		expect(setOutputMock).toHaveBeenCalledWith('errors', 0);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 0);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 0);
		expect(setOutputMock).toHaveBeenCalledWith('total', 0);
	});

	it('should support custom matchers', async () => {
		testInputs['custom-matchers'] = `{"custom-matcher": {
			"format": "xml",
			"item": "//testCase",
			"title": "oopsie-daisy/@message",
			"message": "oopsie-daisy/text()",
			"file": "parent::testFile/@filePath",
			"startLine": "oopsie-daisy/@line"
		}}`;
		testInputs.reports = ['custom-matcher|fixtures/custom-format.xml'];
		await main.run();
		expect(errorMock).toHaveBeenCalledWith(
			expect.stringContaining(
				`at Object.<anonymous> (/home/runner/work/repo-name/repo-name/main.ts:77:11)`,
			),
			{
				endColumn: undefined,
				endLine: undefined,
				file: '',
				startColumn: undefined,
				startLine: 77,
				title: 'Your test sucks',
			},
		);
		expect(setOutputMock).toHaveBeenCalledWith('errors', 1);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 0);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 0);
		expect(setOutputMock).toHaveBeenCalledWith('total', 1);
	});

	it('should report expression errors', async () => {
		testInputs['custom-matchers'] = `{"custom-matcher": {
			"format": "xml",
			"item": "//testCase",
			"message": "oopsie€daisy/#message"
		}}`;
		testInputs.reports = ['custom-matcher|fixtures/custom-format.xml'];
		await expect(main.run()).rejects.toThrow(
			'Error parsing xpath expression "oopsie€daisy/#message": Unexpected character €',
		);
		expect(setFailedMock).toHaveBeenCalledWith(
			new Error(
				'Error parsing xpath expression "oopsie€daisy/#message": Unexpected character €',
			),
		);
	});

	it('should support generic junit files', async () => {
		testInputs.reports = ['junit|fixtures/junit-generic.xml'];
		await main.run();
		expect(errorMock).toHaveBeenCalledWith(
			`Expected value did not match.
Error:
at Tests.Registration.testCase5(Registration.java:206)
at Tests.Registration.main(Registration.java:202)`,
			{
				title: 'Tests.Registration - testCase5',
				file: 'tests/registration.code',
				startLine: 202,
				endLine: undefined,
				startColumn: undefined,
				endColumn: undefined,
			},
		);
		expect(errorMock).toHaveBeenCalledWith('Division by zero.', {
			endColumn: undefined,
			endLine: undefined,
			file: 'tests/registration.code',
			startColumn: undefined,
			startLine: 235,
			title: 'Tests.Registration - testCase6',
		});
		expect(warningMock).not.toHaveBeenCalled();
		expect(noticeMock).toHaveBeenCalledWith('Test was skipped.', {
			endColumn: undefined,
			endLine: undefined,
			file: 'tests/registration.code',
			startColumn: undefined,
			startLine: 164,
			title: 'Tests.Registration - testCase4',
		});
		expect(setOutputMock).toHaveBeenCalledWith('errors', 2);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 0);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 1);
		expect(setOutputMock).toHaveBeenCalledWith('total', 3);
	});

	it('should respect maxAnnotations', async () => {
		testInputs.reports = ['junit|fixtures/junit-generic.xml'];
		testInputs['max-annotations'] = '1';
		await main.run();
		expect(warningMock).toHaveBeenCalledWith(
			'Maximum number of annotations reached (1). 2 annotations were not shown.',
		);
		expect(setOutputMock).toHaveBeenCalledWith('errors', 1);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 0);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 0);
		expect(setOutputMock).toHaveBeenCalledWith('total', 1);
	});

	it('should prioritize errors over warnings and notices when maxAnnotations is reached', async () => {
		// This test uses junit-eslint fixture which has both errors and warnings
		testInputs.reports = ['junit-eslint|fixtures/junit-eslint.xml'];
		testInputs['max-annotations'] = '1';
		await main.run();

		// Should show the error first, not the warning
		expect(errorMock).toHaveBeenCalledWith(
			'["Bucket"] is better written in dot notation.',
			{
				endColumn: undefined,
				endLine: undefined,
				file: '/home/runner/work/repo-name/repo-name/cypress/plugins/s3-email-client/s3-utils.ts',
				startColumn: 28,
				startLine: 7,
				title: '@typescript-eslint/dot-notation',
			},
		);

		// Warning should not be called since we only allow 1 annotation and error has priority
		expect(warningMock).not.toHaveBeenCalledWith(
			'Missing JSDoc comment.',
			expect.any(Object),
		);

		expect(setOutputMock).toHaveBeenCalledWith('errors', 1);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 0);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 0);
		expect(setOutputMock).toHaveBeenCalledWith('total', 1);
	});

	it('should support jest junit files', async () => {
		testInputs.reports = ['junit-jest|fixtures/junit-jest.xml'];
		await main.run();
		expect(errorMock).toHaveBeenCalledWith(
			expect.stringContaining(
				'Error: expect(received).toEqual(expected) // deep equality',
			),
			{
				endColumn: undefined,
				endLine: undefined,
				file: 'next-gen/src/modules/paytrail/paytrail.service.spec.ts',
				startColumn: 29,
				startLine: 152,
				title:
					'PaytrailService createPayment should return a successful payment if the order is free',
			},
		);
		expect(warningMock).not.toHaveBeenCalled();
		expect(noticeMock).not.toHaveBeenCalled();
		expect(setOutputMock).toHaveBeenCalledWith('errors', 2);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 0);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 0);
		expect(setOutputMock).toHaveBeenCalledWith('total', 2);
	});
});
