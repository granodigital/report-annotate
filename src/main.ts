import * as core from '@actions/core';
import * as github from '@actions/github';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { glob } from 'glob';
import { junitEslintMatcher } from './matchers/junit-eslint.js';
import { DOMParser } from '@xmldom/xmldom';
import {
	isArrayOfNodes,
	isNodeLike,
	select,
	xpathSelect,
} from './xpath-utils.js';
import { junitMatcher } from './matchers/junit.js';
import { junitJestMatcher } from './matchers/junit-jest.js';

const DEFAULT_CONFIG_PATH = '.github/report-annotate.yml';
const DEFAULT_CONFIG: Partial<Config> = {
	reports: ['junit|junit/*.xml'],
	ignore: ['node_modules/**', 'dist/**'],
	maxAnnotations: 10,
	customMatchers: {},
	alwaysCommentErrors: true,
	commentMethod: 'minimize',
};

export type CommentMethod = 'minimize' | 'update';

export interface Config {
	/**
	 * List of globs to search for reports.
	 * @example `['junit-eslint|junit/lint*.xml']`
	 */
	reports: string[];
	/** List of globs to ignore when searching for reports. */
	ignore: string[];
	/** Maximum number of annotations per type (error/warning/notice). */
	maxAnnotations: number;
	/** Custom matchers for parsing reports. */
	customMatchers: Record<string, ReportMatcher>;
	/** When true, all errors are always included in the PR comment body. */
	alwaysCommentErrors: boolean;
	/** How to handle previous bot comments: 'minimize' hides them, 'update' edits the last one in-place. */
	commentMethod: CommentMethod;
}

type AnnotationLevel = 'notice' | 'warning' | 'error' | 'ignore';

export interface PendingAnnotation {
	level: AnnotationLevel;
	message: string;
	properties: core.AnnotationProperties;
}

export interface ReportMatcher {
	/**
	 * The format of the report e.g. `xml`
	 * - `xml` the report will be parsed using xpath selectors defined in the other properties.
	 */
	format: 'xml'; // TODO: 'json' | 'text' | 'yaml' | 'csv' | 'tsv' | 'html'
	/** Matcher for individual report item e.g. //testcase */
	item: string;
	/**
	 * Matchers for the error level relative to item, processed in order and first match is applied.
	 * If omitted or no match, the level is error.
	 */
	level?: Partial<Record<AnnotationLevel, string>>;
	/** Matcher for the message relative to item */
	message: string;
	/** Matcher for the title of the report relative to item */
	title?: string;
	/** Matcher for the file path relative to item */
	file: string;
	/** Matcher for the start line relative to item */
	startLine?: string;
	/** Matcher for the end line relative to item */
	endLine?: string;
	/** Matcher for the start column relative to item */
	startColumn?: string;
	/** Matcher for the end column relative to item */
	endColumn?: string;
}

/** Built-in report matchers. */
const builtInReportMatchers: Record<string, ReportMatcher> = {
	junit: junitMatcher,
	'junit-eslint': junitEslintMatcher,
	'junit-jest': junitJestMatcher,
};

/**
 * The main function for the action.
 */
export async function run(): Promise<void> {
	try {
		core.startGroup('Configuration');
		const config = await loadConfig();
		core.endGroup();

		const reportMatchers = {
			...builtInReportMatchers,
			...config.customMatchers,
		};

		const reportFiles = await findReportFiles(config);
		const allAnnotations = await parseAllReports(reportFiles, reportMatchers);
		await processAnnotations(allAnnotations, config, reportFiles.size === 0);
	} catch (error) {
		if (error instanceof Error) core.setFailed(error);
		throw error;
	}
}

/** Find report files for all configured matchers. */
async function findReportFiles(
	config: Config,
): Promise<Map<string, Set<string>>> {
	const reportMatcherPatterns = config.reports.map(report => {
		const parts = report.split('|');
		if (parts.length !== 2) {
			throw new Error(
				`Invalid report format: '${report}'. Expected 'matcher|patterns'.`,
			);
		}
		const [matcher, patternsStr] = parts;
		return { matcher, patterns: patternsStr.split(',') };
	});
	const reportFiles = new Map<string, Set<string>>();
	for (const { matcher, patterns } of reportMatcherPatterns) {
		core.startGroup(`Finding ${matcher} reports`);
		const files = await globFiles(patterns, config.ignore);
		if (files.size === 0) {
			core.warning(
				`No reports found for ${matcher} using patterns ${patterns}`,
			);
			core.endGroup();
			continue;
		}
		reportFiles.set(matcher, files);
		core.info(`Found ${files.size} report(s) for ${matcher}`);
		core.endGroup();
	}
	return reportFiles;
}

