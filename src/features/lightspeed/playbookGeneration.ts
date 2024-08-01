import * as vscode from "vscode";
import { v4 as uuidv4 } from "uuid";
import { LanguageClient } from "vscode-languageclient/node";
import { Webview, Uri, WebviewPanel } from "vscode";
import { getNonce } from "../utils/getNonce";
import { getUri } from "../utils/getUri";
import { SettingsManager } from "../../settings";
import { isLightspeedEnabled, lightSpeedManager } from "../../extension";
import { LightspeedUser } from "./lightspeedUser";
import { GenerationResponse } from "@ansible/ansible-language-server/src/interfaces/lightspeedApi";
import {
  LightSpeedCommands,
  PlaybookGenerationActionType,
} from "../../definitions/lightspeed";
import { isError, UNKNOWN_ERROR } from "./utils/errors";
import { getOneClickTrialProvider } from "./utils/oneClickTrial";

let currentPanel: WebviewPanel | undefined;
let wizardId: string | undefined;
let currentPage: number | undefined;

async function openNewPlaybookEditor(playbook: string) {
  const options = {
    language: "ansible",
    content: playbook,
  };

  const doc = await vscode.workspace.openTextDocument(options);
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
}

function contentMatch(generationId: string, playbook: string) {
  lightSpeedManager.contentMatchesProvider.suggestionDetails = [
    {
      suggestionId: generationId,
      suggestion: playbook,
      isPlaybook: true,
    },
  ];
  // Show training matches for the accepted suggestion.
  vscode.commands.executeCommand(
    LightSpeedCommands.LIGHTSPEED_FETCH_TRAINING_MATCHES,
  );
}

