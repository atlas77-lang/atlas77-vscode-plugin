"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const child_process_1 = require("child_process");
const url_1 = require("url");
const util_1 = require("util");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const position_1 = require("./position");
const execPromise = (0, util_1.promisify)(child_process_1.exec);
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
const OUTPUT_FILE = './build/temp_output.json';
let lastReportedUris = new Set();
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function getSpan(value) {
    if (!isRecord(value))
        return null;
    const start = value.start;
    const end = value.end;
    const spanPath = value.path;
    if (typeof start !== 'number' || typeof end !== 'number' || typeof spanPath !== 'string') {
        return null;
    }
    return { start, end, path: spanPath };
}
function normalizePath(filePath) {
    return path.resolve(filePath).toLowerCase();
}
function spanMatchesDocument(span, normalizedPath) {
    return normalizePath(span.path) === normalizedPath;
}
function spanToUri(span) {
    return (0, url_1.pathToFileURL)(path.isAbsolute(span.path) ? span.path : path.resolve(span.path)).toString();
}
function rangeForSpan(span) {
    const uri = spanToUri(span);
    const openDoc = documents.get(uri);
    if (openDoc) {
        return {
            start: openDoc.positionAt(span.start),
            end: openDoc.positionAt(span.end),
        };
    }
    const absolutePath = (0, url_1.fileURLToPath)(uri);
    if (!fs.existsSync(absolutePath)) {
        return null;
    }
    const content = fs.readFileSync(absolutePath, 'utf-8');
    return new position_1.LineIndex(content).spanToRange(span.start, span.end);
}
function createSymbol(name, kind, span, selectionSpan = span, containerName = null, detail, documentation) {
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
function addSymbol(index, symbol) {
    const byName = index.symbolsByName.get(symbol.name) ?? [];
    byName.push(symbol);
    index.symbolsByName.set(symbol.name, byName);
    if (symbol.containerName) {
        const members = index.membersByContainerAndName.get(`${symbol.containerName}::${symbol.name}`) ?? [];
        members.push(symbol);
        index.membersByContainerAndName.set(`${symbol.containerName}::${symbol.name}`, members);
    }
}
function compileAtlasProject() {
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    return execPromise(`atlas77 to-json -o ${OUTPUT_FILE}`).then(() => {
        const fileContent = fs.readFileSync(OUTPUT_FILE, 'utf-8');
        return JSON.parse(fileContent);
    });
}
function getDiagnosticSeverity(kind) {
    switch (kind) {
        case 'warning':
            return node_1.DiagnosticSeverity.Warning;
        case 'error':
            return node_1.DiagnosticSeverity.Error;
        case 'note':
            return node_1.DiagnosticSeverity.Information;
        default:
            return node_1.DiagnosticSeverity.Hint;
    }
}
function indexFunctionLike(index, fnDecl, fallbackName, containerName, kind) {
    const span = getSpan(fnDecl.span);
    if (!span)
        return;
    const name = typeof fnDecl.name === 'string' ? fnDecl.name : fallbackName;
    const selectionSpan = getSpan(fnDecl.name_span) ?? span;
    const fnSymbol = {
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
    const signature = (isRecord(fnDecl.signature) ? fnDecl.signature : fnDecl);
    indexParams(index, signature.params, fnSymbol);
    if (isRecord(fnDecl.body)) {
        collectLocalDeclarations(index, fnDecl.body, fnSymbol);
    }
}
function indexParams(index, params, fnSymbol) {
    if (!Array.isArray(params))
        return;
    for (const param of params) {
        if (!isRecord(param))
            continue;
        const span = getSpan(param.span);
        const name = typeof param.name === 'string' ? param.name : null;
        if (!span || !name)
            continue;
        const symbol = createSymbol(name, node_1.SymbolKind.Variable, span, getSpan(param.name_span) ?? span, fnSymbol.name);
        fnSymbol.params.push(symbol);
        addSymbol(index, symbol);
    }
}
function indexNamedMembers(index, members, containerName, kind) {
    if (!members)
        return;
    if (Array.isArray(members)) {
        for (const member of members) {
            if (!isRecord(member))
                continue;
            const span = getSpan(member.span);
            const name = typeof member.name === 'string' ? member.name : null;
            if (!span || !name)
                continue;
            const symbol = createSymbol(name, kind, span, getSpan(member.name_span) ?? span, containerName, undefined, member.docstring);
            addSymbol(index, symbol);
            if (kind === node_1.SymbolKind.Method && isRecord(member.body)) {
                const fnSymbol = {
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
    if (!isRecord(members))
        return;
    for (const [memberKey, memberValue] of Object.entries(members)) {
        if (!isRecord(memberValue))
            continue;
        const span = getSpan(memberValue.span);
        if (!span)
            continue;
        const name = typeof memberValue.name === 'string' ? memberValue.name : memberKey;
        const symbol = createSymbol(name, kind, span, getSpan(memberValue.name_span) ?? span, containerName, undefined, memberValue.docstring);
        addSymbol(index, symbol);
        if (kind === node_1.SymbolKind.Method && isRecord(memberValue.body)) {
            const fnSymbol = {
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
function indexOperators(index, operators, containerName) {
    if (!operators)
        return;
    if (Array.isArray(operators)) {
        for (const operatorDecl of operators) {
            if (!isRecord(operatorDecl))
                continue;
            const span = getSpan(operatorDecl.span);
            if (!span)
                continue;
            const name = typeof operatorDecl.name === 'string' ? operatorDecl.name : 'operator';
            const symbol = createSymbol(name, node_1.SymbolKind.Method, span, getSpan(operatorDecl.name_span) ?? span, containerName, `operator ${name}`, operatorDecl.docstring);
            addSymbol(index, symbol);
        }
        return;
    }
    if (!isRecord(operators))
        return;
    for (const [operatorKey, operatorValue] of Object.entries(operators)) {
        if (!isRecord(operatorValue))
            continue;
        const span = getSpan(operatorValue.span);
        if (!span)
            continue;
        const symbol = createSymbol(operatorKey, node_1.SymbolKind.Method, span, getSpan(operatorValue.name_span) ?? span, containerName, `operator ${operatorKey}`, operatorValue.docstring);
        addSymbol(index, symbol);
        if (isRecord(operatorValue.body)) {
            const fnSymbol = {
                name: operatorKey,
                kind: node_1.SymbolKind.Method,
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
function indexTypeLike(index, typeDecl, fallbackName, kind) {
    const span = getSpan(typeDecl.span);
    if (!span)
        return;
    const name = typeof typeDecl.name === 'string' ? typeDecl.name : fallbackName;
    addSymbol(index, createSymbol(name, kind, span, getSpan(typeDecl.name_span) ?? span, null, undefined, typeDecl.docstring));
    const signature = (isRecord(typeDecl.signature) ? typeDecl.signature : typeDecl);
    indexNamedMembers(index, signature.fields, name, node_1.SymbolKind.Field);
    indexNamedMembers(index, signature.methods, name, node_1.SymbolKind.Method);
    indexOperators(index, signature.operators, name);
    indexNamedMembers(index, signature.variants, name, node_1.SymbolKind.EnumMember);
}
function buildAtlasIndex(payload) {
    const index = {
        functions: [],
        symbolsByName: new Map(),
        membersByContainerAndName: new Map(),
    };
    const body = payload.hir?.body;
    if (!body)
        return index;
    const functionEntries = body.functions;
    if (functionEntries) {
        for (const [declKey, declValue] of Object.entries(functionEntries)) {
            if (isRecord(declValue)) {
                indexFunctionLike(index, declValue, declKey, null, node_1.SymbolKind.Function);
            }
        }
    }
    const structEntries = body.structs;
    if (structEntries) {
        for (const [declKey, declValue] of Object.entries(structEntries)) {
            if (isRecord(declValue)) {
                indexTypeLike(index, declValue, declKey, node_1.SymbolKind.Class);
            }
        }
    }
    const unionEntries = body.unions;
    if (unionEntries) {
        for (const [declKey, declValue] of Object.entries(unionEntries)) {
            if (isRecord(declValue)) {
                indexTypeLike(index, declValue, declKey, node_1.SymbolKind.Class);
            }
        }
    }
    const enumEntries = body.enums;
    if (enumEntries) {
        for (const [declKey, declValue] of Object.entries(enumEntries)) {
            if (isRecord(declValue)) {
                indexTypeLike(index, declValue, declKey, node_1.SymbolKind.Enum);
            }
        }
    }
    return index;
}
function collectLocalDeclarations(index, body, fnSymbol) {
    const statements = body.statements;
    if (!Array.isArray(statements))
        return;
    for (const statement of statements) {
        collectLocalDeclarationsFromNode(index, statement, fnSymbol);
    }
}
function collectLocalDeclarationsFromNode(index, node, fnSymbol) {
    if (Array.isArray(node)) {
        for (const item of node) {
            collectLocalDeclarationsFromNode(index, item, fnSymbol);
        }
        return;
    }
    if (!isRecord(node))
        return;
    const letNode = node.Let;
    if (isRecord(letNode)) {
        const span = getSpan(letNode.span);
        const name = typeof letNode.name === 'string' ? letNode.name : null;
        if (span && name) {
            const symbol = createSymbol(name, node_1.SymbolKind.Variable, span, getSpan(letNode.name_span) ?? span, fnSymbol.name, undefined, letNode.docstring);
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
function nodeSpanLength(span) {
    return span.end - span.start;
}
function findNodeAtOffset(payload, offset, normalizedPath) {
    const body = payload.hir?.body;
    if (!body)
        return null;
    const roots = [];
    const addRoots = (entries) => {
        if (!isRecord(entries))
            return;
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
    let best = null;
    for (const root of roots) {
        const match = findBestNode(root, offset, normalizedPath, null, null);
        if (!match)
            continue;
        if (!best || nodeSpanLength(match.span) < nodeSpanLength(best.span)) {
            best = match;
        }
    }
    return best;
}
function findBestNode(node, offset, normalizedPath, parent, key) {
    if (Array.isArray(node)) {
        let best = null;
        for (const item of node) {
            const match = findBestNode(item, offset, normalizedPath, parent, key);
            if (!match)
                continue;
            if (!best || nodeSpanLength(match.span) < nodeSpanLength(best.span)) {
                best = match;
            }
        }
        return best;
    }
    if (!isRecord(node))
        return null;
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
        if (!match)
            continue;
        if (!best || nodeSpanLength(match.span) < nodeSpanLength(best.span)) {
            best = match;
        }
    }
    return best;
}
function findAncestor(node, predicate) {
    let current = node?.parent ?? null;
    while (current) {
        if (predicate(current)) {
            return current;
        }
        current = current.parent;
    }
    return null;
}
function getNodeName(node) {
    return typeof node.name === 'string' ? node.name : null;
}
function getTypeName(typeNode) {
    if (!isRecord(typeNode))
        return null;
    if (isRecord(typeNode.Named) && typeof typeNode.Named.name === 'string')
        return typeNode.Named.name;
    if (isRecord(typeNode.Generic) && typeof typeNode.Generic.name === 'string')
        return typeNode.Generic.name;
    if (isRecord(typeNode.PtrTy))
        return getTypeName(typeNode.PtrTy.inner);
    if (isRecord(typeNode.Slice))
        return getTypeName(typeNode.Slice.inner);
    if (isRecord(typeNode.InlineArray))
        return getTypeName(typeNode.InlineArray.inner);
    return null;
}
function getTypeNameFromExpression(node) {
    if (!isRecord(node))
        return null;
    const directType = getTypeName(node.ty);
    if (directType)
        return directType;
    for (const key of ['expr', 'value', 'target', 'lhs', 'rhs', 'callee']) {
        const nestedType = getTypeNameFromExpression(node[key]);
        if (nestedType)
            return nestedType;
    }
    return null;
}
function findSymbolByName(index, name, predicate) {
    const symbols = index.symbolsByName.get(name);
    if (!symbols || symbols.length === 0)
        return null;
    if (!predicate)
        return symbols[0];
    return symbols.find(predicate) ?? null;
}
function findMemberByContainer(index, containerName, memberName) {
    return index.membersByContainerAndName.get(`${containerName}::${memberName}`)?.[0] ?? null;
}
function findEnclosingFunction(index, normalizedPath, offset) {
    let best = null;
    for (const fn of index.functions) {
        if (!spanMatchesDocument(fn.range, normalizedPath))
            continue;
        if (offset < fn.range.start || offset > fn.range.end)
            continue;
        if (!best || nodeSpanLength(fn.range) < nodeSpanLength(best.range)) {
            best = fn;
        }
    }
    return best;
}
function findBestLocal(fn, name, offset) {
    const locals = [...fn.params, ...fn.locals].filter(symbol => symbol.name === name);
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const symbol of locals) {
        if (symbol.range.start > offset)
            continue;
        const distance = offset - symbol.range.start;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = symbol;
        }
    }
    return best;
}
function symbolToResolvedTarget(symbol) {
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
function symbolKindLabel(kind) {
    switch (kind) {
        case node_1.SymbolKind.Class:
            return 'Class';
        case node_1.SymbolKind.Enum:
            return 'Enum';
        case node_1.SymbolKind.EnumMember:
            return 'Enum member';
        case node_1.SymbolKind.Field:
            return 'Field';
        case node_1.SymbolKind.Function:
            return 'Function';
        case node_1.SymbolKind.Method:
            return 'Method';
        case node_1.SymbolKind.Variable:
            return 'Variable';
        default:
            return 'Symbol';
    }
}
function resolveMemberContext(index, cursorNode) {
    const nodeName = getNodeName(cursorNode.node);
    if (!nodeName)
        return null;
    const accessAncestor = findAncestor(cursorNode, candidate => {
        const candidateNode = candidate.node;
        return isRecord(candidateNode) && candidateNode.field === cursorNode.node && ('target' in candidateNode || 'ty' in candidateNode);
    });
    if (accessAncestor && isRecord(accessAncestor.node)) {
        const targetType = getTypeNameFromExpression(accessAncestor.node.target) ?? getTypeName(accessAncestor.node.target);
        if (targetType) {
            const match = findSymbolByName(index, `${targetType}::${nodeName}`) ?? findMemberByContainer(index, targetType, nodeName) ?? findSymbolByName(index, nodeName);
            if (match)
                return symbolToResolvedTarget(match);
        }
        const targetName = getNodeName(accessAncestor.node.target);
        if (targetName) {
            const match = findSymbolByName(index, `${targetName}::${nodeName}`);
            if (match)
                return symbolToResolvedTarget(match);
        }
    }
    const objectLiteralAncestor = findAncestor(cursorNode, candidate => isRecord(candidate.node) && 'fields' in candidate.node && 'ty' in candidate.node);
    if (objectLiteralAncestor && isRecord(objectLiteralAncestor.node)) {
        const targetType = getTypeName(objectLiteralAncestor.node.ty);
        if (targetType) {
            const match = findMemberByContainer(index, targetType, nodeName) ?? findSymbolByName(index, `${targetType}::${nodeName}`);
            if (match)
                return symbolToResolvedTarget(match);
        }
    }
    return null;
}
function resolveOperatorContext(index, cursorNode) {
    if (!isRecord(cursorNode.node) || typeof cursorNode.node.op !== 'string')
        return null;
    if (!getSpan(cursorNode.node.op_span))
        return null;
    const opName = cursorNode.node.op;
    const receiverType = getTypeNameFromExpression(cursorNode.node.lhs) ?? getTypeNameFromExpression(cursorNode.node.rhs);
    if (!receiverType)
        return null;
    const match = findSymbolByName(index, `${receiverType}::${opName}`) ?? findMemberByContainer(index, receiverType, opName) ?? findSymbolByName(index, opName);
    return match ? symbolToResolvedTarget(match) : null;
}
function resolveTypeContext(index, cursorNode) {
    const typeName = getTypeName(cursorNode.node);
    if (!typeName)
        return null;
    const match = findSymbolByName(index, typeName, symbol => symbol.kind === node_1.SymbolKind.Class || symbol.kind === node_1.SymbolKind.Enum);
    return match ? symbolToResolvedTarget(match) : null;
}
function resolveIdentifierContext(index, cursorNode, offset, normalizedPath) {
    const name = getNodeName(cursorNode.node);
    if (!name)
        return null;
    const scope = findEnclosingFunction(index, normalizedPath, offset);
    if (scope) {
        const local = findBestLocal(scope, name, offset);
        if (local)
            return symbolToResolvedTarget(local);
    }
    const global = findSymbolByName(index, name, symbol => symbol.kind === node_1.SymbolKind.Function || symbol.kind === node_1.SymbolKind.Method || symbol.kind === node_1.SymbolKind.Class || symbol.kind === node_1.SymbolKind.Enum || symbol.kind === node_1.SymbolKind.Variable || symbol.kind === node_1.SymbolKind.EnumMember || symbol.kind === node_1.SymbolKind.Field);
    return global ? symbolToResolvedTarget(global) : null;
}
function resolveSymbolAtPosition(payload, document, position) {
    const normalizedPath = normalizePath((0, url_1.fileURLToPath)(document.uri));
    const offset = document.offsetAt(position);
    const cursorNode = findNodeAtOffset(payload, offset, normalizedPath);
    if (!cursorNode)
        return null;
    const index = buildAtlasIndex(payload);
    return resolveMemberContext(index, cursorNode)
        ?? resolveOperatorContext(index, cursorNode)
        ?? resolveTypeContext(index, cursorNode)
        ?? resolveIdentifierContext(index, cursorNode, offset, normalizedPath);
}
function symbolToDocumentSymbol(symbol, children = []) {
    const range = rangeForSpan(symbol.range) ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
    };
    const selectionRange = rangeForSpan(symbol.selectionRange) ?? range;
    return {
        name: symbol.kind === node_1.SymbolKind.Method && symbol.detail ? symbol.detail : symbol.name,
        detail: symbol.containerName ?? symbol.detail,
        kind: symbol.kind,
        range,
        selectionRange,
        children: children.length > 0 ? children : undefined,
    };
}
function buildDocumentSymbols(payload, normalizedPath) {
    const index = buildAtlasIndex(payload);
    const roots = [];
    for (const fn of index.functions) {
        if (!spanMatchesDocument(fn.range, normalizedPath) || fn.containerName !== null || fn.kind !== node_1.SymbolKind.Function)
            continue;
        const children = [...fn.params, ...fn.locals]
            .filter(symbol => spanMatchesDocument(symbol.range, normalizedPath))
            .map(symbol => symbolToDocumentSymbol(symbol));
        roots.push(symbolToDocumentSymbol(fn, children));
    }
    const typeSymbols = Array.from(index.symbolsByName.values())
        .flat()
        .filter(symbol => spanMatchesDocument(symbol.range, normalizedPath) && (symbol.kind === node_1.SymbolKind.Class || symbol.kind === node_1.SymbolKind.Enum));
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
connection.onInitialize((_params) => {
    const result = {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
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
async function validateTextDocument(_textDocument) {
    try {
        const atlasData = await compileAtlasProject();
        const diagnosticMap = new Map();
        if (atlasData.errors && Array.isArray(atlasData.errors)) {
            atlasData.errors.forEach((err) => {
                const absolutePath = path.resolve(err.span.path);
                const uri = (0, url_1.pathToFileURL)(absolutePath).toString();
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
                }
                else if (fs.existsSync(absolutePath)) {
                    const content = fs.readFileSync(absolutePath, 'utf-8');
                    const index = new position_1.LineIndex(content);
                    range = index.spanToRange(err.span.start, err.span.end);
                }
                if (!range)
                    return;
                const diagnostic = {
                    severity: getDiagnosticSeverity(err.kind),
                    range,
                    message: err.message,
                    source: 'atlas77'
                };
                diagnosticMap.get(uri).push(diagnostic);
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
    }
    catch (error) {
        connection.console.error(`Failed to run atlas77: ${error}`);
    }
}
connection.onHover(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document)
        return null;
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
    }
    catch {
        return null;
    }
    return null;
});
connection.onDefinition(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document)
        return null;
    try {
        const atlasData = await compileAtlasProject();
        const resolved = resolveSymbolAtPosition(atlasData, document, params.position);
        if (!resolved)
            return null;
        return node_1.Location.create(resolved.uri, resolved.selectionRange);
    }
    catch {
        return null;
    }
});
connection.onDocumentSymbol(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document)
        return null;
    try {
        const atlasData = await compileAtlasProject();
        const normalizedPath = normalizePath((0, url_1.fileURLToPath)(document.uri));
        return buildDocumentSymbols(atlasData, normalizedPath);
    }
    catch {
        return null;
    }
});
documents.listen(connection);
connection.listen();
//# sourceMappingURL=server.js.map