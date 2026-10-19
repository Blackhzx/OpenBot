//\\ sessão em SQLite //\\
const fs = require('fs')
const bridge = require('./bridge')

// esconde o aviso experimental do node:sqlite
const emit = process.emitWarning
process.emitWarning = (w, ...a) => String(w).includes('SQLite') || emit.call(process, w, ...a)
const { DatabaseSync } = require('node:sqlite')

module.exports = (file) => {
  const { BufferJSON, initAuthCreds, proto } = bridge.get()
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS auth (id TEXT PRIMARY KEY, data TEXT)')

  const sel = db.prepare('SELECT data FROM auth WHERE id = ?')
  const ins = db.prepare('INSERT OR REPLACE INTO auth VALUES (?, ?)')
  const del = db.prepare('DELETE FROM auth WHERE id = ?')
  const read = id => { const r = sel.get(id); return r ? JSON.parse(r.data, BufferJSON.reviver) : null }
  const write = (id, v) => ins.run(id, JSON.stringify(v, BufferJSON.replacer))

  const creds = read('creds') || initAuthCreds()

  const keys = {
    get: async (type, ids) => Object.fromEntries(ids.map(id => {
      let v = read(`${type}-${id}`)
      if (v && type === 'app-state-sync-key') v = proto.Message.AppStateSyncKeyData.fromObject(v)
      return [id, v]
    })),
    // tudo numa transação
    set: async (data) => {
      db.exec('BEGIN')
      try {
        for (const type in data)
          for (const id in data[type]) data[type][id] ? write(`${type}-${id}`, data[type][id]) : del.run(`${type}-${id}`)
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
    }
  }

  const apagar = () => {
    try { db.close() } catch {}
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true })
  }

  return { state: { creds, keys }, saveCreds: async () => write('creds', creds), apagar, close: () => db.close() }
}
