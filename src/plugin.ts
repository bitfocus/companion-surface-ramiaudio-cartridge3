import { EventEmitter } from 'node:events'
import {
	createModuleLogger,
	type DetectionSurfaceInfo,
	type DiscoveredRemoteSurfaceInfo,
	type OpenSurfaceResult,
	type RemoteSurfaceConnectionInfo,
	type SomeCompanionInputField,
	type SurfaceContext,
	type SurfacePlugin,
	type SurfacePluginRemote,
	type SurfacePluginRemoteEvents,
} from '@companion-surface/base'
import { CartridgeConnection } from './connection.js'
import { probe, scan } from './discovery.js'
import { CartridgeSurface, buildLayout } from './surface.js'

const DEFAULT_PORT = 23
const SCAN_INTERVAL_MS = 30_000
const SCANS_BEFORE_FORGET = 2
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 10_000

const log = createModuleLogger('cartridge')

/** What `openSurface` receives for a surface announced by `surfacesConnected` */
export interface PluginInfo {
	connectionId: string
	connection: CartridgeConnection
	address: string
}

/**
 * Keeps one Telnet session alive for one configured Cartridge: connects, announces the surface to
 * the host, and reconnects (with a growing delay) after any loss.
 */
class Supervisor {
	readonly #remote: CartridgeRemote
	readonly #connectionId: string
	readonly #address: string
	readonly #port: number
	#stopped = false
	#current: CartridgeConnection | null = null
	#wake: (() => void) | null = null

	constructor(remote: CartridgeRemote, connectionId: string, address: string, port: number) {
		this.#remote = remote
		this.#connectionId = connectionId
		this.#address = address
		this.#port = port
	}

	start(): void {
		void this.#run()
	}

	stop(): void {
		this.#stopped = true
		this.#current?.close()
		this.#wake?.()
	}

	/** The host declined the surface: drop the session, a new one is made after the retry delay */
	release(): void {
		this.#current?.close()
	}

	async #run(): Promise<void> {
		let delay = RETRY_MIN_MS
		while (!this.#stopped) {
			try {
				const connection = await CartridgeConnection.open(this.#address, this.#port, log)
				const announce = await probe(this.#address)
				if (this.#stopped) {
					connection.close()
					break
				}
				this.#current = connection
				delay = RETRY_MIN_MS

				const closed = new Promise<void>((resolve) => connection.once('closed', () => resolve()))
				const stableId = announce ? announce.mac.replaceAll('-', '').toLowerCase() : `${this.#address}-${this.#port}`
				const info: DetectionSurfaceInfo<PluginInfo> = {
					surfaceId: `ramiaudio-cartridge3-${stableId}`,
					description: 'Cartridge',
					deviceHandle: this.#connectionId,
					pluginInfo: { connectionId: this.#connectionId, connection, address: this.#address },
				}
				this.#remote.emit('surfacesConnected', [info])
				await closed
				this.#current = null
			} catch (e) {
				log.warn(`${this.#address}:${this.#port}: ${e instanceof Error ? e.message : String(e)}`)
			}

			if (this.#stopped) break
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, delay)
				this.#wake = () => {
					clearTimeout(timer)
					resolve()
				}
			})
			this.#wake = null
			delay = Math.min(delay * 2, RETRY_MAX_MS)
		}
	}
}

class CartridgeRemote
	extends EventEmitter<SurfacePluginRemoteEvents<PluginInfo>>
	implements SurfacePluginRemote<PluginInfo>
{
	readonly configFields: SomeCompanionInputField[] = [
		{
			id: 'address',
			type: 'textinput',
			label: 'IP address or host name',
			default: '',
			tooltip: 'Address of the Cartridge (Settings > Network of its web page)',
		},
		{
			id: 'port',
			type: 'number',
			label: 'Telnet port',
			default: DEFAULT_PORT,
			min: 1,
			max: 65535,
			tooltip: 'TCP port of the Cartridge Telnet server (23 by default)',
		},
	]

	readonly checkConfigMatchesExpression = '$(objA:address) == $(objB:address)'

	readonly #supervisors = new Map<string, Supervisor>()
	readonly #announced = new Map<string, { info: DiscoveredRemoteSurfaceInfo; misses: number }>()
	#scanTimer: NodeJS.Timeout | null = null
	#scanning = false

	async startConnections(connectionInfos: RemoteSurfaceConnectionInfo[]): Promise<void> {
		for (const { connectionId, config } of connectionInfos) {
			this.#supervisors.get(connectionId)?.stop()
			const address = String(config.address ?? '').trim()
			if (!address) {
				log.warn(`Connection ${connectionId}: no address configured`)
				continue
			}
			const port = Number(config.port ?? DEFAULT_PORT) || DEFAULT_PORT
			const supervisor = new Supervisor(this, connectionId, address, port)
			this.#supervisors.set(connectionId, supervisor)
			supervisor.start()
		}
	}

	async stopConnections(connectionIds: string[]): Promise<void> {
		for (const id of connectionIds) {
			this.#supervisors.get(id)?.stop()
			this.#supervisors.delete(id)
		}
	}

	rejectSurface(surfaceInfo: DetectionSurfaceInfo<PluginInfo>): void {
		this.#supervisors.get(surfaceInfo.deviceHandle)?.release()
	}

	startScanning(): void {
		void this.#scanOnce()
		this.#scanTimer = setInterval(() => void this.#scanOnce(), SCAN_INTERVAL_MS)
	}

	stopAll(): void {
		if (this.#scanTimer) clearInterval(this.#scanTimer)
		this.#scanTimer = null
		for (const supervisor of this.#supervisors.values()) supervisor.stop()
		this.#supervisors.clear()
	}

	async #scanOnce(): Promise<void> {
		if (this.#scanning) return
		this.#scanning = true
		try {
			const seen = new Set<string>()
			for (const cartridge of await scan()) {
				seen.add(cartridge.mac)
				const known = this.#announced.get(cartridge.mac)
				if (known) {
					known.misses = 0
					continue
				}
				const info: DiscoveredRemoteSurfaceInfo = {
					id: cartridge.mac,
					displayName: cartridge.name,
					description: 'RAmi Audio Cartridge',
					addresses: cartridge.address,
					config: { address: cartridge.address, port: DEFAULT_PORT },
				}
				this.#announced.set(cartridge.mac, { info, misses: 0 })
				this.emit('connectionsFound', [info])
			}
			const forgotten: string[] = []
			for (const [mac, entry] of this.#announced) {
				if (seen.has(mac)) continue
				if (++entry.misses >= SCANS_BEFORE_FORGET) forgotten.push(mac)
			}
			if (forgotten.length > 0) {
				for (const mac of forgotten) this.#announced.delete(mac)
				this.emit('connectionsForgotten', forgotten)
			}
		} catch (e) {
			log.debug(`Discovery scan failed: ${e instanceof Error ? e.message : String(e)}`)
		} finally {
			this.#scanning = false
		}
	}
}

const remote = new CartridgeRemote()

const plugin: SurfacePlugin<PluginInfo> = {
	remote,

	async init(): Promise<void> {
		remote.startScanning()
	},

	async destroy(): Promise<void> {
		remote.stopAll()
	},

	async openSurface(surfaceId: string, pluginInfo: PluginInfo, context: SurfaceContext): Promise<OpenSurfaceResult> {
		return {
			surface: new CartridgeSurface(surfaceId, pluginInfo.connection, context, log),
			registerProps: {
				brightness: true,
				surfaceLayout: buildLayout(),
				pincodeMap: null,
				location: pluginInfo.address,
				configFields: null,
			},
		}
	},
}

export default plugin
