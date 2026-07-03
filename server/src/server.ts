import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    TextDocumentSyncKind,
    InitializeResult,
    HoverParams,
    Hover,
    DefinitionParams,
    Definition,
    Location,
    DocumentSymbol,
    DocumentSymbolParams,
    SymbolKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { exec } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { promisify } from 'util';
import * as path from 'path';
import { HirPayload, CompilerError } from './types';
import * as fs from 'fs';
import { LineIndex } from './position';

const execPromise = promisify(exec);
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const OUTPUT_FILE = './build/temp_output.json';

let lastReportedUris: Set<string> = new Set();

interface SpanLike {
    start: number;
    end: number;
    path: string;
}

interface CursorNode {
    node: Record<string, unknown>;
    span: SpanLike;
    parent: CursorNode | null;
    key: string | null;
}

interface IndexedSymbol {
    name: string;
    kind: SymbolKind;
    containerName: string | null;
    uri: string;
    range: SpanLike;
    selectionRange: SpanLike;
    detail?: string;
    documentation?: string;
}

interface IndexedFunction extends IndexedSymbol {
    locals: IndexedSymbol[];
    params: IndexedSymbol[];
}

interface AtlasIndex {
    functions: IndexedFunction[];
    symbolsByName: Map<string, IndexedSymbol[]>;
    membersByContainerAndName: Map<string, IndexedSymbol[]>;
}

interface ResolvedTarget {
    name: string;
    kind: SymbolKind;
    uri: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
    detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSpan(value: unknown): SpanLike | null {
    if (!isRecord(value)) return null;
    const start = value.start;
    const end = value.end;
    const spanPath = value.path;
    if (typeof start !== 'number' || typeof end !== 'number' || typeof spanPath !== 'string') {
        return null;
    }
    return { start, end, path: spanPath };
}

function normalizePath(filePath: string): string {
    return path.resolve(filePath).toLowerCase();
}

function spanMatchesDocument(span: SpanLike, normalizedPath: string): boolean {
    return normalizePath(span.path) === normalizedPath;
}

function spanToUri(span: SpanLike): string {
    return pathToFileURL(path.isAbsolute(span.path) ? span.path : path.resolve(span.path)).toString();
}

function rangeForSpan(span: SpanLike): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
    const uri = spanToUri(span);
    const openDoc = documents.get(uri);
    if (openDoc) {
        return {
            start: openDoc.positionAt(span.start),
            end: openDoc.positionAt(span.end),
        };
    }

