// Check the module's connection layer against a real Cartridge (or the simulator).
//
//   yarn build && node tools/device-check.mjs <host> [--port 23] [--keys <seconds>] [--no-restore]
//
// 1. saves COLORON / COLOROFF / BLINK of the 32 keys (what GET returns)
// 2. paints two "pages" of 32 different colours back to back, like a Companion page change,
//    then reads every key back and compares (proves addressing and pacing)
// 3. optionally prints key events for <seconds> (press keys on the unit)
// 4. restores the saved values. The stored values are RAM only: a reboot of the unit also restores them.
import { setTimeout as sleep } from 'node:timers/promises'
import { CartridgeConnection } from '../dist/connection.js'
import { toHex } from '../dist/ramiv3.js'

const args = process.argv.slice(2)
const host = args[0]
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 ? args[i + 1] : fallback
}
if (!host) {
	console.error('usage: node tools/device-check.mjs <host> [--port 23] [--keys <seconds>] [--no-restore]')
	process.exit(1)
}
const port = Number(opt('port', 23))
const keysSeconds = Number(opt('keys', 0))
const restore = !args.includes('--no-restore')

const log = {
	debug() {},
	info: (m) => console.log('  [info]', m),
	warn: (m) => console.log('  [warn]', m),
	error: (m) => console.log('  [error]', m),
}
const conn = await CartridgeConnection.open(host, port, log)
const id = conn.info.deviceId
console.log(
	`connected: device ${id}, firmware ${conn.info.deviceVersion}, protocol ${conn.info.protocolVersion}, ${conn.info.columnMax + 1} columns x ${conn.info.lineMax + 1} lines`,
)

const waiting = new Map()
conn.on('message', (m) => {
	if (m.kind === 'indic') waiting.get(`${m.column}-${m.line}-${m.action}`)?.(m.value)
	if (m.kind === 'error') console.log('  [device error]', m.code, m.message)
})
async function get(column, line, action) {
	const key = `${column}-${line}-${action}`
	const answer = new Promise((resolve) => waiting.set(key, resolve))
	conn.sendRaw(`GET ID|${id}.BUT:[${column}-${line}] ${action}`)
	const value = await Promise.race([answer, sleep(1000).then(() => 'TIMEOUT')])
	waiting.delete(key)
	return value
}

const positions = []
for (let line = 0; line < 8; line++)
	for (let column = 0; column < 4; column++) positions.push({ column, line, n: line * 4 + column + 1 })

// 1. save
console.log('\n1. saving the current state of the 32 keys')
const saved = []
for (const p of positions) {
	saved.push({
		...p,
		on: await get(p.column, p.line, 'COLORON'),
		off: await get(p.column, p.line, 'COLOROFF'),
		blink: await get(p.column, p.line, 'BLINK'),
	})
}
console.log(
	'   key 1:',
	saved[0].on,
	saved[0].off,
	'blink',
	saved[0].blink,
	'| timeouts:',
	saved.filter((s) => [s.on, s.off, s.blink].includes('TIMEOUT')).length,
)

// 2. two pages back to back
const page = (k) =>
	positions.map((p) => ({
		r: (p.n * 8 + k * 100) & 255,
		g: 255 - ((p.n * 7 + k * 50) & 127),
		b: ((p.column + 1) * 60 + k * 20) & 255,
	}))
const expectedHex = (colors) => colors.map(toHex)
let failures = 0
for (const k of [1, 2]) {
	console.log(`\n2.${k} painting page ${k} (32 keys)`)
	const colors = page(k)
	const t0 = Date.now()
	positions.forEach((p, i) => conn.setColor(p.column, p.line, colors[i]))
	await sleep(600)
	const expected = expectedHex(colors)
	let bad = 0
	for (const [i, p] of positions.entries()) {
		const got = await get(p.column, p.line, 'COLORON')
		if (got !== expected[i]) {
			bad++
			console.log(`   key ${p.n} [${p.column}-${p.line}] expected ${expected[i]} got ${got}`)
		}
	}
	failures += bad
	console.log(`   ${32 - bad}/32 keys correct (sent in ${Date.now() - t0 - 600} ms of pacing + 600 ms wait)`)
	if (k === 1) {
		console.log('   --> look at the unit: 32 keys with different colours')
		await sleep(2500)
	}
}

// 3. key events
if (keysSeconds > 0) {
	console.log(`\n3. press keys on the unit for ${keysSeconds} s`)
	conn.on('key', (column, line, pressed) =>
		console.log(`   key ${line * 4 + column + 1} [${column}-${line}] ${pressed ? 'DOWN' : 'UP'}`),
	)
	await sleep(keysSeconds * 1000)
}

// 4. restore
if (restore) {
	console.log('\n4. restoring the saved values')
	for (const s of saved) {
		if ([s.on, s.off].includes('TIMEOUT')) continue
		conn.sendRaw(`SET ID|${id}.BUT:[${s.column}-${s.line}] COLORON=${s.on};COLOROFF=${s.off};BLINK=${s.blink || 0}`)
		await sleep(30)
	}
	await sleep(300)
	let bad = 0
	for (const s of saved)
		if ((await get(s.column, s.line, 'COLORON')) !== s.on || (await get(s.column, s.line, 'COLOROFF')) !== s.off) bad++
	console.log(`   restored: ${32 - bad}/32 keys identical to the saved state`)
	failures += bad
} else {
	console.log('\n4. restore skipped (--no-restore)')
}

conn.close()
console.log(failures === 0 ? '\nRESULT: OK' : `\nRESULT: ${failures} mismatch(es)`)
process.exit(failures === 0 ? 0 : 2)