async function sendActionEvent(
  action: PlaybookGenerationActionType,
  toPage?: number | undefined,
) {
  if (currentPanel && wizardId) {
    const fromPage = currentPage;
    currentPage = toPage;
    try {
      lightSpeedManager.apiInstance.feedbackRequest(
        {
          playbookGenerationAction: {
            wizardId,
            action,
            fromPage,
            toPage,
          },
        },
        process.env.TEST_LIGHTSPEED_ACCESS_TOKEN !== undefined,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      vscode.window.showErrorMessage(e.message);
    }
  }
}

async function generatePlaybook(
  text: string,
  outline: string | undefined,
  generationId: string,
  client: LanguageClient,
  lightspeedAuthenticatedUser: LightspeedUser,
  settingsManager: SettingsManager,
  panel: vscode.WebviewPanel,
): Promise<GenerationResponse> {
  const accessToken =
    await lightspeedAuthenticatedUser.getLightspeedUserAccessToken();

  try {
    panel.webview.postMessage({ command: "startSpinner" });
    const createOutline = outline === undefined;
    const playbook: GenerationResponse = await client.sendRequest(
      "playbook/generation",
      {
        accessToken,
        URL: settingsManager.settings.lightSpeedService.URL,
        text,
        outline,
        createOutline,
        generationId,
        wizardId,
      },
    );
    return playbook;
  } finally {
    panel.webview.postMessage({ command: "stopSpinner" });
  }
}

export async function showPlaybookGenerationPage(
  extensionUri: vscode.Uri,
  client: LanguageClient,
  lightspeedAuthenticatedUser: LightspeedUser,
  settingsManager: SettingsManager,
) {
  // Check if Lightspeed is enabled or not.  If it is not, return without opening the panel.
  if (!(await isLightspeedEnabled())) {
    return;
  }

  const accessToken =
    await lightspeedAuthenticatedUser.getLightspeedUserAccessToken();
  if (!accessToken) {
    return;
  }

  if (currentPanel) {
    currentPanel.reveal();
    return;
  }

  // Create a new panel and update the HTML
  const panel = vscode.window.createWebviewPanel(
    "noteDetailView",
    "Title",
    vscode.ViewColumn.One,
    {
      // Enable JavaScript in the webview
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, "out"),
        vscode.Uri.joinPath(extensionUri, "media"),
      ],
      enableCommandUris: true,
      retainContextWhenHidden: true,
    },
  );

  panel.onDidDispose(async () => {
    await sendActionEvent(PlaybookGenerationActionType.CLOSE_CANCEL, undefined);
    currentPanel = undefined;
    wizardId = undefined;
  });

  currentPanel = panel;
  wizardId = uuidv4();

  panel.webview.onDidReceiveMessage(async (message) => {
    const command = message.command;
    switch (command) {
      case "outline": {
        try {
          if (!message.outline) {
            generatePlaybook(
              message.text,
              undefined,
              message.generationId,
              client,
              lightspeedAuthenticatedUser,
              settingsManager,
              panel,
            ).then(async (response: GenerationResponse) => {
              if (isError(response)) {
                const oneClickTrialProvider = getOneClickTrialProvider();
                response = oneClickTrialProvider.mapError(response);
                if (!(await oneClickTrialProvider.showPopup(response))) {
                  vscode.window.showErrorMessage(
                    response.message ?? UNKNOWN_ERROR,
                  );
                }
              } else {
                panel.webview.postMessage({
                  command: "outline",
                  outline: response,
                });
              }
            });
          } else {
            panel.webview.postMessage({
              command: "outline",
              outline: {
                playbook: message.playbook,
                outline: message.outline,
                generationId: message.generationId,
              },
            });
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          vscode.window.showErrorMessage(e.message);
        }
        break;
      }

      case "generateCode": {
        let { playbook, generationId } = message;
        const outline = message.outline;
        const darkMode = message.darkMode;
        if (!playbook) {
          try {
            const response = await generatePlaybook(
              message.text,
              message.outline,
              message.generationId,
              client,
              lightspeedAuthenticatedUser,
              settingsManager,
              panel,
            );
            if (isError(response)) {
              vscode.window.showErrorMessage(response.message ?? UNKNOWN_ERROR);
              break;
            }
            playbook = response.playbook;
            generationId = response.generationId;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (e: any) {
            vscode.window.showErrorMessage(e.message);
            break;
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let syntaxHighlighter: any;
        try {
          syntaxHighlighter =
            await require(/* webpackIgnore: true */ "../../syntaxHighlighter/src/syntaxHighlighter");
        } catch (error) {
          syntaxHighlighter =
            await require(/* webpackIgnore: true */ "../../../../syntaxHighlighter/src/syntaxHighlighter");
        }
        const html = await syntaxHighlighter.codeToHtml(
          playbook,
          darkMode ? "dark-plus" : "light-plus",
          "yaml",
        );

        panel.webview.postMessage({
          command: "playbook",
          playbook: {
            playbook,
            generationId,
            outline,
            html,
          },
        });

        contentMatch(generationId, playbook);
        break;
      }
      case "transition": {
        const { toPage } = message;
        await sendActionEvent(PlaybookGenerationActionType.TRANSITION, toPage);
        break;
      }
      case "openEditor": {
        const { playbook } = message;
        await openNewPlaybookEditor(playbook);
        await sendActionEvent(
          PlaybookGenerationActionType.CLOSE_ACCEPT,
          undefined,
        );
        // Clear wizardId to suppress another CLOSE event at dispose()
        wizardId = undefined;
        panel?.dispose();
        break;
      }
    }
  });

  panel.title = "Ansible Lightspeed";
  panel.webview.html = getWebviewContent(panel.webview, extensionUri);
  panel.webview.postMessage({ command: "init" });

  await sendActionEvent(PlaybookGenerationActionType.OPEN, 1);
}

export function getWebviewContent(webview: Webview, extensionUri: Uri) {
  const webviewUri = getUri(webview, extensionUri, [
    "out",
    "client",
    "webview",
    "apps",
    "lightspeed",
    "playbookGeneration",
    "main.js",
  ]);
  const styleUri = getUri(webview, extensionUri, [
    "media",
    "playbookGeneration",
    "style.css",
  ]);
  const codiconsUri = getUri(webview, extensionUri, [
    "media",
    "codicons",
    "codicon.css",
  ]);
  const nonce = getNonce();

  return /*html*/ `
  <!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};'">
    <link rel="stylesheet" href="${codiconsUri}">
    <link rel="stylesheet" href="${styleUri}">
    <title>Playbook</title>
</head>

<body>
    <div class="playbookGeneration">
        <h2 id="main-header">Create a Rulebook with Ansible Lightspeed</h2>
        <div class="pageNumber" id="page-number">1 of 2</div>
        <div class="promptContainer">
          <span>
            "<span id="prompt"></span>"&nbsp;
            <a class="backAnchor" id="back-anchor">Edit</a>
          </span>
        </div>
        <div class="firstMessage">
          <h3>What do you want the Rulebook to accomplish?</h3>
        </div>
        <div class="secondMessage">
          <h3>Review the suggested steps for your Rulebook and modify as needed.</h3>
        </div>
        <div class="thirdMessage">
          <h3>The following Rulebook was generated for you:</h3>
        </div>
        <div class="mainContainer">
          <div class="editArea">
            <div class="sourceMessage">
              <h4>Please describe the source.</h4>
            </div>
            <vscode-text-area rows=5 resize="vertical"
                placeholder="receive webhook events"
                id="source-text-area">
            </vscode-text-area>
            <div class="conditionMessage">
              <h4>Please describe the condition.</h4>
            </div>
            <vscode-text-area rows=5 resize="vertical"
                placeholder="event.body is defined"
                id="condition-text-area">
            </vscode-text-area>
            <div class="actionMessage">
              <h4>Please describe the action.</h4>
            </div>
            <vscode-text-area rows=5 resize="vertical"
                placeholder="run a job template with some extra_vars"
                id="action-text-area">
            </vscode-text-area>
            <div class="outlineContainer">
              <!-- TODO -->
              <ol id="outline-list" contentEditable="true">
               <li></li>
              </ol>
              <div class="gen-source">
                <h4>Generated source</h4>
              </div>
              <vscode-text-area rows=5 resize="vertical"
                  id="source-gen-area">
              </vscode-text-area>
              <div class="gen-condition">
                <h4>Generated condition</h4>
              </div>
              <vscode-text-area rows=5 resize="vertical"
                  id="condition-gen-area">
              </vscode-text-area>
              <div class="gen-action">
                <h4>Generated action</h4>
              </div>
              <vscode-text-area rows=5 resize="vertical"
                  id="action-gen-area">
              </vscode-text-area>

            </div>
            <div class="spinnerContainer">
              <span class="codicon-spinner codicon-loading codicon-modifier-spin" id="loading"></span>
            </div>
          </div>
          <div class="formattedPlaybook">
            <span id="formatted-code"></span>
          </div>
          <div class="bigIconButtonContainer">
            <vscode-button class="biggerButton" id="submit-button" disabled>
              Generate
            </vscode-button>
          </div>
          <div class="resetFeedbackContainer">
            <div class="resetContainer">
              <vscode-button appearance="secondary" id="reset-button" disabled>
                Reset
              </vscode-button>
            </div>
          </div>
        </div>
        <div class="examplesContainer">
            <h3>Example</h3>
            <h4>If you input each box as</h4>
            <h4>source</h4>
            <div class="exampleTextContainer">
              <p>
                receives events from kafka on host 127.0.0.1
              </p>
            </div>
            <h4>condition</h4>
            <div class="exampleTextContainer">
              <p>
                event.body is defined 
              </p>
            </div>
            <h4>action</h4>
            <div class="exampleTextContainer">
              <p>
                run a job template with some extra_vars
              </p>
            </div>
            <h4>the full prompt will be</h4>
            <div class="exampleTextContainer">
              <p>
                Generate an Ansible Rulebook which receives events from kafka on host 127.0.0.1 and run a job template with some extra_vars when event.body is defined.
              </p>
            </div>
        </div>
        <div class="continueButtonContainer">
            <vscode-button class="biggerButton" id="continue-button">
                Continue
            </vscode-button>
        </div>
        <div class="generatePlaybookContainer">
          <vscode-button class="biggerButton" id="generate-button">
              Generate Rulebook
          </vscode-button>
          <vscode-button class="biggerButton" id="back-button" appearance="secondary">
              Back
          </vscode-button>
        </div>
        <div class="openEditorContainer">
          <vscode-button class="biggerButton" id="open-editor-button">
              Open editor
          </vscode-button>
          <vscode-button class="biggerButton" id="back-to-page2-button" appearance="secondary">
              Back
          </vscode-button>
        </div>
    </div>
    </div>
    <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
</body>

</html>
  `;
}