    const absolutePath = fileURLToPath(uri);
    if (!fs.existsSync(absolutePath)) {
        return null;
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    return new LineIndex(content).spanToRange(span.start, span.end);
}

function createSymbol(
    name: string,
    kind: SymbolKind,
    span: SpanLike,
    selectionSpan: SpanLike = span,
    containerName: string | null = null,
    detail?: string,
    documentation?: string,
): IndexedSymbol {
    return {
        name,
        kind,
        containerName,
        uri: spanToUri(span),
        range: span,
        selectionRange: selectionSpan,
        detail,
        documentation,
    };
}

function addSymbol(index: AtlasIndex, symbol: IndexedSymbol): void {
    const byName = index.symbolsByName.get(symbol.name) ?? [];
    byName.push(symbol);
    index.symbolsByName.set(symbol.name, byName);

    if (symbol.containerName) {
        const members = index.membersByContainerAndName.get(`${symbol.containerName}::${symbol.name}`) ?? [];
        members.push(symbol);
        index.membersByContainerAndName.set(`${symbol.containerName}::${symbol.name}`, members);
    }
}

function compileAtlasProject(): Promise<HirPayload> {
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    return execPromise(`atlas77 to-json -o ${OUTPUT_FILE}`).then(() => {
        const fileContent = fs.readFileSync(OUTPUT_FILE, 'utf-8');
        return JSON.parse(fileContent) as HirPayload;
    });
}

function getDiagnosticSeverity(kind: string): DiagnosticSeverity {
    switch (kind) {
        case 'warning':
            return DiagnosticSeverity.Warning;
        case 'error':
            return DiagnosticSeverity.Error;
        case 'note':
            return DiagnosticSeverity.Information;
        default:
            return DiagnosticSeverity.Hint;
    }
}

function indexFunctionLike(
    index: AtlasIndex,
    fnDecl: Record<string, unknown>,
    fallbackName: string,
    containerName: string | null,
    kind: SymbolKind,
): void {
    const span = getSpan(fnDecl.span);
    if (!span) return;

    const name = typeof fnDecl.name === 'string' ? fnDecl.name : fallbackName;
    const selectionSpan = getSpan(fnDecl.name_span) ?? span;
    const fnSymbol: IndexedFunction = {
        name,
        kind,
        containerName,
        uri: spanToUri(span),
        range: span,
        selectionRange: selectionSpan,
        locals: [],
        params: [],
    };

    index.functions.push(fnSymbol);
    addSymbol(index, fnSymbol);

    const signature = (isRecord(fnDecl.signature) ? fnDecl.signature : fnDecl) as Record<string, unknown>;
    indexParams(index, signature.params, fnSymbol);

    if (isRecord(fnDecl.body)) {
        collectLocalDeclarations(index, fnDecl.body, fnSymbol);
    }
}

function indexParams(index: AtlasIndex, params: unknown, fnSymbol: IndexedFunction): void {
    if (!Array.isArray(params)) return;

    for (const param of params) {
        if (!isRecord(param)) continue;
        const span = getSpan(param.span);
        const name = typeof param.name === 'string' ? param.name : null;
        if (!span || !name) continue;

        const symbol = createSymbol(name, SymbolKind.Variable, span, getSpan(param.name_span) ?? span, fnSymbol.name);
        fnSymbol.params.push(symbol);
        addSymbol(index, symbol);
    }
}

function indexNamedMembers(index: AtlasIndex, members: unknown, containerName: string, kind: SymbolKind): void {
    if (!members) return;

    if (Array.isArray(members)) {
        for (const member of members) {
            if (!isRecord(member)) continue;
            const span = getSpan(member.span);
            const name = typeof member.name === 'string' ? member.name : null;
            if (!span || !name) continue;

            const symbol = createSymbol(name, kind, span, getSpan(member.name_span) ?? span, containerName, undefined, member.docstring as string | undefined);
            addSymbol(index, symbol);

            if (kind === SymbolKind.Method && isRecord(member.body)) {
                const fnSymbol: IndexedFunction = {
                    name,
                    kind,
                    containerName,
                    uri: spanToUri(span),
                    range: span,
                    selectionRange: getSpan(member.name_span) ?? span,
                    locals: [],
                    params: [],
                };
                index.functions.push(fnSymbol);
                addSymbol(index, fnSymbol);
                collectLocalDeclarations(index, member.body, fnSymbol);
            }
        }
        return;
    }

    if (!isRecord(members)) return;

    for (const [memberKey, memberValue] of Object.entries(members)) {
        if (!isRecord(memberValue)) continue;
        const span = getSpan(memberValue.span);
        if (!span) continue;

        const name = typeof memberValue.name === 'string' ? memberValue.name : memberKey;
        const symbol = createSymbol(name, kind, span, getSpan(memberValue.name_span) ?? span, containerName, undefined, memberValue.docstring as string | undefined);
        addSymbol(index, symbol);

        if (kind === SymbolKind.Method && isRecord(memberValue.body)) {
            const fnSymbol: IndexedFunction = {
                name,
                kind,
                containerName,
                uri: spanToUri(span),
                range: span,
                selectionRange: getSpan(memberValue.name_span) ?? span,
                locals: [],
                params: [],
            };
            index.functions.push(fnSymbol);
            addSymbol(index, fnSymbol);
            collectLocalDeclarations(index, memberValue.body, fnSymbol);
        }
    }
}

function indexOperators(index: AtlasIndex, operators: unknown, containerName: string): void {
    if (!operators) return;

    if (Array.isArray(operators)) {
        for (const operatorDecl of operators) {
            if (!isRecord(operatorDecl)) continue;
            const span = getSpan(operatorDecl.span);
            if (!span) continue;

            const name = typeof operatorDecl.name === 'string' ? operatorDecl.name : 'operator';
            const symbol = createSymbol(name, SymbolKind.Method, span, getSpan(operatorDecl.name_span) ?? span, containerName, `operator ${name}`, operatorDecl.docstring as string | undefined);
            addSymbol(index, symbol);
        }
        return;
    }

    if (!isRecord(operators)) return;

    for (const [operatorKey, operatorValue] of Object.entries(operators)) {
        if (!isRecord(operatorValue)) continue;
        const span = getSpan(operatorValue.span);
        if (!span) continue;

        const symbol = createSymbol(operatorKey, SymbolKind.Method, span, getSpan(operatorValue.name_span) ?? span, containerName, `operator ${operatorKey}`, operatorValue.docstring as string | undefined);
        addSymbol(index, symbol);

        if (isRecord(operatorValue.body)) {
            const fnSymbol: IndexedFunction = {
                name: operatorKey,
                kind: SymbolKind.Method,
                containerName,
                uri: spanToUri(span),
                range: span,
                selectionRange: getSpan(operatorValue.name_span) ?? span,
                locals: [],
                params: [],
            };
            index.functions.push(fnSymbol);
            addSymbol(index, fnSymbol);
            collectLocalDeclarations(index, operatorValue.body, fnSymbol);
        }
    }
}

function indexTypeLike(index: AtlasIndex, typeDecl: Record<string, unknown>, fallbackName: string, kind: SymbolKind): void {
    const span = getSpan(typeDecl.span);
    if (!span) return;

    const name = typeof typeDecl.name === 'string' ? typeDecl.name : fallbackName;
    addSymbol(index, createSymbol(name, kind, span, getSpan(typeDecl.name_span) ?? span, null, undefined, typeDecl.docstring as string | undefined));

    const signature = (isRecord(typeDecl.signature) ? typeDecl.signature : typeDecl) as Record<string, unknown>;
    indexNamedMembers(index, signature.fields, name, SymbolKind.Field);
    indexNamedMembers(index, signature.methods, name, SymbolKind.Method);
    indexOperators(index, signature.operators, name);
    indexNamedMembers(index, signature.variants, name, SymbolKind.EnumMember);
}

function buildAtlasIndex(payload: HirPayload): AtlasIndex {
    const index: AtlasIndex = {
        functions: [],
        symbolsByName: new Map(),
        membersByContainerAndName: new Map(),
    };

    const body = payload.hir?.body as Record<string, unknown> | undefined;
    if (!body) return index;

    const functionEntries = body.functions as Record<string, unknown> | undefined;
    if (functionEntries) {
        for (const [declKey, declValue] of Object.entries(functionEntries)) {
            if (isRecord(declValue)) {
                indexFunctionLike(index, declValue, declKey, null, SymbolKind.Function);
            }
        }
    }

    const structEntries = body.structs as Record<string, unknown> | undefined;
    if (structEntries) {
        for (const [declKey, declValue] of Object.entries(structEntries)) {
            if (isRecord(declValue)) {
                indexTypeLike(index, declValue, declKey, SymbolKind.Class);
            }
        }
    }

    const unionEntries = body.unions as Record<string, unknown> | undefined;
    if (unionEntries) {
        for (const [declKey, declValue] of Object.entries(unionEntries)) {
            if (isRecord(declValue)) {
                indexTypeLike(index, declValue, declKey, SymbolKind.Class);
            }
        }
    }

    const enumEntries = body.enums as Record<string, unknown> | undefined;
    if (enumEntries) {
        for (const [declKey, declValue] of Object.entries(enumEntries)) {
            if (isRecord(declValue)) {
                indexTypeLike(index, declValue, declKey, SymbolKind.Enum);
            }
        }
    }

    return index;
}

function collectLocalDeclarations(index: AtlasIndex, body: Record<string, unknown>, fnSymbol: IndexedFunction): void {
    const statements = body.statements;
    if (!Array.isArray(statements)) return;

    for (const statement of statements) {
        collectLocalDeclarationsFromNode(index, statement, fnSymbol);
    }
}

function collectLocalDeclarationsFromNode(index: AtlasIndex, node: unknown, fnSymbol: IndexedFunction): void {
    if (Array.isArray(node)) {
        for (const item of node) {
            collectLocalDeclarationsFromNode(index, item, fnSymbol);
        }
        return;
    }

    if (!isRecord(node)) return;

    const letNode = node.Let;
    if (isRecord(letNode)) {
        const span = getSpan(letNode.span);
        const name = typeof letNode.name === 'string' ? letNode.name : null;
        if (span && name) {
            const symbol = createSymbol(name, SymbolKind.Variable, span, getSpan(letNode.name_span) ?? span, fnSymbol.name, undefined, letNode.docstring as string | undefined);
            fnSymbol.locals.push(symbol);
            addSymbol(index, symbol);
        }
    }

    for (const [key, value] of Object.entries(node)) {
        if (key === 'span' || key === 'name_span' || key === 'ty_span' || key === 'op_span' || key === 'return_ty_span' || key === 'Let') {
            continue;
        }
        collectLocalDeclarationsFromNode(index, value, fnSymbol);
    }
}

function nodeSpanLength(span: SpanLike): number {
    return span.end - span.start;
}

function findNodeAtOffset(payload: HirPayload, offset: number, normalizedPath: string): CursorNode | null {
    const body = payload.hir?.body as Record<string, unknown> | undefined;
    if (!body) return null;

    const roots: unknown[] = [];

    const addRoots = (entries: unknown): void => {
        if (!isRecord(entries)) return;
        for (const value of Object.values(entries)) {
            const span = getSpan(isRecord(value) ? value.span : null);
            if (span && spanMatchesDocument(span, normalizedPath)) {
                roots.push(value);
            }
        }
    };

    addRoots(body.functions);
    addRoots(body.structs);
    addRoots(body.unions);
    addRoots(body.enums);

    let best: CursorNode | null = null;
    for (const root of roots) {
        const match = findBestNode(root, offset, normalizedPath, null, null);
        if (!match) continue;
        if (!best || nodeSpanLength(match.span) < nodeSpanLength(best.span)) {
            best = match;
        }
    }

    return best;
}

function findBestNode(node: unknown, offset: number, normalizedPath: string, parent: CursorNode | null, key: string | null): CursorNode | null {
    if (Array.isArray(node)) {
        let best: CursorNode | null = null;
        for (const item of node) {
            const match = findBestNode(item, offset, normalizedPath, parent, key);
            if (!match) continue;
            if (!best || nodeSpanLength(match.span) < nodeSpanLength(best.span)) {
                best = match;
            }
        }
        return best;
    }

    if (!isRecord(node)) return null;

    const span = getSpan(node.span);
    const current = span && spanMatchesDocument(span, normalizedPath) && offset >= span.start && offset <= span.end
        ? { node, span, parent, key }
        : null;

    let best = current;
    const nextParent = current ?? parent;

    for (const [childKey, childValue] of Object.entries(node)) {
        if (childKey === 'span' || childKey === 'name_span' || childKey === 'ty_span' || childKey === 'op_span' || childKey === 'return_ty_span') {
            continue;
        }
        const match = findBestNode(childValue, offset, normalizedPath, nextParent, childKey);
        if (!match) continue;
        if (!best || nodeSpanLength(match.span) < nodeSpanLength(best.span)) {
            best = match;
        }
    }

    return best;
}

function findAncestor(node: CursorNode | null, predicate: (candidate: CursorNode) => boolean): CursorNode | null {
    let current = node?.parent ?? null;
    while (current) {
        if (predicate(current)) {
            return current;
        }
        current = current.parent;
    }
    return null;
}

function getNodeName(node: Record<string, unknown>): string | null {
    return typeof node.name === 'string' ? node.name : null;
}

function getTypeName(typeNode: unknown): string | null {
    if (!isRecord(typeNode)) return null;
    if (isRecord(typeNode.Named) && typeof typeNode.Named.name === 'string') return typeNode.Named.name;
    if (isRecord(typeNode.Generic) && typeof typeNode.Generic.name === 'string') return typeNode.Generic.name;
    if (isRecord(typeNode.PtrTy)) return getTypeName(typeNode.PtrTy.inner);
    if (isRecord(typeNode.Slice)) return getTypeName(typeNode.Slice.inner);
    if (isRecord(typeNode.InlineArray)) return getTypeName(typeNode.InlineArray.inner);
    return null;
}

function getTypeNameFromExpression(node: unknown): string | null {
    if (!isRecord(node)) return null;
    const directType = getTypeName(node.ty);
    if (directType) return directType;
    for (const key of ['expr', 'value', 'target', 'lhs', 'rhs', 'callee'] as const) {
        const nestedType = getTypeNameFromExpression(node[key]);
        if (nestedType) return nestedType;
    }
    return null;
}

function findSymbolByName(index: AtlasIndex, name: string, predicate?: (symbol: IndexedSymbol) => boolean): IndexedSymbol | null {
    const symbols = index.symbolsByName.get(name);
    if (!symbols || symbols.length === 0) return null;
    if (!predicate) return symbols[0];
    return symbols.find(predicate) ?? null;
}

function findMemberByContainer(index: AtlasIndex, containerName: string, memberName: string): IndexedSymbol | null {
    return index.membersByContainerAndName.get(`${containerName}::${memberName}`)?.[0] ?? null;
}

function findEnclosingFunction(index: AtlasIndex, normalizedPath: string, offset: number): IndexedFunction | null {
    let best: IndexedFunction | null = null;
    for (const fn of index.functions) {
        if (!spanMatchesDocument(fn.range, normalizedPath)) continue;
        if (offset < fn.range.start || offset > fn.range.end) continue;
        if (!best || nodeSpanLength(fn.range) < nodeSpanLength(best.range)) {
            best = fn;
        }
    }
    return best;
}

function findBestLocal(fn: IndexedFunction, name: string, offset: number): IndexedSymbol | null {
    const locals = [...fn.params, ...fn.locals].filter(symbol => symbol.name === name);
    let best: IndexedSymbol | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const symbol of locals) {
        if (symbol.range.start > offset) continue;
        const distance = offset - symbol.range.start;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = symbol;
        }
    }

    return best;
}

