---
name: Bug report
about: Report unexpected behavior or an error
title: "[BUG] "
labels: bug
assignees: ""
---

## Description

Brief description of what went wrong.

## Steps to reproduce

1. Run `lodestone [command]`
2. (specific steps)
3. See error

## Expected behavior

What should have happened.

## Actual behavior

What actually happened (output, error message, state of the system).

## Environment

Include the exact output of these commands (copy and paste, do not summarize):

```bash
lodestone doctor
claude --version
node --version
```

OS and version (e.g., macOS 14.0, Ubuntu 22.04, Windows 11):

## Logs

Relevant content from `~/.config/lodestone/lodestone.log` (if available). Copy the excerpt that corresponds to the timestamp when the error occurred.

## Privacy

Do not paste:
- Contents of real Claude Code transcripts or session files
- Credentials, API keys, or authentication tokens
- Real profile names if they contain sensitive information

If you need to share transcript content, sanitize it or create a synthetic example.

## Additional context

Anything else relevant: which profile you were using, whether `lodestone doctor` passes, any custom config in `~/.config/lodestone/config.json`, etc.
