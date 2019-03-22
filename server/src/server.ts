"use strict";

import { log } from "util";
import {
    CodeActionParams, CodeLens, CodeLensParams,
    createConnection, IConnection, InitializeResult, IPCMessageReader,
    IPCMessageWriter, Location, RenameParams, TextDocument,
    TextDocumentItem, TextDocumentPositionParams, TextDocuments, WorkspaceEdit,
} from "vscode-languageserver";
import Uri from "vscode-uri";
import { DafnyInstaller } from "./backend/dafnyInstaller";
import { IDafnySettings } from "./backend/dafnySettings";
import { DependencyVerifier } from "./backend/dependencyVerifier";
import { ReferencesCodeLens } from "./backend/features/codeLenses";
import { ICompilerResult } from "./backend/ICompilerResult";
import { DafnyServerProvider } from "./frontend/dafnyProvider";
import { NotificationService } from "./notificationService";
import { InfoMsg } from "./strings/stringRessources";
import { LanguageServerNotification, LanguageServerRequest } from "./strings/stringRessources";

const MAX_CONNECTION_RETRIES = 30;

const connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
const documents: TextDocuments = new TextDocuments();
const codeLenses: { [codeLens: string]: ReferencesCodeLens; } = {};
let settings: ISettings;
let started: boolean = false;
let notificationService: NotificationService;
let dafnyInstaller: DafnyInstaller;

documents.listen(connection);

let workspaceRoot: string;
let provider: DafnyServerProvider;

connection.onInitialize((params): InitializeResult => {
    workspaceRoot = params.rootPath!; // TODO: This line is probably the main reason why only workspaces can be opened.
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
    dafnyInstaller = new DafnyInstaller(notificationService);
    DependencyVerifier.verifyDafnyServer(workspaceRoot, notificationService, settings.dafny)
    .then((serverVersion: string) => {
        init(serverVersion);
        dafnyInstaller.latestVersionInstalled(serverVersion)
        .then((latest) => {
            if (!latest) {
                connection.sendNotification(LanguageServerNotification.DafnyMissing, InfoMsg.DafnyUpdateAvailable);
            }
        })
        .catch((e) => {
            log(e);
            console.error(`Can't check for new dafny version, error message: ${e}`);
        });
    })
    .catch((e) => {
        log(e);
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

connection.onRenameRequest(async (handler: RenameParams): Promise<WorkspaceEdit> => {
    if (provider && provider.renameProvider) {
        const workspaceEdit = await provider.renameProvider.provideRenameEdits(documents.get(handler.textDocument.uri), handler.position, handler.newName);
        if (workspaceEdit === null) {
            throw new Error(`Could not prepare a workspace edit for the rename to ${handler.newName} / position ${handler.position}`);
        }
        return workspaceEdit;
    }
    return Promise.reject("The language provider was not ready");
});

connection.onDefinition(async (handler: TextDocumentPositionParams): Promise<Location> => {
    if (provider && provider.definitionProvider) {
        const newLocal = await provider.definitionProvider.provideDefinition(documents.get(handler.textDocument.uri), handler.position);
        if (newLocal === null) {
            throw new Error(`Could not find definition of ${handler.position}`);
        }
        return newLocal;
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

connection.onCodeLensResolve(async (handler: CodeLens): Promise<CodeLens> => {
    if (provider && provider.referenceProvider) {
        const item = codeLenses[JSON.stringify(handler)];
        if (item) {
            const newLocal = await provider.referenceProvider.resolveCodeLens(item);
            if (newLocal === null) {
                throw new Error(`Could not resolve CodeLens for ${handler.range} / item ${item}`);
            }
            return newLocal;
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

connection.onRequest<ICompilerResult, void>(LanguageServerRequest.Compile, (uri: Uri): Promise<ICompilerResult> => {
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
