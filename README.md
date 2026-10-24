# stayontarget

stayontarget keeps Claude Code on the scope you asked for. It turns your prompts into a charter, a short statement of the goal, the work the request implies and anything you excluded. Then it grades each change the agent makes against that charter as in-scope, adjacent or drift. In warn mode it tells the model and you about drift; in strict mode it asks you before a drift change runs. It is a mod for Claude Code 2.1.309 and uses that release's early-access mod API, which may change.

## Install

From a terminal session, at the prompt:

```
/plugin install stayontarget --marketplace bladehstream/stayontarget
```

From a shell:

```
claude plugin install stayontarget --marketplace bladehstream/stayontarget
```

In the desktop app, `/plugin` does not run. Click + next to the prompt box, then Plugins, Add marketplace with `bladehstream/stayontarget`, then Add plugin.

In a terminal, Claude Code asks `Add marketplace?`. Answer `y`, then choose a scope; the user scope is listed first. The install screen also sets the settings described below.

To run the mod from a checkout while developing it, start Claude Code with the folder:

```
claude --plugin-dir <folder>
```

`claude plugin test <folder>` runs the mod's tests against the engine. An interactive session started that way also
writes the API declarations into `.claude-plugin/types/`, after which `tsc -p <folder>` type-checks the mod.

## How it works

**Charter.** The charter comes from your prompts in the main conversation, from the body of a slash command or skill you invoke, and from later amendments. Chit-chat does not change it. A model (the `model` setting) distils your words into the charter. The update is lazy: submitting a prompt makes no model call, and the update runs when the first change needs a verdict. If the update fails or times out, your raw request stands in for the charter, and the pane shows `charter not distilled`.

**What is judged.** Only changes are judged. Calls the engine marks as read-only are never checked and cost nothing. Edits, writes, notebook edits, shell commands and MCP calls are judged, each in a bounded, redacted form. Subagent changes are judged against the charter that was active when they ran.

**Verdicts.** Each judged change gets one verdict:

- in-scope: it serves the goal, or is a normal supporting step.
- adjacent: not asked for, but a small, closely related step.
- drift: work you did not ask for and the goal does not need, or anything you excluded.
- unchecked: the judge failed or the input could not be read. An unchecked change is never blocked.

Two shortcuts run before the judge. An allowance you gave in the pane makes the change in-scope. A cached verdict for the same change is reused; a different change to the same file is judged again.

**Warn mode** is the default. Adjacent changes are recorded and shown in the pane. For a drift change, the mod adds a note to the model after the call. The note says the change looks outside the request and asks the model to say so or stop. When a turn has adjacent or drift changes, a footer lists them below the answer.

**Strict mode** asks you before a drift change runs. Approving it runs that one change and creates no allowance.

## Settings

Defaults come from `plugin.json`:

- `mode`: `warn` (default) or `strict`. Strict mode is for attended sessions. In a headless `claude -p` run nobody can answer the ask, so it becomes a denial.
- `model`: the model used for charter updates and judgements. Default `haiku`.
- `toasts`: show a toast on drift, at most one per 30 seconds. Default off.
- `notify`: send a desktop notification on drift, at most one per minute. Default off.

Invalid values fall back to the defaults.

## What you see

`/stayontarget` opens the pane. `/stayontarget new` starts a new task, which clears the charter; the next main turn creates one. `/stayontarget eval` runs the judge over the labelled cases (see Accuracy).

Each adjacent or drift change offers two actions, wherever it is shown:

- **Allow for this task** makes further changes of the same kind to the same target in-scope for this charter.
- **Dismiss** closes the event.

**In the transcript.** Each judged tool call gets a one-line badge under its row with the verdict and the reason; an open adjacent or drift change carries the two actions there. Hovering a badge lights the matching pane row. The turn footer lists that turn's out-of-scope changes, each with its own actions.

**Above the prompt.** While the current task has open adjacent or drift changes, a band shows the goal, the counts, and **Review** (opens the pane) and **New task**. It disappears when nothing is open and gives up parts on narrow screens.

