import * as vscode from "vscode";
import * as path from "path";
import * as yaml from "yaml";
import AdmZip = require("adm-zip");
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { sign } from "../utils/cryptography";
import { Dynatrace } from "../dynatrace-api/dynatrace";
import { DynatraceAPIError } from "../dynatrace-api/errors";
import { normalizeExtensionVersion, incrementExtensionVersion, getDatasourceName } from "../utils/extensionParsing";
import { FastModeStatus } from "../statusBar/fastMode";
import { exec, ExecOptions, ProcessEnvOptions } from "child_process";
import { getPythonPath } from "../utils/otherExtensions";

type FastModeOptions = {
  status: FastModeStatus;
  document: vscode.TextDocument;
};

/**
 * Builds an Extension 2.0 and its artefacts into a .zip package ready to upload to Dynatrace.
 * The extension files must all be in an extension folder in the workspace, and developer
 * certificates must be available - either user's own or generated by this extension.
 * If successful, the command is linked to uploading the package to Dynatrace.
 * Note: Only custom extensions may be built/signed using this method.
 * @param context VSCode Extension Context
 * @param oc JSON OutputChannel where detailed errors can be logged
 * @param dt Dynatrace API Client if proper validation is to be done
 * @returns
 */
export async function buildExtension(
  context: vscode.ExtensionContext,
  oc: vscode.OutputChannel,
  dt?: Dynatrace,
  fastMode?: FastModeOptions
) {
  // Basic details we already know exist
  const workspaceStorage = context.storageUri!.fsPath;
  const workSpaceConfig = vscode.workspace.getConfiguration("dynatrace", null);
  const devKey = workSpaceConfig.get("developerKeyLocation") as string;
  const devCert = workSpaceConfig.get("developerCertificateLocation") as string;
  const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const distDir = path.resolve(workspaceRoot, "dist");
  const extensionFile = fastMode
    ? fastMode.document.fileName
    : await vscode.workspace.findFiles("**/extension/extension.yaml").then((files) => files[0].fsPath);
  const extensionDir = path.resolve(extensionFile, "..");

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Building extension",
    },
    async (progress) => {
      // Pre-build workflow
      progress.report({ message: "Checking prerequisites" });
      try {
        fastMode
          ? await preBuildTasks(distDir, extensionFile, true, dt)
          : await preBuildTasks(distDir, extensionFile, false, dt);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error during pre-build phase: ${err.message}`);
        return;
      }

      // Package assembly workflow
      progress.report({ message: "Building extension package" });
      const extension = yaml.parse(readFileSync(extensionFile).toString());
      const zipFilename = `${extension.name.replace(":", "_")}-${extension.version}.zip`;
      try {
        getDatasourceName(extension) === "python"
          ? await assemblePython(workspaceRoot, workspaceStorage, devKey, devCert, oc)
          : assembleStandard(workspaceStorage, extensionDir, zipFilename, devKey, devCert);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error during archiving & signing: ${err.message}`);
        return;
      }

      // Validation & upload workflow
      if (fastMode) {
        progress.report({ message: "Uploading & activating extension" });
        await uploadAndActivate(workspaceStorage, zipFilename, distDir, extension, dt!, fastMode.status, oc);
      } else {
        progress.report({ message: "Validating extension" });
        const valid = await validateExtension(workspaceStorage, zipFilename, distDir, oc, dt);
        if (valid) {
          vscode.window
            .showInformationMessage(
              "Extension built successfully. Would you like to upload it to Dynatrace?",
              "Yes",
              "No"
            )
            .then((choice) => {
              if (choice === "Yes") {
                vscode.commands.executeCommand("dt-ext-copilot.uploadExtension");
              }
            });
        }
      }
    }
  );
}

/**
 * Carries out general tasks that should be executed before the build workflow.
 * Ensures the dist folder exists and increments the extension version in case there might
 * be a conflict on the tenant (if dt is provided).
 * @param distDir path to the "dist" directory within the workspace
 * @param extensionFile path to the extension.yaml file within the workspace
 * @param dt optional Dynatrace API Client
 */
