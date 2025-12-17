import { jest } from '@jest/globals';

// Type for mutable context in tests
type MutableContext = Omit<Context, 'payload' | 'repo'> & {
	payload: Context['payload'] & Record<string, unknown>;
	repo: Context['repo'];
};

// In Jest 30 with ESM, directly spying on re-exported ESM bindings of '@actions/core'
// and assigning implementations (jest.spyOn(core, 'debug').mockImplementation(...))
// can throw "Cannot assign to read only property" because the ESM named exports are
// read-only live bindings. We instead mock the entire module before importing the
// system under test using `jest.unstable_mockModule`, then obtain the mocked module
// via dynamic import. This preserves type information and avoids mutation of the
// read-only export objects.

const coreMocks: Record<string, jest.Mock> = {};
const githubMocks: Record<string, jest.Mock> = {};

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

await jest.unstable_mockModule('@actions/github', async () => {
	const original =
		await jest.requireActual<typeof import('@actions/github')>(
			'@actions/github',
		);
	const make = <T extends keyof typeof original>(key: T) => {
		const fn = jest.fn();
		githubMocks[key as string] = fn;
		return fn;
	};
	return {
		...original,
		getOctokit: make('getOctokit'),
		context: {
			payload: {},
			repo: { owner: 'test-owner', repo: 'test-repo' },
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
});

// Dynamically import after mocking so the SUT picks up mocked module.
const main = await import('../src/main');
const github = await import('@actions/github');

type Context = typeof github.context;

// Mock the GitHub Actions core library
// Logs & Annotations.
let infoMock: jest.Mock;
let errorMock: jest.Mock;
let warningMock: jest.Mock;
let noticeMock: jest.Mock;
// Inputs
let testInputs: Record<string, string | string[]>;
// Outputs
let setFailedMock: jest.Mock;
let setOutputMock: jest.Mock;
// GitHub API
let mockOctokit: {
	rest: {
		issues: {
			createComment: jest.Mock;
		};
	};
};

describe('action', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		// Reset GitHub context
		(github.context as MutableContext).payload = {};
		(github.context as MutableContext).repo = {
			owner: 'test-owner',
			repo: 'test-repo',
		};
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
		// GitHub API
		mockOctokit = {
			rest: {
				issues: {
					createComment: jest.fn(),
				},
			},
		};
		githubMocks.getOctokit.mockReturnValue(mockOctokit);
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

	it('should respect per-type annotation limits', async () => {
		testInputs.reports = ['junit|fixtures/junit-generic.xml'];
		await main.run();
		expect(setOutputMock).toHaveBeenCalledWith('errors', 2);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 0);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 1);
		expect(setOutputMock).toHaveBeenCalledWith('total', 3);
	});

	it('should show annotations up to per-type limits', async () => {
		// This test uses junit-eslint fixture which has both errors and warnings
		testInputs.reports = ['junit-eslint|fixtures/junit-eslint.xml'];
		await main.run();

		// Should show the error
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

		// Warning should also be called since we allow 10 of each type
		expect(warningMock).toHaveBeenCalledWith(
			'Missing JSDoc comment.',
			expect.any(Object),
		);

		expect(setOutputMock).toHaveBeenCalledWith('errors', 1);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 1);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 0);
		expect(setOutputMock).toHaveBeenCalledWith('total', 2);
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

	it('should handle unsupported matcher format', async () => {
		testInputs.reports = ['unsupported|fixtures/junit-generic.xml'];
		testInputs['custom-matchers'] = `{
			"unsupported": {
				"format": "json",
				"item": "//testcase",
				"message": "text()",
				"file": "@file"
			}
		}`;
		await expect(main.run()).rejects.toThrow(
			'Unsupported matcher format in unsupported: json',
		);
	});

	it('should handle reports with no items', async () => {
		testInputs.reports = ['junit|fixtures/empty-report.xml'];
		await main.run();
		expect(errorMock).not.toHaveBeenCalled();
		expect(setOutputMock).toHaveBeenCalledWith('errors', 0);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 0);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 0);
		expect(setOutputMock).toHaveBeenCalledWith('total', 0);
	});

	it('should handle yaml config file', async () => {
		testInputs.configPath = 'fixtures/test-config.yml';
		testInputs.reports = []; // Will use yaml config
		await main.run();
		expect(infoMock).toHaveBeenCalledWith(
			'Using config file at fixtures/test-config.yml',
		);
	});

	it('should handle skipped annotations', async () => {
		testInputs.reports = ['junit|fixtures/junit-many-errors.xml'];
		testInputs['max-annotations'] = '2'; // Force skipping
		await main.run();
		expect(warningMock).toHaveBeenCalledWith(
			'Maximum number of annotations per type reached (2). 1 annotations were not shown.',
		);
		expect(setOutputMock).toHaveBeenCalledWith('errors', 2);
		expect(setOutputMock).toHaveBeenCalledWith('warnings', 0);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 0);
		expect(setOutputMock).toHaveBeenCalledWith('total', 2);
	});

	it('should skip PR comment when not on a pull request', async () => {
		// Mock GitHub context to not be on a PR
		(github.context as MutableContext).payload = {};
		testInputs.reports = ['junit|fixtures/junit-many-errors.xml'];
		testInputs['max-annotations'] = '2';
		await main.run();
		expect(infoMock).toHaveBeenCalledWith(
			'Not running on a pull request, skipping comment creation.',
		);
		expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
	});

	it('should create PR comment when annotations are skipped', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123 },
		};
		testInputs.reports = ['junit|fixtures/junit-many-errors.xml'];
		testInputs['max-annotations'] = '2';
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(mockOctokit.rest.issues.createComment as any).mockResolvedValue({});
		await main.run();
		expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
			owner: 'test-owner',
			repo: 'test-repo',
			issue_number: 123,
			body: expect.stringContaining('## Skipped Annotations'),
		});
		expect(infoMock).toHaveBeenCalledWith(
			'Created PR comment with skipped annotations.',
		);
	});

	it('should handle PR comment API failure', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123 },
		};
		testInputs.reports = ['junit|fixtures/junit-many-errors.xml'];
		testInputs['max-annotations'] = '2';
		const apiError = new Error('API Error');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(mockOctokit.rest.issues.createComment as any).mockRejectedValue(apiError);
		await main.run();
		expect(errorMock).toHaveBeenCalledWith(
			`Failed to create PR comment: ${apiError}`,
		);
	});
});
