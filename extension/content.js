(() => {
  if (window.__linkedinExtractorLoaded) return;
  window.__linkedinExtractorLoaded = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handlers = {
      EXTRACT_SEARCH_RESULTS: extractSearchResults,
      EXTRACT_COMPANY_DETAIL: extractCompanyDetail,
      EXTRACT_DECISION_MAKERS: extractDecisionMakers,
      EXTRACT_PERSON_LINKEDIN_URL: extractPersonLinkedInUrl,
      CLICK_COMPANY: clickCompany,
      CLICK_DECISION_MAKERS_LINK: clickDecisionMakersLink,
      CLICK_NEXT_PAGE: clickNextPage,
      GET_PAGE_INFO: getPageInfo,
      RESOLVE_LOCATION: resolveLocation,
    };

    const handler = handlers[message.action];
    if (handler) {
      const result = handler(message);
      if (result instanceof Promise) {
        result
          .then(data => sendResponse({ ok: true, data }))
          .catch(e => sendResponse({ ok: false, error: e.message }));
      } else {
        sendResponse({ ok: true, data: result });
      }
    }
    return true;
  });

  function extractSearchResults() {
    const results = [];
    const items = document.querySelectorAll('.artdeco-list__item');

    items.forEach(item => {
      const nameLink = item.querySelector(
        'a[data-control-name="view_company_via_result_name"], ' +
        'a.link--mercado[data-anonymize="company-name"]'
      );
      if (!nameLink) return;

      const name = nameLink.textContent.trim();
      const href = nameLink.getAttribute('href');
      const subtitle = item.querySelector('.artdeco-entity-lockup__subtitle');
      const caption = item.querySelector('.artdeco-entity-lockup__caption');

      results.push({
        name,
        href,
        subtitle: subtitle?.textContent?.trim() || '',
        caption: caption?.textContent?.trim() || '',
      });
    });

    const pagination = document.querySelector('.artdeco-pagination');
    const currentPage = pagination?.querySelector('[aria-current="true"], .active')?.textContent?.trim();
    const nextBtn = pagination?.querySelector('button[aria-label="Next"], button.artdeco-pagination__button--next');
    const hasNextPage = nextBtn && !nextBtn.disabled;

    return { results, currentPage: currentPage || '1', hasNextPage: !!hasNextPage };
  }

  function extractCompanyDetail() {
    const getText = (selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el.textContent.trim();
      }
      return '';
    };

    const getHref = (selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el.getAttribute('href') || '';
      }
      return '';
    };

    const name = getText([
      '[data-x--account--name=""]',
      'div[data-anonymize="company-name"]',
      '.artdeco-entity-lockup__title [data-anonymize="company-name"]',
    ]);

    const employees = getText([
      'a[data-anonymize="company-size"]',
      '[data-anonymize="company-size"]',
    ]);

    const location = getText([
      'div[data-anonymize="location"]',
      '[data-anonymize="location"]',
    ]);

    const industry = getText([
      'span[data-anonymize="industry"]',
      '[data-anonymize="industry"]',
    ]);

    const website = getHref([
      'a.view-website-link',
      'a[data-control-name="visit_company_website"]',
    ]) || getText([
      'a.view-website-link',
      'a[data-control-name="visit_company_website"]',
    ]);

    const linkedinUrl = window.location.href;

    // Try to find email in the page
    const pageText = document.body.innerText;
    const emailMatch = pageText.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    const email = emailMatch ? emailMatch[0] : '';

    // Check for decision makers link
    const dmLink = document.querySelector(
      'a[aria-label*="decision maker"], a[aria-label*="Decision maker"]'
    );
    const hasDecisionMakers = !!dmLink;
    const dmHref = dmLink?.getAttribute('href') || '';

    return {
      name,
      linkedinUrl,
      employees,
      location,
      industry,
      website,
      email,
      hasDecisionMakers,
      dmHref,
    };
  }

  function extractDecisionMakers() {
    const people = [];
    const items = document.querySelectorAll('.artdeco-list__item');

    items.forEach(item => {
      const nameEl = item.querySelector(
        'span[data-anonymize="person-name"]'
      );
      const profileLink = item.querySelector(
        'a[data-lead-search-result*="profile-link"], ' +
        'a.link--mercado[data-anonymize="person-name"]'
      );
      const titleEl = item.querySelector(
        'span[data-anonymize="title"]'
      );

      if (!nameEl) return;

      const href = profileLink?.getAttribute('href') || '';
      const fullUrl = href ? `https://www.linkedin.com${href}` : '';

      people.push({
        name: nameEl.textContent.trim(),
        title: titleEl?.textContent?.trim() || '',
        profileUrl: fullUrl,
        email: '',
        phone: '',
      });
    });

    return { people };
  }

  async function extractPersonLinkedInUrl() {
    const wait = ms => new Promise(r => setTimeout(r, ms));

    // Click three-dot menu
    const overflowBtn = document.querySelector(
      'button[data-x--lead-actions-bar-overflow-menu]'
    );
    if (!overflowBtn) {
      console.log('[LI-Extractor] No overflow menu found');
      return { linkedinUrl: '' };
    }

    overflowBtn.click();
    await wait(1000);

    // Find "View LinkedIn profile" link in the menu
    const menuItems = document.querySelectorAll(
      '[id^="hue-menu-ember"] a, [id^="hue-menu-ember"] button, [role="menuitem"]'
    );
    let viewProfileLink = null;
    for (const item of menuItems) {
      const text = item.textContent?.toLowerCase() || '';
      if (text.includes('view linkedin') || text.includes('view profile') || text.includes('linkedin profile')) {
        viewProfileLink = item;
        break;
      }
    }

    if (!viewProfileLink) {
      console.log('[LI-Extractor] No "View LinkedIn profile" menu item found');
      document.body.click();
      return { linkedinUrl: '' };
    }

    // Get the href directly if it's an <a> tag
    const href = viewProfileLink.getAttribute('href') || '';
    if (href && href.includes('/in/')) {
      const fullUrl = href.startsWith('http') ? href : 'https://www.linkedin.com' + href;
      // Clean URL — remove query params
      const cleanUrl = fullUrl.split('?')[0];
      console.log('[LI-Extractor] Got profile URL from href:', cleanUrl);
      document.body.click();
      return { linkedinUrl: cleanUrl };
    }

    // If no href, click it and grab the URL from the new tab/page
    // The link has target="_blank" so it opens in a new tab
    // Instead, read the href after the menu renders fully
    console.log('[LI-Extractor] Menu item HTML:', viewProfileLink.outerHTML);
    document.body.click();
    return { linkedinUrl: '' };
  }

  function clickCompany(message) {
    const links = document.querySelectorAll(
      'a[data-control-name="view_company_via_result_name"], ' +
      'a.link--mercado[data-anonymize="company-name"]'
    );
    const idx = message.index || 0;
    if (links[idx]) {
      links[idx].click();
      return { clicked: true };
    }
    return { clicked: false, error: 'Company link not found at index ' + idx };
  }

  function clickDecisionMakersLink() {
    const link = document.querySelector(
      'a[aria-label*="decision maker"], a[aria-label*="Decision maker"]'
    );
    if (link) {
      link.click();
      return { clicked: true };
    }
    // Fallback: look for links containing "decision" text
    const allLinks = document.querySelectorAll('a');
    for (const a of allLinks) {
      if (a.textContent.toLowerCase().includes('decision maker')) {
        a.click();
        return { clicked: true };
      }
    }
    return { clicked: false, error: 'Decision makers link not found' };
  }

  function clickNextPage() {
    const nextBtn = document.querySelector(
      'button[aria-label="Next"], button.artdeco-pagination__button--next'
    );
    if (nextBtn && !nextBtn.disabled) {
      nextBtn.click();
      return { clicked: true };
    }
    return { clicked: false, error: 'No next page button found' };
  }

  function getPageInfo() {
    const url = window.location.href;
    let pageType = 'unknown';

    if (url.includes('/sales/search/company')) pageType = 'search_results';
    else if (url.includes('/sales/company/')) pageType = 'company_detail';
    else if (url.includes('/sales/search/people')) pageType = 'decision_makers';
    else if (url.includes('/sales/lead/')) pageType = 'person_profile';

    return { url, pageType };
  }

  async function resolveLocation(message) {
    const query = message.locationName;
    if (!query) throw new Error('No location name provided');

    // Get CSRF token from cookies — LinkedIn uses JSESSIONID with quotes
    const csrfToken = document.cookie
      .split('; ')
      .find(c => c.startsWith('JSESSIONID='))
      ?.split('=')
      ?.slice(1)
      ?.join('=')
      ?.replace(/"/g, '');

    const baseHeaders = {
      'accept': 'application/json',
      'x-restli-protocol-version': '2.0.0',
    };
    if (csrfToken) {
      baseHeaders['csrf-token'] = csrfToken;
    }

    const url = `https://www.linkedin.com/sales-api/salesApiFacetTypeahead?q=query&start=0&count=10&type=BING_GEO&query=${encodeURIComponent(query.toLowerCase())}`;

    console.log('[LI-Extractor] Resolving:', url);
    const resp = await fetch(url, { headers: baseHeaders, credentials: 'include' });

    if (!resp.ok) throw new Error(`API returned ${resp.status}`);

    const data = await resp.json();
    const elements = data.elements || [];

    if (!elements.length) throw new Error('No results found for: ' + query);

    // First element is best match
    const match = elements[0];
    console.log('[LI-Extractor] Resolved:', match.id, match.displayValue);

    return { id: String(match.id), name: match.displayValue || query };
  }
})();
