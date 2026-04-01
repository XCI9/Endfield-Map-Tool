// ─────────────────────────────────────────────
// i18n + UI text compatibility layer
// ─────────────────────────────────────────────

(function initI18N(global) {
    const LANGUAGE_STORAGE_KEY = 'endfield.lang';
    const LOCALES = global.END_FIELD_LOCALES || {};
    const DEFAULT_LANGUAGE = 'zh-TW';
    const LANGUAGE_LABELS = {
        'zh-TW': '繁體中文',
        'zh-CN': '简体中文',
        en: 'English',
    };
    const SUPPORTED_LANGUAGES = (() => {
        const localeKeys = Object.keys(LOCALES || {});
        const normalized = localeKeys
            .map((lang) => normalizeLanguage(lang))
            .filter((lang, index, list) => list.indexOf(lang) === index);
        if (!normalized.includes(DEFAULT_LANGUAGE)) normalized.unshift(DEFAULT_LANGUAGE);
        return normalized;
    })();
    const SUPPORTED_LANGUAGE_SET = new Set(SUPPORTED_LANGUAGES);

    function detectLanguageToken(lang) {
        if (!lang) return null;
        const normalized = String(lang).trim();
        const lower = normalized.toLowerCase();
        if (lower.startsWith('zh-cn') || lower.includes('hans')) return 'zh-CN';
        if (lower === 'zh' || lower === 'zh-tw' || lower.startsWith('zh-tw-') || lower === 'zh-hant' || lower.startsWith('zh-hant-')) return 'zh-TW';
        if (lower === 'en' || lower.startsWith('en-')) return 'en';
        return null;
    }

    function normalizeLanguage(lang) {
        return detectLanguageToken(lang) || DEFAULT_LANGUAGE;
    }

    function toSupportedLanguage(lang) {
        const normalized = detectLanguageToken(lang);
        if (!normalized) return null;
        return SUPPORTED_LANGUAGE_SET.has(normalized) ? normalized : null;
    }

    function splitPathSegments(pathname) {
        return String(pathname || '/')
            .split('/')
            .map((segment) => segment.trim())
            .filter((segment) => segment.length > 0);
    }

    function getPathContext(pathname) {
        const segments = splitPathSegments(pathname);
        if (segments[segments.length - 1]?.toLowerCase() === 'index.html') {
            segments.pop();
        }

        let language = DEFAULT_LANGUAGE;
        let languageSegmentIndex = -1;
        for (let index = 0; index < segments.length; index += 1) {
            const candidate = toSupportedLanguage(segments[index]);
            if (candidate) {
                language = candidate;
                languageSegmentIndex = index;
                break;
            }
        }

        if (languageSegmentIndex >= 0) {
            segments.splice(languageSegmentIndex, 1);
        }

        return {
            language,
            hasLanguageSegment: languageSegmentIndex >= 0,
            baseSegments: segments,
        };
    }

    function getLanguagePath(language, pathname) {
        const targetLanguage = toSupportedLanguage(language) || DEFAULT_LANGUAGE;
        const context = getPathContext(pathname ?? global.location?.pathname ?? '/');
        const segments = context.baseSegments.slice();

        if (targetLanguage !== DEFAULT_LANGUAGE) {
            segments.push(targetLanguage);
        }

        if (segments.length === 0) return '/';
        return `/${segments.join('/')}/`;
    }

    function getLanguageUrl(language, pathname) {
        const path = getLanguagePath(language, pathname);
        const origin = global.location?.origin || '';
        return `${origin}${path}`;
    }

    function detectInitialLanguage() {
        const fromPath = getPathContext(global.location?.pathname || '/');
        if (fromPath.hasLanguageSegment) return fromPath.language;
        return DEFAULT_LANGUAGE;
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
        getLanguagePath,
        getLanguageUrl,
        getDefaultLanguage: () => DEFAULT_LANGUAGE,
        getLanguageLabel: (language) => {
            const normalized = toSupportedLanguage(language) || DEFAULT_LANGUAGE;
            return LANGUAGE_LABELS[normalized] || normalized;
        },
        t,
        getStatusToastLoadingKeywords,
        getMapName: (mapKey) => resolveMapName(mapKey),
        getSupportedLanguages: () => SUPPORTED_LANGUAGES.slice(),
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
