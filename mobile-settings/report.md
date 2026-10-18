# mobile-verify 2026-10-18T14:58:06.120Z

Simulator: iPhone 17 Pro (C5B310BE-1DA7-4B98-B989-8C52B229ADBC), app: /Users/amirilovic/.band/worker/worktrees/.band-worktrees/band/feat/mobile-settings/apps/mobile/build/DerivedData/Build/Products/Release-iphonesimulator/Band.app

| Flow | Result |
| --- | --- |
| st1-settings-menu | pass |
| st2-hosts-live | pass |
| st3-hosts-update | pass |
| st4-agents-refresh | pass |
| st5-voice | pass |
| st6-devices | pass |
| st7-non-admin | pass |

Token in logs or app files: none (searched 40980 log lines, and the app's data container after each flow)

Measurements and checks:
- hosts.update reached build-box 1 time(s)
- voice.test sent 1 request(s) to the speech-to-text stub
- device tablet is gone from tokens.list

Screenshots:
- e2e/artifacts/2026-10-18T14-52-48/st1-settings-menu/2026-10-18_165250/Settings lists its sections and each opens/screenshots/step-009-tapOnElement-Cancel.png
- e2e/artifacts/2026-10-18T14-52-48/st1-settings-menu/2026-10-18_165250/Settings lists its sections and each opens/screenshots/step-012-tapOnElement-Open.png
- e2e/artifacts/2026-10-18T14-52-48/st1-settings-menu/2026-10-18_165250/Settings lists its sections and each opens/takeScreenshot/st1-about.png
- e2e/artifacts/2026-10-18T14-52-48/st1-settings-menu/2026-10-18_165250/Settings lists its sections and each opens/takeScreenshot/st1-hosts.png
- e2e/artifacts/2026-10-18T14-52-48/st1-settings-menu/2026-10-18_165250/Settings lists its sections and each opens/takeScreenshot/st1-settings-menu.png
- e2e/artifacts/2026-10-18T14-52-48/st2-hosts-live/2026-10-18_165337/Hosts shows worker state and follows it live/screenshots/step-010-tapOnElement-Cancel.png
- e2e/artifacts/2026-10-18T14-52-48/st2-hosts-live/2026-10-18_165337/Hosts shows worker state and follows it live/screenshots/step-013-tapOnElement-Open.png
- e2e/artifacts/2026-10-18T14-52-48/st2-hosts-live/2026-10-18_165337/Hosts shows worker state and follows it live/takeScreenshot/st2-hosts-after-drop.png
- e2e/artifacts/2026-10-18T14-52-48/st2-hosts-live/2026-10-18_165337/Hosts shows worker state and follows it live/takeScreenshot/st2-hosts-before.png
- e2e/artifacts/2026-10-18T14-52-48/st3-hosts-update/2026-10-18_165411/Hosts update of a worker behind the hub/screenshots/step-010-tapOnElement-Cancel.png
- e2e/artifacts/2026-10-18T14-52-48/st3-hosts-update/2026-10-18_165411/Hosts update of a worker behind the hub/screenshots/step-013-tapOnElement-Open.png
- e2e/artifacts/2026-10-18T14-52-48/st3-hosts-update/2026-10-18_165411/Hosts update of a worker behind the hub/takeScreenshot/st3-update-confirm.png
- e2e/artifacts/2026-10-18T14-52-48/st3-hosts-update/2026-10-18_165411/Hosts update of a worker behind the hub/takeScreenshot/st3-update-done.png
- e2e/artifacts/2026-10-18T14-52-48/st3-hosts-update/2026-10-18_165411/Hosts update of a worker behind the hub/takeScreenshot/st3-update-progress.png
- e2e/artifacts/2026-10-18T14-52-48/st4-agents-refresh/2026-10-18_165452/Agents refresh models/screenshots/step-009-tapOnElement-Cancel.png
- e2e/artifacts/2026-10-18T14-52-48/st4-agents-refresh/2026-10-18_165452/Agents refresh models/screenshots/step-012-tapOnElement-Open.png
- e2e/artifacts/2026-10-18T14-52-48/st4-agents-refresh/2026-10-18_165452/Agents refresh models/takeScreenshot/st4-agents-refreshed.png
- e2e/artifacts/2026-10-18T14-52-48/st4-agents-refresh/2026-10-18_165452/Agents refresh models/takeScreenshot/st4-agents.png
- e2e/artifacts/2026-10-18T14-52-48/st5-voice/2026-10-18_165540/Voice status and test/screenshots/step-009-tapOnElement-Cancel.png
- e2e/artifacts/2026-10-18T14-52-48/st5-voice/2026-10-18_165540/Voice status and test/screenshots/step-012-tapOnElement-Open.png
- e2e/artifacts/2026-10-18T14-52-48/st5-voice/2026-10-18_165540/Voice status and test/takeScreenshot/st5-voice-tested.png
- e2e/artifacts/2026-10-18T14-52-48/st5-voice/2026-10-18_165540/Voice status and test/takeScreenshot/st5-voice.png
- e2e/artifacts/2026-10-18T14-52-48/st6-devices/2026-10-18_165622/Devices revoke and add/screenshots/step-009-tapOnElement-Cancel.png
- e2e/artifacts/2026-10-18T14-52-48/st6-devices/2026-10-18_165622/Devices revoke and add/screenshots/step-012-tapOnElement-Open.png
- e2e/artifacts/2026-10-18T14-52-48/st6-devices/2026-10-18_165622/Devices revoke and add/takeScreenshot/st6-devices.png
- e2e/artifacts/2026-10-18T14-52-48/st6-devices/2026-10-18_165622/Devices revoke and add/takeScreenshot/st6-pairing-link.png
- e2e/artifacts/2026-10-18T14-52-48/st6-devices/2026-10-18_165622/Devices revoke and add/takeScreenshot/st6-revoke-confirm.png
- e2e/artifacts/2026-10-18T14-52-48/st6-devices/2026-10-18_165622/Devices revoke and add/takeScreenshot/st6-revoke-own-confirm.png
- e2e/artifacts/2026-10-18T14-52-48/st6-devices/2026-10-18_165622/Devices revoke and add/takeScreenshot/st6-tablet-revoked.png
- e2e/artifacts/2026-10-18T14-52-48/st7-non-admin/2026-10-18_165718/Non-admin token sees notices and no admin actions/screenshots/step-007-tapOnElement-Cancel.png
- e2e/artifacts/2026-10-18T14-52-48/st7-non-admin/2026-10-18_165718/Non-admin token sees notices and no admin actions/screenshots/step-010-tapOnElement-Open.png
- e2e/artifacts/2026-10-18T14-52-48/st7-non-admin/2026-10-18_165718/Non-admin token sees notices and no admin actions/takeScreenshot/st7-devices-denied.png
- e2e/artifacts/2026-10-18T14-52-48/st7-non-admin/2026-10-18_165718/Non-admin token sees notices and no admin actions/takeScreenshot/st7-hosts-no-update.png