/** Parse all reports and collect annotations. */
async function parseAllReports(
	reportFiles: Map<string, Set<string>>,
	reportMatchers: Record<string, ReportMatcher>,
): Promise<PendingAnnotation[]> {
	const allAnnotations: PendingAnnotation[] = [];

	for (const [matcherName, files] of reportFiles) {
		const matcher = reportMatchers[matcherName];
		if (!matcher) throw new Error(`No matcher found for ${matcherName}`);

		core.startGroup(`Parsing ${matcherName} reports`);
		for (const file of files) {
			core.debug(`Parsing ${file}`);
			switch (matcher.format) {
				case 'xml':
					await parseXmlReport(file, matcher, allAnnotations);
					break;
				default:
					throw new Error(
						`Unsupported matcher format in ${matcherName}: ${matcher.format}`,
					);
			}
		}
		core.info(
			`Parsed ${allAnnotations.length} annotation(s) from ${files.size} report(s)`,
		);
		core.endGroup();
	}

	return allAnnotations;
}

/** Fetch the list of files changed in the PR via the GitHub API. */
export async function getPrChangedFiles(
	octokit: ReturnType<typeof github.getOctokit>,
	owner: string,
	repo: string,
	pullNumber: number,
): Promise<Set<string>> {
	const changedFiles = new Set<string>();
	let page = 1;
	const perPage = 100;
	while (true) {
		const response = await octokit.rest.pulls.listFiles({
			owner,
			repo,
			pull_number: pullNumber,
			page,
			per_page: perPage,
		});
		for (const file of response.data) {
			changedFiles.add(file.filename);
		}
		if (response.data.length < perPage) break;
		page++;
	}
	return changedFiles;
}

