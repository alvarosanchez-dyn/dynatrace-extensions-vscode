import * as vscode from "vscode";
import { loadSchemas } from "./commandPalette/loadSchemas";
import { initWorkspace } from "./commandPalette/initWorkspace";
import { generateCerts } from "./commandPalette/generateCertificates";
import { uploadCertificate } from "./commandPalette/uploadCertificate";
import { createDocumentation } from "./commandPalette/createDocumentation";
import { buildExtension } from "./commandPalette/buildExtension";
import { TopologyCompletionProvider } from "./codeCompletions/topology";
import {
  checkBitBucketReady,
  checkCertificateExists,
  checkEnvironmentConnected,
  checkExtensionZipExists,
  checkOverwriteCertificates,
  checkWorkspaceOpen,
  isExtensionsWorkspace,
} from "./utils/conditionCheckers";
import { getAllEnvironments, getAllWorkspaces, initGlobalStorage, initWorkspaceStorage } from "./utils/fileSystem";
import { ExtensionsTreeDataProvider } from "./treeViews/extensionsTreeView";
import { SnippetGenerator } from "./codeActions/snippetGenerator";
import { uploadExtension } from "./commandPalette/uploadExtension";
import { activateExtension } from "./commandPalette/activateExtension";
import { EntitySelectorCompletionProvider } from "./codeCompletions/entitySelectors";
import { EnvironmentsTreeDataProvider } from "./treeViews/environmentsTreeView";
import { ConnectionStatusManager } from "./statusBar/connection";
import { SelectorCodeLensProvider } from "./codeLens/selectorCodeLens";
import { MetricResultsPanel } from "./webviews/metricResults";
import { IconCompletionProvider } from "./codeCompletions/icons";
import { CachedDataProvider } from "./utils/dataCaching";
import { ScreensMetaCompletionProvider } from "./codeCompletions/screensMeta";
import { runSelector, validateSelector } from "./codeLens/utils/selectorUtils";
import { FastModeStatus } from "./statusBar/fastMode";
import { DiagnosticsProvider } from "./diagnostics/diagnostics";
import { PrometheusCodeLensProvider } from "./codeLens/prometheusScraper";
import { PrometheusCompletionProvider } from "./codeCompletions/prometheus";
import { PrometheusActionProvider } from "./codeActions/prometheus";
import { createOverviewDashboard } from "./commandPalette/createDashboard";
import { ScreenLensProvider } from "./codeLens/screenCodeLens";
import { BitBucketStatus } from "./statusBar/bitbucket";

/**
 * Sets up the VSCode extension by registering all the available functionality as disposable objects.
 * Activation events (e.g. run command) always trigger this function.
 * @param context VSCode Extension Context
 */
