import * as core from '@actions/core';
import * as main from '../src/main';

// Mock the GitHub Actions core library
// Logs & Annotations.
let infoMock: jest.SpyInstance;
let errorMock: jest.SpyInstance;
let warningMock: jest.SpyInstance;
let noticeMock: jest.SpyInstance;
// Inputs
let testInputs: Record<string, string | string[]>;
// Outputs
let setFailedMock: jest.SpyInstance;
let setOutputMock: jest.SpyInstance;

describe('action', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		// Logs & Annotations
		const logMock = jest.fn();
		// Uncomment to see action logs.
		// .mockImplementation(msg => process.stdout.write(`${msg}\n`));
		jest.spyOn(core, 'debug').mockImplementation(logMock);
		infoMock = jest.spyOn(core, 'info').mockImplementation(logMock);
		errorMock = jest.spyOn(core, 'error').mockImplementation(logMock);
		warningMock = jest.spyOn(core, 'warning').mockImplementation(logMock);
		noticeMock = jest.spyOn(core, 'notice').mockImplementation(logMock);
		jest.spyOn(core, 'startGroup').mockImplementation(logMock);
		jest.spyOn(core, 'endGroup').mockImplementation(logMock);
		// Inputs
		testInputs = {
			reports: ['junit-eslint|fixtures/junit-eslint.xml'],
		};
		const inputMock = jest
			.fn()
			.mockImplementation((name: keyof typeof testInputs) => testInputs[name]);
		jest.spyOn(core, 'getInput').mockImplementation(inputMock);
		jest.spyOn(core, 'getMultilineInput').mockImplementation(inputMock);
		// Outputs
		setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation();
		setOutputMock = jest.spyOn(core, 'setOutput').mockImplementation();
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
		testInputs.customMatchers = `{"custom-matcher": {
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
		testInputs.customMatchers = `{"custom-matcher": {
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
		testInputs.maxAnnotations = '1';
		await main.run();
		expect(warningMock).toHaveBeenCalledWith(
			'Maximum number of annotations reached (1)',
		);
		expect(setOutputMock).toHaveBeenCalledWith('errors', 0);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 0);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 1);
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
		expect(noticeMock).not.toHaveBeenCalledWith();
		expect(setOutputMock).toHaveBeenCalledWith('errors', 2);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 0);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 0);
		expect(setOutputMock).toHaveBeenCalledWith('total', 2);
	});
});
