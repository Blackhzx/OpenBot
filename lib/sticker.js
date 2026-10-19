const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { Image } = require('node-webpmux')
const config = require('../config.json')

// limite de ffmpeg ao mesmo tempo
const MAX = Math.max(2, os.cpus().length)
let ativos = 0
const espera = []
const slot = async (fn) => {
  if (ativos >= MAX) await new Promise(r => espera.push(r))
  ativos++
  try { return await fn() } finally { ativos--; espera.shift()?.() }
}

const tmp = ext => path.join(os.tmpdir(), `ob_${crypto.randomBytes(6).toString('hex')}.${ext}`)
const ff = args => new Promise((res, rej) => execFile('ffmpeg', ['-y', '-loglevel', 'error', ...args], e => e ? rej(e) : res()))
const isPng = b => b[0] === 0x89 && b[1] === 0x50

// só converte: mantém proporção e tamanho original (reduz só se passar de 512)
const VF = "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,setsar=1"

// tentativas: qualidade alta primeiro, desce só se passar do limite
const IMG = [[100], [95], [90], [80], [70], [55]]
const VID = [[75, 20], [60, 18], [48, 15], [36, 15], [26, 12], [16, 10]]
const LIM = 1000000

const toWebp = (buf, video) => slot(async () => {
  const inp = tmp(video ? 'mp4' : isPng(buf) ? 'png' : 'jpg')
  const out = tmp('webp')
  await fs.writeFile(inp, buf)
  try {
    const lista = video ? VID : IMG
    let res
    for (let i = 0; i < lista.length;) {
      const [q, fps] = lista[i]
      await ff(['-i', inp,
        '-vf', video ? `fps=${fps},${VF}` : VF,
        '-c:v', 'libwebp', '-q:v', String(q), '-compression_level', '4',
        '-preset', video ? 'default' : 'picture',
        ...(video ? ['-loop', '0', '-an', '-t', '10', '-vsync', '0'] : ['-frames:v', '1']),
        out])
      res = await fs.readFile(out)
      const r = res.length / LIM
      if (r <= 1) break
      // pula níveis conforme o tamanho
      i += r > 3 ? 3 : r > 1.8 ? 2 : 1
    }
    return res
  } finally {
    fs.unlink(inp).catch(() => {})
    fs.unlink(out).catch(() => {})
  }
})

// descrição (exif)
// pack/autor = descrição personalizada (rename)
const exif = async (webp, { nome, grupo, pack, autor }) => {
  const img = new Image()
  await img.load(webp)
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': 'openbot',
    'sticker-pack-name': pack ?? `⌬ 𝕮𝖗𝖎𝖆𝖉𝖆 𝖕𝖔𝖗:\n↳『 ${config.nome} 』\n\n⌬ 𝕹𝖎𝖈𝖐 𝕯𝖔𝖓𝖔:\n↳『 ${config.nomeDono} 』\n《───────`,
    'sticker-pack-publisher': autor ?? `───────》\n⌬ 𝔽𝕖𝕚𝕥𝕒 𝕡𝕠𝕣:\n↳『 ${nome} 』\n\n⌬ 𝔾𝕣𝕦𝕡𝕠:\n↳『 ${grupo} 』`
  }))
  const head = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00])
  const ex = Buffer.concat([head, json])
  ex.writeUIntLE(json.length, 14, 4)
  img.exif = ex
  return { buf: await img.save(null), width: img.width, height: img.height, animated: !!img.hasAnim }
}

// s = whatsapp estica pra 512x512 / f = tamanho original
// o arquivo nunca é deformado, o toimg volta igual ao original
const sticker = async (buf, { tipo, estica, ...info }) => {
  const r = await exif(tipo === 'sticker' ? buf : await toWebp(buf, tipo === 'video'), info)
  return { sticker: r.buf, isAnimated: r.animated, width: estica ? 512 : r.width, height: estica ? 512 : r.height }
}

// figurinha estática -> png
const toPng = buf => slot(async () => {
  const inp = tmp('webp'), out = tmp('png')
  await fs.writeFile(inp, buf)
  try {
    await ff(['-i', inp, out])
    return await fs.readFile(out)
  } finally {
    fs.unlink(inp).catch(() => {})
    fs.unlink(out).catch(() => {})
  }
})

const isAnim = buf => buf.includes('ANIM')

// primeiro quadro de figurinha animada (pra IA ler)
const quadro = async buf => {
  if (!isAnim(buf)) return buf
  const img = new Image()
  await img.load(buf)
  return (await img.demux({ buffers: true, frame: 0 }))[0]
}

module.exports = { sticker, toWebp, toPng, isAnim, quadro, exif }
