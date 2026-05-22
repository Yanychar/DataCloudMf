const state = {
  currentSection: 'overview',
  latestReportExecutionId: null,
  selectedReportExecutionId: null,
};

const sectionTitles = {
  overview: 'Overview',
  clients: 'Client Explorer',
  reports: 'Client Report Lab',
};

document.addEventListener('DOMContentLoaded', () => {
  wireNavigation();
  wireForms();
  wireRefresh();
  initializeDashboard().catch(showError);
});

function wireNavigation() {
  const navLinks = document.querySelectorAll('.nav-link[data-section]');
  navLinks.forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.section;
      if (!target) return;

      state.currentSection = target;
      navLinks.forEach((item) => item.classList.toggle('active', item === button));

      document.querySelectorAll('.page-section').forEach((section) => {
        section.classList.toggle('active', section.id === `section-${target}`);
      });

      document.getElementById('page-title').textContent = sectionTitles[target];
    });
  });
}

function wireForms() {
  document.getElementById('client-filter-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await loadClients();
  });

  document.getElementById('client-filter-reset').addEventListener('click', () => {
    document.getElementById('client-filter-form').reset();
    document.querySelector('#client-filter-form [name="limit"]').value = 100;
  });

  document.getElementById('report-preview-button').addEventListener('click', async () => {
    await previewReportInput();
  });

  document.getElementById('report-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await runClientReport();
  });
}

function wireRefresh() {
  document.getElementById('refresh-all-button').addEventListener('click', async () => {
    await initializeDashboard();
  });

  document.getElementById('run-client-sync-button').addEventListener('click', async () => {
    await runClientSync();
  });
}

async function initializeDashboard() {
  clearStatus();
  await Promise.all([loadOverview(), loadClients(), loadClientMetadata(), loadReportExecutions()]);
}

async function runClientSync() {
  clearStatus();
  const button = document.getElementById('run-client-sync-button');
  button.disabled = true;
  button.textContent = 'Running Sync...';

  try {
    const result = await apiPost('/ingestion/sync/client', {});
    showSuccess(
      `Client sync finished. fetched=${result.fetchedCount}, upserted=${result.upsertedCount}, lastSuccessfulSyncAt=${result.lastSuccessfulSyncAt ?? 'n/a'}`,
    );
    await initializeDashboard();
  } finally {
    button.disabled = false;
    button.textContent = 'Run Client Sync';
  }
}

async function loadOverview() {
  const [syncOverview, clientCount] = await Promise.all([
    apiGet('/admin/clients/sync-overview'),
    apiGet('/admin/clients/count'),
  ]);

  const latestRun = syncOverview.latestRuns?.[0] ?? null;
  document.getElementById('overview-last-successful').textContent =
    formatDateTime(syncOverview.syncState?.lastSuccessfulSyncAt) ?? 'n/a';
  document.getElementById('overview-last-run-status').innerHTML = renderStatusPill(latestRun?.status);
  document.getElementById('overview-client-count').textContent = String(clientCount);

  renderSyncOverview(syncOverview);
  renderSyncRuns(syncOverview.latestRuns ?? []);
}

async function loadClientMetadata() {
  const metadata = await apiGet('/admin/clients/metadata');
  renderClientMetadata(metadata.importedFields ?? []);
}

async function loadClients() {
  clearStatus();
  const formData = new FormData(document.getElementById('client-filter-form'));
  const params = new URLSearchParams();

  for (const [key, value] of formData.entries()) {
    if (String(value).trim()) {
      params.set(key, String(value).trim());
    }
  }

  const query = params.toString();
  const [clients, count] = await Promise.all([
    apiGet(query ? `/admin/clients?${query}` : '/admin/clients'),
    apiGet(query ? `/admin/clients/count?${query}` : '/admin/clients/count'),
  ]);

  document.getElementById('client-count-result').textContent = String(count);
  document.getElementById('client-loaded-rows').textContent = String(clients.length);
  renderClientTable(clients);
}

async function previewReportInput() {
  clearStatus();
  const payload = buildReportPayload();
  const preview = await apiPost('/admin/reports/client/preview', {
    filters: payload.filters,
  });

  renderReportPreview(preview);
}

