# Tour system

The tour walks new users through the chat sidebar, model picker, agent step
controls, and feature toggles by spotlighting one or more elements per stage
and optionally driving UI on stage entry. A stage describes which named
"cutouts" to highlight, a markdown caption to show, and an ordered list of
actions to perform when the stage activates. The controller (`controller.ts`)
manages the active stage index and runs `onEnter` actions through the typed
`performAction` API in `actions.ts`. Cutouts are looked up by selector in
`cutouts.ts`, and component-local state is reached through small imperative
bridges registered in `bridge.ts`.

## Adding a stage

1. Create a new file in `site/src/lib/tour/stages/` named with the next
   ordinal prefix, for example `06-my-stage.ts`. Use `02-welcome.ts` as a
   template.
2. Import `TourStage` from `../types`. Pick one or more `CutoutId` values
   from `../cutouts` for the `cutouts` array — the type system rejects
   anything not in the registry.
3. If the stage needs to toggle UI on entry, add `onEnter` steps using the
   typed `ActionName` and `ActionParams` keys from `../actions`. Use
   `delayMs` to space typing or animation steps.
4. Set `next: 'manual'` to wait for the user to click Next, or
   `next: 'auto-after-actions'` to advance once `onEnter` finishes.
5. Register the stage in `stages/index.ts` by importing the default export
   and appending it to `DEFAULT_TOUR.stages`.

If the stage needs to spotlight a new element, add a `CutoutId` entry to
`cutouts.ts` and add a matching `data-tour-id="<id>"` attribute to the
component that owns the element. The `cutouts.test.ts` source-level grep
will fail if a non-optional id is missing from the components.

## Action catalogue

| Action                 | Params                                                  | Notes                                                                                                |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `toggleModelDropdown`  | `{ open: boolean }`                                     | Opens or closes the chat sidebar model menu via the chat bridge.                                     |
| `selectModel`          | `{ modelId: string }`                                   | Requests a switch to a local Gemma model id. The user still confirms via the existing apply UI.      |
| `typeMessage`          | `{ text: string; clearFirst?: boolean }`                | Sets the chat textarea value. The bridge replaces the field with the new text.                       |
| `pressStepButton`      | `{}`                                                    | Synthesises a click on the chat Step button via `document.querySelector`.                            |
| `pressPlayButton`      | `{}`                                                    | Synthesises a click on the chat Play button via `document.querySelector`.                            |
| `pressRunButton`       | `{}`                                                    | Synthesises a click on the execution panel's Run button (no-op when the button is disabled).         |
| `toggleFeatureSelector`| `{ open: boolean }`                                     | Opens or closes the execution panel feature menu via the exec bridge.                                |
| `setEnabledFeatures`   | `{ features: Partial<Record<FeatureKey, boolean>> }`    | Toggles one or more agent features (`dataLoading`, `runSql`, `runPython`, `runReact`, `runSubAgent`).|
| `setPythonCode`        | `{ code: string }`                                      | Switches to the Python tab and loads `code` into the editor as an unsaved edit so Run is enabled.    |
| `waitForLlmIdle`       | `{ timeoutMs?: number }`                                | Resolves on the `false → true → false` edge of `llm.active`; resolves with a warning on timeout.     |
| `waitForPythonIdle`    | `{ timeoutMs?: number }`                                | Resolves once the Python pane returns from `pending`/`running`; warns on timeout.                    |
| `newChat`              | `{}`                                                    | Clears the chat history and resets debugger / token / sub-agent state — same as the New Chat button. |

## Cutout catalogue

| Cutout id                    | Label                                  | Optional |
| ---------------------------- | -------------------------------------- | -------- |
| `chat.modelDropdown`         | Model selection dropdown trigger       | no       |
| `chat.messageEntry`          | Chat message textarea                  | no       |
| `chat.stepButton`            | Step button                            | no       |
| `chat.playButton`            | Play button                            | yes      |
| `chat.conversation`          | Conversation message list              | no       |
| `chat.compactionRunButton`   | Compact / Run compaction button        | yes      |
| `exec.featureSelector`       | Feature selector trigger               | no       |
| `exec.explainerPanel`        | Explainer panel                        | yes      |
| `exec.codeEditor`            | Code editor section                    | yes      |
| `exec.dataPanel`             | Data panel                             | yes      |

## Bridge mechanism

ChatSidebar and ExecutionPanel keep dropdown-open and textarea state in
component-local `useState`. There is no global store for these, so a tour
action cannot reach them by importing a setter. Instead each component
registers an imperative handle (a `ChatBridge` or `ExecBridge`) on mount via
`registerChatBridge` / `registerExecBridge`. Actions like
`toggleModelDropdown` and `typeMessage` look up the registered bridge and
call its methods. Actions that drive global stores (`setEnabledFeatures`)
or fire DOM clicks (`pressStepButton`, `pressPlayButton`) do not need a
bridge. If a tour action runs while the relevant component is unmounted,
`getChatBridge` / `getExecBridge` throw — the controller catches and logs
this so a missing component does not abort the tour.
