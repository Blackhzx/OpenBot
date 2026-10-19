const fs = require('fs')
const chalk = require('chalk')
const config = require('./config.json')
const { generateWAMessageFromContent, prepareWAMessageMedia, normalizeMessageContent, getContentType, jidNormalizedUser, downloadContentFromMessage } = require('./lib/bridge').get()
const { db, save, t, langs, similar, groupMeta, num } = require('./lib/utils')
const { sticker, toPng, isAnim, quadro } = require('./lib/sticker')
const zone = require('./lib/zone')

//\\ plugins //\\
const plugins = new Map()
for (const f of fs.readdirSync('./plugins').filter(f => f.endsWith('.js'))) {
  const p = require(`./plugins/${f}`)
  for (const c of [].concat(p.cmd)) plugins.set(c, p)
}

//\\ permissões //\\
const perm = { ban: 'admin', promover: 'admin', rebaixar: 'admin', marcar: 'adm', autofigu: 'adm', autofig: 'adm', grupo: 'admin', idioma: 'dono', botoes: 'dono', prefixo: 'dono', setmenu: 'dono', setfoto: 'dono' }

//\\ menu //\\
const MENU = './menu.json'
const getMenu = () => JSON.parse(fs.readFileSync(MENU))
const campos = ['topo', 'secao', 'item', 'fim', 'rodape']
const alias = { menuadmin: 'menuadm', menuowner: 'menudono', menucmd: 'menu', comandos: 'menu' }
const sub = { adm: 'menuadm', admin: 'menuadm', dono: 'menudono', owner: 'menudono' }
const fill = (s = '', v) => s.replace(/{(\w+)}/g, (a, x) => v[x] ?? langs[db.idioma]?.[x] ?? langs.pt[x] ?? a)

// similaridade
const todos = [...new Set(['menu', 'ping', 'dono', ...Object.keys(perm), ...plugins.keys(), ...Object.keys(alias), ...Object.entries(getMenu()).filter(([, v]) => Array.isArray(v)).flatMap(([k, v]) => [k, ...v.map(c => c.split(' ')[0])])])]

// texto da mensagem
const getBody = (msg) => {
  const c = msg?.[getContentType(msg)]
  if (!c) return ''
  if (typeof c === 'string') return c
  if (c.nativeFlowResponseMessage) try { return JSON.parse(c.nativeFlowResponseMessage.paramsJson).id } catch {}
  return c.text || c.caption || c.selectedButtonId || c.singleSelectReply?.selectedRowId || c.selectedId || ''
}

//\\ mídia //\\
const baixar = async (c, tipo) => {
  const b = []
  for await (const x of await downloadContentFromMessage(c, tipo)) b.push(x)
  return Buffer.concat(b)
}
const pegar = async (url, headers) => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(300000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}
// compara números ignorando o 9 dos celulares brasileiros (55 DDD 9 XXXX-XXXX)
const semNove = x => (x = String(x).replace(/\D/g, '')).startsWith('55') && x.length === 13 ? x.slice(0, 4) + x.slice(5) : x
const mesmoNum = (a, b) => semNove(a) === semNove(b)

// número curto (1.2K / 3.4M)
const n = x => x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'K' : x

// baixa e descobre se é foto ou vídeo pelo próprio arquivo
const baixarMidia = async url => {
  const buf = await pegar(url)
  return { [buf.slice(4, 8).toString() === 'ftyp' || buf.slice(0, 4).toString('hex') === '1a45dfa3' ? 'video' : 'image']: buf }
}
const midia = x => x?.imageMessage ? ['image', x.imageMessage] : x?.videoMessage ? ['video', x.videoMessage] : x?.stickerMessage ? ['sticker', x.stickerMessage] : []

// fila por chat
const filas = new Map()
const fila = (id, fn) => {
  const r = (filas.get(id) || Promise.resolve()).then(fn)
  filas.set(id, r.catch(() => {}))
  return r
}

// figurinha
const figu = async (god, m, from, tipo, c, estica = true) => {
  const grupo = from.endsWith('@g.us') ? (await groupMeta(god, from)).subject : 'Privado'
  const st = await sticker(await baixar(c, tipo), { tipo, nome: m.pushName || num(m.key.participant || from), grupo, estica })
  return god.sendMessage(from, st, { quoted: m })
}