async function runClientReport() {
  clearStatus();
  const payload = buildReportPayload();
  const execution = await apiPost('/admin/reports/client/run', payload);
  state.latestReportExecutionId = execution.executionId;
  state.selectedReportExecutionId = execution.executionId;

  renderReportResult(execution);
  await loadReportExecutions();
  showSuccess(`Report execution ${execution.executionId} completed with status ${execution.status}.`);
}

async function loadReportExecutions() {
  const executions = await apiGet('/admin/reports/client/executions');
  renderReportHistory(executions);

  const selectedId = state.selectedReportExecutionId ?? state.latestReportExecutionId ?? executions[0]?.id;
  if (selectedId) {
    await loadReportExecutionDetails(selectedId);
  } else {
    document.getElementById('report-result-content').innerHTML =
      '<div class="empty-state">No report execution selected yet.</div>';
  }
}

async function loadReportExecutionDetails(id) {
  const execution = await apiGet(`/admin/reports/client/executions/${encodeURIComponent(id)}`);
  if (!execution) {
    return;
  }

  state.selectedReportExecutionId = execution.id;
  renderStoredExecution(execution);
}

function buildReportPayload() {
  const formData = new FormData(document.getElementById('report-form'));
  const prompt = String(formData.get('prompt') ?? '').trim();
  const limit = Number(formData.get('limit') ?? 200);

  return {
    prompt,
    filters: {
      birthDateFrom: getOptionalString(formData.get('birthDateFrom')),
      birthDateTo: getOptionalString(formData.get('birthDateTo')),
      ageFrom: getOptionalNumber(formData.get('ageFrom')),
      ageTo: getOptionalNumber(formData.get('ageTo')),
      gender: getOptionalString(formData.get('gender')),
      clientType: getOptionalString(formData.get('clientType')),
      city: getOptionalString(formData.get('city')),
      search: getOptionalString(formData.get('search')),
    },
    options: {
      limit: Number.isFinite(limit) ? limit : 200,
      includeRawRows: formData.get('includeRawRows') === 'on',
    },
  };
}

function renderSyncOverview(syncOverview) {
  const container = document.getElementById('sync-overview-content');
  const syncState = syncOverview.syncState;
  const latestRun = syncOverview.latestRuns?.[0] ?? null;
  const syncContext = latestRun?.syncContext ? JSON.stringify(latestRun.syncContext, null, 2) : null;

  container.innerHTML = `
    <div class="detail-card">
      <h4>EntitySyncState</h4>
      <div class="detail-stack">
        <div><strong>entityKey:</strong> ${escapeHtml(syncOverview.entityKey)}</div>
        <div><strong>lastRunStartedAt:</strong> ${formatDateTime(syncState?.lastRunStartedAt) ?? 'n/a'}</div>
        <div><strong>lastRunCompletedAt:</strong> ${formatDateTime(syncState?.lastRunCompletedAt) ?? 'n/a'}</div>
        <div><strong>lastSuccessfulSyncAt:</strong> ${formatDateTime(syncState?.lastSuccessfulSyncAt) ?? 'n/a'}</div>
        <div><strong>lastSyncMode:</strong> ${escapeHtml(syncState?.lastSyncMode ?? 'n/a')}</div>
      </div>
    </div>
    <div class="sync-context-grid">
      <div class="detail-card">
        <h4>Latest Run Snapshot</h4>
        <div class="detail-stack">
          <div><strong>Status:</strong> ${renderStatusPill(latestRun?.status)}</div>
          <div><strong>Started:</strong> ${formatDateTime(latestRun?.startedAt) ?? 'n/a'}</div>
          <div><strong>Finished:</strong> ${formatDateTime(latestRun?.finishedAt) ?? 'n/a'}</div>
          <div><strong>Fetched / Upserted:</strong> ${latestRun ? `${latestRun.fetchedCount} / ${latestRun.upsertedCount}` : 'n/a'}</div>
        </div>
      </div>
      <div class="detail-card">
        <h4>Latest syncContext</h4>
        ${syncContext ? `<div class="code-block">${escapeHtml(syncContext)}</div>` : '<div class="muted">No syncContext stored yet.</div>'}
      </div>
    </div>
  `;
}

