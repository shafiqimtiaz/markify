/**
 * Markdown This Page v3.0 — Content Script
 *
 * Philosophy (inspired by microsoft/markitdown):
 *   Different website types need different extraction strategies.
 *   A blog article, a GitHub README, a Wikipedia page, a news article,
 *   a product page, and a documentation site all have different structures.
 *   We detect the type, apply the right strategy, and produce the
 *   cleanest possible Markdown.
 *
 * Site types detected:
 *   - github        : GitHub repos, issues, PRs, wikis
 *   - blog          : Blog posts (Medium, Substack, WordPress, etc.)
 *   - news          : News articles (NYT, BBC, etc.)
 *   - docs          : Documentation sites (ReadTheDocs, GitBook, etc.)
 *   - wiki          : Wikipedia, Fandom wikis, Notion-like wikis
 *   - stackoverflow : Stack Overflow, Stack Exchange
 *   - reddit        : Reddit threads
 *   - twitter       : X/Twitter posts and threads
 *   - product       : E-commerce product pages
 *   - academic      : ArXiv, PubMed, academic papers
 *   - forum         : Generic forum/discussion threads
 *   - generic       : Everything else
 *
 * Dependencies: turndown.js, turndown-plugin-gfm.js (loaded before this)
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────
  //  MESSAGE LISTENER
  // ──────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') { sendResponse({ pong: true }); return; }
    if (msg.type === 'DETECT') {
      sendResponse({ siteType: detectSiteType() });
      return;
    }
    if (msg.type === 'CONVERT') {
      try {
        const result = convertPage(msg.options || {});
        sendResponse({ result });
      } catch (e) {
        sendResponse({ error: e.message });
      }
      return true;
    }
    if (msg.type === 'CONVERT_SELECTION') {
      try {
        const result = convertSelection();
        sendResponse({ result });
      } catch (e) {
        sendResponse({ error: e.message });
      }
      return true;
    }
    if (msg.type === 'COPY_TO_CLIPBOARD') {
      navigator.clipboard.writeText(msg.text).then(() => {
        sendResponse({ success: true });
      }).catch(e => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }
  });

  // ──────────────────────────────────────────────
  //  SITE TYPE DETECTION
  // ──────────────────────────────────────────────
  function detectSiteType() {
    const host = location.hostname.toLowerCase();
    const url = location.href;
    const meta = getMeta('og:type') || '';
    const generators = [
      getMeta('generator'), getMeta('application-name'),
      document.querySelector('meta[name="powered-by"]')?.content || ''
    ].join(' ').toLowerCase();

    // GitHub
    if (host === 'github.com' || host.endsWith('.github.com')) {
      if (url.includes('/issues/') || url.includes('/pull/')) return 'github-issue';
      if (url.endsWith('/wiki') || url.includes('/wiki/')) return 'github-wiki';
      return 'github';
    }

    // Stack Overflow / Stack Exchange
    if (host === 'stackoverflow.com' || host.includes('stackexchange.com') ||
        host.includes('.stackoverflow.com')) return 'stackoverflow';

    // Webmail (Gmail, Outlook, Yahoo — these use iframes for content)
    const webmailHosts = ['mail.google.com', 'outlook.live.com', 'outlook.office.com',
      'mail.yahoo.com', 'inbox.google.com', 'calendar.google.com'];
    if (webmailHosts.some(h => host === h || host.endsWith('.' + h))) return 'webmail';

    // Reddit
    if (host === 'www.reddit.com' || host === 'old.reddit.com' || host === 'reddit.com') return 'reddit';

    // Twitter / X
    if (host === 'twitter.com' || host === 'x.com') return 'twitter';

    // Wikipedia
    if (host.endsWith('.wikipedia.org') || host === 'www.wikidata.org') return 'wiki';

    // Medium
    if (host === 'medium.com' || host.endsWith('.medium.com')) return 'blog';

    // Substack
    if (host.endsWith('.substack.com')) return 'blog';

    // Dev.to
    if (host === 'dev.to') return 'blog';

    // Hacker News
    if (host === 'news.ycombinator.com') return 'forum';

    // ArXiv
    if (host === 'arxiv.org') return 'academic';

    // PubMed
    if (host === 'pubmed.ncbi.nlm.nih.gov') return 'academic';

    // Docs sites — common patterns
    const docsHosts = ['readthedocs.io', 'readthedocs.org', 'docs.gitlab.com',
      'docs.docker.com', 'docs.python.org', 'docs.rs', 'developer.mozilla.org',
      'developers.google.com', 'docs.github.com', 'kubernetes.io/docs',
      'postcss.org', 'webpack.js.org', 'vuejs.org', 'react.dev',
      'nextjs.org/docs', 'tailwindcss.com/docs', 'docs.aws.amazon.com'];
    if (docsHosts.some(d => host === d || host.startsWith('docs.')) ||
        url.includes('/docs/') || url.includes('/documentation')) {
      // Check if it's a docs subdomain or path
      if (host.startsWith('docs.') || host.includes('readthedocs') ||
          url.match(/\/docs\/|\/documentation/)) return 'docs';
    }
    // GitBook-style
    if (document.querySelector('[class*="gitbook"]') || host.endsWith('.gitbook.io')) return 'docs';

    // News sites — check meta og:type
    if (meta === 'article') {
      // Check for common news domains
      const newsDomains = ['nytimes.com', 'bbc.com', 'bbc.co.uk', 'theguardian.com',
        'reuters.com', 'apnews.com', 'cnn.com', 'washingtonpost.com', 'npr.org',
        'theverge.com', 'arstechnica.com', 'techcrunch.com', 'wired.com',
        'bloomberg.com', 'ft.com', 'economist.com', 'news.ycombinator.com'];
      if (newsDomains.some(d => host.includes(d))) return 'news';
    }

    // E-commerce product pages
    const productDomains = ['amazon.com', 'amazon.', 'ebay.com', 'walmart.com',
      'target.com', 'bestbuy.com', 'shopify.com'];
    if (productDomains.some(d => host.includes(d))) return 'product';
    if (getMeta('product:price:amount') || document.querySelector('[itemtype*="Product"]')) return 'product';

    // WordPress / general blog detection
    if (generators.includes('wordpress') || document.querySelector('meta[name="generator"][content*="WordPress"]')) return 'blog';
    if (document.querySelector('article .post-content, article .entry-content, article .post-body')) return 'blog';

    // Generic article
    if (meta === 'article' || document.querySelector('article')) {
      if (document.querySelector('article').textContent.trim().length > 500) return 'blog';
    }

    // Forum
    if (document.querySelector('.forum, .forum-post, .thread, .topic, .comment-list') ||
        host.includes('forum') || host.includes('discourse')) return 'forum';

    // Notion / Confluence
    if (host.includes('notion.site') || host.includes('notion.so') || host.includes('atlassian.net/wiki')) return 'wiki';

    // Fallback
    return 'generic';
  }

  // ──────────────────────────────────────────────
  //  MAIN CONVERSION ENTRY
  // ──────────────────────────────────────────────
  function convertPage(opts) {
    const url = location.href;
    const title = document.title || '';
    const siteType = detectSiteType();

    // Load user settings for custom selectors
    let userExclude = [];
    let userInclude = [];
    try {
      // We can't use chrome.storage in content scripts synchronously,
      // so we'll use whatever's in opts. The popup passes settings in.
      userExclude = (opts.extraExclude || '').split('\n').map(s => s.trim()).filter(Boolean);
      userInclude = (opts.extraInclude || '').split('\n').map(s => s.trim()).filter(Boolean);
    } catch (_) {}

    // 1. Find the content root using site-type-specific strategy
    const contentRoot = extractContent(siteType, opts, userInclude);

    // 2. Clone and clean
    const clone = contentRoot.cloneNode(true);
    cleanDOM(clone, siteType, opts, userExclude);

    // 3. Apply site-type-specific transformations
    applySiteTransforms(clone, siteType);

    // 4. Convert to Markdown via Turndown
    const markdown = toMarkdown(clone, siteType, opts);

    // 5. Wrap with metadata
    let output = '';
    if (opts.includeMetadata) {
      output = buildFrontMatter(title, url, siteType) + '\n\n';
    } else if (opts.includeTitle) {
      output = '# ' + title + '\n\n';
    }
    output += markdown;

    // 6. Post-process
    output = postProcess(output, siteType);

    return output;
  }

  // ──────────────────────────────────────────────
  //  CONTENT EXTRACTION BY SITE TYPE
  // ──────────────────────────────────────────────
  function extractContent(siteType, opts, userInclude) {
    // User-specified include selectors take top priority
    for (const sel of userInclude) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 100) return el;
    }

    switch (siteType) {
      case 'github':
        return extractGitHub(opts);
      case 'github-issue':
        return extractGitHubIssue();
      case 'github-wiki':
        return extractGitHubWiki();
      case 'stackoverflow':
        return extractStackOverflow();
      case 'webmail':
        return extractWebmail();
      case 'reddit':
        return extractReddit();
      case 'twitter':
        return extractTwitter();
      case 'wiki':
        return extractWikipedia();
      case 'news':
        return extractArticle();
      case 'blog':
        return extractArticle();
      case 'docs':
        return extractDocs();
      case 'product':
        return extractProduct();
      case 'academic':
        return extractAcademic();
      case 'forum':
        return extractForum();
      default:
        return extractGeneric(opts);
    }
  }

  // --- GitHub repo README ---
  function extractGitHub() {
    // README is the primary content on a repo page
    const readme = document.querySelector('#readme .markdown-body, article.markdown-body');
    if (readme) return readme;

    // Fallback: main content area
    return document.querySelector('[data-target="readme-toc.content"]') ||
           document.querySelector('main .markdown-body') ||
           document.querySelector('main') ||
           document.body;
  }

  // --- GitHub issue / PR ---
  function extractGitHubIssue() {
    // Issue/PR body
    const body = document.querySelector('.js-discussion, .timeline-comment-body, .comment-body');
    if (body) return body;
    return document.querySelector('main') || document.body;
  }

  // --- GitHub wiki ---
  function extractGitHubWiki() {
    return document.querySelector('.markdown-body, main') || document.body;
  }

  // --- Stack Overflow ---
  function extractStackOverflow() {
    const container = document.createElement('div');

    // Question
    const question = document.querySelector('.question .js-post-body, .question .post-text, .question-cell .s-prose');
    if (question) {
      const qTitle = document.querySelector('.question-hyperlink, h1.fs-headline');
      if (qTitle) {
        const h = document.createElement('h1');
        h.textContent = qTitle.textContent.trim();
        container.appendChild(h);
      }
      container.appendChild(question.cloneNode(true));

      // Answers
      const answers = document.querySelectorAll('.answer .js-post-body, .answer .post-text, .answer-cell .s-prose');
      answers.forEach((ans, i) => {
        const h2 = document.createElement('h2');
        const isAccepted = ans.closest('.answer')?.classList.contains('accepted-answer');
        h2.textContent = (isAccepted ? '✓ ' : '') + 'Answer ' + (i + 1);
        container.appendChild(h2);
        container.appendChild(ans.cloneNode(true));
      });
    }

    return container.children.length > 0 ? container : (document.querySelector('.question, main') || document.body);
  }

  // --- Webmail (Gmail, Outlook, etc.) ---
  // These apps render email content inside iframes.
  // We collect content from all visible iframes.
  function extractWebmail() {
    const container = document.createElement('div');

    // Try to get content from iframes (Gmail, Outlook)
    try {
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach(iframe => {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!doc) return;
          // Gmail: the printable version or the main content area
          const body = doc.body || doc.documentElement;
          if (body && body.textContent.trim().length > 20) {
            container.appendChild(body.cloneNode(true));
          }
        } catch (e) {
          // Cross-origin iframe — skip
        }
      });
    } catch (_) {}

    // If we got iframe content, use it
    if (container.textContent.trim().length > 50) return container;

    // Fallback: try to get whatever visible text exists at top level
    // For Gmail, the conversation view sometimes has content outside iframes
    const visible = document.querySelector('.a3s, [role="main"]');
    if (visible && visible.textContent.trim().length > 50) return visible;

    // Last resort: body
    return document.body;
  }

  // --- Reddit ---
  function extractReddit() {
    const container = document.createElement('div');

    // Post title and body
    const postTitle = document.querySelector('h1[slot="title"], shreddit-post [slot="title"], .Post h1');
    const postBody = document.querySelector('shreddit-post .md, .Post .md, [data-click-id="text"]');
    if (postTitle) {
      const h = document.createElement('h1');
      h.textContent = postTitle.textContent.trim();
      container.appendChild(h);
    }
    if (postBody) container.appendChild(postBody.cloneNode(true));

    // Comments
    const comments = document.querySelectorAll('shreddit-comment .md, .Comment .md, .comment .md');
    comments.forEach((c, i) => {
      const author = c.closest('shreddit-comment, .Comment, .comment')?.querySelector('a.author, [author]')?.textContent?.trim() || 'Anonymous';
      const h3 = document.createElement('h3');
      h3.textContent = 'Comment by ' + author;
      container.appendChild(h3);
      container.appendChild(c.cloneNode(true));
    });

    return container.children.length > 0 ? container : document.body;
  }

  // --- Twitter ---
  function extractTwitter() {
    const container = document.createElement('div');
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    tweets.forEach((tweet, i) => {
      if (i === 0) {
        const h = document.createElement('h1');
        h.textContent = document.title.split(' / ')[0].split(' on ')[0].split(': ')[0];
        container.appendChild(h);
      }
      const author = tweet.querySelector('[data-testid="User-Name"]')?.textContent?.trim()?.split('\n')[0] || '';
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
    return container.children.length > 1 ? container : document.body;
  }

  // --- Wikipedia ---
  function extractWikipedia() {
    // Wikipedia has very specific structure
    const content = document.querySelector('#mw-content-text');
    if (content) return content;
    return document.querySelector('.mw-parser-output, main, #content') || document.body;
  }

  // --- Blog / News article ---
  function extractArticle() {
    // Try well-known article containers
    const selectors = [
      'article',
      '[role="main"]',
      'main',
      '.post-content', '.article-content', '.entry-content', '.content-body',
      '.post-body', '.story-body', '#content', '.content', '.main-content',
      '#main-content', '.markdown-body', '.prose', '.rich-text',
      '[class*="article"]', '[class*="Article"]',
      '[class*="post-content"]', '[class*="PostContent"]',
      '[class*="rich-text"]', '[class*="RichText"]',
      // Medium-specific
      '.meteredContent',
      // Substack
      '.available-content',
      // WordPress
      '.entry-content',
      // Ghost
      '.gh-content',
      // Hashnode
      '.content-inner',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 200) return el;
    }
    return document.body || document.documentElement;
  }

  // --- Documentation ---
  function extractDocs() {
    // Docs pages usually have a main content area separate from sidebar/nav
    const selectors = [
      '.documentation', '.docs-content', '.doc-content',
      '.content-area', '.page-content',
      // ReadTheDocs
      '.rst-content', '.document',
      // GitBook
      '.markdown-section',
      // Docusaurus
      'article.markdown',
      // MkDocs Material
      '.md-content__inner',
      // VitePress / VuePress
      '.vp-doc, .content-container',
      // Generic
      'main .content', 'main article', 'main',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 100) return el;
    }
    // Fallback: try main minus any sidebar
    const main = document.querySelector('main');
    if (main) return main;
    return document.body;
  }

  // --- Product page ---
  function extractProduct() {
    const container = document.createElement('div');
    const title = document.querySelector('[itemprop="name"], .product-title, h1');
    const price = document.querySelector('[itemprop="price"], .price, .product-price');
    const desc = document.querySelector('[itemprop="description"], .product-description, .product-details, #feature-bullets');
    const specs = document.querySelector('#productDetails_detailBullets_sections1, .product-specs, table.prodDetails');

    if (title) {
      const h = document.createElement('h1');
      h.textContent = title.textContent.trim();
      container.appendChild(h);
    }
    if (price) {
      const h2 = document.createElement('h2');
      h2.textContent = 'Price: ' + price.textContent.trim();
      container.appendChild(h2);
    }
    if (desc) container.appendChild(desc.cloneNode(true));
    if (specs) container.appendChild(specs.cloneNode(true));

    return container.children.length > 0 ? container : document.body;
  }

  // --- Academic paper ---
  function extractAcademic() {
    // ArXiv abstract page
    const abstract = document.querySelector('#abs, .abstract');
    if (abstract) {
      const container = document.createElement('div');
      const title = document.querySelector('.title mathjax, .ltx_title, h1.title');
      if (title) {
        const h = document.createElement('h1');
        h.textContent = title.textContent.trim();
        container.appendChild(h);
      }
      const authors = document.querySelector('.authors, .author-list');
      if (authors) {
        const h2 = document.createElement('h2');
        h2.textContent = 'Authors';
        container.appendChild(h2);
        const p = document.createElement('p');
        p.textContent = authors.textContent.trim();
        container.appendChild(p);
      }
      container.appendChild(abstract.cloneNode(true));
      return container;
    }
    return extractArticle();
  }

  // --- Forum ---
  function extractForum() {
    const container = document.createElement('div');
    // Discourse-style
    const posts = document.querySelectorAll('.topic-post .cooked, .post .cooked, .topic-body .cooked');
    posts.forEach((post, i) => {
      if (i === 0) {
        const title = document.querySelector('#topic-title, .fancy-title, .topic-link');
        if (title) {
          const h = document.createElement('h1');
          h.textContent = title.textContent.trim();
          container.appendChild(h);
        }
      }
      const author = post.closest('.topic-post, .post')?.querySelector('.username, .names .name, a.creator')?.textContent?.trim();
      if (author && i > 0) {
        const h3 = document.createElement('h3');
        h3.textContent = 'Post by ' + author;
        container.appendChild(h3);
      }
      container.appendChild(post.cloneNode(true));
    });
    return container.children.length > 0 ? container : document.body;
  }

  // --- Generic fallback ---
  function extractGeneric(opts) {
    if (opts.smartExtract === false) return document.documentElement;
    return extractArticle();
  }

  // ──────────────────────────────────────────────
  //  DOM CLEANING (site-type-aware)
  // ──────────────────────────────────────────────
  function cleanDOM(root, siteType, opts, userExclude) {
    // Universal noise selectors
    const NOISE = [
      'script','style','noscript','iframe','object','embed','svg','canvas',
      '[role="navigation"]','nav','[role="banner"]',
      '[role="contentinfo"]','footer',
      '[role="complementary"]','aside',
      '[role="search"]','[role="alert"]','[role="dialog"]',
      '.ad','.ads','.ad-banner','.ad-container','.advertisement',
      '.cookie','.cookie-banner','.cookie-notice',
      '.popup','.modal','.overlay',
      '.newsletter','.subscribe','.subscription',
      '.social-share','.share-buttons','.sharing',
      '.related-posts','.recommended',
      '.breadcrumb',
      '[aria-hidden="true"]','.hidden',
      '[style*="display: none"]','[style*="display:none"]',
    ];

    // Site-type-specific noise
    const SITE_NOISE = {
      'github': [
        '.BorderGrid-row--gutter', '.BorderGrid-cell', '.flex-order-2',
        '#wiki-rightbar', '.gh-header-sticky', '.pagehead-actions',
        '.signup-prompt', 'form[action*="star"]', '.file-navigation',
        'details.repository-lang-stats', '#readme .Box-header',
        '.js-social-container', '.BtnGroup', '.branch-select-menu',
      ],
      'github-issue': [
        '.discussion-sidebar', '.js-discussion-sidebar',
        '.timeline-comment-actions', '.comment-actions',
        '.js-socket-channel', '.gh-header-actions',
      ],
      'stackoverflow': [
        '.sidebar', '.left-sidebar', '#sidebar',
        '.related', '.related-questions', '.hot-network-questions',
        '.s-sidebarwidget', '.js-staging-ground-banner',
        '.topbar', '.js-consent-banner',
      ],
      'reddit': [
        '.subreddit-bar', '#header', '.searchbox',
        '.comment-sort', '.menuarea', '.flat-list.buttons',
        'shreddit-sidebar', '[id="subreddit-sidebar"]',
      ],
      'twitter': [
        '[data-testid="sidebarColumn"]', 'header[role="banner"]',
        'nav[aria-label]', '[data-testid="placementTracking"]',
      ],
      'wiki': [
        '#toc', '.toc', '.navbox', '.navbox-styles',
        '.catlinks', '.sistersitebox', '.authority-control',
        '#p-lang', '.mw-editsection', '.mw-indicators',
        '.noprint', '.thumbcaption', '.magnify',
        'sup.reference', '.reflist', '.refbegin',
      ],
      'docs': [
        '.sidebar', '.sidebar-nav', '.table-of-contents',
        '.navigation', '.breadcrumb', '.edit-this-page',
        '.theme-toggler', '.search-sidebar', '.sidebar-link',
        '.nav-group', '.menu', '[class*="sidebar"]',
        '.page-nav', '.prev-next',
      ],
      'blog': [
        '.sidebar', '.sidebar-widget', '.author-bio-card',
        '.post-navigation', '.comments-title',
        '.related-posts', '.recommendation',
        '.share-widget', '.newsletter-signup',
        '.post-meta', '.byline-misc', '.reading-time',
      ],
      'news': [
        '.sidebar', '.ad-placement', '.newsletter-signup',
        '.most-popular', '.trending', '.opinion',
        '.sponsored', '.partner-content',
      ],
      'product': [
        '.sidebar', '.product-gallery-nav', '.add-to-cart',
        '.customer-reviews-header', '.recommendations',
        '.also-bought', '.sponsored-products',
      ],
      'academic': [
        '.header-breadcrumbs', '.full-view', '.ltx_page_nav',
        '.ltx_page_footer', '.ltx_page_sidebar',
      ],
      'forum': [
        '.topic-list', '.category-list', '.navigation-bar',
        '.header-buttons', '.topic-footer-main-buttons',
      ],
      'generic': [],
    };

    const allNoise = [...NOISE, ...(SITE_NOISE[siteType] || []), ...userExclude];
    // CRITICAL: convert NodeList to array before mutating.
    // Iterating a live NodeList while calling .remove() causes
    // 'parentNode is undefined' errors on complex DOMs (Gmail, SPAs).
    const noiseEls = Array.from(root.querySelectorAll(allNoise.join(',')));
    noiseEls.forEach(el => { try { el.remove(); } catch (_) {} });

    const hiddenEls = Array.from(root.querySelectorAll('[hidden]'));
    hiddenEls.forEach(el => { try { el.remove(); } catch (_) {} });

    // Remove empty containers
    ['p','div','span','section'].forEach(tag => {
      const els = Array.from(root.querySelectorAll(tag));
      els.forEach(el => {
        try {
          const text = el.textContent.trim();
          if (!text.length && !el.querySelector('img,video,audio,code,pre,table,figure')) {
            el.remove();
          }
        } catch (_) {}
      });
    });

    if (opts.keepImages === false) {
      Array.from(root.querySelectorAll('img')).forEach(el => { try { el.remove(); } catch (_) {} });
    }
    if (opts.keepLinks === false) {
      Array.from(root.querySelectorAll('a')).forEach(el => {
        try { el.replaceWith(document.createTextNode(el.textContent)); } catch (_) {}
      });
    }
  }

  // ──────────────────────────────────────────────
  //  SITE-TYPE-SPECIFIC TRANSFORMS
  // ──────────────────────────────────────────────
  function applySiteTransforms(root, siteType) {
    try {
      // Wikipedia: clean up infoboxes, convert to definition lists
      if (siteType === 'wiki') {
        Array.from(root.querySelectorAll('.infobox, .infobox-table, .wikitable')).forEach(table => {
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
          try { table.replaceWith(dl); } catch (_) {}
        });
        // Remove citation brackets
        Array.from(root.querySelectorAll('sup')).forEach(sup => {
          if (sup.textContent.match(/^\[?\d+\]?$/)) { try { sup.remove(); } catch (_) {} }
        });
      }

      // GitHub: clean up task lists
      if (siteType === 'github' || siteType === 'github-issue') {
        Array.from(root.querySelectorAll('.task-list-item')).forEach(item => {
          try {
            const cb = item.querySelector('input[type="checkbox"]');
            if (cb) {
              const prefix = cb.checked ? '[x] ' : '[ ] ';
              const text = item.textContent.trim();
              const p = document.createElement('p');
              p.textContent = prefix + text;
              item.replaceWith(p);
            }
          } catch (_) {}
        });
      }

      // Stack Overflow: add answer separators
      if (siteType === 'stackoverflow') {
        Array.from(root.querySelectorAll('h2')).forEach(h2 => {
          try { h2.before(document.createElement('hr')); } catch (_) {}
        });
      }

      // Docs: preserve heading hierarchy, add code language hints
      if (siteType === 'docs') {
        Array.from(root.querySelectorAll('pre code')).forEach(code => {
          try {
            const cls = code.getAttribute('class') || '';
            if (!cls.includes('language-')) {
              const parent = code.parentElement;
              const heading = parent?.previousElementSibling?.textContent?.toLowerCase() || '';
              const langMap = { 'python': 'python', 'javascript': 'javascript', 'js': 'javascript',
                'typescript': 'typescript', 'ts': 'typescript', 'java': 'java', 'rust': 'rust',
                'go': 'go', 'ruby': 'ruby', 'php': 'php', 'c++': 'cpp', 'c#': 'csharp',
                'shell': 'bash', 'bash': 'bash', 'sql': 'sql', 'html': 'html', 'css': 'css',
                'yaml': 'yaml', 'json': 'json', 'xml': 'xml', 'docker': 'dockerfile',
              };
              for (const [key, lang] of Object.entries(langMap)) {
                if (heading.includes(key)) { code.classList.add('language-' + lang); break; }
              }
            }
          } catch (_) {}
        });
      }
    } catch (e) {
      console.warn('[MTP] Site transforms error:', e.message);
    }
  }

  // ──────────────────────────────────────────────
  //  TURNDOWN CONVERSION (site-type-tuned)
  // ──────────────────────────────────────────────
  function toMarkdown(root, siteType, opts) {
    const td = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: opts.codeBlocks !== false ? 'fenced' : 'inline',
      fence: '```',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
      br: '  ',
    });

    // GFM plugin
    if (typeof turndownPluginGfm !== 'undefined') {
      td.use(turndownPluginGfm.gfm);
    }

    // --- Universal custom rules ---

    // Figures
    td.addRule('figure', {
      filter: 'figure',
      replacement: (content, node) => {
        const img = node.querySelector('img');
        const figcaption = node.querySelector('figcaption');
        if (!img) return content;
        const alt = img.alt || '';
        const src = img.getAttribute('src') || '';
        let md = `![${alt}](${src})`;
        if (figcaption?.textContent?.trim()) md += '\n*' + figcaption.textContent.trim() + '*';
        return '\n\n' + md + '\n\n';
      }
    });

    // Pre > Code
    td.addRule('preCodeBlock', {
      filter: (node) => node.nodeName === 'PRE' && node.firstChild?.nodeName === 'CODE',
      replacement: (content, node) => {
        const codeEl = node.firstChild;
        const lang = (codeEl.getAttribute('class') || '').match(/(?:language|lang|highlight)-(\w+)/)?.[1] || '';
        const code = codeEl.textContent || codeEl.innerText || '';
        if (opts.codeBlocks === false) {
          return '`' + code.replace(/\n/g, ' ').trim().substring(0, 80) + (code.length > 80 ? '...' : '') + '`';
        }
        return '\n\n```' + lang + '\n' + code.replace(/\n$/, '') + '\n```\n\n';
      }
    });

    // Definition lists (for Wikipedia infoboxes)
    td.addRule('definitionList', {
      filter: (node) => node.nodeName === 'DL',
      replacement: (content, node) => {
        let result = '';
        const children = Array.from(node.children);
        for (const child of children) {
          if (child.nodeName === 'DT') {
            result += '\n**' + child.textContent.trim() + '**: ';
          } else if (child.nodeName === 'DD') {
            result += child.textContent.trim() + '\n';
          }
        }
        return result ? '\n' + result.trim() + '\n' : '';
      }
    });

    // Tables → keep GFM tables (already handled by GFM plugin)

    // Skip non-content
    td.addRule('skipNonContent', {
      filter: ['head', 'script', 'style', 'link', 'meta', 'noscript'],
      replacement: () => ''
    });

    td.keep(['table', 'thead', 'tbody', 'tr', 'th', 'td']);

    // Site-type-specific Turndown rules
    if (siteType === 'github' || siteType === 'github-issue' || siteType === 'github-wiki') {
      // GitHub uses .markdown-body — preserve its existing markdown structure
      // Don't re-convert markdown that's already rendered
      td.addRule('preservedMarkdown', {
        filter: '.markdown-body',
        replacement: (content, node) => {
          // The inner content is already mostly markdown-like
          return content;
        }
      });
    }

    const html = root.innerHTML || root.outerHTML;
    // Fallback: if Turndown crashes on complex DOMs (SPAs like Gmail),
    // fall back to plain text extraction
    try {
      return td.turndown(html);
    } catch (e) {
      console.warn('[MTP] Turndown failed, falling back to plain text:', e.message);
      return fallbackToPlainText(root);
    }
  }

  // ──────────────────────────────────────────────
  //  FALLBACK: Plain text extraction
  //  Used when Turndown crashes on hostile DOMs
  // ──────────────────────────────────────────────
  function fallbackToPlainText(root) {
    let text = root.textContent || '';
    // Basic formatting: preserve paragraph breaks
    text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
    text = text.replace(/[ \t]+/g, ' ');
    return text.trim();
  }

  // ──────────────────────────────────────────────
  //  SELECTION CONVERSION
  // ──────────────────────────────────────────────
  function convertSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) throw new Error('No text selected');

    const range = sel.getRangeAt(0);
    const fragment = range.cloneContents(true);
    const div = document.createElement('div');
    div.appendChild(fragment);

    const opts = { keepLinks: true, keepImages: true, codeBlocks: true };
    const cleanHtml = div.innerHTML;
    const md = toMarkdown(div, 'generic', opts);
    return postProcess(md, 'generic');
  }

  // ──────────────────────────────────────────────
  //  FRONT MATTER
  // ──────────────────────────────────────────────
  function buildFrontMatter(title, url, siteType) {
    const lines = ['---'];
    lines.push('title: "' + (title || '').replace(/"/g, '\\"') + '"');
    lines.push('source: "' + url + '"');
    lines.push('date: "' + new Date().toISOString().split('T')[0] + '"');
    lines.push('site_type: "' + siteType + '"');

    const author = getMeta('author') || getMeta('article:author') || getMeta('og:article:author') || '';
    if (author) lines.push('author: "' + author.replace(/"/g, '\\"') + '"');

    const desc = getMeta('description') || getMeta('og:description') || '';
    if (desc) lines.push('description: "' + desc.replace(/"/g, '\\"') + '"');

    const tags = getMeta('keywords');
    if (tags) lines.push('tags: [' + tags.split(',').map(t => '"' + t.trim() + '"').join(', ') + ']');

    lines.push('---');
    return lines.join('\n');
  }

  // ──────────────────────────────────────────────
  //  POST-PROCESSING
  // ──────────────────────────────────────────────
  function postProcess(text, siteType) {
    // Universal cleanup
    text = text.replace(/\n{4,}/g, '\n\n\n');
    text = text.replace(/ ([.,;:!?])/g, '$1');
    text = text.replace(/[ \t]+$/gm, '');
    text = text.replace(/\[\]\([^)]*\)/g, '');
    text = text.replace(/([^\n])\n(#{1,6}\s)/g, '$1\n\n$2');

    // Site-type-specific cleanup
    if (siteType === 'wiki') {
      // Clean up Wikipedia-specific artifacts
      text = text.replace(/\[edit\s*\]/gi, '');
      text = text.replace(/\[citation needed\]/gi, '');
      text = text.replace(/Jump to[: ]?\s*navigation/gi, '');
    }

    if (siteType === 'github' || siteType === 'github-issue') {
      // GitHub sometimes produces duplicate headings
      const seen = new Set();
      text = text.split('\n').map(line => {
        const m = line.match(/^(#{1,6})\s+(.+)$/);
        if (m) {
          const key = m[2].trim();
          if (seen.has(key)) return ''; // skip duplicate heading
          seen.add(key);
        }
        return line;
      }).join('\n');
    }

    if (siteType === 'stackoverflow') {
      // Clean up HTML entities that SO sometimes has
      text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      text = text.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }

    // Final trim
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
  }

  // ──────────────────────────────────────────────
  //  HELPERS
  // ──────────────────────────────────────────────
  function getMeta(name) {
    const el = document.querySelector(`meta[name="${name}"]`) ||
               document.querySelector(`meta[property="${name}"]`);
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  console.log('[Markdown This Page v3.0] Content script loaded. Site type:',
    detectSiteType());
})();