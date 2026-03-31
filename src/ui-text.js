// ─────────────────────────────────────────────
// i18n + UI text compatibility layer
// ─────────────────────────────────────────────

(function initI18N(global) {
    const LANGUAGE_STORAGE_KEY = 'endfield.lang';
    const LOCALES = global.END_FIELD_LOCALES || {};

    function normalizeLanguage(lang) {
        if (!lang) return 'zh-TW';
        const normalized = String(lang).trim();
        const lower = normalized.toLowerCase();
        if (lower.startsWith('zh-cn') || lower.includes('hans')) return 'zh-CN';
        if (lower.startsWith('zh')) return 'zh-TW';
        if (lower.startsWith('en')) return 'en';
        return 'zh-TW';
    }

    function detectInitialLanguage() {
        try {
            const stored = global.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
            if (stored) return normalizeLanguage(stored);
        } catch (_error) {
            // Ignore storage access errors.
        }
        return normalizeLanguage(global.navigator?.language || 'zh-TW');
    }

    let currentLanguage = detectInitialLanguage();
    const listeners = [];

    function getLocale(language = currentLanguage) {
        return LOCALES[language] || LOCALES['zh-TW'] || { mapNames: {}, text: {}, uiText: {} };
    }

    function deepGet(obj, path) {
        return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
    }

    function resolveMapName(mapNameOrKey) {
        const locale = getLocale();
        if (locale.mapNames[mapNameOrKey]) return locale.mapNames[mapNameOrKey];
        if (typeof mapNameOrKey === 'string') {
            const mapEntry = typeof MAPS !== 'undefined' ? Object.values(MAPS).find((item) => item.name === mapNameOrKey) : null;
            if (mapEntry && locale.mapNames) {
                const found = Object.entries(MAPS).find(([, item]) => item === mapEntry);
                if (found && locale.mapNames[found[0]]) return locale.mapNames[found[0]];
            }
        }
        return mapNameOrKey;
    }

    function notifyLanguageChange() {
        listeners.forEach((listener) => {
            try {
                listener(currentLanguage);
            } catch (_error) {
                // Ignore listener errors to keep app stable.
            }
        });
    }

    function setLanguage(lang) {
        const normalized = normalizeLanguage(lang);
        if (normalized === currentLanguage) return currentLanguage;
        currentLanguage = normalized;
        try {
            global.localStorage?.setItem(LANGUAGE_STORAGE_KEY, currentLanguage);
        } catch (_error) {
            // Ignore storage access errors.
        }
        notifyLanguageChange();
        return currentLanguage;
    }

    function t(key) {
        const args = Array.prototype.slice.call(arguments, 1);
        const current = deepGet(getLocale().text, key);
        if (typeof current === 'function') return current.apply(null, args);
        if (current !== undefined) return current;
        const fallback = deepGet((LOCALES['zh-TW'] || {}).text || {}, key);
        if (typeof fallback === 'function') return fallback.apply(null, args);
        return fallback !== undefined ? fallback : key;
    }

    function getStatusToastLoadingKeywords(language = currentLanguage) {
        const localeUi = getLocale(language).uiText || {};
        const fallbackUi = (LOCALES['zh-TW'] || {}).uiText || {};
        const localized = localeUi.STATUS_TOAST?.LOADING_KEYWORDS;
        const fallback = fallbackUi.STATUS_TOAST?.LOADING_KEYWORDS;
        if (Array.isArray(localized) && localized.length > 0) return localized.slice();
        if (Array.isArray(fallback) && fallback.length > 0) return fallback.slice();
        return [];
    }

    function createSectionProxy(sectionName) {
        return new Proxy({}, {
            get(_target, key) {
                const localeUi = getLocale().uiText || {};
                const fallbackUi = (LOCALES['zh-TW'] || {}).uiText || {};
                const section = localeUi[sectionName] || fallbackUi[sectionName] || {};
                const fallbackSection = fallbackUi[sectionName] || {};
                const value = section[key] !== undefined ? section[key] : fallbackSection[key];
                return value;
            },
        });
    }

    const UITextProxy = new Proxy({}, {
        get(_target, sectionName) {
            return createSectionProxy(sectionName);
        },
    });

    global.I18N = {
        getLanguage: () => currentLanguage,
        setLanguage,
        t,
        getStatusToastLoadingKeywords,
        getMapName: (mapKey) => resolveMapName(mapKey),
        getSupportedLanguages: () => ['zh-TW', 'zh-CN', 'en'],
        onChange: (listener) => {
            listeners.push(listener);
            return () => {
                const index = listeners.indexOf(listener);
                if (index >= 0) listeners.splice(index, 1);
            };
        },
    };

    global.UIText = UITextProxy;
})(window);