function renderSyncRuns(syncRuns) {
  const container = document.getElementById('sync-runs-content');
  if (!syncRuns.length) {
    container.innerHTML = '<div class="empty-state">No SyncRun records found yet.</div>';
    return;
  }

  const rows = syncRuns
    .map(
      (run) => `
        <tr>
          <td>${renderStatusPill(run.status)}</td>
          <td>${escapeHtml(run.mode)}</td>
          <td>${run.fetchedCount}</td>
          <td>${run.upsertedCount}</td>
          <td>${formatDateTime(run.startedAt) ?? 'n/a'}</td>
          <td>${formatDateTime(run.finishedAt) ?? 'n/a'}</td>
        </tr>
      `,
    )
    .join('');

  container.innerHTML = `
    <div class="table-wrapper compact">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Mode</th>
            <th>Fetched</th>
            <th>Upserted</th>
            <th>Started</th>
            <th>Finished</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderClientTable(clients) {
  const container = document.getElementById('client-table-content');

  if (!clients.length) {
    container.innerHTML = '<div class="empty-state">No client rows matched the current filters.</div>';
    return;
  }

  const rows = clients
    .map(
      (client) => `
        <tr>
          <td>${escapeHtml(client.client)}</td>
          <td>${escapeHtml(client.birthDate ?? '')}</td>
          <td>${escapeHtml(client.age ?? '')}</td>
          <td>${escapeHtml(client.clientType ?? '')}</td>
          <td>${escapeHtml(client.gender ?? '')}</td>
          <td>${escapeHtml(client.city ?? '')}</td>
          <td>${escapeHtml(client.countryId ?? '')}</td>
          <td>${escapeHtml(client.latestSaveDate ?? '')}</td>
        </tr>
      `,
    )
    .join('');

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Client</th>
          <th>Birth Date</th>
          <th>Age</th>
          <th>Client Type</th>
          <th>Gender</th>
          <th>City</th>
          <th>Country</th>
          <th>Latest Save Date</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderClientMetadata(importedFields) {
  const container = document.getElementById('client-metadata-content');

  if (!importedFields.length) {
    container.innerHTML = '<div class="empty-state">No imported field metadata configured for Client.</div>';
    return;
  }

  const rows = importedFields
    .map(
      (field) => `
        <tr>
          <td>${escapeHtml(field.key)}</td>
          <td>${escapeHtml(field.dataType ?? '')}</td>
          <td>${field.filterable ? 'yes' : 'no'}</td>
          <td>${field.includeInAiContext ? 'yes' : 'no'}</td>
          <td>${escapeHtml(field.description)}</td>
        </tr>
      `,
    )
    .join('');

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Filterable</th>
          <th>AI Context</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderReportPreview(preview) {
  const container = document.getElementById('report-preview-summary');
  container.innerHTML = `
    <div class="detail-card">
      <h4>Input Preview</h4>
      <div class="detail-stack">
        <div><strong>Entity:</strong> ${escapeHtml(preview.entityKey)}</div>
        <div><strong>Matching rows:</strong> ${preview.rowCount}</div>
        <div><strong>AI configured:</strong> ${preview.aiConfigured ? 'yes' : 'no'}</div>
        <div><strong>Model:</strong> ${escapeHtml(preview.model ?? 'n/a')}</div>
        <div><strong>Filters:</strong></div>
        <div class="code-block">${escapeHtml(JSON.stringify(preview.filters, null, 2))}</div>
        <div><strong>Imported field metadata:</strong></div>
        <div class="code-block">${escapeHtml(JSON.stringify(preview.metadata?.importedFields ?? [], null, 2))}</div>
      </div>
    </div>
  `;
}

function renderReportResult(execution) {
  const container = document.getElementById('report-result-content');
  const result = execution.result ?? {};

  const sections = (result.sections ?? [])
    .map((section) => renderReportSection(section))
    .join('');

  container.innerHTML = `
    <div class="detail-card">
      <h4>Execution Summary</h4>
      <div class="detail-stack">
        <div><strong>Execution ID:</strong> ${escapeHtml(execution.executionId)}</div>
        <div><strong>Status:</strong> ${renderStatusPill(execution.status)}</div>
        <div><strong>Input rows:</strong> ${execution.inputRowCount}</div>
        <div><strong>Generator:</strong> ${escapeHtml(result.generator ?? 'unknown')}</div>
        <div>${escapeHtml(result.summary ?? '')}</div>
      </div>
    </div>
    ${sections}
    <div class="result-card">
      <h4>Raw Result JSON</h4>
      <div class="code-block">${escapeHtml(JSON.stringify(result, null, 2))}</div>
    </div>
  `;
}

function renderStoredExecution(execution) {
  renderReportResult({
    executionId: execution.id,
    status: execution.status,
    inputRowCount: execution.inputRowCount,
    result: execution.result ?? {},
  });
}

function renderReportSection(section) {
  if (section.type === 'metric_list') {
    const items = (section.items ?? [])
      .map((item) => `<li><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(String(item.value))}</li>`)
      .join('');

    return `
      <div class="result-card">
        <h4>${escapeHtml(section.title)}</h4>
        <ul class="metric-list">${items}</ul>
      </div>
    `;
  }

  if (section.type === 'table') {
    const headers = (section.columns ?? [])
      .map((column) => `<th>${escapeHtml(column)}</th>`)
      .join('');
    const rows = (section.rows ?? [])
      .map(
        (row) => `<tr>${row.map((value) => `<td>${escapeHtml(String(value ?? ''))}</td>`).join('')}</tr>`,
      )
      .join('');

    return `
      <div class="result-card">
        <h4>${escapeHtml(section.title)}</h4>
        <div class="table-wrapper">
          <table>
            <thead><tr>${headers}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  return `
    <div class="result-card">
      <h4>${escapeHtml(section.title ?? 'Section')}</h4>
      <div class="code-block">${escapeHtml(JSON.stringify(section, null, 2))}</div>
    </div>
  `;
}

