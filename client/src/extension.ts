import * as path from 'path';
import { ExtensionContext } from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
    // The server is implemented in node
    const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
        }
    };

    const clientOptions: LanguageClientOptions = {
        // Register the server for your specific language
        documentSelector: [{ scheme: 'file', language: 'atlas' }],
        synchronize: {
            fileEvents: context.globalState.get('fileEvents')
        }
    };

    client = new LanguageClient('atlas77Server', 'Atlas77 Language Server', serverOptions, clientOptions);
    
    console.log('Starting Atlas77 Language Client...');
    client.start();
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) { return undefined; }
    return client.stop();
}