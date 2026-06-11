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
const OUTPUT_FILE = './temp_output.json'; // Temporary file to store atlas77 output
let lastReportedUris = new Set();
connection.onInitialize((params) => {
    const result = {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
            // Tell the client that this server supports hover (for types)
            hoverProvider: true
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
function getDiagnosticSeverity(kind) {
    switch (kind) {
        case "warning":
            return node_1.DiagnosticSeverity.Warning;
        case "error":
            return node_1.DiagnosticSeverity.Error;
        case "note":
            return node_1.DiagnosticSeverity.Information;
        default:
            return node_1.DiagnosticSeverity.Hint;
    }
}
async function validateTextDocument(textDocument) {
    try {
        // Execute the CLI.
        // We have to rebuilt the entire project, not just the updated file. The compiler is currently limited
        // And no need to call a specific file, we only care about the default "src/main.atlas" for now
        await execPromise(`atlas77 to-json -o ${OUTPUT_FILE}`);
        const file_content = fs.readFileSync(OUTPUT_FILE, 'utf-8');
        const atlasData = JSON.parse(file_content);
        // Group diagnostics by URI
        const diagnosticMap = new Map();
        if (atlasData.errors && Array.isArray(atlasData.errors)) {
            atlasData.errors.forEach((err) => {
                const absolutePath = path.resolve(err.span.path);
                const uri = (0, url_1.pathToFileURL)(absolutePath).toString();
                if (!diagnosticMap.has(uri)) {
                    diagnosticMap.set(uri, []);
                }
                // To convert offsets for any file (even closed ones), we use the LineIndex helper
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
        // Send diagnostics for files that have errors
        const currentUris = new Set(diagnosticMap.keys());
        for (const [uri, diagnostics] of diagnosticMap) {
            connection.sendDiagnostics({ uri, diagnostics });
        }
        // Clear diagnostics for files that used to have errors but are now clean
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
// This handles the "Types and cool stuff" (Hover) part of your request
connection.onHover(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document)
        return null;
    const currentFilePath = (0, url_1.fileURLToPath)(params.textDocument.uri);
    const normalizedCurrentPath = path.resolve(currentFilePath).toLowerCase();
    try {
        // We have to rebuilt the entire project, not just the updated file. The compiler is currently limited
        // And no need to call a specific file, we only care about the default "src/main.atlas" for now
        await execPromise(`atlas77 to-json -o ${OUTPUT_FILE}`);
        const file_content = fs.readFileSync(OUTPUT_FILE, 'utf-8');
        const atlasData = JSON.parse(file_content);
        // Convert the current hover position back to an offset to search the HIR
        const offset = document.offsetAt(params.position);
        const typeInfo = findTypeAtOffset(atlasData, offset, normalizedCurrentPath);
        if (typeInfo) {
            return {
                contents: {
                    kind: 'markdown',
                    value: `**Atlas Type Info**\n\nFound at offset: ${offset}`
                }
            };
        }
    }
    catch (e) {
        return null;
    }
    return null;
});
function findTypeAtOffset(data, offset, normalizedPath) {
    // Placeholder: You would traverse the 'hir' object in data 
    // and check if offset is between node.span.start and node.span.end
    // Now we also verify the file path matches
    return data.errors?.find((err) => {
        const errorPath = path.resolve(err.span.path).toLowerCase();
        return errorPath === normalizedPath && offset >= err.span.start && offset <= err.span.end;
    });
}
documents.listen(connection);
connection.listen();
//# sourceMappingURL=server.js.map