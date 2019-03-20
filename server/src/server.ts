"use strict";

import {
    CodeActionParams, CodeLens, CodeLensParams,
    createConnection, IConnection, InitializeResult, IPCMessageReader,
    IPCMessageWriter, Location, RenameParams, TextDocument,
    TextDocumentItem, TextDocumentPositionParams, TextDocuments, WorkspaceEdit,
} from "vscode-languageserver";
import Uri from "vscode-uri";
import { CompilerResult } from "./backend/CompilerResult";
import { DafnyInstaller } from "./backend/dafnyInstaller";
import { IDafnySettings } from "./backend/dafnySettings";
import { DependencyVerifier } from "./backend/dependencyVerifier";
import { ReferencesCodeLens } from "./backend/features/codeLenses";
import { DafnyServerProvider } from "./frontend/dafnyProvider";
import { NotificationService } from "./notificationService";
import { InfoMsg } from "./strings/stringRessources";
import { LanguageServerNotification, LanguageServerRequest } from "./strings/stringRessources";

const MAX_CONNECTION_RETRIES = 30;

const connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
const documents: TextDocuments = new TextDocuments();
const codeLenses: { [codeLens: string]: ReferencesCodeLens; } = {};
let settings: ISettings = null;
let started: boolean = false;
let notificationService: NotificationService = null;
let dafnyInstaller: DafnyInstaller = null;

documents.listen(connection);

let workspaceRoot: string;
let provider: DafnyServerProvider = null;

connection.onInitialize((params): InitializeResult => {
    workspaceRoot = params.rootPath;
    notificationService = new NotificationService(connection);
    return {
        capabilities: {
            codeActionProvider: true,
            codeLensProvider: { resolveProvider: true },
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ["."],
            },
            definitionProvider: true,
            renameProvider: true,
            textDocumentSync: documents.syncKind,
        },
    };
});

function verifyDependencies() {
    const dependencyVerifier: DependencyVerifier = new DependencyVerifier();
    dafnyInstaller = new DafnyInstaller(notificationService);
    dependencyVerifier.verifyDafnyServer(workspaceRoot, notificationService, settings.dafny, (serverVersion: string) => {
        init(serverVersion);
        dafnyInstaller.latestVersionInstalled(serverVersion).then((latest) => {
            if (!latest) {
                connection.sendNotification(LanguageServerNotification.DafnyMissing, InfoMsg.DafnyUpdateAvailable);
            }
        }).catch(() => {
            console.error("can't access github");
        });
    }, () => {
        connection.sendNotification(LanguageServerNotification.DafnyMissing, InfoMsg.AskInstallDafny);
    });
}

function init(serverVersion: string) {
    try {
        if (!provider) {
            provider = new DafnyServerProvider(notificationService, serverVersion, workspaceRoot, settings.dafny);
            provider.resetServer();
            verifyAll();
        } else {
            provider.init();
            provider.resetServer();
            verifyAll();
        }
    } catch (e) {
        connection.sendNotification(LanguageServerNotification.Error, "Exception occured: " + e);
    }
}

function verifyAll() {
    console.log("verify all" + documents.all().length);
    if (provider) {
        documents.all().forEach((d) => {
            console.log("all verify" + d.uri);
            provider.doVerify(d);
        });
    }
}

connection.onRenameRequest((handler: RenameParams): Promise<WorkspaceEdit> => {
    if (provider && provider.renameProvider) {
        return provider.renameProvider.provideRenameEdits(documents.get(handler.textDocument.uri), handler.position, handler.newName);
    }
    return Promise.reject("The language provider was not ready");
});

connection.onDefinition((handler: TextDocumentPositionParams): Promise<Location> => {
    if (provider && provider.definitionProvider) {
        return provider.definitionProvider.provideDefinition(documents.get(handler.textDocument.uri), handler.position);
    }
    return Promise.reject("The language provider was not ready");
});

function getCodeLens(referenceCodeLens: ReferencesCodeLens): CodeLens {
    return { command: referenceCodeLens.command, data: referenceCodeLens.data, range: referenceCodeLens.range };
}

function sleep(ms: number) {
    return new Promise((resolve: any) => setTimeout(resolve, ms));
}

