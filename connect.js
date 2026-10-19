const pino = require('pino')
const chalk = require('chalk')
const cfonts = require('cfonts')
const NodeCache = require('node-cache')
const readline = require('readline')
const { Boom } = require('@hapi/boom')
const bridge = require('./lib/bridge')
const config = require('./config.json')
const { groupCache } = require('./lib/utils')
const { setup, numero, perguntar } = require('./lib/setup')

// anti-crash
process.on('uncaughtException', e => console.log(chalk.red('[ERRO]'), e?.stack || e))
process.on('unhandledRejection', e => /Connection Closed/i.test(e?.message) || console.log(chalk.red('[ERRO]'), e?.stack || e))

// silencia ruído do signal
const NOISE = /Closing (open )?session|SessionEntry|Bad MAC|Removing old closed/i
for (const s of ['log', 'info', 'warn']) {
  const o = console[s]
  console[s] = (...a) => NOISE.test(a.join(' ')) || o(...a)
}

const SESSAO = './database/sessao.db'
const logger = pino({ level: 'silent' })
const usePair = process.argv.includes('--code')
const retry = new NodeCache()
let auth, sock, versao, online = false, conectado = false, tries = 0, restarting = false, watchdog, last = Date.now()

// cliente fixo: sempre aponta pro socket atual, mesmo depois de reconectar
const pronto = async () => { for (let i = 0; i < 120 && !conectado; i++) await new Promise(r => setTimeout(r, 250)) }
const envio = k => async (...a) => {
  await pronto()
  try { return await sock[k](...a) } catch (e) {
    if (!/Connection Closed/i.test(e?.message)) throw e
    // caiu no meio do envio: espera reconectar e tenta de novo
    await new Promise(r => setTimeout(r, 1000))
    await pronto()
    return sock[k](...a)
  }
}
const client = new Proxy({}, {
  get: (_, k) => {
    if (k === 'sendMessage' || k === 'relayMessage') return envio(k)
    const v = sock?.[k]
    return typeof v === 'function' ? v.bind(sock) : v
  }
})

// reconexão: rápida nas 3 primeiras, depois backoff
const reconectar = (motivo) => {
  if (restarting) return
  restarting = true
  conectado = false
  const base = Math.min(2000 * 2 ** Math.min(tries, 9), 900000)
  const wait = tries < 3 ? 1000 : Math.round(base / 2 + Math.random() * base)
  tries++
  console.log(chalk.yellow(`[RECONEXÃO] ${motivo} - ${(wait / 1000).toFixed(0)}s`))
  clearInterval(watchdog)
  try { sock?.ev.removeAllListeners(); sock?.end() } catch {}
  sock = null
  setTimeout(() => { restarting = false; start().catch(console.error) }, wait)
}

// conexão
// pareamento: pergunta o número uma vez e reaproveita se reconectar
let numeroPar, perguntando = false
const parear = async () => {
  if (!numeroPar) {
    if (perguntando) return
    perguntando = true
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    while (!numeroPar) {
      const r = await perguntar(rl, chalk.green('Número para parear com o bot (ex: +55 11 99999-9999): '))
      if (!r) { perguntando = false; return console.log(chalk.red('Sem número para parear. Rode de novo e digite o número.')) }
      numeroPar = numero(r)
      if (!numeroPar) console.log(chalk.yellow('Número inválido.'))
    }
    rl.close()
    perguntando = false
  }
  // usa o socket atual (pode ter reconectado enquanto digitava)
  for (let i = 0; i < 40 && !sock?.ws?.isOpen; i++) await new Promise(r => setTimeout(r, 250))
  if (!sock || sock.authState.creds.registered) return
  const custom = String(config.pairCode || '').toUpperCase()
  const valido = /^[A-Z0-9]{8}$/.test(custom)
  if (custom && !valido) console.log(chalk.yellow(`pairCode "${config.pairCode}" inválido (precisa ter 8 letras/números). Usando código aleatório.`))
  const code = await sock.requestPairingCode(numeroPar, valido ? custom : undefined)
  console.log(chalk.green('Código de pareamento:'), chalk.bold(code?.match(/.{1,4}/g)?.join('-') || code))
}

async function start() {
  const { default: makeWASocket, makeCacheableSignalKeyStore, Browsers, getBestWaVersion, DisconnectReason } = await bridge.load()

  // sessão sqlite (abre uma vez só)
  if (!auth) {
    try { auth = require('./lib/auth')(SESSAO) } catch (e) {
      console.log(chalk.red('SQLite indisponível. Use Node 22.13 ou superior.'), e.message)
      process.exit(1)
    }
  }
  const { state, saveCreds } = auth
  // versão buscada uma vez só
  versao ||= (await getBestWaVersion()).version

  const god = sock = makeWASocket({
    version: versao,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    browser: Browsers.macOS('Chrome'),
    msgRetryCounterCache: retry,
    cachedGroupMetadata: async id => groupCache.get(id),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 20000,
    emitOwnEvents: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    shouldSyncHistoryMessage: () => false,
    patchMessageBeforeSending: msg => msg?.interactiveMessage
      ? { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...msg } } }
      : msg
  })

  // watchdog
  watchdog = setInterval(async () => {
    if (restarting || Date.now() - last < 600000) return
    if (god.ws?.readyState !== 1) return reconectar('watchdog: socket fechado')
    try { await god.sendPresenceUpdate('available'); last = Date.now() } catch { reconectar('watchdog: socket morto') }
  }, 120000)

  god.ev.process(async (ev) => {
    if (ev['creds.update']) await saveCreds()

    if (ev['groups.update']) for (const g of ev['groups.update']) groupCache.del(g.id)
    if (ev['group-participants.update']) groupCache.del(ev['group-participants.update'].id)

    // mensagens
    if (ev['messages.upsert']) {
      last = Date.now()
      const { messages, type } = ev['messages.upsert']
      const handler = require('./index')
      if (type === 'notify') for (const m of messages) handler(client, m).catch(e => console.log(chalk.red('[CMD]'), e?.message || e))
    }

    if (ev['connection.update']) {
      const { connection, lastDisconnect, qr } = ev['connection.update']
      if (qr && !usePair) require('qrcode-terminal').generate(qr, { small: true })
      if (connection === 'connecting' && !online && !perguntando) console.log(chalk.yellow('Conectando...'))
      if (connection === 'open') {
        conectado = true
        tries = 0
        last = Date.now()
        // banner só na primeira vez
        if (online) console.log(chalk.green('[RECONEXÃO] reconectado.'))
        else {
          online = true
          cfonts.say('OPEN|BOT', { font: 'block', align: 'center', gradient: ['white', 'green'] })
          console.log(chalk.green(`  ${config.nome} online.\n`))
        }
      }
      if (connection === 'close') {
        conectado = false
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          console.log(chalk.red('Sessão desconectada. Apagando sessão, reinicie e conecte de novo.'))
          auth.apagar()
          return process.exit()
        }
        if (code === DisconnectReason.connectionReplaced) {
          console.log(chalk.red('Sessão aberta em outro lugar. Encerrando.'))
          return process.exit()
        }
        reconectar(`código ${code}`)
      }
    }
  })

  // pareamento depois dos eventos registrados (nada se perde enquanto digita)
  if (usePair && !god.authState.creds.registered) parear().catch(e => console.log(chalk.red('[PAREAMENTO]'), e?.message))
}

// primeira vez: pergunta dono e apikey antes de conectar
;(async () => {
  if (!config.configurado) await setup()
  await start()
})().catch(e => console.log(chalk.red('[START]'), e))
