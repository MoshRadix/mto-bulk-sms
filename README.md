# MTO Bulk SMS Manager
Windows Electron desktop app for Maradhoo Town Office (MTO), Addu City Council, Maldives. Developed by M0SH.

## Run
    npm install
    npm run start      # Build and launch the Electron app
    npm test

On first launch, enter the MongoDB connection details and create an administrator account. Choose a strong administrator password of at least 12 characters. The optional remember setting stores the username only, never the password.

For renderer-only development, run `npm run dev`. Create the Windows installer with `npm run dist`; the setup executable is written to `dist/` and creates Desktop and Start Menu shortcuts.

## Releasing updates
Windows packaged builds check GitHub Releases at startup, download newer versions in the background, and prompt to restart when ready. To publish an update:

1. Update the `version` in `package.json`.
2. Set `GH_TOKEN` to a GitHub token with Contents write access to `MoshRadix/mto-bulk-sms`.
3. Run `npm run release`.

The release includes the installer and update metadata required by installed apps. Do not publish drafts or prereleases as production updates.

## Security notes
- Database and Dhiraagu credentials are entered in the setup wizard, never committed. Rotate any credential that has been shared in plain text.
- Secrets are encrypted (AES-256-GCM) in electron-store; the random master key is in the OS keychain and is HMAC-derived with the machine ID. Copying the settings file to another PC will not decrypt it.
- Existing pre-machine-bound secrets are re-encrypted on first read. If the OS keychain is cleared or the machine is replaced, enter the database and SMS-provider credentials again.
- Renderer has no Node access; only whitelisted IPC channels (electron/ipc/channels.ts).
- Known limitation of this architecture: the Atlas credential is present on each installed machine. Give the Atlas user minimal roles and use an IP allow-list.

## Roadmap
2 Auth/RBAC/audit/wizard | 3 Contacts/groups/import-export | 4 SMS composer + Dhiraagu client + tracking | 5 Dashboard/reports/installer
