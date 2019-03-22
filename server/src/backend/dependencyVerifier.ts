"use strict";

import * as cp from "child_process";
import { NotificationService } from "../notificationService";
import { ProcessWrapper } from "../process/process";
import { Command } from "./Command";
import { IDafnySettings } from "./dafnySettings";
import { Environment } from "./environment";

const VERSION_STRING = "VERSION:";

// TODO: This file should be reimplemented and the dafny process / parsing abstracted cleanly.
export class DependencyVerifier {

    public static verifyDafnyServer(
        rootPath: string,
        notificationService: NotificationService,
        dafnySettings: IDafnySettings): Promise<string> {
        const environment: Environment = new Environment(rootPath, notificationService, dafnySettings);
        const spawnOptions = environment.getStandardSpawnOptions();
        const command = environment.getStartDafnyCommand();

        return new Promise((resolve, reject) => {
            const serverProc = DependencyVerifier.spawnNewProcess(command, spawnOptions, resolve, reject);
            serverProc.sendRequestToDafnyServer("", "version");
        });
    }

    private static parseVersion(outBuf: string): string | undefined {
        if (outBuf.indexOf(VERSION_STRING) > -1) {
            const start = outBuf.indexOf(VERSION_STRING);
            const end = outBuf.indexOf("\n", start);
            return outBuf.substring(start + VERSION_STRING.length, end);
        }
        return undefined;
    }

    private static spawnNewProcess(
        dafnyCommand: Command,
        options: cp.SpawnOptions,
        resolve: (value?: string | PromiseLike<string> | undefined) => void,
        reject: (reason?: any) => void,
    ): ProcessWrapper {
        const process = cp.spawn(dafnyCommand.command, dafnyCommand.args, options);
        process.on("error", (e) => reject(e));
        process.stdin.on("error", (e) => reject(e));

        const processWrapper = new ProcessWrapper(process,
            (err: Error) => reject(err),
            () => {
                const versionString = DependencyVerifier.parseVersion(processWrapper.outBuf);
                if (versionString) {
                    processWrapper.sendQuit();
                    resolve(versionString);
                }
            },
            (code: number) => {
                console.log(`The verifyer process ended with code ${code}`);
                if (code !== 0) {
                    reject(code);
                }
            },
        );

        return processWrapper;
    }
}
