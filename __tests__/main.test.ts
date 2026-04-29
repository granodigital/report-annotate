import { jest } from '@jest/globals';
import { PendingAnnotation } from '../src/main';

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
		getBooleanInput: make('getBooleanInput'),
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
			createComment: jest.Mock<any>;
			listComments: jest.Mock<any>;
			updateComment: jest.Mock<any>;
		};
		pulls: {
			listFiles: jest.Mock<any>;
		};
	};
	graphql: jest.Mock<any>;
};

describe('action', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		// Mock GITHUB_WORKSPACE to match fixture paths
		process.env.GITHUB_WORKSPACE = '/home/runner/work/repo-name/repo-name';
		// Reset GitHub context
		(github.context as MutableContext).payload = {};
		(github.context as MutableContext).repo = {
			owner: 'test-owner',
			repo: 'test-repo',
		};
		(github.context as any).sha = 'testsha';
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
			if (value === null || value === undefined) return '';
			// For getInput always coerce arrays to first element
			return Array.isArray(value) ? value[0] : (value as string);
		});
		const getBooleanInputMock = jest.fn((...args: unknown[]) => {
			const name = String(args[0]);
			const value = String(inputValue(name)).trim().toLowerCase();
			if (value === 'true') return true;
			if (value === 'false') return false;
			throw new TypeError(
				`Input does not meet YAML 1.2 boolean specification: ${name}`,
			);
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
		coreMocks.getBooleanInput.mockImplementation(
			getBooleanInputMock as unknown as (...args: unknown[]) => unknown,
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
					listComments: jest.fn(),
					updateComment: jest.fn(),
				},
				pulls: {
					listFiles: jest.fn().mockResolvedValue({ data: [] }),
				},
			},
			graphql: jest.fn(),
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
				file: 'cypress/plugins/s3-email-client/s3-utils.ts',
				startColumn: 28,
				startLine: 7,
				title: '@typescript-eslint/dot-notation',
			},
		);
		expect(warningMock).toHaveBeenCalledWith('Missing JSDoc comment.', {
			endColumn: undefined,
			endLine: undefined,
			file: 'cypress/plugins/s3-email-client/s3-utils.ts',
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
				file: 'cypress/plugins/s3-email-client/s3-utils.ts',
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
		expect(warningMock).toHaveBeenCalledWith(
			"No items found in fixtures/empty-report.xml using XPath '//testcase'",
		);
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
		expect(setOutputMock).toHaveBeenCalledWith('errors', 2);
		expect(setOutputMock).toHaveBeenCalledWith('notices', 1);
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
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit|fixtures/junit-many-errors.xml'];
		testInputs['max-annotations'] = '2';
		// Mock listFiles to return all files as changed (in-diff)
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'tests/registration.code' }],
		});
		// Mock listComments to return some previous bot comments
		mockOctokit.rest.issues.listComments.mockResolvedValue({
			data: [
				{
					id: 1,
					node_id: 'comment1',
					body: '## Report Annotations\n\nOld comment',
				},
				{
					id: 2,
					node_id: 'comment2',
					body: 'Some other comment',
				},
			],
		});
		// Mock graphql for minimizing comments
		mockOctokit.graphql.mockResolvedValue({});
		mockOctokit.rest.issues.createComment.mockResolvedValue({});
		await main.run();
		expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledWith({
			owner: 'test-owner',
			repo: 'test-repo',
			issue_number: 123,
			page: 1,
			per_page: 100,
		});
		expect(mockOctokit.graphql).toHaveBeenCalledWith(
			expect.stringContaining('MinimizeComment'),
			{
				input: {
					subjectId: 'comment1',
					classifier: 'OUTDATED',
				},
			},
		);
		const createCommentCall =
			mockOctokit.rest.issues.createComment.mock.calls[0][0];
		expect(createCommentCall.body).toContain('## Report Annotations');
		expect(createCommentCall.body).toContain('**Summary:** Found ❌ 3 errors.');
		expect(infoMock).toHaveBeenCalledWith(
			'Created PR comment with annotation summary.',
		);
	});

	it('should include summary with all annotation types in PR comment', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		// Use a report with 2 errors and 3 warnings, limit to 1 per type
		testInputs.reports = ['junit-eslint|fixtures/junit-eslint-mixed.xml'];
		testInputs['max-annotations'] = '1';
		// Mock listFiles to return file as changed (in-diff)
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'src/app.ts' }],
		});
		// Mock listComments
		mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
		mockOctokit.rest.issues.createComment.mockResolvedValue({});
		await main.run();
		const createCommentCall =
			mockOctokit.rest.issues.createComment.mock.calls[0][0];
		// The summary should show total counts across all types (0-count types omitted)
		expect(createCommentCall.body).toContain(
			'**Summary:** Found ❌ 2 errors, ⚠️ 3 warnings.',
		);
		// The skipped sections should only list the overflow
		expect(createCommentCall.body).toContain('### Skipped Annotations');
		expect(createCommentCall.body).toContain('⚠️ WARNING (2)');
	});

	it('should format summary with all three annotation types', async () => {
		// junit-generic has 2 errors and 1 notice
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit|fixtures/junit-generic.xml'];
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'tests/registration.code' }],
		});
		mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
		mockOctokit.rest.issues.createComment.mockResolvedValue({});
		await main.run();
		const createCommentCall =
			mockOctokit.rest.issues.createComment.mock.calls[0][0];
		expect(createCommentCall.body).toContain(
			'**Summary:** Found ❌ 2 errors, ℹ️ 1 notice.',
		);
	});

	it('should handle PR comment API failure', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit|fixtures/junit-many-errors.xml'];
		testInputs['max-annotations'] = '2';
		// Mock listFiles
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'tests/registration.code' }],
		});
		// Mock listComments
		mockOctokit.rest.issues.listComments.mockResolvedValue({
			data: [],
		});
		// Mock graphql
		mockOctokit.graphql.mockResolvedValue({});
		const apiError = new Error('API Error');
		mockOctokit.rest.issues.createComment.mockRejectedValue(apiError);
		await main.run();
		expect(errorMock).toHaveBeenCalledWith(
			`Failed to create PR comment: ${apiError}`,
		);
	});

	it('should not minimize previous PR comments when no new comment is created', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		// Use a report with few errors that won't exceed the limit
		testInputs.reports = ['junit|fixtures/junit-generic.xml'];
		testInputs['max-annotations'] = '10';
		// Disable always-comment-errors to test minimization without new comment
		testInputs['always-comment-errors'] = 'false';
		// Mock listFiles to return all files as changed
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'tests/registration.code' }],
		});
		// Mock listComments to return some previous bot comments
		mockOctokit.rest.issues.listComments.mockResolvedValue({
			data: [
				{
					id: 1,
					node_id: 'comment1',
					body: '## Report Annotations\n\nOld comment',
				},
				{
					id: 2,
					node_id: 'comment2',
					body: 'Some other comment',
				},
			],
		});
		// Mock graphql for minimizing comments
		mockOctokit.graphql.mockResolvedValue({});
		await main.run();
		expect(mockOctokit.rest.issues.listComments).not.toHaveBeenCalled();
		expect(mockOctokit.graphql).not.toHaveBeenCalled();
		// Should not create a new comment since no annotations were skipped and alwaysCommentErrors is false
		expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
	});

	it('should handle pagination when fetching comments', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit|fixtures/junit-many-errors.xml'];
		testInputs['max-annotations'] = '2';
		// Mock listFiles
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'tests/registration.code' }],
		});
		// Mock listComments to return full page on first call, then empty page
		mockOctokit.rest.issues.listComments
			.mockResolvedValueOnce({
				data: Array(100)
					.fill(null)
					.map((_, i) => ({
						id: i + 1,
						node_id: `comment${i + 1}`,
						body: '## Report Annotations\n\nOld comment',
					})),
			})
			.mockResolvedValueOnce({
				data: [],
			});
		// Mock graphql for minimizing comments
		mockOctokit.graphql.mockResolvedValue({});
		mockOctokit.rest.issues.createComment.mockResolvedValue({});
		await main.run();
		expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledTimes(2);
		expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledWith({
			owner: 'test-owner',
			repo: 'test-repo',
			issue_number: 123,
			page: 1,
			per_page: 100,
		});
		expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledWith({
			owner: 'test-owner',
			repo: 'test-repo',
			issue_number: 123,
			page: 2,
			per_page: 100,
		});
		expect(mockOctokit.graphql).toHaveBeenCalledTimes(100);
	});

	it('should handle GraphQL minimization failure for individual comments', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit|fixtures/junit-many-errors.xml'];
		testInputs['max-annotations'] = '2';
		// Mock listFiles
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'tests/registration.code' }],
		});
		// Mock listComments to return bot comments
		mockOctokit.rest.issues.listComments.mockResolvedValue({
			data: [
				{
					id: 1,
					node_id: 'comment1',
					body: '## Report Annotations\n\nOld comment',
				},
			],
		});
		// Mock graphql to fail for minimization
		const graphqlError = new Error('GraphQL Error');
		mockOctokit.graphql.mockRejectedValue(graphqlError);
		mockOctokit.rest.issues.createComment.mockResolvedValue({});
		await main.run();
		expect(warningMock).toHaveBeenCalledWith(
			'Failed to minimize comment 1: Error: GraphQL Error',
		);
		expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
	});

	it('should handle listComments API failure', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit|fixtures/junit-many-errors.xml'];
		testInputs['max-annotations'] = '2';
		// Mock listFiles
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'tests/registration.code' }],
		});
		// Mock listComments to fail
		const apiError = new Error('API Error');
		mockOctokit.rest.issues.listComments.mockRejectedValue(apiError);
		mockOctokit.rest.issues.createComment.mockResolvedValue({});
		await main.run();
		expect(warningMock).toHaveBeenCalledWith(
			'Failed to minimize previous bot comments: Error: API Error',
		);
		expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
	});

	it('should throw error for invalid report format', async () => {
		testInputs.reports = ['invalid-format-no-pipe'];
		await expect(main.run()).rejects.toThrow(
			"Invalid report format: 'invalid-format-no-pipe'. Expected 'matcher|patterns'.",
		);
	});

	it('should handle missing config file', async () => {
		testInputs.configPath = '/nonexistent/config.yml';
		await main.run();
		expect(infoMock).toHaveBeenCalledWith(
			'No config file found at /nonexistent/config.yml.',
		);
	});

	it('should throw error for invalid custom-matchers JSON', async () => {
		testInputs['custom-matchers'] = '{invalid json';
		await expect(main.run()).rejects.toThrow();
		expect(errorMock).toHaveBeenCalledWith(
			expect.stringContaining('Failed to parse custom-matchers input'),
		);
	});

	it('should throw error for invalid YAML config', async () => {
		testInputs.configPath = 'fixtures/invalid-config.yml';
		await expect(main.run()).rejects.toThrow();
		expect(errorMock).toHaveBeenCalledWith(
			expect.stringContaining(
				'Failed to parse YAML config at fixtures/invalid-config.yml',
			),
		);
	});

	it('should skip items with empty messages', async () => {
		testInputs['custom-matchers'] = `{
			"custom-matcher": {
				"format": "xml",
				"item": "//testCase",
				"message": "@empty",
				"file": "@file",
				"startLine": "@line"
			}
		}`;
		testInputs.reports = ['custom-matcher|fixtures/custom-format.xml'];
		await main.run();
		// Should not create any annotations since message is empty
		expect(setOutputMock).toHaveBeenCalledWith('total', 0);
	});

	describe('truncateFilePath', () => {
		it('should return short paths unchanged', () => {
			expect(main.truncateFilePath('src/file.ts')).toBe('src/file.ts');
			expect(main.truncateFilePath('a/b/c/d.ts')).toBe('a/b/c/d.ts');
		});

		it('should truncate long paths to last 4 parts', () => {
			expect(main.truncateFilePath('a/b/c/d/e/f.ts')).toBe('.../c/d/e/f.ts');
			expect(
				main.truncateFilePath(
					'home/runner/work/repo/repo/src/modules/products/dto/product.dto.ts',
				),
			).toBe('.../modules/products/dto/product.dto.ts');
		});
	});

	describe('getDiffId', () => {
		it('should generate SHA256 hash for file path', () => {
			expect(main.getDiffId('src/index.js')).toBe(
				'bfe9874d239014961b1ae4e89875a6155667db834a410aaaa2ebe3cf89820556',
			);
			expect(main.getDiffId('src/modules/products/dto/product.dto.ts')).toBe(
				'58d7002fa09097d6e54eec04b3ba865011f947ebb601513ede5829785248e69f',
			);
		});
	});

	describe('pluralize', () => {
		it('should use singular form for count of 1', () => {
			expect(main.pluralize(1, 'error')).toBe('1 error');
			expect(main.pluralize(1, 'warning')).toBe('1 warning');
			expect(main.pluralize(1, 'notice')).toBe('1 notice');
		});

		it('should use plural form for other counts', () => {
			expect(main.pluralize(0, 'error')).toBe('0 errors');
			expect(main.pluralize(2, 'warning')).toBe('2 warnings');
			expect(main.pluralize(15, 'notice')).toBe('15 notices');
		});
	});

	describe('generateAnnotationSection', () => {
		it('should return empty string for no annotations', () => {
			expect(
				main.generateAnnotationSection('ERROR', [], 'https://example.com'),
			).toBe('');
		});

		it('should generate section with truncated file paths', () => {
			const annotations: PendingAnnotation[] = [
				{
					level: 'error',
					message: 'Test error',
					properties: {
						file: 'src/modules/products/dto/product.dto.ts',
						startLine: 167,
					},
				},
			];
			const baseUrl = 'https://github.com/owner/repo/pull/123/files';
			const result = main.generateAnnotationSection(
				'CAUTION',
				annotations,
				baseUrl,
			);
			expect(result).toContain('<details>');
			expect(result).toContain('❌ CAUTION (1)');
			expect(result).toContain(
				'[.../modules/products/dto/product.dto.ts#L167]',
			);
			expect(result).toContain(
				'(https://github.com/owner/repo/pull/123/files#diff-58d7002fa09097d6e54eec04b3ba865011f947ebb601513ede5829785248e69f)',
			);
			expect(result).toContain('</details>');
		});

		it('should escape @mentions in messages', () => {
			const annotations: PendingAnnotation[] = [
				{
					level: 'error',
					message:
						'Use InputSignals (e.g. via input()) for Component input properties rather than the legacy @Input() decorator',
					properties: {},
				},
			];
			const result = main.generateAnnotationSection(
				'CAUTION',
				annotations,
				'https://example.com',
			);
			expect(result).toContain(
				'Use InputSignals (e.g. via input()) for Component input properties rather than the legacy `@Input`() decorator',
			);
		});

		it('should escape @org/team mentions in messages', () => {
			const annotations: PendingAnnotation[] = [
				{
					level: 'error',
					message: 'Owned by @my-org/frontend-team member',
					properties: {},
				},
			];
			const result = main.generateAnnotationSection(
				'CAUTION',
				annotations,
				'https://example.com',
			);
			expect(result).toContain('`@my-org/frontend-team`');
		});

		it('should not add duplicate escaping for messages already containing code formatting', () => {
			const annotations: PendingAnnotation[] = [
				{
					level: 'error',
					message:
						'Avoid using `@Output()` decorators. Use OutputSignals (e.g. via output()) instead.',
					properties: {},
				},
			];
			const result = main.generateAnnotationSection(
				'CAUTION',
				annotations,
				'https://example.com',
			);
			expect(result).toContain(
				'Avoid using `@Output()` decorators. Use OutputSignals (e.g. via output()) instead.',
			);
		});
	});

	describe('generateBlobAnnotationSection', () => {
		it('should return empty string for no annotations', () => {
			expect(
				main.generateBlobAnnotationSection(
					'ERROR',
					[],
					'https://example.com/blob/abc',
				),
			).toBe('');
		});

		it('should generate section with blob links', () => {
			const annotations: PendingAnnotation[] = [
				{
					level: 'error',
					message: 'Test error',
					properties: {
						file: 'src/modules/products/dto/product.dto.ts',
						startLine: 167,
					},
				},
			];
			const blobBaseUrl = 'https://github.com/owner/repo/blob/abc123';
			const result = main.generateBlobAnnotationSection(
				'CAUTION',
				annotations,
				blobBaseUrl,
			);
			expect(result).toContain('<details>');
			expect(result).toContain('❌ CAUTION (1)');
			expect(result).toContain(
				'[.../modules/products/dto/product.dto.ts#L167]',
			);
			expect(result).toContain(
				'(https://github.com/owner/repo/blob/abc123/src/modules/products/dto/product.dto.ts#L167)',
			);
			expect(result).toContain('</details>');
		});

		it('should handle annotations without startLine', () => {
			const annotations: PendingAnnotation[] = [
				{
					level: 'warning',
					message: 'Some warning',
					properties: {
						file: 'src/file.ts',
					},
				},
			];
			const result = main.generateBlobAnnotationSection(
				'WARNING',
				annotations,
				'https://github.com/owner/repo/blob/abc123',
			);
			expect(result).toContain('[src/file.ts]');
			expect(result).toContain(
				'(https://github.com/owner/repo/blob/abc123/src/file.ts)',
			);
			// Should not contain line number reference
			expect(result).not.toContain('#L');
		});

		it('should URL-encode file paths with special characters', () => {
			const annotations: PendingAnnotation[] = [
				{
					level: 'error',
					message: 'Error in file with spaces',
					properties: {
						file: 'src/my file #1.ts',
						startLine: 10,
					},
				},
			];
			const result = main.generateBlobAnnotationSection(
				'CAUTION',
				annotations,
				'https://github.com/owner/repo/blob/abc123',
			);
			expect(result).toContain(
				'(https://github.com/owner/repo/blob/abc123/src/my%20file%20%231.ts#L10)',
			);
		});
	});

	it('should always create PR comment with errors when alwaysCommentErrors is true', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit-eslint|fixtures/junit-eslint.xml'];
		testInputs['max-annotations'] = '10'; // No skipping
		// Mock listFiles to return all files as changed
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'cypress/plugins/s3-email-client/s3-utils.ts' }],
		});
		mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
		mockOctokit.rest.issues.createComment.mockResolvedValue({});
		await main.run();
		// Should create a comment because there are errors and alwaysCommentErrors defaults to true
		expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
		const createCommentCall =
			mockOctokit.rest.issues.createComment.mock.calls[0][0];
		expect(createCommentCall.body).toContain('## Report Annotations');
		expect(createCommentCall.body).toContain('❌ CAUTION (1)');
	});

	it.each(['true', 'True', 'TRUE'])(
		'should parse always-comment-errors=%s as true',
		async value => {
			(github.context as MutableContext).payload = {
				pull_request: { number: 123, head: { sha: 'abc123' } },
			};
			testInputs.reports = ['junit-eslint|fixtures/junit-eslint.xml'];
			testInputs['max-annotations'] = '10';
			testInputs['always-comment-errors'] = value;
			mockOctokit.rest.pulls.listFiles.mockResolvedValue({
				data: [{ filename: 'cypress/plugins/s3-email-client/s3-utils.ts' }],
			});
			mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
			mockOctokit.rest.issues.createComment.mockResolvedValue({});

			await main.run();

			expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
		},
	);

	it.each(['false', 'False', 'FALSE'])(
		'should parse always-comment-errors=%s as false',
		async value => {
			(github.context as MutableContext).payload = {
				pull_request: { number: 123, head: { sha: 'abc123' } },
			};
			testInputs.reports = ['junit-eslint|fixtures/junit-eslint.xml'];
			testInputs['max-annotations'] = '10';
			testInputs['always-comment-errors'] = value;
			mockOctokit.rest.pulls.listFiles.mockResolvedValue({
				data: [{ filename: 'cypress/plugins/s3-email-client/s3-utils.ts' }],
			});
			mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });

			await main.run();

			expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
		},
	);

	it('should not create PR comment when alwaysCommentErrors is false and no skipped', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit-eslint|fixtures/junit-eslint.xml'];
		testInputs['max-annotations'] = '10';
		testInputs['always-comment-errors'] = 'false';
		// Mock listFiles to return all annotation files as changed (in-diff)
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'cypress/plugins/s3-email-client/s3-utils.ts' }],
		});
		mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
		await main.run();
		// Should NOT create a comment because alwaysCommentErrors is false, all files in diff, and nothing was skipped
		expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
	});

	it('should include out-of-diff annotations in PR comment', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit-eslint|fixtures/junit-eslint.xml'];
		testInputs['max-annotations'] = '10';
		testInputs['always-comment-errors'] = 'false';
		// Mock listFiles to return NO changed files - all annotations are out-of-diff
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [],
		});
		mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
		mockOctokit.rest.issues.createComment.mockResolvedValue({});
		await main.run();
		// Out-of-diff annotations should not be emitted as GitHub annotations
		expect(errorMock).not.toHaveBeenCalledWith(
			'["Bucket"] is better written in dot notation.',
			expect.any(Object),
		);
		// Should create a comment with out-of-diff section
		expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
		const createCommentCall =
			mockOctokit.rest.issues.createComment.mock.calls[0][0];
		expect(createCommentCall.body).toContain('### Annotations Outside PR Diff');
		expect(createCommentCall.body).toContain(
			'https://github.com/test-owner/test-repo/blob/abc123/',
		);
		// Outputs should reflect 0 since out-of-diff annotations are not emitted
		expect(setOutputMock).toHaveBeenCalledWith('errors', 0);
		expect(setOutputMock).toHaveBeenCalledWith('total', 0);
	});

	it('should not duplicate out-of-diff errors in the main error section', async () => {
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit-eslint|fixtures/junit-eslint.xml'];
		testInputs['max-annotations'] = '10';
		// Leave always-comment-errors enabled and classify every annotation as out-of-diff
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: [] });
		mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
		mockOctokit.rest.issues.createComment.mockResolvedValue({});

		await main.run();

		const createCommentCall =
			mockOctokit.rest.issues.createComment.mock.calls[0][0];
		const cautionSectionCount = (
			createCommentCall.body.match(/❌ CAUTION \(1\)/g) ?? []
		).length;
		expect(cautionSectionCount).toBe(1);
		expect(createCommentCall.body).not.toContain('/pull/123/files#diff-');
		expect(createCommentCall.body).toContain(
			'https://github.com/test-owner/test-repo/blob/abc123/cypress/plugins/s3-email-client/s3-utils.ts#L7',
		);
	});

	it('should use github context sha as blob link fallback', async () => {
		(github.context as MutableContext).payload = {
			pull_request: { number: 123 },
		};
		(github.context as any).sha = 'fallbacksha';
		testInputs.reports = ['junit-eslint|fixtures/junit-eslint.xml'];
		testInputs['always-comment-errors'] = 'false';
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: [] });
		mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
		mockOctokit.rest.issues.createComment.mockResolvedValue({});

		await main.run();

		const createCommentCall =
			mockOctokit.rest.issues.createComment.mock.calls[0][0];
		expect(createCommentCall.body).toContain(
			'https://github.com/test-owner/test-repo/blob/fallbacksha/',
		);
	});

	it('should handle getPrChangedFiles API failure gracefully', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit-eslint|fixtures/junit-eslint.xml'];
		// Mock listFiles to fail
		mockOctokit.rest.pulls.listFiles.mockRejectedValue(
			new Error('API failure'),
		);
		mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
		mockOctokit.rest.issues.createComment.mockResolvedValue({});
		await main.run();
		// Should fall back to treating all as in-diff
		expect(warningMock).toHaveBeenCalledWith(
			expect.stringContaining('Failed to fetch PR changed files'),
		);
		// Annotations should still be created as normal
		expect(errorMock).toHaveBeenCalledWith(
			'["Bucket"] is better written in dot notation.',
			expect.any(Object),
		);
	});

	it('should also minimize old-format Skipped Annotations comments', async () => {
		// Mock GitHub context to be on a PR
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit-eslint|fixtures/junit-eslint.xml'];
		// Mock listFiles
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'cypress/plugins/s3-email-client/s3-utils.ts' }],
		});
		mockOctokit.rest.issues.listComments.mockResolvedValue({
			data: [
				{
					id: 1,
					node_id: 'comment1',
					body: '## Skipped Annotations\n\nOld format comment',
				},
				{
					id: 2,
					node_id: 'comment2',
					body: '## Report Annotations\n\nNew format comment',
				},
			],
		});
		mockOctokit.graphql.mockResolvedValue({});
		mockOctokit.rest.issues.createComment.mockResolvedValue({});
		await main.run();
		// Both old and new format comments should be minimized
		expect(mockOctokit.graphql).toHaveBeenCalledTimes(2);
		expect(mockOctokit.graphql).toHaveBeenCalledWith(
			expect.stringContaining('MinimizeComment'),
			{ input: { subjectId: 'comment1', classifier: 'OUTDATED' } },
		);
		expect(mockOctokit.graphql).toHaveBeenCalledWith(
			expect.stringContaining('MinimizeComment'),
			{ input: { subjectId: 'comment2', classifier: 'OUTDATED' } },
		);
	});

	it('should update existing comment when comment-method is update', async () => {
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit|fixtures/junit-many-errors.xml'];
		testInputs['max-annotations'] = '2';
		testInputs['comment-method'] = 'update';
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'tests/registration.code' }],
		});
		// listComments called twice: once by processAnnotations (no minimize since method=update),
		// once by updateOrCreateComment to find existing comment
		mockOctokit.rest.issues.listComments.mockResolvedValue({
			data: [
				{
					id: 42,
					node_id: 'comment42',
					body: '## Report Annotations\n\nOld comment',
				},
			],
		});
		mockOctokit.rest.issues.updateComment.mockResolvedValue({});
		await main.run();
		// Should NOT minimize since comment-method is 'update'
		expect(mockOctokit.graphql).not.toHaveBeenCalled();
		// Should update the existing comment
		expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: 'test-owner',
				repo: 'test-repo',
				comment_id: 42,
				body: expect.stringContaining('## Report Annotations'),
			}),
		);
		// Should NOT create a new comment
		expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
	});

	it('should create new comment when comment-method is update but no existing comment', async () => {
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		testInputs.reports = ['junit|fixtures/junit-many-errors.xml'];
		testInputs['max-annotations'] = '2';
		testInputs['comment-method'] = 'update';
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'tests/registration.code' }],
		});
		mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
		mockOctokit.rest.issues.createComment.mockResolvedValue({});
		await main.run();
		expect(mockOctokit.rest.issues.updateComment).not.toHaveBeenCalled();
		expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
	});

	it('should not include errors in skipped section when already shown in allErrors', async () => {
		(github.context as MutableContext).payload = {
			pull_request: { number: 123, head: { sha: 'abc123' } },
		};
		// junit-many-errors has 3 errors; with max-annotations=2, 1 will be skipped
		// But alwaysCommentErrors=true shows all 3 errors in the errors section
		testInputs.reports = ['junit|fixtures/junit-many-errors.xml'];
		testInputs['max-annotations'] = '2';
		mockOctokit.rest.pulls.listFiles.mockResolvedValue({
			data: [{ filename: 'tests/registration.code' }],
		});
		mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
		mockOctokit.rest.issues.createComment.mockResolvedValue({});
		await main.run();
		const createCommentCall =
			mockOctokit.rest.issues.createComment.mock.calls[0][0];
		// All errors shown in main section
		expect(createCommentCall.body).toContain('❌ CAUTION (3)');
		// The skipped section should not duplicate errors already shown
		expect(createCommentCall.body).not.toContain('### Skipped Annotations');
	});
});
