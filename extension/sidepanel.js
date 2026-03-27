const $ = (sel) => document.querySelector(sel);

// State
let state = {
  running: false,
  paused: false,
  results: [], // combined: company + decision makers per row
  currentKeywordIdx: 0,
  currentLocationIdx: 0,
  currentPage: 1,
  tabId: null,
  resolvedLocations: {},
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
  resultsTable: $('#resultsTable').querySelector('tbody'),
  tableCount: $('#tableCount'),
};

// Init
loadData();

// Events
els.btnStart.addEventListener('click', startExtraction);
els.btnPause.addEventListener('click', () => { state.paused = true; updateButtons(); log('Paused', 'info'); els.statusText.textContent = 'Paused'; });
els.btnResume.addEventListener('click', () => { state.paused = false; updateButtons(); log('Resumed', 'info'); els.statusText.textContent = 'Running'; });
els.btnStop.addEventListener('click', () => { state.running = false; state.paused = false; updateButtons(); });
$('#btnExportCSV').addEventListener('click', exportCSV);
$('#btnClearData').addEventListener('click', clearData);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TAB_UPDATED' && message.tabId === state.tabId) {
    log('Page loaded', 'info');
  }
});

// ---- Core Flow ----

async function startExtraction() {
  const keywords = parseLines(els.keywords.value);
  const locationNames = parseLines(els.locations.value);

  if (!keywords.length) { log('No keywords', 'error'); return; }
  if (!locationNames.length) { log('No locations', 'error'); return; }

  els.progressSection.style.display = 'block';

  const tab = await sendBg({ type: 'GET_ACTIVE_TAB' });
  if (!tab?.tabId) { log('Open LinkedIn Sales Navigator first', 'error'); return; }
  state.tabId = tab.tabId;

  // Auto-resolve locations
  log('Resolving locations...', 'info');
  const locations = await resolveLocations(locationNames);
  if (!locations.length) { log('Failed to resolve locations', 'error'); return; }
  log(`Resolved ${locations.length} location(s)`, 'success');

  state.running = true;
  state.paused = false;
  state.currentKeywordIdx = 0;
  state.currentLocationIdx = 0;
  state.currentPage = 1;
  updateButtons();

  log('Starting...', 'success');

  try {
    await runAllCombinations(keywords, locations);
    log('Done!', 'success');
  } catch (e) {
    if (e.message === 'STOPPED') log('Stopped', 'info');
    else log('Error: ' + e.message, 'error');
  }

  state.running = false;
  updateButtons();
  els.statusText.textContent = 'Idle';
}