**Read as.** After a prompt changes the charter, the band and the pane show how it was read, for example
`Read as amendment: "also update the tests"`, with **New task** or **Same task**, **Not a change** and **OK**. Nothing
waits for it; one click corrects the charter (restoring the earlier one, with its allowances, where that applies). It
goes away at the next prompt or after 10 minutes.

**The pane** has two views. The events view shows the goal, a summary of the scope lists, the mode, counts, tokens used, a strip with one coloured block per recent verdict, and the events, newest first. Clicking an event shows the judged excerpt and a link to the file (on the desktop app the file path is shown as text, since it opens only `https:` links). **Edit charter** switches to the charter view, where you can edit the goal and add or remove in-scope and out-of-scope items; the model never overwrites a list you edited. The mode can be switched between warn and strict from the pane; if Claude Code refuses the change, a toast says so and the pane shows the mode still in force.

The pane works on terminal, desktop and VS Code. On mobile everything is read-only.

The status line shows one of four texts:

- `stayontarget: on target`
- `stayontarget: N drift · M adjacent`
- `stayontarget: degraded (K unchecked)`
- `stayontarget: no charter yet`

` · charter not distilled` is added when the charter update failed, and ` · not saved` when the session snapshot
could not be stored.

## Privacy and cost

Only redacted, bounded text leaves the mod, and it goes to your session's own model client. Nothing is sent anywhere else.

Redaction runs before any model call, display or saved state. It replaces bearer and basic auth headers, `Authorization:` headers, password, token, secret and API key assignments, AWS, GitHub, OpenAI, Anthropic and Slack key formats, PEM private key blocks, and URLs with user info. It is pattern-based and best-effort, so unusual quoting or escaping can get past it. One known gap: a URL with a password used as an object key longer
than 256 characters is cut before it is redacted.

Each judged change costs one model call, and each charter revision costs at most one charter update. The pane shows the tokens used. In the spike runs a Haiku judgement took about 1.3 to 1.6 seconds. A Write call took 25 to 40 milliseconds, so warn mode added about 1.3 to 1.5 seconds per judged write. A judged change in warn mode waits at most 7 seconds for its verdict. Strict mode adds the judge time before the call. Cache and allowance hits add no judge time.

## Accuracy

Live eval on 2026-10-24, Claude Code 2.1.309 on Windows 11, model `haiku`, through `/stayontarget eval`.

**Judge** (32 labelled changes): 96.9% accuracy, 0 unchecked, 18 seconds, 19,272 input and 2,524 output tokens.

| Class | Cases | Precision | Recall |
|---|---|---|---|
| Drift | 15 | 100% | 100% |
| In-scope | 13 | 100% | 92.3% |
| Adjacent | 4 | 80% | 100% |

The one miss: an import update labelled in-scope was judged adjacent. The adjacent class has only 4 cases, so its
numbers say little yet.

**Charter classification** (32 labelled prompts): 96.9% accuracy, 0 unchecked, 18 seconds, 15,060 input and 3,283
output tokens. New task: precision 100%, recall 90.9% (11 cases); amendment: 92.9% / 100% (13); chit-chat: 100% /
100% (8). The one miss: a new task on the same file as the current one was read as an amendment, which is the case
the "Read as" line's **New task** button corrects.

## Limitations

- A subagent working in another directory has its paths normalised against the session's directory, so its targets may not match allowances made for relative paths.
- A store write that hangs for more than 30 seconds is abandoned, and if it lands later it can overwrite a newer snapshot of the same session.
- Rows are fitted by character count, not display width, so Chinese, Japanese or other full-width text in a goal or reason can make a row wrap.
- On Windows, a pane file link for a network-share path (`\\server\share\…`) may not open; the path is still shown.
- Eval numbers come from single runs: the same cases can differ by about one case between runs.
- These interactive checks are not yet confirmed: strict mode under `bypassPermissions`, a prompt typed into a running turn, the footer, pane, tool-row badges and band in the desktop app, whether the drift note changes the model's behaviour, and restore after resume, and the "Read as" line.

## Licence

MIT. See `LICENSE`.
