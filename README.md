# pending-decisions

A Claude Code mod that keeps a list of what Claude is waiting on you to decide in the main conversation.

- **A reminder above the prompt**: `⚖ 2 pending decisions ①Storage format ②Commit it` with an Open button.
- **`/decisions`** opens or closes a pane listing each item with its kind (Decide, Confirm, Info) and Claude's recommendation:
  - **Quote** puts `Re "<title>": ` in the prompt so you can answer it.
  - **Accept** puts `Re "<title>": going with your recommendation (<recommendation>)` in the prompt.
  - **Done** removes the item; **Clear all** removes every item.
  - **Recently removed** shows the last 10 items and how each left the list (accepted, answered, left to AI, withdrawn, removed by you), with **Restore**.
- Items resolve on their own when your next message accepts, answers or hands them back, or when Claude settles them itself.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pending-decisions --marketplace HuliLulu46/pending-decisions
```

Answer `y` to add the marketplace, then pick a scope (user is first).

From a shell:

```
claude plugin install pending-decisions --marketplace HuliLulu46/pending-decisions
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `HuliLulu46/pending-decisions`, then Add plugin.

## How it works

After each main-thread turn that ends with an answer, the mod sends the turn's user message, Claude's replies and the open items to `claude-haiku-5-5`, which returns the items added, resolved and updated. The call runs after the turn, so the prompt stays free while it reads.

## Known limits

- Each main-thread turn costs one small Haiku call.
- Subagent turns are not tracked.
- The list is kept per session, for the 20 most recent sessions; `/clear` empties it.
- Titles and answers are written in the conversation's language.

Built against Claude Code 2.1.300. A mod is an early-access API that may change between releases.

## Develop

```
claude plugin validate .
claude plugin test .
tsc -p .
```

`scripts/e2e.mjs` runs two headless turns against real Haiku and prints the stored list after each. `scripts/eval-prompt.py` replays one transcript turn through the prompt several times to compare prompt versions. Both call a live model.
