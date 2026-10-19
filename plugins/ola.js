// plugin exemplo
module.exports = {
  cmd: ['ola', 'hello', 'halo'],
  run: ({ reply, nome, db }) => reply({ pt: `Olá, ${nome}.`, en: `Hello, ${nome}.`, id: `Halo, ${nome}.` }[db.idioma])
}