async function preBuildTasks(distDir: string, extensionFile: string, forceIncrement: boolean = false, dt?: Dynatrace) {
  // Create the dist folder if it doesn't exist
  if (!existsSync(distDir)) {
    mkdirSync(distDir);
  }

  if (forceIncrement) {
    // Always increment the version
    const extension = yaml.parse(readFileSync(extensionFile).toString());
    const extensionVersion = normalizeExtensionVersion(extension.version);
    extension.version = incrementExtensionVersion(extensionVersion);
    writeFileSync(extensionFile, yaml.stringify(extension, { lineWidth: 0 }));
    vscode.window.showInformationMessage("Extension version automatically increased.");
  } else if (dt) {
    // Increment the version if there is clash on the tenant
    const extension = yaml.parse(readFileSync(extensionFile).toString());
    const extensionVersion = normalizeExtensionVersion(extension.version);
    const versions = await dt.extensionsV2
      .listVersions(extension.name)
      .then((ext) => ext.map((e) => e.version))
      .catch(() => [] as string[]);
    if (versions.includes(extensionVersion)) {
      extension.version = incrementExtensionVersion(extensionVersion);
      writeFileSync(extensionFile, yaml.stringify(extension, { lineWidth: 0 }));
      vscode.window.showInformationMessage("Extension version automatically increased.");
    }
  }
}

/**
 * Carries out the archiving and signing parts of the extension build workflow.
 * The intermediary files (inner & outer .zips and signature) are created and stored
 * within the VS Code workspace storage folder to not crowd the user's workspace.
 * @param workspaceStorage path to the VS Code folder for this workspace's storage
 * @param extensionDir path to the "extension" folder within the workspace
 * @param zipFileName the name of the .zip file for this build
 * @param devKeyPath the path to the developer's private key
 * @param devCertPath the path to the developer's certificate
 */
function assembleStandard(
  workspaceStorage: string,
  extensionDir: string,
  zipFileName: string,
  devKeyPath: string,
  devCertPath: string
) {
  // Build the inner .zip archive
  const innerZip = new AdmZip();
  innerZip.addLocalFolder(extensionDir);
  const innerZipPath = path.resolve(workspaceStorage, "extension.zip");
  innerZip.writeZip(innerZipPath);
  console.log(`Built the inner archive: ${innerZipPath}`);

  // Sign the inner .zip archive and write the signature file
  const signature = sign(innerZipPath, devKeyPath, devCertPath);
  const sigatureFilePath = path.resolve(workspaceStorage, "extension.zip.sig");
  writeFileSync(sigatureFilePath, signature);
  console.log(`Wrote the signature file: ${sigatureFilePath}`);

  // Build the outer .zip that includes the inner .zip and the signature file
  const outerZip = new AdmZip();
  const outerZipPath = path.resolve(workspaceStorage, zipFileName);
  outerZip.addLocalFile(innerZipPath);
  outerZip.addLocalFile(sigatureFilePath);
  outerZip.writeZip(outerZipPath);
  console.log(`Wrote initial outer zip at: ${outerZipPath}`);
}

/**
 * Executes the given command in a child process and wraps the whole thing in a Promise.
 * This way the execution is async but other code can await it.
 * On success, returns the exit code (if any). Will throw any error with the message
 * part of the stderr (the rest is included via output channel)
 * @param command the command to execute
 * @param oc JSON output channel to communicate error details
 * @returns exit code or `null`
 */
function runCommand(command: string, oc: vscode.OutputChannel, envOptions?: ExecOptions): Promise<number | null> {
  let p = exec(command, envOptions);
  let [stdout, stderr] = ["", ""];
  return new Promise((resolve, reject) => {
    p.stdout?.on("data", (data) => (stdout += data.toString()));
    p.stderr?.on("data", (data) => (stderr += data.toString()));
    p.on("exit", (code) => {
      if (code !== 0) {
        let [shortMessage, details] = [stderr, [""]];
        if (stderr.includes("ERROR") && stderr.includes("+")) {
          [shortMessage, ...details] = stderr.substring(stderr.indexOf("ERROR") + 7).split("+");
        }
        oc.replace(
          JSON.stringify(
            { error: shortMessage.split("\r\n"), detailedOutput: `+${details.join("+")}`.split("\r\n") },
            null,
            2
          )
        );
        oc.show();
        reject(Error(shortMessage));
      }
      console.log(stdout);
      return resolve(code);
    });
  });
}

/**
 * Carries out the archiving and signing parts of the extension build workflow.
 * This function is meant for Python extesnions 2.0, therefore all the steps are carried
 * out through `dt-sdk` which must be available on the machine.
 * @param extensionDir path to the "extension" folder within the workspace
 * @param devKeyPath the path to the developer's private key
 * @param devCertPath the path to the developer's certificate
 * @param oc JSON output channel for communicating errors
 */
async function assemblePython(extensionDir: string, distDir: string, devKeyPath: string, devCertPath: string, oc: vscode.OutputChannel) {
  let envOptions = {} as ExecOptions;
  const pythonPath = await getPythonPath();

  if (pythonPath !== "python") {
    envOptions = {
      env: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        PATH: `${path.resolve(pythonPath, "..")}${path.delimiter}${process.env.PATH}`, // add the python bin directory to the PATH
        // eslint-disable-next-line @typescript-eslint/naming-convention
        VIRTUAL_ENV: path.resolve(pythonPath, "..", ".."), // virtual env is right above bin directory
      },
    };
  }

  // Check we can run dt-sdk
  await runCommand("dt-sdk --help", oc, envOptions); // this will throw if dt-sdk is not available

  // Build
  await runCommand(`dt-sdk build -k "${devKeyPath}" -c "${devCertPath}" "${extensionDir}" -t "${distDir}"`, oc, envOptions);
}

