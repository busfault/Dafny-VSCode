import { Position, TextDocument, WorkspaceEdit } from "vscode-languageserver";
import { DocumentDecorator } from "../../vscodeFunctions/documentDecorator";
import { DafnyServer } from "./../dafnyServer";
import { DafnySymbol} from "./symbols";
import { WorkSpaceRenameHolder } from "./WorkSpaceRenameHolder";

export class DafnyRenameProvider {
    public constructor(public server: DafnyServer) { }
    public provideRenameEdits(document: TextDocument, position: Position, newName: string): Thenable<WorkspaceEdit> {
        return this.provideRenameInternal(newName, document, position).then((definitionInfo: WorkspaceEdit) => {
            if (definitionInfo != null) {
                return definitionInfo;
            }
            return null;
        }, (err) => {
            console.error(err);
            return null;
        });
    }

    private provideRenameInternal(newName: string, document: TextDocument, position: Position): Promise<WorkspaceEdit> {
        const documentDecorator: DocumentDecorator = new DocumentDecorator(document);
        const word = documentDecorator.getWordAtPosition(position, false);
        return this.collectRenamings(document, word, newName, position)
            .catch((e: any) => { console.error(e); return {}; });
    }

    private collectRenamings(document: TextDocument, word: string, newName: string, position: Position): Promise<WorkspaceEdit> {
        return this.server.symbolService.getAllSymbols(document).then((symbols: DafnySymbol[]) => {
            const renamer = new WorkSpaceRenameHolder(word, newName, symbols, position);
            const workSpaceEdit: WorkspaceEdit = {};
            workSpaceEdit.changes = renamer.collectRenamings();
            return workSpaceEdit;
        });
    }
}