function symbolToResolvedTarget(symbol: IndexedSymbol): ResolvedTarget {
    const range = rangeForSpan(symbol.range) ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
    };
    const selectionRange = rangeForSpan(symbol.selectionRange) ?? range;
    return {
        name: symbol.name,
        kind: symbol.kind,
        uri: symbol.uri,
        range,
        selectionRange,
        detail: symbol.detail,
    };
}

function symbolKindLabel(kind: SymbolKind): string {
    switch (kind) {
        case SymbolKind.Class:
            return 'Class';
        case SymbolKind.Enum:
            return 'Enum';
        case SymbolKind.EnumMember:
            return 'Enum member';
        case SymbolKind.Field:
            return 'Field';
        case SymbolKind.Function:
            return 'Function';
        case SymbolKind.Method:
            return 'Method';
        case SymbolKind.Variable:
            return 'Variable';
        default:
            return 'Symbol';
    }
}

function resolveMemberContext(index: AtlasIndex, cursorNode: CursorNode): ResolvedTarget | null {
    const nodeName = getNodeName(cursorNode.node);
    if (!nodeName) return null;

    const accessAncestor = findAncestor(cursorNode, candidate => {
        const candidateNode = candidate.node;
        return isRecord(candidateNode) && candidateNode.field === cursorNode.node && ('target' in candidateNode || 'ty' in candidateNode);
    });

    if (accessAncestor && isRecord(accessAncestor.node)) {
        const targetType = getTypeNameFromExpression(accessAncestor.node.target) ?? getTypeName(accessAncestor.node.target);
        if (targetType) {
            const match = findSymbolByName(index, `${targetType}::${nodeName}`) ?? findMemberByContainer(index, targetType, nodeName) ?? findSymbolByName(index, nodeName);
            if (match) return symbolToResolvedTarget(match);
        }

        const targetName = getNodeName(accessAncestor.node.target as Record<string, unknown>);
        if (targetName) {
            const match = findSymbolByName(index, `${targetName}::${nodeName}`);
            if (match) return symbolToResolvedTarget(match);
        }
    }

    const objectLiteralAncestor = findAncestor(cursorNode, candidate => isRecord(candidate.node) && 'fields' in candidate.node && 'ty' in candidate.node);
    if (objectLiteralAncestor && isRecord(objectLiteralAncestor.node)) {
        const targetType = getTypeName(objectLiteralAncestor.node.ty);
        if (targetType) {
            const match = findMemberByContainer(index, targetType, nodeName) ?? findSymbolByName(index, `${targetType}::${nodeName}`);
            if (match) return symbolToResolvedTarget(match);
        }
    }

    return null;
}