module.exports = async (god, m) => {
  if (!m.message || m.key.remoteJid === 'status@broadcast') return
  const conn = god, sock = god, Socket = god, systemZR = god

  const msg = normalizeMessageContent(m.message)
  const body = getBody(msg).trim()
  const p = db.prefixo
  const from = m.key.remoteJid

  // autofigu
  if (!body.startsWith(p)) {
    if (db.autofigu?.[from] && !m.key.fromMe) {
      const [tipo, c] = midia(msg)
      if (tipo === 'image' || (tipo === 'video' && (c.seconds || 0) <= 20)) fila(from, () => figu(god, m, from, tipo, c)).catch(e => console.log(chalk.red('[AUTOFIGU]'), e?.message))
    }
    return
  }

  const raw = body.slice(p.length).trim()
  const [cmd, ...args] = raw.split(/\s+/)
  const command = cmd?.toLowerCase()
  if (!command) return
  const q = raw.slice(cmd.length).trim()
  const isGroup = from.endsWith('@g.us')
  const sender = jidNormalizedUser(isGroup ? m.key.participant : from)
  const senderAlt = jidNormalizedUser(m.key.participantAlt || m.key.remoteJidAlt || '')
  const nome = m.pushName || num(sender)
  const ctxInfo = msg[getContentType(msg)]?.contextInfo
  const quoted = ctxInfo?.quotedMessage
  const alvo = ctxInfo?.mentionedJid?.[0] || ctxInfo?.participant

  // grupo / admin / dono
  const meta = isGroup ? await groupMeta(god, from) : null
  const admins = meta?.participants.filter(x => x.admin).flatMap(x => [x.id, x.lid, x.phoneNumber]) || []
  const eu = [god.user.id, god.user.lid].filter(Boolean).map(jidNormalizedUser)
  const isDono = m.key.fromMe || [sender, senderAlt].some(j => j && config.dono.some(d => mesmoNum(d, num(j))))
  const isAdm = isDono || [sender, senderAlt].some(j => admins.includes(j))
  const isBotAdm = eu.some(j => admins.includes(j))

  const reply = (text) => god.sendMessage(from, { text }, { quoted: m })

  // botões (native flow single_select)
  const lista = async ({ texto, rodape = config.nome, botao = t('abrir'), secoes, foto }) => {
    const header = foto
      ? { hasMediaAttachment: true, ...(await prepareWAMessageMedia({ image: foto }, { upload: god.waUploadToServer })) }
      : { hasMediaAttachment: false }
    const w = generateWAMessageFromContent(from, {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} },
          interactiveMessage: {
            header,
            body: { text: texto },
            footer: { text: rodape },
            nativeFlowMessage: { buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title: botao, sections: secoes }) }] }
          }
        }
      }
    }, { quoted: m, userJid: god.user.id })
    return god.relayMessage(from, w.message, { messageId: w.key.id })
  }

  // mídia com botão de abrir o link
  const cartao = async (midia, texto, link) => {
    const header = { hasMediaAttachment: true, ...(await prepareWAMessageMedia(midia, { upload: god.waUploadToServer })) }
    const w = generateWAMessageFromContent(from, {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} },
          interactiveMessage: {
            header,
            body: { text: texto || ' ' },
            footer: { text: config.nome },
            nativeFlowMessage: { buttons: [{ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: t('abrirPost'), url: link, merchant_url: link }) }] }
          }
        }
      }
    }, { quoted: m, userJid: god.user.id })
    return god.relayMessage(from, w.message, { messageId: w.key.id })
  }

  console.log(chalk.green('[CMD]'), chalk.white(p + command), chalk.gray(`| ${nome} | ${isGroup ? meta.subject : 'PV'}`))

  // permissões
  const tag = plugins.get(command)?.tag || perm[command]
  if (tag === 'dono' && !isDono) return reply(t('soDono'))
  if (tag === 'admin' || tag === 'adm') {
    if (!isGroup) return reply(t('soGrupo'))
    if (!isAdm) return reply(t('soAdm'))
    if (tag === 'admin' && !isBotAdm) return reply(t('botAdm'))
  }

  const ctx = { god, conn, sock, Socket, systemZR, m, msg, from, sender, nome, args, q, p, command, alvo, quoted, isGroup, meta, isDono, isAdm, isBotAdm, reply, lista, t, db, save, config }
  if (plugins.has(command)) return plugins.get(command).run(ctx)

  //\\ menus //\\
  const mn = getMenu()
  const nm = (command === 'menu' && sub[args[0]?.toLowerCase()]) || alias[command] || command
  if (Array.isArray(mn[nm])) {
    const v = { bot: config.nome, nome, p, idioma: db.idioma, grupo: meta?.subject || 'PV', titulo: t(nm) }
    // botões: !menu mostra só os menus, cada um abre o menu em texto
    if (db.botoes && command === 'menu' && !args[0]) return lista({
      texto: fill(mn.topo, v),
      rodape: fill(mn.rodape, v),
      foto: fs.readFileSync(config.foto),
      secoes: [{
        title: t('menus'),
        rows: Object.keys(mn).filter(k => Array.isArray(mn[k])).map(k => ({ title: k === 'menu' ? t('menuCmds') : t(k), id: p + (k === 'menu' ? 'menucmd' : k) }))
      }]
    })
    const txt = [fill(mn.topo, v), [fill(mn.secao, v), ...mn[nm].map(c => fill(mn.item, { ...v, cmd: c })), fill(mn.fim, v)].join('\n'), fill(mn.rodape, v)]
    return god.sendMessage(from, { image: fs.readFileSync(config.foto), caption: txt.filter(Boolean).join('\n\n') }, { quoted: m })
  }

  switch (command) {

    case 'setmenu': {
      const [campo] = args
      const txt = q.slice(campo?.length || 0).trim()
      if (!campo) return reply(t('setmenuUso', { p, campos: campos.join(', '), menus: Object.keys(mn).filter(k => Array.isArray(mn[k])).join(', '), vars: '{bot} {nome} {p} {grupo} {idioma} {titulo} {cmd}' }))
      if (campos.includes(campo)) mn[campo] = txt
      else if (txt) mn[campo.toLowerCase()] = txt.split(',').map(c => c.trim()).filter(Boolean)
      else delete mn[campo.toLowerCase()]
      fs.writeFileSync(MENU, JSON.stringify(mn, null, 2))
      reply(t('feito'))
    }
    break

    case 'setfoto': {
      const img = quoted?.imageMessage || msg.imageMessage
      if (!img) return reply(t('mandeFoto'))
      fs.writeFileSync(config.foto, await baixar(img, 'image'))
      reply(t('feito'))
    }
    break

    case 's':
    case 'sticker':
    case 'figurinha':
    case 'f':
    case 'figu': {
      const [tipo, c] = midia(quoted ? normalizeMessageContent(quoted) : msg)
      if (!tipo) return reply(t('figuUso'))
      const estica = !['f', 'figu'].includes(command)
      await fila(from, () => figu(god, m, from, tipo, c, estica)).catch(e => (console.log(chalk.red('[STICKER]'), e?.message), reply(t('erroFigu'))))
    }
    break

    case 'toimg':
    case 'simg':
    case 'stickerimg':
    case 'togif':
    case 'tovideo':
    case 'tomp4': {
      const [tipo, c] = midia(quoted ? normalizeMessageContent(quoted) : msg)
      if (tipo !== 'sticker') return reply(t('toimgUso'))
      try {
        const buf = await baixar(c, 'sticker')
        if (!isAnim(buf)) return await god.sendMessage(from, { image: await toPng(buf) }, { quoted: m })
        const res = await zone.toMp4(buf)
        if (!res?.result?.video) return reply(t('erroApi'))
        await god.sendMessage(from, { video: { url: res.result.video }, gifPlayback: !['tovideo', 'tomp4'].includes(command) }, { quoted: m })
      } catch (e) {
        console.log(chalk.red('[TOIMG]'), e?.message)
        reply(t('erroConv'))
      }
    }
    break

    case 'autofig':
    case 'autofigu': {
      db.autofigu ||= {}
      if (db.autofigu[from]) delete db.autofigu[from]
      else db.autofigu[from] = true
      save()
      reply(t(db.autofigu[from] ? 'autofiguOn' : 'autofiguOff'))
    }
    break

    case 'rbg':
    case 'removebg': {
      const [tipo, c] = midia(quoted ? normalizeMessageContent(quoted) : msg)
      if (tipo !== 'image') return reply(t('mandeFoto'))
      try {
        const res = await zone.removeBg(await baixar(c, 'image'))
        if (!res?.imagem) return reply(t('erroApi'))
        await god.sendMessage(from, { image: { url: res.imagem } }, { quoted: m })
      } catch (e) {
        console.log(chalk.red('[RBG]'), e?.message)
        reply(t('erroApi'))
      }
    }
    break

    case 'sfundo': {
      const [tipo, c] = midia(quoted ? normalizeMessageContent(quoted) : msg)
      if (tipo !== 'sticker') return reply(t('toimgUso'))
      try {
        const buf = await baixar(c, 'sticker')
        if (isAnim(buf)) return reply(t('soEstatica'))
        const res = await zone.removeBg(await toPng(buf))
        if (!res?.imagem) return reply(t('erroApi'))
        const st = await sticker(await pegar(res.imagem), { tipo: 'image', nome, grupo: meta?.subject || 'Privado' })
        // mantém o tamanho que a figurinha original tinha
        await god.sendMessage(from, { ...st, width: c.width || st.width, height: c.height || st.height }, { quoted: m })
      } catch (e) {
        console.log(chalk.red('[SFUNDO]'), e?.message)
        reply(t('erroApi'))
      }
    }
    break

    case 'rename':
    case 'take': {
      const [tipo, c] = midia(quoted ? normalizeMessageContent(quoted) : msg)
      if (tipo !== 'sticker' || !q) return reply(t('uso', { u: `${p}rename pack / autor` }))
      const [pack, autor = ''] = q.split('/').map(x => x.trim())
      try {
        const st = await sticker(await baixar(c, 'sticker'), { tipo, pack, autor })
        await god.sendMessage(from, { ...st, width: c.width || st.width, height: c.height || st.height }, { quoted: m })
      } catch (e) {
        console.log(chalk.red('[RENAME]'), e?.message)
        reply(t('erroFigu'))
      }
    }
    break

    case 'play':
    case 'playvid':
    case 'playvideo': {
      if (!q) return reply(t('uso', { u: `${p}${command} nome ou link` }))
      if (!zone.key()) return reply(t('semKey'))
      const video = command !== 'play'
      try {
        const r = await zone.get('api/v1/gyt', video ? { url: q, format: 'mp4', quality: 360, direct: true } : { url: q, format: 'm4a', direct: 'tmp' })
        if (!r?.status) return reply(t('naoAchei'))
        if (video) {
          const buf = await pegar(r.url, r.headers)
          const info = t('ytVideo', { titulo: r.title, duracao: r.duration, tamanho: (buf.length / 1048576).toFixed(2) + ' MB' })
          return await god.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption: info }, { quoted: m })
        }
        const info = t('ytAudio', { titulo: r.title, canal: r.channel, duracao: r.duration, tamanho: r.size })
        // capa: tenta a maior e cai pras menores
        const id = r.youtube_url?.match(/[?&]v=([\w-]{11})/)?.[1]
        const capas = [r.thumbnail?.replace('/vi_webp/', '/vi/').replace(/\.webp$/, '.jpg'), ...['maxresdefault', 'sddefault', 'hqdefault'].map(x => id && `https://i.ytimg.com/vi/${id}/${x}.jpg`)].filter(Boolean)
        let capa
        for (const u of capas) if (!capa) capa = await pegar(u).catch(() => null)
        await god.sendMessage(from, capa ? { image: capa, caption: info } : { text: info }, { quoted: m })
        await god.sendMessage(from, { audio: { url: r.download_url }, mimetype: 'audio/mpeg' }, { quoted: m })
      } catch (e) {
        console.log(chalk.red('[PLAY]'), e?.message)
        reply(t('erroDown'))
      }
    }
    break

    case 'pin':
    case 'pinterest': {
      const [busca, ...op] = q.split('|').map(x => x.trim()).filter(Boolean)
      if (!busca) return reply(t('pinUso', { p }))
      const tipo = op.find(x => /^v[ií]deos?$/i.test(x)) ? 'video' : op.find(x => /^(imagens?|imagem|images?|fotos?|gambar)$/i.test(x)) ? 'image' : null
      const qtd = Math.min(50, Math.max(1, +op.find(x => /^\d+$/.test(x)) || 6))
      try {
        const ev = await zone.pinterest(busca, qtd, tipo)
        const itens = ev.filter(x => (x.type === 'image' || x.type === 'video') && x.download_url).slice(0, qtd)
        if (!itens.length) return reply(t('naoAchei'))
        // baixa tudo junto e ignora o que falhar
        const midias = (await Promise.allSettled(itens.map(async x => ({ [x.type]: await pegar(x.download_url) }))))
          .filter(x => x.status === 'fulfilled' && x.value[Object.keys(x.value)[0]].length).map(x => x.value)
        if (!midias.length) return reply(t('erroDown'))
        if (midias.length === 1) return await god.sendMessage(from, midias[0], { quoted: m })
        await god.sendMessage(from, { albumMessage: midias }, { quoted: m })
      } catch (e) {
        console.log(chalk.red('[PIN]'), e?.message)
        reply(t('erroDown'))
      }
    }
    break

    case 'tiktok':
    case 'ttk':
    case 'tt': {
      if (!/tiktok\.com/i.test(q)) return reply(t('uso', { u: `${p}${command} https://vt.tiktok.com/...` }))
      if (!zone.key()) return reply(t('semKey'))
      try {
        const r = await zone.tiktok(q)
        if (!r?.status) return reply(t('naoAchei'))
        // só mostra o que veio preenchido
        const info = [
          ['lAutor', r.autor?.nickname && `${r.autor.nickname} (@${r.autor.username})`],
          ['lDuracao', !/^0\b/.test(r.duracao || '0') && r.duracao],
          ['lCurtidas', r.stats?.like != null && n(r.stats.like)],
          ['lViews', r.stats?.views != null && n(r.stats.views)],
          ['lComentarios', r.stats?.comment != null && n(r.stats.comment)],
          ['lCompart', r.stats?.share != null && n(r.stats.share)],
          ['lMusica', r.musica?.title && `${r.musica.title} - ${r.musica.author}`]
        ].filter(([, v]) => v).map(([k, v]) => `${t(k)}: ${v}`)
        const caption = [r.titulo && `*${r.titulo.trim().slice(0, 100)}*`, info.join('\n')].filter(Boolean).join('\n\n')

        if (r.is_video && r.download_url) return await god.sendMessage(from, { video: await pegar(r.download_url), mimetype: 'video/mp4', caption }, { quoted: m })

        const fotos = (await Promise.allSettled((r.imagens || []).map(u => pegar(u)))).filter(x => x.status === 'fulfilled').map(x => ({ image: x.value }))
        if (!fotos.length) return reply(t('naoAchei'))
        fotos[0].caption = caption
        await god.sendMessage(from, fotos.length > 1 ? { albumMessage: fotos } : fotos[0], { quoted: m })
      } catch (e) {
        console.log(chalk.red('[TIKTOK]'), e?.message)
        reply(t('erroDown'))
      }
    }
    break

    case 'gpt':
    case 'ia':
    case 'chatgpt': {
      const [tipo, c] = midia(msg).length ? midia(msg) : midia(quoted ? normalizeMessageContent(quoted) : {})
      const ver = tipo === 'image' || tipo === 'sticker'
      if (!q && !ver) return reply(t('gptUso', { p, c: command }))
      if (!zone.key()) return reply(t('semKey'))
      try {
        // imagem ou figurinha (animada vai o primeiro quadro)
        const img = ver ? await zone.cdn(tipo === 'sticker' ? await quadro(await baixar(c, 'sticker')) : await baixar(c, 'image')) : null
        const r = await zone.gpt(q || t('gptImg'), `${num(senderAlt || sender)}-${num(from)}`, img)
        if (!r?.result) return reply(t('erroIa'))
        reply(r.result.replace(/\*\*(.+?)\*\*/g, '*$1*'))
      } catch (e) {
        console.log(chalk.red('[GPT]'), e?.message)
        reply(t('erroIa'))
      }
    }
    break

    case 'ig':
    case 'insta':
    case 'instagram':
    case 'fb':
    case 'face':
    case 'facebook':
    case 'kwai': {
      const rede = ['fb', 'face', 'facebook'].includes(command) ? 'facebook' : command === 'kwai' ? 'kwai' : 'instagram'
      if (!new RegExp(`${rede === 'facebook' ? 'facebook\\.com|fb\\.(watch|com)' : rede}`, 'i').test(q)) return reply(t('uso', { u: `${p}${command} link` }))
      if (!zone.key()) return reply(t('semKey'))
      try {
        const r = await zone[rede](q)
        if (!r?.status || !r.media?.length) return reply(t('naoAchei'))
        const s = r.stats || {}
        const info = [
          ['lAutor', r.author?.name && (/^pfbid/.test(r.author.username) || !r.author.username ? r.author.name : `${r.author.name} (@${r.author.username})`)],
          ['lDuracao', s.duration && `${Math.floor(s.duration / 60)}:${String(Math.round(s.duration % 60)).padStart(2, '0')}`],
          ['lCurtidas', s.likes != null && n(s.likes)],
          ['lViews', s.views != null && n(s.views)],
          ['lComentarios', s.comments != null && n(s.comments)],
          ['lCompart', s.shares != null && n(s.shares)]
        ].filter(([, v]) => v).map(([k, v]) => `${t(k)}: ${v}`).join('\n')
        const legenda = r.caption?.trim() && r.caption.trim() !== '...' ? `\n\n${r.caption.trim().slice(0, 700)}` : ''

        const midias = (await Promise.allSettled(r.media.map(u => baixarMidia(u)))).filter(x => x.status === 'fulfilled').map(x => x.value)
        if (!midias.length) return reply(t('erroDown'))

        // primeira mídia com o botão de abrir o post, o resto em álbum
        const [primeira, ...resto] = midias
        await cartao(primeira, info + legenda, q)
        if (resto.length) await god.sendMessage(from, resto.length > 1 ? { albumMessage: resto } : resto[0], { quoted: m })
      } catch (e) {
        console.log(chalk.red(`[${rede.toUpperCase()}]`), e?.message)
        reply(t('erroDown'))
      }
    }
    break

    case 'tw':
    case 'twitter':
    case 'x': {
      if (!/(twitter|x)\.com/i.test(q)) return reply(t('uso', { u: `${p}${command} link` }))
      if (!zone.key()) return reply(t('semKey'))
      try {
        const r = await zone.twitter(q)
        if (!r?.status || !r.download_url) return reply(t('naoAchei'))
        const midia = await baixarMidia(r.download_url)
        await cartao(midia, r.qualidade ? `${t('lQualidade')}: ${r.qualidade}` : '', r.tweet_url || q)
      } catch (e) {
        console.log(chalk.red('[TWITTER]'), e?.message)
        reply(t('erroDown'))
      }
    }
    break

    case 'ping': {
      const up = process.uptime()
      reply(t('ping', { ms: Date.now() - Number(m.messageTimestamp) * 1000, up: `${Math.floor(up / 3600)}h ${Math.floor(up / 60) % 60}m` }))
    }
    break

    case 'dono':
      reply(config.dono.map(n => `wa.me/${n}`).join('\n'))
    break

    case 'ban':
    case 'promover':
    case 'rebaixar': {
      if (!alvo) return reply(t('marque'))
      const acao = { ban: 'remove', promover: 'promote', rebaixar: 'demote' }[command]
      await god.groupParticipantsUpdate(from, [alvo], acao)
      reply(t('feito'))
    }
    break

    case 'marcar':
      god.sendMessage(from, { text: q || '‎', mentions: meta.participants.map(x => x.id) })
    break

    case 'grupo': {
      const s = { abrir: 'not_announcement', open: 'not_announcement', buka: 'not_announcement', fechar: 'announcement', close: 'announcement', tutup: 'announcement' }[args[0]]
      if (!s) return reply(t('uso', { u: `${p}grupo abrir/fechar` }))
      await god.groupSettingUpdate(from, s)
      reply(t('feito'))
    }
    break

    case 'idioma': {
      if (!langs[args[0]]) return reply(t('uso', { u: `${p}idioma ${Object.keys(langs).join('/')}` }))
      db.idioma = args[0]
      save()
      reply(t('feito'))
    }
    break

    case 'botoes': {
      if (!['on', 'off'].includes(args[0])) return reply(t('uso', { u: `${p}botoes on/off` }))
      db.botoes = args[0] === 'on'
      save()
      reply(t(db.botoes ? 'botoesOn' : 'botoesOff'))
    }
    break

    case 'prefixo': {
      if (!args[0]) return reply(t('uso', { u: `${p}prefixo .` }))
      db.prefixo = args[0]
      save()
      reply(t('feito'))
    }
    break

    default: {
      const s = similar(command, todos)
      reply(s.p >= 40 ? t('similar', { cmd: command, s: p + s.n, pct: s.p }) : t('naoExiste', { cmd: command, p }))
    }
  }
}
