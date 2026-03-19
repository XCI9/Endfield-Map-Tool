// Lightweight parser for project changelog markdown.
// Supported syntax:
// - level-2/3 headings for version: ## v1.2.3
// - bullet list items for change entries: - description

var ChangelogLoader = (function () {
    function normalizeVersion(raw) {
        if (!raw) return '';
        const trimmed = raw.trim();
        if (!trimmed) return '';
        return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
    }

    function parseMarkdown(markdown) {
        const entries = [];
        let currentEntry = null;

        const lines = (markdown || '').split(/\r?\n/);
        for (const line of lines) {
            const versionMatch = line.match(/^#{2,3}\s+(.+?)\s*$/);
            if (versionMatch) {
                if (currentEntry && currentEntry.version && currentEntry.changes.length > 0) {
                    entries.push(currentEntry);
                }

                currentEntry = {
                    version: normalizeVersion(versionMatch[1]),
                    changes: [],
                };
                continue;
            }

            const changeMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/);
            if (changeMatch && currentEntry) {
                currentEntry.changes.push(changeMatch[1].trim());
            }
        }

        if (currentEntry && currentEntry.version && currentEntry.changes.length > 0) {
            entries.push(currentEntry);
        }

        return {
            currentVersion: entries[0]?.version || '',
            entries,
        };
    }

    async function load(path = 'CHANGELOG.md') {
        const cacheBuster = Date.now();
        const response = await fetch(`${path}?v=${cacheBuster}`, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Unable to load changelog: HTTP ${response.status}`);
        }

        const markdown = await response.text();
        const parsed = parseMarkdown(markdown);
        if (!parsed.entries.length) {
            throw new Error('Changelog parsed with zero entries');
        }

        return parsed;
    }

    return {
        load,
        parseMarkdown,
    };
})();