async function runAllCombinations(keywords, locations) {
  const headcount = els.headcount.value;
  const maxPages = parseInt(els.maxPages.value) || 5;

  for (let ki = 0; ki < keywords.length; ki++) {
    for (let li = 0; li < locations.length; li++) {
      checkStopped(); await waitIfPaused();

      const keyword = keywords[ki];
      const loc = locations[li];
      updateProgress(keyword, loc.name, 1);
      log(`Searching: "${keyword}" in ${loc.name}`, 'info');

      const searchUrl = buildSearchUrl(keyword, loc, headcount);
      await navigateAndWait(searchUrl);

      for (let page = 1; page <= maxPages; page++) {
        checkStopped(); await waitIfPaused();
        updateProgress(keyword, loc.name, page);
        await sleep(getDelay());

        const searchData = await sendToContent('EXTRACT_SEARCH_RESULTS');
        if (!searchData?.data?.results?.length) { log(`No results page ${page}`, 'info'); break; }

        const companies = searchData.data.results;
        log(`${companies.length} companies on page ${page}`, 'success');

        for (const company of companies) {
          checkStopped(); await waitIfPaused();
          log(`Visiting: ${company.name}`, 'info');

          const companyUrl = `https://www.linkedin.com${company.href}`;
          await navigateAndWait(companyUrl);
          await sleep(getDelay());

          const detail = await sendToContent('EXTRACT_COMPANY_DETAIL');
          if (!detail?.data) continue;

          const d = detail.data;
          const companyInfo = {
            companyName: d.name || company.name,
            companyLinkedinUrl: d.linkedinUrl,
            employees: d.employees,
            country: extractCountry(d.location),
            location: d.location,
            industry: cleanIndustry(d.industry),
            website: d.website,
            email: d.email,
          };

          log(`  ${companyInfo.companyName} | ${companyInfo.employees}`, 'success');

          // Get decision makers
          if (d.hasDecisionMakers && d.dmHref) {
            const dmUrl = `https://www.linkedin.com${d.dmHref}`;
            await navigateAndWait(dmUrl);
            await sleep(getDelay());

            const dmData = await sendToContent('EXTRACT_DECISION_MAKERS');
            if (dmData?.data?.people?.length) {
              for (const person of dmData.data.people) {
                checkStopped(); await waitIfPaused();

                // Visit person profile to get public LinkedIn URL
                let personLinkedinUrl = '';
                if (person.profileUrl) {
                  const profilePath = person.profileUrl.replace('https://www.linkedin.com', '');
                  await navigateAndWait(person.profileUrl);
                  await sleep(getDelay());

                  const urlData = await sendToContent('EXTRACT_PERSON_LINKEDIN_URL');
                  personLinkedinUrl = urlData?.data?.linkedinUrl || '';
                  if (personLinkedinUrl) {
                    log(`    LinkedIn: ${personLinkedinUrl}`, 'success');
                  }
                }

                const row = {
                  ...companyInfo,
                  contactName: person.name,
                  contactTitle: person.title,
                  contactLinkedinUrl: personLinkedinUrl,
                  contactEmail: person.email || '',
                  contactPhone: person.phone || '',
                  keyword,
                  searchLocation: loc.name,
                };
                state.results.push(row);
                addTableRow(row);
              }
              log(`  ${dmData.data.people.length} decision maker(s)`, 'success');
            } else {
              // No decision makers, add company-only row
              state.results.push({ ...companyInfo, contactName: '', contactTitle: '', contactLinkedinUrl: '', contactEmail: '', contactPhone: '', keyword, searchLocation: loc.name });
              addTableRow(companyInfo);
            }
          } else {
            state.results.push({ ...companyInfo, contactName: '', contactTitle: '', contactLinkedinUrl: '', contactEmail: '', contactPhone: '', keyword, searchLocation: loc.name });
            addTableRow(companyInfo);
          }

          saveData();
        }

        if (page < maxPages && searchData.data.hasNextPage) {
          await navigateAndWait(buildSearchUrl(keyword, loc, headcount, page + 1));
        } else {
          break;
        }
      }
    }
  }
}

// ---- Location Resolution ----

async function resolveLocations(names) {
  const resolved = [];
  for (const raw of names) {
    // Support ID|Name format for backward compat
    if (raw.includes('|')) {
      const [id, name] = raw.split('|').map(s => s.trim());
      if (/^\d+$/.test(id)) { resolved.push({ id, name }); continue; }
    }

    const name = raw.trim();
    if (state.resolvedLocations[name.toLowerCase()]) {
      resolved.push(state.resolvedLocations[name.toLowerCase()]);
      continue;
    }

    const resp = await sendToContent('RESOLVE_LOCATION', { locationName: name });
    if (resp?.ok && resp.data?.id) {
      const loc = { id: resp.data.id, name: resp.data.name };
      state.resolvedLocations[name.toLowerCase()] = loc;
      resolved.push(loc);
      log(`  ${name} -> ID ${loc.id}`, 'success');
    } else {
      log(`  Failed: ${name} - ${resp?.error || 'not found'}`, 'error');
    }
    await sleep(300);
  }
  chrome.storage.local.set({ resolvedLocations: state.resolvedLocations });
  return resolved;
}

// ---- URL Building ----

function buildSearchUrl(keyword, location, headcount, page) {
  const filters = [
    `(type%3ACOMPANY_HEADCOUNT%2Cvalues%3AList((id%3A${headcount}%2CselectionType%3AINCLUDED)))`,
    `(type%3AREGION%2Cvalues%3AList((id%3A${location.id}%2Ctext%3A${encodeURIComponent(location.name)}%2CselectionType%3AINCLUDED)))`,
  ].join('%2C');

  let url = `https://www.linkedin.com/sales/search/company?query=(spellCorrectionEnabled%3Atrue%2Cfilters%3AList(${filters})%2Ckeywords%3A${encodeURIComponent(keyword)})&viewAllFilters=true`;
  if (page && page > 1) url += `&page=${page}`;
  return url;
}

