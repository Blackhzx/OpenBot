//\\ System Zone API //\\
const config = require('../config.json')

const url = (path, query = {}) => {
  const u = new URL(path, config.zone.url)
  for (const [k, v] of Object.entries({ ...query, apikey: config.zone.apikey })) u.searchParams.set(k, v)
  return u
}

const mime = b => b[0] === 0x89 && b[1] === 0x50 ? ['image/png', 'image.png'] : b.slice(8, 12).toString() === 'WEBP' ? ['image/webp', 'image.webp'] : ['image/jpeg', 'image.jpg']

// GET
const get = async (path, query) => {
  const r = await fetch(url(path, query), { signal: AbortSignal.timeout(120000) })
  return r.json().catch(() => ({ status: false, code: r.status }))
}

// stream (eventos "data: {...}")
const sse = async (path, query) => {
  const r = await fetch(url(path, query), { signal: AbortSignal.timeout(120000) })
  return (await r.text()).split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)) } catch {} }).filter(Boolean)
}

// POST com arquivo
const post = async (path, buf, extra = {}) => {
  const [type, name] = mime(buf)
  const form = new FormData()
  form.append('image', new Blob([buf], { type }), name)
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  const r = await fetch(url(path), { method: 'POST', body: form, headers: { apikey: config.zone.apikey }, signal: AbortSignal.timeout(120000) })
  return r.json().catch(() => ({ status: false, code: r.status }))
}

const zone = {
  get,
  post,
  sse,
  key: () => !!config.zone.apikey,

  // ferramentas
  toMp4: buf => post('api/ferramentas/tomp4', buf),
  removeBg: buf => post('api/removebg', buf),
  ocr: (buf, lang = 'por') => post('api/ocr', buf, { lang }),

  // downloads
  player: text => get('v2/player', { text }),
  ytsearch: text => get('api/ytsearch', { text }),
  tiktok: url => get('api/v2/tiktok', { url }),
  instagram: url => get('api/v2/instagram', { url }),
  facebook: url => get('api/v2/facebook', { url }),
  kwai: url => get('api/v1/kwai', { url }),
  twitter: url => get('api/v2/twitter', { url }),

  pinterest: (q, limit, type) => sse('api/v1/pinterest-download-beta', { q, limit, ...(type && { type }) }),

  // ia (session guarda a conversa)
  gpt: (text, session, image) => get('api/v2/chatgpt', { text, session, ...(image && { image }) }),

  // cdn temporário (minutos)
  cdn: async (buf, minutos = 10) => {
    const [type, name] = mime(buf)
    const form = new FormData()
    form.append('file', new Blob([buf], { type }), name)
    form.append('temporary', 'true')
    form.append('expiresIn', String(minutos))
    const r = await fetch(new URL('api/v2/cdn/upload', config.zone.cdn || 'https://cdn.zone.api.br'), { method: 'POST', body: form, signal: AbortSignal.timeout(120000) })
    return (await r.json()).url
  }
}

module.exports = zone
