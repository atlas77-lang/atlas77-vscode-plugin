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
const OUTPUT_FILE = './temp_output.json'; // Temporary file to store atlas77 output

let lastReportedUris: Set<string> = new Set();

connection.onInitialize((params: InitializeParams) => {
    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
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
})

function getDiagnosticSeverity(kind: string): DiagnosticSeverity {    
    switch (kind) {
        case "warning": 
            return DiagnosticSeverity.Warning;
        case "error":
            return DiagnosticSeverity.Error;
        case "note":
            return DiagnosticSeverity.Information;
        default:
            return DiagnosticSeverity.Hint;
    }
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    try {
        // Execute the CLI.
        // We have to rebuilt the entire project, not just the updated file. The compiler is currently limited
        // And no need to call a specific file, we only care about the default "src/main.atlas" for now
        await execPromise(`atlas77 to-json -o ${OUTPUT_FILE}`);
        const file_content = fs.readFileSync(OUTPUT_FILE, 'utf-8');
        const atlasData = JSON.parse(file_content) as HirPayload;

        // Group diagnostics by URI
        const diagnosticMap: Map<string, Diagnostic[]> = new Map();

        if (atlasData.errors && Array.isArray(atlasData.errors)) {
            atlasData.errors.forEach((err: CompilerError) => {
                const absolutePath = path.resolve(err.span.path);
                const uri = pathToFileURL(absolutePath).toString();

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

    } catch (error) {
        connection.console.error(`Failed to run atlas77: ${error}`);
    }
}

// This handles the "Types and cool stuff" (Hover) part of your request
connection.onHover(async (params: HoverParams): Promise<Hover | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const currentFilePath = fileURLToPath(params.textDocument.uri);
    const normalizedCurrentPath = path.resolve(currentFilePath).toLowerCase();

    try {
        // We have to rebuilt the entire project, not just the updated file. The compiler is currently limited
        // And no need to call a specific file, we only care about the default "src/main.atlas" for now
        await execPromise(`atlas77 to-json -o ${OUTPUT_FILE}`);
        const file_content = fs.readFileSync(OUTPUT_FILE, 'utf-8');
        const atlasData = JSON.parse(file_content) as HirPayload;

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
    } catch (e) {
        return null;
    }

    return null;
});

function findTypeAtOffset(data: HirPayload, offset: number, normalizedPath: string) {
    // Placeholder: You would traverse the 'hir' object in data 
    // and check if offset is between node.span.start and node.span.end
    // Now we also verify the file path matches
    return data.errors?.find((err: CompilerError) => {
        const errorPath = path.resolve(err.span.path).toLowerCase();
        return errorPath === normalizedPath && offset >= err.span.start && offset <= err.span.end;
    });
}

documents.listen(connection);
connection.listen();