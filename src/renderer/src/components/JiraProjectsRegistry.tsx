import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { jiraProjectsClient, type JiraProjectBinding } from '@/jiraProjects/jiraProjectsClient';
import { integrationsClient } from '@/integrations/registryClient';
import { authTypeNeedsSecret as needsSecret } from '@shared/integrations';
import { PixelButton } from './PixelButton';

// Jira project bindings — Settings → Connections, mounted right below
// IntegrationsRegistry (the natural continuation: that panel says HOW to talk
// to Jira, this one says WHICH projects/repos/agents it applies to).
// Structurally mirrors IntegrationsRegistry.tsx: a list view + a configure
// view, one `err` message per draft (not per-field), a `Test` action per row.

type View = 'list' | 'configure';

interface Draft {
  isNew: boolean;
  key: string;
  repo: string;
  baseBranch: string;
  agentsCsv: string; // comma-separated agent ids, parsed to string[] on save
  enabled: boolean;
}

interface TestResult { ok: boolean; error?: string }

function draftFromBinding(b: JiraProjectBinding): Draft {
  return {
    isNew: false, key: b.key, repo: b.repo, baseBranch: b.baseBranch,
    agentsCsv: (b.agents ?? []).join(', '), enabled: b.enabled
  };
}
function emptyDraft(): Draft {
  return { isNew: true, key: '', repo: '', baseBranch: '', agentsCsv: '', enabled: true };
}
function bindingFromDraft(d: Draft): JiraProjectBinding {
  const agents = d.agentsCsv.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    key: d.key.trim().toUpperCase(),
    repo: d.repo.trim(),
    baseBranch: d.baseBranch.trim(),
    agents: agents.length > 0 ? agents : undefined,
    enabled: d.enabled
  };
}

