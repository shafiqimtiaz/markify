/**
 * Markify v4.0 — Content Script
 *
 * Philosophy (inspired by microsoft/markitdown & Mozilla Readability):
 *   Different website types need different extraction strategies.
 *   A blog article, a GitHub README, a Wikipedia page, a news article,
 *   a product page, and a documentation site all have different structures.
 *   We detect the type with a confidence score, apply the right strategy,
 *   and produce the cleanest possible Markdown — without ever crashing
 *   on hostile or malformed DOMs.
 *
 * Production hardening:
 *   - Every external call (querySelector, turndown, clipboard) is wrapped
 *     in try/catch with structured fallbacks.
 *   - Site detection returns both a type and a confidence score; low-
 *     confidence detections fall through to a Readability-style scoring
 *     extractor that picks the densest content node.
 *   - Post-processing is code-block-aware: punctuation cleanup, escape
 *     fixes, and heading normalization never touch fenced code spans.
 *   - All user-supplied template strings are substituted safely; YAML
 *     front-matter is properly escaped per the YAML 1.2 spec.
 *
 * Site types detected (v4 — 24 types):
 *   github | github-issue | github-wiki | gitlab | bitbucket
 *   stackoverflow | reddit | twitter | linkedin | youtube
 *   wiki | notion | confluence | discourse | hackernews
 *   blog | news | docs | product | academic | forum | webmail | chatgpt | generic
 *
 * Dependencies: turndown.js, turndown-plugin-gfm.js (loaded before this)
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────
  //  CONSTANTS
  // ──────────────────────────────────────────────
  const VERSION = '4.0';
  const DEBUG = false; // flip to true to verbose-log to console

  // Track code-block fence markers so post-processing can skip them.
  // Populated during post-process by scanning the markdown once.
  const FENCE = '```';

  // ──────────────────────────────────────────────
  //  MESSAGE LISTENER
  // ──────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') { sendResponse({ pong: true, version: VERSION }); return; }

    if (msg.type === 'DETECT') {
      try {
        const det = detectSiteType();
        sendResponse({ siteType: det.type, confidence: det.confidence, scores: det.scores });
      } catch (e) {
        sendResponse({ siteType: 'generic', confidence: 0, error: e.message });
      }
      return;
    }

    if (msg.type === 'CONVERT') {
      try {
        const result = convertPage(msg.options || {});
        sendResponse({ result });
      } catch (e) {
        log('CONVERT error:', e);
        sendResponse({ error: e.message, stack: e.stack });
      }
      return true;
    }

    if (msg.type === 'CONVERT_SELECTION') {
      try {
        const result = convertSelection(msg.options || {});
        sendResponse({ result });
      } catch (e) {
        log('CONVERT_SELECTION error:', e);
        sendResponse({ error: e.message });
      }
      return true;
    }

    if (msg.type === 'COPY_TO_CLIPBOARD') {
      try {
        navigator.clipboard.writeText(msg.text).then(
          () => sendResponse({ success: true }),
          (e) => sendResponse({ success: false, error: e.message })
        );
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }
  });

  // ──────────────────────────────────────────────
  //  SITE TYPE DETECTION (confidence-scored)
  // ──────────────────────────────────────────────
  // Returns { type, confidence, scores } where `scores` is the full
  // candidate→score map (useful for debugging / UI display).
  function detectSiteType() {
    const ctx = buildDetectionContext();
    const candidates = scoreAllCandidates(ctx);

    // Pick the highest-scoring candidate.
    let best = { type: 'generic', confidence: 0 };
    for (const [type, score] of Object.entries(candidates)) {
      if (score > best.confidence) best = { type, confidence: score };
    }

    // Refine GitHub into sub-types (issue / wiki / repo) — only if GitHub
    // is the winning candidate, so we don't override stronger signals.
    if (best.type === 'github') {
      if (ctx.url.includes('/issues/') || ctx.url.includes('/pull/')) best.type = 'github-issue';
      else if (ctx.url.includes('/wiki') || ctx.url.includes('/wiki/')) best.type = 'github-wiki';
    }

    best.scores = candidates;
    return best;
  }

  // Build a single context object so every scorer sees the same data
  // and we don't repeatedly touch the DOM during scoring.
  function buildDetectionContext() {
    const host = (location.hostname || '').toLowerCase();
    const url = location.href || '';
    const meta = {
      ogType: getMeta('og:type') || '',
      ogSiteName: getMeta('og:site_name') || '',
      generator: (getMeta('generator') || '').toLowerCase(),
      appName: (getMeta('application-name') || '').toLowerCase(),
      poweredBy: (safeQuery('meta[name="powered-by"]')?.getAttribute('content') || '').toLowerCase(),
    };

    // DOM probes — each is wrapped so a missing selector doesn't crash.
    const dom = {
      hasArticle: !!safeQuery('article'),
      hasMarkdownBody: !!safeQuery('.markdown-body, article.markdown, [class*="markdown-body"]'),
      hasReadme: !!safeQuery('#readme, [data-testid="readme"]'),
      hasMwContent: !!safeQuery('#mw-content-text, .mw-parser-output'),
      hasInfobox: !!safeQuery('.infobox, .wikitable'),
      hasGitbook: !!safeQuery('[class*="gitbook"], [class*="GitBook"]'),
      hasDocusaurus: !!safeQuery('article.markdown, [class*="docsContent"], .theme-doc-markdown'),
      hasMkDocs: !!safeQuery('.md-content, .md-main'),
      hasVitePress: !!safeQuery('.vp-doc, .VPHero'),
      hasReadthedocs: !!safeQuery('.rst-content, [class*="rst-"]'),
      hasNotion: !!safeQuery('.notion-page, .notion-app, [class*="notion-"]'),
      hasConfluence: !!safeQuery('#confluence-content, .wiki-content, [class*="confluence"]'),
      hasDiscourse: !!safeQuery('.topic-post, .cooked, [class*="discourse"]'),
      hasProductSchema: !!safeQuery('[itemtype*="Product"], [itemtype*="product"]'),
      hasPostBody: !!safeQuery('article.post-content, article.entry-content, article.post-body, .gh-content, article .post-content, article .entry-content, article .post-body'),
      hasForumStructure: !!safeQuery('.forum, .forum-post, .thread, .topic, .comment-list, .post-list'),
      hasTweetArticle: !!safeQuery('article[data-testid="tweet"]'),
      hasReddit: !!safeQuery('shreddit-post, .Post, [class*="reddit-post"]'),
      hasSO: !!safeQuery('.question, .js-post-body, .s-prose'),
      hasYouTube: !!safeQuery('ytd-watch-infoy, #info-contents, ytd-video-description'),
      hasChatGPT: !!safeQuery('[class*="prose"][class*="message"], #chat, [class*="conversation"]'),
      hasLazyLoad: !!safeQuery('[loading="lazy"], [data-src], [data-original]'),
    };

    return { host, url, meta, dom };
  }

  // Each scorer returns an integer score ≥ 0. Higher = more likely.
  // We deliberately use small additive scores so multiple weak signals
  // can combine to outweigh a single strong one — this is what makes
  // the detection robust on sites we've never seen before.
  function scoreAllCandidates(ctx) {
    const scores = {
      github: 0, 'github-issue': 0, 'github-wiki': 0,
      gitlab: 0, bitbucket: 0,
      stackoverflow: 0, reddit: 0, twitter: 0, linkedin: 0, youtube: 0,
      wiki: 0, notion: 0, confluence: 0, discourse: 0, hackernews: 0,
      blog: 0, news: 0, docs: 0, product: 0, academic: 0, forum: 0,
      webmail: 0, chatgpt: 0, generic: 1, // generic always gets 1 as fallback
    };

    // --- Host-based signals (strongest) ---
    const { host, url, meta, dom } = ctx;

    if (host === 'github.com' || host.endsWith('.github.com')) {
      scores.github += 50;
      if (url.includes('/issues/') || url.includes('/pull/')) scores['github-issue'] += 30;
      if (url.includes('/wiki')) scores['github-wiki'] += 30;
    }
    if (host === 'gitlab.com' || host.endsWith('.gitlab.io') ||
        host.endsWith('.gitlab.com') || host === 'about.gitlab.com') {
      scores.gitlab += 50;
    }
    if (host === 'bitbucket.org') scores.bitbucket += 50;

    if (host === 'stackoverflow.com' || host.endsWith('.stackoverflow.com') ||
        host.includes('stackexchange.com') || host.endsWith('.stackexchange.com')) {
      scores.stackoverflow += 50;
    }
    if (host === 'www.reddit.com' || host === 'old.reddit.com' ||
        host === 'reddit.com' || host === 'new.reddit.com') {
      scores.reddit += 50;
    }
    if (host === 'twitter.com' || host === 'x.com' || host === 'mobile.twitter.com') {
      scores.twitter += 50;
    }
    if (host === 'www.linkedin.com' || host === 'linkedin.com') {
      scores.linkedin += 40;
    }
    if (host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'youtube.com') {
      scores.youtube += 50;
    }
    if (host === 'news.ycombinator.com') {
      scores.hackernews += 50;
      scores.forum += 20;
    }
    if (host === 'arxiv.org' || host === 'www.arxiv.org') scores.academic += 50;
    if (host === 'pubmed.ncbi.nlm.nih.gov') scores.academic += 50;
    if (host.endsWith('.scholar.google.com') || host === 'scholar.google.com') scores.academic += 40;
    if (host.endsWith('.doi.org') || host === 'doi.org') scores.academic += 30;

    // Webmail — Gmail, Outlook, Yahoo
    const webmailHosts = ['mail.google.com', 'outlook.live.com', 'outlook.office.com',
      'mail.yahoo.com', 'inbox.google.com'];
    if (webmailHosts.some(h => host === h || host.endsWith('.' + h))) scores.webmail += 50;

    // Wikipedia & related
    if (host.endsWith('.wikipedia.org') || host === 'www.wikidata.org' ||
        host.endsWith('.wikimedia.org') || host.endsWith('.fandom.com') ||
        host.endsWith('.wiki')) {
      scores.wiki += 50;
    }

    // Notion (published pages and the app)
    if (host.endsWith('.notion.site') || host.endsWith('.notion.so') ||
        host === 'notion.so' || host === 'www.notion.so') {
      scores.notion += 50;
    }
    // Confluence / Atlassian
    if (host.endsWith('.atlassian.net') || host.includes('confluence') ||
        host.endsWith('.jira.com')) {
      scores.confluence += 40;
    }

    // Blog platforms
    if (host === 'medium.com' || host.endsWith('.medium.com')) scores.blog += 40;
    if (host.endsWith('.substack.com')) scores.blog += 40;
    if (host === 'dev.to' || host.endsWith('.dev.to') || host.endsWith('.forem.app')) scores.blog += 40;
    if (host.endsWith('.hashnode.dev') || host.endsWith('.hashnode.com')) scores.blog += 40;
    if (host.endsWith('.ghost.io') || host.endsWith('.ghost.org')) scores.blog += 30;
    if (host.endsWith('.tumblr.com')) scores.blog += 30;
    if (host.endsWith('.wordpress.com') || meta.generator.includes('wordpress')) scores.blog += 25;

    // Docs platforms
    const docsHosts = ['readthedocs.io', 'readthedocs.org', 'docs.gitlab.com',
      'docs.docker.com', 'docs.python.org', 'docs.rs', 'developer.mozilla.org',
      'developers.google.com', 'docs.github.com', 'kubernetes.io',
      'webpack.js.org', 'vuejs.org', 'react.dev', 'nextjs.org',
      'tailwindcss.com', 'docs.aws.amazon.com', 'docs.microsoft.com',
      'learn.microsoft.com', 'nodejs.org', 'go.dev', 'doc.rust-lang.org',
      'docs.npmjs.com', 'stripe.com/docs', 'cloud.google.com'];
    if (docsHosts.some(d => host === d || host.endsWith('.' + d))) scores.docs += 40;
    if (host.startsWith('docs.') || host.startsWith('developer.')) scores.docs += 15;
    if (url.match(/\/docs?\/|\/documentation|\/api\/|\/guide\//i)) scores.docs += 10;

    // News
    const newsDomains = ['nytimes.com', 'bbc.com', 'bbc.co.uk', 'theguardian.com',
      'reuters.com', 'apnews.com', 'cnn.com', 'washingtonpost.com', 'npr.org',
      'theverge.com', 'arstechnica.com', 'techcrunch.com', 'wired.com',
      'bloomberg.com', 'ft.com', 'economist.com', 'aljazeera.com', 'cbc.ca',
      'torontostar.com', 'theglobeandmail.com', 'lemonde.fr', 'spiegel.de'];
    if (newsDomains.some(d => host === d || host.endsWith('.' + d))) scores.news += 35;

    // E-commerce
    const productDomains = ['amazon.com', 'amazon.ca', 'amazon.co.uk', 'amazon.de',
      'ebay.com', 'walmart.com', 'target.com', 'bestbuy.com', 'shopify.com',
      'etsy.com', 'aliexpress.com', 'bhphotovideo.com'];
    if (productDomains.some(d => host === d || host.endsWith('.' + d))) scores.product += 35;

    // ChatGPT / AI chat interfaces
    if (host === 'chat.openai.com' || host === 'chatgpt.com' ||
        host === 'claude.ai' || host === 'poe.com') {
      scores.chatgpt += 50;
    }

    // --- Meta-based signals ---
    if (meta.ogType === 'article') { scores.news += 10; scores.blog += 8; }
    if (meta.ogType === 'profile') scores.linkedin += 8;
    if (meta.ogType === 'product' || getMeta('product:price:amount')) scores.product += 20;
    if (meta.generator.includes('wordpress')) scores.blog += 15;
    if (meta.generator.includes('ghost')) scores.blog += 15;
    if (meta.generator.includes('hexo')) scores.blog += 10;
    if (meta.generator.includes('jekyll')) scores.blog += 10;
    if (meta.generator.includes('hugo')) scores.blog += 10;
    if (meta.appName.includes('discourse')) scores.discourse += 30;

    // --- DOM-based signals ---
    if (dom.hasMarkdownBody) { scores.github += 15; scores.docs += 5; }
    if (dom.hasReadme) scores.github += 20;
    if (dom.hasMwContent || dom.hasInfobox) scores.wiki += 30;
    if (dom.hasGitbook) scores.docs += 25;
    if (dom.hasDocusaurus) scores.docs += 25;
    if (dom.hasMkDocs) scores.docs += 25;
    if (dom.hasVitePress) scores.docs += 20;
    if (dom.hasReadthedocs) scores.docs += 25;
    if (dom.hasNotion) scores.notion += 30;
    if (dom.hasConfluence) scores.confluence += 30;
    if (dom.hasDiscourse) scores.discourse += 35;
    if (dom.hasProductSchema) scores.product += 20;
    if (dom.hasPostBody) scores.blog += 15;
    if (dom.hasForumStructure) scores.forum += 15;
    if (dom.hasTweetArticle) scores.twitter += 30;
    if (dom.hasReddit) scores.reddit += 30;
    if (dom.hasSO) scores.stackoverflow += 30;
    if (dom.hasYouTube) scores.youtube += 30;
    if (dom.hasChatGPT) scores.chatgpt += 30;

    // If we have an article element with substantial text, lean blog/generic
    if (dom.hasArticle) {
      const art = safeQuery('article');
      if (art && art.textContent.trim().length > 500) {
        scores.blog += 5;
        scores.news += 5;
        scores.generic += 2;
      }
    }

    return scores;
  }

  // ──────────────────────────────────────────────
  //  MAIN CONVERSION ENTRY
  // ──────────────────────────────────────────────
  function convertPage(opts) {
    opts = opts || {};
    const url = location.href;
    const title = (document.title || '').trim();
    const detection = detectSiteType();
    const siteType = detection.type;

    log('convertPage siteType=', siteType, 'confidence=', detection.confidence, 'opts=', opts);

    // Custom include/exclude selectors from user settings.
    let userExclude = [];
    let userInclude = [];
    try {
      userExclude = (opts.extraExclude || '').split('\n').map(s => s.trim()).filter(Boolean);
      userInclude = (opts.extraInclude || '').split('\n').map(s => s.trim()).filter(Boolean);
    } catch (_) {}

    // 1. Find the content root using site-type-specific strategy.
    let contentRoot;
    try {
      contentRoot = extractContent(siteType, opts, userInclude);
    } catch (e) {
      log('extractContent crashed, falling back:', e);
      contentRoot = extractGeneric(opts);
    }
    if (!contentRoot) contentRoot = document.body;

    // 2. Clone and clean.
    const clone = contentRoot.cloneNode(true);
    cleanDOM(clone, siteType, opts, userExclude);

    // 3. Apply site-type-specific DOM transformations.
    try {
      applySiteTransforms(clone, siteType);
    } catch (e) {
      log('applySiteTransforms error (non-fatal):', e);
    }

    // 4. Unwrap lazy-load image attributes (srcset, data-src, etc.)
    unwrapLazyImages(clone);

    // 5. Convert to Markdown via Turndown.
    let markdown;
    try {
      markdown = toMarkdown(clone, siteType, opts);
    } catch (e) {
      log('Turndown crashed, using plain-text fallback:', e);
      markdown = fallbackToPlainText(clone);
    }

    // 6. Build the header (YAML front matter OR title heading OR none).
    let header = '';
    if (opts.includeMetadata) {
      header = buildFrontMatter(title, url, siteType, opts) + '\n\n';
    } else if (opts.includeTitle && title) {
      header = '# ' + title + '\n\n';
    }

    // 7. Post-process (code-aware).
    const output = postProcess(header + markdown, siteType, opts);

    return output;
  }

  // ──────────────────────────────────────────────
  //  CONTENT EXTRACTION BY SITE TYPE
  // ──────────────────────────────────────────────
  function extractContent(siteType, opts, userInclude) {
    // User-specified include selectors take top priority.
    for (const sel of userInclude) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim().length > 100) return el;
      } catch (_) {}
    }

    switch (siteType) {
      case 'github':           return extractGitHub(opts) || extractGeneric(opts);
      case 'github-issue':     return extractGitHubIssue() || extractGeneric(opts);
      case 'github-wiki':      return extractGitHubWiki() || extractGeneric(opts);
      case 'gitlab':           return extractGitLab() || extractGeneric(opts);
      case 'bitbucket':        return extractBitbucket() || extractGeneric(opts);
      case 'stackoverflow':    return extractStackOverflow() || extractGeneric(opts);
      case 'webmail':          return extractWebmail() || extractGeneric(opts);
      case 'reddit':           return extractReddit() || extractGeneric(opts);
      case 'twitter':          return extractTwitter() || extractGeneric(opts);
      case 'linkedin':         return extractLinkedIn() || extractGeneric(opts);
      case 'youtube':          return extractYouTube() || extractGeneric(opts);
      case 'wiki':             return extractWikipedia() || extractGeneric(opts);
      case 'notion':           return extractNotion() || extractGeneric(opts);
      case 'confluence':       return extractConfluence() || extractGeneric(opts);
      case 'discourse':        return extractDiscourse() || extractForum() || extractGeneric(opts);
      case 'hackernews':       return extractHackerNews() || extractForum() || extractGeneric(opts);
      case 'news':             return extractArticle() || extractGeneric(opts);
      case 'blog':             return extractArticle() || extractGeneric(opts);
      case 'docs':             return extractDocs() || extractGeneric(opts);
      case 'product':          return extractProduct() || extractGeneric(opts);
      case 'academic':         return extractAcademic() || extractArticle() || extractGeneric(opts);
      case 'forum':            return extractForum() || extractGeneric(opts);
      case 'chatgpt':          return extractChatGPT() || extractGeneric(opts);
      default:                 return extractGeneric(opts);
    }
  }

  // --- GitHub repo README ---
  function extractGitHub() {
    const readme = safeQuery('#readme .markdown-body, article.markdown-body, [data-testid="readme"] .markdown-body');
    if (readme) return readme;
    return safeQuery('[data-target="readme-toc.content"]') ||
           safeQuery('main .markdown-body') ||
           safeQuery('main') ||
           null;
  }

  // --- GitHub issue / PR ---
  function extractGitHubIssue() {
    // Gather the issue body + all comments in timeline order.
    const container = document.createElement('div');
    const titleEl = safeQuery('.js-issue-title, .gh-header-title .markdown-title, bdi.js-issue-title');
    if (titleEl) {
      const h = document.createElement('h1');
      h.textContent = titleEl.textContent.trim();
      container.appendChild(h);
    }

    // The first comment is the issue body.
    const bodies = document.querySelectorAll('.timeline-comment-body, .js-comment-body, .comment-body');
    bodies.forEach((body, i) => {
      const heading = document.createElement('h2');
      heading.textContent = i === 0 ? 'Description' : ('Comment ' + i);
      container.appendChild(heading);
      container.appendChild(body.cloneNode(true));
    });

    return container.children.length > 0 ? container : safeQuery('main');
  }

  // --- GitHub wiki ---
  function extractGitHubWiki() {
    return safeQuery('.markdown-body, #wiki-body, main') || null;
  }

  // --- GitLab ---
  function extractGitLab() {
    return safeQuery('.md, .markdown-body, [data-testid="readme-container"], .readme, article, main') || null;
  }

  // --- Bitbucket ---
  function extractBitbucket() {
    return safeQuery('.markdown-body, .readme-content, article, main') || null;
  }

  // --- Stack Overflow ---
  function extractStackOverflow() {
    const container = document.createElement('div');

    // Question
    const question = safeQuery(
      '.question .js-post-body, .question .post-text, .question-cell .s-prose, .question .s-prose'
    );
    if (question) {
      const qTitle = safeQuery('.question-hyperlink, h1.fs-headline, #question-header h1');
      if (qTitle) {
        const h = document.createElement('h1');
        h.textContent = qTitle.textContent.trim();
        container.appendChild(h);
      }
      container.appendChild(question.cloneNode(true));

      // Answers
      const answers = document.querySelectorAll(
        '.answer .js-post-body, .answer .post-text, .answer-cell .s-prose, .answer .s-prose'
      );
      answers.forEach((ans, i) => {
        const h2 = document.createElement('h2');
        const ansWrap = ans.closest('.answer');
        const isAccepted = ansWrap?.classList.contains('accepted-answer') ||
                           !!ansWrap?.querySelector('[title="accepted"]');
        h2.textContent = (isAccepted ? 'Accepted Answer' : ('Answer ' + (i + 1)));
        container.appendChild(h2);
        container.appendChild(ans.cloneNode(true));
      });
    }

    return container.children.length > 0 ? container : safeQuery('.question, main');
  }

  // --- Webmail (Gmail, Outlook, etc.) ---
  // These apps render email content inside iframes. We try to collect
  // content from all reachable same-origin iframes. Cross-origin iframes
  // will silently fail — that's expected, the browser blocks them.
  function extractWebmail() {
    const container = document.createElement('div');

    try {
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach(iframe => {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!doc) return;
          const body = doc.body || doc.documentElement;
          if (body && body.textContent.trim().length > 20) {
            container.appendChild(body.cloneNode(true));
          }
        } catch (_) { /* cross-origin — skip silently */ }
      });
    } catch (_) {}

    if (container.textContent.trim().length > 50) return container;

    // Gmail's conversation view sometimes renders at top level.
    const visible = safeQuery('.a3s, [role="main"], .ii.gt, .adP');
    if (visible && visible.textContent.trim().length > 50) return visible;

    return null;
  }

  // --- Reddit ---
  function extractReddit() {
    const container = document.createElement('div');

    const postTitle = safeQuery(
      'h1[slot="title"], shreddit-post [slot="title"], .Post h1, [data-testid="post-title"]'
    );
    const postBody = safeQuery('shreddit-post .md, .Post .md, [data-click-id="text"], [slot="text-body"] .md');
    if (postTitle) {
      const h = document.createElement('h1');
      h.textContent = postTitle.textContent.trim();
      container.appendChild(h);
    }
    if (postBody) container.appendChild(postBody.cloneNode(true));

    const comments = document.querySelectorAll(
      'shreddit-comment .md, .Comment .md, .comment .md, [data-testid="comment"] .md'
    );
    comments.forEach((c) => {
      const wrap = c.closest('shreddit-comment, .Comment, .comment, [data-testid="comment"]');
      const authorEl = wrap?.querySelector('a.author, [author], [data-testid="comment_author_link"]');
      const author = authorEl?.textContent?.trim() || 'Anonymous';
      const scoreEl = wrap?.querySelector('[score], .score, [data-testid="comment-score"]');
      const score = scoreEl?.getAttribute('score') || scoreEl?.textContent?.trim() || '';
      const h3 = document.createElement('h3');
      h3.textContent = 'Comment by ' + author + (score ? ' (' + score + ' pts)' : '');
      container.appendChild(h3);
      container.appendChild(c.cloneNode(true));
    });

    return container.children.length > 0 ? container : null;
  }

  // --- Twitter / X ---
  function extractTwitter() {
    const container = document.createElement('div');
    const tweets = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
    tweets.forEach((tweet, i) => {
      if (i === 0) {
        const h = document.createElement('h1');
        // Derive a reasonable title from <title> or first tweet's author.
        const titleAuthor = document.title.split(' / ')[0].split(' on ')[0].split(': ')[0];
        h.textContent = titleAuthor || 'Tweet';
        container.appendChild(h);
      }
      const authorEl = tweet.querySelector('[data-testid="User-Name"], a[role="link"] span');
      const author = authorEl?.textContent?.trim()?.split('\n')[0] || '';
      const text = tweet.querySelector('[data-testid="tweetText"]');
      if (text) {
        if (author) {
          const h3 = document.createElement('h3');
          h3.textContent = '@' + author.replace(/\s/g, '');
          container.appendChild(h3);
        }
        container.appendChild(text.cloneNode(true));
      }
    });
    return container.children.length > 1 ? container : null;
  }

  // --- LinkedIn (article / post) ---
  function extractLinkedIn() {
    return safeQuery('article, .feed-shared-update, .core-rail, main') || null;
  }

  // --- YouTube (video description / transcript) ---
  function extractYouTube() {
    const container = document.createElement('div');
    const title = safeQuery('h1.ytd-watch-metadata, h1.title, [data-testid="video-title"]');
    if (title) {
      const h = document.createElement('h1');
      h.textContent = title.textContent.trim();
      container.appendChild(h);
    }
    const desc = safeQuery(
      '#description, #description-inner, ytd-text-inline-expander, [data-testid="video-description"]'
    );
    if (desc) {
      const h2 = document.createElement('h2');
      h2.textContent = 'Description';
      container.appendChild(h2);
      container.appendChild(desc.cloneNode(true));
    }
    return container.children.length > 0 ? container : null;
  }

  // --- Wikipedia ---
  // The page <h1> lives outside #mw-content-text (inside #content), so we
  // build a wrapper that prepends the title heading to the extracted content.
  function extractWikipedia() {
    const content = safeQuery('#mw-content-text') || safeQuery('.mw-parser-output');
    if (!content) return safeQuery('main, #content') || null;

    const titleEl = safeQuery('h1.firstHeading, h1#firstHeading, #section_0, h1#titleHeading');
    if (titleEl) {
      const container = document.createElement('div');
      container.appendChild(titleEl.cloneNode(true));
      container.appendChild(content.cloneNode(true));
      return container;
    }
    return content;
  }

  // --- Notion (published page) ---
  function extractNotion() {
    return safeQuery('.notion-page-content, .notion-app, [class*="notion-page-content"]') ||
           safeQuery('main, article') || null;
  }

  // --- Confluence ---
  function extractConfluence() {
    return safeQuery('#confluence-content, .wiki-content, .page-content, main, article') || null;
  }

  // --- Discourse ---
  function extractDiscourse() {
    const container = document.createElement('div');
    const posts = document.querySelectorAll('.topic-post .cooked, .post .cooked, .topic-body .cooked');
    posts.forEach((post, i) => {
      if (i === 0) {
        const title = safeQuery('#topic-title, .fancy-title, .topic-link, h1');
        if (title) {
          const h = document.createElement('h1');
          h.textContent = title.textContent.trim();
          container.appendChild(h);
        }
      }
      const wrap = post.closest('.topic-post, .post, article');
      const author = wrap?.querySelector('.username, .names .name, a.creator, [data-user-card]')?.textContent?.trim();
      if (author && i > 0) {
        const h3 = document.createElement('h3');
        h3.textContent = 'Post by ' + author;
        container.appendChild(h3);
      }
      container.appendChild(post.cloneNode(true));
    });
    return container.children.length > 0 ? container : null;
  }

  // --- Hacker News ---
  function extractHackerNews() {
    const container = document.createElement('div');
    const titleEl = safeQuery('.titleline > a, .athing .title, .title > a');
    if (titleEl) {
      const h = document.createElement('h1');
      h.textContent = titleEl.textContent.trim();
      container.appendChild(h);
      const url = titleEl.getAttribute('href');
      if (url) {
        const p = document.createElement('p');
        p.textContent = 'Link: ' + url;
        container.appendChild(p);
      }
    }
    const postText = safeQuery('.toptext, .commtext');
    if (postText) {
      const h2 = document.createElement('h2');
      h2.textContent = 'Post';
      container.appendChild(h2);
      container.appendChild(postText.cloneNode(true));
    }
    const comments = document.querySelectorAll('.comtr .commtext, .comment .commtext');
    comments.forEach((c, i) => {
      const h3 = document.createElement('h3');
      h3.textContent = 'Comment ' + (i + 1);
      container.appendChild(h3);
      container.appendChild(c.cloneNode(true));
    });
    return container.children.length > 0 ? container : null;
  }

  // --- Blog / News article ---
  // Tries well-known article containers in priority order, then falls
  // back to a Readability-style density scorer.
  function extractArticle() {
    const selectors = [
      // Semantic HTML
      'article',
      '[role="main"]',
      'main',
      // CMS-specific
      '.post-content', '.article-content', '.entry-content', '.content-body',
      '.post-body', '.story-body', '#content-body', '.article-body',
      '.gh-content', '.content-inner', '.available-content',
      '.meteredContent', '.prose', '.rich-text', '.markdown-body',
      '#content', '.content', '.main-content', '#main-content',
      // Loose class contains (last resort)
      '[class*="article-body"]', '[class*="ArticleBody"]',
      '[class*="post-content"]', '[class*="PostContent"]',
      '[class*="rich-text"]', '[class*="RichText"]',
    ];
    for (const sel of selectors) {
      const el = safeQuery(sel);
      if (el && el.textContent.trim().length > 200) return el;
    }

    // Readability-style density scorer as last resort.
    const best = findMainContentByDensity(document);
    if (best) return best;

    return safeQuery('main') || document.body || null;
  }

  // --- Documentation ---
  function extractDocs() {
    const selectors = [
      '.documentation', '.docs-content', '.doc-content',
      '.content-area', '.page-content',
      '.rst-content', '.document',                  // ReadTheDocs
      '.markdown-section',                          // GitBook
      'article.markdown',                           // Docusaurus
      '.md-content__inner',                         // MkDocs Material
      '.vp-doc', '.content-container',              // VitePress / VuePress
      '.theme-doc-markdown',                        // Docusaurus 2+
      'main .content', 'main article', 'main',
    ];
    for (const sel of selectors) {
      const el = safeQuery(sel);
      if (el && el.textContent.trim().length > 100) return el;
    }
    return safeQuery('main') || null;
  }

  // --- Product page ---
  function extractProduct() {
    const container = document.createElement('div');
    const title = safeQuery('[itemprop="name"], .product-title, h1.product-name, h1');
    const price = safeQuery('[itemprop="price"], .price, .product-price, [data-testid="price"], .a-price');
    const desc = safeQuery(
      '[itemprop="description"], .product-description, .product-details, #feature-bullets, #productDescription'
    );
    const specs = safeQuery(
      '#productDetails_detailBullets_sections1, .product-specs, table.prodDetails, #techSpecTable'
    );
    if (title) {
      const h = document.createElement('h1');
      h.textContent = title.textContent.trim();
      container.appendChild(h);
    }
    if (price) {
      const h2 = document.createElement('h2');
      h2.textContent = 'Price: ' + price.textContent.trim().replace(/\s+/g, ' ');
      container.appendChild(h2);
    }
    if (desc) container.appendChild(desc.cloneNode(true));
    if (specs) container.appendChild(specs.cloneNode(true));
    return container.children.length > 0 ? container : null;
  }

  // --- Academic paper ---
  function extractAcademic() {
    // ArXiv abstract page
    const abstract = safeQuery('#abs, .abstract, .ltx_abstract');
    if (abstract) {
      const container = document.createElement('div');
      const title = safeQuery('.title mathjax, .ltx_title, h1.title, h1.citation-title');
      if (title) {
        const h = document.createElement('h1');
        h.textContent = title.textContent.trim();
        container.appendChild(h);
      }
      const authors = safeQuery('.authors, .author-list, .ltx_personname');
      if (authors) {
        const h2 = document.createElement('h2');
        h2.textContent = 'Authors';
        container.appendChild(h2);
        const p = document.createElement('p');
        p.textContent = authors.textContent.trim().replace(/\s+/g, ' ');
        container.appendChild(p);
      }
      container.appendChild(abstract.cloneNode(true));
      return container;
    }
    // PubMed / DOI landing pages
    return null;
  }

  // --- Generic forum ---
  function extractForum() {
    const container = document.createElement('div');
    const posts = document.querySelectorAll(
      '.topic-post .cooked, .post .cooked, .topic-body .cooked, .post-content, .post-body, .comment-body, .message-body'
    );
    posts.forEach((post, i) => {
      if (i === 0) {
        const title = safeQuery('#topic-title, .fancy-title, .topic-link, h1, .topic-title');
        if (title) {
          const h = document.createElement('h1');
          h.textContent = title.textContent.trim();
          container.appendChild(h);
        }
      }
      const wrap = post.closest('.topic-post, .post, article, .comment, .message');
      const author = wrap?.querySelector('.username, .author, .names .name, a.creator, .post-author, .username')?.textContent?.trim();
      if (author && i > 0) {
        const h3 = document.createElement('h3');
        h3.textContent = 'Post by ' + author;
        container.appendChild(h3);
      }
      container.appendChild(post.cloneNode(true));
    });
    return container.children.length > 0 ? container : null;
  }

  // --- ChatGPT / Claude / Poe conversation export ---
  function extractChatGPT() {
    const container = document.createElement('div');
    // OpenAI ChatGPT structure
    const messages = document.querySelectorAll(
      '[data-testid^="conversation-turn-"], [class*="Message"][class*="message"], .markdown.prose'
    );
    messages.forEach((msg, i) => {
      const isUser = msg.dataset?.testid?.includes('-1') || msg.querySelector('[data-testid*="user"]') ||
                     msg.classList.contains('user-message');
      const h = document.createElement('h2');
      h.textContent = isUser ? 'User' : 'Assistant';
      container.appendChild(h);
      container.appendChild(msg.cloneNode(true));
    });
    return container.children.length > 0 ? container : null;
  }

  // --- Generic fallback with Readability-style scoring ---
  function extractGeneric(opts) {
    if (opts.smartExtract === false) return document.documentElement;
    // Try article-like selectors first (cheap path).
    const quick = safeQuery('article, main, [role="main"]');
    if (quick && quick.textContent.trim().length > 200) return quick;
    // Readability-style density scorer.
    const best = findMainContentByDensity(document);
    if (best) return best;
    return document.body || document.documentElement;
  }

  // ──────────────────────────────────────────────
  //  READABILITY-STYLE CONTENT DENSITY SCORER
  // ──────────────────────────────────────────────
  // Walks all "block" candidates and scores them by:
  //   - text length
  //   - paragraph count
  //   - link density (penalty)
  //   - presence of commas / periods (real prose)
  // Returns the highest-scoring element, or null.
  function findMainContentByDensity(doc) {
    const candidates = doc.querySelectorAll(
      'article, main, section, div, [role="main"], [role="article"]'
    );
    let best = null;
    let bestScore = 0;

    candidates.forEach((el) => {
      // Skip tiny nodes / nodes with too many children (likely layout wrappers).
      const text = el.textContent || '';
      if (text.length < 500) return;

      const paragraphs = el.querySelectorAll('p').length;
      if (paragraphs < 2) return; // require at least 2 paragraphs

      const linkText = Array.from(el.querySelectorAll('a'))
        .reduce((sum, a) => sum + (a.textContent || '').length, 0);
      const linkDensity = text.length > 0 ? linkText / text.length : 0;
      if (linkDensity > 0.5) return; // mostly links → nav / footer

      // Real prose has commas and periods.
      const commaCount = (text.match(/[,;]/g) || []).length;
      const periodCount = (text.match(/[.!?]/g) || []).length;
      if (periodCount < 5) return;

      let score = 0;
      score += text.length / 100;             // 1 pt per 100 chars
      score += paragraphs * 5;                // 5 pts per paragraph
      score += commaCount * 0.5;              // 0.5 pt per comma/semicolon
      score += periodCount * 1;               // 1 pt per period
      score -= linkDensity * 200;             // heavy penalty for link-heavy nodes
      // Slight bonus for semantic tags.
      if (el.tagName === 'ARTICLE') score += 50;
      if (el.tagName === 'MAIN') score += 30;
      if (el.getAttribute('role') === 'main') score += 30;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });

    return best;
  }

  // ──────────────────────────────────────────────
  //  DOM CLEANING (site-type-aware, production-grade)
  // ──────────────────────────────────────────────
  function cleanDOM(root, siteType, opts, userExclude) {
    // Universal noise selectors — the union of:
    //   1. Non-content tags (script, style, etc.)
    //   2. ARIA landmarks we never want in output (nav, footer, aside)
    //   3. Common ad / cookie / paywall / modal / newsletter patterns
    //   4. Hidden elements (display:none, visibility:hidden, aria-hidden)
    const NOISE = [
      // Non-content tags
      'script','style','noscript','iframe','object','embed','svg','canvas',
      // ARIA landmarks
      '[role="navigation"]','nav','[role="banner"]','header[role="banner"]',
      '[role="contentinfo"]','footer','[role="complementary"]','aside',
      '[role="search"]','[role="alert"]','[role="dialog"]','[role="alertdialog"]',
      // Ads
      '.ad','.ads','.ad-banner','.ad-container','.advertisement','.ad-slot',
      '[class*="ad-"]','[id*="ad-"]','[class*="advert"]','[id*="advert"]',
      '[data-ad]','ins.adsbygoogle',
      // Cookie / paywall / consent
      '.cookie','.cookie-banner','.cookie-notice','.cookie-consent',
      '[id*="cookie"]','[class*="cookie-consent"]','[id*="consent"]',
      '.cc-banner','#onetrust-banner-sdk','#onetrust-consent-sdk',
      '.paywall','.paywall-container','[class*="paywall"]',
      // Popups / modals / overlays
      '.popup','.modal','.overlay','[class*="modal-"]','[class*="Modal"]',
      '[class*="popup-"]','[class*="Popup"]','[class*="overlay-"]',
      '[data-modal]','[data-popup]',
      // Newsletter / subscription prompts
      '.newsletter','.subscribe','.subscription','.newsletter-signup',
      '[class*="newsletter"]','[class*="Newsletter"]',
      '[class*="subscribe-"]','[id*="subscribe"]',
      // Social share / recommendation
      '.social-share','.share-buttons','.sharing','.share-widget',
      '[class*="share-"]','[class*="Share"]',
      '.related-posts','.recommended','.recommendation','.related-content',
      '[class*="related-"]','[id*="related-"]',
      // Breadcrumb / jump links
      '.breadcrumb','[class*="breadcrumb"]','[aria-label="breadcrumb"]',
      // Hidden elements (multiple hiding techniques)
      '[aria-hidden="true"]','.hidden','.visually-hidden',
      '[style*="display: none"]','[style*="display:none"]',
      '[style*="visibility:hidden"]','[style*="visibility: hidden"]',
      '[hidden]',
      // Print-only / screen-reader-only
      '.noprint','.sr-only','.screen-reader',
    ];

    // Site-type-specific noise.
    const SITE_NOISE = {
      'github': [
        '.BorderGrid-row--gutter', '.BorderGrid-cell', '.flex-order-2',
        '#wiki-rightbar', '.gh-header-sticky', '.pagehead-actions',
        '.signup-prompt', 'form[action*="star"]', '.file-navigation',
        'details.repository-lang-stats', '#readme .Box-header',
        '.js-social-container', '.BtnGroup', '.branch-select-menu',
        '.react-issue-comment-composer', '.timeline-comment-actions',
        '.comment-reactions', '.js-comment-action',
      ],
      'github-issue': [
        '.discussion-sidebar', '.js-discussion-sidebar',
        '.timeline-comment-actions', '.comment-actions',
        '.js-socket-channel', '.gh-header-actions',
        '.comment-reactions', '.js-suggested-tooltip',
      ],
      'github-wiki': [
        '.wiki-rightbar', '.wiki-custom-sidebar', '.gh-header',
      ],
      'gitlab': [
        '.sidebar', '.nav-sidebar', '.layout-nav',
        '.issuable-sidebar', '.mr-sidebar', '.issue-sidebar',
      ],
      'stackoverflow': [
        '.sidebar', '.left-sidebar', '#sidebar',
        '.related', '.related-questions', '.hot-network-questions',
        '.s-sidebarwidget', '.js-staging-ground-banner',
        '.topbar', '.js-consent-banner', '#left-sidebar',
        '.s-prose .d-none',
      ],
      'reddit': [
        '.subreddit-bar', '#header', '.searchbox',
        '.comment-sort', '.menuarea', '.flat-list.buttons',
        'shreddit-sidebar', '[id="subreddit-sidebar"]',
        '.rp3d-close-btn', '.promo-link',
      ],
      'twitter': [
        '[data-testid="sidebarColumn"]', 'header[role="banner"]',
        'nav[aria-label]', '[data-testid="placementTracking"]',
        '[data-testid="primaryColumn"] > div > div:first-child',
      ],
      'youtube': [
        '#related', '#secondary', 'ytd-watch-next-secondary-results-renderer',
        '#comments-teaser', '#comment-teaser',
      ],
      'wiki': [
        '#toc', '.toc', '.navbox', '.navbox-styles',
        '.catlinks', '.sistersitebox', '.authority-control',
        '#p-lang', '.mw-editsection', '.mw-indicators',
        '.noprint', '.thumbcaption', '.magnify',
        'sup.reference', '.reflist', '.refbegin',
        '.vertical-navbox', '.side-box', '.metadata',
        '.mw-empty-elt', '.mw-cite-backlink',
      ],
      'notion': [
        '.notion-topbar', '.notion-sidebar', '.notion-overlay-container',
        '.notion-presence-container',
      ],
      'confluence': [
        '.page-metadata', '.ia-secondary-container', '.plugin_pagetree',
        '.wiki-edit', '.nopanel',
      ],
      'discourse': [
        '.topic-list', '.category-list', '.navigation-bar',
        '.header-buttons', '.topic-footer-main-buttons',
        '.post-controls', '.post-actions', '.nav-pills',
      ],
      'hackernews': [
        '.nav', '.yclinks', '.topbar',
      ],
      'docs': [
        '.sidebar', '.sidebar-nav', '.table-of-contents',
        '.navigation', '.breadcrumb', '.edit-this-page',
        '.theme-toggler', '.search-sidebar', '.sidebar-link',
        '.nav-group', '.menu', '[class*="sidebar"]',
        '.page-nav', '.prev-next', '.pagination',
        '.md-sidebar', '.vp-sidebar', '.DocSidebar',
      ],
      'blog': [
        '.sidebar', '.sidebar-widget', '.author-bio-card',
        '.post-navigation', '.comments-title',
        '.related-posts', '.recommendation',
        '.share-widget', '.newsletter-signup',
        '.post-meta', '.byline-misc', '.reading-time',
        '.comment-form', '.comments-area', '.respond',
      ],
      'news': [
        '.sidebar', '.ad-placement', '.newsletter-signup',
        '.most-popular', '.trending', '.opinion',
        '.sponsored', '.partner-content', '.outbrain',
        '.taboola', '[class*="zergnet"]',
      ],
      'product': [
        '.sidebar', '.product-gallery-nav', '.add-to-cart',
        '.customer-reviews-header', '.recommendations',
        '.also-bought', '.sponsored-products',
        '.cr-product-image', '#view-purchase-promos',
      ],
      'academic': [
        '.header-breadcrumbs', '.full-view', '.ltx_page_nav',
        '.ltx_page_footer', '.ltx_page_sidebar',
        '.sidebar', '.nav-links',
      ],
      'forum': [
        '.topic-list', '.category-list', '.navigation-bar',
        '.header-buttons', '.topic-footer-main-buttons',
        '.pagination', '.quick-reply',
      ],
      'chatgpt': [
        'nav', '.sidebar', '[class*="Sidebar"]', 'footer',
        '[class*="composer"]', '[class*="Composer"]',
      ],
      'webmail': [],
      'generic': [],
    };

    const allNoise = [...NOISE, ...(SITE_NOISE[siteType] || []), ...userExclude];
    // CRITICAL: convert NodeList to array before mutating.
    // Iterating a live NodeList while calling .remove() causes
    // 'parentNode is undefined' errors on complex DOMs (Gmail, SPAs).
    try {
      const noiseEls = Array.from(root.querySelectorAll(allNoise.join(',')));
      noiseEls.forEach(el => { try { el.remove(); } catch (_) {} });
    } catch (e) { log('noise removal error (non-fatal):', e); }

    // Remove elements hidden via inline opacity:0 (only if truly invisible —
    // we don't want to nuke CSS animations that use opacity transitions).
    try {
      const opacityEls = Array.from(root.querySelectorAll('[style*="opacity:0"], [style*="opacity: 0"]'));
      opacityEls.forEach(el => {
        const m = (el.getAttribute('style') || '').match(/opacity:\s*0/);
        if (m) { try { el.remove(); } catch (_) {} }
      });
    } catch (_) {}

    // Remove elements with position:fixed that aren't inside <main>/<article>
    // (these are usually floating headers, share bars, cookie dialogs).
    try {
      const fixedEls = Array.from(root.querySelectorAll('[style*="position:fixed"], [style*="position: fixed"]'));
      fixedEls.forEach(el => {
        // Only remove if it's small (a share bar / cookie notice), not a large modal.
        if ((el.textContent || '').trim().length < 500) {
          try { el.remove(); } catch (_) {}
        }
      });
    } catch (_) {}

    // Remove empty containers (no text and no media).
    ['p','div','span','section','header','article'].forEach(tag => {
      try {
        const els = Array.from(root.querySelectorAll(tag));
        els.forEach(el => {
          try {
            const text = (el.textContent || '').trim();
            if (!text.length && !el.querySelector('img,video,audio,code,pre,table,figure,iframe,svg')) {
              el.remove();
            }
          } catch (_) {}
        });
      } catch (_) {}
    });

    // Optionally strip images / links entirely.
    if (opts.keepImages === false) {
      try {
        Array.from(root.querySelectorAll('img,figure,picture,video')).forEach(el => {
          try { el.remove(); } catch (_) {}
        });
      } catch (_) {}
    }
    if (opts.keepLinks === false) {
      try {
        Array.from(root.querySelectorAll('a')).forEach(el => {
          try {
            const text = el.textContent || '';
            el.replaceWith(document.createTextNode(text));
          } catch (_) {}
        });
      } catch (_) {}
    }

    // Unwrap <noscript> contents into their parent (some sites use <noscript>
    // to provide image fallbacks; we want the actual image inside).
    try {
      Array.from(root.querySelectorAll('noscript')).forEach(ns => {
        try {
          const frag = document.createElement('div');
          frag.innerHTML = ns.textContent || '';
          ns.replaceWith(...Array.from(frag.childNodes));
        } catch (_) {}
      });
    } catch (_) {}

    // Normalize whitespace inside text nodes (collapse runs of spaces).
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'PRE' || tag === 'CODE') return NodeFilter.FILTER_REJECT;
          return /\s{2,}/.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      const toNormalize = [];
      while (walker.nextNode()) toNormalize.push(walker.currentNode);
      toNormalize.forEach(n => {
        n.nodeValue = n.nodeValue.replace(/[ \t]{2,}/g, ' ');
      });
    } catch (_) {}
  }

  // ──────────────────────────────────────────────
  //  LAZY-LOAD IMAGE UNWRAPPING
  // ──────────────────────────────────────────────
  // Many modern sites use lazy-loading attributes (data-src, data-original,
  // data-lazy-src, srcset). We unwrap them into the standard `src` so
  // Turndown picks up the real image URL.
  function unwrapLazyImages(root) {
    try {
      const imgs = root.querySelectorAll('img');
      imgs.forEach(img => {
        // If src is missing or is a placeholder, replace with data-src.
        const src = img.getAttribute('src') || '';
        const looksEmpty = !src || src.startsWith('data:image/svg') ||
                           src.includes('placeholder') || src.includes('loading.gif');
        const candidates = [
          img.getAttribute('data-src'),
          img.getAttribute('data-original'),
          img.getAttribute('data-lazy-src'),
          img.getAttribute('data-srcset'),
        ].filter(Boolean);
        if (looksEmpty && candidates.length > 0) {
          // data-srcset is "url 1x, url 2x" — pick the first URL.
          let realSrc = candidates[0];
          if (realSrc.includes(' ')) realSrc = realSrc.split(',')[0].split(' ')[0].trim();
          img.setAttribute('src', realSrc);
        }

        // Resolve relative URLs against the page location.
        const finalSrc = img.getAttribute('src') || '';
        if (finalSrc && !finalSrc.startsWith('http') && !finalSrc.startsWith('data:')) {
          try {
            img.setAttribute('src', new URL(finalSrc, location.href).href);
          } catch (_) {}
        }

        // Drop srcset to avoid Turndown emitting it as the link target.
        img.removeAttribute('srcset');
      });

      // <picture><source srcset="..."></picture> — pick the first source.
      root.querySelectorAll('picture').forEach(pic => {
        const img = pic.querySelector('img');
        const source = pic.querySelector('source[srcset]');
        if (img && source && (!img.getAttribute('src') || img.getAttribute('src').startsWith('data:'))) {
          const srcset = source.getAttribute('srcset') || '';
          const first = srcset.split(',')[0].trim().split(' ')[0];
          if (first) img.setAttribute('src', first);
        }
      });
    } catch (e) {
      log('unwrapLazyImages error (non-fatal):', e);
    }
  }

  // ──────────────────────────────────────────────
  //  SITE-TYPE-SPECIFIC TRANSFORMS
  // ──────────────────────────────────────────────
  function applySiteTransforms(root, siteType) {
    // Wikipedia: convert infoboxes/wikitables to definition lists and
    // strip citation markers.
    if (siteType === 'wiki') {
      try {
        Array.from(root.querySelectorAll('.infobox, .infobox-table')).forEach(table => {
          const dl = document.createElement('dl');
          Array.from(table.querySelectorAll('tr')).forEach(tr => {
            const th = tr.querySelector('th');
            const td = tr.querySelector('td');
            if (th && td) {
              const dt = document.createElement('dt');
              dt.textContent = th.textContent.trim();
              const dd = document.createElement('dd');
              dd.innerHTML = td.innerHTML;
              dl.appendChild(dt);
              dl.appendChild(dd);
            }
          });
          if (dl.children.length > 0) {
            try { table.replaceWith(dl); } catch (_) {}
          }
        });
        // Remove citation brackets like [1], [edit], [citation needed]
        Array.from(root.querySelectorAll('sup')).forEach(sup => {
          const txt = sup.textContent || '';
          if (/^\[?\d+\]?$/.test(txt) || /edit/i.test(txt) || /citation needed/i.test(txt)) {
            try { sup.remove(); } catch (_) {}
          }
        });
      } catch (e) { log('wiki transform error (non-fatal):', e); }
    }

    // GitHub: task-list items are handled by the GFM plugin natively,
    // which converts <li class="task-list-item"><input type="checkbox"
    // checked></li> into [x] syntax WITHOUT escaping the brackets.
    // (Our old manual transform produced [x] text that Turndown escaped.)
    // We just need to remove the checkbox <input> element so the GFM plugin
    // sees a clean task-list-item, and ensure the li has the right class.
    if (siteType === 'github' || siteType === 'github-issue' || siteType === 'github-wiki') {
      try {
        Array.from(root.querySelectorAll('.task-list-item')).forEach(item => {
          try {
            // Mark the checkbox state on the li via data-attr so GFM can read it.
            const cb = item.querySelector('input[type="checkbox"]');
            if (cb) {
              if (cb.checked) item.setAttribute('data-checked', 'true');
              else item.setAttribute('data-checked', 'false');
            }
          } catch (_) {}
        });
      } catch (_) {}
    }

    // Stack Overflow: separate answers with horizontal rules.
    if (siteType === 'stackoverflow') {
      try {
        Array.from(root.querySelectorAll('h2')).forEach(h2 => {
          try { h2.before(document.createElement('hr')); } catch (_) {}
        });
      } catch (_) {}
    }

    // Docs: add code language hints when missing.
    if (siteType === 'docs') {
      try {
        Array.from(root.querySelectorAll('pre code')).forEach(code => {
          try {
            const cls = code.getAttribute('class') || '';
            if (!cls.includes('language-') && !cls.includes('lang-')) {
              const parent = code.parentElement;
              const heading = parent?.previousElementSibling?.textContent?.toLowerCase() || '';
              const langMap = {
                'python': 'python', 'py': 'python',
                'javascript': 'javascript', 'js': 'javascript',
                'typescript': 'typescript', 'ts': 'typescript',
                'java': 'java', 'kotlin': 'kotlin', 'scala': 'scala',
                'rust': 'rust', 'go': 'go', 'golang': 'go',
                'ruby': 'ruby', 'php': 'php',
                'c++': 'cpp', 'cpp': 'cpp', 'c': 'c',
                'c#': 'csharp', 'csharp': 'csharp',
                'shell': 'bash', 'bash': 'bash', 'sh': 'bash', 'zsh': 'bash',
                'sql': 'sql', 'html': 'html', 'css': 'css', 'scss': 'scss',
                'yaml': 'yaml', 'yml': 'yaml',
                'json': 'json', 'xml': 'xml', 'toml': 'toml',
                'docker': 'dockerfile', 'dockerfile': 'dockerfile',
                'swift': 'swift', 'objective-c': 'objectivec',
                'perl': 'perl', 'r': 'r', 'matlab': 'matlab',
                'lua': 'lua', 'haskell': 'haskell', 'elixir': 'elixir',
                'clojure': 'clojure', 'erlang': 'erlang',
                'powershell': 'powershell', 'ps1': 'powershell',
                'protobuf': 'protobuf', 'graphql': 'graphql',
                'jsx': 'jsx', 'tsx': 'tsx',
              };
              for (const [key, lang] of Object.entries(langMap)) {
                if (heading.includes(key)) {
                  code.classList.add('language-' + lang);
                  break;
                }
              }
            }
          } catch (_) {}
        });
      } catch (_) {}
    }

    // ChatGPT: wrap user vs assistant messages with H2 markers (already done
    // in extractChatGPT, but in case the user triggered selection conversion
    // we don't double-process here).
  }

  // ──────────────────────────────────────────────
  //  TURNDOWN CONVERSION (site-type-tuned, extended rules)
  // ──────────────────────────────────────────────
  function toMarkdown(root, siteType, opts) {
    const td = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: opts.codeBlocks !== false ? 'fenced' : 'inline',
      fence: FENCE,
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
      br: '  ',
      preserveNestedTables: true,
    });

    // GFM plugin — strikethrough, task lists, tables, autolinks.
    if (typeof turndownPluginGfm !== 'undefined') {
      try { td.use(turndownPluginGfm.gfm); } catch (_) {}
    }

    // --- Universal custom rules ---
    // Order matters: rules are evaluated in registration order, but each
    // rule's `filter` decides whether it applies. We register the most
    // specific rules first so they win over the generic ones.

    // <figure> → image + italicized caption
    td.addRule('figure', {
      filter: 'figure',
      replacement: (content, node) => {
        try {
          const img = node.querySelector('img');
          const figcaption = node.querySelector('figcaption');
          if (!img) return content;
          const alt = img.alt || '';
          const src = img.getAttribute('src') || '';
          if (!src) return content;
          let md = `![${alt}](${src})`;
          const cap = figcaption?.textContent?.trim();
          if (cap) md += '\n\n*' + cap + '*';
          return '\n\n' + md + '\n\n';
        } catch (_) { return content; }
      }
    });

    // <pre><code> → fenced code block with language hint
    td.addRule('preCodeBlock', {
      filter: (node) => node.nodeName === 'PRE' && node.firstChild?.nodeName === 'CODE',
      replacement: (content, node) => {
        try {
          const codeEl = node.firstChild;
          const cls = codeEl.getAttribute('class') || '';
          const lang = cls.match(/(?:language|lang|highlight)-(\w+)/)?.[1] || '';
          const code = (codeEl.textContent || codeEl.innerText || '').replace(/\n$/, '');
          if (opts.codeBlocks === false) {
            const oneLine = code.replace(/\n/g, ' ').trim();
            if (oneLine.length <= 80) return '`' + oneLine + '`';
            return '\n\n```\n' + code + '\n```\n\n';
          }
          return '\n\n```' + lang + '\n' + code + '\n```\n\n';
        } catch (_) { return content; }
      }
    });

    // <pre> with no inner <code> (e.g. plain preformatted text)
    td.addRule('prePlain', {
      filter: (node) => node.nodeName === 'PRE' && (!node.firstChild || node.firstChild.nodeName !== 'CODE'),
      replacement: (content, node) => {
        try {
          const code = (node.textContent || '').replace(/\n$/, '');
          return '\n\n```\n' + code + '\n```\n\n';
        } catch (_) { return content; }
      }
    });

    // Definition lists (Wikipedia infoboxes, glossaries)
    td.addRule('definitionList', {
      filter: (node) => node.nodeName === 'DL',
      replacement: (content, node) => {
        let result = '';
        const children = Array.from(node.children);
        for (const child of children) {
          if (child.nodeName === 'DT') {
            result += '\n**' + (child.textContent || '').trim() + '**: ';
          } else if (child.nodeName === 'DD') {
            result += (child.textContent || '').trim() + '\n';
          }
        }
        return result ? '\n' + result.trim() + '\n' : '';
      }
    });

    // <kbd> → inline code (keyboard shortcut)
    td.addRule('kbd', {
      filter: (node) => node.nodeName === 'KBD',
      replacement: (content) => '`' + (content || '').trim() + '`'
    });

    // <mark> → bold (Markdown has no native highlight)
    td.addRule('mark', {
      filter: (node) => node.nodeName === 'MARK',
      replacement: (content) => '**' + (content || '').trim() + '**'
    });

    // <sub> → HTML <sub> (no Markdown equivalent)
    td.addRule('subscript', {
      filter: (node) => node.nodeName === 'SUB',
      replacement: (content) => '<sub>' + (content || '').trim() + '</sub>'
    });

    // <sup> → HTML <sup>
    td.addRule('superscript', {
      filter: (node) => node.nodeName === 'SUP',
      replacement: (content, node) => {
        // Footnote reference like [1] — render as ^1
        const txt = (content || '').trim();
        if (/^\d+$/.test(txt)) return '<sup>' + txt + '</sup>';
        // Otherwise keep as <sup>
        return '<sup>' + txt + '</sup>';
      }
    });

    // <abbr title="..."> → abbr(text) with title
    td.addRule('abbr', {
      filter: (node) => node.nodeName === 'ABBR',
      replacement: (content, node) => {
        const title = node.getAttribute('title');
        const txt = (content || '').trim();
        return title ? `${txt} (${title})` : txt;
      }
    });

    // <details><summary> → blockquote with summary
    td.addRule('details', {
      filter: (node) => node.nodeName === 'DETAILS',
      replacement: (content, node) => {
        try {
          const summary = node.querySelector('summary')?.textContent?.trim() || 'Details';
          return '\n\n> **' + summary + '**\n>\n' +
                 (content || '').trim().split('\n').map(l => '> ' + l).join('\n') +
                 '\n\n';
        } catch (_) { return content; }
      }
    });

    // Images: keep alt + src, strip srcset and other attrs
    td.addRule('image', {
      filter: 'img',
      replacement: (content, node) => {
        const alt = (node.getAttribute('alt') || '').trim();
        let src = node.getAttribute('src') || '';
        const title = node.getAttribute('title');
        if (!src || src.startsWith('data:image/svg')) return '';
        // Resolve relative URLs.
        if (src && !src.startsWith('http') && !src.startsWith('data:')) {
          try { src = new URL(src, location.href).href; } catch (_) {}
        }
        let md = `![${alt}](${src})`;
        if (title) md = `![${alt}](${src} "${title.replace(/"/g, '\\"')}")`;
        return md;
      }
    });

    // Links: strip tracking params, resolve relative URLs, collapse empty links
    td.addRule('link', {
      filter: (node) => node.nodeName === 'A' && node.getAttribute('href'),
      replacement: (content, node) => {
        let href = node.getAttribute('href') || '';
        const txt = (content || '').trim();
        if (!href || href === '#' || href.startsWith('javascript:')) return txt;
        // Resolve relative URLs.
        if (!href.startsWith('http') && !href.startsWith('mailto:') &&
            !href.startsWith('tel:') && !href.startsWith('#')) {
          try { href = new URL(href, location.href).href; } catch (_) {}
        }
        // Strip common tracking params from query string.
        try {
          const u = new URL(href);
          const trackParams = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content',
            'fbclid','gclid','msclkid','mc_eid','mc_cid','_hsenc','_hsmi','icid','vero_id','wickedid'];
          let changed = false;
          trackParams.forEach(p => { if (u.searchParams.has(p)) { u.searchParams.delete(p); changed = true; } });
          if (changed) href = u.toString();
        } catch (_) {}
        // Auto-link bare URLs (no text content).
        if (!txt) return '<' + href + '>';
        if (txt === href) return '<' + href + '>';
        return `[${txt}](${href})`;
      }
    });

    // Headings: preserve id attribute as a custom anchor for cross-reference.
    // We can't add an inline anchor in pure Markdown, but we can emit an
    // HTML anchor tag before the heading if the id is meaningful.
    ['h1','h2','h3','h4','h5','h6'].forEach(tag => {
      td.addRule('heading_' + tag, {
        filter: tag,
        replacement: (content, node) => {
          const level = parseInt(tag.slice(1));
          const txt = (content || '').trim();
          if (!txt) return '';
          // Sanitize text: collapse internal whitespace, strip trailing spaces.
          const cleanText = txt.replace(/\s+/g, ' ');
          return '\n\n' + '#'.repeat(level) + ' ' + cleanText + '\n\n';
        }
      });
    });

    // Skip non-content tags entirely.
    td.addRule('skipNonContent', {
      filter: ['head', 'script', 'style', 'link', 'meta', 'noscript', 'template'],
      replacement: () => ''
    });

    // Keep table structure for GFM tables.
    td.keep(['table', 'thead', 'tbody', 'tr', 'th', 'td']);

    // GitHub-specific: preserve .markdown-body content verbatim.
    if (siteType === 'github' || siteType === 'github-issue' || siteType === 'github-wiki') {
      td.addRule('preservedMarkdown', {
        filter: '.markdown-body',
        replacement: (content) => content
      });
    }

    // Pass the DOM node directly — serializing to HTML and re-parsing
    // creates orphaned nodes on complex SPAs (Gmail, etc.).
    try {
      return td.turndown(root);
    } catch (e) {
      log('Turndown failed, falling back to plain text:', e);
      return fallbackToPlainText(root);
    }
  }

  // ──────────────────────────────────────────────
  //  FALLBACK: Plain text extraction
  //  Used when Turndown crashes on hostile DOMs.
  // ──────────────────────────────────────────────
  function fallbackToPlainText(root) {
    // Walk block elements to preserve paragraph breaks between sections.
    const blocks = root.querySelectorAll(
      'p, div, h1, h2, h3, h4, h5, h6, li, pre, blockquote, hr, br, table, tr, th, td'
    );
    const lines = [];
    blocks.forEach(b => {
      const txt = (b.textContent || '').trim();
      if (txt) lines.push(txt);
    });
    let text = lines.join('\n\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/[ \t]+/g, ' ');
    return text.trim();
  }

  // ──────────────────────────────────────────────
  //  SELECTION CONVERSION
  // ──────────────────────────────────────────────
  function convertSelection(opts) {
    opts = opts || {};
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      throw new Error('No text selected');
    }

    const range = sel.getRangeAt(0);
    const fragment = range.cloneContents(true);
    const div = document.createElement('div');
    div.appendChild(fragment);

    // Run the same DOM cleaning + lazy-load unwrapping as full-page mode.
    cleanDOM(div, 'generic', opts, []);
    unwrapLazyImages(div);

    const fullOpts = {
      keepLinks: opts.keepLinks !== false,
      keepImages: opts.keepImages !== false,
      codeBlocks: opts.codeBlocks !== false,
    };
    const md = toMarkdown(div, 'generic', fullOpts);
    return postProcess(md, 'generic', fullOpts);
  }

  // ──────────────────────────────────────────────
  //  FRONT MATTER (YAML, with user-template support)
  // ──────────────────────────────────────────────
  function buildFrontMatter(title, url, siteType, opts) {
    // If the user provided a custom YAML template via options, use it.
    const template = opts && opts.yamlTemplate;
    if (template && typeof template === 'string' && template.includes('---')) {
      const placeholders = {
        title: yamlEscape(title || ''),
        url: yamlEscape(url || ''),
        date: new Date().toISOString().split('T')[0],
        site_type: yamlEscape(siteType || ''),
        author: yamlEscape(getMeta('author') || getMeta('article:author') || getMeta('og:article:author') || ''),
        description: yamlEscape(getMeta('description') || getMeta('og:description') || ''),
        keywords: yamlEscape(getMeta('keywords') || ''),
        source: yamlEscape(url || ''),
      };
      let out = template;
      for (const [k, v] of Object.entries(placeholders)) {
        out = out.split('{' + k + '}').join(v);
      }
      return out;
    }

    // Default YAML template.
    const lines = ['---'];
    lines.push('title: ' + yamlValue(title || ''));
    lines.push('source: ' + yamlValue(url || ''));
    lines.push('date: ' + new Date().toISOString().split('T')[0]);
    lines.push('site_type: ' + yamlValue(siteType || ''));

    const author = getMeta('author') || getMeta('article:author') || getMeta('og:article:author') || '';
    if (author) lines.push('author: ' + yamlValue(author));

    const desc = getMeta('description') || getMeta('og:description') || '';
    if (desc) lines.push('description: ' + yamlValue(desc));

    const tags = getMeta('keywords');
    if (tags) {
      // YAML inline array with proper quoting.
      const arr = tags.split(',').map(t => yamlValue(t.trim())).join(', ');
      lines.push('tags: [' + arr + ']');
    }

    // Open Graph image if present.
    const ogImage = getMeta('og:image');
    if (ogImage) lines.push('image: ' + yamlValue(ogImage));

    lines.push('---');
    return lines.join('\n');
  }

  // YAML scalar formatter — wraps strings in double quotes and escapes
  // special chars per YAML 1.2. Numbers and booleans are emitted bare.
  function yamlValue(v) {
    if (v == null) return '""';
    const s = String(v).trim();
    if (s === '') return '""';
    // Booleans / null
    if (s === 'true' || s === 'false' || s === 'null') return '"' + s + '"';
    // Numbers — keep bare if they parse cleanly.
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
    // Otherwise wrap in double quotes and escape backslash + double-quote.
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  // For use inside user templates — returns the raw escaped string
  // WITHOUT surrounding quotes, since the user controls quoting.
  function yamlEscape(v) {
    if (v == null) return '';
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // ──────────────────────────────────────────────
  //  POST-PROCESSING (code-aware)
  // ──────────────────────────────────────────────
  // Splits the markdown into code-span / code-fence / text segments,
  // applies text-only cleanups to the non-code segments, and reassembles.
  function postProcess(text, siteType, opts) {
    if (!text) return text;

    // Phase 1: split into segments (code vs. text).
    const segments = splitByCodeRegions(text);

    // Phase 2: apply text-only cleanups to non-code segments.
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.kind === 'code') continue;
      seg.text = cleanTextSegment(seg.text, siteType);
    }

    // Phase 3: reassemble.
    let out = segments.map(s => s.text).join('');

    // Phase 4: whole-document cleanups (heading hierarchy, dedup, etc.).
    out = normalizeDocument(out, siteType);

    return out;
  }

  // Split a markdown string into segments, marking fenced code blocks and
  // inline code spans as "code" so subsequent cleanups skip them.
  function splitByCodeRegions(text) {
    const segments = [];
    const lines = text.split('\n');
    let i = 0;
    let buffer = [];

    function flushBuffer() {
      if (buffer.length > 0) {
        const txt = buffer.join('\n');
        if (txt) segments.push({ kind: 'text', text: txt });
        buffer = [];
      }
    }

    while (i < lines.length) {
      const line = lines[i];
      // Detect opening of a fenced code block.
      const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
      if (fenceMatch) {
        flushBuffer();
        const fence = fenceMatch[2][0]; // ` or ~
        const fenceLen = fenceMatch[2].length;
        const codeLines = [line];
        i++;
        // Scan until matching closing fence (same char, at least same length).
        while (i < lines.length) {
          const l = lines[i];
          codeLines.push(l);
          const closeMatch = l.match(/^(\s*)(`{3,}|~{3,})\s*$/);
          if (closeMatch && closeMatch[2][0] === fence && closeMatch[2].length >= fenceLen) {
            i++;
            break;
          }
          i++;
        }
        segments.push({ kind: 'code', text: codeLines.join('\n') });
      } else {
        buffer.push(line);
        i++;
      }
    }
    flushBuffer();

    // Now split each text segment further on inline `code spans`.
    const finalSegments = [];
    for (const seg of segments) {
      if (seg.kind === 'code') { finalSegments.push(seg); continue; }
      const parts = seg.text.split(/(`[^`\n]+`)/g);
      for (const p of parts) {
        if (!p) continue;
        if (p.startsWith('`') && p.endsWith('`') && p.length >= 2) {
          finalSegments.push({ kind: 'code', text: p });
        } else {
          finalSegments.push({ kind: 'text', text: p });
        }
      }
    }
    return finalSegments;
  }

  // Cleanups applied ONLY to non-code text segments.
  function cleanTextSegment(text, siteType) {
    let t = text;

    // Collapse 4+ newlines to max 2.
    t = t.replace(/\n{4,}/g, '\n\n\n');
    // Remove spaces before punctuation (but never inside code).
    // Only fix the common cases: "word ." → "word.", "word ," → "word,"
    // Leave ellipsis "..." alone.
    t = t.replace(/ +([.,;:!?])(?!\.)/g, '$1');
    // Remove trailing whitespace on each line.
    t = t.replace(/[ \t]+$/gm, '');
    // Remove empty link syntax `[](url)`.
    t = t.replace(/\[\]\([^)]*\)/g, '');
    // Ensure headings are preceded by a blank line.
    t = t.replace(/([^\n])\n(#{1,6}\s)/g, '$1\n\n$2');
    // Ensure headings are followed by a blank line.
    t = t.replace(/(#{1,6}\s[^\n]+)\n([^\n#])/g, '$1\n\n$2');
    // Collapse multiple spaces inside lines (preserve indentation at line start).
    t = t.replace(/([^ \t\n]) {2,}([^ \t\n])/g, '$1 $2');
    // Fix stray HTML entities.
    t = t.replace(/&nbsp;/g, ' ');
    t = t.replace(/&amp;nbsp;/g, ' ');

    // Site-type-specific cleanups.
    if (siteType === 'wiki') {
      t = t.replace(/\[edit\s*\]/gi, '');
      t = t.replace(/\[citation needed\]/gi, '');
      t = t.replace(/\[clarification needed\]/gi, '');
      t = t.replace(/Jump to[: ]?\s*navigation/gi, '');
      t = t.replace(/Jump to[: ]?\s*search/gi, '');
    }

    if (siteType === 'stackoverflow') {
      t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      t = t.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }

    if (siteType === 'github' || siteType === 'github-issue' || siteType === 'github-wiki') {
      // GitHub sometimes produces duplicate headings.
      // We dedupe consecutive identical headings only.
      t = t.replace(/(#{1,6}\s[^\n]+\n)\1+/g, '$1');
    }

    return t;
  }

  // Whole-document cleanups applied after segment reassembly.
  function normalizeDocument(text, siteType) {
    let t = text;

    // Normalize heading hierarchy: if a document jumps from h1 to h3 with
    // no h2, demote the h3 to h2. We do this by scanning heading levels
    // in order and remapping them to a contiguous sequence.
    t = normalizeHeadingHierarchy(t);

    // Collapse 3+ blank lines back to 2 (the segment reassembly may have
    // introduced extras). But preserve blank lines inside fenced code
    // blocks — re-run the code-aware split for safety.
    const segs = splitByCodeRegions(t);
    for (const s of segs) {
      if (s.kind === 'code') continue;
      s.text = s.text.replace(/\n{3,}/g, '\n\n');
    }
    t = segs.map(s => s.text).join('');

    // Remove leading/trailing whitespace from the whole document.
    t = t.replace(/^\s+/, '').replace(/\s+$/, '');

    // Ensure the document ends with a single trailing newline.
    t = t.replace(/\n*$/, '\n');

    return t;
  }

  // Remap heading levels so they form a contiguous 1..N hierarchy.
  // Example: if a doc has h1, h3, h3, h4 → becomes h1, h2, h2, h3.
  function normalizeHeadingHierarchy(text) {
    const lines = text.split('\n');
    const headingRe = /^(#{1,6})\s+(.+)$/;
    let lastLevel = 0;
    const levelMap = {}; // original level → normalized level
    let nextNormalized = 0;

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(headingRe);
      if (!m) continue;
      const originalLevel = m[1].length;

      if (!(originalLevel in levelMap)) {
        if (originalLevel > lastLevel + 1 && lastLevel > 0) {
          // Skip: this heading is too deep — map it to lastLevel + 1.
          levelMap[originalLevel] = lastLevel + 1;
        } else {
          levelMap[originalLevel] = originalLevel;
        }
        lastLevel = levelMap[originalLevel];
      } else {
        lastLevel = levelMap[originalLevel];
      }

      const newLevel = levelMap[originalLevel];
      if (newLevel !== originalLevel) {
        lines[i] = '#'.repeat(newLevel) + ' ' + m[2];
      }
    }

    return lines.join('\n');
  }

  // ──────────────────────────────────────────────
  //  HELPERS
  // ──────────────────────────────────────────────
  function getMeta(name) {
    if (!name) return '';
    try {
      const el = document.querySelector(`meta[name="${cssEscape(name)}"]`) ||
                 document.querySelector(`meta[property="${cssEscape(name)}"]`);
      if (el) return (el.getAttribute('content') || '').trim();
    } catch (_) {}
    // Bulletproof fallback: walk all <meta> tags manually.
    // We use getElementsByTagName (not querySelectorAll) because some
    // CSS-selector engine bugs in older / headless environments can
    // make querySelectorAll throw on certain selector strings.
    try {
      const metas = document.getElementsByTagName('meta');
      for (let i = 0; i < metas.length; i++) {
        const m = metas[i];
        if ((m.getAttribute('name') || '') === name ||
            (m.getAttribute('property') || '') === name) {
          return (m.getAttribute('content') || '').trim();
        }
      }
    } catch (_) {}
    return '';
  }

  // CSS.escape is available in all modern browsers; fall back to manual escaping.
  function cssEscape(s) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/["\\\[\]\.]/g, '\\$&');
  }

  // Safe querySelector — never throws, returns null on any error.
  function safeQuery(sel) {
    try { return document.querySelector(sel); } catch (_) { return null; }
  }

  // Safe querySelectorAll — never throws, returns [] on any error.
  function safeQueryAll(sel) {
    try { return Array.from(document.querySelectorAll(sel)); } catch (_) { return []; }
  }

  function log(...args) {
    if (DEBUG) console.log('[Markify v' + VERSION + ']', ...args);
  }

  // Mark script as loaded.
  console.log('[Markify v' + VERSION + '] Content script loaded. Site type:',
    detectSiteType().type);
})();
