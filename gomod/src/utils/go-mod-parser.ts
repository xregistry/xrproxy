import {
    GoExcludeDirective,
    GoReplaceDirective,
    GoRequireDirective,
    GoRetractDirective,
    ParsedGoMod,
} from '../types/go';

type BlockDirective = 'require' | 'replace' | 'exclude' | 'retract' | 'godebug' | 'tool' | 'ignore';

function splitLineComment(line: string): { content: string; comment?: string } {
    const idx = line.indexOf('//');
    if (idx < 0) {
        return { content: line.trim() };
    }
    return {
        content: line.slice(0, idx).trim(),
        comment: line.slice(idx + 2).trim(),
    };
}

function ensureArray<T>(current: T[] | undefined): T[] {
    return current ?? [];
}

function parseRequire(content: string, comment?: string): GoRequireDirective | null {
    const parts = content.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return null;
    return {
        path: parts[0],
        version: parts[1],
        ...(comment === 'indirect' ? { indirect: true } : {}),
    };
}

function parseReplace(content: string): GoReplaceDirective | null {
    const parts = content.split(/\s*=>\s*/);
    if (parts.length !== 2) return null;

    const [oldSide, newSide] = parts;
    const oldTokens = oldSide.trim().split(/\s+/).filter(Boolean);
    const newTokens = newSide.trim().split(/\s+/).filter(Boolean);
    if (oldTokens.length === 0 || newTokens.length === 0) return null;

    return {
        old_path: oldTokens[0],
        ...(oldTokens[1] ? { old_version: oldTokens[1] } : {}),
        new_path: newTokens[0],
        ...(newTokens[1] ? { new_version: newTokens[1] } : {}),
    };
}

function parseExclude(content: string): GoExcludeDirective | null {
    const parts = content.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return null;
    return {
        path: parts[0],
        version: parts[1],
    };
}

function parseRetract(content: string, comment?: string): GoRetractDirective | null {
    const trimmed = content.trim();
    if (!trimmed) return null;

    const rangeMatch = trimmed.match(/^\[\s*([^,\s]+)\s*,\s*([^\]\s]+)\s*\]$/);
    if (rangeMatch) {
        return {
            low: rangeMatch[1],
            high: rangeMatch[2],
            ...(comment ? { rationale: comment } : {}),
        };
    }

    return {
        low: trimmed,
        high: trimmed,
        ...(comment ? { rationale: comment } : {}),
    };
}

function parseGoDebug(content: string): { key: string; value: string } | null {
    const match = content.match(/^([^=\s]+)\s*=\s*(.+)$/);
    if (!match) return null;
    return { key: match[1], value: match[2].trim() };
}

function parseDirectiveLine(result: ParsedGoMod, directive: BlockDirective, line: string): void {
    const { content, comment } = splitLineComment(line);
    if (!content) return;

    switch (directive) {
        case 'require': {
            const entry = parseRequire(content, comment);
            if (!entry) return;
            result.require = ensureArray(result.require);
            result.require.push(entry);
            return;
        }
        case 'replace': {
            const entry = parseReplace(content);
            if (!entry) return;
            result.replace = ensureArray(result.replace);
            result.replace.push(entry);
            return;
        }
        case 'exclude': {
            const entry = parseExclude(content);
            if (!entry) return;
            result.exclude = ensureArray(result.exclude);
            result.exclude.push(entry);
            return;
        }
        case 'retract': {
            const entry = parseRetract(content, comment);
            if (!entry) return;
            result.retract = ensureArray(result.retract);
            result.retract.push(entry);
            return;
        }
        case 'godebug': {
            const entry = parseGoDebug(content);
            if (!entry) return;
            result.godebug = result.godebug ?? {};
            result.godebug[entry.key] = entry.value;
            return;
        }
        case 'tool': {
            result.tool = ensureArray(result.tool);
            result.tool.push(content.trim());
            return;
        }
        case 'ignore': {
            result.ignore = ensureArray(result.ignore);
            result.ignore.push(content.trim());
            return;
        }
    }
}

export function parseGoMod(text: string): ParsedGoMod {
    const result: ParsedGoMod = {};
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let block: BlockDirective | null = null;
    let pendingComments: string[] = [];

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();

        if (!trimmed) {
            if (!block) pendingComments = [];
            continue;
        }

        if (trimmed.startsWith('//')) {
            if (!block) pendingComments.push(trimmed.slice(2).trim());
            continue;
        }

        if (trimmed === ')') {
            block = null;
            pendingComments = [];
            continue;
        }

        const blockStart = trimmed.match(/^(require|replace|exclude|retract|godebug|tool|ignore)\s*\($/);
        if (blockStart) {
            block = blockStart[1] as BlockDirective;
            pendingComments = [];
            continue;
        }

        if (block) {
            parseDirectiveLine(result, block, trimmed);
            continue;
        }

        const { content, comment } = splitLineComment(trimmed);
        if (!content) {
            pendingComments = [];
            continue;
        }

        if (content.startsWith('module ')) {
            const deprecated = pendingComments.find((entry) => entry.startsWith('Deprecated:'));
            if (deprecated) {
                const message = deprecated.slice('Deprecated:'.length).trim();
                if (message) result.deprecatedMessage = message;
            }
            pendingComments = [];
            continue;
        }

        if (content.startsWith('go ')) {
            result.goVersion = content.slice(3).trim();
            pendingComments = [];
            continue;
        }

        if (content.startsWith('toolchain ')) {
            result.toolchain = content.slice('toolchain '.length).trim();
            pendingComments = [];
            continue;
        }

        if (content.startsWith('require ')) {
            parseDirectiveLine(result, 'require', content.slice('require '.length) + (comment ? ` // ${comment}` : ''));
            pendingComments = [];
            continue;
        }

        if (content.startsWith('replace ')) {
            parseDirectiveLine(result, 'replace', content.slice('replace '.length));
            pendingComments = [];
            continue;
        }

        if (content.startsWith('exclude ')) {
            parseDirectiveLine(result, 'exclude', content.slice('exclude '.length));
            pendingComments = [];
            continue;
        }

        if (content.startsWith('retract ')) {
            parseDirectiveLine(result, 'retract', content.slice('retract '.length) + (comment ? ` // ${comment}` : ''));
            pendingComments = [];
            continue;
        }

        if (content.startsWith('godebug ')) {
            parseDirectiveLine(result, 'godebug', content.slice('godebug '.length));
            pendingComments = [];
            continue;
        }

        if (content.startsWith('tool ')) {
            parseDirectiveLine(result, 'tool', content.slice('tool '.length));
            pendingComments = [];
            continue;
        }

        if (content.startsWith('ignore ')) {
            parseDirectiveLine(result, 'ignore', content.slice('ignore '.length));
            pendingComments = [];
            continue;
        }

        pendingComments = [];
    }

    return result;
}