function resolveOperatorContext(index: AtlasIndex, cursorNode: CursorNode): ResolvedTarget | null {
    if (!isRecord(cursorNode.node) || typeof cursorNode.node.op !== 'string') return null;
    if (!getSpan(cursorNode.node.op_span)) return null;

    const opName = cursorNode.node.op as string;
    const receiverType = getTypeNameFromExpression(cursorNode.node.lhs) ?? getTypeNameFromExpression(cursorNode.node.rhs);
    if (!receiverType) return null;

    const match = findSymbolByName(index, `${receiverType}::${opName}`) ?? findMemberByContainer(index, receiverType, opName) ?? findSymbolByName(index, opName);
    return match ? symbolToResolvedTarget(match) : null;
}

function resolveTypeContext(index: AtlasIndex, cursorNode: CursorNode): ResolvedTarget | null {
    const typeName = getTypeName(cursorNode.node);
    if (!typeName) return null;

    const match = findSymbolByName(index, typeName, symbol => symbol.kind === SymbolKind.Class || symbol.kind === SymbolKind.Enum);
    return match ? symbolToResolvedTarget(match) : null;
}

function resolveIdentifierContext(index: AtlasIndex, cursorNode: CursorNode, offset: number, normalizedPath: string): ResolvedTarget | null {
    const name = getNodeName(cursorNode.node);
    if (!name) return null;

    const scope = findEnclosingFunction(index, normalizedPath, offset);
    if (scope) {
        const local = findBestLocal(scope, name, offset);
        if (local) return symbolToResolvedTarget(local);
    }

    const global = findSymbolByName(
        index,
        name,
        symbol => symbol.kind === SymbolKind.Function || symbol.kind === SymbolKind.Method || symbol.kind === SymbolKind.Class || symbol.kind === SymbolKind.Enum || symbol.kind === SymbolKind.Variable || symbol.kind === SymbolKind.EnumMember || symbol.kind === SymbolKind.Field,
    );
    return global ? symbolToResolvedTarget(global) : null;
}

