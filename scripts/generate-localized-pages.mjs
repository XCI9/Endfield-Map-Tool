import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const projectRoot = process.cwd();
const templatePath = path.join(projectRoot, 'templates', 'page.template.html');
const localeSourcePath = path.join(projectRoot, 'src', 'ui-locales.js');

const siteOrigin = 'https://xci9.github.io';
const repoBase = '/Endfield-Map-Tool';
const defaultLanguage = 'zh-TW';

const templateHtml = fs.readFileSync(templatePath, 'utf8').replace(/^\uFEFF/, '');

function loadLocalesFromUiLocales() {
  const localeSource = fs.readFileSync(localeSourcePath, 'utf8').replace(/^\uFEFF/, '');
  const sandbox = { window: {}, console };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(localeSource, sandbox, { filename: 'src/ui-locales.js' });
  const locales = sandbox.window.END_FIELD_LOCALES;
  if (!locales || typeof locales !== 'object') {
    throw new Error('Failed to read END_FIELD_LOCALES from src/ui-locales.js');
  }
  return locales;
}

function toLanguageLabelKey(languageCode) {
  if (languageCode === 'zh-TW') return 'zhTW';
  if (languageCode === 'zh-CN') return 'zhCN';
  const [base, region] = String(languageCode).split('-');
  if (!region) return base;
  return `${base}${region.charAt(0).toUpperCase()}${region.slice(1)}`;
}

function getLanguagePath(languageCode) {
  return languageCode === defaultLanguage ? '/' : `/${languageCode}/`;
}

function toAbsoluteSiteUrl(pathname) {
  return `${siteOrigin}${repoBase}${pathname === '/' ? '/' : pathname}`;
}

function getHeadText(locales, languageCode) {
  const fallback = locales[defaultLanguage]?.text?.head || {};
  const current = locales[languageCode]?.text?.head || {};
  return {
    title: current.title || fallback.title || 'Endfield Map Tool',
    description: current.description || fallback.description || '',
    keywords: current.keywords || fallback.keywords || '',
    ogTitle: current.ogTitle || current.title || fallback.ogTitle || fallback.title || '',
    ogDescription: current.ogDescription || current.description || fallback.ogDescription || fallback.description || '',
    twitterTitle: current.twitterTitle || current.title || fallback.twitterTitle || fallback.title || '',
    twitterDescription: current.twitterDescription || current.description || fallback.twitterDescription || fallback.description || '',
  };
}

function getLanguageDisplayName(locales, currentLanguageCode, targetLanguageCode) {
  const currentLangText = locales[currentLanguageCode]?.text?.language || {};
  const targetLangText = locales[targetLanguageCode]?.text?.language || {};
  const targetKey = toLanguageLabelKey(targetLanguageCode);
  return currentLangText[targetKey] || targetLangText[targetKey] || targetLanguageCode;
}

function buildAlternateLinks(languageCodes) {
  const lines = languageCodes.map((languageCode) => {
    const href = toAbsoluteSiteUrl(getLanguagePath(languageCode));
    return `    <link rel="alternate" hreflang="${languageCode}" href="${href}">`;
  });
  lines.push(`    <link rel="alternate" hreflang="x-default" href="${toAbsoluteSiteUrl(getLanguagePath(defaultLanguage))}">`);
  return lines.join('\n');
}

function buildLanguageLinkItems(locales, languageCodes, pageLanguageCode) {
  return languageCodes.map((languageCode) => {
    const href = `${getLanguagePath(languageCode)}`;
    const label = getLanguageDisplayName(locales, pageLanguageCode, languageCode);
    return `                    <a class="language-link" href="${href}" :class="{ active: currentLanguage === '${languageCode}' }" :aria-current="currentLanguage === '${languageCode}' ? 'page' : null">${label}</a>`;
  }).join('\n');
}

function renderPage(locales, languageCodes, pageLanguageCode) {
  const head = getHeadText(locales, pageLanguageCode);
  const canonicalUrl = toAbsoluteSiteUrl(getLanguagePath(pageLanguageCode));
  const replacements = {
    '{{HTML_LANG}}': pageLanguageCode,
    '{{BASE_TAG}}': pageLanguageCode === defaultLanguage ? '' : '<base href="../">',
    '{{HEAD_TITLE}}': head.title,
    '{{HEAD_DESCRIPTION}}': head.description,
    '{{HEAD_KEYWORDS}}': head.keywords,
    '{{OG_TITLE}}': head.ogTitle,
    '{{OG_DESCRIPTION}}': head.ogDescription,
    '{{TWITTER_TITLE}}': head.twitterTitle,
    '{{TWITTER_DESCRIPTION}}': head.twitterDescription,
    '{{CANONICAL_URL}}': canonicalUrl,
    '{{ALTERNATE_LINKS}}': buildAlternateLinks(languageCodes),
    '{{LANGUAGE_LINK_ITEMS}}': buildLanguageLinkItems(locales, languageCodes, pageLanguageCode),
  };

  let output = templateHtml;
  for (const [token, value] of Object.entries(replacements)) {
    output = output.split(token).join(value);
  }
  return `${output.replace(/^\uFEFF/, '').trimEnd()}\n`;
}

const locales = loadLocalesFromUiLocales();
const languageCodes = Object.keys(locales).sort((a, b) => {
  if (a === defaultLanguage) return -1;
  if (b === defaultLanguage) return 1;
  return a.localeCompare(b);
});

if (!languageCodes.includes(defaultLanguage)) {
  throw new Error(`Default language ${defaultLanguage} is missing in src/ui-locales.js`);
}

for (const languageCode of languageCodes) {
  const outputHtml = renderPage(locales, languageCodes, languageCode);
  const outputPath = languageCode === defaultLanguage
    ? path.join(projectRoot, 'index.html')
    : path.join(projectRoot, languageCode, 'index.html');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outputHtml, 'utf8');
  console.log(`Generated: ${outputPath}`);
}

const lastmod = new Date().toISOString().slice(0, 10);
const sitemapEntries = languageCodes
  .map((languageCode) => {
    const languagePath = getLanguagePath(languageCode);
    return `  <url>\n    <loc>${toAbsoluteSiteUrl(languagePath)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n  </url>`;
  })
  .join('\n');

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">\n${sitemapEntries}\n</urlset>\n`;

const sitemapPath = path.join(projectRoot, 'sitemap.xml');
fs.writeFileSync(sitemapPath, sitemapXml, 'utf8');
console.log(`Generated: ${sitemapPath}`);