// ---- Navigation ----

async function navigateAndWait(url) {
  await sendBg({ type: 'NAVIGATE', tabId: state.tabId, url });
  await sleep(2000);
  let retries = 10;
  while (retries-- > 0) {
    try {
      const info = await sendToContent('GET_PAGE_INFO');
      if (info?.ok) return;
    } catch {}
    await sleep(1000);
  }
}

// ---- Communication ----

function sendBg(msg) {
  return new Promise(r => chrome.runtime.sendMessage(msg, r));
}

function sendToContent(action, payload = {}) {
  return new Promise(r => chrome.runtime.sendMessage({
    type: 'EXECUTE_CONTENT_SCRIPT', tabId: state.tabId,
    payload: { action, ...payload },
  }, r));
}

// ---- Control ----

function checkStopped() { if (!state.running) throw new Error('STOPPED'); }

function waitIfPaused() {
  return new Promise(resolve => {
    const check = () => {
      if (!state.paused || !state.running) return resolve();
      setTimeout(check, 500);
    };
    check();
  });
}

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
  els.companyCount.textContent = state.results.filter(r => r.contactName).length ? new Set(state.results.map(r => r.companyName)).size : state.results.length;
  els.peopleCount.textContent = state.results.filter(r => r.contactName).length;
}

// ---- UI ----

function log(msg, type = '') {
  const e = document.createElement('div');
  e.className = 'log-entry ' + type;
  e.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  els.log.appendChild(e);
  els.log.parentElement.scrollTop = els.log.parentElement.scrollHeight;
}

function addTableRow(row) {
  const tr = els.resultsTable.insertRow();
  tr.innerHTML = `
    <td title="${esc(row.companyName)}">${esc(row.companyName)}</td>
    <td title="${esc(row.contactName || '-')}">${esc(row.contactName || '-')}</td>
    <td title="${esc(row.contactTitle || '-')}">${esc(row.contactTitle || '-')}</td>
    <td>${esc(row.country || '')}</td>
  `;
  els.tableCount.textContent = state.results.length;
}

// ---- Data ----

function saveData() {
  chrome.storage.local.set({ results: state.results });
}

function loadData() {
  chrome.storage.local.get(['results', 'resolvedLocations'], (data) => {
    state.results = data.results || [];
    state.resolvedLocations = data.resolvedLocations || {};
    els.tableCount.textContent = state.results.length;
    state.results.forEach(r => addTableRow(r));
  });
}

function clearData() {
  if (!confirm('Clear all data?')) return;
  state.results = [];
  els.resultsTable.innerHTML = '';
  els.tableCount.textContent = '0';
  saveData();
  log('Cleared', 'info');
}

// ---- CSV Export ----

function exportCSV() {
  const headers = [
    'Company Name', 'Company LinkedIn URL', 'No. Employees', 'Country', 'Location',
    'Industry', 'Company Website', 'Company Email',
    'Contact Name', 'Contact Title', 'Contact LinkedIn URL', 'Contact Email', 'Contact Phone',
    'Search Keyword', 'Search Location'
  ];
  const rows = state.results.map(r => [
    r.companyName, r.companyLinkedinUrl, r.employees, r.country, r.location,
    r.industry, r.website, r.email,
    r.contactName, r.contactTitle, r.contactLinkedinUrl, r.contactEmail, r.contactPhone,
    r.keyword, r.searchLocation
  ]);

  const escape = v => {
    const s = String(v || '');
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\r\n');

  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `linkedin_extract_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  log('Exported CSV', 'success');
}

// ---- Helpers ----

function parseLines(text) { return text.split('\n').map(s => s.trim()).filter(Boolean); }
function extractCountry(loc) { return loc ? loc.split(',').pop().trim() : ''; }
function cleanIndustry(i) { return i ? i.replace(/\s*\(Industry\)\s*$/i, '').trim() : ''; }
function getDelay() { return (parseInt(els.delay.value) || 3) * 1000; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