/** Process and create annotations with limits. */
async function processAnnotations(
	allAnnotations: PendingAnnotation[],
	config: Config,
	noReportsFound = false,
): Promise<void> {
	// Sort annotations by priority: errors first, then warnings, then notices
	// Ignore level annotations are already filtered out during collection
	const priorityOrder: Record<AnnotationLevel, number> = {
		error: 0,
		warning: 1,
		notice: 2,
		ignore: 3, // Should not appear in the array, but included for type completeness
	};
	allAnnotations.sort(
		(a, b) => priorityOrder[a.level] - priorityOrder[b.level],
	);

	// If on a PR, fetch changed files and partition annotations
	let changedFiles: Set<string> | null = null;
	let octokit: ReturnType<typeof github.getOctokit> | null = null;
	let pullNumber = 0;
	const { owner, repo } = github.context.repo;

	if (github.context.payload.pull_request) {
		octokit = github.getOctokit(
			core.getInput('token') || process.env.GITHUB_TOKEN!,
		);
		pullNumber = github.context.payload.pull_request.number;

		try {
			changedFiles = await getPrChangedFiles(octokit, owner, repo, pullNumber);
			core.info(
				`Found ${changedFiles.size} changed file(s) in PR #${pullNumber}.`,
			);
		} catch (error) {
			core.warning(`Failed to fetch PR changed files: ${error}`);
		}
	}

	// Partition annotations into in-diff and out-of-diff
	const inDiffAnnotations: PendingAnnotation[] = [];
	const outOfDiffAnnotations: PendingAnnotation[] = [];
	for (const annotation of allAnnotations) {
		if (
			changedFiles &&
			annotation.properties.file &&
			!changedFiles.has(annotation.properties.file)
		) {
			outOfDiffAnnotations.push(annotation);
		} else {
			inDiffAnnotations.push(annotation);
		}
	}

	if (outOfDiffAnnotations.length > 0) {
		core.info(
			`${outOfDiffAnnotations.length} annotation(s) target files outside the PR diff.`,
		);
	}

	// Apply the per-type annotation limits to in-diff annotations only
	const maxPerType = config.maxAnnotations;
	const errors = inDiffAnnotations
		.filter(a => a.level === 'error')
		.slice(0, maxPerType);
	const warnings = inDiffAnnotations
		.filter(a => a.level === 'warning')
		.slice(0, maxPerType);
	const notices = inDiffAnnotations
		.filter(a => a.level === 'notice')
		.slice(0, maxPerType);
	const annotationsToCreate = [...errors, ...warnings, ...notices];
	const tally = { errors: 0, warnings: 0, notices: 0, total: 0 };

	for (const annotation of annotationsToCreate) {
		// Type assertion is safe because we filter out 'ignore' level during collection
		core[annotation.level as 'error' | 'warning' | 'notice'](
			annotation.message,
			annotation.properties,
		);
		if (annotation.level === 'error') tally.errors++;
		if (annotation.level === 'warning') tally.warnings++;
		if (annotation.level === 'notice') tally.notices++;
		tally.total++;
	}

	// Collect skipped in-diff annotations (over limit)
	const skippedErrors = inDiffAnnotations
		.filter(a => a.level === 'error')
		.slice(maxPerType);
	const skippedWarnings = inDiffAnnotations
		.filter(a => a.level === 'warning')
		.slice(maxPerType);
	const skippedNotices = inDiffAnnotations
		.filter(a => a.level === 'notice')
		.slice(maxPerType);

	// Warn if any annotations were skipped due to per-type limits
	const totalSkipped =
		skippedErrors.length + skippedWarnings.length + skippedNotices.length;
	if (totalSkipped > 0) {
		core.warning(
			`Maximum number of annotations per type reached (${maxPerType}). ${totalSkipped} annotations were not shown.`,
		);
	}

	// Determine if we need a PR comment
	const allErrors = allAnnotations.filter(a => a.level === 'error');
	const inDiffOnlyErrors = inDiffAnnotations.filter(a => a.level === 'error');
	const hasErrors = allErrors.length > 0;
	const hasOutOfDiff = outOfDiffAnnotations.length > 0;
	const hasSkipped = totalSkipped > 0;
	const needsComment =
		(hasErrors && config.alwaysCommentErrors) || hasOutOfDiff || hasSkipped;

	if (noReportsFound && octokit && pullNumber) {
		await postNoReportsFoundWarning(
			octokit,
			owner,
			repo,
			pullNumber,
			config.commentMethod,
			config.reports,
		);
	} else if (needsComment) {
		// If on a PR, minimize previous bot comments only when a replacement
		// comment will be created.
		if (octokit && pullNumber && config.commentMethod === 'minimize') {
			await minimizePreviousBotComments(octokit, owner, repo, pullNumber);
		}

		const totalErrors = allAnnotations.filter(a => a.level === 'error').length;
		const totalWarnings = allAnnotations.filter(
			a => a.level === 'warning',
		).length;
		const totalNotices = allAnnotations.filter(
			a => a.level === 'notice',
		).length;

		await createSummaryComment({
			allErrors: config.alwaysCommentErrors ? inDiffOnlyErrors : [],
			skippedErrors,
			skippedWarnings,
			skippedNotices,
			outOfDiffAnnotations,
			maxPerType,
			totalCounts: {
				errors: totalErrors,
				warnings: totalWarnings,
				notices: totalNotices,
			},
			commentMethod: config.commentMethod,
			octokit,
			owner,
			repo,
			pullNumber,
		});
	} else if (octokit && pullNumber) {
		// Nothing new to report. If a previous bot comment exists it is now
		// stale (still showing old errors/warnings), so replace it with an
		// "all clear" status — minimize+post for `minimize`, update for
		// `update`. We skip this entirely when no prior bot comment exists
		// to avoid spamming clean PRs.
		await postAllClearStatus(
			octokit,
			owner,
			repo,
			pullNumber,
			config.commentMethod,
		);
	}

	// Set outputs for other workflow steps to use.
	core.setOutput('errors', tally.errors);
	core.setOutput('warnings', tally.warnings);
	core.setOutput('notices', tally.notices);
	core.setOutput('total', tally.total);
}

