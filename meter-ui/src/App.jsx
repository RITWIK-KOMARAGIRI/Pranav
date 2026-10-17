import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

const GROUPS = [
  { value: 'instantaneous', label: 'Instantaneous' },
  { value: 'cumulative', label: 'Cumulative energy' },
  { value: 'all', label: 'Both' },
]

const NAMES = ['HV1', 'HV2', 'HV3', 'LV1', 'LV2', 'LV3',
  'F11', 'F12', 'F13', 'F21', 'F22', 'F23', 'F31', 'F32', 'F33']
const SLAVES = Array.from({ length: 25 }, (_, i) => i + 1)

const PARAMS = {
  cumulative: {
    title: 'Meter Cumulative Energies',
    list: [[37, 'Active(I) Total Wh'], [41, 'Active(E) Total Wh'], [45, 'Active(I) Fund Wh'], [49, 'Active(E) Fund Wh'],
      [53, 'Reactive(I) Active(I) Varh'], [57, 'Reactive(I) Active(E) Varh'], [61, 'Reactive(E) Active(E) Varh'],
      [65, 'Reactive(E) Active(I) Varh'], [69, 'Apparent(I) VAh'], [73, 'Apparent(E) VAh'],
      [77, 'Abs Active Total Wh'], [81, 'Abs Apparent VAh']],
  },
  instantaneous: {
    title: 'Meter Instantaneous Parameters',
    list: [[85, 'Current L1'], [89, 'Current L2'], [93, 'Current L3'], [97, 'Total Active Power'],
      [101, 'Total Reactive Power'], [105, 'Total Apparent Power'], [109, 'Voltage L1'], [113, 'Voltage L2'],
      [117, 'Voltage L3'], [121, 'Power factor L1'], [125, 'Power factor L2'], [129, 'Power factor L3'],
      [133, 'Average Power factor'], [137, 'Frequency']],
  },
}
const TABLES = [
  { key: 'cumulative', title: PARAMS.cumulative.title },
  { key: 'instantaneous', title: PARAMS.instantaneous.title },
]