export function activate(context: vscode.ExtensionContext) {
  console.log("DYNATRACE EXTENSION DEVELOPER - ACTIVATED!");

  // Initialize global storage
  initGlobalStorage(context);

  // Document selector for the extension.yaml file
  const extension2selector: vscode.DocumentSelector = { language: "yaml", pattern: "**/extension/extension.yaml" };
  // Additonal context: number of workspaces affects the welcome message for the extensions tree view
  vscode.commands.executeCommand("setContext", "dt-ext-copilot.numWorkspaces", getAllWorkspaces(context).length);
  // Additonal context: different welcome message for the extensions tree view if inside a workspace
  vscode.commands.executeCommand("setContext", "dt-ext-copilot.extensionWorkspace", isExtensionsWorkspace(context));
  // Additional context: number of environments affects the welcome message for the tenants tree view
  vscode.commands.executeCommand("setContext", "dt-ext-copilot.numEnvironments", getAllEnvironments(context).length);
  // Create feature/data providers
  const extensionsTreeViewProvider = new ExtensionsTreeDataProvider(context);
  const connectionStatusManager = new ConnectionStatusManager();
  const tenantsTreeViewProvider = new EnvironmentsTreeDataProvider(context, connectionStatusManager);
  const cachedDataProvider = new CachedDataProvider(tenantsTreeViewProvider);
  const snippetCodeActionProvider = new SnippetGenerator();
  const metricLensProvider = new SelectorCodeLensProvider(
    "metricSelector:",
    "metricSelectorsCodeLens",
    cachedDataProvider
  );
  const entityLensProvider = new SelectorCodeLensProvider(
    "entitySelectorTemplate:",
    "entitySelectorsCodeLens",
    cachedDataProvider
  );
  const screensLensProvider = new ScreenLensProvider(tenantsTreeViewProvider);
  const prometheusLensProvider = new PrometheusCodeLensProvider(cachedDataProvider);
  const prometheusActionProvider = new PrometheusActionProvider(cachedDataProvider);
  const fastModeChannel = vscode.window.createOutputChannel("Dynatrace Fast Mode", "json");
  const fastModeStatus = new FastModeStatus(fastModeChannel);
  const genericChannel = vscode.window.createOutputChannel("Dynatrace", "json");
  const diagnosticsProvider = new DiagnosticsProvider();
  var editTimeout: NodeJS.Timeout | undefined;
  if (checkWorkspaceOpen() && isExtensionsWorkspace(context)) {
    checkBitBucketReady().then((ready) => {
      if (ready) {
        new BitBucketStatus(context);
      }
    });
  }

  // Perform all feature registrations
  context.subscriptions.push(
    // Commands for the Command Palette
    ...registerCommandPaletteCommands(tenantsTreeViewProvider, diagnosticsProvider, genericChannel, context),
    // Auto-completion providers
    ...registerCompletionProviders(extension2selector, cachedDataProvider),
    // Extension 2.0 Workspaces Tree View
    vscode.window.registerTreeDataProvider("dt-ext-copilot-workspaces", extensionsTreeViewProvider),
    // Dynatrace Environments Tree View
    vscode.window.registerTreeDataProvider("dt-ext-copilot-environments", tenantsTreeViewProvider),
    // Code actions for adding snippets
    vscode.languages.registerCodeActionsProvider(extension2selector, snippetCodeActionProvider, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    // Code actions for Prometheus data
    vscode.languages.registerCodeActionsProvider(extension2selector, prometheusActionProvider, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    // Connection Status Bar Item
    connectionStatusManager.getStatusBarItem(),
    // FastMode Status Bar Item
    fastModeStatus.getStatusBarItem(),
    // Code Lens for Prometheus scraping
    vscode.languages.registerCodeLensProvider(extension2selector, prometheusLensProvider),
    // Code Lens for metric and entity selectors
    vscode.languages.registerCodeLensProvider(extension2selector, metricLensProvider),
    vscode.languages.registerCodeLensProvider(extension2selector, entityLensProvider),
    // Code Lens for opening screens
    vscode.languages.registerCodeLensProvider(extension2selector, screensLensProvider),
    // Commands for metric and entity selector Code Lenses
    vscode.commands.registerCommand(
      "dt-ext-copilot.codelens.validateSelector",
      async (selector: string, type: "metric" | "entity") => {
        if (checkEnvironmentConnected(tenantsTreeViewProvider)) {
          const status = await validateSelector(selector, type, (await tenantsTreeViewProvider.getDynatraceClient())!);
          return type === "metric"
            ? metricLensProvider.updateValidationStatus(selector, status)
            : entityLensProvider.updateValidationStatus(selector, status);
        }
      }
    ),
    vscode.commands.registerCommand(
      "dt-ext-copilot.codelens.runSelector",
      async (selector: string, type: "metric" | "entity") => {
        if (checkEnvironmentConnected(tenantsTreeViewProvider)) {
          runSelector(selector, type, (await tenantsTreeViewProvider.getDynatraceClient())!, genericChannel);
        }
      }
    ),
    // Web view panel - metric query results
    vscode.window.registerWebviewPanelSerializer(MetricResultsPanel.viewType, {
      async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
        console.log(`Got state: ${state}`);
        webviewPanel.webview.options = { enableScripts: true };
        MetricResultsPanel.revive(webviewPanel, "No data to display. Close the tab and trigger the action again.");
      },
    }),
    // Activity on every document save
    vscode.workspace.onDidSaveTextDocument(async (doc: vscode.TextDocument) => {
      // Fast Development Mode - build extension
      if (
        vscode.workspace.getConfiguration("dynatrace", null).get("fastDevelopmentMode") &&
        doc.fileName.endsWith("extension.yaml") &&
        isExtensionsWorkspace(context) &&
        checkEnvironmentConnected(tenantsTreeViewProvider)
      ) {
        const dt = await tenantsTreeViewProvider.getDynatraceClient();
        buildExtension(context, fastModeChannel, dt, { status: fastModeStatus, document: doc });
      }
    }),
    // Activity on active document changed
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.fileName.endsWith("extension.yaml")) {
        diagnosticsProvider.provideDiagnostics(editor.document);
      }
    }),
    // Activity on every text change in a document
    vscode.workspace.onDidChangeTextDocument((change) => {
      if (change.document.fileName.endsWith("extension.yaml")) {
        // Allow 0.5 sec after doc changes to reduce execution frequency
        if (editTimeout) {
          clearTimeout(editTimeout);
          editTimeout = undefined;
        }
        editTimeout = setTimeout(() => {
          diagnosticsProvider.provideDiagnostics(change.document);
          editTimeout = undefined;
        }, 500);
      }
    }),
    // Activity on every configuration change
    vscode.workspace.onDidChangeConfiguration(() => {
      const fastModeEnabled = vscode.workspace.getConfiguration("dynatrace", null).get("fastDevelopmentMode");
      fastModeStatus.updateStatusBar(Boolean(fastModeEnabled));
    })
  );
  // We may have an initialization pending from previous window/activation.
  if (context.globalState.get("dt-ext-copilot.initPending")) {
    vscode.commands.executeCommand("dt-ext-copilot.initWorkspace");
  }
}

/**
 * Registers Completion Providers for this extension.
 * This is so that all providers can be created in one function, keeping the activation function more tidy.
 * @param documentSelector {@link vscode.DocumentSelector} matching the extension.yaml file
 * @param cachedDataProvider a provider for cached data
 * @returns list of providers as disposables
 */