/** The comment header used to identify bot comments for minimization. */
export const COMMENT_HEADER = '## Report Annotations';

/**
 * Hidden marker embedded in all-clear comments. Used to detect that the
 * latest bot comment is already an all-clear so repeat clean runs don't
 * keep posting / minimizing duplicates. Decoupled from the visible body
 * so wording can change without affecting the idempotency check.
 */
const ALL_CLEAR_MARKER = '<!-- report-annotate:all-clear -->';
const ALL_CLEAR_BODY = `${COMMENT_HEADER}\n${ALL_CLEAR_MARKER}\n\n✅ All issues resolved.\n`;
const NO_REPORTS_FOUND_BODY = (reports: string[]) =>
	`${COMMENT_HEADER}\n\n⚠️ No configured report files were found.\n\n` +
	`Report Annotate could not find any files matching the configured report patterns. ` +
	`This can happen when an earlier workflow step failed before generating reports, or when reports were written to a different path.\n\n` +
	`Configured reports:\n${reports.map(report => `- \`${report}\``).join('\n')}\n`;

interface SummaryCommentParams {
	allErrors: PendingAnnotation[];
	skippedErrors: PendingAnnotation[];
	skippedWarnings: PendingAnnotation[];
	skippedNotices: PendingAnnotation[];
	outOfDiffAnnotations: PendingAnnotation[];
	maxPerType: number;
	totalCounts: { errors: number; warnings: number; notices: number };
	commentMethod: CommentMethod;
	octokit: ReturnType<typeof github.getOctokit> | null;
	owner: string;
	repo: string;
	pullNumber: number;
}

/** Create a PR comment summarizing errors, out-of-diff, and skipped annotations. */
async function createSummaryComment(
	params: SummaryCommentParams,
): Promise<void> {
	// Only create comment if running on a pull request
	if (!github.context.payload.pull_request) {
		core.info('Not running on a pull request, skipping comment creation.');
		return;
	}

	const octokit =
		params.octokit ??
		github.getOctokit(core.getInput('token') || process.env.GITHUB_TOKEN!);
	const { owner, repo, pullNumber } = params;
	const diffBaseUrl = `https://github.com/${owner}/${repo}/pull/${pullNumber}/files`;
	const sha =
		github.context.payload.pull_request.head?.sha ?? github.context.sha;
	const blobBaseUrl = `https://github.com/${owner}/${repo}/blob/${sha}`;

	let commentBody = `${COMMENT_HEADER}\n\n`;

	// Build summary line, omitting types with 0 count
	const summaryParts: string[] = [];
	if (params.totalCounts.errors > 0)
		summaryParts.push(`❌ ${pluralize(params.totalCounts.errors, 'error')}`);
	if (params.totalCounts.warnings > 0)
		summaryParts.push(
			`⚠️ ${pluralize(params.totalCounts.warnings, 'warning')}`,
		);
	if (params.totalCounts.notices > 0)
		summaryParts.push(`ℹ️ ${pluralize(params.totalCounts.notices, 'notice')}`);
	if (summaryParts.length > 0) {
		commentBody += `**Summary:** Found ${summaryParts.join(', ')}.\n\n`;
	}

	// Track error files already shown in the allErrors section to avoid duplication in skipped
	const shownErrorKeys = new Set<string>();

	// Section: All errors (always shown when alwaysCommentErrors is enabled)
	if (params.allErrors.length > 0) {
		for (const e of params.allErrors) {
			shownErrorKeys.add(annotationKey(e));
		}
		commentBody += generateAnnotationSection(
			'CAUTION',
			params.allErrors,
			diffBaseUrl,
		);
	}

	// Section: Out-of-diff annotations
	if (params.outOfDiffAnnotations.length > 0) {
		const outOfDiffErrors = params.outOfDiffAnnotations.filter(
			a => a.level === 'error',
		);
		const outOfDiffWarnings = params.outOfDiffAnnotations.filter(
			a => a.level === 'warning',
		);
		const outOfDiffNotices = params.outOfDiffAnnotations.filter(
			a => a.level === 'notice',
		);

		commentBody += `### Annotations Outside PR Diff\n\n`;
		commentBody += `The following annotations target files not included in this PR's changes:\n\n`;
		commentBody += generateBlobAnnotationSection(
			'CAUTION',
			outOfDiffErrors,
			blobBaseUrl,
		);
		commentBody += generateBlobAnnotationSection(
			'WARNING',
			outOfDiffWarnings,
			blobBaseUrl,
		);
		commentBody += generateBlobAnnotationSection(
			'NOTE',
			outOfDiffNotices,
			blobBaseUrl,
		);
	}

	// Section: Skipped annotations (over limit), excluding errors already shown in allErrors
	const dedupedSkippedErrors = params.skippedErrors.filter(
		e => !shownErrorKeys.has(annotationKey(e)),
	);
	const totalSkipped =
		dedupedSkippedErrors.length +
		params.skippedWarnings.length +
		params.skippedNotices.length;
	if (totalSkipped > 0) {
		commentBody += `### Skipped Annotations\n\n`;
		commentBody += `The maximum number of annotations per type (${params.maxPerType}) was reached. Here are the additional annotations that were not displayed:\n\n`;
		commentBody += generateAnnotationSection(
			'CAUTION',
			dedupedSkippedErrors,
			diffBaseUrl,
		);
		commentBody += generateAnnotationSection(
			'WARNING',
			params.skippedWarnings,
			diffBaseUrl,
		);
		commentBody += generateAnnotationSection(
			'NOTE',
			params.skippedNotices,
			diffBaseUrl,
		);
	}

	try {
		if (params.commentMethod === 'update') {
			await updateOrCreateComment(
				octokit,
				owner,
				repo,
				pullNumber,
				commentBody,
			);
		} else {
			await octokit.rest.issues.createComment({
				owner,
				repo,
				issue_number: pullNumber,
				body: commentBody,
			});
		}
		core.info('Created PR comment with annotation summary.');
	} catch (error) {
		core.error(`Failed to create PR comment: ${error}`);
	}
}

