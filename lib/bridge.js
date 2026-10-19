// baileys ESM -> CommonJS
let mod, p
const load = () => p ||= import('@systemzero/baileys').then(m => (mod = m))
const get = () => mod || (() => { throw new Error('chame load() antes de get()') })()

module.exports = { load, get }
