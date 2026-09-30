# MTO Bulk SMS Manager
Electron desktop app for Maradhoo Town Office (MTO), Addu City Council, Maldives.

## Status: Phase 1 (foundation)
Scaffold, Mongoose schemas (indexes, soft delete, schema versioning), AES-256-GCM crypto, keytar-backed
credential store, runtime DB connection (Main process only), secure IPC whitelist, Maldives number validation, tests.

## Run
    npm install
    npm run build:electron
    npm run dev        # Vite
    npx electron .     # second terminal, with VITE_DEV_SERVER_URL=http://localhost:5173
    npm test

## Security notes
- Database and Dhiraagu credentials are entered in the setup wizard, never committed. Rotate any credential that has been shared in plain text.
- Secrets are encrypted (AES-256-GCM) in electron-store; the master key is in the OS keychain.
- Renderer has no Node access; only whitelisted IPC channels (electron/ipc/channels.ts).
- Known limitation of this architecture: the Atlas credential is present on each installed machine. Give the Atlas user minimal roles and use an IP allow-list.

## Roadmap
2 Auth/RBAC/audit/wizard | 3 Contacts/groups/import-export | 4 SMS composer + Dhiraagu client + tracking | 5 Dashboard/reports/installer
