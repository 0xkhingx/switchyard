# Dashboard

Next.js (App Router, TypeScript) frontend for Switchyard. Login page first;
flag list/detail, audit log, and demo arrive with the rest of M4.

```powershell
npm install
npm run dev      # http://localhost:3000
```

Configure the API location in `.env.local` (see `.env.example`).
The login form POSTs to the server's `/api/auth/login` with credentials
included, so the session cookie set by the server is stored and sent back.