function resolveSymbolAtPosition(payload: HirPayload, document: TextDocument, position: { line: number; character: number }): ResolvedTarget | null {
    const normalizedPath = normalizePath(fileURLToPath(document.uri));
    const offset = document.offsetAt(position);
    const cursorNode = findNodeAtOffset(payload, offset, normalizedPath);
    if (!cursorNode) return null;

    const index = buildAtlasIndex(payload);
    return resolveMemberContext(index, cursorNode)
        ?? resolveOperatorContext(index, cursorNode)
        ?? resolveTypeContext(index, cursorNode)
        ?? resolveIdentifierContext(index, cursorNode, offset, normalizedPath);
}

function symbolToDocumentSymbol(symbol: IndexedSymbol, children: DocumentSymbol[] = []): DocumentSymbol {
    const range = rangeForSpan(symbol.range) ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
    };
    const selectionRange = rangeForSpan(symbol.selectionRange) ?? range;

    return {
        name: symbol.kind === SymbolKind.Method && symbol.detail ? symbol.detail : symbol.name,
        detail: symbol.containerName ?? symbol.detail,
        kind: symbol.kind,
        range,
        selectionRange,
        children: children.length > 0 ? children : undefined,
    };
}

function buildDocumentSymbols(payload: HirPayload, normalizedPath: string): DocumentSymbol[] {
    const index = buildAtlasIndex(payload);
    const roots: DocumentSymbol[] = [];

    for (const fn of index.functions) {
        if (!spanMatchesDocument(fn.range, normalizedPath) || fn.containerName !== null || fn.kind !== SymbolKind.Function) continue;
        const children = [...fn.params, ...fn.locals]
            .filter(symbol => spanMatchesDocument(symbol.range, normalizedPath))
            .map(symbol => symbolToDocumentSymbol(symbol));
        roots.push(symbolToDocumentSymbol(fn, children));
    }

    const typeSymbols = Array.from(index.symbolsByName.values())
        .flat()
        .filter(symbol => spanMatchesDocument(symbol.range, normalizedPath) && (symbol.kind === SymbolKind.Class || symbol.kind === SymbolKind.Enum));

    for (const typeSymbol of typeSymbols) {
        const children = Array.from(index.membersByContainerAndName.entries())
            .filter(([containerKey]) => containerKey.startsWith(`${typeSymbol.name}::`))
            .flatMap(([, members]) => members)
            .filter(member => spanMatchesDocument(member.range, normalizedPath))
            .map(member => symbolToDocumentSymbol(member));
        roots.push(symbolToDocumentSymbol(typeSymbol, children));
    }

    return roots;
}

