# claude-plugins

Franco Gilio's plugin marketplace for [Claude Code](https://code.claude.com). Add it once and install any of the plugins below.

## Usage

```
/plugin marketplace add fgilio/claude-plugins
/plugin install coding@fgilio
```

## Plugins

- **coding** ([fgilio/coding-skill](https://github.com/fgilio/coding-skill)): code style preferences. Expressive naming, fluent interfaces, early returns, Laravel-style comments, Stripe-style docs.
- **skill-design-philosophy** ([fgilio/skill-design-philosophy-skill](https://github.com/fgilio/skill-design-philosophy-skill)): design philosophy for creating outstanding Claude Code skills.
- **polish** ([fgilio/polish-skill](https://github.com/fgilio/polish-skill)): simplification review. Convenes Otwell, DHH, and Wathan as parallel reviewers, plus Porzio when frontend files are in scope. Report-only by default; `--interactive` confirms and implements.
- **fgilio-review** ([fgilio/fgilio-review-skill](https://github.com/fgilio/fgilio-review-skill)): audits a scope through the `coding` and `polish` skills in one pass. Modes: report (default), address, comment (inline PR comments).

## Updates

Plugins track the latest commit of their source repositories. Claude Code checks for updates on startup. Run `/plugin update <name>` to update manually, or enable auto-update for this marketplace in the `/plugin` menu.

## License

[MIT](LICENSE)
