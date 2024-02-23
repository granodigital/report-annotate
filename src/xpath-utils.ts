import xpath, { type XString, type XBoolean, type Evaluator } from 'xpath';

// Extend xpath types as they are incomplete.
declare module 'xpath' {
	/** A string. */
	export interface XString {
		new (value: string): XString;
		toString(): string;
	}

	/** A boolean. */
	export interface XBoolean {
		new (value: boolean): XBoolean;
		toString(): string;
		booleanValue(): boolean;
	}

	/** A set of nodes. */
	export interface XNodeSet {
		nodes: Node[];
		size: number;
		toString(): string;
	}

	interface EvaluatorOptions {
		node: Node;
		functions: Record<string, (context: unknown, ...args: any[]) => unknown>;
	}

	/** Evaluate the expression and return the result in the requested type. */
	export interface Evaluator {
		evaluateString: (options: EvaluatorOptions) => string;
		evaluateNumber: (options: EvaluatorOptions) => number;
		evaluateBoolean: (options: EvaluatorOptions) => boolean;
	}

	/** Parse the expression and return an evaluator. */
	export function parse(expr: string): Evaluator;
}

/** Additional xpath functions not built-in the xpath module. */
const functions = {
	/** Replace all occurrences of a string with another string. */
	replace(
		_context: unknown,
		input: XString,
		search: XString,
		replace: XString,
	): string {
		return `${input}`.replace(new RegExp(`${search}`), `${replace}`) ?? '';
	},
	/** Match a string against a regular expression and return the first group or empty string. */
	match(_context: unknown, input: XString, pattern: XString): string {
		return `${input}`.match(new RegExp(`${pattern}`))?.[1] ?? '';
	},
	/** Return based on boolean condition */
	if(
		_context: unknown,
		condition: XBoolean,
		then: Node,
		otherwise: Node,
	): Node {
		return condition.booleanValue() ? then : otherwise;
	},
	/** Trim & collapse whitespace from the input string, except newlines. */
	normalize(_context: unknown, input: XString): string {
		return `${input}`.replaceAll(/^\s+|\s+$/gm, '');
	},
};

/** Utility to select items from a Node with extra functions like `replace`. */
export const xpathSelect = (node: Node) => ({
	/** Parse the expression and return an evaluator. */
	parse(expression: string): Evaluator {
		try {
			return xpath.parse(expression);
		} catch (error) {
			// Xpath does not show the expression in the error message.
			const msg = error instanceof Error ? error.message : 'Unknown error';
			throw new Error(`Error parsing xpath expression "${expression}": ${msg}`);
		}
	},
	/** Evaluate the expression and return the result as a string. */
	string(expression: string): string {
		return this.parse(expression).evaluateString({ node, functions });
	},
	/** Evaluate the expression and return the result as a number. */
	number(expression: string): number {
		return this.parse(expression).evaluateNumber({ node, functions });
	},
	/** Evaluate the expression and return the result as a boolean. */
	boolean(expression: string): boolean {
		return this.parse(expression).evaluateBoolean({ node, functions });
	},
});

// Re-export the xpath module with the extended types and functions.
export * from 'xpath';
