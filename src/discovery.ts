import dgram from 'node:dgram'
import os from 'node:os'

/**
 * The Cartridge runs the Microchip TCP/IP stack "Announce" service: a UDP datagram starting with
 * the letter 'D' sent to port 30303 gets a unicast answer "NAME\r\nMAC\r\nPORT\r\n", for example
 * "CARTRIDGE \r\nEC-D9-25-00-85-17\r\n80\r\n" (observed on a real unit).
 * The MAC is the only stable identifier the device exposes: RAMIv3 INFO returns neither name nor serial.
 */
export const DISCOVERY_PORT = 30303
const REQUEST = Buffer.from('Discovery: Who is out there?\0', 'latin1')

export interface DiscoveredCartridge {
	address: string
	name: string
	/** "EC-D9-25-00-85-17" */
	mac: string
}

export function parseAnnounce(payload: Buffer, address: string): DiscoveredCartridge | null {
	const lines = payload.toString('latin1').split(/\r?\n/)
	const name = lines[0]?.trim()
	const mac = lines[1]?.trim().toUpperCase()
	if (!name || !mac || !/^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/.test(mac)) return null
	return { address, name, mac }
}

/** Ask one known address. Resolves to null when nothing answers. */
export async function probe(address: string, timeoutMs = 1500): Promise<DiscoveredCartridge | null> {
	return new Promise((resolve) => {
		const socket = dgram.createSocket('udp4')
		let done = false
		const finish = (result: DiscoveredCartridge | null): void => {
			if (done) return
			done = true
			clearTimeout(timer)
			try {
				socket.close()
			} catch {
				// already closed
			}
			resolve(result)
		}
		const timer = setTimeout(() => finish(null), timeoutMs)
		socket.on('error', () => finish(null))
		socket.on('message', (msg, rinfo) => {
			const found = parseAnnounce(msg, rinfo.address)
			if (found) finish(found)
		})
		socket.send(REQUEST, DISCOVERY_PORT, address, (err) => {
			if (err) finish(null)
		})
	})
}

/** Broadcast on every IPv4 interface and collect the answers for `timeoutMs`. */
export async function scan(timeoutMs = 2000): Promise<DiscoveredCartridge[]> {
	const found = new Map<string, DiscoveredCartridge>()
	const sockets: dgram.Socket[] = []

	for (const addresses of Object.values(os.networkInterfaces())) {
		for (const nic of addresses ?? []) {
			if (nic.family !== 'IPv4' || nic.internal) continue
			const socket = dgram.createSocket('udp4')
			sockets.push(socket)
			socket.on('error', () => {})
			socket.on('message', (msg, rinfo) => {
				const cartridge = parseAnnounce(msg, rinfo.address)
				if (cartridge) found.set(cartridge.mac, cartridge)
			})
			socket.bind(0, nic.address, () => {
				try {
					socket.setBroadcast(true)
					socket.send(REQUEST, DISCOVERY_PORT, directedBroadcast(nic.address, nic.netmask))
					socket.send(REQUEST, DISCOVERY_PORT, '255.255.255.255')
				} catch {
					// interface went away: ignore
				}
			})
		}
	}

	await new Promise((resolve) => setTimeout(resolve, timeoutMs))
	for (const socket of sockets) {
		try {
			socket.close()
		} catch {
			// already closed
		}
	}
	return [...found.values()]
}

export function directedBroadcast(address: string, netmask: string): string {
	const a = address.split('.').map(Number)
	const m = netmask.split('.').map(Number)
	return a.map((octet, i) => (octet & m[i]) | (~m[i] & 255)).join('.')
}