/** Minimize previous bot comments on the PR. */
async function minimizePreviousBotComments(
	octokit: ReturnType<typeof github.getOctokit>,
	owner: string,
	repo: string,
	pullNumber: number,
	botComments?: BotComment[],
): Promise<void> {
	try {
		const comments =
			botComments ?? (await fetchBotComments(octokit, owner, repo, pullNumber));

		if (comments.length === 0) {
			core.debug('No previous bot comments to minimize.');
			return;
		}

		core.debug(`Found ${comments.length} previous bot comments to minimize.`);

		for (const comment of comments) {
			try {
				await octokit.graphql(
					`
					mutation MinimizeComment($input: MinimizeCommentInput!) {
						minimizeComment(input: $input) {
							minimizedComment {
								isMinimized
							}
						}
					}
				`,
					{
						input: {
							subjectId: comment.node_id,
							classifier: 'OUTDATED',
						},
					},
				);
				core.debug(`Minimized comment ${comment.id}`);
			} catch (error) {
				core.warning(`Failed to minimize comment ${comment.id}: ${error}`);
			}
		}
	} catch (error) {
		core.warning(`Failed to minimize previous bot comments: ${error}`);
	}
}

/** Find the latest bot comment on the PR, or create a new one. */
async function updateOrCreateComment(
	octokit: ReturnType<typeof github.getOctokit>,
	owner: string,
	repo: string,
	pullNumber: number,
	body: string,
): Promise<void> {
	const botComment = (
		await fetchBotComments(octokit, owner, repo, pullNumber)
	).at(-1);

	if (botComment) {
		await octokit.rest.issues.updateComment({
			owner,
			repo,
			comment_id: botComment.id,
			body,
		});
		core.debug(`Updated existing comment ${botComment.id}`);
	} else {
		await octokit.rest.issues.createComment({
			owner,
			repo,
			issue_number: pullNumber,
			body,
		});
	}
}

/**
 * Replace any stale prior bot comment with an "all clear" status. Does
 * nothing when there is no prior bot comment, or when the latest prior
 * bot comment is already an all-clear (so repeat clean runs are
 * idempotent).
 *
 * - `minimize`: minimize prior bot comments and create a new all-clear one
 * - `update`:   rewrite the latest prior bot comment in place
 */
