const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// State
let state = {
  running: false,
  paused: false,
  companies: [],
  people: [],
  currentKeywordIdx: 0,
  currentLocationIdx: 0,
  currentPage: 1,
  currentCompanyIdx: 0,
  tabId: null,
  resolvedLocations: {}, // cache: name -> { id, name }
};

// DOM refs
const els = {
  keywords: $('#keywords'),
  locations: $('#locations'),
  headcount: $('#headcount'),
  delay: $('#delay'),
  maxPages: $('#maxPages'),
  btnStart: $('#btnStart'),
  btnPause: $('#btnPause'),
  btnResume: $('#btnResume'),
  btnStop: $('#btnStop'),
  progressSection: $('#progressSection'),
  statusText: $('#statusText'),
  currentKeyword: $('#currentKeyword'),
  currentLocation: $('#currentLocation'),
  currentPage: $('#currentPage'),
  companyCount: $('#companyCount'),
  peopleCount: $('#peopleCount'),
  log: $('#log'),
  companiesTable: $('#companiesTable').querySelector('tbody'),
  peopleTable: $('#peopleTable').querySelector('tbody'),
  tableCompanyCount: $('#tableCompanyCount'),
  tablePeopleCount: $('#tablePeopleCount'),
};

// Init: load saved data
loadData();

// Event listeners
els.btnStart.addEventListener('click', startExtraction);
els.btnPause.addEventListener('click', pauseExtraction);
els.btnResume.addEventListener('click', resumeExtraction);
els.btnStop.addEventListener('click', stopExtraction);
$('#btnExportCompanies').addEventListener('click', () => exportCSV('companies'));
$('#btnExportPeople').addEventListener('click', () => exportCSV('people'));
$('#btnClearData').addEventListener('click', clearData);
$('#btnResolve').addEventListener('click', resolveAllLocations);

// Listen for tab updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TAB_UPDATED' && message.tabId === state.tabId) {
    log('Page loaded: ' + (message.url || ''), 'info');
  }
});

// ---- Core Flow ----

async function startExtraction() {
  const keywords = parseLines(els.keywords.value);

  if (!keywords.length) { log('No keywords provided', 'error'); return; }

  els.progressSection.style.display = 'block';

  // Get active tab first (needed for resolving locations)
  const tab = await sendBg({ type: 'GET_ACTIVE_TAB' });
  if (!tab?.tabId) { log('No active tab found. Open LinkedIn Sales Navigator first.', 'error'); return; }
  state.tabId = tab.tabId;

  // Auto-resolve locations if needed
  const locations = await resolveAndGetLocations();
  if (!locations.length) { log('No valid locations. Resolve location IDs first.', 'error'); return; }

  state.running = true;
  state.paused = false;
  state.currentKeywordIdx = 0;
  state.currentLocationIdx = 0;
  state.currentPage = 1;
  state.currentCompanyIdx = 0;

  updateButtons();

  log('Starting extraction...', 'success');

  try {
    await runAllCombinations(keywords, locations);
    log('Extraction complete!', 'success');
  } catch (e) {
    if (e.message === 'STOPPED') {
      log('Extraction stopped by user.', 'info');
    } else {
      log('Error: ' + e.message, 'error');
    }
  }

  state.running = false;
  updateButtons();
}