const dispLabel: CSSProperties = { fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-500)', textTransform: 'uppercase' };
const fieldLabel: CSSProperties = { ...dispLabel, color: 'var(--cth-ink-700)' };
const subText: CSSProperties = { fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' };
const hint: CSSProperties = { fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' };
const inputStyle: CSSProperties = { width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, lineHeight: '18px', color: 'var(--cth-ink-900)' };

export function JiraProjectsRegistry() {
  const { t: tr } = useTranslation();
  const [bindings, setBindings] = useState<JiraProjectBinding[]>([]);
  const [jiraUsable, setJiraUsable] = useState(false);
  const [view, setView] = useState<View>('list');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [rowTest, setRowTest] = useState<Record<string, TestResult>>({});
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [pollMinutes, setPollMinutes] = useState(5);

  const refresh = async () => setBindings(await jiraProjectsClient.list());

  useEffect(() => {
    let alive = true;
    (async () => {
      const [bs, ints, cfg] = await Promise.all([
        jiraProjectsClient.list(), integrationsClient.list(), window.cth.getConfig()
      ]);
      if (!alive) return;
      setBindings(bs);
      const jira = ints.find((r) => r.id === 'jira');
      setJiraUsable(!!jira?.enabled && (!needsSecret(jira.authType) || jira.hasSecret));
      setPollMinutes(Math.round((cfg.jiraPoll?.pollIntervalMs ?? 300000) / 60000));
    })();
    return () => { alive = false; };
  }, []);

  const goList = () => { setView('list'); setDraft(null); setErr(''); };
  const startAdd = () => { setDraft(emptyDraft()); setErr(''); setView('configure'); };
  const startEdit = (b: JiraProjectBinding) => { setDraft(draftFromBinding(b)); setErr(''); setView('configure'); };
  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const onSave = async () => {
    if (!draft) return;
    setBusy(true); setErr('');
    try {
      const res = await jiraProjectsClient.save(bindingFromDraft(draft));
      if (!res.ok) { setErr(res.error || tr('jiraProjects.couldNotSave')); return; }
      await refresh();
      goList();
    } catch {
      setErr(tr('jiraProjects.couldNotSave'));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (key: string) => {
    await jiraProjectsClient.remove(key);
    await refresh();
  };

  const onTestRow = async (b: JiraProjectBinding) => {
    setTestingKey(b.key);
    try {
      const res = await jiraProjectsClient.validate(b);
      setRowTest((m) => ({ ...m, [b.key]: res.ok ? { ok: true } : { ok: false, error: res.error } }));
    } finally {
      setTestingKey(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={dispLabel}>{tr('jiraProjects.title')}</span>
        <span style={subText}>{tr('jiraProjects.desc')}</span>
      </div>

      {!jiraUsable && (
        <div style={{ padding: 8, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-500)' }}>
          {tr('jiraProjects.needsIntegration')}
        </div>
      )}

      {view === 'list' && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {bindings.length === 0 && <span style={subText}>{tr('jiraProjects.noProjects')}</span>}
            {bindings.map((b) => {
              const test = rowTest[b.key];
              return (
                <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 2 }}>
                    <span style={{ fontSize: 13, color: 'var(--cth-ink-900)' }}>{b.key} {!b.enabled && `(${tr('jiraProjects.enabled')}: off)`}</span>
                    <span style={hint}>{b.repo} → {b.baseBranch}</span>
                  </div>
                  {test && (
                    <span style={{ fontSize: 12, color: test.ok ? 'var(--cth-mint-700, #1f7a4d)' : 'var(--cth-danger, #6E1423)' }}>
                      {test.ok ? tr('jiraProjects.testOk') : `${tr('jiraProjects.testFailed')} ${test.error ?? ''}`}
                    </span>
                  )}
                  <PixelButton variant="secondary" size="sm" onClick={() => void onTestRow(b)} disabled={testingKey === b.key}>
                    {testingKey === b.key ? tr('jiraProjects.testing') : tr('jiraProjects.test')}
                  </PixelButton>
                  <PixelButton variant="secondary" size="sm" onClick={() => startEdit(b)}>{tr('jiraProjects.saveChanges')}</PixelButton>
                  <PixelButton variant="secondary" size="sm" onClick={() => void onRemove(b.key)}>×</PixelButton>
                </div>
              );
            })}
          </div>
          <PixelButton variant="secondary" size="sm" onClick={startAdd}>{tr('jiraProjects.addProject')}</PixelButton>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            <span style={fieldLabel}>{tr('jiraProjects.pollSettings')}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={subText}>{tr('jiraProjects.pollInterval')}</span>
              <input
                type="number" min={1} value={pollMinutes}
                onChange={(e) => setPollMinutes(Math.max(1, Number(e.target.value) || 1))}
                onBlur={() => { void window.cth.updateConfig({ jiraPoll: { pollIntervalMs: pollMinutes * 60000, assigneeFilter: 'currentUser', statusFilter: 'To Do' } }); }}
                style={{ ...inputStyle, width: 64 }}
              />
            </div>
            <span style={hint}>{tr('jiraProjects.claimFilterFixed')}</span>
          </div>
        </>
      )}

      {view === 'configure' && draft && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button type="button" onClick={goList} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start', fontSize: 12, color: 'var(--cth-ink-500)' }}>
            {tr('jiraProjects.backToList')}
          </button>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>{tr('jiraProjects.key')}</span>
            <input
              value={draft.key} disabled={!draft.isNew}
              onChange={(e) => patch({ key: e.target.value.toUpperCase() })}
              style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
            />
            <span style={hint}>{tr('jiraProjects.keyHint')}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>{tr('jiraProjects.repo')}</span>
            <input value={draft.repo} onChange={(e) => patch({ repo: e.target.value })} style={inputStyle} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>{tr('jiraProjects.baseBranch')}</span>
            <input value={draft.baseBranch} onChange={(e) => patch({ baseBranch: e.target.value })} style={inputStyle} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>{tr('jiraProjects.agents')}</span>
            <input value={draft.agentsCsv} onChange={(e) => patch({ agentsCsv: e.target.value })} style={inputStyle} />
            <span style={hint}>{tr('jiraProjects.agentsHint')}</span>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--cth-ink-700)' }}>
            <input type="checkbox" checked={draft.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
            {tr('jiraProjects.enabled')}
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            {err && <span style={{ marginRight: 'auto', fontSize: 12, color: 'var(--cth-danger, #6E1423)' }}>{err}</span>}
            <PixelButton variant="primary" size="sm" onClick={() => { void onSave(); }} disabled={busy}>
              {busy ? '…' : draft.isNew ? tr('jiraProjects.saveProject') : tr('jiraProjects.saveChanges')}
            </PixelButton>
          </div>
        </div>
      )}
    </div>
  );
}
