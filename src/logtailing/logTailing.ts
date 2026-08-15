import * as vscode from 'vscode';
import { ClarvisLog } from '../ClarvisLog';
import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

let tailingProcess: import('child_process').ChildProcess | undefined;
let tailingStream: fs.WriteStream | undefined;

function getLogDir(): string | undefined {
    const homeDir = os.homedir();
    switch (process.platform) {
        case 'darwin':
            return path.join(homeDir, 'Library', 'Application Support', 'Code', 'logs');
        case 'linux':
            return path.join(homeDir, '.config', 'Code', 'logs');
        case 'win32':
            return path.join(process.env.APPDATA || '', 'Code', 'logs');
        default:
            return undefined;
    }
}


async function findLatestLogFile(logDir: string, log: ClarvisLog): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile('find', [logDir, '-name', '1-main.log'], (error, stdout, stderr) => {
            if (error) {
                log.write(`Error finding log file: ${error.message}`);
                log.write(`stderr: ${stderr}`);
                resolve(undefined);
                return;
            }
            const files = stdout.split('\n').filter(f => f);
            if (files.length === 0) {
                log.write(`No log files found in ${logDir}`);
                resolve(undefined);
                return;
            }

            try {
                const latestFile = files.map(f => ({ file: f, mtime: fs.statSync(f).mtime }))
                    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0];
                resolve(latestFile.file);
            } catch (e: any) {
                log.write(`Error stating log files: ${e.message}`);
                resolve(undefined);
            }
        });
    });
}


export async function startTailing(log: ClarvisLog) {
    if (tailingProcess) {
        vscode.window.showInformationMessage('Clarvis is already tailing VS Code logs.');
        return;
    }

    const confirmed = await vscode.window.showWarningMessage(
        "This will copy VS Code's extension host logs from outside the workspace into a local file (`.clarvis/vscode.log`). The logs may contain sensitive information. Do you approve?",
        { modal: true },
        'Approve'
    );

    if (confirmed !== 'Approve') {
        return;
    }

    const logDir = getLogDir();
    if (!logDir) {
        vscode.window.showErrorMessage('Unsupported OS.');
        return;
    }

    const logPath = await findLatestLogFile(logDir, log);
    
    if (!logPath || !fs.existsSync(logPath)) {
        vscode.window.showErrorMessage('Could not find the VS Code extension host log file.');
        return;
    }
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder is open.');
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const clarvisDir = path.join(workspaceRoot, '.clarvis');
    try {
        if (!fs.existsSync(clarvisDir)) {
            fs.mkdirSync(clarvisDir);
        }
    } catch (e) {
        log.write(`Failed to create .clarvis directory: ${e}`)
        vscode.window.showErrorMessage('Failed to create .clarvis directory.');
        return;
    }
    const tailLogPath = path.join(clarvisDir, 'vscode.log');

    const proc = execFile('tail', ['-f', logPath]);
    proc.on('error', (e) => log.write(`Log tailing process failed: ${e.message}`));
    const writeStream = fs.createWriteStream(tailLogPath);
    writeStream.on('error', (e) => log.write(`Failed writing .clarvis/vscode.log: ${e.message}`));
    proc.stdout?.pipe(writeStream);

    tailingProcess = proc;
    tailingStream = writeStream;

    log.write(`Tailing logs from ${logPath} to ${tailLogPath}`);
    vscode.window.showInformationMessage(`Clarvis is now tailing VS Code logs to .clarvis/vscode.log`);

}

export function stopTailing(log: ClarvisLog) {
    if (tailingProcess) {
        tailingProcess.kill();
        tailingProcess = undefined;
        tailingStream?.end();
        tailingStream = undefined;
        log.write('Stopped tailing logs.');
        vscode.window.showInformationMessage('Clarvis has stopped tailing VS Code logs.');
    } else {
        log.write('No active log tailing process to stop.');
        vscode.window.showInformationMessage('Clarvis is not currently tailing VS Code logs.');
    }
}
