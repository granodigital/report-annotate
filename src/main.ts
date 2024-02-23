import * as core from '@actions/core';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { glob } from 'glob';
import { junitEslintMatcher } from './matchers/junit-eslint';
import { DOMParser } from '@xmldom/xmldom';
import { isArrayOfNodes, isNodeLike, select, xpathSelect } from './xpath-utils';
import { junitMatcher } from './matchers/junit';
import { junitJestMatcher } from './matchers/junit-jest';

const DEFAULT_CONFIG_PATH = '.github/report-annotate.yml';
const DEFAULT_CONFIG: Partial<Config> = {
	reports: ['junit|junit/*.xml'],
	ignore: ['node_modules/**', 'dist/**'],
	maxAnnotations: 50,
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
	/** Maximum number of annotations to create. */
	maxAnnotations: number;
	/** Custom matchers for parsing reports. */
	customMatchers: Record<string, ReportMatcher>;
}

type AnnotationLevel = 'notice' | 'warning' | 'error' | 'ignore';

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

		const reportMatcherPatterns = config.reports.map(report => {
			const [matcher, patterns] = report.split('|');
			return { matcher, patterns: patterns.split(',') };
		});
		const reportFiles = new Map<string, Set<string>>();
		for (const { matcher, patterns } of reportMatcherPatterns) {
			core.startGroup(`Finding ${matcher} reports`);
			const files = await globFiles(patterns, config, matcher);
			if (files.size === 0) {
				core.warning(
					`No reports found for ${matcher} using patterns ${patterns}`,
				);
				continue;
			}
			reportFiles.set(matcher, files);
			core.endGroup();
		}

		const tally = { errors: 0, warnings: 0, notices: 0, total: 0 };
		let maxAnnotationsReached = false;

		for (const [matcherName, files] of reportFiles) {
			const matcher = reportMatchers[matcherName];
			if (!matcher) throw new Error(`No matcher found for ${matcherName}`);

			core.startGroup(`Parsing ${matcherName} reports`);
			for (const file of files) {
				core.debug(`Parsing ${file}`);
				switch (matcher.format) {
					case 'xml':
						maxAnnotationsReached = await parseXmlReport(
							file,
							matcher,
							tally,
							config.maxAnnotations,
						);
						break;
					default:
						throw new Error(
							`Unsupported matcher format in ${matcherName}: ${matcher.format}`,
						);
				}
				if (maxAnnotationsReached) break;
			}
			core.endGroup();
			if (maxAnnotationsReached) break;
		}
		if (maxAnnotationsReached)
			core.warning(
				`Maximum number of annotations reached (${config.maxAnnotations})`,
			);
		// Set outputs for other workflow steps to use.
		core.setOutput('errors', tally.errors);
		core.setOutput('warnings', tally.warnings);
		core.setOutput('notices', tally.notices);
		core.setOutput('total', tally.total);
	} catch (error) {
		if (error instanceof Error) core.setFailed(error);
		throw error;
	}
}

async function globFiles(
	patterns: string[],
	config: Config,
	matcher: string,
): Promise<Set<string>> {
	const reportFiles = new Set<string>();
	for (const pattern of patterns) {
		const files = await glob(pattern, { ignore: config.ignore });
		for (const file of files) reportFiles.add(file);
	}
	core.debug(`Found ${reportFiles.size} files for matcher ${matcher}`);
	return reportFiles;
}

/** Load the Yaml config file. */
async function loadYamlConfig(): Promise<Partial<Config>> {
	const configPath: string = core.getInput('configPath') ?? DEFAULT_CONFIG_PATH;
	if (existsSync(configPath)) {
		core.info(`Using config file at ${configPath}`);
		// Parse Yaml config and merge with default config.
		const configYaml = await readFile(configPath, 'utf8');
		return parse(configYaml) as Partial<Config>;
	} else {
		core.info(`No config file found at ${configPath}.`);
		return {};
	}
}

/** Load the action inputs and merge with the yaml & default config. */
async function loadConfig(): Promise<Config> {
	const inputs: Partial<Config> = {
		reports: core.getMultilineInput('reports'),
		ignore: core.getMultilineInput('ignore'),
		maxAnnotations: core.getInput('maxAnnotations')
			? parseInt(core.getInput('maxAnnotations'))
			: undefined,
		customMatchers: JSON.parse(core.getInput('customMatchers') ?? 'null'),
	};
	const yamlConfig = await loadYamlConfig();
	// Merge the inputs with the Yaml config and default config without overriding the defaults.
	const config = Object.fromEntries(
		Object.entries(DEFAULT_CONFIG).map(([key, value]) => [
			key,
			inputs[key as keyof Config] ?? yamlConfig[key as keyof Config] ?? value,
		]),
	) as unknown as Config;
	core.debug(`Parsed config: ${JSON.stringify(config, null, 2)}`);
	return config;
}

/** Parse an XML report using the given matcher. */
async function parseXmlReport(
	file: string,
	matcher: ReportMatcher,
	tally: Record<'errors' | 'warnings' | 'notices' | 'total', number>,
	maxAnnotations: number,
): Promise<boolean> {
	const report = await readFile(file, 'utf8');
	const doc = new DOMParser().parseFromString(report, 'text/xml');
	let items = select(matcher.item, doc);
	if (!Array.isArray(items) && isNodeLike(items)) items = [items];
	if (!isArrayOfNodes(items)) {
		core.warning(`No items found in ${file}`);
		return false;
	}

	for (const item of items) {
		core.debug(
			`Processing item ${tally.total + 1}/${maxAnnotations}: ${item}.`,
		);
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
		// Create the annotation.
		const message = xpath.string(matcher.message);
		const annotation = {
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
		core[level](message, annotation);

		// Count the annotations for the output.
		if (level === 'error') tally.errors++;
		if (level === 'warning') tally.warnings++;
		if (level === 'notice') tally.notices++;
		tally.total++;
		if (tally.total >= maxAnnotations) return true;
	}
	return false;
}