function renderReportHistory(executions) {
  const container = document.getElementById('report-history-content');
  if (!executions.length) {
    container.innerHTML = '<div class="empty-state">No report executions yet.</div>';
    return;
  }

  const rows = executions
    .map(
      (execution) => `
        <tr class="history-row ${execution.id === state.selectedReportExecutionId ? 'is-selected' : ''}" data-execution-id="${escapeHtml(execution.id)}">
          <td>${escapeHtml(execution.id)}</td>
          <td>${renderStatusPill(execution.status)}</td>
          <td>${escapeHtml(execution.mode)}</td>
          <td>${execution.inputRowCount}</td>
          <td>${escapeHtml((execution.prompt ?? '').slice(0, 90))}</td>
          <td>${formatDateTime(execution.createdAt) ?? 'n/a'}</td>
        </tr>
      `,
    )
    .join('');

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Status</th>
          <th>Mode</th>
          <th>Input Rows</th>
          <th>Prompt</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  container.querySelectorAll('.history-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const id = row.dataset.executionId;
      if (!id) return;

      clearStatus();
      await loadReportExecutionDetails(id);
      renderReportHistory(executions);
    });
  });
}

async function apiGet(url) {
  const response = await fetch(url);
  return handleResponse(response);
}

async function apiPost(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return handleResponse(response);
}

async function handleResponse(response) {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.message ?? `Request failed with status ${response.status}`);
  }

  return payload;
}

function showError(error) {
  const banner = document.getElementById('status-banner');
  banner.textContent = error instanceof Error ? error.message : String(error);
  banner.classList.remove('hidden');
  banner.dataset.variant = 'error';
}

function showSuccess(message) {
  const banner = document.getElementById('status-banner');
  banner.textContent = message;
  banner.classList.remove('hidden');
  banner.dataset.variant = 'success';
}

function clearStatus() {
  const banner = document.getElementById('status-banner');
  banner.textContent = '';
  banner.classList.add('hidden');
  delete banner.dataset.variant;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getOptionalString(value) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : undefined;
}

function getOptionalNumber(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleString('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function renderStatusPill(status) {
  if (!status) {
    return '<span class="pill">n/a</span>';
  }

  const normalized = String(status).toLowerCase();
  const tone = ['success', 'failed', 'running'].includes(normalized) ? normalized : '';
  return `<span class="pill ${tone}">${escapeHtml(String(status))}</span>`;
}
