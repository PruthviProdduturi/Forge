/**
 * Forge CLI — VS Code Extension
 *
 * Provides IDE integration for the Forge Platform job scaffolding CLI:
 *   - forge.generate  — run `forge generate --job <name>` in terminal
 *   - forge.check     — run `forge generate --check --job <name>` in terminal
 *   - forge.init      — create a new .forge.ts manifest stub
 *   - Locked-block decorator — grey background on FORGE:LOCKED regions
 *   - Status bar item  — "Forge: {layer}" when a .forge.ts file is active
 */
import * as vscode from "vscode";
import * as path from "path";

// ---------------------------------------------------------------------------
// Sentinel strings that delimit locked regions in generated Python files.
// Must match the values in sdk/cli/src/templates/python.ts
// ---------------------------------------------------------------------------
const LOCKED_START_REGEX = /# ── FORGE:LOCKED:START(?::\w+)? ──/;
const LOCKED_END_REGEX = /# ── FORGE:LOCKED:END(?::\w+)? ──/;

// ---------------------------------------------------------------------------
// Decoration type for locked regions
// ---------------------------------------------------------------------------
const lockedDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.inactiveSelectionBackground"),
  isWholeLine: true,
  opacity: "0.65",
  after: {
    contentText: " 🔒",
    color: new vscode.ThemeColor("editorLineNumber.foreground"),
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the job name from a .forge.ts file path. */
function jobNameFromPath(filePath: string): string {
  return path.basename(filePath, ".forge.ts");
}

/** Determine if the active document is a .forge.ts manifest. */
function isForgeManifest(doc: vscode.TextDocument): boolean {
  return doc.fileName.endsWith(".forge.ts");
}

/** Determine if the active document is a Forge-generated .py file. */
function isGeneratedPy(doc: vscode.TextDocument): boolean {
  return doc.fileName.endsWith(".py");
}

/** Get the forge CLI command from settings. */
function forgeCli(): string {
  const cfg = vscode.workspace.getConfiguration("forge");
  const cliPath = cfg.get<string>("cliPath") || "";
  return cliPath || "npx tsx sdk/cli/src/index.ts";
}

/** Get the output dir from settings. */
function outputDir(): string {
  return vscode.workspace.getConfiguration("forge").get<string>("outputDir") || "examples";
}

/** Get the manifest dir from settings. */
function manifestDir(): string {
  return vscode.workspace.getConfiguration("forge").get<string>("manifestDir") || "examples/src/spark/jobs";
}

/** Run a forge command in a VS Code terminal. */
function runForgeInTerminal(label: string, args: string): void {
  const terminal = vscode.window.createTerminal({ name: `Forge: ${label}` });
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ".";
  terminal.sendText(`cd "${workspaceRoot}" && ${forgeCli()} ${args}`);
  terminal.show();
}

// ---------------------------------------------------------------------------
// Locked region decoration for generated Python files
// ---------------------------------------------------------------------------

function updateLockedDecorations(editor: vscode.TextEditor): void {
  if (!isGeneratedPy(editor.document)) {
    editor.setDecorations(lockedDecorationType, []);
    return;
  }

  const doc = editor.document;
  const decorations: vscode.DecorationOptions[] = [];
  let inLockedBlock = false;
  let blockStartLine = -1;

  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text;

    if (LOCKED_START_REGEX.test(line)) {
      inLockedBlock = true;
      blockStartLine = i;
    }

    if (inLockedBlock) {
      decorations.push({
        range: new vscode.Range(i, 0, i, line.length),
        hoverMessage: "This region is managed by Forge CLI. Run `forge generate` to update.",
      });
    }

    if (LOCKED_END_REGEX.test(line) && inLockedBlock) {
      inLockedBlock = false;
      blockStartLine = -1;
    }
  }

  editor.setDecorations(lockedDecorationType, decorations);
}

// ---------------------------------------------------------------------------
// Status bar item
// ---------------------------------------------------------------------------

function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  item.command = "forge.generate";
  return item;
}

