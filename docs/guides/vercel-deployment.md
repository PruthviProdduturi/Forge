# Deploying the Portal to Vercel

This guide covers deploying the Forge Developer Portal frontend to Vercel for a public demo or staging environment.

## Prerequisites

- [Vercel account](https://vercel.com) (sign up with GitHub)
- Vercel CLI: `npm install -g vercel`
- GitHub OAuth App (for auth)

## 1. Create a Vercel Project

```bash
cd portal/frontend
vercel link --yes
```

When prompted, select your Vercel team/account. This creates `.vercel/project.json` (gitignored).

## 2. Set Up OAuth Providers

### GitHub OAuth

1. Go to https://github.com/settings/developers → **New OAuth App**
2. Set:
   - **Homepage URL**: `https://<your-project>.vercel.app`
   - **Callback URL**: `https://<your-project>.vercel.app/api/auth/callback/github`
3. Copy the Client ID and generate a Client Secret

### Google OAuth (optional)

1. Go to https://console.cloud.google.com/apis/credentials → **Create OAuth 2.0 Client ID**
2. Type: Web application
3. Add authorized redirect: `https://<your-project>.vercel.app/api/auth/callback/google`
4. Copy Client ID and Client Secret

## 3. Set Environment Variables

```bash
# Required
vercel env add GITHUB_ID production        # GitHub OAuth Client ID
vercel env add GITHUB_SECRET production    # GitHub OAuth Client Secret
vercel env add NEXTAUTH_URL production     # https://<your-project>.vercel.app
vercel env add NEXTAUTH_SECRET production  # openssl rand -base64 32

# Optional — enables Google sign-in
vercel env add GOOGLE_ID production        # Google OAuth Client ID
vercel env add GOOGLE_SECRET production    # Google OAuth Client Secret
```

Never commit secrets to the repo. All auth credentials live in Vercel env vars only.

## 4. Deploy

### Manual deploy

```bash
cd portal/frontend
vercel --prod
```

### Auto-deploy from GitHub

1. Go to your project's Vercel dashboard → **Settings → Git**
2. Click **Connect Git Repository**
3. Select your fork of `Forge`
4. Set **Root Directory** to `portal/frontend`
5. Branch: `main`

Every push to `main` will auto-deploy.

## 5. Disable Deployment Protection (public access)

By default, Vercel team deployments require SSO to view.

1. Go to **Settings → Deployment Protection**
2. Set Standard Protection to **Disabled** (or "Only Preview Deployments")

## Architecture on Vercel

```
Vercel (frontend only)
├── /about              — public landing page (no auth required)
├── /login              — sign-in page (GitHub, Google, Microsoft buttons)
├── /api/auth/*         — NextAuth.js routes (handles OAuth flow)
├── /api/*              — catch-all proxy returning 503 JSON (no backend)
└── /* (other pages)    — require NextAuth session, redirect to /login if not signed in
```

- **`/`** redirects to **`/about`** via `vercel.json`
- Pages that call the backend API will show empty states (backend returns 503)
- Auth is handled by NextAuth.js (GitHub + Google), not the oauth2-proxy used on AKS
- The `useAuth` hook still attempts proxy-based auth first; NextAuth is the fallback

## Replicating for Other Projects

To add the same Vercel + NextAuth setup to another Next.js project (e.g., LoomX):

1. Install NextAuth: `npm install next-auth@beta`
2. Create `auth.ts` at the project root with your providers
3. Create `app/api/auth/[...nextauth]/route.ts` exporting handlers
4. Create `middleware.ts` to protect routes
5. Wrap your app in `<SessionProvider>`
6. Add `vercel.json` for any redirects
7. Set env vars in Vercel and deploy