connection.onInitialize((_params: InitializeParams) => {
    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            hoverProvider: true,
            definitionProvider: true,
            documentSymbolProvider: true,
        }
    };
    return result;
});

// This handles the "Errors" part of your request
documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

documents.onDidSave(change => {
    validateTextDocument(change.document);
});

async function validateTextDocument(_textDocument: TextDocument): Promise<void> {
    try {
        const atlasData = await compileAtlasProject();

        const diagnosticMap: Map<string, Diagnostic[]> = new Map();

        if (atlasData.errors && Array.isArray(atlasData.errors)) {
            atlasData.errors.forEach((err: CompilerError) => {
                const absolutePath = path.resolve(err.span.path);
                const uri = pathToFileURL(absolutePath).toString();

                if (!diagnosticMap.has(uri)) {
                    diagnosticMap.set(uri, []);
                }

                let range;
                const openDoc = documents.get(uri);
                if (openDoc) {
                    range = {
                        start: openDoc.positionAt(err.span.start),
                        end: openDoc.positionAt(err.span.end)
                    };
                } else if (fs.existsSync(absolutePath)) {
                    const content = fs.readFileSync(absolutePath, 'utf-8');
                    const index = new LineIndex(content);
                    range = index.spanToRange(err.span.start, err.span.end);
                }

                if (!range) return;

                const diagnostic: Diagnostic = {
                    severity: getDiagnosticSeverity(err.kind),
                    range,
                    message: err.message,
                    source: 'atlas77'
                };
                diagnosticMap.get(uri)!.push(diagnostic);
            });
        }

        const currentUris = new Set(diagnosticMap.keys());
        for (const [uri, diagnostics] of diagnosticMap) {
            connection.sendDiagnostics({ uri, diagnostics });
        }

        for (const uri of lastReportedUris) {
            if (!currentUris.has(uri)) {
                connection.sendDiagnostics({ uri, diagnostics: [] });
            }
        }
        lastReportedUris = currentUris;

    } catch (error) {
        connection.console.error(`Failed to run atlas77: ${error}`);
    }
}

connection.onHover(async (params: HoverParams): Promise<Hover | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    try {
        const atlasData = await compileAtlasProject();
        const resolved = resolveSymbolAtPosition(atlasData, document, params.position);

        if (resolved) {
            return {
                contents: {
                    kind: 'markdown',
                    value: `**${resolved.name}**\n\nKind: ${symbolKindLabel(resolved.kind)}${resolved.detail ? `\n${resolved.detail}` : ''}`
                }
            };
        }
    } catch {
        return null;
    }

    return null;
});

connection.onDefinition(async (params: DefinitionParams): Promise<Definition | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    try {
        const atlasData = await compileAtlasProject();
        const resolved = resolveSymbolAtPosition(atlasData, document, params.position);
        if (!resolved) return null;
        return Location.create(resolved.uri, resolved.selectionRange);
    } catch {
        return null;
    }
});

connection.onDocumentSymbol(async (params: DocumentSymbolParams): Promise<DocumentSymbol[] | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    try {
        const atlasData = await compileAtlasProject();
        const normalizedPath = normalizePath(fileURLToPath(document.uri));
        return buildDocumentSymbols(atlasData, normalizedPath);
    } catch {
        return null;
    }
});

documents.listen(connection);
connection.listen();