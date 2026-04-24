# Digital Asset Links — Play Store TWA verification

`assetlinks.json` is served at `https://stocksaathi.co.in/.well-known/assetlinks.json`
and binds the Android Play Store app to the domain. Google Play requires this
for Trusted Web Activity (TWA) installations — without a valid, reachable
assetlinks.json, the installed app would show the URL bar at the top (ugly)
instead of launching full-screen like a native app.

## What you need to do

The two `REPLACE_WITH_…` placeholders in `assetlinks.json` must be swapped with
real SHA-256 fingerprints:

1. **Upload key fingerprint** — the key Bubblewrap generates on your machine
   and uses to sign the AAB you upload. Get it with:
   ```bash
   keytool -list -v -keystore android.keystore -alias android
   ```
   Look for the `SHA256:` line. Copy everything after the colon (remove spaces
   and the leading `SHA256:`). Format:
   `AB:CD:EF:12:34:...` (colon-separated 32 hex-byte pairs).

2. **Play App Signing key fingerprint** — after you upload the first AAB to
   Play Console, Google shows this in:
   `Play Console → Release → Setup → App Integrity → App signing key certificate → SHA-256 certificate fingerprint`.
   Copy that colon-separated string.

Paste both into `assetlinks.json` replacing the two placeholders. Commit, push,
Vercel redeploys, the file is live, Google verifies on next Play Console check.

## Testing

Once fingerprints are in and deployed, verify the file is reachable:
```bash
curl https://stocksaathi.co.in/.well-known/assetlinks.json
```
Should return the JSON (not a 404, not HTML). Then run Google's official
tester:
```
https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://stocksaathi.co.in&relation=delegate_permission/common.handle_all_urls
```
Should return your statement with no errors.

## Why two fingerprints?

- The upload key signs the AAB you actually upload. Play verifies during
  upload.
- Play App Signing re-signs the AAB with their own key before distributing
  to users' devices. That's the key users' devices verify on install.
- Both need to match entries in assetlinks.json for TWA verification to
  succeed on debug builds AND production Play Store installs.