async function runAllCombinations(keywords, locations) {
  const headcount = els.headcount.value;
  const maxPages = parseInt(els.maxPages.value) || 5;

  for (let ki = state.currentKeywordIdx; ki < keywords.length; ki++) {
    for (let li = state.currentLocationIdx; li < locations.length; li++) {
      checkStopped();
      await waitIfPaused();

      const keyword = keywords[ki];
      const loc = locations[li];

      state.currentKeywordIdx = ki;
      state.currentLocationIdx = li;
      state.currentPage = 1;

      updateProgress(keyword, loc.name, 1);
      log(`Searching: "${keyword}" in ${loc.name}`, 'info');

      // Build search URL
      const searchUrl = buildSearchUrl(keyword, loc, headcount);
      await navigateAndWait(searchUrl);

      // Process pages
      for (let page = 1; page <= maxPages; page++) {
        checkStopped();
        await waitIfPaused();

        state.currentPage = page;
        updateProgress(keyword, loc.name, page);

        await delay(getDelay());

        // Extract search results
        const searchData = await sendToContent('EXTRACT_SEARCH_RESULTS');
        if (!searchData?.data?.results?.length) {
          log(`No results on page ${page}`, 'info');
          break;
        }

        const results = searchData.data.results;
        log(`Found ${results.length} companies on page ${page}`, 'success');

        // Visit each company
        for (let ci = 0; ci < results.length; ci++) {
          checkStopped();
          await waitIfPaused();

          const company = results[ci];
          log(`Visiting: ${company.name}`, 'info');

          // Navigate to company detail
          const companyUrl = `https://www.linkedin.com${company.href}`;
          await navigateAndWait(companyUrl);
          await delay(getDelay());

          // Extract company detail
          const detailData = await sendToContent('EXTRACT_COMPANY_DETAIL');
          if (detailData?.data) {
            const d = detailData.data;
            const companyRecord = {
              name: d.name || company.name,
              linkedinUrl: d.linkedinUrl,
              employees: d.employees,
              country: extractCountry(d.location),
              location: d.location,
              industry: cleanIndustry(d.industry),
              website: d.website,
              email: d.email,
              keyword,
              searchLocation: loc.name,
            };
            state.companies.push(companyRecord);
            updateCompanyTable(companyRecord);
            els.companyCount.textContent = state.companies.length;
            log(`  Extracted: ${companyRecord.name} | ${companyRecord.employees} employees`, 'success');

            // Visit decision makers if available
            if (d.hasDecisionMakers && d.dmHref) {
              const dmUrl = `https://www.linkedin.com${d.dmHref}`;
              await navigateAndWait(dmUrl);
              await delay(getDelay());

              const dmData = await sendToContent('EXTRACT_DECISION_MAKERS');
              if (dmData?.data?.people?.length) {
                for (const person of dmData.data.people) {
                  person.company = companyRecord.name;
                  state.people.push(person);
                  updatePeopleTable(person);
                }
                els.peopleCount.textContent = state.people.length;
                log(`  Found ${dmData.data.people.length} decision makers`, 'success');
              }
            }
          }

          // Save after each company
          saveData();
        }

        // Go to next page
        if (page < maxPages && searchData.data.hasNextPage) {
          // Navigate back to search results page for next page
          const nextPageUrl = buildSearchUrl(keyword, loc, headcount, page + 1);
          await navigateAndWait(nextPageUrl);
        } else {
          break;
        }
      }
    }
    // Reset location index for next keyword
    state.currentLocationIdx = 0;
  }
}

// ---- URL Building ----

function buildSearchUrl(keyword, location, headcount, page) {
  const encodedKeyword = encodeURIComponent(keyword);
  const filters = [
    `(type%3ACOMPANY_HEADCOUNT%2Cvalues%3AList((id%3A${headcount}%2CselectionType%3AINCLUDED)))`,
    `(type%3AREGION%2Cvalues%3AList((id%3A${location.id}%2Ctext%3A${encodeURIComponent(location.name)}%2CselectionType%3AINCLUDED)))`,
  ].join('%2C');

  let url = `https://www.linkedin.com/sales/search/company?query=(spellCorrectionEnabled%3Atrue%2Cfilters%3AList(${filters})%2Ckeywords%3A${encodedKeyword})&viewAllFilters=true`;

  if (page && page > 1) {
    url += `&page=${page}`;
  }

  return url;
}

// ---- Navigation ----

async function navigateAndWait(url) {
  await sendBg({ type: 'NAVIGATE', tabId: state.tabId, url });
  // Wait for page to load
  await delay(2000);
  // Wait for content script to be ready
  let retries = 10;
  while (retries > 0) {
    try {
      const info = await sendToContent('GET_PAGE_INFO');
      if (info?.ok) return;
    } catch (e) { /* ignore */ }
    await delay(1000);
    retries--;
  }
  log('Warning: page may not have loaded fully', 'error');
}

// ---- Communication ----

function sendBg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

function sendToContent(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'EXECUTE_CONTENT_SCRIPT',
      tabId: state.tabId,
      payload: { action, ...payload },
    }, resolve);
  });
}

// ---- Control Flow ----

