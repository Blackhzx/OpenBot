//\\ configuração inicial no terminal //\\
const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const readline = require('readline')
const config = require('../config.json')

const FILE = path.join(__dirname, '../config.json')

// aceita +55 (11) 99999-9999, 11999999999, 55 11 9999-9999, +1 415...
// sem "+" e com 10/11 dígitos = número brasileiro sem o 55
const numero = txt => {
  let n = String(txt).replace(/\D/g, '').replace(/^0+/, '')
  if (!String(txt).trim().startsWith('+') && (n.length === 10 || n.length === 11)) n = '55' + n
  return n.length >= 10 && n.length <= 15 ? n : null
}

// pergunta que não trava se o terminal fechar (hosts sem stdin)
const perguntar = (rl, txt) => new Promise(r => {
  if (rl.closed) return r('')
  rl.once('close', () => r(''))
  rl.question(txt, a => r(a.trim()))
})

const setup = async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log(chalk.green('\n  Configuração inicial do Open Bot\n'))

  const nome = await perguntar(rl, chalk.white('Nome do dono: '))
  if (nome) config.nomeDono = nome

  let dono
  while (!dono) {
    const r = await perguntar(rl, chalk.white('Número do dono: '))
    if (!r) break
    dono = numero(r)
    if (!dono) console.log(chalk.yellow('Número inválido. Ex: +55 11 99999-9999'))
  }
  if (dono) config.dono = [dono]

  const key = await perguntar(rl, chalk.white('Apikey da Zone (opcional, Enter para pular): '))
  if (key) config.zone.apikey = key

  // host sem terminal: não salva, usa o config.json como está
  if (rl.closed) return console.log(chalk.yellow('\nSem acesso ao terminal. Edite o config.json (dono, nomeDono, zone.apikey) e coloque "configurado": true.\n'))
  rl.close()
  config.configurado = true
  fs.writeFileSync(FILE, JSON.stringify(config, null, 2) + '\n')
  console.log(chalk.green(`\nSalvo em config.json. Dono: ${config.dono[0]}\n`))
}

module.exports = { setup, numero, perguntar }

// npm run setup
if (require.main === module) setup()
