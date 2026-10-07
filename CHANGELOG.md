# Fuzzy File Search Changelog

## [TinyCast Compatibility] - 2026-10-07

- Use Homebrew `fd`/`fzf` instead of downloading them; drop `proper-lockfile`, `axios`, `tar`, `extract-zip`, `sha256-file`
- Run fd/fzf through `/bin/sh` redirections and cap results with `head`, since TinyCast ignores `spawn` stdio/signal options and buffers output until exit
- Write fd ignore rules to the extension support directory instead of `~/.config/fd/ignore`
- Rank with `fzf --scheme=path`; `Ignore Spaces in Search` defaults to off

## [Show in Finder Shortcut] - 2026-07-06

- Add Cmd+Enter shortcut to reveal the selected file in Finder by placing Show in Finder as the secondary action

## [Directory and File Search Directives] - 2026-06-17

- Add `-d` / `-f` query directives to search directories or files only
- Parse directives before filtering so they are not passed to `fzf` as search terms
- Debounce fzf filtering and cap results to avoid exceeding Raycast's extension memory limit

## [Open With Action] - 2026-03-12

- Add "Open With" action to open files with a specific application (Cmd+O).

## [Rework] - 2025-10-05

- Use fzf CLI tool for fuzzy finding.
- Add automatic installation of the fzf CLI tool.
- Improve search performance.
- Add caching of indexed files
- Improve UI/UX with toast notifications.
- Fix issue where the heap memory limit is reached.

## [Initial version] - 2025-09-15
