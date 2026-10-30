# Lightshow

A small PWA for playing seasonal light shows across Philips Hue and compatible Govee lights. Pick lights and a scene, adjust pace and brightness, and optionally play a local audio file with brightness reacting to its sound. The browser tab must stay open during playback; stopping a show leaves the lights at their last color.

## Get started

1. Install Node.js 22 or later on a computer on the same network as your lights.
2. Run `npm start` in this directory. Leave the companion running.
3. Open <http://localhost:4177> on that computer, or open the deployed GitHub Pages app on the same computer. GitHub Pages may ask for permission to access the local network. To use a phone, follow the instructions below.
4. Under **Connections**, enter your Hue Bridge's private IPv4 address and an existing authorized Bridge username, then connect. For Govee, enable **LAN Control** for each supported device in the Govee Home app, and scan. Select the lights to include, pick a scene, and press play.

Hue requires a Bridge and an existing authorized Bridge username; lights already connected to the Bridge do not need to be paired again. An app needs its own authorization to control the Bridge, even when bulbs are already connected. Bluetooth-only Hue control is not supported. Govee discovery uses multicast UDP ports 4001 and 4002, and control uses port 4003. Not every Govee device supports LAN Control. Discovery can be affected by firewalls, network isolation, and multicast settings. The Govee LAN protocol does not acknowledge commands, so sending successfully does not prove a light changed. This project has not been tested against physical devices.

The Hue Bridge credential is stored in `.lightshow.json` on the companion computer. It is excluded from Git; keep the file private. By default the companion listens on localhost; `npm run start:lan` enables local-network access protected by a code. It accepts browser requests from its own local origin, `https://johnou.github.io`, and `https://just.johno.it` as applicable. It uses the Bridge's self-signed HTTPS certificate and connects only to a private IPv4 address supplied during pairing. Music files stay in your browser. The PWA caches its shell for offline use, but controlling lights still requires the running companion and network.

## Control from a phone

1. Stop the companion if it is running, then start it on the computer with `npm run start:lan`.
2. On a phone connected to the same home Wi-Fi, open the phone address printed in the terminal (for example `http://192.168.1.39:4177`). If multiple addresses are shown, use the one for your home network. This address may change if your router assigns a new one.
3. Enter the connection code printed in the terminal. The code and phone session change every time the companion restarts. Keep the computer and terminal running during the show.

The phone address is ordinary HTTP, so the connection code, device commands and session are visible to others who can monitor your local network. Use it only on a trusted network; it is not intended for the internet or guest Wi-Fi. Browsers generally require HTTPS for service workers and installable PWAs, so phone access at this address is a browser experience without offline installation. The GitHub Pages URL runs the companion on the device opening it and cannot directly access the computer's HTTP service from a phone. The Hue Bridge must be reachable from the terminal running the companion; if macOS asks for local network access, allow it.

## GitHub Pages

Push to `main` and set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. The workflow tests, builds, and deploys the static app to `https://just.johno.it/lightshow/`. GitHub Pages hosts the interface only; run the companion locally as above. The PWA can be installed from a supported browser after its first load.

Run `npm test` and `npm run build` to verify the project. The integration follows the [Hue Bridge getting started guide](https://developers.meethue.com/develop/get-started-2/) and the [Govee LAN protocol documentation](https://github.com/damient/govee-toolkit/blob/main/docs/protocol/lan.md).
