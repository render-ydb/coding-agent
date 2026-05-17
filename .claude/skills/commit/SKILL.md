---
name: commit
description: Generate a conventional commit message from staged changes
when-to-use: When the user asks to commit, create a commit, or save changes
context: inline
---

Generate a git commit message for the currently staged changes.

Steps:
1. Run `git diff --cached` to see staged changes
2. Run `git log --oneline -5` to see recent commit style
3. Write a concise commit message following conventional commits format (feat/fix/docs/refactor/test/chore)
4. Focus on the "why" not the "what"

$ARGUMENTS