function registerCompletionProviders(
  documentSelector: vscode.DocumentSelector,
  cachedDataProvider: CachedDataProvider
): vscode.Disposable[] {
  return [
    // Topology data
    vscode.languages.registerCompletionItemProvider(
      documentSelector,
      new TopologyCompletionProvider(cachedDataProvider),
      ":"
    ),
    // Entity selectors
    vscode.languages.registerCompletionItemProvider(
      documentSelector,
      new EntitySelectorCompletionProvider(cachedDataProvider),
      ":"
    ),
    // Barista icons
    vscode.languages.registerCompletionItemProvider(
      documentSelector,
      new IconCompletionProvider(cachedDataProvider),
      ":"
    ),
    // Screens metadata/items
    vscode.languages.registerCompletionItemProvider(documentSelector, new ScreensMetaCompletionProvider(), ":"),
    // Prometheus data
    vscode.languages.registerCompletionItemProvider(
      documentSelector,
      new PrometheusCompletionProvider(cachedDataProvider)
    ),
  ];
}

/**
 * Registers this extension's Commands for the VSCode Command Palette.
 * This is so that all commands can be created in one function, keeping the activation function more tidy.
 * @param tenantsProvider a provider for environments tree data
 * @param diagnosticsProvider a provider for diagnostics
 * @param outputChannel a JSON output channel for communicating data
 * @param context {@link vscode.ExtensionContext}
 * @returns list commands as disposables
 */
function registerCommandPaletteCommands(
  tenantsProvider: EnvironmentsTreeDataProvider,
  diagnosticsProvider: DiagnosticsProvider,
  outputChannel: vscode.OutputChannel,
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  return [
    // Load extension schemas of a given version
    vscode.commands.registerCommand("dt-ext-copilot.loadSchemas", async () => {
      if (checkEnvironmentConnected(tenantsProvider)) {
        loadSchemas(context, (await tenantsProvider.getDynatraceClient())!);
      }
    }),
    // Initialize a new workspace for extension development
    vscode.commands.registerCommand("dt-ext-copilot.initWorkspace", async () => {
      if (checkWorkspaceOpen() && checkEnvironmentConnected(tenantsProvider)) {
        initWorkspaceStorage(context);
        try {
          initWorkspace(context, (await tenantsProvider.getDynatraceClient())!, () => {
            tenantsProvider.refresh();
          });
        } finally {
          context.globalState.update("dt-ext-copilot.initPending", undefined);
        }
      }
    }),
    // Generate the certificates required for extension signing
    vscode.commands.registerCommand("dt-ext-copilot.generateCertificates", async () => {
      if (checkWorkspaceOpen()) {
        initWorkspaceStorage(context);
        return await checkOverwriteCertificates(context).then(async (approved) => {
          if (approved) {
            return await generateCerts(context);
          }
        });
      }
    }),
    // Upload certificate to Dynatrace credential vault
    vscode.commands.registerCommand("dt-ext-copilot.uploadCertificate", async () => {
      if (checkWorkspaceOpen() && checkEnvironmentConnected(tenantsProvider)) {
        initWorkspaceStorage(context);
        if (checkCertificateExists("ca")) {
          uploadCertificate(context, (await tenantsProvider.getDynatraceClient())!);
        }
      }
    }),
    // Build Extension 2.0 package
    vscode.commands.registerCommand("dt-ext-copilot.buildExtension", async () => {
      if (
        (await diagnosticsProvider.isValidForBuilding()) &&
        checkWorkspaceOpen() &&
        isExtensionsWorkspace(context) &&
        checkCertificateExists("dev")
      ) {
        buildExtension(context, outputChannel, await tenantsProvider.getDynatraceClient());
      }
    }),
    // Upload an extension to the tenant
    vscode.commands.registerCommand("dt-ext-copilot.uploadExtension", async () => {
      if (
        checkWorkspaceOpen() &&
        isExtensionsWorkspace(context) &&
        checkEnvironmentConnected(tenantsProvider) &&
        checkExtensionZipExists()
      ) {
        uploadExtension((await tenantsProvider.getDynatraceClient())!);
      }
    }),
    // Activate a given version of extension 2.0
    vscode.commands.registerCommand("dt-ext-copilot.activateExtension", async (version?: string) => {
      if (checkWorkspaceOpen() && isExtensionsWorkspace(context) && checkEnvironmentConnected(tenantsProvider)) {
        activateExtension((await tenantsProvider.getDynatraceClient())!, version);
      }
    }),
    // Create Extension documentation
    vscode.commands.registerCommand("dt-ext-copilot.createDocumentation", () => {
      createDocumentation();
    }),
    // Create Overview dashboard
    vscode.commands.registerCommand("dt-ext-copilot.createDashboard", () => {
      if (checkWorkspaceOpen() && isExtensionsWorkspace(context)) {
        createOverviewDashboard(tenantsProvider, outputChannel);
      }
    }),
  ];
}

/**
 * Performs any kind of necessary clean up.
 * Automatically called when the extension was deactivated (e.g. end of command).
 */
export function deactivate() {
  console.log("DYNATRACE EXTENSION DEVELOPER - DEACTIVATED");
}