connection.onCodeLens(async (handler: CodeLensParams): Promise<ReferencesCodeLens[]> => {
    let tries = 0;
    while (!(provider && provider.referenceProvider) && tries < MAX_CONNECTION_RETRIES) {
        await sleep(2000);
        tries++;
    }
    if (!(provider && provider.referenceProvider)) {
        return Promise.reject("The language provider is not (yet) ready.");
    }

    const lenses = await provider.referenceProvider.provideCodeLenses(documents.get(handler.textDocument.uri));
    lenses.forEach((lens: ReferencesCodeLens) => {
        codeLenses[JSON.stringify(getCodeLens(lens))] = lens;
    });
    return lenses;
});

connection.onCodeLensResolve((handler: CodeLens): Promise<CodeLens> => {
    if (provider && provider.referenceProvider) {
        const item = codeLenses[JSON.stringify(handler)];
        if (item) {
            return provider.referenceProvider.resolveCodeLens(item);
        } else {
            console.error(`Codelens key for range ${handler.range} not found`);
        }
    }
    return Promise.reject("The language provider is not (yet) ready.");
});

interface ISettings {
    dafny: IDafnySettings;
}

connection.onDidChangeConfiguration((change) => {
    settings = change.settings as ISettings;
    if (!started) {
        started = true;
        verifyDependencies();
    }
});

connection.onDidCloseTextDocument((handler) => {
    connection.sendDiagnostics({ diagnostics: [], uri: handler.textDocument.uri });
});

connection.onRequest<CompilerResult, void>(LanguageServerRequest.Compile, (uri: Uri): Promise<CompilerResult> => {
    if (provider && provider.compiler) {
        return provider.compiler.compile(uri);
    }
    return Promise.reject("The language provider is not (yet) ready.");
});

connection.onRequest<void, void>(LanguageServerRequest.Dotgraph, (json: string): Promise<void> => {
    const textDocumentItem: TextDocumentItem = JSON.parse(json);
    const textDocument: TextDocument = TextDocument.create(textDocumentItem.uri, textDocumentItem.languageId,
        textDocumentItem.version, textDocumentItem.text);
    if (provider) {
        return provider.dotGraph(textDocument);
    }
    return Promise.reject("The language provider is not (yet) ready.");
});

connection.onRequest<string, void>(LanguageServerRequest.Install, () => {
    return new Promise<string>(async (resolve, reject) => {
        await uninstallDafny();
        if (dafnyInstaller) {
            const basePath = await dafnyInstaller.install();
            settings.dafny.basePath = basePath;
            verifyDependencies();
            resolve(basePath);
        } else {
            reject();
        }
    });
});

connection.onRequest<void, void>(LanguageServerRequest.Uninstall, () => {
    return uninstallDafny();
});

function uninstallDafny(): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
        if (provider) {
            notificationService.progressText("Stopping dafny");
            provider.stop();
            await sleep(1000);
            let tries = 0;
            while (provider && provider.dafnyServer.isRunning() && tries < MAX_CONNECTION_RETRIES) {
                await sleep(1000);
                tries++;
            }
        }
        if (dafnyInstaller) {
            try {
                dafnyInstaller.uninstall();
                resolve();
            } catch (e) {
                notificationService.sendError("Error uninstalling: " + e);
                reject(e);
            }
        } else {
            reject();
        }
    });
}

connection.onRequest<void, void>(LanguageServerRequest.Reset, () => {
    if (provider) {
        provider.resetServer();
    }
    return;
});

connection.onNotification(LanguageServerNotification.Verify, (json: string) => {
    const textDocumentItem: TextDocumentItem = JSON.parse(json);
    const textDocument: TextDocument = TextDocument.create(textDocumentItem.uri, textDocumentItem.languageId,
        textDocumentItem.version, textDocumentItem.text);
    if (provider) {
        provider.doVerify(textDocument);
    }
});

connection.onNotification(LanguageServerNotification.CounterExample, (json: string) => {
    const textDocumentItem: TextDocumentItem = JSON.parse(json);
    const textDocument: TextDocument = TextDocument.create(textDocumentItem.uri, textDocumentItem.languageId,
        textDocumentItem.version, textDocumentItem.text);
    if (provider) {
        provider.doCounterExample(textDocument);
    }
});

connection.onCodeAction((params: CodeActionParams) => {
    if (provider && provider.codeActionProvider) {
        return provider.codeActionProvider.provideCodeAction(params);
    }
    return Promise.resolve([]);
});

connection.onCompletion((handler: TextDocumentPositionParams) => {
    if (provider && provider.completionProvider) {
        return provider.completionProvider.provideCompletion(handler);
    }
    return Promise.resolve([]);
});

connection.listen();
