// Simulator of a Cartridge speaking RAMIv3 over Telnet, to develop the module without hardware.
//
//   node tools/cartridge-sim.mjs [--port 2323] [--id 35] [--udp 30303] [--no-udp]
//
// Type a key number 1..32 (reading order, top-left = 1) + Enter to press and release it,
// "d12" / "u12" to hold / release key 12, "q" to quit. The 8x4 LED grid is redrawn when it changes.
// Behaviour follows the fixed firmware: COLORON lights the key unless it blinks, COLOROFF only
// matters for blinking, BLINK=0 shows COLORON again. Commands for another device id are ignored.
// Protocol v3.2: a SET without error is acknowledged (ACK), errors carry the device id.
import dgram from 'node:dgram'
import net from 'node:net'
import readline from 'node:readline'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 ? args[i + 1] : fallback
}
const PORT = Number(opt('port', 2323))
const ID = Number(opt('id', 35))
const UDP_PORT = Number(opt('udp', 30303))
const COLUMNS = 4
const LINES = 8

const keys = Array.from({ length: COLUMNS * LINES }, () => ({
	on: '#00FF00',
	off: '#FF0000',
	blink: 0,
	led: '#FF0000',
}))
const sessions = new Set()
const log = []
const idx = (c, l) => l * COLUMNS + c

function draw() {
	const rows = []
	for (let l = 0; l < LINES; l++) {
		let row = ''
		for (let c = 0; c < COLUMNS; c++) {
			const hex = keys[idx(c, l)].led
			const n = parseInt(hex.slice(1), 16)
			row += `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m  ${String(idx(c, l) + 1).padStart(2)}  \x1b[0m `
		}
		rows.push(row)
	}
	process.stdout.write(
		'\x1b[2J\x1b[H' +
			`Cartridge simulator  id=${ID}  telnet=${PORT}  sessions=${sessions.size}\n\n` +
			rows.join('\n') +
			'\n\n' +
			log.slice(-6).join('\n') +
			'\n> ',
	)
}
const note = (s) => {
	log.push(s)
	draw()
}

function handle(line, reply) {
	const text = line.trim()
	if (!text) return reply(`ERROR|1 ID|${ID} : EMPTY COMMAND\r\n`)
	if (text.startsWith('INFO ALL|')) {
		return reply(
			`INFO ID|${ID} IP=127.0.0.1;COLUMN_MAX=3;LINE_MAX=7;DEVICE_VERSION=v1.3;PROTOCOL_VERSION=v3.2;INTERFACE_TELNET=3;INTERFACE_TCP=0;INTERFACE_RS232=0;\r\n`,
		)
	}
	const m = /^(SET|GET) ID\|(\d+)\.BUT:\[(\d+)-(\d+)\] ?(.*)$/.exec(text)
	if (!m) return reply(`ERROR|0 ID|${ID} : UNKNOWN COMMAND\r\n`)
	const [, cmd, id, c, l, rest] = m
	if (Number(id) !== ID) return // not for us: silent, like the firmware
	const key = keys[idx(Number(c), Number(l))]
	if (!key) return reply(`ERROR|5 ID|${ID} : BUTTON ID DOES NOT EXIST, check COLUMN_MAX and LINE_MAX (base 0)\r\n`)
	const actions = rest.split(';').filter(Boolean)
	if (cmd === 'GET') {
		for (const a of actions) {
			if (a === 'COLORON') reply(`INDIC ID|${ID}.BUT:[${c}-${l}].COLORON=${key.on};\r\n`)
			else if (a === 'COLOROFF') reply(`INDIC ID|${ID}.BUT:[${c}-${l}].COLOROFF=${key.off};\r\n`)
			else if (a === 'BLINK') reply(`INDIC ID|${ID}.BUT:[${c}-${l}].BLINK=${key.blink};\r\n`)
		}
		return
	}
	for (const a of actions) {
		const [name, value] = a.split('=')
		if (name === 'COLORON') {
			key.on = value.toUpperCase()
			if (!key.blink) key.led = key.on
		} else if (name === 'COLOROFF') key.off = value.toUpperCase()
		else if (name === 'BLINK') {
			key.blink = Number(value)
			if (!key.blink) key.led = key.on
			else key.led = key.on
		} else return reply(`ERROR|2 ID|${ID} : UNKNOWN ACTION\r\n`)
	}
	reply(`ACK ID|${ID}.BUT:[${c}-${l}];\r\n`)
	draw()
}

const server = net.createServer((socket) => {
	sessions.add(socket)
	let buffer = ''
	const reply = (s) => socket.write(s, 'latin1')
	socket.on('data', (d) => {
		buffer += d.toString('latin1')
		let i
		while ((i = buffer.indexOf('\r\n')) >= 0) {
			handle(buffer.slice(0, i), reply)
			buffer = buffer.slice(i + 2)
		}
	})
	socket.on('close', () => {
		sessions.delete(socket)
		draw()
	})
	socket.on('error', () => {})
	draw()
})
server.listen(PORT, () => note(`listening on ${PORT}`))

if (!args.includes('--no-udp')) {
	const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
	udp.on('error', (e) => note(`udp discovery disabled: ${e.message}`))
	udp.on('message', (msg, rinfo) => {
		if (msg[0] === 0x44)
			udp.send(Buffer.from('CARTRIDGE-SIM \r\nEC-D9-25-00-00-01\r\n80\r\n', 'latin1'), rinfo.port, rinfo.address)
	})
	udp.bind(UDP_PORT)
}

const press = (n, down) => {
	if (n < 1 || n > COLUMNS * LINES) return
	const i = n - 1
	const frame = `EVENT ID|${ID}.BUT:[${i % COLUMNS}-${Math.floor(i / COLUMNS)}].KEY=${down ? 'DOWN' : 'UP'};\r\n`
	for (const s of sessions) s.write(frame, 'latin1')
}
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
	const t = line.trim().toLowerCase()
	if (t === 'q') process.exit(0)
	const m = /^([du]?)(\d+)$/.exec(t)
	if (!m) return draw()
	const n = Number(m[2])
	if (m[1] === 'd') press(n, true)
	else if (m[1] === 'u') press(n, false)
	else {
		press(n, true)
		setTimeout(() => press(n, false), 80)
	}
	note(`key ${n} ${m[1] === 'd' ? 'down' : m[1] === 'u' ? 'up' : 'pressed'}`)
})