function pauseExtraction() {
  state.paused = true;
  updateButtons();
  log('Paused', 'info');
  els.statusText.textContent = 'Paused';
}

function resumeExtraction() {
  state.paused = false;
  updateButtons();
  log('Resumed', 'info');
  els.statusText.textContent = 'Running';
}

function stopExtraction() {
  state.running = false;
  state.paused = false;
  updateButtons();
}

function checkStopped() {
  if (!state.running) throw new Error('STOPPED');
}

function waitIfPaused() {
  return new Promise((resolve) => {
    const check = () => {
      if (!state.paused) return resolve();
      if (!state.running) return resolve();
      setTimeout(check, 500);
    };
    check();
  });
}

// ---- UI Updates ----

function updateButtons() {
  els.btnStart.disabled = state.running;
  els.btnPause.disabled = !state.running || state.paused;
  els.btnResume.disabled = !state.running || !state.paused;
  els.btnStop.disabled = !state.running;
}

function updateProgress(keyword, location, page) {
  els.statusText.textContent = 'Running';
  els.currentKeyword.textContent = keyword;
  els.currentLocation.textContent = location;
  els.currentPage.textContent = page;
}

function log(message, type = '') {
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${message}`;
  els.log.appendChild(entry);
  els.log.parentElement.scrollTop = els.log.parentElement.scrollHeight;
}

function updateCompanyTable(company) {
  const row = els.companiesTable.insertRow();
  row.innerHTML = `
    <td title="${esc(company.name)}">${esc(company.name)}</td>
    <td>${esc(company.employees)}</td>
    <td>${esc(company.country)}</td>
    <td>${esc(company.industry)}</td>
    <td title="${esc(company.website)}">${esc(company.website)}</td>
  `;
  els.tableCompanyCount.textContent = state.companies.length;
}

function updatePeopleTable(person) {
  const row = els.peopleTable.insertRow();
  row.innerHTML = `
    <td title="${esc(person.name)}">${esc(person.name)}</td>
    <td title="${esc(person.title)}">${esc(person.title)}</td>
    <td title="${esc(person.company)}">${esc(person.company)}</td>
  `;
  els.tablePeopleCount.textContent = state.people.length;
}

// ---- Data Persistence ----

function saveData() {
  chrome.storage.local.set({
    companies: state.companies,
    people: state.people,
  });
}

function loadData() {
  chrome.storage.local.get(['companies', 'people', 'resolvedLocations'], (data) => {
    state.resolvedLocations = data.resolvedLocations || {};
    state.companies = data.companies || [];
    state.people = data.people || [];
    els.companyCount.textContent = state.companies.length;
    els.peopleCount.textContent = state.people.length;
    els.tableCompanyCount.textContent = state.companies.length;
    els.tablePeopleCount.textContent = state.people.length;

    state.companies.forEach(c => updateCompanyTable(c));
    state.people.forEach(p => updatePeopleTable(p));
  });
}

function clearData() {
  if (!confirm('Clear all extracted data?')) return;
  state.companies = [];
  state.people = [];
  els.companiesTable.innerHTML = '';
  els.peopleTable.innerHTML = '';
  els.companyCount.textContent = '0';
  els.peopleCount.textContent = '0';
  els.tableCompanyCount.textContent = '0';
  els.tablePeopleCount.textContent = '0';
  saveData();
  log('Data cleared', 'info');
}

// ---- CSV Export ----

function exportCSV(type) {
  let csv, filename;

  if (type === 'companies') {
    const headers = ['Company Name', 'LinkedIn URL', 'No. Employees', 'Country', 'Location', 'Industry', 'Company Website', 'Company Email', 'Search Keyword', 'Search Location'];
    const rows = state.companies.map(c => [
      c.name, c.linkedinUrl, c.employees, c.country, c.location, c.industry, c.website, c.email, c.keyword, c.searchLocation
    ]);
    csv = toCSV(headers, rows);
    filename = `linkedin_companies_${dateStr()}.csv`;
  } else {
    const headers = ['Name', 'Title', 'Email', 'Phone', 'Profile URL', 'Company'];
    const rows = state.people.map(p => [
      p.name, p.title, p.email, p.phone, p.profileUrl, p.company
    ]);
    csv = toCSV(headers, rows);
    filename = `linkedin_decision_makers_${dateStr()}.csv`;
  }

  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  log(`Exported ${filename}`, 'success');
}

function toCSV(headers, rows) {
  const escape = (val) => {
    const s = String(val || '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) {
    lines.push(row.map(escape).join(','));
  }
  return lines.join('\r\n');
}

// ---- Helpers ----

function parseLines(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean);
}

function parseLocations(text) {
  return parseLines(text).map(line => {
    // Support both "ID|Name" and plain "Name" formats
    if (line.includes('|')) {
      const parts = line.split('|');
      return { id: parts[0].trim(), name: parts[1]?.trim() || parts[0].trim() };
    }
    // Check if already resolved in cache
    const cached = state.resolvedLocations[line.toLowerCase()];
    if (cached) return { id: cached.id, name: cached.name };
    // Return without ID — needs resolution
    return { id: '', name: line.trim() };
  });
}

// ---- Location Resolution ----

async function resolveAllLocations() {
  const statusEl = $('#resolveStatus');
  const names = parseLines(els.locations.value);

  if (!names.length) { statusEl.innerHTML = '<span class="failed">No locations entered</span>'; return; }

  // Need active tab for API calls
  const tab = await sendBg({ type: 'GET_ACTIVE_TAB' });
  if (!tab?.tabId) {
    statusEl.innerHTML = '<span class="failed">Open LinkedIn Sales Navigator first, then resolve</span>';
    return;
  }
  state.tabId = tab.tabId;

  statusEl.innerHTML = '<span class="pending">Resolving...</span>';
  const results = [];

  for (const rawName of names) {
    const name = rawName.includes('|') ? rawName.split('|')[1]?.trim() || rawName : rawName.trim();
    const idFromLine = rawName.includes('|') ? rawName.split('|')[0]?.trim() : '';

    // Already has ID
    if (idFromLine && /^\d+$/.test(idFromLine)) {
      results.push({ input: rawName, id: idFromLine, name, ok: true });
      state.resolvedLocations[name.toLowerCase()] = { id: idFromLine, name };
      continue;
    }

    // Check cache
    if (state.resolvedLocations[name.toLowerCase()]) {
      const cached = state.resolvedLocations[name.toLowerCase()];
      results.push({ input: rawName, id: cached.id, name: cached.name, ok: true });
      continue;
    }

    // Resolve via LinkedIn API
    const resp = await sendToContent('RESOLVE_LOCATION', { locationName: name });
    if (resp?.ok && resp.data?.id) {
      results.push({ input: rawName, id: resp.data.id, name: resp.data.name, ok: true });
      state.resolvedLocations[name.toLowerCase()] = { id: resp.data.id, name: resp.data.name };
    } else {
      results.push({ input: rawName, id: '', name, ok: false, error: resp?.error || 'Not found' });
    }

    // Small delay between API calls
    await delay(500);
  }

  // Update textarea with resolved IDs
  const newLines = results.map(r => r.ok ? `${r.id}|${r.name}` : r.input);
  els.locations.value = newLines.join('\n');

  // Show status
  const resolved = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  let html = `<span class="resolved">${resolved}/${results.length} resolved</span>`;
  if (failed.length) {
    html += '<br>' + failed.map(f => `<span class="failed">Not found: ${f.name}</span>`).join('<br>');
  }
  statusEl.innerHTML = html;

  // Save cache
  chrome.storage.local.set({ resolvedLocations: state.resolvedLocations });
}

async function resolveAndGetLocations() {
  const locations = parseLocations(els.locations.value);
  const unresolved = locations.filter(l => !l.id);

  if (unresolved.length) {
    log(`Resolving ${unresolved.length} location(s)...`, 'info');
    await resolveAllLocations();
    return parseLocations(els.locations.value).filter(l => l.id);
  }

  return locations.filter(l => l.id);
}

function extractCountry(location) {
  if (!location) return '';
  const parts = location.split(',');
  return parts[parts.length - 1]?.trim() || location;
}

function cleanIndustry(industry) {
  if (!industry) return '';
  return industry.replace(/\s*\(Industry\)\s*$/i, '').trim();
}

function getDelay() {
  return (parseInt(els.delay.value) || 3) * 1000;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function dateStr() {
  return new Date().toISOString().slice(0, 10);
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}
