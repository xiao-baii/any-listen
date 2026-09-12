const http = require('node:http')
const server = http.createServer((req, res) => {
  res.end(process.env.ANYLISTEN_USER_ID)
})
server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port }))
process.on('message', (message) => {
  if (message.type === 'shutdown') server.close(() => process.exit(0))
})
