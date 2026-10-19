const fs = require('fs')
const NodeCache = require('node-cache')
const config = require('../config.json')

//\\ banco //\\
const file = './database/db.json'
fs.mkdirSync('./database', { recursive: true })
const db = { idioma: config.idioma, botoes: config.botoes, prefixo: config.prefixo }
try { Object.assign(db, JSON.parse(fs.readFileSync(file))) } catch {}
const save = () => fs.writeFile(file, JSON.stringify(db, null, 2), () => {})

//\\ idiomas //\\
const langs = Object.fromEntries(fs.readdirSync('./lang').map(f => [f.replace('.json', ''), require(`../lang/${f}`)]))
const t = (k, v = {}) => (langs[db.idioma]?.[k] ?? langs.pt[k] ?? k).replace(/{(\w+)}/g, (a, x) => v[x] ?? a)

//\\ similaridade //\\
const dist = (a, b) => {
  const d = Array.from({ length: b.length + 1 }, (_, i) => [i])
  for (let j = 1; j <= a.length; j++) d[0][j] = j
  for (let i = 1; i <= b.length; i++)
    for (let j = 1; j <= a.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[j - 1] !== b[i - 1]))
  return d[b.length][a.length]
}
const similar = (txt, list) => list
  .map(n => ({ n, p: Math.round((1 - dist(txt, n) / Math.max(txt.length, n.length)) * 100) }))
  .sort((a, b) => b.p - a.p)[0] || { n: '', p: 0 }

//\\ grupos //\\
const groupCache = new NodeCache({ stdTTL: 300, useClones: false })
const groupMeta = async (god, id) => groupCache.get(id) || god.groupMetadata(id).then(g => (groupCache.set(id, g), g))

const num = (jid = '') => jid.split('@')[0].split(':')[0]

module.exports = { db, save, t, langs, similar, groupCache, groupMeta, num }
