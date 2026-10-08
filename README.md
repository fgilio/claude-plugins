# claude-plugins

Franco Gilio's plugin marketplace for [Claude Code](https://code.claude.com). Add it once and install any of the plugins below.

## Usage

```
/plugin marketplace add fgilio/claude-plugins
/plugin install coding@fgilio
```

## Plugins

- **coding** ([fgilio/coding-skill](https://github.com/fgilio/coding-skill)): Franco's code style preferences.
- **skill-design-philosophy** ([fgilio/skill-design-philosophy-skill](https://github.com/fgilio/skill-design-philosophy-skill)): design philosophy for creating outstanding Claude Code skills.
- **polish** ([fgilio/polish-skill](https://github.com/fgilio/polish-skill)): reviews a scope in search of simplifications, unifications, and reductions in cognitive load.
- **fgilio-review** ([fgilio/fgilio-review-skill](https://github.com/fgilio/fgilio-review-skill)): audits a scope through the `coding` and `polish` skills merged into one prioritized list.
- **fgilio-audit** ([fgilio/fgilio-audit-skill](https://github.com/fgilio/fgilio-audit-skill)): audit-only search for materially useful simplifications in a diff, branch, project, or multi-repo feature. Based on [Aaron Francis's "Audit your codebase" prompt](https://gist.github.com/aarondfrancis/8735edbe48532f97ee5ea818db4dbd47).
- **tool-lines** ([fgilio/tool-lines-mod](https://github.com/fgilio/tool-lines-mod)): draws each tool call as one compact line; click a line to see its full input and result in a side pane. Fork of the `tool-lines` mod in [Tickloop/claude-mods](https://github.com/Tickloop/claude-mods).

## Updates

Plugins track the latest commit of their source repositories. Claude Code checks for updates on startup. Run `/plugin update <name>` to update manually, or enable auto-update for this marketplace in the `/plugin` menu.

## License

[MIT](LICENSE)