async function api(url, options) {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

const newRow = () => ({ id: Date.now() + Math.random(), name: '', slaveId: '' })

/* ---------------- Reader tab ---------------- */
function ReaderTab({ ports, path, setPath, loadPorts }) {
  const [slaveId, setSlaveId] = useState('2')
  const [group, setGroup] = useState('all')
  const [data, setData] = useState({ cumulative: [], instantaneous: [] })
  const [flash, setFlash] = useState({})
  const [changed, setChanged] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const prev = useRef({})
  const reqId = useRef(0)

  const loadTables = useCallback(async (slave, highlight) => {
    const id = ++reqId.current
    const [cumulative, instantaneous] = await Promise.all(
      TABLES.map((t) => api(`/api/meters/${slave}/${t.key}`))
    )
    if (id !== reqId.current) return
    const next = {}, f = {}, c = {}
    for (const [key, rows] of [['cumulative', cumulative], ['instantaneous', instantaneous]]) {
      for (const r of rows) {
        const k = `${key}:${r.start_address}`
        next[k] = { value: r.value, updated_at: r.updated_at }
        const old = prev.current[k]
        if (highlight && old) {
          if (old.updated_at !== r.updated_at) f[k] = true
          if (old.value !== r.value) c[k] = true
        }
      }
    }
    prev.current = next
    setData({ cumulative, instantaneous })
    setFlash(f)
    setChanged(c)
    if (highlight) setTimeout(() => setFlash({}), 2600)
  }, [])

  useEffect(() => {
    const n = Number(slaveId)
    if (!Number.isInteger(n) || n < 1 || n > 247) return
    prev.current = {}
    setChanged({})
    loadTables(n, false).catch((e) => setMsg({ type: 'error', text: e.message }))
  }, [slaveId, loadTables])

  async function send() {
    const n = Number(slaveId)
    setBusy(true)
    setMsg(null)
    try {
      const out = await api('/api/meters/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, slaveId: n, group }),
      })
      await loadTables(n, true)
      const errors = Object.entries(out.results)
        .filter(([, v]) => !Array.isArray(v))
        .map(([k, v]) => `${k}: ${v.status} - ${v.error}`)
      if (errors.length) setMsg({ type: 'error', text: errors.join(' | ') })
      else setMsg({ type: 'ok', text: `Slave ${n} updated at ${new Date().toLocaleTimeString()}` })
    } catch (e) {
      setMsg({ type: 'error', text: e.message })
    } finally {
      setBusy(false)
    }
  }

  const slaveOk = Number.isInteger(Number(slaveId)) && Number(slaveId) >= 1 && Number(slaveId) <= 247

  return (
    <>
      <div className="bar">
        <PortSelect ports={ports} path={path} setPath={setPath} loadPorts={loadPorts} />
        <label className="field">
          Slave ID
          <input type="number" min="1" max="247" value={slaveId} onChange={(e) => setSlaveId(e.target.value)} />
        </label>
        <label className="field">
          Group
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            {GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </label>
        <button onClick={send} disabled={busy || !path || !slaveOk}>{busy ? 'Reading...' : 'Send'}</button>
      </div>

      {msg && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      {TABLES.map((t) => (
        <div className="card" key={t.key}>
          <h2>{t.title} <span>Slave {slaveId}</span></h2>
          {data[t.key].length === 0 ? (
            <div className="empty">No data stored for this slave yet. Press Send.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Start address</th><th>Parameter</th><th className="num">Value</th><th>Updated at</th></tr>
              </thead>
              <tbody>
                {data[t.key].map((r) => {
                  const k = `${t.key}:${r.start_address}`
                  return (
                    <tr key={k} className={flash[k] ? 'flash' : ''}>
                      <td>{r.start_address}</td>
                      <td>{r.parameter}</td>
                      <td className={`num ${changed[k] ? 'changed' : ''}`}>{r.value ?? '-'}</td>
                      <td>{r.updated_at ? new Date(r.updated_at).toLocaleString() : '-'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </>
  )
}

function PortSelect({ ports, path, setPath, loadPorts }) {
  return (
    <>
      <label className="field">
        COM port
        <select value={path} onChange={(e) => setPath(e.target.value)}>
          {ports.length === 0 && <option value="">No ports found</option>}
          {ports.map((p) => (
            <option key={p.path} value={p.path}>{p.path} - {p.name || p.manufacturer || ''}</option>
          ))}
        </select>
      </label>
      <button className="ghost" onClick={loadPorts} title="Refresh ports">Refresh</button>
    </>
  )
}

/* ---------------- Settings tab ---------------- */
function SettingsTab({ rows, setRows }) {
  const update = (id, patch) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const addAfter = (id) => {
    const i = rows.findIndex((r) => r.id === id)
    const copy = [...rows]
    copy.splice(i + 1, 0, newRow())
    setRows(copy)
  }
  const remove = (id) => setRows(rows.length > 1 ? rows.filter((r) => r.id !== id) : [newRow()])

  const usedNames = rows.map((r) => r.name).filter(Boolean)
  const usedSlaves = rows.map((r) => r.slaveId).filter(Boolean)
  const dupSlave = (v) => v && usedSlaves.filter((s) => s === v).length > 1

  return (
    <div className="card">
      <h2>Meter settings <span>Saved automatically in this browser</span></h2>
      <table>
        <thead>
          <tr><th>Name</th><th>Slave ID</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <select className="cell" value={r.name} onChange={(e) => update(r.id, { name: e.target.value })}>
                  <option value="">Select name</option>
                  {NAMES.map((n) => (
                    <option key={n} value={n} disabled={usedNames.includes(n) && r.name !== n}>{n}</option>
                  ))}
                </select>
              </td>
              <td>
                <select className="cell" value={r.slaveId} onChange={(e) => update(r.id, { slaveId: e.target.value })}>
                  <option value="">Select slave ID</option>
                  {SLAVES.map((s) => <option key={s} value={String(s)}>{s}</option>)}
                </select>
                {dupSlave(r.slaveId) && <span className="warn"> already used</span>}
              </td>
              <td className="actions">
                <button onClick={() => addAfter(r.id)}>Add</button>
                <button className="danger" onClick={() => remove(r.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------------- Compare tab ---------------- */
function CompareTab({ rows, ports, path, setPath, loadPorts }) {
  const meters = rows.filter((r) => r.name && r.slaveId)
  const key = meters.map((m) => `${m.name}:${m.slaveId}`).join(',')
  const [values, setValues] = useState({}) // group -> slaveId -> { addr: value }
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  // start empty whenever the meter list changes
  useEffect(() => {
    setValues({})
    setMsg(null)
  }, [key])

  async function send() {
    setBusy(true)
    setMsg(null)
    setValues({})
    const errors = []
    const out = { cumulative: {}, instantaneous: {} }
    const slaves = [...new Set(meters.map((m) => m.slaveId))]
    for (const s of slaves) {
      try {
        const res = await api('/api/meters/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, slaveId: Number(s), group: 'all' }),
        })
        for (const g of Object.keys(PARAMS)) {
          const r = res.results[g]
          if (Array.isArray(r)) {
            out[g][s] = {}
            for (const row of r) out[g][s][row.address] = row.value
          } else if (r) {
            errors.push(`Slave ${s} ${g}: ${r.status} - ${r.error}`)
          }
        }
      } catch (e) {
        errors.push(`Slave ${s}: ${e.message}`)
      }
      setValues({ cumulative: { ...out.cumulative }, instantaneous: { ...out.instantaneous } })
    }
    setMsg(errors.length
      ? { type: 'error', text: errors.join(' | ') }
      : { type: 'ok', text: `All meters updated at ${new Date().toLocaleTimeString()}` })
    setBusy(false)
  }

  if (meters.length === 0) {
    return <div className="msg error">Add at least one meter (name and slave ID) in the Settings tab.</div>
  }

  return (
    <>
      <div className="bar">
        <PortSelect ports={ports} path={path} setPath={setPath} loadPorts={loadPorts} />
        <button onClick={send} disabled={busy || !path}>{busy ? 'Reading...' : 'Send'}</button>
      </div>
      {msg && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      {Object.entries(PARAMS).map(([g, def]) => (
        <div className="card" key={g}>
          <h2>{def.title}</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Parameter</th>
                  {meters.map((m) => (
                    <th key={m.id} className="num">{m.name}<br /><small>Slave {m.slaveId}</small></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {def.list.map(([addr, name]) => (
                  <tr key={addr}>
                    <td>{name}</td>
                    {meters.map((m) => (
                      <td key={m.id} className="num">{values[g]?.[m.slaveId]?.[addr] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  )
}

/* ---------------- App ---------------- */
export default function App() {
  const [tab, setTab] = useState('settings')
  const [ports, setPorts] = useState([])
  const [path, setPath] = useState('')
  const [rows, setRows] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('meterSettings'))
      if (Array.isArray(saved) && saved.length) return saved
    } catch { /* ignore */ }
    return [newRow()]
  })

  useEffect(() => {
    try { localStorage.setItem('meterSettings', JSON.stringify(rows)) } catch { /* ignore */ }
  }, [rows])

  const loadPorts = useCallback(async () => {
    try {
      const list = await api('/api/ports')
      setPorts(list)
      setPath((cur) => (list.some((p) => p.path === cur) ? cur : list[0]?.path || ''))
    } catch { /* ignore */ }
  }, [])
  useEffect(() => { loadPorts() }, [loadPorts])

  return (
    <div className="page">
      <div className="header">
  <img src="/logo.png" alt="Sri Parandhama Technologies" className="logo" />
  <h1>Modbus Meter Reader</h1>
</div>
      <div className="tabs">
        {[['settings', 'Settings'], ['compare', 'All meters']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {/*{tab === 'reader' && <ReaderTab ports={ports} path={path} setPath={setPath} loadPorts={loadPorts} />}*/}
      {tab === 'settings' && <SettingsTab rows={rows} setRows={setRows} />}
      {tab === 'compare' && <CompareTab rows={rows} ports={ports} path={path} setPath={setPath} loadPorts={loadPorts} />}
    </div>
  )
}