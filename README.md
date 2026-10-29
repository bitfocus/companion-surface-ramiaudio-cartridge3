# companion-surface-ramiaudio-cartridge3

Bitfocus Companion **surface module** for the RAmi Audio Cartridge, a 32-key RGB button panel (4 columns x 8 lines) on Ethernet.
With this module the Cartridge works like any other Companion surface: a key press presses the matching Companion button, and each key lights up with the background colour of its button.

User documentation (shown inside Companion): [companion/HELP.md](companion/HELP.md).

## How it works

The module talks the Cartridge's **RAMIv3** text protocol over Telnet (TCP 23). The Cartridge accepts 4 simultaneous Telnet sessions, without login.

| Direction            | Frame                                                                          |
| -------------------- | ------------------------------------------------------------------------------ |
| key press / release  | `EVENT ID\|35.BUT:[col-line].KEY=DOWN;` / `KEY=UP;`                            |
| key colour           | `SET ID\|35.BUT:[col-line] COLORON=#RRGGBB;BLINK=0`                            |
| answer to a SET      | `ACK ID\|35.BUT:[col-line];` or `ERROR\|n ID\|35 : <text>`                     |
| identity, keep-alive | `INFO ALL\| ALL;` answered by `INFO ID\|35 IP=...;COLUMN_MAX=3;LINE_MAX=7;...` |

Cartridges are found on the local network with their UDP discovery service (port 30303). The MAC address it returns is used as the stable surface id.
The device id (0 to 253) is read from the unit, so there is nothing to configure in the module.

Requires Cartridge firmware v1.4 or later for the LEDs to follow Companion.

## Development

Node.js 22 or 24 and Yarn 4 (`corepack yarn` works without installing Yarn).

```
yarn install
yarn build                         # TypeScript to dist/
yarn dev                           # rebuild on change
yarn lint                          # eslint + prettier
yarn test                          # protocol unit tests + plugin test against the simulator
yarn sim                           # Cartridge simulator on 127.0.0.1:2323 (type a key number + Enter to press it)
node tools/device-check.mjs <ip>   # 32-key addressing and pacing check on a real unit (saves and restores its colours)
yarn package                       # build + companion-surface-build, gives a .tgz to import in Companion
```

To load the module in Companion without packaging, set **Developer modules path** (Companion settings) to the folder that _contains_ this module folder, then enable the module.

## Files

| Path                      | Role                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| `src/main.ts`             | entry point                                                                     |
| `src/plugin.ts`           | remote connections, reconnection, discovery suggestions                         |
| `src/surface.ts`          | Companion surface instance, 8x4 layout, brightness, colour drawing              |
| `src/connection.ts`       | one Telnet session: handshake, heartbeat, paced and de-duplicated colour writes |
| `src/discovery.ts`        | UDP discovery (MAC address, network scan)                                       |
| `src/ramiv3.ts`           | protocol parsing and formatting, colour helpers (pure functions)                |
| `companion/manifest.json` | module manifest                                                                 |
| `companion/HELP.md`       | user help                                                                       |
| `test/`                   | unit and integration tests                                                      |
| `tools/`                  | Cartridge simulator and real-device check                                       |

## License

MIT, see [LICENSE](LICENSE).