async function postAllClearStatus(
	octokit: ReturnType<typeof github.getOctokit>,
	owner: string,
	repo: string,
	pullNumber: number,
	commentMethod: CommentMethod,
): Promise<void> {
	try {
		const botComments = await fetchBotComments(
			octokit,
			owner,
			repo,
			pullNumber,
		);
		const latest = botComments.at(-1);
		if (!latest) {
			core.debug('No previous bot comment to clear.');
			return;
		}
		if (latest.body?.includes(ALL_CLEAR_MARKER)) {
			core.debug('Latest bot comment is already an all-clear; skipping.');
			return;
		}
		if (commentMethod === 'minimize') {
			await minimizePreviousBotComments(
				octokit,
				owner,
				repo,
				pullNumber,
				botComments,
			);
			await octokit.rest.issues.createComment({
				owner,
				repo,
				issue_number: pullNumber,
				body: ALL_CLEAR_BODY,
			});
			core.info('Posted all-clear PR comment and minimized previous one(s).');
		} else {
			await octokit.rest.issues.updateComment({
				owner,
				repo,
				comment_id: latest.id,
				body: ALL_CLEAR_BODY,
			});
			core.info(`Updated previous bot comment ${latest.id} to all-clear.`);
		}
	} catch (error) {
		core.warning(`Failed to post all-clear PR comment: ${error}`);
	}
}

/** Post a warning when configured reports are missing instead of marking issues resolved. */
async function postNoReportsFoundWarning(
	octokit: ReturnType<typeof github.getOctokit>,
	owner: string,
	repo: string,
	pullNumber: number,
	commentMethod: CommentMethod,
	reports: string[],
): Promise<void> {
	try {
		const body = NO_REPORTS_FOUND_BODY(reports);
		if (commentMethod === 'update') {
			await updateOrCreateComment(octokit, owner, repo, pullNumber, body);
		} else {
			await minimizePreviousBotComments(octokit, owner, repo, pullNumber);
			await octokit.rest.issues.createComment({
				owner,
				repo,
				issue_number: pullNumber,
				body,
			});
		}
		core.info('Posted no-reports-found PR warning comment.');
	} catch (error) {
		core.warning(`Failed to post no-reports-found PR warning comment: ${error}`);
	}
}

interface BotComment {
	id: number;
	node_id: string;
	body?: string;
}

/** Fetch all bot comments authored by this action on the PR (paginated). */
async function fetchBotComments(
	octokit: ReturnType<typeof github.getOctokit>,
	owner: string,
	repo: string,
	pullNumber: number,
): Promise<BotComment[]> {
	const allComments: BotComment[] = [];
	let page = 1;
	const perPage = 100;
	while (true) {
		const response = await octokit.rest.issues.listComments({
			owner,
			repo,
			issue_number: pullNumber,
			page,
			per_page: perPage,
		});
		allComments.push(...response.data);
		if (response.data.length < perPage) break;
		page++;
	}

	return allComments.filter(
		c =>
			c.body?.startsWith(COMMENT_HEADER) ||
			c.body?.startsWith('## Skipped Annotations'),
	);
}

/** Generate a unique key for an annotation to support deduplication. */
function annotationKey(annotation: PendingAnnotation): string {
	return `${annotation.properties.file}:${annotation.properties.startLine}:${annotation.message}`;
}

/** Truncate file path to show at most 4 directories. */
export function truncateFilePath(filePath: string): string {
	const parts = filePath.split('/');
	if (parts.length <= 4) {
		return filePath;
	}
	return '...' + '/' + parts.slice(-4).join('/');
}

/** Generate the diff ID for a file path in GitHub PR files view. */
export function getDiffId(filePath: string): string {
	return createHash('sha256').update(filePath).digest('hex');
}