/**
 * Validates a finalized extension archive against a Dynatrace tenant, if one is connected.
 * Returns true if either the extension passed validation or no API client is connected.
 * Upon success, the final extension archive is moved into the workspace's "dist" folder and
 * removed from the VSCode workspace storage folder (intermediary location).
 * @param workspaceStorage path to the VS Code folder for this workspace's storage
 * @param zipFileName the name of the .zip file for this build
 * @param distDir path to the "dist" folder within the workspace
 * @param oc JSON output channel for communicating errors
 * @param dt optional Dynatrace API Client (needed for real validation)
 * @returns validation status
 */
async function validateExtension(
  workspaceStorage: string,
  zipFileName: string,
  distDir: string,
  oc: vscode.OutputChannel,
  dt?: Dynatrace
) {
  var valid = true;
  const outerZipPath = path.resolve(workspaceStorage, zipFileName);
  const finalZipPath = path.resolve(distDir, zipFileName);
  if (dt) {
    await dt.extensionsV2.upload(readFileSync(outerZipPath), true).catch((err: DynatraceAPIError) => {
      vscode.window.showErrorMessage("Extension validation failed.");
      oc.replace(JSON.stringify(err.errorParams.data, null, 2));
      oc.show();
      valid = false;
    });
  }
  // Copy .zip archive into dist dir
  if (valid) {
    copyFileSync(outerZipPath, finalZipPath);
  }
  // Always remove from extension storage
  rmSync(outerZipPath);

  return valid;
}

/**
 * An all-in-one upload & activation flow designed to be used for fast mode builds.
 * If the extension limit has been reached on tenant, either the first or the last version is
 * removed automatically, the extension uploaded, and immediately activated.
 * This skips any prompts compared to regular flow and does not preform any validation.
 * @param workspaceStorage path to the VS Code folder for this workspace's storage
 * @param zipFileName the name of the .zip file for this build
 * @param distDir path to the "dist" folder within the workspace
 * @param extension extension.yaml serialized as object
 * @param dt Dynatrace API Client
 * @param status status bar to be updated with build status
 * @param oc JSON output channel for communicating errors
 */
async function uploadAndActivate(
  workspaceStorage: string,
  zipFileName: string,
  distDir: string,
  extension: ExtensionStub,
  dt: Dynatrace,
  status: FastModeStatus,
  oc: vscode.OutputChannel
) {
  try {
    // Check upload possible
    var existingVersions = await dt.extensionsV2.listVersions(extension.name).catch((err) => {
      return [];
    });
    if (existingVersions.length >= 10) {
      // Try delete oldest version
      await dt.extensionsV2.deleteVersion(extension.name, existingVersions[0].version).catch(async () => {
        // Try delete newest version
        await dt.extensionsV2.deleteVersion(extension.name, existingVersions[existingVersions.length - 1].version);
      });
    }

    const file = readFileSync(path.resolve(workspaceStorage, zipFileName));
    // Upload to Dynatrace
    do {
      var lastError;
      var uploadStatus: string = await dt.extensionsV2
        .upload(file)
        .then(() => "success")
        .catch((err: DynatraceAPIError) => {
          lastError = err;
          return err.errorParams.message;
        });
      // Previous version deletion may not be complete yet, loop until done.
      if (uploadStatus.startsWith("Extension versions quantity limit")) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } while (uploadStatus.startsWith("Extension versions quantity limit"));

    // Activate extension or throw error
    if (uploadStatus === "success") {
      dt.extensionsV2.putEnvironmentConfiguration(extension.name, extension.version);
    } else {
      throw lastError;
    }

    // Copy .zip archive into dist dir
    copyFileSync(path.resolve(workspaceStorage, zipFileName), path.resolve(distDir, zipFileName));
    status.updateStatusBar(true, extension.version, true);
    oc.clear();
  } catch (err: any) {
    // Mark the status bar as build failing
    status.updateStatusBar(true, extension.version, false);
    // Provide details in output channel
    oc.replace(
      JSON.stringify(
        {
          extension: extension.name,
          version: extension.version,
          errorDetails: err.errorParams,
        },
        null,
        2
      )
    );
    oc.show();
  } finally {
    rmSync(path.resolve(workspaceStorage, zipFileName));
  }
}
