import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { after, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { CartridgeConnection } from '../dist/connection.js'
import plugin from '../dist/plugin.js'

const PORT = 2398
const SIM = fileURLToPath(new URL('../tools/cartridge-sim.mjs', import.meta.url))

let sim = null
function startSim() {
	sim = spawn(process.execPath, [SIM, '--port', String(PORT), '--id', '35', '--no-udp'], {
		stdio: ['pipe', 'ignore', 'ignore'],
	})
}
async function waitForPort(port, timeoutMs = 5000) {
	const end = Date.now() + timeoutMs
	while (Date.now() < end) {
		const ok = await new Promise((resolve) => {
			const s = net.connect(port, '127.0.0.1')
			s.once('connect', () => (s.destroy(), resolve(true)))
			s.once('error', () => resolve(false))
		})
		if (ok) return
		await sleep(100)
	}
	throw new Error('simulator did not start')
}
const once = (emitter, name, timeoutMs = 12000) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs)
		emitter.once(name, (...a) => (clearTimeout(t), resolve(a)))
	})

/** Stored COLORON of one key, read through an independent connection (what the device keeps) */
async function storedColor(column, line) {
	const probe = await CartridgeConnection.open('127.0.0.1', PORT)
	try {
		const answer = new Promise((resolve) => {
			probe.on('message', (m) => m.kind === 'indic' && m.action === 'COLORON' && resolve(m.value))
		})
		probe.sendRaw(`GET ID|35.BUT:[${column}-${line}] COLORON`)
		return await Promise.race([answer, sleep(2000).then(() => 'TIMEOUT')])
	} finally {
		probe.close()
	}
}

const events = []
const context = {
	isLocked: false,
	capabilities: { supportsNonSquareButtons: false },
	disconnect: (e) => events.push(['disconnect', e.message]),
	keyDownById: (id) => events.push(['down', id]),
	keyUpById: (id) => events.push(['up', id]),
	keyDownUpById: () => {},
	rotateLeftById: () => {},
	rotateRightById: () => {},
	changePage: () => {},
	sendVariableValue: () => {},
}

after(async () => {
	await plugin.destroy()
	sim?.kill()
})

test('plugin: connect, draw, brightness, keys, drop and reconnect', { timeout: 60000 }, async () => {
	startSim()
	await waitForPort(PORT)

	// 1. the remote connection announces a surface
	const announced = once(plugin.remote, 'surfacesConnected')
	await plugin.remote.startConnections([{ connectionId: 't1', config: { address: '127.0.0.1', port: PORT } }])
	const [[info]] = await announced
	assert.match(info.surfaceId, /^ramiaudio-cartridge3-/)
	assert.equal(info.deviceHandle, 't1')

	// 2. the host opens it
	const { surface, registerProps } = await plugin.openSurface(info.surfaceId, info.pluginInfo, context)
	assert.equal(Object.keys(registerProps.surfaceLayout.controls).length, 32)
	assert.equal(registerProps.surfaceLayout.stylePresets.default.colors, 'hex')
	assert.deepEqual(registerProps.surfaceLayout.controls['7/3'], { row: 7, column: 3 })
	assert.equal(registerProps.brightness, true)
	await surface.init()
	await surface.ready()

	// 3. colours reach the right keys (control id is line/column, the protocol wants column-line)
	const ctl = new AbortController().signal
	await surface.draw(ctl, { controlId: '0/0', color: '#ff0000' })
	await surface.draw(ctl, { controlId: '7/3', color: '#0000ff' })
	await surface.draw(ctl, { controlId: '3/2', color: 'rgb(0,128,0)' })
	await sleep(300)
	assert.equal(await storedColor(0, 0), '#FF0000')
	assert.equal(await storedColor(3, 7), '#0000FF')
	assert.equal(await storedColor(2, 3), '#008000')

	// 4. brightness is applied by the module
	await surface.setBrightness(50)
	await sleep(300)
	assert.equal(await storedColor(0, 0), '#800000')
	await surface.setBrightness(100)
	await sleep(300)
	assert.equal(await storedColor(0, 0), '#FF0000')

	// 5. key 5 in reading order is line 1, column 0
	sim.stdin.write('d5\n')
	await sleep(200)
	sim.stdin.write('u5\n')
	await sleep(200)
	assert.deepEqual(
		events.filter(([k]) => k !== 'disconnect'),
		[
			['down', '1/0'],
			['up', '1/0'],
		],
	)

	// 6. the link drops: the host is told, then the module reconnects and announces again
	const again = once(plugin.remote, 'surfacesConnected', 20000)
	sim.kill()
	await sleep(500)
	assert.ok(
		events.some(([k]) => k === 'disconnect'),
		'context.disconnect should be called when the link drops',
	)
	startSim()
	await waitForPort(PORT)
	const [[info2]] = await again
	assert.equal(info2.surfaceId, info.surfaceId, 'the surface id must stay the same after a reconnection')

	// 7. the new session starts from a clean state: the host would call openSurface again
	const reopened = await plugin.openSurface(info2.surfaceId, info2.pluginInfo, context)
	await reopened.surface.init()
	await reopened.surface.ready()
	await reopened.surface.draw(ctl, { controlId: '2/1', color: '#ffff00' })
	await sleep(300)
	assert.equal(await storedColor(1, 2), '#FFFF00')
	await reopened.surface.close()
})