function updateStatusBar(
  statusBar: vscode.StatusBarItem,
  editor: vscode.TextEditor | undefined
): void {
  if (!editor) {
    statusBar.hide();
    return;
  }

  const doc = editor.document;

  if (isForgeManifest(doc)) {
    // Try to extract the layer from the file content
    const text = doc.getText();
    const layerMatch = text.match(/layer\s*:\s*["']([^"']+)["']/);
    const layer = layerMatch?.[1] ?? "?";
    const jobName = jobNameFromPath(doc.fileName);
    statusBar.text = `$(symbol-class) Forge: ${layer} — ${jobName}`;
    statusBar.tooltip = "Click to run forge generate for this manifest";
    statusBar.show();
  } else if (isGeneratedPy(doc) && doc.getText().includes("GENERATED BY FORGE CLI")) {
    statusBar.text = "$(lock) Forge: generated file";
    statusBar.tooltip = "This file is managed by Forge CLI";
    statusBar.show();
  } else {
    statusBar.hide();
  }
}

// ---------------------------------------------------------------------------
// Extension activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = createStatusBarItem();
  context.subscriptions.push(statusBar);

  // ── forge.generate ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("forge.generate", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("Forge: no active editor");
        return;
      }

      const doc = editor.document;
      if (isForgeManifest(doc)) {
        const jobName = jobNameFromPath(doc.fileName);
        runForgeInTerminal(
          `generate ${jobName}`,
          `generate --job ${jobName} --dir ${outputDir()} --manifest-dir ${manifestDir()}`
        );
      } else {
        // Prompt for job name
        vscode.window
          .showInputBox({
            prompt: "Job name (snake_case) to generate",
            placeHolder: "e.g. nyc_taxi_silver",
          })
          .then((jobName) => {
            if (!jobName) return;
            runForgeInTerminal(
              `generate ${jobName}`,
              `generate --job ${jobName} --dir ${outputDir()} --manifest-dir ${manifestDir()}`
            );
          });
      }
    })
  );

  // ── forge.check ─────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("forge.check", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("Forge: no active editor");
        return;
      }

      const doc = editor.document;
      if (isForgeManifest(doc)) {
        const jobName = jobNameFromPath(doc.fileName);
        runForgeInTerminal(
          `check ${jobName}`,
          `generate --check --job ${jobName} --dir ${outputDir()} --manifest-dir ${manifestDir()}`
        );
      } else {
        vscode.window
          .showInputBox({
            prompt: "Job name (snake_case) to check",
            placeHolder: "e.g. nyc_taxi_silver",
          })
          .then((jobName) => {
            if (!jobName) return;
            runForgeInTerminal(
              `check ${jobName}`,
              `generate --check --job ${jobName} --dir ${outputDir()} --manifest-dir ${manifestDir()}`
            );
          });
      }
    })
  );

  // ── forge.init ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("forge.init", async () => {
      const name = await vscode.window.showInputBox({
        prompt: "Job name (snake_case)",
        placeHolder: "e.g. my_dataset_silver",
        validateInput: (v) =>
          /^[a-z][a-z0-9_]*$/.test(v)
            ? undefined
            : "Must be snake_case (lowercase letters, digits, underscores)",
      });
      if (!name) return;

      const layer = await vscode.window.showQuickPick(["bronze", "silver", "gold"], {
        placeHolder: "Select medallion layer",
      });
      if (!layer) return;

      runForgeInTerminal(
        `init ${name}`,
        `init --name ${name} --layer ${layer} --manifest-dir ${manifestDir()}`
      );
    })
  );

  // ── Decorations ─────────────────────────────────────────────────────────
  const updateDecorations = (): void => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      updateLockedDecorations(editor);
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        updateLockedDecorations(editor);
      }
      updateStatusBar(statusBar, editor);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) {
        updateLockedDecorations(editor);
      }
    })
  );

  // Initial state
  updateDecorations();
  updateStatusBar(statusBar, vscode.window.activeTextEditor);
}

export function deactivate(): void {
  // Clean up is handled by context.subscriptions
}
