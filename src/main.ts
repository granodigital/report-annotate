import * as core from '@actions/core';
import * as github from '@actions/github';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
};

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
}

type AnnotationLevel = 'notice' | 'warning' | 'error' | 'ignore';

interface PendingAnnotation {
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
		await processAnnotations(allAnnotations, config);
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

/** Process and create annotations with limits. */
async function processAnnotations(
	allAnnotations: PendingAnnotation[],
	config: Config,
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

	// Apply the per-type annotation limits to respect GitHub Actions limits
	const maxPerType = config.maxAnnotations;
	const errors = allAnnotations
		.filter(a => a.level === 'error')
		.slice(0, maxPerType);
	const warnings = allAnnotations
		.filter(a => a.level === 'warning')
		.slice(0, maxPerType);
	const notices = allAnnotations
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

	// Collect skipped annotations
	const skippedErrors = allAnnotations
		.filter(a => a.level === 'error')
		.slice(maxPerType);
	const skippedWarnings = allAnnotations
		.filter(a => a.level === 'warning')
		.slice(maxPerType);
	const skippedNotices = allAnnotations
		.filter(a => a.level === 'notice')
		.slice(maxPerType);

	// Warn if any annotations were skipped due to per-type limits
	const totalSkipped =
		skippedErrors.length + skippedWarnings.length + skippedNotices.length;
	if (totalSkipped > 0) {
		core.warning(
			`Maximum number of annotations per type reached (${maxPerType}). ${totalSkipped} annotations were not shown.`,
		);
		await createSkippedAnnotationsComment(
			skippedErrors,
			skippedWarnings,
			skippedNotices,
			maxPerType,
		);
	}
	// Set outputs for other workflow steps to use.
	core.setOutput('errors', tally.errors);
	core.setOutput('warnings', tally.warnings);
	core.setOutput('notices', tally.notices);
	core.setOutput('total', tally.total);
}

/** Create a PR comment with skipped annotations. */
async function createSkippedAnnotationsComment(
	skippedErrors: PendingAnnotation[],
	skippedWarnings: PendingAnnotation[],
	skippedNotices: PendingAnnotation[],
	maxPerType: number,
): Promise<void> {
	// Only create comment if running on a pull request
	if (!github.context.payload.pull_request) {
		core.info('Not running on a pull request, skipping comment creation.');
		return;
	}

	const octokit = github.getOctokit(
		core.getInput('token') || process.env.GITHUB_TOKEN!,
	);
	const { owner, repo } = github.context.repo;
	const pullNumber = github.context.payload.pull_request.number;
	const baseUrl = `https://github.com/${owner}/${repo}/pull/${pullNumber}/files`;

	// Minimize previous bot comments before adding a new one
	await minimizePreviousBotComments(octokit, owner, repo, pullNumber);

	let commentBody = '## Skipped Annotations\n\n';
	commentBody += `The maximum number of annotations per type (${maxPerType}) was reached. Here are the additional annotations that were not displayed:\n\n`;

	commentBody += generateAnnotationSection('ERROR', skippedErrors, baseUrl);
	commentBody += generateAnnotationSection('WARNING', skippedWarnings, baseUrl);
	commentBody += generateAnnotationSection('NOTE', skippedNotices, baseUrl);

	try {
		await octokit.rest.issues.createComment({
			owner,
			repo,
			issue_number: pullNumber,
			body: commentBody,
		});
		core.info('Created PR comment with skipped annotations.');
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
): Promise<void> {
	try {
		// Fetch all comments on the PR, handling pagination
		const allComments: Array<{
			id: number;
			node_id: string;
			body?: string;
		}> = [];
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

		// Filter for bot comments (comments created by this action)
		const botComments = allComments.filter(comment =>
			comment.body?.startsWith('## Skipped Annotations'),
		);

		if (botComments.length === 0) {
			core.debug('No previous bot comments to minimize.');
			return;
		}

		core.debug(
			`Found ${botComments.length} previous bot comments to minimize.`,
		);

		// Minimize each bot comment
		for (const comment of botComments) {
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

/** Generate a comment section for a specific annotation level. */
function generateAnnotationSection(
	levelName: string,
	annotations: PendingAnnotation[],
	baseUrl: string,
): string {
	if (annotations.length === 0) return '';

	const noteType = `[!${levelName}]`;
	let section = `> ${noteType}\n`;
	for (const annotation of annotations) {
		let message = annotation.message.replace(/@\w+/g, '`$&`');
		let line = `> ${message}`;
		if (annotation.properties.file && annotation.properties.startLine) {
			const location = `${annotation.properties.file}#L${annotation.properties.startLine}`;
			const link = `${baseUrl}/${location}`;
			line = `> [${location}](${link}) ${message}`;
		}
		section += `${line}\n`;
	}
	section += '\n';
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
	const inputs: Partial<Config> = {
		reports: core.getMultilineInput('reports'),
		ignore: core.getMultilineInput('ignore'),
		maxAnnotations: core.getInput('max-annotations')
			? parseInt(core.getInput('max-annotations'))
			: undefined,
		customMatchers,
	};
	core.debug(`Parsed inputs: ${JSON.stringify(inputs, null, 2)}`);
	const yamlConfig = await loadYamlConfig();
	core.debug(`Parsed yaml config: ${JSON.stringify(yamlConfig, null, 2)}`);
	// Merge the inputs with the Yaml config and default config without overriding the defaults.
	const config = Object.fromEntries(
		Object.entries(DEFAULT_CONFIG).map(([key, value]) => [
			key,
			inputs[key as keyof Config] || yamlConfig[key as keyof Config] || value,
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