/** Pluralize a word based on count. */
export function pluralize(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Emoji indicators for annotation levels. */
const levelEmojis: Record<string, string> = {
	CAUTION: '❌',
	WARNING: '⚠️',
	NOTE: 'ℹ️',
};

/**
 * Neutralize GitHub @mentions in annotation messages to prevent unwanted notifications.
 * Handles usernames with hyphens and org/team mentions (e.g. @org/team-name).
 */
function neutralizeMentions(message: string): string {
	return message.replace(/(?<!`)@[a-zA-Z][\w/-]*(?!`)/g, '`$&`');
}

/** URL-encode each segment of a file path for use in URLs. */
function encodeFilePath(filePath: string): string {
	return filePath
		.split('/')
		.map(segment => encodeURIComponent(segment))
		.join('/');
}

/** Generate a comment section for a specific annotation level. */
export function generateAnnotationSection(
	levelName: string,
	annotations: PendingAnnotation[],
	baseUrl: string,
): string {
	if (annotations.length === 0) return '';

	const emoji = levelEmojis[levelName] ?? levelName;
	let section = `<details>\n<summary>${emoji} ${levelName} (${annotations.length})</summary>\n\n`;
	for (const annotation of annotations) {
		const message = neutralizeMentions(annotation.message);
		let line = `- ${message}`;
		if (annotation.properties.file && annotation.properties.startLine) {
			const displayLocation = `${truncateFilePath(annotation.properties.file)}#L${annotation.properties.startLine}`;
			const diffId = getDiffId(annotation.properties.file);
			const link = `${baseUrl}#diff-${diffId}`;
			line = `- [${displayLocation}](${link}) ${message}`;
		}
		section += `${line}\n`;
	}
	section += '\n</details>\n\n';
	return section;
}

/** Generate a comment section linking to blob view for out-of-diff annotations. */
export function generateBlobAnnotationSection(
	levelName: string,
	annotations: PendingAnnotation[],
	blobBaseUrl: string,
): string {
	if (annotations.length === 0) return '';

	const emoji = levelEmojis[levelName] ?? levelName;
	let section = `<details>\n<summary>${emoji} ${levelName} (${annotations.length})</summary>\n\n`;
	for (const annotation of annotations) {
		const message = neutralizeMentions(annotation.message);
		let line = `- ${message}`;
		if (annotation.properties.file) {
			const encodedPath = encodeFilePath(annotation.properties.file);
			const displayLocation = annotation.properties.startLine
				? `${truncateFilePath(annotation.properties.file)}#L${annotation.properties.startLine}`
				: truncateFilePath(annotation.properties.file);
			const link = annotation.properties.startLine
				? `${blobBaseUrl}/${encodedPath}#L${annotation.properties.startLine}`
				: `${blobBaseUrl}/${encodedPath}`;
			line = `- [${displayLocation}](${link}) ${message}`;
		}
		section += `${line}\n`;
	}
	section += '\n</details>\n\n';
	return section;
}

/** Find files using the given glob patterns. */
async function globFiles(
	patterns: string[],
	ignore: string[],
): Promise<Set<string>> {
	const reportFiles = new Set<string>();
	for (const pattern of patterns) {
		const files = await glob(pattern, { ignore });
		for (const file of files) reportFiles.add(file);
	}
	return reportFiles;
}

/** Load the Yaml config file. */
async function loadYamlConfig(): Promise<Partial<Config>> {
	const configPath: string = core.getInput('configPath') || DEFAULT_CONFIG_PATH;
	if (existsSync(configPath)) {
		core.info(`Using config file at ${configPath}`);
		try {
			// Parse Yaml config and merge with default config.
			const configYaml = await readFile(configPath, 'utf8');
			return parse(configYaml) as Partial<Config>;
		} catch (error) {
			core.error(`Failed to parse YAML config at ${configPath}: ${error}`);
			throw error;
		}
	} else {
		core.info(`No config file found at ${configPath}.`);
		return {};
	}
}

/** Load the action inputs and merge with the yaml & default config. */
async function loadConfig(): Promise<Config> {
	let customMatchers: Record<string, ReportMatcher> | undefined;
	try {
		customMatchers = JSON.parse(core.getInput('custom-matchers') || 'null');
	} catch (error) {
		core.error(`Failed to parse custom-matchers input: ${error}`);
		throw error;
	}
	const alwaysCommentErrorsInput = core.getInput('always-comment-errors');
	const alwaysCommentErrors =
		alwaysCommentErrorsInput.trim() !== ''
			? core.getBooleanInput('always-comment-errors')
			: undefined;
	const commentMethodInput = core.getInput('comment-method');
	const commentMethod: CommentMethod | undefined =
		commentMethodInput === 'minimize' || commentMethodInput === 'update'
			? commentMethodInput
			: undefined;
	const reports = core.getMultilineInput('reports');
	const ignore = core.getMultilineInput('ignore');
	const inputs: Partial<Config> = {
		reports: reports.length > 0 ? reports : undefined,
		ignore: ignore.length > 0 ? ignore : undefined,
		maxAnnotations: core.getInput('max-annotations')
			? parseInt(core.getInput('max-annotations'))
			: undefined,
		customMatchers,
		alwaysCommentErrors,
		commentMethod,
	};
	core.debug(`Parsed inputs: ${JSON.stringify(inputs, null, 2)}`);
	const yamlConfig = await loadYamlConfig();
	core.debug(`Parsed yaml config: ${JSON.stringify(yamlConfig, null, 2)}`);
	// Merge the inputs with the Yaml config and default config without overriding the defaults.
	const config = Object.fromEntries(
		Object.entries(DEFAULT_CONFIG).map(([key, value]) => [
			key,
			inputs[key as keyof Config] ?? yamlConfig[key as keyof Config] ?? value,
		]),
	) as unknown as Config;
	core.debug(`Final config: ${JSON.stringify(config, null, 2)}`);
	return config;
}

/** Parse an XML report using the given matcher. */
async function parseXmlReport(
	file: string,
	matcher: ReportMatcher,
	allAnnotations: PendingAnnotation[],
): Promise<void> {
	try {
		const report = await readFile(file, 'utf8');
		core.debug(`Parsing report:\n${report}`);
		const doc = new DOMParser().parseFromString(report, 'text/xml');
		let items = select(matcher.item, doc);
		if (!Array.isArray(items) && isNodeLike(items)) items = [items];
		if (!isArrayOfNodes(items) || items.length === 0) {
			core.warning(`No items found in ${file} using XPath '${matcher.item}'`);
			return;
		}
		core.debug(`Found ${items.length} items in ${file}.`);

		for (const item of items) {
			try {
				core.debug(`Processing item: ${item}.`);
				const xpath = xpathSelect(item);
				// Figure out the level of the annotation.
				let level: AnnotationLevel = 'error';
				if (matcher.level) {
					for (const [key, path] of Object.entries(matcher.level)) {
						const check = xpath.boolean(path);
						core.debug(`Checking level ${key} with path ${path}: ${check}`);
						if (!check) continue;
						level = key as AnnotationLevel;
						break;
					}
				}
				// Skip if the level is ignore.
				if (level === 'ignore') {
					core.debug('Ignoring item.');
					continue;
				}

				// Create the annotation data.
				const message = xpath.string(matcher.message);

				// Skip annotations with empty messages
				if (!message.trim()) {
					core.debug('Skipping item with empty message.');
					continue;
				}

				const properties = {
					title: matcher.title ? xpath.string(matcher.title) : undefined,
					file: matcher.file ? xpath.string(matcher.file) : undefined,
					startLine: matcher.startLine
						? xpath.number(matcher.startLine)
						: undefined,
					endLine: matcher.endLine ? xpath.number(matcher.endLine) : undefined,
					startColumn: matcher.startColumn
						? xpath.number(matcher.startColumn)
						: undefined,
					endColumn: matcher.endColumn
						? xpath.number(matcher.endColumn)
						: undefined,
				} satisfies core.AnnotationProperties;

				// Make file path relative to workspace
				if (properties.file) {
					const workspace = process.env.GITHUB_WORKSPACE;
					if (workspace && properties.file.startsWith(workspace + '/')) {
						properties.file = properties.file.slice(workspace.length + 1);
					}
				}

				// Ensure annotations have a start line for proper display
				if (!properties.startLine) properties.startLine = 1;

				// Collect non-ignore annotations
				allAnnotations.push({ level, message, properties });
			} catch (error) {
				core.warning(`Failed to process item in ${file}: ${error}`);
				throw error; // Re-throw to fail the action on parsing errors
			}
		}
	} catch (error) {
		core.error(`Failed to parse XML report ${file}: ${error}`);
		throw error;
	}
}
